import { describe, expect, it } from "vitest";
import {
  linkDualViewSymbolsForSlack,
  linkResolvedDataflowSymbolsForSlack,
  linkResolvedDataflowSymbolsForSlackMarkdown,
  linkSlackBlockSymbolsForSlack,
  markdownToSlackStreamingMarkdown,
  markdownToSlackMrkdwn,
  normalizeSlackOutboundText,
} from "./format.js";
import { escapeSlackMrkdwn } from "./monitor/mrkdwn.js";

describe("markdownToSlackMrkdwn", () => {
  it("handles core markdown formatting conversions", () => {
    const cases = [
      ["converts bold from double asterisks to single", "**bold text**", "*bold text*"],
      ["preserves italic underscore format", "_italic text_", "_italic text_"],
      [
        "converts strikethrough from double tilde to single",
        "~~strikethrough~~",
        "~strikethrough~",
      ],
      [
        "renders basic inline formatting together",
        "hi _there_ **boss** `code`",
        "hi _there_ *boss* `code`",
      ],
      ["renders inline code", "use `npm install`", "use `npm install`"],
      ["renders fenced code blocks", "```js\nconst x = 1;\n```", "```\nconst x = 1;\n```"],
      [
        "renders links with Slack mrkdwn syntax",
        "see [docs](https://example.com)",
        "see <https://example.com|docs>",
      ],
      ["does not duplicate bare URLs", "see https://example.com", "see https://example.com"],
      ["escapes unsafe characters", "a & b < c > d", "a &amp; b &lt; c &gt; d"],
      [
        "preserves Slack angle-bracket markup (mentions/links)",
        "hi <@U123> see <https://example.com|docs> and <!here>",
        "hi <@U123> see <https://example.com|docs> and <!here>",
      ],
      ["escapes raw HTML", "<b>nope</b>", "&lt;b&gt;nope&lt;/b&gt;"],
      ["renders paragraphs with blank lines", "first\n\nsecond", "first\n\nsecond"],
      ["renders bullet lists", "- one\n- two", "• one\n• two"],
      ["renders ordered lists with numbering", "2. two\n3. three", "2. two\n3. three"],
      ["renders headings as bold text", "# Title", "*Title*"],
      ["renders blockquotes", "> Quote", "> Quote"],
    ] as const;
    for (const [name, input, expected] of cases) {
      expect(markdownToSlackMrkdwn(input), name).toBe(expected);
    }
  });

  it("handles nested list items", () => {
    const res = markdownToSlackMrkdwn("- item\n  - nested");
    // markdown-it correctly parses this as a nested list
    expect(res).toBe("• item\n  • nested");
  });

  it("handles complex message with multiple elements", () => {
    const res = markdownToSlackMrkdwn(
      "**Important:** Check the _docs_ at [link](https://example.com)\n\n- first\n- second",
    );
    expect(res).toBe(
      "*Important:* Check the _docs_ at <https://example.com|link>\n\n• first\n• second",
    );
  });

  it("does not throw when input is undefined at runtime", () => {
    expect(markdownToSlackMrkdwn(undefined as unknown as string)).toBe("");
  });

  it("does not label unresolved raw DualView symbols", () => {
    expect(
      markdownToSlackMrkdwn("see $_DUALVIEW_SYM_web_fetch[a1b2].text", {
        symbolLinkUrl: "http://127.0.0.1:18789/",
      }),
    ).toBe("see $_DUALVIEW_SYM_web_fetch[a1b2].text");
  });
});

describe("linkDualViewSymbolsForSlack", () => {
  it("leaves text unchanged when no link URL is configured", () => {
    expect(linkDualViewSymbolsForSlack("$_DUALVIEW_SYM_exec[abcd].stdout")).toBe(
      "$_DUALVIEW_SYM_exec[abcd].stdout",
    );
  });

  it("does not rewrite existing Slack angle-bracket tokens", () => {
    expect(
      linkDualViewSymbolsForSlack(
        "see <https://example.com|$_DUALVIEW_SYM_exec[abcd].stdout>",
        "http://127.0.0.1:18789/",
      ),
    ).toBe("see <https://example.com|$_DUALVIEW_SYM_exec[abcd].stdout>");
  });

  it("does not label markdown-escaped unresolved raw symbols", () => {
    expect(
      linkDualViewSymbolsForSlack(
        String.raw`see $\_DUALVIEW\_SYM\_exec[abcd].stdout`,
        "http://127.0.0.1:18789/",
      ),
    ).toBe(String.raw`see $\_DUALVIEW\_SYM\_exec[abcd].stdout`);
  });

  it("does not label raw symbols when a session URL is configured", () => {
    expect(
      linkDualViewSymbolsForSlack(
        "see $_DUALVIEW_SYM_web_fetch[a1b2].text",
        "http://localhost:13457/bot/#batch/20260628_125215/session/b739f3c2-2896-4cd6-9692-44a3379943a2",
      ),
    ).toBe("see $_DUALVIEW_SYM_web_fetch[a1b2].text");
  });

  it("keeps array-index symbol paths intact", () => {
    expect(
      linkDualViewSymbolsForSlack(
        "see $_DUALVIEW_SYM_web_search[5865].results[0].title.note",
        "http://localhost:13457/bot/#batch/20260630_000000/session/session-1",
      ),
    ).toBe("see $_DUALVIEW_SYM_web_search[5865].results[0].title.note");
  });

  it("does not partially link malformed array-index symbol paths", () => {
    expect(
      linkDualViewSymbolsForSlack(
        "see $_DUALVIEW_SYM_web_search[5865].results[0.title.note.summary",
        "http://localhost:13457/bot/#batch/20260630_000000/session/session-1",
      ),
    ).toBe("see $_DUALVIEW_SYM_web_search[5865].results[0.title.note.summary");
  });

  it("does not partially link malformed array-index symbols after markdown rendering", () => {
    expect(
      markdownToSlackMrkdwn(
        "Sure - here it is again:\n$_DUALVIEW_SYM_web_search[5865].results[0.title.note.summary",
        {
          symbolLinkUrl: "http://localhost:13457/bot/#batch/20260630_000000/session/session-1",
        },
      ),
    ).toBe(
      "Sure - here it is again:\n$_DUALVIEW_SYM_web_search[5865].results[0.title.note.summary",
    );
  });
});

describe("linkSlackBlockSymbolsForSlack", () => {
  it("does not label unresolved raw symbols inside Slack blocks", () => {
    const blocks = [
      {
        type: "section",
        text: { type: "mrkdwn", text: "Result: $_DUALVIEW_SYM_web_fetch[a1b2].title" },
        fields: [
          { type: "mrkdwn", text: "Field $_ADFI_SYM_exec[abcd].stdout" },
          { type: "plain_text", text: "Plain $_DUALVIEW_SYM_exec[abcd].stdout" },
        ],
      },
    ];

    expect(linkSlackBlockSymbolsForSlack(blocks, "http://127.0.0.1:18789/")).toEqual([
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "Result: $_DUALVIEW_SYM_web_fetch[a1b2].title",
        },
        fields: [
          {
            type: "mrkdwn",
            text: "Field $_ADFI_SYM_exec[abcd].stdout",
          },
          { type: "plain_text", text: "Plain $_DUALVIEW_SYM_exec[abcd].stdout" },
        ],
      },
    ]);
  });
});

describe("linkResolvedDataflowSymbolsForSlack", () => {
  it("links raw content that replaced a DualView symbol", () => {
    expect(
      linkResolvedDataflowSymbolsForSlack({
        sourceText: "Result: $_DUALVIEW_SYM_web_fetch[a1b2].title.",
        resolvedText: "Result: Example title.",
        symbolLinkUrl: "http://127.0.0.1:18789/",
      }),
    ).toBe("Result: <http://127.0.0.1:18789/|[Data] Example title>.");
  });

  it("marks multiline resolved symbol content without linking the full text", () => {
    expect(
      linkResolvedDataflowSymbolsForSlack({
        sourceText:
          "Title: $_DUALVIEW_SYM_web_fetch[a1b2].title\nBody: $_DUALVIEW_SYM_web_fetch[c3d4].text",
        resolvedText: "Title: Example\nBody: First line\nSecond line",
        symbolLinkUrl: "http://127.0.0.1:18789/",
      }),
    ).toBe(
      "Title: <http://127.0.0.1:18789/|[Data] Example>\n" +
        "Body: <http://127.0.0.1:18789/|[Data begins]>\n" +
        "First line\n" +
        "Second line\n" +
        "<http://127.0.0.1:18789/|[Data ends]>",
    );
  });

  it("links long single-line resolved symbol content as one data span", () => {
    const longSummary = `Summary: ${"external report ".repeat(14)}`.trim();
    expect(
      linkResolvedDataflowSymbolsForSlack({
        sourceText: "$_DUALVIEW_SYM_web_fetch[a1b2].summary",
        resolvedText: longSummary,
        symbolLinkUrl: "http://127.0.0.1:18789/",
      }),
    ).toBe(`<http://127.0.0.1:18789/|[Data] ${longSummary}>`);
  });

  it("marks resolved markdown blocks without linking each line", () => {
    const note = "- *Why it matters:*\n- Source: X post relaying an article from iototsecnews.jp";
    const symbolUrl =
      "https://compsec.snu.ac.kr/adfi-test/bot/#batch/20260630_023124/session/08ab14aa-6d41-414a-a81d-167404731e2b/tab/conversation/symbol/%24_DUALVIEW_SYM_web_fetch%5B1a8e%5D.text.note";
    expect(
      linkResolvedDataflowSymbolsForSlack({
        sourceText: "$_DUALVIEW_SYM_web_fetch[1a8e].text.note",
        resolvedText: note,
        symbolLinkUrl:
          "https://compsec.snu.ac.kr/adfi-test/bot/#batch/20260630_023124/session/08ab14aa-6d41-414a-a81d-167404731e2b",
      }),
    ).toBe(`<${symbolUrl}|[Data begins]>\n${note}\n<${symbolUrl}|[Data ends]>`);
  });

  it("wraps a fully resolved summary with linked boundary marks", () => {
    expect(
      linkResolvedDataflowSymbolsForSlack({
        sourceText: "$_DUALVIEW_SYM_web_fetch[a1b2].summary",
        resolvedText:
          "One-line conclusion: *Coleridge is the clearest candidate when station access is the priority.*",
        symbolLinkUrl: "http://127.0.0.1:3456/bot/",
      }),
    ).toBe(
      "<http://127.0.0.1:3456/bot/|[Data] One-line conclusion: *Coleridge is the clearest candidate when station access is the priority.*>",
    );
  });

  it("keeps markdown styling outside linked boundary marks", () => {
    const symbolUrl =
      "https://compsec.snu.ac.kr/adfi-test/bot/#batch/20260630_023124/session/08ab14aa-6d41-414a-a81d-167404731e2b/tab/conversation/symbol/%24_DUALVIEW_SYM_exec%5B5820%5D.triage";

    const linked = linkResolvedDataflowSymbolsForSlack({
      sourceText: "$_DUALVIEW_SYM_exec[5820].triage",
      resolvedText: "_Needs reply_",
      symbolLinkUrl:
        "https://compsec.snu.ac.kr/adfi-test/bot/#batch/20260630_023124/session/08ab14aa-6d41-414a-a81d-167404731e2b",
    });

    expect(linked).toBe(`<${symbolUrl}|[Data] _Needs reply_>`);
    expect(normalizeSlackOutboundText(linked)).toBe(`<${symbolUrl}|[Data] _Needs reply_>`);
  });

  it("does not label raw symbols when the hook leaves them unresolved", () => {
    expect(
      linkResolvedDataflowSymbolsForSlack({
        sourceText: "see $_ADFI_SYM_exec[abcd].stdout",
        resolvedText: "see $_ADFI_SYM_exec[abcd].stdout",
        symbolLinkUrl: "http://127.0.0.1:18789/",
      }),
    ).toBe("see $_ADFI_SYM_exec[abcd].stdout");
  });

  it("links resolved spans when the source symbol was markdown-escaped", () => {
    expect(
      linkResolvedDataflowSymbolsForSlack({
        sourceText: String.raw`Result: $\_DUALVIEW\_SYM\_web_fetch[a1b2].title.`,
        resolvedText: "Result: Example title.",
        symbolLinkUrl: "http://127.0.0.1:18789/",
      }),
    ).toBe("Result: <http://127.0.0.1:18789/|[Data] Example title>.");
  });

  it("links resolved spans to the source symbol route when a session URL is configured", () => {
    expect(
      linkResolvedDataflowSymbolsForSlack({
        sourceText: "Result: $_DUALVIEW_SYM_web_fetch[a1b2].title.",
        resolvedText: "Result: Example title.",
        symbolLinkUrl:
          "http://localhost:13457/bot/#batch/20260628_125215/session/b739f3c2-2896-4cd6-9692-44a3379943a2",
      }),
    ).toBe(
      "Result: <http://localhost:13457/bot/#batch/20260628_125215/session/b739f3c2-2896-4cd6-9692-44a3379943a2/tab/conversation/symbol/%24_DUALVIEW_SYM_web_fetch%5Ba1b2%5D.title|[Data] Example title>.",
    );
  });

  it("marks multiline resolved spans for Slack streaming", () => {
    const symbolUrl =
      "https://compsec.snu.ac.kr/adfi-test/bot/#batch/20260629_041116/session/9fc39449-88dc-4e91-83f0-6198ab68dd94/tab/conversation/symbol/%24_DUALVIEW_SYM_exec%5Bbe42%5D.triage_report";

    expect(
      linkResolvedDataflowSymbolsForSlackMarkdown({
        sourceText: "$_DUALVIEW_SYM_exec[be42].triage_report",
        resolvedText:
          "Which calendar event(s) should I add? Reply with the numbers, or say none.\nNo action\n• No action needed: newsletter digest.",
        symbolLinkUrl:
          "https://compsec.snu.ac.kr/adfi-test/bot/#batch/20260629_041116/session/9fc39449-88dc-4e91-83f0-6198ab68dd94",
      }),
    ).toBe(
      `[\\[Data begins\\]](${symbolUrl})\n` +
        "Which calendar event(s) should I add? Reply with the numbers, or say none.\n" +
        "No action\n" +
        "• No action needed: newsletter digest.\n" +
        `[\\[Data ends\\]](${symbolUrl})`,
    );

    expect(symbolUrl).toContain("symbol/%24_DUALVIEW_SYM_exec%5Bbe42%5D.triage_report");
  });

  it("keeps markdown styling outside streaming boundary marks", () => {
    const symbolUrl =
      "https://compsec.snu.ac.kr/adfi-test/bot/#batch/20260630_023124/session/08ab14aa-6d41-414a-a81d-167404731e2b/tab/conversation/symbol/%24_DUALVIEW_SYM_exec%5B5820%5D.triage";

    expect(
      linkResolvedDataflowSymbolsForSlackMarkdown({
        sourceText: "$_DUALVIEW_SYM_exec[5820].triage",
        resolvedText: "_Needs reply_",
        symbolLinkUrl:
          "https://compsec.snu.ac.kr/adfi-test/bot/#batch/20260630_023124/session/08ab14aa-6d41-414a-a81d-167404731e2b",
      }),
    ).toBe(`[\\[Data\\] _Needs reply_](${symbolUrl})`);
  });

  it("marks multiline resolved content for Slack streaming", () => {
    const note = "- *Why it matters:*\n- Source: X post relaying an article from iototsecnews.jp";
    const symbolUrl =
      "https://compsec.snu.ac.kr/adfi-test/bot/#batch/20260630_023124/session/08ab14aa-6d41-414a-a81d-167404731e2b/tab/conversation/symbol/%24_DUALVIEW_SYM_web_fetch%5B1a8e%5D.text.note";
    expect(
      linkResolvedDataflowSymbolsForSlackMarkdown({
        sourceText: "$_DUALVIEW_SYM_web_fetch[1a8e].text.note",
        resolvedText: note,
        symbolLinkUrl:
          "https://compsec.snu.ac.kr/adfi-test/bot/#batch/20260630_023124/session/08ab14aa-6d41-414a-a81d-167404731e2b",
      }),
    ).toBe(`[\\[Data begins\\]](${symbolUrl})\n${note}\n[\\[Data ends\\]](${symbolUrl})`);
  });
});

describe("markdownToSlackStreamingMarkdown", () => {
  it("renders headings for Slack native markdown_text", () => {
    expect(markdownToSlackStreamingMarkdown("## ABC")).toBe("**ABC**");
  });

  it("keeps markdown links while normalizing headings and lists", () => {
    expect(markdownToSlackStreamingMarkdown("## Triage\n- [Needs reply](https://x.test/a)")).toBe(
      "**Triage**\n\n• [Needs reply](https://x.test/a)",
    );
  });

  it("normalizes multiline resolved symbol content for native streaming", () => {
    const linked = linkResolvedDataflowSymbolsForSlackMarkdown({
      sourceText: "$_DUALVIEW_SYM_web_fetch[1a8e].text.note",
      resolvedText:
        "## Incident note\n- *Why it matters:*\n- Source: X post relaying an article from iototsecnews.jp",
      symbolLinkUrl:
        "https://compsec.snu.ac.kr/adfi-test/bot/#batch/20260630_023124/session/08ab14aa-6d41-414a-a81d-167404731e2b",
    });
    const symbolUrl =
      "https://compsec.snu.ac.kr/adfi-test/bot/#batch/20260630_023124/session/08ab14aa-6d41-414a-a81d-167404731e2b/tab/conversation/symbol/%24_DUALVIEW_SYM_web_fetch%5B1a8e%5D.text.note";

    expect(markdownToSlackStreamingMarkdown(linked)).toBe(
      `[[Data begins]](${symbolUrl})\n\n` +
        "**Incident note**\n\n" +
        "• _Why it matters:_\n" +
        "• Source: X post relaying an article from iototsecnews.jp\n" +
        `[[Data ends]](${symbolUrl})`,
    );
  });
});

describe("escapeSlackMrkdwn", () => {
  it("returns plain text unchanged", () => {
    expect(escapeSlackMrkdwn("heartbeat status ok")).toBe("heartbeat status ok");
  });

  it("escapes slack and mrkdwn control characters", () => {
    expect(escapeSlackMrkdwn("mode_*`~<&>\\")).toBe("mode\\_\\*\\`\\~&lt;&amp;&gt;\\\\");
  });
});

describe("normalizeSlackOutboundText", () => {
  it("normalizes markdown for outbound send/update paths", () => {
    expect(normalizeSlackOutboundText(" **bold** ")).toBe("*bold*");
  });

  it("keeps prebuilt Slack links valid when labels contain angle-bracket text", () => {
    const symbolLink =
      "<https://compsec.snu.ac.kr/adfi-test/bot/#batch/20260629_034635/session/a12cd2ef-5b25-42bb-b84d-217ba951c8b3/tab/conversation/symbol/%24_DUALVIEW_SYM_exec%5B3268%5D.snippet.triage_report|  - Supporting documents needed for completed LLM API purchase (&lt;5Ry6VyZ-NnmBpLHR@example.com&gt;) — Minji asked you to send the payment receipt.>";

    expect(normalizeSlackOutboundText(symbolLink)).toBe(symbolLink);
  });

  it("does not label unresolved raw symbols for outbound update paths", () => {
    expect(
      normalizeSlackOutboundText("$_DUALVIEW_SYM_web_fetch[a1b2].title", {
        symbolLinkUrl: "http://127.0.0.1:18789/",
      }),
    ).toBe("$_DUALVIEW_SYM_web_fetch[a1b2].title");
  });
});
