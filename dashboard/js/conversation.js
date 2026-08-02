import S, { api } from './state.js';
import { esc, escSym, resolveSymbols, hasResolvableSymbols, highlightAdfiSystemLines, toolIcon, stripTs, tryPrettyJson, usableWsIds, renderWsSelector, wsTestNameMap, localTime } from './utils.js';
import { renderJsonTree, renderContentBlock, renderRefBadges, renderAuditInline, renderNotifyInline, getSymbolsFromEvent, auditOriginal, auditModified, renderAuditHeadBlock, isWebhook, renderWebhookMeta, inspectToolTraceSummary } from './render-helpers.js';

export async function fetchWsData(wsId) {
  const sid = S.currentSession.id;
  const fetches = [
    S.conversationData[wsId] ? S.conversationData[wsId] : api(`sessions/${sid}/workspace/${wsId}/conversation`),
    S.auditData[wsId] ? S.auditData[wsId] : api(`sessions/${sid}/workspace/${wsId}/audit`),
    S.notifyData[wsId] ? S.notifyData[wsId] : api(`sessions/${sid}/workspace/${wsId}/notify`),
    S.llmRequestsData[wsId] ? S.llmRequestsData[wsId] : api(`sessions/${sid}/workspace/${wsId}/llm-requests`),
    S.dualviewCommitsData[wsId] ? S.dualviewCommitsData[wsId] : api(`sessions/${sid}/workspace/${wsId}/dualview-commits?subdir=workspace`),
  ];
  const [conv, audit, notify, llmReqs, dualviewCommits] = await Promise.all(fetches);
  S.conversationData[wsId] = conv;
  S.auditData[wsId] = audit;
  S.notifyData[wsId] = notify;
  S.llmRequestsData[wsId] = llmReqs;
  S.dualviewCommitsData[wsId] = dualviewCommits;
}

/** Fetch data for a bot session (parallel to fetchWsData for e2e). */
export async function fetchBotData(batchId, sessionId) {
  const cacheKey = `bot:${batchId}:${sessionId}`;
  const [conv, audit, llmReqs, dualviewCommits] = await Promise.all([
    S.conversationData[cacheKey] || api(`bot/batches/${batchId}/sessions/${sessionId}/conversation`),
    S.auditData[cacheKey] || api(`bot/batches/${batchId}/audit`),
    S.llmRequestsData[cacheKey] || api(`bot/batches/${batchId}/llm-requests`),
    S.dualviewCommitsData[cacheKey] || api(`bot/batches/${batchId}/ws/dualview-commits?subdir=workspace`),
  ]);
  S.conversationData[cacheKey] = conv;
  S.auditData[cacheKey] = audit;
  S.llmRequestsData[cacheKey] = llmReqs;
  S.dualviewCommitsData[cacheKey] = dualviewCommits;
  // Bot mode has no notify
  S.notifyData[cacheKey] = [];
}

function assistantText(entry) {
  const content = entry?.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(block => block?.type === 'text')
    .map(block => block.text || '')
    .filter(Boolean)
    .join('\n\n');
}

function normalizeOutboundTextForMatch(text) {
  return String(text || '')
    .replace(/^\s*\[\[reply_to_current\]\]\s*/, '')
    .trim();
}

function stripReplyToCurrentPrefix(text) {
  return String(text ?? '').replace(/^\s*\[\[reply_to_current\]\]\s*/, '');
}

export function buildMessageSendingByMsgId(msgs, audits) {
  const assistantEntries = [];
  for (const e of Object.values(msgs || {}).flat()) {
    if (e?.type !== 'message' || e.message?.role !== 'assistant' || !e.id) continue;
    const text = assistantText(e);
    if (!text) continue;
    const tsMs = e.timestamp ? new Date(e.timestamp).getTime() : NaN;
    assistantEntries.push({
      entry: e,
      tsMs,
      normalizedText: normalizeOutboundTextForMatch(text),
    });
  }
  assistantEntries.sort((a, b) => (a.tsMs || 0) - (b.tsMs || 0));

  const messageSendingByMsgId = {};
  const consumedSendingKeys = new Set();
  const usedMsgIds = new Set();
  const sendings = (audits || [])
    .filter(a => a?.hookType === 'message_sending' && a.modifiedHead)
    .map(a => ({ audit: a, tsMs: a.ts ? new Date(a.ts).getTime() : NaN }))
    .sort((a, b) => (a.tsMs || 0) - (b.tsMs || 0));

  for (const { audit, tsMs } of sendings) {
    const key = 'message_sending:' + audit.ts;
    consumedSendingKeys.add(key);
    const original = normalizeOutboundTextForMatch(audit.originalHead || '');
    let matched = null;

    if (original) {
      for (let i = assistantEntries.length - 1; i >= 0; i--) {
        const candidate = assistantEntries[i];
        if (usedMsgIds.has(candidate.entry.id)) continue;
        if (candidate.normalizedText !== original) continue;
        if (Number.isFinite(tsMs) && Number.isFinite(candidate.tsMs) && candidate.tsMs > tsMs + 1000) continue;
        matched = candidate.entry;
        break;
      }
    }

    if (!matched) {
      for (let i = assistantEntries.length - 1; i >= 0; i--) {
        const candidate = assistantEntries[i];
        if (usedMsgIds.has(candidate.entry.id)) continue;
        if (!Number.isFinite(tsMs) || !Number.isFinite(candidate.tsMs) || candidate.tsMs <= tsMs) {
          matched = candidate.entry;
          break;
        }
      }
    }

    if (matched && !messageSendingByMsgId[matched.id]) {
      messageSendingByMsgId[matched.id] = audit.modifiedHead;
      usedMsgIds.add(matched.id);
    }
  }

  return { messageSendingByMsgId, consumedSendingKeys };
}

function botHistoryToolbar() {
  if (S.mode !== 'bot') return '';
  const view = S.botHistoryView || 'dual';
  const button = (key, label) =>
    `<button class="bot-view-btn${view === key ? ' active' : ''}" onclick="switchBotHistoryView('${key}')">${label}</button>`;
  return `<div class="bot-session-toolbar">
    <div class="bot-view-switch" aria-label="Session History view">
      ${button('dual', 'DualView')}
      ${button('agent', 'AgentView')}
      ${button('human', 'HumanView')}
      ${button('both', 'Both')}
    </div>
  </div>`;
}

// e2e-only two-state switch: default merged Timeline vs. shared DualView.
function renderE2eViewSwitch() {
  if (S.mode !== 'e2e') return '';
  const dv = !!S.e2eDualView;
  return `<div class="bot-view-switch e2e-view-switch" aria-label="Conversation view">
    <button class="bot-view-btn${dv ? ' active' : ''}" onclick="switchE2eDualView(true)">DualView</button>
    <button class="bot-view-btn${dv ? '' : ' active'}" onclick="switchE2eDualView(false)">Timeline</button>
  </div>`;
}

function displayToolName(name) {
  return name === 'inspect_symbol' ? 'ULLM' : (name || 'tool');
}

const BOT_SYMBOL_RE = /\$_DUALVIEW_SYM_[a-zA-Z_]\w*\[\w+\](?:\.[a-zA-Z_][\w[\].]*)?/g;

function botAttrJson(value) {
  return JSON.stringify(String(value ?? '')).replace(/"/g, '&quot;');
}

function botEventHref(stepId) {
  if (!S.currentBotBatch || !S.currentBotSession) return '#';
  let hash = `#batch/${encodeURIComponent(S.currentBotBatch.batchId)}`;
  hash += `/session/${encodeURIComponent(S.currentBotSession.sessionId)}`;
  hash += `/tab/conversation/event/${encodeURIComponent(stepId)}`;
  return hash;
}

function botEventLinkAttrs(stepId) {
  return `href="${esc(botEventHref(stepId))}" onclick="openBotEventLink(event, ${botAttrJson(stepId)})"`;
}

function botRegisterSymbols(audits) {
  S.symValueMap = S.symValueMap || {};
  for (const ev of audits || []) {
    for (const sym of getSymbolsFromEvent(ev, { fullValues: true })) {
      if (sym?.name && sym.value != null && S.symValueMap[sym.name] == null) {
        S.symValueMap[sym.name] = String(sym.value);
      }
    }
  }
}

function botSymbolValue(sym) {
  return S.symValueMap?.[sym] || '';
}

function botResolveSymbols(text) {
  return String(text ?? '').replace(BOT_SYMBOL_RE, sym => botSymbolValue(sym) || sym);
}

function botValueAttrs(sym, value) {
  return `data-symbol="${esc(sym)}" data-val="${esc(value)}" onclick="event.stopPropagation();showSymValue(this, ${botAttrJson(sym)}, this.dataset.val)"`;
}

function botInlineSymbols(text, view = 'agent', opts = {}) {
  const src = String(text ?? '');
  let out = '';
  let last = 0;
  for (const m of src.matchAll(BOT_SYMBOL_RE)) {
    const sym = m[0];
    out += esc(src.slice(last, m.index));
    const value = botSymbolValue(sym);
    const shown = view === 'human' && value ? value : sym;
    const cls = view === 'human' && value ? 'bot-original-token' : 'bot-symbol-token';
    if (opts.static) {
      out += `<span class="${cls}" data-symbol="${esc(sym)}">${esc(shown)}</span>`;
    } else if (view === 'human' && value) {
      out += `<span class="${cls}" role="button" tabindex="0" ${botValueAttrs(sym, value)}>${esc(shown)}</span>`;
    } else {
      out += `<button class="${cls}" data-symbol="${esc(sym)}" onclick="event.stopPropagation();showBotSymbolDetails(${botAttrJson(sym)})">${esc(shown)}</button>`;
    }
    last = m.index + sym.length;
  }
  out += esc(src.slice(last));
  return out;
}

function botSymbolsInText(text) {
  return [...new Set(String(text ?? '').match(BOT_SYMBOL_RE) || [])];
}

function botStringify(value) {
  if (typeof value === 'string') return value;
  return JSON.stringify(value ?? {}, null, 2);
}

function botParseJsonMaybe(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  try { return JSON.parse(value); } catch { return null; }
}

function botTrimText(text, max = 1400) {
  const src = String(text ?? '');
  return src.length > max ? src.slice(0, max - 1) + '...' : src;
}

function botFormatValue(value, view, depth = 0) {
  if (value == null) return '<span class="bot-muted">null</span>';
  if (typeof value === 'string') return `"${botInlineSymbols(botTrimText(value), view)}"`;
  if (typeof value === 'number' || typeof value === 'boolean') return esc(String(value));
  if (Array.isArray(value)) {
    const rows = value.map((item, idx) => `  [${idx}] ${botFormatValue(item, view, depth + 1)}`);
    return `[\n${rows.join('\n')}\n]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value);
    const rows = entries.map(([k, v]) => `${esc(k)}: ${botFormatValue(v, view, depth + 1)}`);
    return rows.join('\n');
  }
  return esc(String(value));
}

function botPreview(raw, view, opts = {}) {
  const parsed = botParseJsonMaybe(raw);
  const rawText = botStringify(raw);
  const pretty = parsed ? botFormatValue(parsed, view) : botInlineSymbols(botTrimText(rawText), view);
  const rawShown = botInlineSymbols(opts.fullRaw === false ? botTrimText(rawText, opts.rawMax || 12000) : rawText, view);
  return `<div class="bot-preview raw-off">${pretty}</div><pre class="bot-preview raw-on">${rawShown}</pre>`;
}

function botMessageText(msg) {
  const content = msg?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(b => b?.type === 'text').map(b => b.text || '').filter(Boolean).join('\n\n');
}

function botToolResultText(msg) {
  return msg?.content?.map(b => b.text || '').join('\n') || '';
}

function botUserMessage(rawText, ts) {
  const firstLine = String(rawText || '').split('\n')[0] || '';
  const m = firstLine.match(/Slack message in\s+(.+?)\s+from\s+(.+?):\s*(.*)$/i);
  const tail = String(rawText || '').split(/```\s*\n\n/).pop()?.trim() || '';
  const message = m?.[3]?.trim() || tail || stripTs(rawText);
  const sender = m?.[2]?.trim() || 'User';
  const time = ts ? localTime(ts, 'HH:mm') : '';
  return {
    title: 'Slack message',
    label: `${sender}${time ? ` · ${time}` : ''}`,
    message,
    raw: rawText,
  };
}

function botBuildAuditByCallId(audits) {
  const byId = {};
  for (const ev of audits || []) {
    if (!ev?.toolCallId) continue;
    if (!byId[ev.toolCallId]) byId[ev.toolCallId] = [];
    byId[ev.toolCallId].push(ev);
  }
  return byId;
}

function botResultAudit(hooks) {
  return hooks.find(ev => ev.hookType === 'inspect_symbol')
    || hooks.find(ev => ev.hookType === 'transform_tool_result')
    || hooks.find(ev => ev.hookType === 'tool_result')
    || null;
}

function botContextBoundary(entry) {
  const customType = entry?.customType || '';
  const data = entry?.data || {};
  if (customType === 'openclaw:prompt-error') {
    const error = data.error ? `: ${data.error}` : '';
    return {
      kind: 'context',
      ts: entry.timestamp || '',
      title: 'Agent context interrupted',
      label: `OpenClaw prompt error${error}`,
      message: 'The previous agent turn did not finish, so later dashboard entries are from the persisted transcript, not necessarily the live model context.',
      raw: data,
    };
  }
  if (String(customType).includes('compaction')) {
    return {
      kind: 'context',
      ts: entry.timestamp || '',
      title: 'Agent context changed',
      label: customType,
      message: 'OpenClaw compacted or changed the agent context at this point.',
      raw: data,
    };
  }
  return null;
}

function botBuildFlowSteps(msgs, audits) {
  botRegisterSymbols(audits);
  const entries = msgs?.main || [];
  const auditByCallId = botBuildAuditByCallId(audits);
  const resultByCallId = {};
  for (const entry of entries) {
    if (entry?.type === 'message' && entry.message?.role === 'toolResult' && entry.message.toolCallId) {
      resultByCallId[entry.message.toolCallId] = entry.message;
    }
  }

  const { messageSendingByMsgId } = buildMessageSendingByMsgId(msgs, audits);
  const steps = [];
  let idx = 0;
  const addStep = (step) => steps.push({ ...step, id: `bot-step-${idx++}` });

  for (const entry of entries) {
    if (entry?.type === 'custom') {
      const boundary = botContextBoundary(entry);
      if (boundary) addStep(boundary);
      continue;
    }
    if (entry?.type !== 'message' || !entry.message) continue;
    const msg = entry.message;

    if (msg.role === 'user') {
      const raw = msg.content?.map(b => b.text || '').join('\n') || '';
      if (!raw.trim()) continue;
      addStep({ kind: 'input', ts: entry.timestamp || '', input: botUserMessage(raw, entry.timestamp) });
      continue;
    }

    if (msg.role !== 'assistant') continue;

    for (const block of msg.content || []) {
      if (block.type === 'toolCall') {
        const hooks = auditByCallId[block.id] || [];
        const result = resultByCallId[block.id] || null;
        const resultAudit = botResultAudit(hooks);
        const callData = block.arguments || {};
        const resultAgent = botToolResultText(result) || resultAudit?.modifiedHead || '';
        const resultHuman = botSymbolsInText(resultAgent).length
          ? resultAgent
          : (resultAudit?.originalHead || botResolveSymbols(resultAgent));
        const created = (resultAudit?.symbolsCreated || []).map(s => s.name).filter(Boolean);
        const inputSyms = botSymbolsInText(botStringify(callData));
        const outputSyms = [...new Set([...created, ...botSymbolsInText(resultAgent)])];
        const toolName = displayToolName(block.name);
        const step = {
          kind: 'tool',
          ts: entry.timestamp || resultAudit?.ts || '',
          toolName,
          rawToolName: block.name,
          callId: block.id || '',
          callData,
          resultAgent,
          resultHuman,
          pending: !result && !resultAudit,
          inputSymbols: inputSyms,
          outputSymbols: outputSyms,
          symbols: [...new Set([...inputSyms, ...outputSyms])],
          // Per-call trust classification from the transform_tool_result audit
          // (authoritative; set by the policy engine at hook time). Drives the
          // DualView HumanView lane: a tool the T-LLM issued whose result was
          // classified UNTRUSTED gets mirrored to HumanView.
          trust: resultAudit?.trust || '',
          taintAction: resultAudit?.taintAction || '',
          origin: resultAudit?.origin || '',
          resultRaw: resultAudit?.originalHead || '',
        };
        if (block.name === 'inspect_symbol') {
          step.ullm = {
            inputAgent: {
              symbols: callData.symbols || [],
              prompt: callData.prompt || '',
              outputSchema: callData.outputSchema || {},
            },
            responseAgent: resultAudit?.modifiedHead || resultAgent,
            responseHuman: resultHuman,
            toolTrace: resultAudit?.toolTrace || [],
            model: resultAudit?.model || '',
          };
        }
        addStep(step);
      } else if (block.type === 'text') {
        const text = stripReplyToCurrentPrefix(block.text || '');
        if (!text.trim()) continue;
        const textHasSymbols = botSymbolsInText(text).length > 0;
        const sentText = stripReplyToCurrentPrefix(messageSendingByMsgId[entry.id] || '');
        addStep({
          kind: 'response',
          ts: entry.timestamp || '',
          agentText: text,
          humanText: textHasSymbols ? text : (sentText || botResolveSymbols(text)),
          symbols: botSymbolsInText(text),
        });
      }
    }
  }
  return steps;
}

function botStepTitle(step) {
  if (step.kind === 'input') return step.input?.title || 'Input';
  if (step.kind === 'response') return 'Response';
  if (step.kind === 'context') return step.title || 'Agent Context';
  return step.toolName || 'Tool';
}

function botSymbolResponseStep(sym) {
  const steps = S._botFlowSteps || [];
  return steps.find(step => step.kind === 'response' && (step.symbols || []).includes(sym))
    || steps.find(step => (step.symbols || []).includes(sym))
    || null;
}

function renderBotEventBlockLink(step, opts = {}) {
  if (!step) return '';
  const kind = step.kind === 'tool' ? 'Tool' : step.kind === 'response' ? 'Response' : 'Input';
  const title = opts.title || botStepTitle(step);
  const meta = [
    kind,
    step.ts ? localTime(step.ts, 'HH:mm:ss') : '',
  ].filter(Boolean).join(' · ');
  return `<a class="bot-block-link" ${botEventLinkAttrs(step.id)}>
    <strong>${esc(title)}</strong>
    <span>${esc(meta)}</span>
  </a>`;
}

function renderBotUllm(step, view) {
  if (!step.ullm) return '';
  const input = step.ullm.inputAgent;
  const response = view === 'human' ? step.ullm.responseHuman : step.ullm.responseAgent;
  return `<details class="bot-subsession" data-step-id="${esc(step.id)}" ontoggle="syncBotSubsession(${botAttrJson(step.id)}, this.open)">
    <summary>
      <div><strong>ULLM subagent</strong></div>
    </summary>
    <div class="bot-subflow">
      <div class="bot-substep">
        <div class="bot-step-kind">Input</div>
        ${botPreview(input, view)}
      </div>
      <div class="bot-substep">
        <div class="bot-step-kind">Response</div>
        ${botPreview(response, view)}
      </div>
    </div>
  </details>`;
}

// Simple mode collapses raw payloads behind a click so a lay viewer sees the
// story, not a wall of text; expert mode shows them inline as before.
function botWrapRaw(html) {
  if (!S.botSimpleMode) return html;
  return `<details class="bot-raw-details" onclick="event.stopPropagation()">
    <summary>show raw content</summary>${html}
  </details>`;
}

// DualView swim-lane: the U-LLM side of an inspect_symbol crossing. This is the
// only place original untrusted data is shown — the U-LLM works on resolved values in
// isolation. Symbols themselves never render here; the symbol↔raw mapping lives
// in the translation bands between the lanes (renderBotTranslationBand).
function renderBotUllmLaneCard(step) {
  const simple = !!S.botSimpleMode;
  const ullm = step.ullm || {};
  const input = ullm.inputAgent || {};
  const syms = input.symbols || [];
  const prompt = input.prompt || '';
  const time = step.ts ? localTime(step.ts, 'HH:mm:ss') : '';
  const model = ullm.model ? `<span class="bot-ullm-model"> · ${esc(ullm.model)}</span>` : '';

  const rawInput = syms.length
    ? `<div class="bot-ullm-raw">${syms.map(sym => {
        const value = botSymbolValue(sym);
        return `<div class="bot-ullm-raw-item">
          <span class="bot-ullm-raw-val">${value ? esc(botTrimText(value, 600)) : '<span class="bot-muted">no value recorded</span>'}</span>
        </div>`;
      }).join('')}</div>`
    : '<div class="bot-muted">No symbols inspected</div>';

  const helpers = inspectToolTraceSummary({ toolTrace: ullm.toolTrace || [] });
  const helperRow = helpers.length
    ? `<div class="bot-ullm-row">
        <span class="bot-ullm-label">${simple ? 'Tools used on original data' : 'U-LLM tool calls (original data)'}</span>
        <div class="bot-ullm-chips">${helpers.map(t => `<span class="bot-ullm-chip">${toolIcon(t)} ${esc(t)}</span>`).join('')}</div>
      </div>`
    : '';

  return `<div class="bot-ullm-card" data-step-id="${esc(step.id)}" onclick="showBotEventDetails(${botAttrJson(step.id)})">
    <div class="bot-ullm-card-head">
      <span class="bot-step-num">&#9313;</span>
      <span class="pill ullm">U-LLM</span>
      <span class="bot-ullm-card-sub">${simple ? 'processes original data' : 'U-LLM processing'}${model}</span>
      ${time ? `<span class="bot-step-time">${esc(time)}</span>` : ''}
    </div>
    <div class="bot-ullm-card-body">
      ${prompt ? `<div class="bot-ullm-row">
        <span class="bot-ullm-label">${simple ? 'What the assistant asked' : 'Instruction from T-LLM (resolved)'}</span>
        <div class="bot-preview">${esc(botTrimText(botResolveSymbols(prompt), 600))}</div>
      </div>` : ''}
      <div class="bot-ullm-row">
        <span class="bot-ullm-label bot-ullm-warn">${simple ? 'Original data' : 'Resolved original data'}</span>
        ${botWrapRaw(rawInput)}
      </div>
      ${helperRow}
      <div class="bot-ullm-row">
        <span class="bot-ullm-label bot-ullm-warn">${simple ? 'U-LLM output' : 'U-LLM output (original)'}</span>
        ${botWrapRaw(`<div class="bot-raw-box">${botPreview(botResolveSymbols(ullm.responseHuman || ''), 'human')}</div>`)}
      </div>
    </div>
  </div>`;
}

// DualView swim-lane: the untrusted side of a *normal* tool call whose result was
// classified UNTRUSTED (e.g. web_fetch on a non-allowlisted URL, exec, message
// read). Unlike inspect_symbol there is no U-LLM here — the tool executes and its
// original result lands here. Only original data renders in this card; the raw→symbol
// translation lives in the up-band between the lanes (renderBotTranslationBand).
function renderBotUntrustedToolCard(step) {
  const simple = !!S.botSimpleMode;
  const time = step.ts ? localTime(step.ts, 'HH:mm:ss') : '';
  const origin = step.origin ? `<span class="bot-ullm-card-origin">${esc(botTrimText(step.origin, 90))}</span>` : '';
  const rawResult = step.resultRaw || step.resultHuman || '';

  return `<div class="bot-ullm-card bot-untrusted-tool-card" data-step-id="${esc(step.id)}" onclick="showBotEventDetails(${botAttrJson(step.id)})">
    <div class="bot-ullm-card-head">
      <span class="bot-step-num">&#9313;</span>
      <span class="pill untrusted">HumanView (Original)</span>
      <span class="bot-ullm-card-sub"><code>${toolIcon(step.rawToolName)} ${esc(step.toolName || 'tool')}</code> ${simple ? 'runs on original data' : 'executes'}</span>
      ${time ? `<span class="bot-step-time">${esc(time)}</span>` : ''}
    </div>
    <div class="bot-ullm-card-body">
      ${origin ? `<div class="bot-ullm-row"><span class="bot-ullm-label">Origin</span>${origin}</div>` : ''}
      <div class="bot-ullm-row">
        <span class="bot-ullm-label bot-ullm-warn">${simple ? 'Original tool result' : 'Original untrusted data'}</span>
        ${rawResult ? botWrapRaw(`<div class="bot-raw-box">${botPreview(rawResult, 'human', { fullRaw: false })}</div>`) : '<div class="bot-muted">No result recorded</div>'}
      </div>
    </div>
  </div>`;
}

// Translation band: the only place symbols and raw values appear together. It
// renders centered between the lanes, on the trust boundary itself. Direction
// 'down' = symbols resolved to raw values for untrusted execution; 'up' = raw
// values symbolized before the result crosses back to the T-LLM. The symbol
// always sits left and the raw value right — matching the trusted (left) and
// untrusted (right) lanes — so only the arrow direction flips with the flow.
function renderBotTranslationBand(syms, dir, opts = {}) {
  if (!syms.length) return '';
  const simple = !!S.botSimpleMode;
  const label = dir === 'down'
    ? `<span class="bot-band-dir">AgentView &#10132; HumanView</span><span>${simple
        ? 'Resolve symbols for HumanView execution'
        : 'symbols resolved for HumanView execution'}</span>`
    : '<span class="bot-band-dir">HumanView &#10132; AgentView</span><span>Untrusted data is symbolized and returned to AgentView</span>';
  const arrow = dir === 'down' ? '&rarr;' : '&larr;';
  const items = syms.map(sym => {
    const value = botSymbolValue(sym);
    const valHtml = value
      ? `<span class="bot-band-val">${esc(botTrimText(value, 400))}</span>`
      : '<span class="bot-band-val bot-muted">no value recorded</span>';
    const symHtml = `<span class="bot-band-sym">${botInlineSymbols(sym, 'agent')}</span>`;
    return `<div class="bot-band-item">${symHtml}<span class="bot-band-arrow">${arrow}</span>${valHtml}</div>`;
  }).join('');
  return `<div class="bot-lane-band ${dir}">
    <div class="bot-band-label">${label}</div>
    <div class="bot-band-items">${items}</div>
  </div>`;
}

// Render-time isolation check: scan every piece of content the T-LLM saw (the
// trusted lane's data, not the DOM) for any recorded raw symbol value. Values
// shorter than MIN_LEN are skipped to avoid false positives on short/common
// strings. Any hit means original untrusted data reached AgentView content.
function botScanTrustedLeaks(steps) {
  const MIN_LEN = 24;
  const syms = Object.entries(S.symValueMap || {})
    .filter(([, value]) => typeof value === 'string' && value.length >= MIN_LEN);
  const leaks = [];
  let checkedSteps = 0;
  for (const step of steps) {
    const parts = [];
    if (step.kind === 'tool') {
      parts.push(botStringify(step.callData));
      if (!step.pending) parts.push(step.resultAgent || '');
    } else if (step.kind === 'response') {
      parts.push(step.agentText || '');
    } else if (step.kind === 'input') {
      parts.push(step.input?.raw || '');
    } else if (step.kind === 'context') {
      parts.push(botStringify(step.raw || {}));
    }
    const text = parts.join('\n');
    if (!text) continue;
    checkedSteps++;
    for (const [sym, value] of syms) {
      if (text.includes(value)) leaks.push({ stepId: step.id, sym });
    }
  }
  return { leaks, checkedSteps, symbolCount: syms.length };
}

function renderBotLeakBadge(scan) {
  const simple = !!S.botSimpleMode;
  const method = `checked ${scan.checkedSteps} steps &times; ${scan.symbolCount} symbols`;
  if (scan.leaks.length) {
    const first = scan.leaks[0];
    const plural = scan.leaks.length === 1 ? '' : 's';
    const text = simple
      ? `Original data reached AgentView content (${scan.leaks.length} match${plural})`
      : `${scan.leaks.length} match${plural} &mdash; original untrusted data found in AgentView content`;
    return `<div class="bot-leak-badge bad">
      <span>${text}</span>
      <a ${botEventLinkAttrs(first.stepId)}>${simple ? 'see where' : 'view first match'}</a>
    </div>`;
  }
  const text = simple
    ? 'No original untrusted data found in AgentView content'
    : '0 original untrusted values found in AgentView content';
  return `<div class="bot-leak-badge ok" title="${method.replace('&times;', 'x')}">
    <span>${text}</span>
    <span class="bot-leak-badge-method">&middot; ${method}</span>
  </div>`;
}

// One crossing tool call, vertically ordered:
//   (1) AgentView issues the call with symbols
//   (2) HumanView executes on original data
//   (3) AgentView receives the symbolized result
// with the symbol↔raw translation bands centered between the lanes.
function renderBotCallGroup(step, isUllmCrossing, opts = {}) {
  const toolTitle = isUllmCrossing ? 'inspect_symbol' : undefined;
  const laneRow = (cell, lane) => `<div class="bot-lane-row" data-step-id="${esc(step.id)}">
      <div class="bot-lane-cell trusted${lane === 'trusted' ? '' : ' bot-lane-idle'}">${lane === 'trusted' ? cell : ''}</div>
      <div class="bot-lane-cell untrusted${lane === 'untrusted' ? '' : ' bot-lane-idle'}">${lane === 'untrusted' ? cell : ''}</div>
    </div>`;
  const callRow = laneRow(renderBotFlowStep(step, 'agent', { part: 'call', toolTitle, leak: opts.leak }), 'trusted');
  const execRow = laneRow(isUllmCrossing ? renderBotUllmLaneCard(step) : renderBotUntrustedToolCard(step), 'untrusted');
  const resultRow = laneRow(renderBotFlowStep(step, 'agent', { part: 'result', toolTitle, leak: opts.leak }), 'trusted');
  const downSyms = isUllmCrossing ? (step.ullm?.inputAgent?.symbols || []) : (step.inputSymbols || []);
  const downBand = renderBotTranslationBand(downSyms, 'down');
  const upBand = step.pending ? '' : renderBotTranslationBand(step.outputSymbols || [], 'up', {
    what: isUllmCrossing ? 'U-LLM result' : `${step.toolName || 'tool'} result`,
  });
  return `<div class="bot-call-group" data-step-id="${esc(step.id)}">
    ${callRow}${downBand}${execRow}${upBand}${resultRow}
  </div>`;
}

// DualView swim-lane layout: left = AgentView (symbols), right = HumanView
// (original data). A vertical wall separates them; inspect_symbol rows and
// UNTRUSTED-classified tool results cross it as ordered call groups with
// translation bands on the boundary. AgentView is always rendered in symbol
// view, regardless of toggle state.
// Split the flow into exchanges: each starts at User input and ends at the
// last Agent Response before the next input. Powers the sidebar sub-session
// list and the endpoint highlights.
function botBuildExchanges(steps) {
  const exchanges = [];
  let current = null;
  steps.forEach((step, idx) => {
    if (step.kind === 'input') {
      current = {
        inputId: step.id,
        ts: step.ts,
        userText: botTrimText(String(step.input?.message || '').replace(/\s+/g, ' ').trim(), 80),
        replyId: null,
        replyText: '',
        startIdx: idx,   // first step of this sub-session (the user message)
        endIdx: idx,     // last step, extended to just before the next input
      };
      exchanges.push(current);
    } else if (current) {
      current.endIdx = idx;
      if (step.kind === 'response') {
        current.replyId = step.id;
        current.replyText = botTrimText(botResolveSymbols(step.humanText || step.agentText || '').replace(/\s+/g, ' ').trim(), 80);
      }
    }
  });
  return exchanges;
}

// Banner above the lanes showing which sub-session is in view, with prev/next
// navigation and a "full session" escape. Only shown when the session has more
// than one exchange (otherwise the whole session already is one sub-session).
function renderBotExchangeScopeBar(exchanges, scopeIdx) {
  if (!exchanges || exchanges.length <= 1) return '';
  const simple = !!S.botSimpleMode;
  if (scopeIdx == null) {
    return `<div class="bot-scope-bar">
      <span class="bot-scope-label">${simple ? 'Showing the whole session' : `Full session &middot; ${exchanges.length} sub-sessions`}</span>
      <button class="bot-scope-btn" onclick="selectBotExchange(0)">${simple ? 'View one at a time &rsaquo;' : 'Focus sub-session 1 &rsaquo;'}</button>
    </div>`;
  }
  const n = scopeIdx + 1;
  const prev = scopeIdx > 0 ? `<button class="bot-scope-btn" onclick="selectBotExchange(${scopeIdx - 1})">&lsaquo; Prev</button>` : '<button class="bot-scope-btn" disabled>&lsaquo; Prev</button>';
  const next = scopeIdx < exchanges.length - 1 ? `<button class="bot-scope-btn" onclick="selectBotExchange(${scopeIdx + 1})">Next &rsaquo;</button>` : '<button class="bot-scope-btn" disabled>Next &rsaquo;</button>';
  return `<div class="bot-scope-bar scoped">
    <span class="bot-scope-label"><strong>Sub-session ${n}</strong> of ${exchanges.length} &middot; ${simple ? 'one message &rarr; one reply' : 'single exchange'}</span>
    <div class="bot-scope-nav">${prev}${next}
      <button class="bot-scope-btn ghost" onclick="clearBotExchangeScope()">${simple ? 'Show whole session' : 'Full session'}</button>
    </div>
  </div>`;
}

function renderBotDualLanes(allSteps) {
  // When a sidebar sub-session is selected, scope the lanes to just that
  // exchange so it reads as one self-contained unit: a single end-user message
  // at the top and a single delivered reply at the bottom. Otherwise show the
  // whole session.
  const exchanges = botBuildExchanges(allSteps);
  const scopeIdx = Number.isInteger(S._botExchangeScope) ? S._botExchangeScope : null;
  const scoped = scopeIdx != null ? exchanges[scopeIdx] : null;
  const steps = scoped ? allSteps.slice(scoped.startIdx, scoped.endIdx + 1) : allSteps;

  const scan = botScanTrustedLeaks(steps);
  const leakStepIds = new Set(scan.leaks.map(l => l.stepId));
  // The two endpoints — the first user message in and the final delivered reply
  // out — are what the end user actually sees; only these two get the blue
  // highlight. In scoped view there is exactly one of each.
  const firstInput = steps.find(s => s.kind === 'input');
  const lastReplyId = [...steps].reverse().find(s => s.kind === 'response')?.id || null;
  const lastResponse = steps.find(s => s.id === lastReplyId) || null;
  const scopeBar = renderBotExchangeScopeBar(exchanges, scopeIdx);
  const rows = steps.map(step => {
    const leak = leakStepIds.has(step.id);
    const endpoint = step === firstInput ? 'sent' : step.id === lastReplyId ? 'received' : '';
    const isUllmCrossing = step.kind === 'tool' && step.rawToolName === 'inspect_symbol' && !!step.ullm;
    const isUntrustedTool = step.kind === 'tool' && step.rawToolName !== 'inspect_symbol' && step.trust === 'UNTRUSTED';
    if (isUllmCrossing || isUntrustedTool) return renderBotCallGroup(step, isUllmCrossing, { leak });
    const trusted = `<div class="bot-lane-cell trusted">${renderBotFlowStep(step, 'agent', { hideUllm: true, leak, endpoint })}</div>`;
    return `<div class="bot-lane-row" data-step-id="${esc(step.id)}">
      ${trusted}<div class="bot-lane-cell untrusted bot-lane-idle"></div>
    </div>`;
  }).join('');

  const deliveryZone = lastResponse ? renderBotDeliveryZone(lastResponse) : '';
  const simple = !!S.botSimpleMode;
  const trustedHead = simple
    ? `<strong>AgentView (Symbolized)</strong><span>T-LLM reads symbols</span>`
    : `<strong>AgentView (Symbolized) &middot; T-LLM</strong><span>symbolized data</span>`;
  const untrustedHead = simple
    ? `<strong>HumanView (Original)</strong><span>U-LLM and HumanView tools process original data</span>`
    : `<strong>HumanView (Original) &middot; U-LLM</strong><span>original data</span>`;
  return `<div class="bot-dual-lanes${simple ? ' simple-mode' : ''}">
    <div class="bot-dual-topbar">
      ${renderBotLeakBadge(scan)}
      <button class="bot-simple-toggle" onclick="toggleBotSimpleMode()" title="Switch between plain-language and expert labels">${simple ? 'Expert view' : 'Simple view'}</button>
    </div>
    ${scopeBar}
    <div class="bot-dual-head">
      <div class="bot-lane-head trusted"><span class="bot-lane-dot"></span>${trustedHead}</div>
      <div class="bot-lane-head untrusted"><span class="bot-lane-dot"></span>${untrustedHead}</div>
    </div>
    <div class="bot-dual-body">
      <div class="bot-lane-bg trusted" aria-hidden="true"></div>
      <div class="bot-lane-bg untrusted" aria-hidden="true"></div>
      <div class="bot-wall" aria-hidden="true"><span class="bot-wall-caption">DualView Isolation</span></div>
      ${rows || '<div class="no-data">No session events found</div>'}
      ${deliveryZone}
    </div>
  </div>`;
}

// Delivery zone: the final Agent Response in HumanView after symbol resolution.
function renderBotDeliveryZone(step) {
  const simple = !!S.botSimpleMode;
  const text = step.humanText || step.agentText || '';
  const syms = (step.symbols || []).filter(sym => botSymbolValue(sym));
  const band = syms.length
    ? `<div class="bot-lane-band bot-delivery-band">
        <div class="bot-band-label"><span class="bot-band-dir">AgentView &#10132; HumanView</span><span>${simple
          ? 'Resolve symbols for Agent Response'
          : 'symbols resolved for Agent Response'}</span></div>
        <div class="bot-band-items">${syms.map(sym => `<div class="bot-band-item">
            <span class="bot-band-sym">${botInlineSymbols(sym, 'agent')}</span>
            <span class="bot-band-arrow">&rarr;</span>
            <span class="bot-band-val">${esc(botTrimText(botSymbolValue(sym), 400))}</span>
          </div>`).join('')}</div>
      </div>`
    : '';
  return `<div class="bot-delivery-zone">
    ${band}
    <div class="bot-delivery-card" data-step-id="${esc(step.id)}" onclick="showBotEventDetails(${botAttrJson(step.id)})">
      <div class="bot-delivery-head">&#129302; Agent Response</div>
      <div class="bot-preview">${botInlineSymbols(text, 'human')}</div>
    </div>
  </div>`;
}

function renderBotFlowStep(step, view, opts = {}) {
  const stepId = `${step.id}-${view}${opts.part ? `-${opts.part}` : ''}`;
  const title = botStepTitle(step);
  const endpointSimple = !!S.botSimpleMode;
  const endpointTag = opts.endpoint
    ? `<span class="bot-endpoint-tag">${opts.endpoint === 'sent'
        ? 'User input'
        : '&#129302; Agent Response'}</span>`
    : '';
  let body = '';
  let head = '';

  if (step.kind === 'input') {
    head = `<span class="pill user">&#128100; User</span><span>${esc(title)}</span>`;
    const shown = `${step.input.label}\n\n${step.input.message}`;
    body = `<div class="bot-preview raw-off">${botInlineSymbols(shown, view)}</div>
      <pre class="bot-preview raw-on">${botInlineSymbols(step.input.raw, view)}</pre>`;
  } else if (step.kind === 'context') {
    head = `<span class="pill">Context</span><span>${esc(title)}</span>`;
    body = `<div class="bot-context-boundary-body">
        <strong>${esc(step.label || '')}</strong>
        <span>${esc(step.message || '')}</span>
      </div>
      <pre class="bot-preview raw-on">${esc(botStringify(step.raw || {}))}</pre>`;
  } else if (step.kind === 'tool') {
    const simple = !!S.botSimpleMode;
    const callData = step.callData;
    const resultData = view === 'human' ? step.resultHuman : step.resultAgent;
    const resultBody = step.pending ? renderBotPendingResult(step) : botPreview(resultData, view);
    const iconCode = `<code>${toolIcon(step.rawToolName)} ${esc(opts.toolTitle || title)}</code>`;
    // part: 'call' or 'result' renders just that half of the tool step — used by
    // the DualView call group to order call → untrusted execution → result.
    if (opts.part === 'call') {
      head = `<span class="bot-step-num">&#9312;</span><span class="pill agent">${simple ? 'Ask' : 'Call'}</span>${iconCode}
        <span class="bot-step-sub">${simple ? 'T-LLM tool call' : 'issued by T-LLM'}</span>`;
      body = botPreview(callData, view);
    } else if (opts.part === 'result') {
      head = `<span class="bot-step-num">&#9314;</span><span class="pill">${simple ? 'Receive' : 'Result'}</span>${iconCode}
        <span class="bot-step-sub">${simple ? 'Result returned to T-LLM' : 'received by T-LLM'}</span>`;
      body = resultBody;
    } else {
      head = `<span class="pill tool">Tool</span>${iconCode}`;
      body = `<div class="bot-step-line"><span class="pill agent">Call</span></div>
        ${botPreview(callData, view)}
        ${opts.hideUllm ? '' : renderBotUllm(step, view)}
        <div class="bot-step-line"><span class="pill">Result</span></div>
        ${resultBody}`;
    }
  } else {
    head = `<span class="pill response">&#128172; Response</span>`;
    body = botPreview(view === 'human' ? step.humanText : step.agentText, view);
  }

  return `<div id="${stepId}" class="bot-step bot-step-${esc(step.kind)}${opts.leak ? ' bot-step-leak' : ''}${opts.endpoint ? ' bot-step-endpoint' : ''}" data-step-id="${esc(step.id)}" onclick="showBotEventDetails(${botAttrJson(step.id)})">
    ${endpointTag}
    <div class="bot-step-head">${head}<span class="bot-step-time">${step.ts ? esc(localTime(step.ts, 'HH:mm:ss')) : ''}</span></div>
    <div class="bot-step-body">${body}</div>
  </div>`;
}

function renderBotPendingResult(step) {
  const since = step.ts ? ` since ${localTime(step.ts, 'HH:mm:ss')}` : '';
  return `<div class="bot-pending-result">
    <strong>Pending result${esc(since)}</strong>
    <span>No toolResult or DualView result audit has been written for this tool call yet.</span>
  </div>`;
}

function renderBotInspectorEmpty() {
  return `${renderBotInspectorTitle('Event Details', 'Select a box or symbol')}
    <div class="bot-inspector-body"><div class="bot-detail-card"><div class="bot-muted">Click an event box for event details, or click a symbol for its AgentView/HumanView mapping.</div></div></div>`;
}

function renderBotInspectorTitle(title, subtitle) {
  return `<button class="bot-inspector-rail bot-inspector-toggle" onclick="toggleBotInspector()" title="Show details" aria-label="Show details">‹</button>
    <div class="bot-inspector-title">
      <div class="bot-inspector-title-text"><strong>${esc(title)}</strong><span>${esc(subtitle || '')}</span></div>
      <button class="bot-inspector-toggle" onclick="toggleBotInspector()" title="Collapse details">›</button>
    </div>`;
}

function botSymbolCreatedAt(sym) {
  const steps = S._botFlowSteps || [];
  const found = steps.find(step => (step.outputSymbols || []).includes(sym))
    || steps.find(step => (step.symbols || []).includes(sym));
  return found || null;
}

function botSymbolTrajectory(sym) {
  const steps = (S._botFlowSteps || []).filter(step => (step.symbols || []).includes(sym));
  if (steps.length === 0) return '<div class="bot-muted">No trajectory recorded in this session.</div>';
  return `<div class="bot-detail-trajectory">${steps.map((step, idx) => {
    const roles = [];
    if ((step.inputSymbols || []).includes(sym)) roles.push('Input');
    if ((step.outputSymbols || []).includes(sym)) roles.push('Output');
    if (roles.length === 0) roles.push(step.kind === 'response' ? 'Response' : 'Used');
    const kind = step.kind === 'tool' ? 'Tool' : step.kind === 'response' ? 'Response' : 'Input';
    let rows = '';
    if (step.kind === 'tool') {
      rows = `<div class="bot-detail-trajectory-row">
          <span>Input</span>
          <div>${botInlineSymbols(botTrimText(botStringify(step.callData), 220), 'agent', { static: true })}</div>
        </div>
        <div class="bot-detail-trajectory-row">
          <span>Result</span>
          <div>${botInlineSymbols(botTrimText(step.resultAgent, 260), 'agent', { static: true })}</div>
        </div>`;
    } else if (step.kind === 'response') {
      rows = `<div class="bot-detail-trajectory-row">
        <span>Text</span>
        <div>${botInlineSymbols(botTrimText(step.agentText || '', 260), 'agent', { static: true })}</div>
      </div>`;
    } else {
      rows = `<div class="bot-detail-trajectory-row">
        <span>Text</span>
        <div>${botInlineSymbols(botTrimText(step.input?.message || '', 260), 'agent', { static: true })}</div>
      </div>`;
    }
    const edge = idx < steps.length - 1 ? '<div class="bot-detail-trajectory-arrow">↓</div>' : '';
    return `<a class="bot-detail-trajectory-node" ${botEventLinkAttrs(step.id)}>
      <div class="bot-detail-trajectory-head">
        <span>${esc(kind)}</span>
        <strong>${esc(botStepTitle(step))}</strong>
        <em>${esc(roles.join(' / '))}</em>
      </div>
      <div class="bot-detail-trajectory-rows">${rows}</div>
    </a>${edge}`;
  }).join('')}</div>`;
}

function renderBotSymbolInspector(sym) {
  const value = botSymbolValue(sym);
  const created = botSymbolCreatedAt(sym);
  const appears = botSymbolResponseStep(sym);
  const humanValue = value
    ? `<div class="bot-human-value" role="button" tabindex="0" ${botValueAttrs(sym, value)}>${esc(value)}</div>`
    : '<span class="bot-muted">No original value recorded</span>';
  return `${renderBotInspectorTitle('Symbol Details', sym)}
    <div class="bot-inspector-body">
      <div class="bot-detail-card">
        <div class="bot-detail-card-title">Agent / human mapping</div>
        <div class="bot-kv"><div>AgentView</div><div>${botInlineSymbols(sym, 'agent')}</div></div>
        <div class="bot-kv"><div>HumanView</div><div>${humanValue}</div></div>
        ${appears ? `<div class="bot-kv"><div>Appears in</div><div>${renderBotEventBlockLink(appears, { title: appears.kind === 'response' ? 'Response block' : botStepTitle(appears) })}</div></div>` : ''}
        ${created ? `<div class="bot-kv"><div>Created at</div><div>${esc(botStepTitle(created))}</div></div>` : ''}
      </div>
      <div class="bot-detail-card">
        <div class="bot-detail-card-title">Symbol trajectory</div>
        ${botSymbolTrajectory(sym)}
      </div>
    </div>`;
}

function renderBotEventInspector(step) {
  if (!step) return renderBotInspectorEmpty();
  if (step.kind === 'context') {
    return `${renderBotInspectorTitle('Event Details', botStepTitle(step))}
      <div class="bot-inspector-body">
        <div class="bot-detail-card">
          <div class="bot-detail-card-title">${esc(step.label || botStepTitle(step))}</div>
          ${step.ts ? `<div class="bot-kv"><div>Time</div><div>${esc(localTime(step.ts, 'HH:mm:ss'))}</div></div>` : ''}
          <div class="bot-preview">${esc(step.message || '')}</div>
        </div>
        <div class="bot-detail-card">
          <div class="bot-detail-card-title">Raw event</div>
          <pre class="bot-preview">${esc(botStringify(step.raw || {}))}</pre>
        </div>
      </div>`;
  }
  const agent = step.kind === 'input'
    ? `${step.input.label}\n\n${step.input.message}`
    : step.kind === 'tool' ? `Call\n${botStringify(step.callData)}\n\nResult\n${step.resultAgent}` : step.agentText;
  const human = step.kind === 'input'
    ? `${step.input.label}\n\n${step.input.message}`
    : step.kind === 'tool' ? `Call\n${botStringify(step.callData)}\n\nResult\n${step.resultHuman}` : step.humanText;
  const syms = step.symbols || [];
  return `${renderBotInspectorTitle('Event Details', botStepTitle(step))}
    <div class="bot-inspector-body">
      <div class="bot-detail-card">
        <div class="bot-detail-card-title">${esc(botStepTitle(step))}</div>
        ${step.ts ? `<div class="bot-kv"><div>Time</div><div>${esc(localTime(step.ts, 'HH:mm:ss'))}</div></div>` : ''}
        ${syms.length ? `<div class="bot-kv"><div>Symbols</div><div>${syms.map(sym => botInlineSymbols(sym, 'agent')).join(' ')}</div></div>` : ''}
      </div>
      <div class="bot-detail-card">
        <div class="bot-detail-card-title">AgentView</div>
        <div class="bot-preview">${botInlineSymbols(agent, 'agent')}</div>
      </div>
      <div class="bot-detail-card">
        <div class="bot-detail-card-title">HumanView</div>
        <div class="bot-preview">${botInlineSymbols(human, 'human')}</div>
      </div>
    </div>`;
}

// The flow-shell + inspector aside wrapper shared by every bot Session History
// view AND the e2e DualView. Keeping one wrapper guarantees identical structure.
function renderFlowShell(flow, { rawClass = '', inspectorClass = '', collapsed = false } = {}) {
  return `<div class="bot-flow-shell${rawClass}${inspectorClass}">
    <div class="bot-flow-main">
      <section class="bot-turn">
        <div class="bot-turn-head">
          <div class="bot-turn-title"><span class="pill blue">session</span><span>Session History</span></div>
        </div>
        <div class="bot-flow">${flow || '<div class="no-data">No session events found</div>'}</div>
      </section>
    </div>
    <aside class="bot-inspector${collapsed ? ' collapsed' : ''}" id="bot-inspector">${renderBotInspectorEmpty()}</aside>
  </div>`;
}

// Store the built flow steps plus the derived end-user exchanges, and refresh
// the bot sidebar so its per-session exchange list stays in sync.
function botSetFlowSteps(steps) {
  S._botFlowSteps = steps;
  S._botExchanges = botBuildExchanges(steps);
  if (S.mode === 'bot') window.renderBotSidebar?.();
}

// Shared DualView renderer: built once, called by both the bot `dual` view and
// the e2e DualView toggle. Sets S._botFlowSteps so inspector click handlers work.
function dualViewHtml(msgs, audits, opts = {}) {
  const steps = botBuildFlowSteps(msgs, audits);
  botSetFlowSteps(steps);
  return renderFlowShell(renderBotDualLanes(steps), opts);
}

function renderBotSessionHistory(el, msgs, audits) {
  const rawClass = S.botRawMode ? ' show-raw' : '';
  const inspectorClass = S.botInspectorCollapsed ? ' inspector-collapsed' : '';
  const collapsed = S.botInspectorCollapsed;
  const view = S.botHistoryView || 'dual';

  if (view === 'dual') {
    el.innerHTML = dualViewHtml(msgs, audits, { rawClass, inspectorClass, collapsed });
    return;
  }

  const steps = botBuildFlowSteps(msgs, audits);
  botSetFlowSteps(steps);
  const flow = view === 'both'
    ? `<div class="bot-view-head-row"><div>AgentView</div><div>HumanView</div></div>
      <div class="bot-both-rows">${steps.map(step => `<div class="bot-both-row" data-step-id="${esc(step.id)}">
        ${renderBotFlowStep(step, 'agent')}
        ${renderBotFlowStep(step, 'human')}
      </div>`).join('')}</div>`
    : `<div class="bot-single-transcript">${steps.map(step => renderBotFlowStep(step, view)).join('')}</div>`;

  el.innerHTML = renderFlowShell(flow, { rawClass, inspectorClass, collapsed });
}

export function toggleBotRawMode(enabled) {
  S.botRawMode = !!enabled;
  document.querySelector('.bot-flow-shell')?.classList.toggle('show-raw', S.botRawMode);
}

export function showBotSymbolDetails(sym) {
  S.botInspectorCollapsed = false;
  document.querySelector('.bot-flow-shell')?.classList.remove('inspector-collapsed');
  document.getElementById('bot-inspector')?.classList.remove('collapsed');
  document.querySelectorAll('.bot-step.highlight-target').forEach(el => el.classList.remove('highlight-target'));
  document.querySelectorAll('.bot-symbol-token.active, .bot-original-token.active').forEach(el => el.classList.remove('active'));
  document.querySelectorAll(`[data-symbol="${CSS.escape(sym)}"]`).forEach(el => el.classList.add('active'));
  const targetStep = botSymbolResponseStep(sym) || botSymbolCreatedAt(sym);
  if (targetStep?.id) {
    document.querySelectorAll(`.bot-step[data-step-id="${CSS.escape(targetStep.id)}"]`).forEach(el => el.classList.add('highlight-target'));
    document.querySelector(`.bot-step[data-step-id="${CSS.escape(targetStep.id)}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  const inspector = document.getElementById('bot-inspector');
  if (inspector) inspector.innerHTML = renderBotSymbolInspector(sym);
}

export function showBotEventDetails(stepId) {
  S.botInspectorCollapsed = false;
  document.querySelector('.bot-flow-shell')?.classList.remove('inspector-collapsed');
  document.getElementById('bot-inspector')?.classList.remove('collapsed');
  const step = (S._botFlowSteps || []).find(s => s.id === stepId);
  document.querySelectorAll('.bot-symbol-token.active, .bot-original-token.active').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.bot-step.highlight-target').forEach(el => el.classList.remove('highlight-target'));
  document.querySelectorAll(`.bot-step[data-step-id="${CSS.escape(stepId)}"]`).forEach(el => el.classList.add('highlight-target'));
  const target = document.querySelector(`.bot-step[data-step-id="${CSS.escape(stepId)}"]`);
  if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const inspector = document.getElementById('bot-inspector');
  if (inspector) inspector.innerHTML = renderBotEventInspector(step);
}

export function openBotEventLink(event, stepId) {
  event?.preventDefault();
  event?.stopPropagation();
  showBotEventDetails(stepId);
  const href = event?.currentTarget?.getAttribute('href') || botEventHref(stepId);
  if (href && href !== '#') history.replaceState(null, '', href);
}

export function syncBotSubsession(stepId, open) {
  document.querySelectorAll(`.bot-subsession[data-step-id="${CSS.escape(stepId)}"]`).forEach(el => {
    if (el.open !== open) el.open = open;
  });
}

// Scope the DualView lanes to a single sub-session (exchange). Re-renders the
// conversation and refreshes the sidebar so the active sub-session is marked.
export function selectBotExchange(idx) {
  S._botExchangeScope = idx;
  if (S.mode === 'bot' && (S.botHistoryView || 'agent') !== 'dual') S.botHistoryView = 'dual';
  window.showTab?.('conversation');
}

export function clearBotExchangeScope() {
  S._botExchangeScope = null;
  window.showTab?.('conversation');
}

export function toggleBotInspector() {
  S.botInspectorCollapsed = !S.botInspectorCollapsed;
  document.querySelector('.bot-flow-shell')?.classList.toggle('inspector-collapsed', S.botInspectorCollapsed);
  document.getElementById('bot-inspector')?.classList.toggle('collapsed', S.botInspectorCollapsed);
}

export async function renderConversation(el) {
  S.cumulativeSymbols = [];
  S.symValueMap = {};
  S._ftFileContents = [];

  // Bot mode: fetch data via bot API and use bot cache key
  let cacheKey;
  let allWsIds = [];
  if (S.mode === 'eval' && S.currentEvalRunId && S.currentEvalTask) {
    // Eval mode: data already fetched and cached by selectEvalTask
    cacheKey = `eval:${S.currentEvalRunId}:${S.currentEvalTask}`;
  } else if (S.mode === 'bot' && S.currentBotBatch && S.currentBotSession) {
    const batchId = S.currentBotBatch.batchId;
    const sessionId = S.currentBotSession.sessionId;
    if (batchId === '__stitched__') {
      cacheKey = `bot:__stitched__:${S.currentBotSession.sessionKey}`;
    } else {
      cacheKey = `bot:${batchId}:${sessionId}`;
      await fetchBotData(batchId, sessionId);
    }
  } else {
    // E2E mode
    allWsIds = usableWsIds(S.currentSession);
    if (allWsIds.length === 0) {
      el.innerHTML = '<div class="no-data">No workspace data available for this session</div>';
      return;
    }
    if (!S.currentWsId || !allWsIds.includes(S.currentWsId)) S.currentWsId = allWsIds[0];
    cacheKey = S.currentWsId;
    await fetchWsData(S.currentWsId);
  }

  const msgs = S.conversationData[cacheKey] || {};
  const audits = S.auditData[cacheKey] || [];
  const notifies = S.notifyData[cacheKey] || [];
  const llmReqs = S.llmRequestsData[cacheKey] || {};
  const dualviewCommits = S.dualviewCommitsData[cacheKey] || {};

  if (S.mode === 'bot') {
    renderBotSessionHistory(el, msgs, audits, llmReqs);
    return;
  }

  // E2E DualView: optional rendering that reuses the exact bot DualView pipeline.
  // The default e2e timeline (below) is unchanged when the toggle is off.
  if (S.mode === 'e2e' && S.e2eDualView) {
    let head = '';
    if (allWsIds.length > 1) head += renderWsSelector(allWsIds, "switchWorkspace(this.value)");
    head += renderE2eViewSwitch();
    el.innerHTML = head + dualViewHtml(msgs, audits);
    return;
  }

  // Compute the main session's time window so we can drop stale entries
  // from persistent audit/notify logs that accumulate across bot runs.
  // The dualview audit files (`logs/dualview-audit/*.jsonl`, `__file_tracking__.jsonl`)
  // and u-llm session files are append-only and shared across runs, so
  // without this filter, hooks like before_tool_call / transform_tool_result
  // / inspect_symbol / file_commit_worktree from a prior session leak to
  // the top of the conversation view.
  let mainSessionStartTs = '';
  for (const entry of msgs.main || []) {
    if (entry.type === 'batch_boundary') continue;
    const ts = entry.timestamp || entry.message?.timestamp || '';
    if (ts) { mainSessionStartTs = ts; break; }
  }

  // Build a unified timeline
  const timeline = [];

  for (const agent in msgs) {
    for (const entry of msgs[agent]) {
      if (entry.type === 'batch_boundary') {
        timeline.push({ kind: 'batch_boundary', ts: entry.date || '', data: entry });
        continue;
      }
      const ts = entry.timestamp || entry.message?.timestamp || '';
      timeline.push({ kind: 'conv', ts, data: entry, agent });
    }
  }

  for (const ev of audits) {
    const ts = ev.ts || '';
    if (mainSessionStartTs && ts && ts < mainSessionStartTs) continue;
    timeline.push({ kind: 'audit', ts, data: ev });
  }

  // Add LLM requests (system/user prompts sent to API)
  for (const req of Object.values(llmReqs).flat()) {
    timeline.push({ kind: 'llm-request', ts: req.ts || '', data: req });
  }

  // Add notify events (filter stale entries from prior runs, same as audits)
  for (const n of notifies) {
    const ts = n.ts || '';
    if (mainSessionStartTs && ts && ts < mainSessionStartTs) continue;
    timeline.push({ kind: 'notify', ts, data: n });
  }

  // Stable sort by timestamp; when timestamps are close (within 50ms),
  // sort conv entries before audit/notify so that renderGroupedConvEntry
  // consumes audit entries before the timeline loop renders them standalone.
  const kindOrder = { conv: 0, audit: 1, notify: 2 };
  timeline.sort((a, b) => {
    if (!a.ts || !b.ts) return 0;
    const ta = new Date(a.ts).getTime();
    const tb = new Date(b.ts).getTime();
    const diff = ta - tb;
    if (Math.abs(diff) <= 50) return (kindOrder[a.kind] ?? 9) - (kindOrder[b.kind] ?? 9);
    return diff;
  });

  let html = '';
  if (allWsIds.length > 1) {
    html += renderWsSelector(allWsIds, "switchWorkspace(this.value)");
  }

  html += renderE2eViewSwitch();
  html += botHistoryToolbar();

  html += `<div class="expand-controls">
    <button class="expand-btn" onclick="toggleAll(this, true)">Expand All</button>
    <button class="expand-btn" onclick="toggleAll(this, false)">Collapse All</button>
    <button class="expand-btn" id="usage-toggle" onclick="toggleUsageInfo()">${S.showUsageInfo ? 'Hide' : 'Show'} Stats</button>
    <button class="expand-btn" id="entry-time-toggle" onclick="toggleEntryTime()">${S.showEntryTime ? 'Hide' : 'Show'} Time</button>
  </div>`;

  if (timeline.length === 0) {
    const noDataMsg = S.mode === 'bot'
      ? 'No conversation data found for this bot session (bot workspace data is under tmp-runs/bot/log-sessions/)'
      : S.mode === 'eval'
        ? 'No conversation data found for this eval task'
        : 'No data found (workspace data is available in test/log-sessions/ for recent batches)';
    html += `<div class="no-data">${esc(noDataMsg)}</div>`;
    el.innerHTML = html;
    return;
  }

  // Filter audits to the current main session's time window (same reasoning
  // as the timeline filter above). This keeps inline audit rendering inside
  // tool call groups consistent with the top-level timeline.
  const sessionAudits = mainSessionStartTs
    ? audits.filter(ev => !ev.ts || ev.ts >= mainSessionStartTs)
    : audits;

  // Index audit events by toolCallId
  const auditByCallId = {};
  for (const ev of sessionAudits) {
    const cid = ev.toolCallId;
    if (cid) {
      if (!auditByCallId[cid]) auditByCallId[cid] = [];
      auditByCallId[cid].push(ev);
    }
  }

  // Find webhook audit event (transform_webhook_content) for the session
  const webhookAudit = sessionAudits.find(ev => isWebhook(ev)) || null;

  // Index tool results by toolCallId. Keep a parallel map of the outer
  // entry timestamps so inspect_symbol ↔ u-llm matching can use the tool
  // result time as the upper bound of the matching window.
  const resultByCallId = {};
  const resultTsByCallId = {};
  for (const entry of Object.values(msgs).flat()) {
    if (entry.type === 'message' && entry.message?.role === 'toolResult' && entry.message.toolCallId) {
      resultByCallId[entry.message.toolCallId] = entry.message;
      resultTsByCallId[entry.message.toolCallId] = entry.timestamp || '';
    }
  }

  // ── message_sending audit → assistant message ──────────────────────
  // DUALVIEW emits `message_sending` audit entries (with no toolCallId) each
  // time the agent's outbound payload text is resolved/transformed
  // before CLI / JSON / external delivery. Attach each entry to the
  // closest-preceding assistant message with text content, so the
  // renderer can show the audit's `modifiedHead` as the "Response
  // (Resolved)" view — that's the authoritative text the user actually
  // saw, not the client-side regex-resolve fallback. Also marks the
  // entries as consumed so they don't re-render as standalone audit
  // blocks after the last response.
  const { messageSendingByMsgId, consumedSendingKeys } = buildMessageSendingByMsgId(msgs, sessionAudits);

  // Index notify events by timestamp
  const notifyByTs = {};
  for (const n of notifies) {
    const key = (n.ts || '').slice(0, 19);
    if (!notifyByTs[key]) notifyByTs[key] = [];
    notifyByTs[key].push(n);
  }

  // Fetch assertion results for inline placement
  let assertionData = null;
  if (S.mode === 'bot' && S.currentBotBatch && S.currentBotBatch.batchId !== '__stitched__') {
    // Bot per-batch sessions: permissive assertions (skip for collected/stitched views)
    try {
      const botData = await api(`bot/batches/${S.currentBotBatch.batchId}/assertions`);
      assertionData = { assertions: botData.results || [], permissive: botData.permissive, taintMode: botData.taintMode };
    } catch { /* endpoint not available */ }
  } else if (S.mode !== 'bot' && S.currentSession && S.currentWsId) {
    try {
      assertionData = await api(`sessions/${S.currentSession.id}/workspace/${S.currentWsId}/assertions`);
    } catch { /* endpoint not available */ }
  }
  const allAssertions = (assertionData && assertionData.assertions) || [];
  S._currentAssertions = allAssertions;
  S._assertionMeta = assertionData ? { active: assertionData.active, runtimeMeta: assertionData.runtimeMeta } : null;

  // Index assertions by tool name for inline rendering
  const assertionsByTool = {};
  const unplacedAssertions = [];
  for (const a of allAssertions) {
    if (a.tool) {
      if (!assertionsByTool[a.tool]) assertionsByTool[a.tool] = [];
      assertionsByTool[a.tool].push(a);
    } else {
      unplacedAssertions.push(a);
    }
  }
  // Track which assertions have been consumed (rendered inline)
  const consumedAssertionIdxs = new Set();

  // Pre-compute outline entries for the sidebar
  const outlineEntries = [];
  let outlineIdx = 0;

  // Track which audit/result/notify items are consumed (rendered as children)
  const consumedAuditIds = new Set();
  // Pre-consume webhook audit so it doesn't render standalone in the timeline
  // (it will be rendered inline with the user message instead)
  if (webhookAudit) {
    consumedAuditIds.add((webhookAudit.toolCallId || 'null') + ':' + webhookAudit.hookType);
  }
  const consumedResultIds = new Set();
  const consumedNotifyIdxs = new Set();

  // Group u-llm entries into sessions so inspect_symbol tool call groups
  // can match them by timestamp window instead of queue order. Queue order
  // is fragile: stale u-llm .jsonl files from prior bot runs accumulate in
  // the sessions directory and offset the pairing, causing wrong u-llm
  // content to show inside an inspect_symbol and orphaned u-llm entries to
  // leak to the top-level timeline.
  const ullmEntries = msgs.ullm || [];
  const ullmSessions = [];
  {
    let cur = null;
    for (const e of ullmEntries) {
      if (e.type === 'session') {
        if (cur) ullmSessions.push(cur);
        cur = {
          startTs: e.timestamp || '',
          entries: [e],
          userEntry: null,
          assistantEntry: null,
          assistantEntries: [],
          matched: false,
          llmReq: null,
          llmReqIdx: -1,
        };
      } else if (e.type === 'message' && cur) {
        cur.entries.push(e);
        if (e.message?.role === 'user' && !cur.userEntry) cur.userEntry = e;
        if (e.message?.role === 'assistant') {
          cur.assistantEntries.push(e);
          if (!cur.assistantEntry) cur.assistantEntry = e;
        }
      } else if (cur) {
        cur.entries.push(e);
      }
    }
    if (cur) ullmSessions.push(cur);
  }

  // Pair u-llm llm-request logs to sessions by walking both lists in
  // chronological order. This is robust to stale requests/sessions: both
  // come from persistent audit dirs and may include entries from prior
  // runs that don't line up 1:1.
  {
    const sortedReqs = (llmReqs.ullm || [])
      .map((req, idx) => ({ req, idx }))
      .filter(x => x.req.ts)
      .sort((a, b) => a.req.ts.localeCompare(b.req.ts));
    let rc = 0;
    for (const s of ullmSessions) {
      if (!s.startTs) continue;
      while (rc < sortedReqs.length && sortedReqs[rc].req.ts < s.startTs) rc++;
      if (rc < sortedReqs.length) {
        s.llmReq = sortedReqs[rc].req;
        s.llmReqIdx = sortedReqs[rc].idx;
        rc++;
      }
    }
  }

  // Hide ALL u-llm entries from the top-level timeline. Sessions matched to
  // an inspect_symbol tool call will be re-emitted inline by renderToolCallGroup
  // via renderInlineUllm. Unmatched sessions (stale files, truly orphaned)
  // are silently hidden — by design u-llm should never appear at top level.
  const consumedUllmIds = new Set();
  for (const e of ullmEntries) if (e.id) consumedUllmIds.add(e.id);

  // Track LLM request index for matching to assistant responses
  let llmReqIdx = {};
  const globalIdxByAgentIdx = {};
  let contentHtml = '';

  // WIP/inactive banner at top of conversation content
  if (assertionData?.active === 'wip') {
    contentHtml += `<div style="background:color-mix(in srgb, var(--yellow) 12%, transparent);border:1px solid color-mix(in srgb, var(--yellow) 40%, transparent);border-radius:4px;padding:6px 12px;margin-bottom:8px;display:flex;align-items:center;gap:8px">
      <span style="color:var(--yellow);font-weight:700;font-size:12px">WIP</span>
      <span style="color:var(--fg2);font-size:11px">This test is work-in-progress &mdash; assertion failures are non-blocking</span>
    </div>`;
  } else if (assertionData?.active === false) {
    contentHtml += `<div style="background:color-mix(in srgb, var(--fg3) 10%, transparent);border:1px solid var(--border);border-radius:4px;padding:6px 12px;margin-bottom:8px;display:flex;align-items:center;gap:8px">
      <span style="color:var(--fg3);font-weight:700;font-size:12px">INACTIVE</span>
      <span style="color:var(--fg3);font-size:11px">This test is inactive &mdash; skipped during test runs</span>
    </div>`;
  }

  let prevAssistantTs = null;  // track elapsed between assistant turns
  // Session start = first timeline entry timestamp (for total elapsed)
  const sessionStartTs = timeline.length > 0 && timeline[0].ts ? timeline[0].ts : null;

  for (const item of timeline) {
    let entryHtml = '';
    let outlineLabel = null;
    let outlineClass = '';
    let outlineChildren = [];

    if (item.kind === 'batch_boundary') {
      const bd = item.data;
      const label = bd.batchId || 'unknown';
      const dateStr = bd.date ? localTime(bd.date, 'date') + ' ' + localTime(bd.date, 'HH:mm') : '';
      const branchStr = bd.gitBranch ? ` (${esc(bd.gitBranch)})` : '';
      entryHtml = `<div class="batch-boundary"><span class="batch-boundary-line"></span><span class="batch-boundary-label">${esc(label)}${branchStr} ${esc(dateStr)}</span><span class="batch-boundary-line"></span></div>`;
    } else if (item.kind === 'conv') {
      // Skip U-LLM entries already consumed by an inspect_symbol tool call group
      if (item.agent === 'ullm' && consumedUllmIds.has(item.data.id)) continue;
      const agent = item.agent;
      llmReqIdx[agent] ??= 0;
      const prevMatchedCount = ullmSessions.reduce((n, s) => n + (s.matched ? 1 : 0), 0);
      const ullmState = {
        sessions: ullmSessions,
        consumed: consumedUllmIds,
        globalIdxByAgentIdx,
        curMsgTs: item.data.timestamp || item.ts || '',
        resultTsByCallId,
      };
      // Compute elapsed: per-turn (since previous) and session total (since session start)
      let turnElapsedMs = null;
      let sessionElapsedMs = null;
      if (item.data.type === 'message' && item.data.message?.role === 'assistant' && item.ts) {
        const nowMs = new Date(item.ts).getTime();
        if (prevAssistantTs) turnElapsedMs = nowMs - new Date(prevAssistantTs).getTime();
        if (sessionStartTs) sessionElapsedMs = nowMs - new Date(sessionStartTs).getTime();
      }
      entryHtml = renderGroupedConvEntry(item.data, llmReqs[agent], auditByCallId, resultByCallId,
        consumedAuditIds, consumedResultIds, { llmReqIdx: llmReqIdx[agent], agent, ullm: ullmState, turnElapsedMs, sessionElapsedMs, webhookAudit, messageSendingByMsgId }, dualviewCommits, assertionsByTool, consumedAssertionIdxs);
      const turnMatchedAnyUllm = ullmSessions.reduce((n, s) => n + (s.matched ? 1 : 0), 0) > prevMatchedCount;
      if (item.data.type === 'message' && item.data.message?.role === 'assistant') {
        prevAssistantTs = item.ts;
        const isTrusted = agent === 'main';
        outlineLabel = S.mode === 'bot' ? (isTrusted ? 'Agent' : 'ULLM') : (isTrusted ? 'T-LLM' : 'U-LLM');
        outlineClass = isTrusted ? 'ol-trusted' : 'ol-untrusted';
        // Collect tool call names + key argument as children
        // Extract user prompt from the LLM request for this turn
        const llmReq = (llmReqs[agent] || [])[llmReqIdx[agent]] || null;
        let userPromptText = '';
        if (llmReq?.messages) {
          for (let i = llmReq.messages.length - 1; i >= 0; i--) {
            if (llmReq.messages[i].role === 'user') {
              const content = llmReq.messages[i].content;
              if (Array.isArray(content)) {
                userPromptText = content.filter(b => b.type === 'text' && b.text).map(b => b.text).join('\n\n');
              } else if (typeof content === 'string') {
                userPromptText = content;
              }
              break;
            }
          }
        }
        const toolCalls = [];
        if (userPromptText && llmReqIdx[agent] > 0) {
          toolCalls.push({ name: 'Context', detail: userPromptText, type: 'user-prompt' });
        }
        for (const b of (item.data.message.content || []).filter(b => b.type === 'toolCall')) {
            let name = b.name || b.toolName || 'tool';
            const args = b.arguments || {};
            let detail = '';
            const nameLower = name.toLowerCase();
            if (nameLower.includes('web_fetch') || nameLower.includes('webfetch')) {
              detail = args.url || '';
            } else if (nameLower.includes('inspect')) {
              detail = args.prompt || '';
            } else if (nameLower.includes('exec')) {
              detail = args.command || '';
              if (args.env?.WITH_SYMBOLS === '1') {
                name = 'exec (trusted)';
              }
            } else if (nameLower.includes('read') || nameLower.includes('write')) {
              detail = args.file_path || args.filepath || args.path || '';
            }
            toolCalls.push({ name: displayToolName(name), detail, trusted: args.env?.WITH_SYMBOLS === '1' });
            // If this inspect_symbol matched a U-LLM session, add it as a child
            if (nameLower.includes('inspect') && turnMatchedAnyUllm) {
              toolCalls.push({ name: 'U-LLM', detail: '', type: 'ullm' });
            }
        }
        outlineChildren = toolCalls;
        // Extract thinking text for inline preview
        var _outlineThinking = (item.data.message.content || [])
          .filter(b => b.type === 'thinking').map(b => b.thinking || '').join('\n\n');
        llmReqIdx[agent]++;
      } else if (item.data.type === 'message' && item.data.message?.role === 'user') {
        // Skip ullm user messages in the outline — the prompt forwarded to
        // the untrusted LLM is already visible inside the LLM request body;
        // showing it again creates a confusing duplicate "User" entry.
        if (agent === 'ullm') continue;
        outlineLabel = webhookAudit ? 'Webhook' : 'User';
        outlineClass = webhookAudit ? 'ol-hook' : 'ol-user';
        // Extract user prompt text for hover
        var _outlineThinking = (item.data.message.content || [])
          .filter(b => b.type === 'text').map(b => b.text || '').join('\n\n');
      }
    } else if (item.kind === 'audit') {
      // message_sending entries are folded into the closest preceding
      // assistant message's "Response (Resolved)" block above — skip
      // rendering them as standalone audit blocks.
      if (item.data.hookType === 'message_sending'
          && consumedSendingKeys.has('message_sending:' + item.data.ts)) {
        continue;
      }
      if (!consumedAuditIds.has(item.data.toolCallId + ':' + item.data.hookType)) {
        if (item.data.taintAction === 'classify_trusted') continue;
        entryHtml = renderAuditInline(item.data);
        outlineLabel = item.data.hookType || '';
        outlineClass = 'ol-hook';
      }
    } else if (item.kind === 'notify') {
      // Skip guard:before_tool_call notifications — redundant with audit inline
      const ntext = item.data.text || '';
      if (ntext.includes('[DUALVIEW-classify:before_tool_call]')) continue;
      entryHtml = renderNotifyInline(item.data);
    }

    if (entryHtml) {
      const id = `conv-item-${outlineIdx}`;
      // Timestamp badge: always `HH:mm:ss (YYYY-MM-DD)`. Full ISO is in
      // the tooltip for hover inspection. Batch boundaries already carry
      // their own date header, so skip the badge there.
      let tsHtml = '';
      if (item.ts && item.kind !== 'batch_boundary') {
        const dateStr = localTime(item.ts, 'date');
        const timeStr = localTime(item.ts, 'HH:mm:ss');
        const label = dateStr ? `${timeStr} (${dateStr})` : timeStr;
        tsHtml = `<span class="conv-entry-ts" title="${esc(item.ts)}">${esc(label)}</span>`;
      }
      contentHtml += `<div id="${id}" class="conv-entry-wrap">${tsHtml}${entryHtml}</div>`;
      if (outlineLabel) {
        outlineEntries.push({ id, label: outlineLabel, cls: outlineClass, children: outlineChildren, thinking: typeof _outlineThinking === 'string' ? _outlineThinking : '', ts: item.ts });
        _outlineThinking = undefined;
      }
      outlineIdx++;
    }
  }

  // Build outline sidebar
  S._outlineThinkings = [];
  window._outlineThinkings = S._outlineThinkings;
  S._outlineUserPrompts = [];
  window._outlineUserPrompts = S._outlineUserPrompts;
  let outlineHtml = '';
  for (let oi = 0; oi < outlineEntries.length; oi++) {
    const oe = outlineEntries[oi];
    // Compute delta from previous entry (only shown when timing is enabled)
    let deltaHtml = '';
    if (S.showOutlineTiming && oe.ts && oi > 0) {
      const prevTs = outlineEntries[oi - 1]?.ts;
      if (prevTs) {
        const deltaMs = new Date(oe.ts).getTime() - new Date(prevTs).getTime();
        if (deltaMs >= 0) {
          const deltaSec = deltaMs / 1000;
          const deltaStr = deltaSec >= 60 ? `${(deltaSec / 60).toFixed(1)}m` : `${deltaSec.toFixed(1)}s`;
          const slow = deltaSec >= 10;
          deltaHtml = ` <span class="ol-delta${slow ? ' ol-delta-slow' : ''}">${deltaStr}</span>`;
        }
      }
    }
    if (oe.cls === 'ol-user') {
      outlineHtml += '<div class="conv-outline-divider"></div>';
    }
    const isLlm = oe.cls === 'ol-trusted' || oe.cls === 'ol-untrusted';
    if (isLlm) {
      const groupBorder = oe.cls === 'ol-trusted' ? 'var(--green)' : 'var(--yellow)';
      outlineHtml += `<div class="conv-outline-group" style="border-left:2px solid ${groupBorder};margin-left:2px;border-radius:3px;margin-bottom:3px;padding-left:2px;">`;
    }
    const isUser = oe.cls === 'ol-user';
    const thinkIdx = S._outlineThinkings.length;
    S._outlineThinkings.push(oe.thinking || '');
    const hoverTitle = isLlm ? 'Thinking' : isUser ? 'User Prompt' : '';
    const hoverColor = (isLlm || isUser) ? 'var(--cyan)' : 'var(--pink)';
    const llmHover = ((isLlm || isUser) && oe.thinking) ? ` onmouseenter="showArgPopup(event,'${hoverTitle}',_outlineThinkings[${thinkIdx}],'${hoverColor}')" onmouseleave="hideArgPopup()"` : '';
    const thinkPreview = ((isLlm || isUser) && oe.thinking) ? ` <span class="ol-think-preview">${esc(oe.thinking.replace(/\n/g, ' '))}</span>` : '';
    outlineHtml += `<div class="conv-outline-item ${oe.cls}" data-target="${oe.id}" onclick="scrollHighlight('${oe.id}')"${llmHover}>${esc(oe.label)}${deltaHtml}${thinkPreview}</div>`;
    if (oe.children && oe.children.length > 0) {
      for (const tool of oe.children) {
        if (tool.type === 'ullm') {
          // Render U-LLM as a child of the preceding inspect_symbol
          outlineHtml += `<div class="conv-outline-item ol-tool-arg" data-target="${oe.id}" onclick="scrollHighlight('${oe.id}')" style="color:var(--pink);font-weight:600"><span class="ol-tool-icon">U</span>ULLM</div>`;
          continue;
        }
        if (tool.type === 'user-prompt') {
          const promptPreview = tool.detail.replace(/\n/g, ' ');
          const truncated = promptPreview.length > 60 ? promptPreview.slice(0, 60) + '...' : promptPreview;
          const upIdx = S._outlineUserPrompts.length;
          S._outlineUserPrompts.push(tool.detail);
          outlineHtml += `<div class="conv-outline-item ol-user-prompt" data-target="${oe.id}" onclick="scrollHighlight('${oe.id}')" onmouseenter="showArgPopup(event,'Context',_outlineUserPrompts[${upIdx}],'var(--cyan)')" onmouseleave="hideArgPopup()"><span class="ol-tool-icon">C</span>${esc(truncated)}</div>`;
          continue;
        }
        const icon = toolIcon(tool.name);
        const toolHoverDetail = tool.detail ? `${tool.name}: ${tool.detail}` : tool.name;
        const toolStyle = tool.trusted ? ' style="color:var(--green)"' : '';
        outlineHtml += `<div class="conv-outline-item ol-tool" data-target="${oe.id}" onclick="scrollHighlight('${oe.id}')" onmouseenter="showArgPopup(event,'${esc(tool.name)}','${esc(toolHoverDetail).replace(/'/g,"&#39;")}')" onmouseleave="hideArgPopup()"${toolStyle}><span class="ol-tool-icon">${icon}</span>${esc(tool.name)}</div>`;
        if (tool.detail) {
          outlineHtml += `<div class="conv-outline-item ol-tool-arg" data-target="${oe.id}" onclick="scrollHighlight('${oe.id}')" onmouseenter="showArgPopup(event,'${esc(tool.name)}','${esc(tool.detail).replace(/'/g,"&#39;")}')" onmouseleave="hideArgPopup()"${toolStyle}>${esc(tool.detail)}</div>`;
        }
      }
    }
    if (isLlm) {
      outlineHtml += '</div>';
    }
  }

  // Render bottom assertion summary panel — split by correctness / utility
  if (allAssertions.length > 0) {
    const isNotCalledSkip = (a) => a.status === 'pass' && a.reason && a.reason.includes('not called');
    const visibleAssertions = allAssertions.filter(a => !isNotCalledSkip(a));
    const hiddenCount = allAssertions.length - visibleAssertions.length;

    const correctness = visibleAssertions.filter(a => a.category === 'correctness');
    const utility = visibleAssertions.filter(a => a.category !== 'correctness');

    const stats = (list) => {
      const pass = list.filter(a => a.status === 'pass').length;
      const fail = list.filter(a => a.status === 'fail').length;
      const warn = list.filter(a => a.status === 'warn').length;
      const skip = list.filter(a => a.status === 'skip').length;
      const total = list.length;
      const effective = total - skip - warn;
      const allPass = fail === 0;
      const color = !allPass ? 'var(--red)' : warn > 0 ? 'var(--yellow)' : 'var(--green)';
      return { pass, fail, warn, skip, total, effective, allPass, color };
    };

    const cStats = stats(correctness);
    const uStats = stats(utility);
    // Only correctness failures block the test; utility failures are non-blocking
    const overallFail = cStats.fail;
    const utilityFail = uStats.fail;
    const overallColor = overallFail > 0 ? 'var(--red)' : (cStats.warn + uStats.warn + utilityFail) > 0 ? 'var(--yellow)' : 'var(--green)';

    const renderGroup = (title, list, st) => {
      if (list.length === 0) return '';
      const sorted = [...list].sort((a, b) => {
        const aInlined = consumedAssertionIdxs.has(a) ? 0 : 1;
        const bInlined = consumedAssertionIdxs.has(b) ? 0 : 1;
        return aInlined - bInlined;
      });
      let html = `<div class="assertion-group">
        <div class="assertion-group-header" style="border-left-color:${st.color}">
          <span class="assertion-group-title">${title}</span>
          <span class="assertion-group-score" style="color:${st.color}">${st.pass}/${st.effective}</span>
        </div>`;
      for (const a of sorted) {
        const origIdx = allAssertions.indexOf(a);
        const icon = a.status === 'pass' ? '✓' : a.status === 'fail' ? '✗' : a.status === 'warn' ? '⚠' : a.status === 'skip' ? '⊘' : '⚠';
        const wasInlined = consumedAssertionIdxs.has(a);
        const cls = a.status === 'pass' ? 'assertion-pass' : a.status === 'fail' ? 'assertion-fail' : a.status === 'warn' ? 'assertion-warn' : a.status === 'skip' ? 'assertion-skip' : 'assertion-error';
        const inlinedCls = wasInlined ? ' assertion-inlined' : '';
        const inlinedBadge = wasInlined ? `<span class="assertion-inlined-badge" title="Shown inline above with tool call: ${esc(a.tool || '')}">inlined</span>` : '';
        const descHtml = a.description ? `<span class="assertion-description">${esc(a.description)}</span>` : '';
        const inlinedStyle = wasInlined ? ' style="color:var(--fg1)"' : '';
        html += `<div class="assertion-item ${cls}${inlinedCls}" data-aidx="${origIdx}" onclick="showAssertionPopup(event, ${origIdx})"${inlinedStyle}>
          <span class="assertion-icon">${icon}</span>
          ${inlinedBadge}
          <span class="assertion-label">${esc(a.label)}</span>
          ${descHtml}
          <span class="assertion-reason">${esc(a.reason)}</span>
        </div>`;
      }
      html += '</div>';
      return html;
    };

    const overallPass = cStats.pass + uStats.pass;
    const overallEffective = cStats.effective + uStats.effective;
    const nonBlockingTotal = cStats.warn + uStats.warn + utilityFail;
    const nonBlockingSuffix = nonBlockingTotal > 0 ? `, ${nonBlockingTotal} non-blocking` : '';
    const hiddenSuffix = hiddenCount > 0 ? `, ${hiddenCount} hidden` : '';
    const overallLabel = overallFail > 0
      ? `${overallFail} FAILED${nonBlockingSuffix}${hiddenSuffix}`
      : nonBlockingTotal > 0
        ? `PASSED${nonBlockingSuffix}${hiddenSuffix}`
        : `ALL PASSED${hiddenSuffix}`;

    let assertionsHtml = `<div class="assertion-panel" id="assertion-panel">
      <div class="assertion-header" style="border-left-color:${overallColor}">
        <span class="assertion-title">Assertions</span>
        <span class="assertion-summary" style="color:${overallColor}">${overallPass}/${overallEffective} passed &mdash; ${overallLabel}</span>
        ${assertionData?.permissive ? `<span style="font-size:10px;color:var(--fg3);margin-left:8px;border:1px solid var(--fg3);border-radius:3px;padding:0 4px;">permissive</span>` : ''}
      </div>
      <div class="assertion-list">`;

    assertionsHtml += renderGroup('Correctness', correctness, cStats);
    assertionsHtml += renderGroup('Utility', utility, uStats);

    assertionsHtml += '</div></div>';
    contentHtml += assertionsHtml;

    // Add to outline
    const olAssertCls = overallFail > 0 ? 'ol-assertions-fail' : nonBlockingTotal > 0 ? 'ol-assertions-warn' : 'ol-assertions-pass';
    outlineHtml += `<div class="conv-outline-item ol-assertions ${olAssertCls}" data-target="assertion-panel" onclick="scrollHighlight('assertion-panel')">
      Assertions ${overallPass}/${overallEffective}${nonBlockingTotal > 0 ? ` (${nonBlockingTotal} ⚠)` : ''}
    </div>`;
  }

  const timingBtnLabel = S.showOutlineTiming ? '⏱' : '⏱';
  const timingBtnCls = S.showOutlineTiming ? ' active' : '';
  const outlineControls = `<div class="outline-width-controls">
    <button onclick="resizeOutline(0.5)" title="Narrower">−</button>
    <button onclick="resizeOutline(2)" title="Wider">+</button>
    <button class="ol-timing-btn${timingBtnCls}" onclick="toggleOutlineTiming()" title="Toggle timing">${timingBtnLabel}</button>
  </div>`;
  const botViewClass = S.mode === 'bot' ? ` bot-history-${S.botHistoryView || 'dual'}` : '';
  html += `<div class="conv-layout${botViewClass}">
    <div class="conv-outline" id="conv-outline">${outlineControls}${outlineHtml || '<div class="no-data" style="font-size:11px">No entries</div>'}</div>
    <div class="conv-outline-handle" id="conv-outline-handle"></div>
    <div class="conv-content${S.showEntryTime ? ' conv-show-time' : ''}" id="conv-scroll">${contentHtml}</div>
  </div>`;
  el.innerHTML = html;

  // Set up scroll tracking to highlight the outline sidebar
  setupConvScrollTracking(outlineEntries);
}

export function renderApiContent(content) {
  const raw = JSON.stringify(content, null, 2);
  let pretty;
  if (Array.isArray(content)) {
    const parts = content.map(b => {
      if (b.type === 'text' && b.text) return tryPrettyJson(b.text);
      if (b.type === 'tool_use') return `[tool_use: ${b.name}]\n${JSON.stringify(b.input, null, 2)}`;
      if (b.type === 'tool_result') {
        const inner = Array.isArray(b.content)
          ? b.content.map(c => c.text ? tryPrettyJson(c.text) : `[${c.type}]`).join('\n')
          : typeof b.content === 'string' ? tryPrettyJson(b.content) : JSON.stringify(b.content, null, 2);
        return `[tool_result: ${b.tool_use_id || ''}]\n${inner}`;
      }
      return JSON.stringify(b, null, 2);
    });
    pretty = parts.join('\n\n');
  } else if (typeof content === 'string') {
    pretty = tryPrettyJson(content);
  } else {
    pretty = raw;
  }
  return { pretty, raw };
}

export function renderGroupedConvEntry(entry, llmReqs, auditByCallId, resultByCallId,
    consumedAuditIds, consumedResultIds, state, dualviewCommits, assertionsByTool, consumedAssertionIdxs) {
  let html = '';
  if (entry.type === 'session') {
    html += `<div class="conv-meta">Session: ${esc(entry.id)}<br>cwd: ${esc(entry.cwd)}</div>`;
  } else if (entry.type === 'model_change') {
    html += `<div class="conv-meta">Model: ${esc(entry.provider)}/${esc(entry.modelId)}</div>`;
  } else if (entry.type === 'thinking_level_change') {
    html += `<div class="conv-meta">Thinking: ${esc(entry.thinkingLevel)}</div>`;
  } else if (entry.type === 'message') {
    const msg = entry.message;
    if (!msg) return '';

    if (msg.role === 'user') {
      const text = stripTs(msg.content?.map(b => b.text || '').join('\n') || '');
      html += `<div class="conv-turn-divider"><span></span></div>`;
      // Check if this is a webhook message (has a matching transform_webhook_content audit)
      const webhookAudit = state.webhookAudit;
      if (webhookAudit) {
        const original = auditOriginal(webhookAudit);
        html += renderContentBlock(original, { role: 'Webhook (Original)', roleClass: 'hook', open: false, sym: false, forceDetails: true });
        html += renderAuditInline(webhookAudit);
        html += renderContentBlock(text, { role: 'Webhook (Transformed)', roleClass: 'hook', open: true, sym: true, forceDetails: true });
      } else {
        html += renderContentBlock(text, { role: 'User', roleClass: 'user', open: true, sym: false });
      }
    } else if (msg.role === 'assistant') {
      // Match with LLM request (by index)
      const llmReq = (llmReqs || [])[state.llmReqIdx] || null;
      const isTrusted = state.agent === 'main';
      const llmLabel = S.mode === 'bot' ? (isTrusted ? 'Agent' : 'ULLM') : (isTrusted ? 'T-LLM' : 'U-LLM');
      const llmClass = isTrusted ? 'conv-llm-trusted' : 'conv-llm-untrusted';
      const model = msg.model || llmReq?.model || '';

      // Build children: LLM request prompts + thinking + tool calls (with hooks/results) + text
      let children = '';

      // LLM request system/user prompts
      if (llmReq) {
        // For ullm, each inspect_symbol starts a fresh session — no shared
        // history, so never diff against a previous session's request.
        const prevLlmReq = isTrusted && state.llmReqIdx > 0 ? ((llmReqs || [])[state.llmReqIdx - 1] || null) : null;
        children += renderLlmRequestBody(llmReq, prevLlmReq, isTrusted ? 'var(--green)' : 'var(--pink)');
      }

      // Assistant content blocks
      const blocks = msg.content || [];
      for (const block of blocks) {
        if (block.type === 'thinking') {
          children += renderContentBlock(block.thinking || '', { role: 'Thinking', roleClass: 'assistant',
            summaryStyle: 'background:color-mix(in srgb, var(--green) 10%, var(--bg))', roleStyle: 'color:var(--green)', open: false, sym: false });
        } else if (block.type === 'toolCall') {
          children += renderToolCallGroup(block, auditByCallId, resultByCallId, consumedAuditIds, consumedResultIds, dualviewCommits, assertionsByTool, consumedAssertionIdxs, state.ullm);
        } else if (block.type === 'text') {
          const respText = block.text || '';
          const hasSyms = hasResolvableSymbols(respText);
          const respLabel = 'Response';
          children += renderContentBlock(respText, { role: respLabel, roleClass: 'assistant',
            summaryStyle: 'background:color-mix(in srgb, var(--green) 10%, var(--bg))', roleStyle: 'color:var(--green)', open: true, sym: true, view: hasSyms ? 'agent' : null });
          // Prefer the authoritative resolved text from DUALVIEW's
          // message_sending audit entry (the Agent Response after symbol
          // resolution) over the client-side regex
          // resolve fallback. The audit entry only exists for sessions
          // recorded after the openclaw CLI-hook patch; older sessions
          // fall back to the client-side resolver.
          const sentText = state.messageSendingByMsgId?.[entry.id];
          if (sentText && sentText !== respText) {
            children += renderContentBlock(sentText, { role: 'Response', roleClass: 'assistant',
              summaryStyle: 'background:color-mix(in srgb, var(--green) 10%, var(--bg))', roleStyle: 'color:var(--green)', open: false, sym: false, view: 'human' });
          } else if (hasSyms) {
            children += renderContentBlock(resolveSymbols(respText), { role: 'Response', roleClass: 'assistant',
              summaryStyle: 'background:color-mix(in srgb, var(--green) 10%, var(--bg))', roleStyle: 'color:var(--green)', open: false, sym: false, view: 'human' });
          }
        }
      }

      // Show error info for empty assistant messages (e.g. stop=error from failed live API fallback)
      if (blocks.length === 0 && (msg.stopReason === 'error' || msg.stopReason === 'aborted')) {
        const errText = msg.errorMessage || msg.stopReason || 'empty response';
        children += `<div class="conv-error" style="color:var(--red);padding:4px 8px;font-size:12px;opacity:0.8">${esc(errText)}</div>`;
      }

      // Usage info (tokens, model, elapsed)
      if (msg.usage) {
        const u = msg.usage;
        const cost = u.cost?.total ? ` | $${u.cost.total.toFixed(4)}` : '';
        const fmtMs = (ms) => ms >= 60000 ? (ms / 60000).toFixed(1) + 'm' : (ms / 1000).toFixed(1) + 's';
        const turnMs = state.turnElapsedMs;
        const sesMs = state.sessionElapsedMs;
        const turnPart = turnMs != null && turnMs >= 0 ? fmtMs(turnMs) : null;
        const sesPart = sesMs != null && sesMs >= 0 ? fmtMs(sesMs) : null;
        const elStr = turnPart || sesPart
          ? ` | ${turnPart ?? '—'}/${sesPart ?? '—'}`
          : '';
        const vis = S.showUsageInfo ? '' : ' style="display:none"';
        children += `<div class="usage-info usage-detail"${vis}>${u.input}in + ${u.output}out = ${u.totalTokens}tok${cost} | ${esc(msg.model)} | ${esc(msg.stopReason)}${elStr}</div>`;
      }

      const summaryExtra = model ? ` (${esc(model)})` : '';
      html += `<details class="conv-entry" open><summary class="${llmClass}">
        <span class="conv-role" style="color:${isTrusted ? 'var(--green)' : 'var(--yellow)'};">${llmLabel}</span>${summaryExtra}
      </summary><div class="conv-body conv-children">${children}</div></details>`;

    } else if (msg.role === 'toolResult') {
      // Standalone tool results (not consumed by a tool call group)
      if (!consumedResultIds.has(msg.toolCallId)) {
        html += renderToolResultEntry(msg);
      }
    }
  }
  return html;
}

/** Render LLM request body (system + user prompts), marking repeated context from previous call. */
export function renderLlmRequestBody(req, prevReq, color = 'var(--green)') {
  let html = '';
  const prevMsgCount = prevReq?.messages?.length || 0;
  const prevSysCount = prevReq?.system ? (Array.isArray(prevReq.system) ? prevReq.system.length : 1) : 0;

  // System prompts — repeated if prev had same system
  if (req.system) {
    const sysParts = Array.isArray(req.system) ? req.system : [{ type: 'text', text: req.system }];
    const isRepeatedSys = prevSysCount > 0; // system prompt is always the same across calls
    for (const part of sysParts) {
      if (part.type === 'text' && part.text) {
        const label = part.cache_control ? ' (cached)' : '';
        const ctxLabel = isRepeatedSys ? ' <span class="ctx-badge">ctx</span>' : '';
        const hasAdfi = /\$_DUALVIEW_SYM_|DualView_UNTRUSTED|DUALVIEW-TRUSTED|DUALVIEW-UNTRUSTED|inspect_symbol|symbol_table|symbol.*table|dualview/i.test(part.text);
        const textPreview = part.text.length > 80 ? part.text.slice(0, 80) + '...' : part.text;
        const opacity = isRepeatedSys ? ' style="opacity:0.5"' : '';
        const sysHtml = hasAdfi ? highlightAdfiSystemLines(esc(part.text)) : esc(part.text);
        html += `<details class="conv-entry"${opacity}><summary class="conv-message" style="background:color-mix(in srgb, ${color} 10%, var(--bg))">
          <span class="conv-role" style="color:${color}">System Prompt${label}</span>${ctxLabel} ${esc(textPreview)} (${part.text.length}c)
        </summary><div class="conv-body"><pre class="conv-pre">${sysHtml}</pre></div></details>`;
      }
    }
  }

  // Messages — mark those that were in the previous request as context
  if (req.messages) {
    const newStartIdx = prevMsgCount; // messages before this index are repeated context
    const contextCount = Math.min(prevMsgCount, req.messages.length);

    if (contextCount > 0) {
      html += `<details class="conv-entry" style="opacity:0.5"><summary class="conv-message" style="background:color-mix(in srgb, ${color} 10%, var(--bg))">
        <span class="conv-role" style="color:${color}">Context</span> <span class="ctx-badge">ctx</span> ${contextCount} previous messages (repeated from prior call)
      </summary><div class="conv-body">`;
      for (let i = 0; i < contextCount; i++) {
        html += renderApiMessage(req.messages[i], color);
      }
      html += '</div></details>';
    }

    // New messages (not in previous request).
    // Separate into: tool-loop messages (assistant + toolResult pairs from the
    // tool execution loop) vs. the final user message that triggered this call.
    const newMsgs = req.messages.slice(newStartIdx);
    // Find the last user message — everything before it is tool-loop context
    let lastUserIdx = -1;
    for (let i = newMsgs.length - 1; i >= 0; i--) {
      if (newMsgs[i].role === 'user') { lastUserIdx = i; break; }
    }
    // Tool-loop messages (assistant responses + tool results fed back)
    const toolLoopMsgs = lastUserIdx > 0 ? newMsgs.slice(0, lastUserIdx) : [];
    if (toolLoopMsgs.length > 0) {
      html += `<details class="conv-entry" style="opacity:0.7"><summary class="conv-message" style="background:color-mix(in srgb, var(--orange) 12%, var(--bg))">
        <span class="conv-role" style="color:var(--orange)">Tool Loop</span> ${toolLoopMsgs.length} messages (assistant responses + tool results fed back)
      </summary><div class="conv-body">`;
      for (const m of toolLoopMsgs) {
        html += renderApiMessage(m, color);
      }
      html += '</div></details>';
    }
    // Final user message (the actual new input for this call)
    if (lastUserIdx >= 0) {
      html += renderApiMessage(newMsgs[lastUserIdx], color);
    }
    // Any trailing non-user messages after the last user (edge case)
    for (let i = lastUserIdx + 1; i < newMsgs.length; i++) {
      html += renderApiMessage(newMsgs[i], color);
    }
  }
  return html;
}

/** Render a single API message with pretty-printed content and a raw toggle. */
export function renderApiMessage(msg, color = 'var(--green)') {
  const role = msg.role || '?';
  const roleLabel = role === 'user' ? 'User Prompt' : role === 'system' ? 'System Prompt' : role.charAt(0).toUpperCase() + role.slice(1);
  const roleColor = color;
  const content = msg.content;

  // For user messages, extract plain text directly
  if (role === 'user' && Array.isArray(content)) {
    const textParts = content.filter(b => b.type === 'text' && b.text).map(b => b.text);
    if (textParts.length > 0) {
      const fullText = textParts.join('\n\n');
      const preview = stripTs(fullText.replace(/\n/g, ' '));
      const msgPreview = preview.length > 80 ? preview.slice(0, 80) + '...' : preview;
      return `<details class="conv-entry"><summary class="conv-message" style="background:color-mix(in srgb, ${roleColor} 12%, var(--bg))">
        <span class="conv-role" style="color:${roleColor}">${esc(roleLabel)}</span> ${esc(msgPreview)}
      </summary><div class="conv-body"><pre class="conv-pre">${escSym(fullText)}</pre></div></details>`;
    }
  }

  // Fallback: render as JSON tree
  const raw = JSON.stringify(content, null, 2);
  const { pretty } = renderApiContent(content);
  const previewText = stripTs(pretty.replace(/\n/g, ' '));
  const msgPreview = previewText.length > 80 ? previewText.slice(0, 80) + '...' : previewText;
  return `<details class="conv-entry"><summary class="conv-message" style="background:color-mix(in srgb, ${roleColor} 12%, var(--bg))">
    <span class="conv-role" style="color:${roleColor}">${esc(roleLabel)}</span> ${esc(msgPreview)}
  </summary><div class="conv-body">
    <div class="json-tree">${renderJsonTree(content, undefined, 0)}</div>
    <details class="jt-raw-toggle" style="margin-top:6px"><summary>Raw JSON</summary>
      <pre class="conv-pre" style="margin-top:4px">${escSym(raw)}</pre>
    </details>
  </div></details>`;
}

/** Render a tool call with its hooks and result as children */
export function renderToolCallGroup(block, auditByCallId, resultByCallId, consumedAuditIds, consumedResultIds, dualviewCommits, assertionsByTool, consumedAssertionIdxs, ullmState) {
  const args = block.arguments || {};
  const toolName = displayToolName(block.name);
  const preview = `${toolName}(${JSON.stringify(args).slice(0, 80)}${JSON.stringify(args).length > 80 ? '...' : ''})`;
  const hooks = auditByCallId[block.id] || [];

  // Collect child items: args tree + hooks + result
  const argsStr = JSON.stringify(args, null, 2);
  let children = `<div class="json-tree">${renderJsonTree(args, undefined, 0)}</div>
    <details class="jt-raw-toggle" style="margin-top:6px"><summary>Raw JSON</summary>
      <pre class="conv-pre" style="margin-top:4px">${escSym(argsStr)}</pre>
    </details>`;

  // For inspect_symbol, render the U-LLM conversation inline between the
  // tool call args and the audit hooks / result, since the untrusted LLM
  // executes during the inspect_symbol call. A single inspect_symbol can
  // invoke U-LLM multiple times (e.g. request pdf_to_text/csv_query, then
  // produce the final schema JSON), so match every unmatched U-LLM session
  // whose start timestamp falls inside this specific tool call's audit
  // window. Using the assistant-message timestamp is too broad when one
  // assistant message issues multiple inspect_symbol calls.
  if (block.name === 'inspect_symbol' && ullmState && Array.isArray(ullmState.sessions)) {
    const beforeHook = hooks.find(ev => ev.hookType === 'before_tool_call');
    const inspectHook = hooks.find(ev => ev.hookType === 'inspect_symbol');
    const callTs = beforeHook?.ts || ullmState.curMsgTs || '';
    const resultTs = inspectHook?.ts || (ullmState.resultTsByCallId || {})[block.id] || '';
    const matches = ullmState.sessions.filter(s => {
      if (s.matched || !s.startTs) return false;
      if (!s.assistantEntry && !(s.assistantEntries || []).length) return false;
      if (callTs && s.startTs < callTs) return false;
      if (resultTs && s.startTs > resultTs) return false;
      return true;
    });
    for (const match of matches) {
      match.matched = true;
      // These are already in consumedUllmIds (hidden upfront), but keep
      // the add() calls so the contract with any future consumers holds.
      for (const e of (match.entries || [])) {
        if (e.id) ullmState.consumed.add(e.id);
      }
      const ullmReq = match.llmReq || null;
      const ullmGlobalIdx = match.llmReqIdx >= 0
        ? (ullmState.globalIdxByAgentIdx?.[`ullm:${match.llmReqIdx}`] ?? match.llmReqIdx)
        : 0;
      children += renderInlineUllm(match, ullmReq, ullmGlobalIdx);
    }
  }

  // Exec info badges: show trust level, network, filesystem, sandbox, result status
  if (block.name === 'exec') {
    children += renderExecInfoStrip(args, hooks);
  }

  // Before-exec: show desymbolization if resolve_symbol happened (untrusted exec)
  // or show that symbols were preserved (trusted exec with WITH_SYMBOLS)
  if (block.name === 'exec') {
    const resolveEv = hooks.find(ev => ev.hookType === 'before_tool_call' && ev.taintAction === 'resolve_symbol');
    const withSymbols = args.env?.WITH_SYMBOLS === '1';
    if (resolveEv) {
      children += renderExecDataFlow('before', 'Desymbolized before exec', resolveEv);
    } else if (withSymbols) {
      children += renderExecDataFlow('before', 'Symbols preserved (WITH_SYMBOLS=1)', null);
    }
  }

  // Associated hooks (skip label_trusted — no useful info)
  for (const ev of hooks) {
    consumedAuditIds.add(ev.toolCallId + ':' + ev.hookType);
    if (ev.taintAction === 'classify_trusted') continue;
    children += renderAuditInline(ev);
  }

  // Associated tool result
  const result = resultByCallId[block.id];
  if (result) {
    consumedResultIds.add(block.id);
    children += renderToolResultEntry(result);
  }

  // After-exec: show symbolization of result if it happened
  if (block.name === 'exec') {
    const resultEv = hooks.find(ev => ev.hookType === 'tool_result' &&
      (ev.taintAction === 'symbolize_untrusted' || ev.taintAction === 'label_untrusted'));
    if (resultEv) {
      const label = resultEv.taintAction === 'symbolize_untrusted'
        ? 'Result symbolized after exec'
        : 'Result labeled untrusted after exec';
      children += renderExecDataFlow('after', label, resultEv);
    }
  }

  // DUALVIEW file read flow: if this is a `read` tool and the result has symbols, show trusted-view flow
  if (block.name === 'read' && result) {
    const resultText = result.content?.map(b => b.text || '').join('\n') || '';
    if (resultText.includes('$_DUALVIEW_SYM_')) {
      children += renderFileReadFlow(args.file_path || args.path || '', resultText);
    }
  }

  // DUALVIEW file tracking commits for this tool call
  const commits = (dualviewCommits || {})[block.id] || [];
  if (commits.length > 0) {
    children += renderAdfiCommitsInline(commits);
  }

  // Inline assertion results for this tool.
  // For exec WITH_SYMBOLS=1, also include exec_sym assertions (virtual audit toolName).
  let toolAssertions = (assertionsByTool || {})[block.name] || [];
  if (block.name === 'exec' && args.env?.WITH_SYMBOLS === '1') {
    toolAssertions = [...((assertionsByTool || {})['exec_sym'] || []), ...toolAssertions];
  } else if (block.name === 'exec') {
    // Default exec: include exec assertions but not exec_sym
    // (exec_sym assertions are only relevant for WITH_SYMBOLS calls)
  }
  if (toolAssertions.length > 0) {
    children += renderAssertionsInline(toolAssertions, consumedAssertionIdxs);
  }

  const isTrustedCall = args.env?.WITH_SYMBOLS === '1';
  const callBg = isTrustedCall ? 'background:color-mix(in srgb, var(--green) 12%, var(--bg))' : '';
  const callRoleColor = isTrustedCall ? 'color:var(--green)' : '';
  return `<details class="conv-entry" open><summary class="conv-message conv-tool-call" style="${callBg}">
    <span class="conv-role tool-call" style="${callRoleColor}">Tool Call</span> ${esc(preview)}
  </summary><div class="conv-body conv-children">${children}</div></details>`;
}

function renderInlineUllmTextBlock(block) {
  const text = block.text || '';
  const hasSyms = hasResolvableSymbols(text);
  const label = 'Response';
  let html = '';

  // Try to parse as JSON for tree view.
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  if (parsed && typeof parsed === 'object') {
    html += `<details class="conv-entry${hasSyms ? ' bot-agent-view-block' : ''}" open><summary class="conv-message" style="background:color-mix(in srgb, var(--pink) 8%, var(--bg))">
      <span class="conv-role" style="color:var(--pink)">${label}</span>
    </summary><div class="conv-body">
      <div class="json-tree">${renderJsonTree(parsed, undefined, 0)}</div>
      <details class="jt-raw-toggle" style="margin-top:6px"><summary>Raw JSON</summary>
        <pre class="conv-pre" style="margin-top:4px">${escSym(text)}</pre>
      </details>
    </div></details>`;
  } else {
    html += renderContentBlock(text, {
      role: label, roleClass: 'assistant',
      summaryStyle: 'background:color-mix(in srgb, var(--pink) 8%, var(--bg))',
      roleStyle: 'color:var(--pink)', open: true, sym: true, view: hasSyms ? 'agent' : null,
    });
  }
  if (hasSyms) {
    html += renderContentBlock(resolveSymbols(text), {
      role: 'Response', roleClass: 'assistant',
      summaryStyle: 'background:color-mix(in srgb, var(--pink) 12%, var(--bg))',
      roleStyle: 'color:var(--pink)', open: false, sym: false, view: 'human',
    });
  }
  return html;
}

function renderInlineUllmToolCall(block, resultMsg, consumedToolResults) {
  const args = block.arguments || block.input || {};
  const argsStr = JSON.stringify(args, null, 2);
  const previewSrc = `${block.name || 'tool'}(${JSON.stringify(args)})`;
  const preview = previewSrc.length > 100 ? previewSrc.slice(0, 100) + '...' : previewSrc;
  let body = `<div class="json-tree">${renderJsonTree(args, undefined, 0)}</div>
    <details class="jt-raw-toggle" style="margin-top:6px"><summary>Raw JSON</summary>
      <pre class="conv-pre" style="margin-top:4px">${escSym(argsStr)}</pre>
    </details>`;

  if (resultMsg) {
    if (resultMsg.toolCallId) consumedToolResults.add(resultMsg.toolCallId);
    body += renderToolResultEntry(resultMsg);
  }

  return `<details class="conv-entry" open><summary class="conv-message conv-tool-call" style="background:color-mix(in srgb, var(--pink) 8%, var(--bg))">
    <span class="conv-role tool-call" style="color:var(--pink)">Tool Call</span> ${esc(preview)}
  </summary><div class="conv-body conv-children">${body}</div></details>`;
}

function renderInlineUllmUsage(msg) {
  if (!msg.usage) return '';
  const u = msg.usage;
  const cost = u.cost?.total ? ` | $${u.cost.total.toFixed(4)}` : '';
  const vis = S.showUsageInfo ? '' : ' style="display:none"';
  return `<div class="usage-info usage-detail"${vis}>${u.input}in + ${u.output}out = ${u.totalTokens}tok${cost} | ${esc(msg.model)} | ${esc(msg.stopReason)}</div>`;
}

/** Render a U-LLM session inline within an inspect_symbol tool call group. */
export function renderInlineUllm(sessionOrEntry, llmReq, globalIdx = 0) {
  const entries = Array.isArray(sessionOrEntry?.entries)
    ? sessionOrEntry.entries
    : (sessionOrEntry ? [sessionOrEntry] : []);
  if (entries.length === 0) return '';

  const assistantMessages = entries
    .filter(e => e.type === 'message' && e.message?.role === 'assistant')
    .map(e => e.message);
  const displayMsg = assistantMessages[assistantMessages.length - 1] || assistantMessages[0] || null;
  const resultByToolCallId = {};
  for (const e of entries) {
    const msg = e.message;
    if (e.type === 'message' && msg?.role === 'toolResult' && msg.toolCallId) {
      resultByToolCallId[msg.toolCallId] = msg;
    }
  }

  const consumedToolResults = new Set();
  let inner = '';

  // LLM request system/user prompts
  if (llmReq) {
    inner += renderLlmRequestBody(llmReq, null, 'var(--pink)');
  }

  for (const e of entries) {
    if (e.type === 'model_change') {
      inner += `<div class="conv-meta">Model: ${esc(e.provider || '')}/${esc(e.modelId || '')}</div>`;
      continue;
    }
    if (e.type !== 'message' || !e.message) continue;
    const msg = e.message;

    if (msg.role === 'user') {
      if (!llmReq) {
        const text = stripTs(msg.content?.map(b => b.text || '').join('\n') || '');
        inner += renderContentBlock(text, {
          role: 'Input', roleClass: 'user',
          summaryStyle: 'background:color-mix(in srgb, var(--pink) 6%, var(--bg))',
          roleStyle: 'color:var(--pink)', open: false, sym: false,
        });
      }
      continue;
    }

    if (msg.role === 'toolResult') {
      if (!consumedToolResults.has(msg.toolCallId)) {
        if (msg.toolCallId) consumedToolResults.add(msg.toolCallId);
        inner += renderToolResultEntry(msg);
      }
      continue;
    }

    if (msg.role !== 'assistant') continue;

    for (const block of (msg.content || [])) {
      if (block.type === 'thinking') {
        inner += renderContentBlock(block.thinking || '', {
          role: 'Thinking', roleClass: 'assistant',
          summaryStyle: 'background:color-mix(in srgb, var(--pink) 8%, var(--bg))',
          roleStyle: 'color:var(--pink)', open: false, sym: false,
        });
      } else if (block.type === 'toolCall') {
        const resultMsg = resultByToolCallId[block.id] || null;
        inner += renderInlineUllmToolCall(block, resultMsg, consumedToolResults);
      } else if (block.type === 'text') {
        inner += renderInlineUllmTextBlock(block);
      }
    }

    inner += renderInlineUllmUsage(msg);
  }

  if (!inner) {
    inner += '<div class="conv-meta">No ULLM messages recorded</div>';
  }

  const model = displayMsg?.model || llmReq?.model || '';
  const modelExtra = model ? ` (${esc(model)})` : '';
  const openAttr = S.mode === 'bot' ? '' : ' open';
  return `<details class="conv-entry"${openAttr}><summary class="conv-llm-untrusted" style="background:color-mix(in srgb, var(--pink) 12%, var(--bg))">
    <span class="conv-role" style="color:var(--pink)">ULLM subagent</span>${modelExtra}
  </summary><div class="conv-body conv-children">${inner}</div></details>`;
}

/** Render exec info badge strip showing trust, network, filesystem, sandbox, result status. */
function renderExecInfoStrip(args, hooks) {
  const withSymbols = args.env?.WITH_SYMBOLS === '1';
  const isTrusted = withSymbols;

  const resultEv = hooks.find(ev => ev.hookType === 'tool_result' &&
    (ev.taintAction === 'symbolize_untrusted' || ev.taintAction === 'label_untrusted' || ev.taintAction === 'label_trusted'));
  const resultAction = resultEv?.taintAction || (isTrusted ? 'label_trusted' : 'unknown');

  let html = '<div class="exec-info-strip">';

  // Trust level
  if (isTrusted) {
    html += '<span class="exec-badge trusted">Agent Shell</span>';
  } else {
    html += '<span class="exec-badge untrusted">Human Shell</span>';
  }

  // Network
  if (isTrusted) {
    html += '<span class="exec-badge net-blocked">Network: blocked</span>';
  } else {
    html += '<span class="exec-badge net-open">Network: open</span>';
  }

  // Filesystem
  if (isTrusted) {
    html += '<span class="exec-badge trusted">FS: Agent File System</span>';
  } else {
    html += '<span class="exec-badge untrusted">FS: Human File System</span>';
  }

  // Result status
  if (resultAction === 'symbolize_untrusted') {
    html += '<span class="exec-badge symbolized">Result: symbolized</span>';
  } else if (resultAction === 'label_untrusted') {
    html += '<span class="exec-badge labeled">Result: labeled untrusted</span>';
  } else if (resultAction === 'label_trusted') {
    html += '<span class="exec-badge trusted">Result: trusted</span>';
  }

  html += '</div>';
  return html;
}

/** Render symbolize/desymbolize data flow around exec. */
function renderExecDataFlow(phase, label, auditEv) {
  const color = phase === 'before' ? 'var(--orange)' : 'var(--cyan)';
  const arrow = phase === 'before' ? '\u25b6' : '\u25c0'; // right / left arrow
  let html = `<details class="conv-entry" style="margin:4px 0"><summary class="conv-message" style="background:color-mix(in srgb, ${color} 8%, var(--bg));font-size:11px">
    <span style="color:${color};font-weight:600">${arrow} ${esc(label)}</span>`;
  if (auditEv) {
    const lenInfo = ` ${auditEv.originalLen || 0}\u2192${auditEv.modifiedLen || 0}b`;
    html += `<span style="font-size:10px;color:var(--fg3);margin-left:6px">${lenInfo}</span>`;
  }
  html += '</summary>';
  if (auditEv) {
    html += '<div class="conv-body">';
    const origText = auditEv.originalHead || '';
    const modText = auditEv.modifiedHead || '';
    if (origText) {
      html += renderAuditHeadBlock(phase === 'before' ? 'Symbolized params' : 'Raw result', origText);
    }
    if (modText) {
      html += renderAuditHeadBlock(phase === 'before' ? 'Desymbolized params' : 'Symbolized result', modText);
    }
    html += '</div>';
  }
  html += '</details>';
  return html;
}

/** Render a tool result entry */
export function renderToolResultEntry(msg) {
  const errClass = msg.isError ? ' error' : '';
  const contentText = msg.content?.map(b => b.text || '').join('\n') || '';
  const resultBg = msg.isError
    ? 'background:color-mix(in srgb, var(--red) 12%, var(--bg))'
    : 'background:color-mix(in srgb, var(--yellow) 10%, var(--bg))';
  let html = renderContentBlock(contentText, {
    role: `Result: ${msg.toolName}`,
    roleClass: `tool-result${errClass}`,
    summaryStyle: resultBg,
    open: false,
    sym: true,
  });
  if (msg.details) {
    const detailsStr = JSON.stringify(msg.details, null, 2);
    html += renderContentBlock(detailsStr, { role: 'Details', roleClass: 'tool-result', summaryStyle: resultBg, open: false, sym: true });
  }
  return html;
}

/** Render assertion results inline within a tool call group. */
export function renderAssertionsInline(assertions, consumedIdxs) {
  if (!assertions || assertions.length === 0) return '';

  // Filter out "not called" skips — these are noise from meta-templates
  const isNotCalledSkip = (a) => a.status === 'pass' && a.reason && a.reason.includes('not called');
  const visible = assertions.filter(a => !isNotCalledSkip(a));
  // Still mark filtered assertions as consumed so they don't appear in bottom panel
  for (const a of assertions) { if (isNotCalledSkip(a) && consumedIdxs) consumedIdxs.add(a); }
  if (visible.length === 0) return '';

  const skipCount = visible.filter(a => a.status === 'skip').length;
  const warnCount = visible.filter(a => a.status === 'warn').length;
  const passCount = visible.filter(a => a.status === 'pass').length;
  const evaluated = visible.length - skipCount - warnCount;
  const failCount = visible.filter(a => a.status === 'fail').length;
  const allPass = failCount === 0;
  const hasWarns = warnCount > 0;
  const statusColor = !allPass ? 'var(--red)' : hasWarns ? 'var(--yellow)' : 'var(--green)';
  const skipLabel = skipCount > 0 ? ` <span style="color:var(--fg3);font-size:10px">(${skipCount} skipped)</span>` : '';
  const warnLabel = warnCount > 0 ? ` <span style="color:var(--yellow);font-size:10px">(${warnCount} ⚠)</span>` : '';

  let html = `<div class="assertion-inline">
    <div class="assertion-inline-header">
      <span class="assertion-inline-title">Assertions</span>
      <span style="color:${statusColor};font-size:11px;font-weight:600">${passCount}/${evaluated}</span>${warnLabel}${skipLabel}
    </div>`;

  for (const a of visible) {
    const icon = a.status === 'pass' ? '✓' : a.status === 'fail' ? '✗' : a.status === 'warn' ? '⚠' : a.status === 'skip' ? '⊘' : '⚠';
    const cls = a.status === 'pass' ? 'assertion-pass' : a.status === 'fail' ? 'assertion-fail' : a.status === 'warn' ? 'assertion-warn' : a.status === 'skip' ? 'assertion-skip' : 'assertion-error';
    const globalIdx = S._currentAssertions.indexOf(a);
    const clickAttr = globalIdx >= 0 ? ` data-aidx="${globalIdx}" onclick="showAssertionPopup(event, ${globalIdx})"` : '';
    html += `<div class="assertion-item ${cls}"${clickAttr}>
      <span class="assertion-icon">${icon}</span>
      <span class="assertion-label">${esc(a.label)}</span>
      <span class="assertion-reason">${esc(a.reason)}</span>
    </div>`;
    // Mark as consumed so it's not duplicated in the bottom panel
    if (consumedIdxs) consumedIdxs.add(a);
  }

  html += '</div>';
  return html;
}

/** Render DUALVIEW file tracking commits inline in the conversation tab */
export function renderAdfiCommitsInline(commits) {
  if (commits.length === 0) return '';

  // Group commits into pairs: trusted + untrusted for the same callId
  const trustedCommit = commits.find(c => c.trusted);
  const untrustedCommit = commits.find(c => !c.trusted);
  const toolName = commits[0].toolName;
  const callId = commits[0].callId;
  const runId = commits[0].runId;
  const totalFiles = trustedCommit ? trustedCommit.files.length : (untrustedCommit ? untrustedCommit.files.length : 0);

  // Build file list for each commit
  function buildFilesHtml(c) {
    let html = '';
    for (const f of c.files) {
      const hasContent = f.content && !f.binary;
      let clickAttr = '';
      if (hasContent) {
        const idx = S._ftFileContents.length;
        S._ftFileContents.push({ path: f.path, content: f.content });
        clickAttr = ` class="ft-path-clickable" onclick="showFileContentPopup(${idx})"`;
      }
      html += `<div class="ft-file">
        <span class="ft-path"${clickAttr}>${esc(f.path)}</span>
        ${f.binary ? ' <span style="color:var(--fg3)">(binary)</span>' : ''}
      </div>`;
    }
    return html;
  }

  // Determine if any symbols were resolved (untrusted commit exists = symbols were present)
  const hasSymbols = !!untrustedCommit;

  let flowHtml = `<div class="ft-flow">
    <div class="ft-flow-header">
      <span style="font-weight:600;color:var(--yellow)">File Tracking Flow</span>
      <span style="font-size:10px;color:var(--orange);margin-left:8px;">tool=${esc(toolName)}</span>
      <span style="font-size:10px;color:var(--fg3);margin-left:4px;">${totalFiles} file${totalFiles !== 1 ? 's' : ''}</span>
    </div>
    <div class="ft-flow-meta">
      <span class="dualview-callid">callId: ${esc(callId)}</span>
      <span class="dualview-runid">runId: ${esc(runId)}</span>
    </div>
    <div class="ft-flow-steps">`;

  // Step 1: before_tool_call — path rewrite
  flowHtml += `<div class="ft-flow-step">
    <div class="ft-flow-step-marker" style="--step-color: var(--yellow)"></div>
    <div class="ft-flow-step-content">
      <div class="ft-flow-step-label" style="color:var(--yellow)">before_tool_call</div>
      <div class="ft-flow-step-desc">Path rewrite: file path redirected to <code>agentview</code></div>
    </div>
  </div>`;

  // Step 2: Tool executes
  flowHtml += `<div class="ft-flow-step">
    <div class="ft-flow-step-marker" style="--step-color: var(--pink)"></div>
    <div class="ft-flow-step-content">
      <div class="ft-flow-step-label" style="color:var(--pink)">Tool Executes</div>
      <div class="ft-flow-step-desc">File written to Agent File System${hasSymbols ? ' with symbolized content (<code>$_DUALVIEW_SYM_*</code>)' : ''}</div>
    </div>
  </div>`;

  // Step 3: after_tool_call — detect changes
  flowHtml += `<div class="ft-flow-step">
    <div class="ft-flow-step-marker" style="--step-color: var(--orange)"></div>
    <div class="ft-flow-step-content">
      <div class="ft-flow-step-label" style="color:var(--orange)">after_tool_call</div>
      <div class="ft-flow-step-desc">Detected ${totalFiles} changed file${totalFiles !== 1 ? 's' : ''} in Agent File System</div>
    </div>
  </div>`;

  // Step 4: AgentView commit
  if (trustedCommit) {
    const refsHtml = renderRefBadges(trustedCommit.refs);
    const trustedLabel = S.mode === 'bot' ? 'AgentView' : 'DUALVIEW-TRUSTED';
    flowHtml += `<div class="ft-flow-step">
      <div class="ft-flow-step-marker" style="--step-color: var(--green)"></div>
      <div class="ft-flow-step-content">
        <details class="ft-flow-commit-details">
          <summary class="ft-flow-step-label" style="color:var(--green)">
            <span class="trust-badge trusted">${trustedLabel}</span>
            <span class="ft-flow-ws-tag" style="background:var(--green);color:var(--bg)">Agent FS</span>
            ${refsHtml}
            <span style="font-size:10px;color:var(--fg3);margin-left:4px;">Copy symbolized files to main worktree + commit</span>
          </summary>
          <div class="ft-flow-commit-body">
            <div class="ft-flow-commit-hash">${esc(trustedCommit.hash.slice(0, 7))}</div>
            ${buildFilesHtml(trustedCommit)}
          </div>
        </details>
      </div>
    </div>`;
  }

  // Step 5: De-symbolize + HumanView commit
  if (untrustedCommit) {
    const refsHtml = renderRefBadges(untrustedCommit.refs);
    const untrustedLabel = S.mode === 'bot' ? 'HumanView' : 'DUALVIEW-UNTRUSTED';
    flowHtml += `<div class="ft-flow-step">
      <div class="ft-flow-step-marker" style="--step-color: var(--pink)"></div>
      <div class="ft-flow-step-content">
        <details class="ft-flow-commit-details">
          <summary class="ft-flow-step-label" style="color:var(--pink)">
            <span class="trust-badge untrusted">${untrustedLabel}</span>
            <span class="ft-flow-ws-tag" style="background:var(--pink);color:var(--bg)">Human FS</span>
            ${refsHtml}
            <span style="font-size:10px;color:var(--fg3);margin-left:4px;">Resolve <code>$_DUALVIEW_SYM_</code> → raw values + commit</span>
          </summary>
          <div class="ft-flow-commit-body">
            <div class="ft-flow-commit-hash">${esc(untrustedCommit.hash.slice(0, 7))}</div>
            ${buildFilesHtml(untrustedCommit)}
          </div>
        </details>
      </div>
    </div>`;
  } else {
    // No symbols to resolve — note it
    flowHtml += `<div class="ft-flow-step">
      <div class="ft-flow-step-marker" style="--step-color: var(--fg3)"></div>
      <div class="ft-flow-step-content">
        <div class="ft-flow-step-label" style="color:var(--fg3)">No symbols</div>
        <div class="ft-flow-step-desc">No <code>$_DUALVIEW_SYM_</code> tokens found — no untrusted commit needed</div>
      </div>
    </div>`;
  }

  // Step 6: Reset Agent File System
  flowHtml += `<div class="ft-flow-step ft-flow-step-last">
    <div class="ft-flow-step-marker" style="--step-color: var(--fg3)"></div>
    <div class="ft-flow-step-content">
      <div class="ft-flow-step-label" style="color:var(--fg3)">Reset</div>
      <div class="ft-flow-step-desc">Agent File System reset to <code>dualview-trusted</code> ref</div>
    </div>
  </div>`;

  flowHtml += '</div></div>';

  // Wrap in a collapsible entry
  return `<details class="conv-entry"><summary class="conv-message" style="background:color-mix(in srgb, var(--yellow) 10%, var(--bg))">
    <span style="font-weight:600;color:var(--yellow);font-size:11px;">File Tracking</span>
    <span style="font-size:10px;color:var(--fg3);margin-left:4px;">${totalFiles} file${totalFiles !== 1 ? 's' : ''}</span>
    ${trustedCommit ? `<span class="trust-badge trusted" style="font-size:9px">T:${esc(trustedCommit.hash.slice(0, 7))}</span>` : ''}
    ${untrustedCommit ? `<span class="trust-badge untrusted" style="font-size:9px">U:${esc(untrustedCommit.hash.slice(0, 7))}</span>` : ''}
  </summary><div class="conv-body">${flowHtml}</div></details>`;
}

/** Render DUALVIEW worktree read flow for read tool calls */
export function renderFileReadFlow(filePath, resultText) {
  // Extract unique symbols from the result
  const symMatches = resultText.match(/\$_DUALVIEW_SYM_[a-zA-Z_]\w*\[\w+\](?:\.[a-zA-Z_][\w[\].]*)?/g);
  const uniqueSyms = symMatches ? [...new Set(symMatches)].sort() : [];
  const symCount = uniqueSyms.length;

  let flowHtml = `<div class="ft-flow">
    <div class="ft-flow-header">
      <span style="font-weight:600;color:var(--cyan)">File Read Agent View</span>
      <span style="font-size:10px;color:var(--fg3);margin-left:8px;">${esc(filePath)}</span>
    </div>
    <div class="ft-flow-steps">`;

  // Step 1: Read target
  flowHtml += `<div class="ft-flow-step">
    <div class="ft-flow-step-marker" style="--step-color: var(--yellow)"></div>
    <div class="ft-flow-step-content">
      <div class="ft-flow-step-label" style="color:var(--yellow)">Read Target</div>
      <div class="ft-flow-step-desc">Tool requested the human-view path</div>
    </div>
  </div>`;

  // Step 2: trusted view
  flowHtml += `<div class="ft-flow-step">
    <div class="ft-flow-step-marker" style="--step-color: var(--orange)"></div>
    <div class="ft-flow-step-content">
      <div class="ft-flow-step-label" style="color:var(--orange)">before_tool_call</div>
      <div class="ft-flow-step-desc">Path redirected to Agent File System when policy marks the target untrusted</div>
    </div>
  </div>`;

  // Step 3: Symbol-backed content
  let symListHtml = '';
  if (uniqueSyms.length > 0) {
    symListHtml = `<div class="ft-flow-sym-list">`;
    for (const sym of uniqueSyms) {
      symListHtml += `<div class="ft-flow-sym-item"><span class="sym-marker">${esc(sym)}</span></div>`;
    }
    symListHtml += `</div>`;
  }

  flowHtml += `<div class="ft-flow-step">
    <div class="ft-flow-step-marker" style="--step-color: var(--green)"></div>
    <div class="ft-flow-step-content">
      <div class="ft-flow-step-label" style="color:var(--green)">Agent File System Read</div>
      <div class="ft-flow-step-desc">Read returned symbol-backed content (${symCount} symbol${symCount !== 1 ? 's' : ''})</div>
      ${symListHtml}
    </div>
  </div>`;

  // Step 4: Return to LLM
  flowHtml += `<div class="ft-flow-step ft-flow-step-last">
    <div class="ft-flow-step-marker" style="--step-color: var(--cyan)"></div>
    <div class="ft-flow-step-content">
      <div class="ft-flow-step-label" style="color:var(--cyan)">Result Returned to LLM</div>
      <div class="ft-flow-step-desc">T-LLM reads symbolized content</div>
    </div>
  </div>`;

  flowHtml += '</div></div>';

  return `<details class="conv-entry"><summary class="conv-message" style="background:color-mix(in srgb, var(--yellow) 10%, var(--bg))">
    <span style="font-weight:600;color:var(--yellow);font-size:11px;">File Read Agent View</span>
    <span style="font-size:10px;color:var(--fg3);margin-left:4px;">${symCount} symbol${symCount !== 1 ? 's' : ''}</span>
  </summary><div class="conv-body">${flowHtml}</div></details>`;
}

export function setupConvScrollTracking(outlineEntries) {
  if (S.convObserver) S.convObserver.disconnect();

  const scrollContainer = document.getElementById('conv-scroll');
  if (!scrollContainer || outlineEntries.length === 0) return;

  const visibleIds = new Set();

  S.convObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) visibleIds.add(e.target.id);
      else visibleIds.delete(e.target.id);
    }
    // Skip observer updates while a user click scroll is in progress
    if (S._scrollHighlightUntil && Date.now() < S._scrollHighlightUntil) return;
    // Find the first visible outline entry
    let activeId = null;
    for (const oe of outlineEntries) {
      if (visibleIds.has(oe.id)) { activeId = oe.id; break; }
    }
    setActiveOutlineItem(activeId);
  }, { root: scrollContainer, threshold: 0.1 });

  for (const oe of outlineEntries) {
    const el = document.getElementById(oe.id);
    if (el) S.convObserver.observe(el);
  }
}

function setActiveOutlineItem(activeId) {
  document.querySelectorAll('.conv-outline-item').forEach(el => {
    el.classList.toggle('active', el.dataset.target === activeId);
  });
  // Scroll the active outline item into view in the outline sidebar
  if (activeId) {
    const activeEl = document.querySelector(`.conv-outline-item[data-target="${activeId}"]`);
    if (activeEl) activeEl.scrollIntoView({ block: 'nearest' });
  }
}

export function scrollHighlight(id) {
  const el = document.getElementById(id);
  if (!el) return;
  // Suppress observer highlight updates while smooth scroll settles
  S._scrollHighlightUntil = Date.now() + 600;
  // Immediately highlight the clicked outline entry
  setActiveOutlineItem(id);
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.remove('conv-flash');
  void el.offsetWidth; // force reflow to restart animation
  el.classList.add('conv-flash');
  el.addEventListener('animationend', () => el.classList.remove('conv-flash'), { once: true });
}

export function showArgPopup(evt, toolName, detail, color) {
  hideArgPopup();
  const c = color || 'var(--pink)';
  const el = evt.currentTarget;
  const rect = el.getBoundingClientRect();
  const popup = document.createElement('div');
  popup.className = 'ol-arg-popup';
  popup.style.borderColor = c;
  popup.innerHTML = `<div class="ol-arg-popup-title" style="color:${c}">${esc(toolName)}</div><pre>${esc(detail)}</pre>`;
  document.body.appendChild(popup);
  const pw = popup.offsetWidth, ph = popup.offsetHeight;
  let left = rect.right + 8;
  let top = rect.top;
  if (left + pw > window.innerWidth) left = rect.left - pw - 8;
  if (top + ph > window.innerHeight) top = window.innerHeight - ph - 8;
  popup.style.left = left + 'px';
  popup.style.top = top + 'px';
  S._argPopup = popup;
}

export function hideArgPopup() {
  if (S._argPopup) { S._argPopup.remove(); S._argPopup = null; }
}

export function showSymValue(el, symName, value) {
  if (!value) return;
  // Remove any existing popup
  document.querySelectorAll('.sym-value-popup, .sym-value-popup-overlay').forEach(e => e.remove());
  const overlay = document.createElement('div');
  overlay.className = 'sym-value-popup-overlay';
  overlay.onclick = () => { overlay.remove(); popup.remove(); };
  const popup = document.createElement('div');
  popup.className = 'sym-value-popup';
  popup.innerHTML = `<div class="sym-value-popup-title">${esc(symName)}</div><pre>${esc(value)}</pre>`;
  document.body.appendChild(overlay);
  document.body.appendChild(popup);
}

export function showFileContentPopup(idx) {
  const entry = S._ftFileContents[idx];
  if (!entry) return;
  // Remove any existing file content popup
  document.querySelectorAll('.ft-content-popup, .ft-content-popup-overlay').forEach(e => e.remove());
  const overlay = document.createElement('div');
  overlay.className = 'ft-content-popup-overlay';
  const popup = document.createElement('div');
  popup.className = 'ft-content-popup';
  popup.innerHTML = `<div class="ft-content-popup-header">
      <span class="ft-content-popup-path">${esc(entry.path)}</span>
      <button class="ft-content-popup-copy" onclick="navigator.clipboard.writeText(${JSON.stringify(entry.path).replace(/"/g, '&quot;')});this.textContent='copied!';setTimeout(()=>this.textContent='copy path',1000)">copy path</button>
    </div>
    <pre class="ft-content-popup-pre">${escSym(entry.content)}</pre>`;
  const close = () => { overlay.remove(); popup.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  overlay.onclick = close;
  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
  document.body.appendChild(popup);
}
if (typeof window !== 'undefined') {
  window.showFileContentPopup = showFileContentPopup;
}
