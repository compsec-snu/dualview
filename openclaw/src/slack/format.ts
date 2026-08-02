import type { Block, KnownBlock } from "@slack/web-api";
import type { MarkdownTableMode } from "../config/types.base.js";
import { chunkMarkdownIR, markdownToIR, type MarkdownLinkSpan } from "../markdown/ir.js";
import { renderMarkdownWithMarkers } from "../markdown/render.js";

// Escape special characters for Slack mrkdwn format.
// Preserve Slack's angle-bracket tokens so mentions and links stay intact.
function escapeSlackMrkdwnSegment(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const SLACK_ANGLE_TOKEN_RE = /<[^>\n]+>/g;
const DATAFLOW_SYMBOL_IDENT = String.raw`[a-zA-Z_](?:[a-zA-Z0-9]|\\?_)*`;
const DATAFLOW_SYMBOL_RE = new RegExp(
  String.raw`\\?\$\\?_(?:DUALVIEW|ADFI)\\?_SYM\\?_${DATAFLOW_SYMBOL_IDENT}\[[0-9a-f]{4,8}\](?:(?:\\?\.${DATAFLOW_SYMBOL_IDENT})|(?:\[[0-9]+\]))*`,
  "g",
);
const DATAFLOW_SYMBOL_PREFIX_RE = /\\?\$\\?_(?:DUALVIEW|ADFI)\\?_SYM\\?_/;

function hasAllowedSlackAnglePrefix(inner: string): boolean {
  return (
    inner.startsWith("@") ||
    inner.startsWith("#") ||
    inner.startsWith("!") ||
    inner.startsWith("mailto:") ||
    inner.startsWith("tel:") ||
    inner.startsWith("http://") ||
    inner.startsWith("https://") ||
    inner.startsWith("slack://")
  );
}

function isAllowedSlackAngleToken(token: string): boolean {
  if (!token.startsWith("<") || !token.endsWith(">")) {
    return false;
  }
  return hasAllowedSlackAnglePrefix(token.slice(1, -1));
}

function normalizeSlackEntityEscapes(text: string): string {
  return text.replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&amp;/gi, "&");
}

function safeSlackLinkUrlSegment(url: string): string {
  return escapeSlackMrkdwnSegment(normalizeSlackEntityEscapes(url).replace(/\|/g, "%7C"));
}

function safeSlackLinkLabelSegment(label: string): string {
  return escapeSlackMrkdwnSegment(normalizeSlackEntityEscapes(label)).replace(/\|/g, "&#124;");
}

function findSlackAngleTokenEnd(text: string, startIndex: number): number {
  if (text[startIndex] !== "<") {
    return -1;
  }
  const lineEndIndex = text.indexOf("\n", startIndex + 1);
  const scanEnd = lineEndIndex >= 0 ? lineEndIndex : text.length;
  const firstCloseIndex = text.indexOf(">", startIndex + 1);
  if (firstCloseIndex < 0 || firstCloseIndex >= scanEnd) {
    return -1;
  }

  const firstPipeIndex = text.indexOf("|", startIndex + 1);
  if (firstPipeIndex < 0 || firstPipeIndex >= scanEnd || firstPipeIndex > firstCloseIndex) {
    return firstCloseIndex;
  }

  const prefix = text.slice(startIndex + 1, firstPipeIndex);
  if (!hasAllowedSlackAnglePrefix(prefix)) {
    return firstCloseIndex;
  }

  let nestedAngleDepth = 0;
  for (let i = firstPipeIndex + 1; i < scanEnd; i += 1) {
    const char = text[i];
    if (char === "<") {
      nestedAngleDepth += 1;
      continue;
    }
    if (char !== ">") {
      continue;
    }
    if (nestedAngleDepth > 0) {
      nestedAngleDepth -= 1;
      continue;
    }
    return i;
  }
  return -1;
}

function normalizeAllowedSlackAngleToken(token: string): string {
  if (!isAllowedSlackAngleToken(token)) {
    return escapeSlackMrkdwnSegment(token);
  }

  const inner = token.slice(1, -1);
  const pipeIndex = inner.indexOf("|");
  if (pipeIndex < 0) {
    return `<${safeSlackLinkUrlSegment(inner)}>`;
  }

  const target = inner.slice(0, pipeIndex);
  const label = inner.slice(pipeIndex + 1);
  return `<${safeSlackLinkUrlSegment(target)}|${safeSlackLinkLabelSegment(label)}>`;
}

function escapeSlackMrkdwnContent(text: string): string {
  if (!text) {
    return "";
  }
  if (!text.includes("&") && !text.includes("<") && !text.includes(">")) {
    return text;
  }

  const out: string[] = [];
  let lastIndex = 0;

  while (lastIndex < text.length) {
    const tokenStart = text.indexOf("<", lastIndex);
    if (tokenStart < 0) {
      break;
    }
    out.push(escapeSlackMrkdwnSegment(text.slice(lastIndex, tokenStart)));
    const tokenEnd = findSlackAngleTokenEnd(text, tokenStart);
    if (tokenEnd < 0) {
      out.push("&lt;");
      lastIndex = tokenStart + 1;
      continue;
    }
    out.push(normalizeAllowedSlackAngleToken(text.slice(tokenStart, tokenEnd + 1)));
    lastIndex = tokenEnd + 1;
  }

  out.push(escapeSlackMrkdwnSegment(text.slice(lastIndex)));
  return out.join("");
}

function escapeSlackMrkdwnText(text: string): string {
  if (!text) {
    return "";
  }
  if (!text.includes("&") && !text.includes("<") && !text.includes(">")) {
    return text;
  }

  return text
    .split("\n")
    .map((line) => {
      if (line.startsWith("> ")) {
        return `> ${escapeSlackMrkdwnContent(line.slice(2))}`;
      }
      return escapeSlackMrkdwnContent(line);
    })
    .join("\n");
}

function buildSlackLink(link: MarkdownLinkSpan, text: string) {
  const href = link.href.trim();
  if (!href) {
    return null;
  }
  const label = text.slice(link.start, link.end);
  const trimmedLabel = label.trim();
  const comparableHref = href.startsWith("mailto:") ? href.slice("mailto:".length) : href;
  const useMarkup =
    trimmedLabel.length > 0 && trimmedLabel !== href && trimmedLabel !== comparableHref;
  if (!useMarkup) {
    return null;
  }
  const safeHref = escapeSlackMrkdwnSegment(href);
  return {
    start: link.start,
    end: link.end,
    open: `<${safeHref}|`,
    close: ">",
  };
}

type SlackMarkdownOptions = {
  tableMode?: MarkdownTableMode;
  symbolLinkUrl?: string;
};

type DataflowLinkFormat = "slack_mrkdwn" | "markdown";
const DATAFLOW_INLINE_MARK = "[Data] ";
const DATAFLOW_SYMBOL_START_MARK = "[Data begins]";
const DATAFLOW_SYMBOL_END_MARK = "[Data ends]";

function buildSlackRenderOptions() {
  return {
    styleMarkers: {
      bold: { open: "*", close: "*" },
      italic: { open: "_", close: "_" },
      strikethrough: { open: "~", close: "~" },
      code: { open: "`", close: "`" },
      code_block: { open: "```\n", close: "```" },
    },
    escapeText: escapeSlackMrkdwnText,
    buildLink: buildSlackLink,
  };
}

function buildMarkdownRenderLink(link: MarkdownLinkSpan): {
  start: number;
  end: number;
  open: string;
  close: string;
} | null {
  const href = link.href.trim();
  if (!href) {
    return null;
  }
  return {
    start: link.start,
    end: link.end,
    open: "[",
    close: `](${safeMarkdownLinkUrl(href)})`,
  };
}

function safeMarkdownLinkUrl(url: string): string {
  return normalizeSlackEntityEscapes(url)
    .replace(/\s/g, "%20")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29");
}

function safeMarkdownLinkLabel(label: string): string {
  return escapeSlackMrkdwnSegment(normalizeSlackEntityEscapes(label))
    .replace(/\\/g, "\\\\")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
}

function buildDataflowMark(mark: string, url: string, format: DataflowLinkFormat): string {
  const safeUrl = format === "markdown" ? safeMarkdownLinkUrl(url) : safeSlackLinkUrl(url);
  if (format === "markdown") {
    return `[${safeMarkdownLinkLabel(mark)}](${safeUrl})`;
  }
  return `<${safeUrl}|${safeSlackLinkLabel(mark)}>`;
}

function shouldUseBlockSymbolBoundary(text: string): boolean {
  return text.includes("\n") || text.includes("\r");
}

function buildDataflowTextLink(text: string, url: string, format: DataflowLinkFormat): string {
  if (!text) {
    return text;
  }
  if (shouldUseBlockSymbolBoundary(text)) {
    const open = buildDataflowMark(DATAFLOW_SYMBOL_START_MARK, url, format);
    const close = buildDataflowMark(DATAFLOW_SYMBOL_END_MARK, url, format);
    return `${open}\n${text}\n${close}`;
  }
  const safeUrl = format === "markdown" ? safeMarkdownLinkUrl(url) : safeSlackLinkUrl(url);
  const label = `${DATAFLOW_INLINE_MARK}${text}`;
  if (format === "markdown") {
    return `[${safeMarkdownLinkLabel(label)}](${safeUrl})`;
  }
  return `<${safeUrl}|${safeSlackLinkLabel(label)}>`;
}

function isDataflowSlackLinkToken(token: string): boolean {
  if (!token.startsWith("<") || !token.endsWith(">")) {
    return false;
  }
  const inner = token.slice(1, -1);
  const pipeIndex = inner.indexOf("|");
  if (pipeIndex < 0 || !hasAllowedSlackAnglePrefix(inner.slice(0, pipeIndex))) {
    return false;
  }
  const label = normalizeSlackEntityEscapes(inner.slice(pipeIndex + 1));
  return (
    label.startsWith(DATAFLOW_INLINE_MARK) ||
    label === DATAFLOW_SYMBOL_START_MARK ||
    label === DATAFLOW_SYMBOL_END_MARK
  );
}

function linkDualViewSymbolsForFormat(
  text: string,
  _symbolLinkUrl: string | undefined,
  _format: DataflowLinkFormat,
): string {
  return text;
}

export function linkDualViewSymbolsForSlack(text: string, symbolLinkUrl?: string): string {
  return linkDualViewSymbolsForFormat(text, symbolLinkUrl, "slack_mrkdwn");
}

export function linkDualViewSymbolsForSlackMarkdown(text: string, symbolLinkUrl?: string): string {
  return linkDualViewSymbolsForFormat(text, symbolLinkUrl, "markdown");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function linkSlackMrkdwnSymbols(value: unknown, symbolLinkUrl?: string): unknown {
  if (!symbolLinkUrl) {
    return value;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const linked = linkSlackMrkdwnSymbols(item, symbolLinkUrl);
      changed ||= linked !== item;
      return linked;
    });
    return changed ? next : value;
  }
  if (!isRecord(value)) {
    return value;
  }

  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (value.type === "mrkdwn" && key === "text" && typeof child === "string") {
      const linked = linkDualViewSymbolsForSlack(child, symbolLinkUrl);
      changed ||= linked !== child;
      next[key] = linked;
      continue;
    }
    const linked = linkSlackMrkdwnSymbols(child, symbolLinkUrl);
    changed ||= linked !== child;
    next[key] = linked;
  }
  return changed ? next : value;
}

export function linkSlackBlockSymbolsForSlack(
  blocks: (Block | KnownBlock)[],
  symbolLinkUrl?: string,
): (Block | KnownBlock)[] {
  return linkSlackMrkdwnSymbols(blocks, symbolLinkUrl) as (Block | KnownBlock)[];
}

function hasDataflowSymbolPrefix(text: string): boolean {
  return DATAFLOW_SYMBOL_PREFIX_RE.test(text);
}

function normalizeDataflowSymbol(symbol: string): string {
  return symbol.replace(/\\/g, "");
}

function safeSlackLinkUrl(url: string): string {
  return safeSlackLinkUrlSegment(url);
}

function safeSlackLinkLabel(label: string): string {
  return safeSlackLinkLabelSegment(label);
}

function dualViewSymbolLinkUrl(baseUrl: string, symbol: string): string {
  try {
    const url = new URL(baseUrl);
    const hash = url.hash.startsWith("#") ? url.hash.slice(1) : "";
    if (!hash.includes("/session/")) {
      return baseUrl;
    }
    const keptParts: string[] = [];
    for (const part of hash.split("/")) {
      if (part === "tab" || part === "event" || part === "symbol") {
        break;
      }
      if (part) {
        keptParts.push(part);
      }
    }
    if (!keptParts.includes("session")) {
      return baseUrl;
    }
    url.hash = [...keptParts, "tab", "conversation", "symbol", encodeURIComponent(symbol)].join(
      "/",
    );
    return url.toString();
  } catch {
    return baseUrl;
  }
}

export function linkResolvedDataflowSymbolsForSlack(params: {
  sourceText: string;
  resolvedText: string;
  symbolLinkUrl?: string;
}): string {
  return linkResolvedDataflowSymbolsForFormat(params, "slack_mrkdwn");
}

export function linkResolvedDataflowSymbolsForSlackMarkdown(params: {
  sourceText: string;
  resolvedText: string;
  symbolLinkUrl?: string;
}): string {
  return linkResolvedDataflowSymbolsForFormat(params, "markdown");
}

function linkResolvedDataflowSymbolsForFormat(
  params: {
    sourceText: string;
    resolvedText: string;
    symbolLinkUrl?: string;
  },
  format: DataflowLinkFormat,
): string {
  const url = params.symbolLinkUrl?.trim();
  if (!url) {
    return params.resolvedText;
  }
  const linkedResolvedText = linkResolvedSymbolReplacementsForFormat(
    {
      sourceText: params.sourceText,
      resolvedText: params.resolvedText,
      symbolLinkUrl: url,
    },
    format,
  );
  return linkedResolvedText ?? params.resolvedText;
}

function linkResolvedSymbolReplacementsForFormat(
  params: {
    sourceText: string;
    resolvedText: string;
    symbolLinkUrl: string;
  },
  format: DataflowLinkFormat,
): string | undefined {
  if (!hasDataflowSymbolPrefix(params.sourceText) || params.sourceText === params.resolvedText) {
    return undefined;
  }

  const parts: Array<{ type: "literal" | "symbol"; text: string }> = [];
  DATAFLOW_SYMBOL_RE.lastIndex = 0;
  let sourceCursor = 0;
  for (
    let match = DATAFLOW_SYMBOL_RE.exec(params.sourceText);
    match;
    match = DATAFLOW_SYMBOL_RE.exec(params.sourceText)
  ) {
    const matchIndex = match.index ?? 0;
    if (matchIndex > sourceCursor) {
      parts.push({ type: "literal", text: params.sourceText.slice(sourceCursor, matchIndex) });
    }
    const symbol = match[0] ?? "";
    if (symbol) {
      parts.push({ type: "symbol", text: symbol });
    }
    sourceCursor = matchIndex + symbol.length;
  }
  if (sourceCursor < params.sourceText.length) {
    parts.push({ type: "literal", text: params.sourceText.slice(sourceCursor) });
  }
  if (!parts.some((part) => part.type === "symbol")) {
    return undefined;
  }

  const out: string[] = [];
  let resolvedCursor = 0;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (part.type === "literal") {
      if (!part.text) {
        continue;
      }
      if (params.resolvedText.startsWith(part.text, resolvedCursor)) {
        out.push(part.text);
        resolvedCursor += part.text.length;
        continue;
      }
      const literalIndex = params.resolvedText.indexOf(part.text, resolvedCursor);
      if (literalIndex < 0) {
        return undefined;
      }
      out.push(params.resolvedText.slice(resolvedCursor, literalIndex + part.text.length));
      resolvedCursor = literalIndex + part.text.length;
      continue;
    }

    const nextLiteral = parts
      .slice(i + 1)
      .find((candidate) => candidate.type === "literal" && candidate.text);
    let replacementEnd = params.resolvedText.length;
    if (nextLiteral) {
      replacementEnd = params.resolvedText.indexOf(nextLiteral.text, resolvedCursor);
      if (replacementEnd < 0) {
        return undefined;
      }
    }
    const normalizedSymbol = normalizeDataflowSymbol(part.text);
    out.push(
      buildDataflowTextLink(
        params.resolvedText.slice(resolvedCursor, replacementEnd),
        dualViewSymbolLinkUrl(params.symbolLinkUrl, normalizedSymbol),
        format,
      ),
    );
    resolvedCursor = replacementEnd;
  }

  if (resolvedCursor < params.resolvedText.length) {
    out.push(params.resolvedText.slice(resolvedCursor));
  }
  return out.join("");
}

function preserveDataflowSlackLinks(text: string): {
  text: string;
  restore: (value: string) => string;
} {
  if (!text.includes(DATAFLOW_INLINE_MARK) && !text.includes(DATAFLOW_SYMBOL_START_MARK)) {
    return { text, restore: (value) => value };
  }

  const tokens: string[] = [];
  const out: string[] = [];
  let lastIndex = 0;
  SLACK_ANGLE_TOKEN_RE.lastIndex = 0;
  for (
    let match = SLACK_ANGLE_TOKEN_RE.exec(text);
    match;
    match = SLACK_ANGLE_TOKEN_RE.exec(text)
  ) {
    const token = match[0] ?? "";
    const matchIndex = match.index ?? 0;
    if (!isDataflowSlackLinkToken(token)) {
      continue;
    }
    out.push(text.slice(lastIndex, matchIndex));
    const placeholder = `DUALVIEWDATATOKEN${tokens.length}END`;
    tokens.push(token);
    out.push(placeholder);
    lastIndex = matchIndex + token.length;
  }
  if (tokens.length === 0) {
    return { text, restore: (value) => value };
  }
  out.push(text.slice(lastIndex));

  return {
    text: out.join(""),
    restore(value: string): string {
      let restored = value;
      for (let i = 0; i < tokens.length; i += 1) {
        restored = restored.split(`DUALVIEWDATATOKEN${i}END`).join(tokens[i]!);
      }
      return restored;
    },
  };
}

export function markdownToSlackMrkdwn(
  markdown: string,
  options: SlackMarkdownOptions = {},
): string {
  const ir = markdownToIR(markdown ?? "", {
    linkify: false,
    autolink: false,
    headingStyle: "bold",
    blockquotePrefix: "> ",
    tableMode: options.tableMode,
  });
  return linkDualViewSymbolsForSlack(
    renderMarkdownWithMarkers(ir, buildSlackRenderOptions()),
    options.symbolLinkUrl,
  );
}

export function normalizeSlackOutboundText(
  markdown: string,
  options: SlackMarkdownOptions = {},
): string {
  const preserved = preserveDataflowSlackLinks(markdown ?? "");
  return preserved.restore(markdownToSlackMrkdwn(preserved.text, options));
}

export function markdownToSlackStreamingMarkdown(
  markdown: string,
  options: SlackMarkdownOptions = {},
): string {
  const ir = markdownToIR(markdown ?? "", {
    linkify: false,
    autolink: false,
    headingStyle: "bold",
    blockquotePrefix: "> ",
    tableMode: options.tableMode,
  });
  return renderMarkdownWithMarkers(ir, {
    styleMarkers: {
      bold: { open: "**", close: "**" },
      italic: { open: "_", close: "_" },
      strikethrough: { open: "~", close: "~" },
      code: { open: "`", close: "`" },
      code_block: { open: "```\n", close: "```" },
    },
    escapeText: escapeSlackMrkdwnText,
    buildLink: buildMarkdownRenderLink,
  });
}

export function markdownToSlackMrkdwnChunks(
  markdown: string,
  limit: number,
  options: SlackMarkdownOptions = {},
): string[] {
  const ir = markdownToIR(markdown ?? "", {
    linkify: false,
    autolink: false,
    headingStyle: "bold",
    blockquotePrefix: "> ",
    tableMode: options.tableMode,
  });
  const chunks = chunkMarkdownIR(ir, limit);
  const renderOptions = buildSlackRenderOptions();
  return chunks.map((chunk) =>
    linkDualViewSymbolsForSlack(
      renderMarkdownWithMarkers(chunk, renderOptions),
      options.symbolLinkUrl,
    ),
  );
}
