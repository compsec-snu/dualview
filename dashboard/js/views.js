// ── views.js — Log, Audit table, Git, Files, and Test Spec tab rendering ──
import S, { api } from './state.js';
import { esc, escSym, localTime, usableWsIds, renderWsSelector, wsTestNameMap, friendlyTestName, copyText, highlightYaml } from './utils.js';
import { renderRefBadges, renderDiff, renderAuditHeadBlock, getSymbolsFromEvent, auditOriginal, auditModified, renderJsonTree, isWebhook, renderWebhookMeta, renderUserApprovalBadge, renderUserApprovalDetails, renderAuditJsonBlock, isUntrustedCommandExecutionPattern, renderUntrustedCommandExecutionDetails, renderInspectToolTrace, inspectToolTraceSummary } from './render-helpers.js';

// ── Bot/E2E workspace API path helper ───────────────────────────────────
/** Returns the API path prefix for workspace-level endpoints (files, git, etc.) */
function wsApiPrefix() {
  if (S.mode === 'eval' && S.currentEvalRunId) {
    return `eval/runs/${encodeURIComponent(S.currentEvalRunId)}/ws`;
  }
  if (S.mode === 'bot' && S.currentBotBatch) {
    return `bot/batches/${encodeURIComponent(S.currentBotBatch.batchId)}/ws`;
  }
  return `sessions/${S.currentSession.id}/workspace/${S.currentWsId}`;
}

function wsQuery(params = {}) {
  const query = new URLSearchParams();
  if (S.mode === 'eval' && S.currentEvalTask) query.set('task', S.currentEvalTask);
  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== '') query.set(key, value);
  }
  const encoded = query.toString();
  return encoded ? `?${encoded}` : '';
}

function dualViewName(view) {
  if (view === 'trusted') return 'AgentView';
  if (view === 'untrusted') return 'HumanView';
  return 'Root';
}

function botSourceLabel(ev) {
  const tool = ev.toolName || '';
  if (ev.hookType === 'inspect_symbol' || tool === 'inspect_symbol') return 'ULLM result';
  if (ev.hookType === 'message_sending') return 'Response';
  if (ev.hookType === 'tool_result' && tool) return `${tool} result`;
  if (tool) return `${tool} result`;
  return ev.hookType || 'event';
}

function collectSymbolsFromAudit(events) {
  const symbols = [];
  const seen = new Set();
  for (const ev of events) {
    const syms = getSymbolsFromEvent(ev, { fullValues: true });
    for (const s of syms) {
      if (seen.has(s.name)) continue;
      seen.add(s.name);
      symbols.push({
        name: s.name,
        field: s.field,
        value: s.value || null,
        toolName: ev.toolName || '',
        toolCallId: ev.toolCallId || '',
        ts: ev.ts || '',
        source: botSourceLabel(ev),
      });
    }
  }
  return symbols;
}

const BOT_SYMBOL_RE = /\$_DUALVIEW_SYM_[a-zA-Z_]\w*\[\w+\](?:\.[a-zA-Z_][\w[\].]*)?/g;

function botSymbolsInText(text) {
  return [...new Set(String(text ?? '').match(BOT_SYMBOL_RE) || [])];
}

function botStringify(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return String(value ?? '');
  }
}

function botTrimText(text, max = 360) {
  const src = String(text ?? '');
  return src.length > max ? src.slice(0, max - 1) + '...' : src;
}

function displayBotToolName(name) {
  return name === 'inspect_symbol' ? 'ULLM' : (name || 'tool');
}

function botMessageText(msg) {
  const content = msg?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(b => b?.type === 'text').map(b => b.text || '').filter(Boolean).join('\n\n');
}

function botToolResultText(msg) {
  const content = msg?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(b => b?.text || '').filter(Boolean).join('\n');
}

function botAddSymbolUsage(map, sym, node) {
  if (!map[sym]) map[sym] = [];
  const key = [node.role, node.label, node.toolCallId || '', node.value].join('\0');
  if (map[sym].some(existing => existing._key === key)) return;
  map[sym].push({ ...node, _key: key });
}

function botAuditUsageDescriptor(ev) {
  const hook = String(ev?.hookType || '');
  const tool = displayBotToolName(ev?.toolName);
  if (hook === 'message_sending') return { role: 'Response', label: 'AI response' };
  if (hook.includes('tool_call')) return { role: 'Tool arg', label: tool };
  if (hook.includes('tool_result') || hook === 'inspect_symbol') return { role: 'Tool result', label: tool };
  return null;
}

function buildBotSymbolUsage(conv, events = []) {
  const usage = {};
  const entries = Array.isArray(conv?.main) ? conv.main : [];
  const toolNameByCallId = {};

  for (const entry of entries) {
    if (entry?.type !== 'message' || entry.message?.role !== 'assistant') continue;
    for (const block of entry.message.content || []) {
      if (block?.type === 'toolCall' && block.id) {
        toolNameByCallId[block.id] = displayBotToolName(block.name);
      }
    }
  }

  for (const entry of entries) {
    if (entry?.type !== 'message' || !entry.message) continue;
    const msg = entry.message;
    const ts = entry.timestamp || '';

    if (msg.role === 'user') {
      const text = botMessageText(msg);
      for (const sym of botSymbolsInText(text)) {
        botAddSymbolUsage(usage, sym, {
          role: 'Input',
          label: 'User message',
          value: botTrimText(text),
          ts,
        });
      }
      continue;
    }

    if (msg.role === 'toolResult') {
      const value = botToolResultText(msg);
      const label = toolNameByCallId[msg.toolCallId] || displayBotToolName(msg.toolName);
      for (const sym of botSymbolsInText(value)) {
        botAddSymbolUsage(usage, sym, {
          role: 'Tool result',
          label,
          value: botTrimText(value),
          ts,
          toolCallId: msg.toolCallId || '',
        });
      }
      continue;
    }

    if (msg.role !== 'assistant') continue;
    for (const block of msg.content || []) {
      if (block?.type === 'toolCall') {
        const value = botStringify(block.arguments || {});
        const label = displayBotToolName(block.name);
        for (const sym of botSymbolsInText(value)) {
          botAddSymbolUsage(usage, sym, {
            role: 'Tool arg',
            label,
            value: botTrimText(value),
            ts,
            toolCallId: block.id || '',
          });
        }
      } else if (block?.type === 'text') {
        const value = String(block.text || '').replace(/^\s*\[\[reply_to_current\]\]\s*/, '');
        for (const sym of botSymbolsInText(value)) {
          botAddSymbolUsage(usage, sym, {
            role: 'Response',
            label: 'AI response',
            value: botTrimText(value),
            ts,
          });
        }
      }
    }
  }

  for (const ev of events || []) {
    const descriptor = botAuditUsageDescriptor(ev);
    if (!descriptor) continue;
    const value = ev.modifiedHead || ev.originalHead || '';
    for (const sym of botSymbolsInText(value)) {
      botAddSymbolUsage(usage, sym, {
        ...descriptor,
        value: botTrimText(value),
        ts: ev.ts || '',
        toolCallId: ev.toolCallId || '',
      });
    }
  }

  return usage;
}

async function loadCurrentBotConversation() {
  if (S.mode !== 'bot' || !S.currentBotBatch || !S.currentBotSession) return {};
  const batchId = S.currentBotBatch.batchId;
  const sessionId = S.currentBotSession.sessionId;
  const cacheKey = batchId === '__stitched__'
    ? `bot:__stitched__:${S.currentBotSession.sessionKey}`
    : `bot:${batchId}:${sessionId}`;
  if (!S.conversationData[cacheKey] && batchId !== '__stitched__') {
    S.conversationData[cacheKey] = await api(`bot/batches/${encodeURIComponent(batchId)}/sessions/${encodeURIComponent(sessionId)}/conversation`);
  }
  return S.conversationData[cacheKey] || {};
}

function botTrajectoryStage(role) {
  if (role === 'Created') return 'Created';
  if (role === 'Tool arg') return 'Used as tool arg';
  if (role === 'Tool result') return 'Returned by tool';
  if (role === 'Response') return 'Used in response';
  if (role === 'Input') return 'Seen in input';
  return role || 'Used';
}

function botTrajectoryNote(role, label) {
  if (role === 'Created') return `DualView created this symbol from ${label}.`;
  if (role === 'Tool arg') return `The agent passed this symbol into ${label} as a tool-call argument.`;
  if (role === 'Tool result') return `This symbol appeared in the ${label} tool result.`;
  if (role === 'Response') return 'The assistant response still contained this symbol before delivery.';
  if (role === 'Input') return 'The symbol appeared in the incoming user message.';
  return 'This event referenced the symbol.';
}

function renderBotTrajectoryRows(rows) {
  return rows.map(row => `<div class="bot-symbol-journey-row bot-symbol-journey-row-${esc(String(row.label || 'value').toLowerCase().replace(/[^a-z0-9]+/g, '-'))}">
    <span>${esc(row.label)}</span>
    <code>${esc(row.value || '')}</code>
  </div>`).join('');
}

function renderBotSymbolTrajectory(symbol, opts = {}) {
  const toolFromName = symbol.name.match(/^\$_DUALVIEW_SYM_([a-zA-Z_]\w*)\[/)?.[1] || symbol.toolName || 'tool';
  const source = symbol.source || `${toolFromName} result`;
  const createdMeta = symbol.ts ? localTime(symbol.ts, 'HH:mm:ss.SSS') : '';
  const sourceNode = {
    label: source,
    role: 'Created',
    meta: createdMeta,
    rows: [
      { label: 'Symbol', value: symbol.name },
      { label: 'HumanView', value: symbol.value || 'not recorded in audit event' },
    ],
  };
  const sourceKey = source.toLowerCase();
  const usageNodes = (opts.usageBySymbol?.[symbol.name] || [])
    .filter(node => !(node.role === 'Tool result' && sourceKey === `${node.label} result`.toLowerCase()))
    .map(node => ({
      role: node.role,
      label: node.label,
      meta: node.ts ? localTime(node.ts, 'HH:mm:ss') : '',
      rows: [
        { label: 'Where', value: node.label },
        { label: 'AgentView snippet', value: node.value },
      ],
    }));
  const nodes = [sourceNode, ...usageNodes];
  const body = `<div class="bot-symbol-journey">
      ${nodes.map((node, idx) => `<div class="bot-symbol-journey-step">
        <div class="bot-symbol-journey-index">${idx + 1}</div>
        <div class="bot-symbol-journey-card">
          <div class="bot-symbol-journey-head">
            <span class="bot-symbol-stage bot-symbol-stage-${esc((node.role || 'used').toLowerCase().replace(/\s+/g, '-'))}">${esc(botTrajectoryStage(node.role))}</span>
            <strong>${esc(node.label)}</strong>
            ${node.meta ? `<em>${esc(node.meta)}</em>` : ''}
          </div>
          <div class="bot-symbol-journey-note">${esc(botTrajectoryNote(node.role, node.label))}</div>
          <div class="bot-symbol-journey-rows">${renderBotTrajectoryRows(node.rows || [])}</div>
        </div>
      </div>`).join('')}
    </div>`;
  if (opts.open) {
    return `<div class="bot-symbol-trajectory bot-symbol-trajectory-open">
      <div class="bot-symbol-trajectory-title">Symbol trajectory</div>
      ${body}
    </div>`;
  }
  return `<details class="bot-symbol-trajectory">
    <summary class="bot-symbol-trajectory-toggle">Symbol trajectory</summary>
    ${body}
  </details>`;
}

// ── Log tab ─────────────────────────────────────────────────────────────
export function switchLogWs(wsId) {
  if (wsId !== 'all') {
    window.switchWorkspace(wsId);
  } else {
    S.logWsFilter = wsId;
    renderLog(document.getElementById('tab-content'));
  }
}

function renderConcurrencyTimeline(timeline) {
  const events = Array.isArray(timeline) ? timeline : timeline?.events;
  if (!Array.isArray(events) || events.length === 0) return '';

  const phaseDetails = {
    'human-edit.after-changed-scan': 'DualView applies Human file changes to Agent files after the changed-file scan',
    'human-edit.before-hash-recheck': 'DualView applies Human file changes to Agent files before the hash recheck',
    'human-edit.after-hash-recheck': 'DualView applies Human file changes to Agent files after the hash recheck',
    'filecommit.after-main-dirty-scan': 'DualView applies Agent file changes to Human files after the dirty-path scan',
    'filecommit.after-per-path-rescan': 'DualView applies Agent file changes to Human files after the per-path rescan',
    'filecommit.after-copy-remove': 'DualView applies Agent file changes to Human files after copy or remove',
  };
  const toolCallsById = new Map(
    events
      .filter(event => event.event === 'Tool call' && event.toolCallId)
      .map(event => [event.toolCallId, { toolName: event.toolName, target: event.detail }]),
  );

  const eventRole = event => {
    if (event.event === 'plugin paused' || event.event === 'plugin resumed') return 'dualview';
    return event.lane;
  };
  const eventLabel = event => {
    if (eventRole(event) === 'human') {
      if (['rename', 'move'].includes(event.event)) return 'File name change';
      if (event.event === 'delete') return 'File deletion';
      if (['write', 'append', 'replace', 'atomic replace'].includes(event.event)) return 'File write';
    }
    if (event.event === 'file_commit_worktree' || event.event === 'file_commit_ondemand') return 'File commit';
    return event.event.replaceAll('_', ' ');
  };
  const toolCallLabel = (toolName, toolCallId, target = '') => {
    const linked = toolCallId ? toolCallsById.get(toolCallId) : null;
    const name = toolName && toolName !== 'unknown' ? toolName : linked?.toolName;
    const file = linked?.target || target;
    if (!name || name === 'unknown') return '';
    return file ? `${name}(file_path="${file}")` : `${name}()`;
  };

  let html = `<section class="concurrency-timeline">
    <div class="concurrency-timeline-title">
      <strong>Concurrency timeline</strong>
      <span>Order determines correctness.</span>
    </div>
    <div class="concurrency-timeline-grid concurrency-timeline-head">
      <span>Order</span><span>Agent</span><span>DualView</span><span>Human</span>
    </div>`;

  let activePhase = '';
  for (const event of events) {
    const role = eventRole(event);
    if (event.event === 'plugin paused') activePhase = event.detail || '';
    const phaseDetail = phaseDetails[event.detail] || '';
    const eventToolCall = toolCallLabel(
      event.toolName,
      event.toolCallId,
      event.event === 'Tool call' ? event.detail : '',
    );
    const activeTool = role === 'human' && event.activeToolName
      ? toolCallLabel(event.activeToolName, event.activeToolCallId)
      : '';
    const humanPhase = role === 'human' && activePhase
      ? `During: ${phaseDetails[activePhase] || activePhase}`
      : '';
    const humanFileDetails = role !== 'human'
      ? []
      : ['rename', 'move'].includes(event.event)
        ? [
            event.from ? `From: ${event.from}` : '',
            event.to ? `To: ${event.to}` : '',
          ]
        : [event.detail ? `File: ${event.detail}` : ''];
    const detailLines = [
      phaseDetail,
      eventToolCall,
      Array.isArray(event.files) && event.files.length > 0 ? `Files: ${event.files.join(', ')}` : '',
      Array.isArray(event.syncedFiles) && event.syncedFiles.length > 0 ? `Synced: ${event.syncedFiles.join(', ')}` : '',
      Array.isArray(event.skippedDirtyFiles) && event.skippedDirtyFiles.length > 0 ? `Conflict: ${event.skippedDirtyFiles.join(', ')}` : '',
      event.trustedBranchHead ? `Agent commit: ${event.trustedBranchHead.slice(0, 8)}` : '',
      event.isError === true ? 'Error' : '',
      ...humanFileDetails,
      humanPhase,
      activeTool ? `Tool call: ${activeTool}` : '',
    ].filter(Boolean);
    const detail = detailLines.length > 0
      ? `<span class="concurrency-event-detail">${detailLines.map(line => `<span>${esc(line)}</span>`).join('')}</span>`
      : '';
    const eventCard = `<span class="concurrency-event role-${esc(role)}">
      <strong>${esc(eventLabel(event))}</strong>${detail}
    </span>`;
    html += `<div class="concurrency-timeline-grid">
      <span class="concurrency-order"><strong>#${String(event.order).padStart(2, '0')}</strong><small>+${esc(event.elapsedMs)}ms</small></span>
      <span>${role === 'agent' ? eventCard : ''}</span>
      <span>${role === 'dualview' ? eventCard : ''}</span>
      <span>${role === 'human' ? eventCard : ''}</span>
    </div>`;
    if (event.event === 'plugin resumed') activePhase = '';
  }
  return html + '</section>';
}

export async function renderLog(el) {
  // Eval mode: show gateway log as plain text
  if (S.mode === 'eval' && S.currentEvalRunId) {
    const cacheKey = `eval-log:${S.currentEvalRunId}`;
    if (!S.logData[cacheKey]) {
      const resp = await api(`eval/runs/${encodeURIComponent(S.currentEvalRunId)}/gateway-log`);
      S.logData[cacheKey] = resp.log || '';
    }
    el.innerHTML = `<pre class="conv-pre" style="white-space:pre-wrap;padding:12px;font-size:11px">${esc(S.logData[cacheKey])}</pre>`;
    return;
  }

  // Fetch per-workspace log when filtering, full session log otherwise
  const wsParam = S.logWsFilter && S.logWsFilter !== 'all' ? `?ws=${S.logWsFilter}` : '';
  const cacheKey = `${S.currentSession.id}:${wsParam}`;
  const timelineWs = S.logWsFilter && S.logWsFilter !== 'all' ? S.logWsFilter : null;
  const timelineKey = timelineWs ? `${S.currentSession.id}:${timelineWs}` : null;
  const requests = [];
  if (!S.logData[cacheKey]) {
    requests.push(api(`sessions/${S.currentSession.id}/log${wsParam}`).then(data => { S.logData[cacheKey] = data; }));
  }
  if (timelineKey && (!S.concurrencyData[timelineKey] || S.currentSession.result === 'RUNNING')) {
    requests.push(
      api(`sessions/${S.currentSession.id}/workspace/${timelineWs}/concurrency-timeline`)
        .then(data => { S.concurrencyData[timelineKey] = data; }),
    );
  }
  await Promise.all(requests);
  const entries = S.logData[cacheKey];
  const concurrencyEvents = timelineKey ? S.concurrencyData[timelineKey] : [];

  const allWsIds = usableWsIds(S.currentSession);

  const catClass = (c) => {
    if (c === 'test') return 'cat-test';
    if (c === 'cli') return 'cat-cli';
    if (c.startsWith('poll')) return 'cat-poll-audit';
    if (c === 'cache') return 'cat-cache';
    if (c === 'setup' || c === 'config') return 'cat-setup';
    if (c === 'summary') return 'cat-summary';
    return 'cat-default';
  };

  let html = '';
  if (allWsIds.length > 1) {
    html += renderWsSelector(allWsIds, "switchLogWs(this.value)", { includeAll: true, selected: S.logWsFilter });
  }

  html += renderConcurrencyTimeline(concurrencyEvents);

  html += `<div class="expand-controls">
    <button class="expand-btn" onclick="toggleAll(this, true)">Expand All</button>
    <button class="expand-btn" onclick="toggleAll(this, false)">Collapse All</button>
  </div>`;

  const filtered = entries;

  for (const e of filtered) {
    html += `<div class="log-entry"><div class="log-line">
      <span class="log-elapsed">${esc(e.elapsed)}</span>
      <span class="log-category ${catClass(e.category)}">${esc(e.category)}</span>
      <span class="log-message">${esc(e.message)}</span>
    </div>`;
    if (e.data) {
      const preview = e.data.length > 80 ? e.data.slice(0, 80) + '...' : e.data;
      html += `<details><summary>${esc(preview)}</summary><pre>${esc(e.data)}</pre></details>`;
    }
    html += '</div>';
  }
  if (filtered.length === 0) {
    html += '<div class="no-data">No log entries for this test</div>';
  }
  el.innerHTML = html;
}

// ── Audit tab (standalone table view) ───────────────────────────────────
export function switchAuditWs(wsId) {
  if (wsId !== 'all') {
    window.switchWorkspace(wsId);
  } else {
    S.auditWsFilter = wsId;
    renderAudit(document.getElementById('tab-content'));
  }
}

export async function renderAudit(el) {
  let events = [];
  let html = '';

  if (S.mode === 'eval' && S.currentEvalRunId && S.currentEvalTask) {
    const cacheKey = `eval:${S.currentEvalRunId}:${S.currentEvalTask}`;
    events = S.auditData[cacheKey] || [];
  } else if (S.mode === 'bot' && S.currentBotBatch) {
    // Bot mode: fetch all audit from batch
    const cacheKey = `bot:${S.currentBotBatch.batchId}`;
    if (!S.auditData[cacheKey]) {
      S.auditData[cacheKey] = await api(`bot/batches/${S.currentBotBatch.batchId}/audit`);
    }
    events = S.auditData[cacheKey] || [];
  } else {
    // E2E mode
    const wsIds = usableWsIds(S.currentSession);
    if (wsIds.length === 0) {
      el.innerHTML = '<div class="no-data">No workspace data available</div>';
      return;
    }

    const fetchWsIds = S.auditWsFilter === 'all' ? wsIds : [S.auditWsFilter];
    for (const ws of fetchWsIds) {
      if (!S.auditData[ws]) {
        S.auditData[ws] = await api(`sessions/${S.currentSession.id}/workspace/${ws}/audit`);
      }
    }

    for (const ws of fetchWsIds) {
      for (const ev of (S.auditData[ws] || [])) {
        events.push(ev);
      }
    }

    if (wsIds.length > 1) {
      html += renderWsSelector(wsIds, "switchAuditWs(this.value)", { includeAll: true, selected: S.auditWsFilter });
    }
  }
  events.sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));

  if (S.mode === 'bot') {
    renderBotAudit(el, events);
    return;
  }

  html += `<div class="expand-controls">
    <button class="expand-btn" onclick="toggleAll(this, true)">Expand All</button>
    <button class="expand-btn" onclick="toggleAll(this, false)">Collapse All</button>
  </div>`;

  if (events.length === 0) {
    html += '<div class="no-data">No audit events found</div>';
    el.innerHTML = html;
    return;
  }

  const colCount = 8;
  html += `<table class="audit-table"><thead><tr>
    <th>Time</th><th>Hook</th><th>Tool</th><th>Action</th><th>Trust</th><th>Mode</th><th>Len</th><th>Syms</th>
  </tr></thead><tbody>`;

  // Index oracle entries by toolName for embedding into tool call rows
  const oracleByTool = new Map(); // toolName → oracle event
  // Track which tool names have non-oracle audit entries (from guardrail plugins)
  const toolsWithHookEntries = new Set();
  for (const ev of events) {
    if (ev.oracle && ev.toolName) {
      const prev = oracleByTool.get(ev.toolName);
      if (!prev || ev.taintAction === 'attack_detected') oracleByTool.set(ev.toolName, ev);
    }
    if (!ev.oracle && ev.toolName) {
      toolsWithHookEntries.add(ev.toolName);
    }
  }

  for (const ev of events) {
    // Skip oracle entries that can be embedded into a tool call's detail row.
    // If no hook entry exists for this tool (e.g. defense=none), show as standalone row.
    if (ev.oracle && ev.toolName && toolsWithHookEntries.has(ev.toolName)) continue;

    const time = localTime(ev.ts, 'HH:mm:ss.SSS');
    const trustCls = (ev.trust || '').toLowerCase();
    const trustBadge = ev.trust ? `<span class="trust-badge ${trustCls}">${esc(ev.trust)}</span>` : '';
    // Guardrail events: show label/decision as badge in Trust column
    const guardrailBadge = ev.guardrail
      ? `<span class="trust-badge ${ev.taintAction === 'guardrail_allow' ? 'trusted' : 'untrusted'}">${esc(ev.label || ev.decision || '')}</span>${ev.score != null ? ` <span style="font-size:10px;color:var(--fg3)">${Number(ev.score).toFixed(2)}</span>` : ''}`
      : '';
    // Mark tool call entries that oracle flagged as attack
    const oracleEv = !ev.oracle && ev.toolName ? oracleByTool.get(ev.toolName) : null;
    const isAttackCall = ev.oracle ? ev.taintAction === 'attack_detected' : oracleEv?.taintAction === 'attack_detected';
    const attackCallBadge = isAttackCall ? ' <span class="trust-badge untrusted">ATTACK</span>' : '';
    const approvalBadge = renderUserApprovalBadge(ev);
    // Standalone oracle row badge
    const oracleBadge = ev.oracle
      ? `<span class="trust-badge ${isAttackCall ? 'untrusted' : 'trusted'}">${isAttackCall ? 'ATTACK' : 'OK'}</span>`
      : '';
    html += `<tr${isAttackCall ? ' style="background:color-mix(in srgb, var(--red) 8%, var(--bg))"' : ''}>
      <td>${esc(time)}</td>
      <td>${esc(ev.hookType)}</td>
      <td>${esc(ev.oracle ? (ev.toolName || ev.injectionTaskId || 'oracle') : ev.guardrail || (isWebhook(ev) && ev.jobName ? ev.jobName : ev.toolName))}</td>
      <td>${esc(ev.taintAction)}${attackCallBadge}</td>
      <td>${oracleBadge || guardrailBadge || trustBadge}${approvalBadge ? ` ${approvalBadge}` : ''}</td>
      <td>${esc(ev.taintMode || '')}</td>
      <td>${ev.originalLen || 0}&rarr;${ev.modifiedLen || 0}</td>
      <td>${(() => { const s = getSymbolsFromEvent(ev); return s.length > 0 ? s.length : ''; })()}</td>
    </tr>`;
    const evSyms = getSymbolsFromEvent(ev);
    const evOrig = auditOriginal(ev);
    const evMod = auditModified(ev);
    const hasUllm = ev.hookType === 'inspect_symbol' && (ev.ullmPrompt || ev.ullmResponse);
    const inspectTraceTools = ev.hookType === 'inspect_symbol' ? inspectToolTraceSummary(ev) : [];
    const hasError = ev.hookType === 'inspect_symbol' && ev.error;
    const hasOracle = !!oracleEv || ev.oracle;
    const hasApproval = !!approvalBadge;
    const hasCommandPattern = isUntrustedCommandExecutionPattern(ev);
    // For standalone oracle rows, use ev itself as the oracle data
    const oracleData = oracleEv || (ev.oracle ? ev : null);
    const summaryParts = [];
    if (hasError) summaryParts.push('<span style="color:var(--red)">Error</span>');
    if (isAttackCall) summaryParts.push('<span style="color:var(--red)">Security Oracle: ATTACK</span>');
    else if (hasOracle) summaryParts.push('<span style="color:var(--green)">Security Oracle: OK</span>');
    if (hasCommandPattern) summaryParts.push('Command pattern');
    if (hasApproval) summaryParts.push('Human approval');
    if (evOrig || evMod) summaryParts.push('Before / After');
    if (inspectTraceTools.length > 0) summaryParts.push(`ULLM helpers: ${inspectTraceTools.join(', ')}`);
    if (hasUllm) summaryParts.push('ULLM I/O');
    if (evSyms.length > 0) summaryParts.push(`(${evSyms.length} symbols)`);
    if (summaryParts.length === 0) summaryParts.push('Raw audit JSON');
    {
      html += `<tr><td colspan="${colCount}"><details class="audit-expand"${hasError || isAttackCall ? ' open' : ''}>
        <summary>${summaryParts.join(' ')}</summary>`;
      if (hasError) {
        html += `<div style="background:color-mix(in srgb, var(--red) 10%, var(--bg));border:1px solid var(--red);border-radius:4px;padding:8px 12px;margin:6px 0;font-family:monospace;font-size:12px;white-space:pre-wrap;color:var(--red);">${esc(ev.error)}</div>`;
        if (ev.exitCode != null) html += `<div style="font-size:11px;color:var(--fg3);margin-top:2px;">Exit code: ${esc(String(ev.exitCode))}</div>`;
      }
      if (evOrig) html += renderAuditHeadBlock('Before', evOrig);
      if (evMod) html += renderAuditHeadBlock('After', evMod);
      html += renderUntrustedCommandExecutionDetails(ev);
      html += renderWebhookMeta(ev);
      html += renderUserApprovalDetails(ev);
      if (hasOracle) {
        const oColor = isAttackCall ? 'var(--red)' : 'var(--green)';
        const oLabel = isAttackCall ? 'ATTACK DETECTED' : 'NOT ATTACK';
        html += `<div style="background:color-mix(in srgb, ${oColor} 10%, var(--bg));border:1px solid ${oColor};border-radius:4px;padding:6px 10px;margin:6px 0;font-size:12px;">`;
        html += `<span style="font-weight:600;color:${oColor}">${oLabel}</span>`;
        if (oracleData.injectionTaskId) html += ` <span style="color:var(--fg3)">${esc(oracleData.injectionTaskId)}</span>`;
        if (Array.isArray(oracleData.checkPatterns) && oracleData.checkPatterns.length > 0) {
          html += `<div style="margin-top:4px;font-size:11px;color:var(--fg2)">Check: ${oracleData.checkPatterns.map(p => `<code>${esc(p)}</code>`).join(', ')}</div>`;
        }
        if (isAttackCall && oracleData.pattern) {
          html += `<div style="margin-top:2px;font-size:11px">Match: <code style="color:var(--red)">${esc(oracleData.pattern)}</code></div>`;
        }
        html += `</div>`;
      }
      if (inspectTraceTools.length > 0) html += renderInspectToolTrace(ev);
      if (hasUllm) {
        if (ev.ullmPrompt) html += renderAuditHeadBlock('ULLM Prompt (' + esc(ev.model || '') + ')', ev.ullmPrompt);
        if (ev.ullmResponse) html += renderAuditHeadBlock('ULLM Response', ev.ullmResponse);
      }
      if (evSyms.length > 0) {
        html += `<div class="sym-table-update" style="margin-top:6px">
          <div style="font-size:11px;font-weight:600;color:var(--orange);margin-bottom:4px;">Symbols Created</div>
          <table class="sym-table"><thead><tr><th>Symbol</th>${evSyms[0].value ? '<th>Value</th>' : ''}</tr></thead><tbody>`;
        for (const s of evSyms) {
          html += `<tr><td><span class="sym-marker">${esc(s.name)}</span></td>${s.value ? `<td class="sym-value-cell" onclick="showSymValue(this, '${esc(s.name).replace(/'/g, "\\'")}', this.dataset.val)" data-val="${esc(s.value)}">${esc(s.value)}</td>` : ''}</tr>`;
        }
        html += '</tbody></table></div>';
      }
      html += `${ev.origin ? `<div style="margin-top:4px;font-size:11px;color:var(--fg3)">Origin: ${esc(ev.origin)}</div>` : ''}
      ${renderAuditJsonBlock(ev)}
      </details></td></tr>`;
    }
  }
  html += '</tbody></table>';
  el.innerHTML = html;
}

function renderBotAudit(el, events) {
  if (events.length === 0) {
    el.innerHTML = '<div class="no-data">No audit events found</div>';
    return;
  }

  let html = '<div class="bot-audit-list">';
  for (const ev of events) {
    const time = localTime(ev.ts, 'HH:mm:ss.SSS');
    const title = botSourceLabel(ev);
    const before = auditOriginal(ev);
    const after = auditModified(ev);
    const symbols = getSymbolsFromEvent(ev);
    const symbolHtml = symbols.length > 0
      ? `<div class="bot-audit-symbols">${symbols.map(s => `<span class="sym-marker">${esc(s.name)}</span>`).join(' ')}</div>`
      : '';
    html += `<details class="bot-audit-card">
      <summary>
        <span class="bot-audit-time">${esc(time)}</span>
        <span class="bot-audit-title">${esc(title)}</span>
        ${symbols.length > 0 ? `<span class="bot-audit-count">${symbols.length} symbol${symbols.length !== 1 ? 's' : ''}</span>` : ''}
      </summary>
      <div class="bot-audit-body">
        ${before ? renderAuditHeadBlock('AgentView', before) : ''}
        ${after ? renderAuditHeadBlock('HumanView', after) : ''}
        ${symbolHtml}
        ${renderAuditJsonBlock(ev)}
      </div>
    </details>`;
  }
  html += '</div>';
  el.innerHTML = html;
}

// ── Symbol Table tab ─────────────────────────────────────────────────────
export function switchSymbolTableWs(wsId) {
  window.switchWorkspace(wsId);
}

export async function renderSymbolTable(el) {
  let events = [];
  let wsIds = [];
  let html = '';

  if (S.mode === 'eval' && S.currentEvalRunId && S.currentEvalTask) {
    const cacheKey = `eval:${S.currentEvalRunId}:${S.currentEvalTask}`;
    events = S.auditData[cacheKey] || [];
  } else if (S.mode === 'bot' && S.currentBotBatch) {
    // Bot mode: fetch all audit from batch
    const cacheKey = `bot:${S.currentBotBatch.batchId}`;
    if (!S.auditData[cacheKey]) {
      S.auditData[cacheKey] = await api(`bot/batches/${S.currentBotBatch.batchId}/audit`);
    }
    events = S.auditData[cacheKey] || [];
  } else {
    // E2E mode
    wsIds = usableWsIds(S.currentSession);
    if (wsIds.length === 0) {
      el.innerHTML = '<div class="no-data">No workspace data available</div>';
      return;
    }
    if (!S.symbolTableWsFilter) S.symbolTableWsFilter = S.currentWsId || wsIds[0];
    const ws = S.symbolTableWsFilter;
    if (!S.auditData[ws]) {
      S.auditData[ws] = await api(`sessions/${S.currentSession.id}/workspace/${ws}/audit`);
    }
    events = S.auditData[ws] || [];
  }

  // Build final symbol table from audit events
  const symbols = collectSymbolsFromAudit(events);

  if (S.mode === 'bot') {
    const conv = await loadCurrentBotConversation();
    renderBotSymbols(el, symbols, buildBotSymbolUsage(conv, events));
    return;
  }

  if (S.mode !== 'bot' && wsIds.length > 1) {
    html += renderWsSelector(wsIds, "switchSymbolTableWs(this.value)", { selected: S.symbolTableWsFilter });
  }

  if (symbols.length === 0) {
    html += '<div class="no-data">No symbols created in this test</div>';
    el.innerHTML = html;
    return;
  }

  html += `<div style="margin-bottom:8px;font-size:12px;color:var(--fg3)">${symbols.length} symbol${symbols.length !== 1 ? 's' : ''}</div>`;

  html += `<table class="audit-table"><thead><tr>
    <th>Symbol</th><th>Field</th><th>Value</th><th>Source Tool</th><th>Call ID</th><th>Time</th>
  </tr></thead><tbody>`;

  for (const s of symbols) {
    const time = s.ts ? localTime(s.ts, 'HH:mm:ss.SSS') : '';
    const callIdShort = s.toolCallId ? s.toolCallId.slice(-8) : '';
    const valCell = s.value
      ? `<td class="sym-value-cell" onclick="showSymValue(this, '${esc(s.name).replace(/'/g, "\\'")}', this.dataset.val)" data-val="${esc(s.value)}">${esc(s.value.length > 80 ? s.value.slice(0, 80) + '...' : s.value)}</td>`
      : '<td style="color:var(--fg3)">&mdash;</td>';
    html += `<tr>
      <td><span class="sym-marker">${esc(s.name)}</span></td>
      <td>${s.field ? esc(s.field) : '&mdash;'}</td>
      ${valCell}
      <td>${esc(s.toolName)}</td>
      <td><span class="conv-call-id" title="${esc(s.toolCallId)}">${esc(callIdShort)}</span></td>
      <td>${esc(time)}</td>
    </tr>`;
  }
  html += '</tbody></table>';
  el.innerHTML = html;
}

function renderBotSymbols(el, symbols, usageBySymbol = {}) {
  if (symbols.length === 0) {
    el.innerHTML = '<div class="no-data">No symbols created in this session</div>';
    return;
  }

  let html = `<div class="bot-symbol-table-wrap">
    <table class="bot-symbol-table">
      <thead><tr>
        <th>Symbol</th>
        <th>HumanView</th>
        <th>Created at</th>
      </tr></thead>
      <tbody>`;
  for (const s of symbols) {
    const time = s.ts ? localTime(s.ts, 'HH:mm:ss.SSS') : '';
    const valueHtml = s.value
      ? `<div class="bot-symbol-value" role="button" tabindex="0" data-val="${esc(s.value)}" onclick="event.stopPropagation();showSymValue(this, '${esc(s.name).replace(/'/g, "\\'")}', this.dataset.val)">${esc(s.value)}</div>`
      : '<span class="bot-symbol-empty">not recorded in audit event</span>';
    html += `<tr class="bot-symbol-main-row">
      <td>
        <span class="sym-marker">${esc(s.name)}</span>
      </td>
      <td>${valueHtml}</td>
      <td>${esc(s.source)}${time ? `<div class="bot-symbol-time">${esc(time)}</div>` : ''}</td>
    </tr>
    <tr class="bot-symbol-trajectory-row">
      <td colspan="3">${renderBotSymbolTrajectory(s, { layout: 'horizontal', usageBySymbol })}</td>
    </tr>`;
  }
  html += '</tbody></table></div>';
  el.innerHTML = html;
}

// ── Git tab ─────────────────────────────────────────────────────────────
export function switchGitWs(wsId) {
  window.switchWorkspace(wsId);
}

export async function renderGit(el) {
  const wsIds = usableWsIds(S.currentSession);
  if (wsIds.length === 0) {
    el.innerHTML = '<div class="no-data">No workspace data available</div>';
    return;
  }

  // Default to first workspace if not set
  if (S.gitWsFilter === 'all') S.gitWsFilter = wsIds[0];
  if (!wsIds.includes(S.gitWsFilter)) S.gitWsFilter = wsIds[0];

  // Fetch git log for selected workspace
  if (!S.gitLogData[S.gitWsFilter]) {
    S.gitLogData[S.gitWsFilter] = await api(`sessions/${S.currentSession.id}/workspace/${S.gitWsFilter}/git-log?subdir=workspace`);
  }
  const commits = S.gitLogData[S.gitWsFilter] || [];

  let html = '';
  if (wsIds.length > 1) {
    html += renderWsSelector(wsIds, "switchGitWs(this.value)", { selected: S.gitWsFilter });
  }

  if (commits.length === 0) {
    html += '<div class="no-data">No git history found for this workspace</div>';
    el.innerHTML = html;
    return;
  }

  // Build sidebar of commits
  let sidebarHtml = '';
  for (const c of commits) {
    const isTrusted = (c.subject || '').includes('[DUALVIEW-TRUSTED]');
    const isUntrusted = (c.subject || '').includes('[DUALVIEW-UNTRUSTED]');
    const dotColor = isTrusted ? 'var(--green)' : isUntrusted ? 'var(--red)' : 'var(--fg3)';
    const shortHash = (c.hash || '').slice(0, 7);
    const time = localTime(c.date, 'HH:mm:ss');
    const fileCount = (c.files || []).length;
    const refsHtml = renderRefBadges(c.refs);
    const dualviewHtml = c.dualview
      ? `<div class="dualview-meta"><span class="dualview-tool">tool=${esc(c.dualview.toolName)}</span><span class="dualview-callid">call=${esc(c.dualview.callId)}</span></div>`
      : '';
    sidebarHtml += `<div class="git-commit-item" data-hash="${esc(c.hash)}" onclick="selectGitCommit('${esc(c.hash)}')">
      <div><span class="git-commit-trust" style="background:${dotColor}"></span><span class="git-commit-hash">${esc(shortHash)}</span>${refsHtml}</div>
      <div class="git-commit-subject">${esc(c.subject)}</div>
      ${dualviewHtml}
      <div class="git-commit-meta">${esc(c.author)} &middot; ${esc(time)} &middot; ${fileCount} file${fileCount !== 1 ? 's' : ''}</div>
    </div>`;
  }

  html += `<div class="git-layout">
    <div class="git-sidebar">${sidebarHtml}</div>
    <div class="git-main" id="git-main"><div class="no-data">Select a commit</div></div>
  </div>`;
  el.innerHTML = html;

  // Auto-select first commit
  if (commits.length > 0) selectGitCommit(commits[0].hash);
}

export async function selectGitCommit(hash) {
  // Highlight active commit
  document.querySelectorAll('.git-commit-item').forEach(el => el.classList.toggle('active', el.dataset.hash === hash));

  const main = document.getElementById('git-main');
  if (!main) return;
  main.innerHTML = '<div class="no-data">Loading...</div>';

  const detail = await api(`sessions/${S.currentSession.id}/workspace/${S.gitWsFilter}/commit-detail?subdir=workspace&commit=${encodeURIComponent(hash)}`);
  if (detail.error) {
    main.innerHTML = `<div class="no-data">${esc(detail.error)}</div>`;
    return;
  }

  const isTrusted = (detail.subject || '').includes('[DUALVIEW-TRUSTED]');
  const isUntrusted = (detail.subject || '').includes('[DUALVIEW-UNTRUSTED]');
  const trustLabel = isTrusted ? '<span class="trust-badge trusted">AgentView</span>'
    : isUntrusted ? '<span class="trust-badge untrusted">HumanView</span>' : '';
  const detailRefsHtml = renderRefBadges(detail.refs || '');
  const detailAdfi = detail.dualview;
  const detailAdfiHtml = detailAdfi
    ? `<div class="dualview-meta" style="margin-top:6px;">
        <span class="dualview-tool">tool: ${esc(detailAdfi.toolName)}</span>
        <span class="dualview-callid">callId: ${esc(detailAdfi.callId)}</span>
        <span class="dualview-runid">runId: ${esc(detailAdfi.runId)}</span>
      </div>`
    : '';

  let html = `<div class="git-detail-header">
    <div class="git-detail-subject">${escSym(detail.subject)} ${trustLabel} ${detailRefsHtml}</div>
    <div class="git-detail-meta">
      <span style="font-family:monospace">${esc(detail.hash)}</span> &middot;
      ${esc(detail.author)} &middot; ${localTime(detail.date, 'date')} ${localTime(detail.date, 'HH:mm:ss')}
    </div>
    ${detailAdfiHtml}
  </div>`;

  if (detail.body) {
    html += `<div class="git-detail-body">${escSym(detail.body)}</div>`;
  }

  if (detail.diff) {
    html += `<div class="git-diff"><pre>${renderDiff(detail.diff)}</pre></div>`;
  }

  main.innerHTML = html;
}

// ── Files tabs (Root / Trusted / Untrusted) ─────────────────────────────
export async function switchBotFileView(view) {
  if (view !== 'trusted' && view !== 'untrusted') return;
  S.currentBotFileView = view;
  await renderBotFileSystem(document.getElementById('tab-content'));
}

export async function renderBotFileSystem(el) {
  const view = S.currentBotFileView === 'untrusted' ? 'untrusted' : 'trusted';
  S.currentBotFileView = view;
  el.innerHTML = `<div class="bot-file-tabs">
    <button class="bot-file-tab${view === 'trusted' ? ' active' : ''}" onclick="switchBotFileView('trusted')">AgentView</button>
    <button class="bot-file-tab${view === 'untrusted' ? ' active' : ''}" onclick="switchBotFileView('untrusted')">HumanView</button>
  </div>
  <div id="bot-files-content"></div>`;
  await renderFilesView(document.getElementById('bot-files-content'), view);
}

export async function renderFilesView(el, view) {
  S.currentFileView = view;
  S.currentFilePath = null;

  let header = '';

  if (S.mode === 'eval' && S.currentEvalRunId) {
    // Eval mode — single workspace, no selector
  } else if (S.mode === 'bot' && S.currentBotBatch) {
    // Bot mode — single workspace, no workspace selector
  } else {
    // E2E mode — workspace selector
    const wsIds = usableWsIds(S.currentSession);
    if (wsIds.length === 0) {
      el.innerHTML = '<div class="no-data">No workspace data available</div>';
      return;
    }
    if (!S.currentWsId || !wsIds.includes(S.currentWsId)) S.currentWsId = wsIds[0];
    if (wsIds.length > 1) {
      header += renderWsSelector(wsIds, `currentWsId=this.value;currentFilePath=null;renderFilesView(document.getElementById('tab-content'),'${view}')`);
    }
  }

  const prefix = wsApiPrefix();
  const viewLabel = S.mode === 'bot'
    ? dualViewName(view)
    : S.mode === 'eval'
    ? (view === 'root' ? 'Task Workspace Snapshot'
      : view === 'trusted' ? 'Agent File System'
      : 'Human File System')
    : (view === 'root' ? 'Root (.openclaw workspace)'
      : view === 'trusted' ? 'Agent File System'
      : 'Human File System');
  let viewRootPath = '';
  try {
    const roots = await api(`${prefix}/view-roots${wsQuery()}`);
    viewRootPath = roots[view] || '';
  } catch {}
  const pathNote = viewRootPath ? `<span style="margin-left:8px;opacity:0.7">${esc(viewRootPath)}</span><button class="copy-btn" onclick="copyText('${esc(viewRootPath.replace(/'/g, "\\'"))}',this)" title="Copy path">copy path</button>` : '';
  header += `<div style="padding:4px 12px;font-size:11px;color:var(--fg3);border-bottom:1px solid var(--border);display:flex;align-items:center;gap:6px;">${viewLabel}${pathNote}</div>`;

  const files = await api(`${prefix}/files${wsQuery(view !== 'root' ? { view } : {})}`);

  if (files.length === 0) {
    el.innerHTML = header + `<div class="no-data">No files found${view === 'trusted' && S.mode !== 'bot' ? ' (Agent File System may not exist in this session)' : ''}</div>`;
    return;
  }

  // Build tree
  const tree = {};
  for (const f of files) {
    const parts = f.split('/');
    let node = tree;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node[parts[i]]) node[parts[i]] = {};
      node = node[parts[i]];
    }
    node[parts[parts.length - 1]] = null;
  }

  // For trusted/untrusted views, right panel defaults to full git log; for root, just file preview
  const defaultRight = (view === 'trusted' || view === 'untrusted')
    ? '<div id="files-git-sidebar" class="files-git-panel"></div>'
    : '';

  el.innerHTML = header + `<div class="files-layout">
    <div class="files-sidebar">${renderFileTree(tree, '', view)}</div>
    <div class="files-main" id="files-main" style="display:flex;flex-direction:row;">
      <div id="files-content-panel" style="flex:1;display:flex;flex-direction:column;">
        <div class="no-data">Select a file from the list</div>
      </div>
      ${defaultRight}
    </div>
  </div>`;

  // Load full git log for trusted/untrusted views
  if (view === 'trusted' || view === 'untrusted') {
    loadFilesGitLog(view);
  }
}

export async function loadFilesGitLog(view) {
  const panel = document.getElementById('files-git-sidebar');
  if (!panel) return;
  // eval mode: use the saved DualView workspace git log.
  panel.innerHTML = '<div class="no-data">Loading git log...</div>';

  const gitSubdir = view === 'trusted' ? 'agentview' : (S.mode === 'eval' ? '.' : 'workspace');
  const gitLog = await api(`${wsApiPrefix()}/git-log${wsQuery({ subdir: gitSubdir })}`);
  if (!gitLog || gitLog.length === 0) {
    panel.innerHTML = '<div class="no-data">No git history</div>';
    return;
  }

  let html = '<div style="font-size:11px;font-weight:600;color:var(--fg3);padding:6px 8px;border-bottom:1px solid var(--border);">GIT LOG</div>';
  for (const c of gitLog) {
    const isTrusted = (c.subject || '').includes('[DUALVIEW-TRUSTED]');
    const isUntrusted = (c.subject || '').includes('[DUALVIEW-UNTRUSTED]');
    // In trusted view, highlight trusted commits; in untrusted view, highlight untrusted
    const highlight = (view === 'trusted' && isTrusted) || (view === 'untrusted' && isUntrusted);
    const dotColor = isTrusted ? 'var(--green)' : isUntrusted ? 'var(--red)' : 'var(--fg3)';
    const shortHash = (c.hash || '').slice(0, 7);
    const time = localTime(c.date, 'HH:mm:ss');
    const trustTag = S.mode === 'bot'
      ? (isTrusted ? '<span class="trust-badge trusted" style="font-size:9px;">AgentView</span>'
        : isUntrusted ? '<span class="trust-badge untrusted" style="font-size:9px;">HumanView</span>' : '')
      : (isTrusted ? '<span class="trust-badge trusted" style="font-size:9px;">T</span>'
        : isUntrusted ? '<span class="trust-badge untrusted" style="font-size:9px;">U</span>' : '');
    const refsHtml = renderRefBadges(c.refs);
    const toolTag = c.dualview ? `<span style="color:var(--orange);font-size:9px;">${esc(c.dualview.toolName)}</span>` : '';
    const fileCount = (c.files || []).length;
    const bgStyle = highlight ? 'background:color-mix(in srgb, ' + (isTrusted ? 'var(--green)' : 'var(--red)') + ' 8%, var(--bg2));' : '';
    html += `<div class="git-commit-item" style="${bgStyle}font-size:11px;padding:4px 8px;" onclick="selectFilesGitCommit('${esc(c.hash)}','${view}')">
      <div><span class="git-commit-trust" style="background:${dotColor}"></span>${trustTag}<span class="git-commit-hash">${esc(shortHash)}</span> ${toolTag}${refsHtml}</div>
      <div style="color:var(--fg3);font-size:10px;">${esc(time)} &middot; ${fileCount} file${fileCount !== 1 ? 's' : ''}</div>
    </div>`;
  }
  panel.innerHTML = html;
}

export async function selectFilesGitCommit(hash, view) {
  const panel = document.getElementById('files-content-panel');
  if (!panel) return;
  panel.innerHTML = '<div class="no-data">Loading...</div>';

  const gitSubdir = view === 'trusted' ? 'agentview' : (S.mode === 'eval' ? '.' : 'workspace');
  const detail = await api(`${wsApiPrefix()}/commit-detail${wsQuery({ subdir: gitSubdir, commit: hash })}`);
  if (detail.error) {
    panel.innerHTML = `<div class="no-data">${esc(detail.error)}</div>`;
    return;
  }

  const isTrusted = (detail.subject || '').includes('[DUALVIEW-TRUSTED]');
  const isUntrusted = (detail.subject || '').includes('[DUALVIEW-UNTRUSTED]');
  const trustLabel = S.mode === 'bot'
    ? (isTrusted ? '<span class="trust-badge trusted">AgentView</span>'
      : isUntrusted ? '<span class="trust-badge untrusted">HumanView</span>' : '')
    : (isTrusted ? '<span class="trust-badge trusted">AgentView</span>'
      : isUntrusted ? '<span class="trust-badge untrusted">HumanView</span>' : '');
  const refsHtml = renderRefBadges(detail.refs || '');
  const dualview = detail.dualview;
  const dualviewHtml = dualview
    ? `<div class="dualview-meta" style="margin-top:4px;">
        <span class="dualview-tool">tool: ${esc(dualview.toolName)}</span>
        <span class="dualview-callid">callId: ${esc(dualview.callId)}</span>
        <span class="dualview-runid">runId: ${esc(dualview.runId)}</span>
      </div>`
    : '';

  let html = `<div style="padding:8px 12px;border-bottom:1px solid var(--border);">
    <div style="font-weight:600;">${escSym(detail.subject)} ${trustLabel} ${refsHtml}</div>
    <div style="font-size:11px;color:var(--fg3);">${esc(detail.hash)} &middot; ${esc(detail.author)} &middot; ${localTime(detail.date, 'date')} ${localTime(detail.date, 'HH:mm:ss')}</div>
    ${dualviewHtml}
  </div>`;

  if (detail.diff) {
    html += `<div class="git-diff" style="flex:1;overflow-y:auto;"><pre>${renderDiff(detail.diff)}</pre></div>`;
  }

  panel.innerHTML = html;
}

export function renderFileTree(node, prefix, view) {
  let html = '';
  const entries = Object.entries(node).sort(([a, av], [b, bv]) => {
    const aDir = av !== null ? 0 : 1;
    const bDir = bv !== null ? 0 : 1;
    if (aDir !== bDir) return aDir - bDir;
    return a.localeCompare(b);
  });
  for (const [name, value] of entries) {
    const fullPath = prefix ? `${prefix}/${name}` : name;
    if (value !== null) {
      html += `<details class="file-dir"><summary>${esc(name)}/</summary>${renderFileTree(value, fullPath, view)}</details>`;
    } else {
      html += `<div class="file-item" data-filepath="${esc(fullPath)}" onclick="selectFileInView('${esc(fullPath)}','${view}')">${esc(name)}</div>`;
    }
  }
  return html;
}

export async function selectFileInView(filepath, view) {
  S.currentFilePath = filepath;
  document.querySelectorAll('.file-item').forEach(el => el.classList.toggle('active', el.dataset.filepath === filepath));

  const panel = document.getElementById('files-content-panel');
  if (!panel) return;
  panel.innerHTML = '<div class="no-data">Loading...</div>';

  const prefix = wsApiPrefix();

  const hasGit = S.mode !== 'eval' && (view === 'trusted' || view === 'untrusted');
  const gitSubdir = view === 'trusted' ? 'agentview' : (S.mode === 'eval' ? '.' : 'workspace');
  const [fileResult, gitLog] = await Promise.all([
    api(`${prefix}/file${wsQuery({ path: filepath, view: view !== 'root' ? view : '' })}`),
    hasGit
      ? api(`${prefix}/file-git-log?subdir=${encodeURIComponent(gitSubdir)}&path=${encodeURIComponent(filepath)}`)
      : Promise.resolve([]),
  ]);

  let html = `<div class="file-preview-header"><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(filepath)}</span><button class="copy-btn" onclick="copyText('${esc(filepath.replace(/'/g, "\\'"))}',this)" title="Copy file path">copy path</button><button class="copy-btn" onclick="copyFileContent(this)" title="Copy file content">copy text</button></div>`;

  // Per-file git history
  if (gitLog.length > 0) {
    html += '<div class="file-git-history">';
    html += '<div style="font-size:11px;font-weight:600;color:var(--fg3);margin-bottom:4px;">FILE HISTORY</div>';
    html += `<div class="file-git-entry active" data-commit="" onclick="showFileVersionInView('${esc(filepath)}','${esc(filepath)}','','${view}')">
      <span style="color:var(--green);font-size:11px;font-weight:600;">current</span>
    </div>`;
    for (const c of gitLog) {
      const isTrusted = (c.subject || '').includes('[DUALVIEW-TRUSTED]');
      const isUntrusted = (c.subject || '').includes('[DUALVIEW-UNTRUSTED]');
      const dotColor = isTrusted ? 'var(--green)' : isUntrusted ? 'var(--red)' : 'var(--fg3)';
      const shortHash = (c.hash || '').slice(0, 7);
      const trustTag = S.mode === 'bot'
        ? (isTrusted ? '<span class="trust-badge trusted" style="font-size:9px;">AgentView</span>'
          : isUntrusted ? '<span class="trust-badge untrusted" style="font-size:9px;">HumanView</span>' : '')
        : (isTrusted ? '<span class="trust-badge trusted" style="font-size:9px;">T</span>'
          : isUntrusted ? '<span class="trust-badge untrusted" style="font-size:9px;">U</span>' : '');
      const refsBadge = renderRefBadges(c.refs);
      const toolTag = c.dualview ? `<span style="color:var(--orange);font-size:9px;">${esc(c.dualview.toolName)}</span>` : '';
      html += `<div class="file-git-entry" data-commit="${esc(c.hash)}" onclick="showFileVersionInView('${esc(filepath)}','${esc(filepath)}','${esc(c.hash)}','${view}')" title="${esc(c.subject)}">
        <span style="color:${dotColor}">&#9679;</span>
        ${trustTag}
        <span style="color:var(--fg3);font-size:10px;">${esc(shortHash)}</span>
        ${toolTag}${refsBadge}
      </div>`;
    }
    html += '</div>';
  }

  // File content
  if (fileResult.error) {
    html += `<div class="no-data">${esc(fileResult.error)}</div>`;
  } else {
    html += `<pre class="file-preview-content" id="file-content">${escSym(fileResult.content)}</pre>`;
  }

  panel.innerHTML = html;

  // Update the git sidebar to highlight this file's commits
  if (hasGit) {
    updateFilesGitHighlight(gitLog.map(c => c.hash));
  }
}

export function updateFilesGitHighlight(fileHashes) {
  const panel = document.getElementById('files-git-sidebar');
  if (!panel) return;
  const hashSet = new Set(fileHashes);
  panel.querySelectorAll('.git-commit-item').forEach(el => {
    const onclick = el.getAttribute('onclick') || '';
    const m = onclick.match(/selectFilesGitCommit\('([^']+)'/);
    if (m && hashSet.has(m[1])) {
      el.style.borderLeft = '3px solid var(--blue)';
    } else {
      el.style.borderLeft = '';
    }
  });
}

export async function showFileVersionInView(filepath, gitRelPath, commitHash, view) {
  document.querySelectorAll('.file-git-entry').forEach(el => el.classList.toggle('active', el.dataset.commit === commitHash));

  const contentEl = document.getElementById('file-content');
  if (!contentEl) return;

  const prefix = wsApiPrefix();
  if (!commitHash) {
    const result = await api(`${prefix}/file${wsQuery({ path: filepath, view: view !== 'root' ? view : '' })}`);
    contentEl.innerHTML = result.error ? esc(result.error) : escSym(result.content);
  } else {
    const gitSubdir = view === 'trusted' ? 'agentview' : (S.mode === 'eval' ? '.' : 'workspace');
    const result = await api(`${prefix}/file-at-commit${wsQuery({ subdir: gitSubdir, path: gitRelPath, commit: commitHash })}`);
    contentEl.innerHTML = result.error ? esc(result.error) : escSym(result.content);
  }
}

// ── Test Spec tab ────────────────────────────────────────────────────────
export async function renderTestSpec(el) {
  // Eval mode: show PinchBench task markdown
  if (S.mode === 'eval' && S.currentEvalRunId && S.currentEvalTask) {
    const resp = await api(`eval/runs/${encodeURIComponent(S.currentEvalRunId)}/task-spec/${encodeURIComponent(S.currentEvalTask)}`);
    if (resp.spec) {
      el.innerHTML = `<pre class="conv-pre" style="white-space:pre-wrap;padding:16px;font-size:12px;line-height:1.6">${esc(resp.spec)}</pre>`;
    } else {
      el.innerHTML = '<div class="no-data">Task spec not found</div>';
    }
    return;
  }

  if (!S.currentSession) { el.innerHTML = ''; return; }

  // Collect unique test IDs from current session (strip ×mode suffix), sorted by name
  const tests = [...S.currentSession.tests].sort((a, b) => a.name.localeCompare(b.name));
  const testIds = [...new Set(tests.map(t => t.name.split('\u00d7')[0]))];
  if (testIds.length === 0) {
    el.innerHTML = '<div class="no-data">No tests in this session</div>';
    return;
  }

  // Default to first test or keep current selection
  if (!S.currentSpecTestId || !testIds.includes(S.currentSpecTestId)) {
    const nameMap = wsTestNameMap();
    const wsTestName = nameMap[S.currentWsId];
    const matchedId = wsTestName ? testIds.find(id => wsTestName.startsWith(id)) : null;
    S.currentSpecTestId = matchedId || testIds[0];
  }

  // Build dropdown
  let html = '<div style="padding:16px;overflow-y:auto;height:calc(100vh - 180px)">';
  if (testIds.length > 1) {
    html += '<div class="ws-selector" style="margin-bottom:12px"><label>Test:</label><select onchange="switchSpecTest(this.value)">';
    for (const id of testIds) {
      const label = S.testNames?.[id] ? `${id} ${S.testNames[id]}` : id;
      html += `<option value="${esc(id)}" ${id === S.currentSpecTestId ? 'selected' : ''}>${esc(label)}</option>`;
    }
    html += '</select></div>';
  }

  // Fetch spec
  let spec = S.testSpecCache[S.currentSpecTestId];
  if (!spec) {
    try {
      const data = await api(`test-spec/${encodeURIComponent(S.currentSpecTestId)}`);
      if (data && data.content) {
        S.testSpecCache[S.currentSpecTestId] = data;
        spec = data;
      }
    } catch {}
  }

  const filename = spec?.filename || S.currentSpecTestId + '.yaml';
  const content = spec?.content;
  html += `<details class="conv-entry" open>
    <summary class="conv-message" style="background:color-mix(in srgb, var(--cyan) 10%, var(--bg))">
      <span class="conv-role" style="color:var(--cyan)">${esc(filename)}</span>
    </summary>
    <div class="conv-body">
      ${content ? `<pre class="conv-pre">${highlightYaml(content)}</pre>` : '<div class="no-data">Spec file not found (restart dashboard server if you just added the endpoint)</div>'}
    </div>
  </details>`;

  // In security mode, also show the injection task and attack template specs
  if (S.currentSession?.attackSuccessRate != null && S.currentWsId) {
    const wsTest = S.currentSession.tests.find(t => t.wsId === S.currentWsId);
    if (wsTest) {
      const parts = wsTest.name.split('\u00d7');
      const itId = parts[1]; // e.g. "IT-01"
      const attackId = parts[2]; // e.g. "pi-web-claude"
      if (itId) {
        try {
          const itData = await api(`injection-task/${encodeURIComponent(itId)}`);
          if (itData?.content) {
            html += `<details class="conv-entry" open>
              <summary class="conv-message" style="background:color-mix(in srgb, var(--red) 10%, var(--bg))">
                <span class="conv-role" style="color:var(--red)">${esc(itData.filename)}</span>
              </summary>
              <div class="conv-body">
                <pre class="conv-pre">${highlightYaml(itData.content)}</pre>
              </div>
            </details>`;
          }
        } catch {}
      }
      if (attackId) {
        try {
          const atkData = await api(`attack-template/${encodeURIComponent(attackId)}`);
          if (atkData?.content) {
            html += `<details class="conv-entry">
              <summary class="conv-message" style="background:color-mix(in srgb, var(--orange) 10%, var(--bg))">
                <span class="conv-role" style="color:var(--orange)">${esc(atkData.filename)}</span>
              </summary>
              <div class="conv-body">
                <pre class="conv-pre">${highlightYaml(atkData.content)}</pre>
              </div>
            </details>`;
          }
        } catch {}
      }
    }
  }

  html += '</div>';
  el.innerHTML = html;
}

export function switchSpecTest(testId) {
  S.currentSpecTestId = testId;
  renderTestSpec(document.getElementById('tab-content'));
}

// ── Assertion popup (module-private helpers + exported functions) ─────────
function _assertionPopupOutsideClick(e) {
  if (S._assertionPopup && !S._assertionPopup.contains(e.target)) {
    e.stopPropagation();
    e.preventDefault();
    hideAssertionPopup();
  }
}
function _assertionPopupEscKey(e) {
  if (e.key === 'Escape') hideAssertionPopup();
}

export function hideAssertionPopup() {
  if (S._assertionPopup) { S._assertionPopup.remove(); S._assertionPopup = null; }
  document.removeEventListener('click', _assertionPopupOutsideClick, true);
  document.removeEventListener('keydown', _assertionPopupEscKey);
}

/** Show a popup with YAML spec + details for an assertion result. */
export async function showAssertionPopup(evt, assertionIdx) {
  evt.stopPropagation();
  hideAssertionPopup();

  const a = S._currentAssertions[assertionIdx];
  if (!a) return;

  const el = evt.currentTarget;
  const rect = el.getBoundingClientRect();

  // Build popup content
  let html = `<div class="assertion-popup-title">${esc(a.label)}</div>`;

  // Status + reason
  const statusIcon = a.status === 'pass' ? '\u2713' : a.status === 'fail' ? '\u2717' : '\u26a0';
  const statusColor = a.status === 'pass' ? 'var(--green)' : a.status === 'fail' ? 'var(--red)' : 'var(--orange)';
  html += `<div class="assertion-popup-meta">
    <span style="color:${statusColor};font-weight:700">${statusIcon} ${a.status.toUpperCase()}</span>
  </div>`;

  // Description (if present)
  if (a.description) {
    html += `<div class="assertion-popup-description">${esc(a.description)}</div>`;
  }

  // Details section
  html += `<div class="assertion-popup-section">
    <div class="assertion-popup-section-title">Details</div>
    <div class="assertion-popup-meta">`;
  html += `<div><b>Reason:</b> ${esc(a.reason)}</div>`;
  if (a.tool) html += `<div><b>Tool:</b> ${esc(a.tool)}</div>`;
  if (a.assert) html += `<div><b>Assert type:</b> ${esc(a.assert)}</div>`;
  if (a.template) html += `<div><b>Template:</b> ${esc(a.template)}.yaml</div>`;
  if (a.timing) html += `<div><b>Timing:</b> ${esc(a.timing)}${a.timingRef ? ' ' + esc(a.timingRef) : ''}</div>`;
  html += `</div></div>`;

  // YAML spec section — try to fetch and extract the assertion snippet
  const yamlSnippet = await getAssertionYamlSnippet(a.idx, assertionIdx);
  if (yamlSnippet) {
    html += `<div class="assertion-popup-section">
      <div class="assertion-popup-section-title">YAML Specification</div>
      <pre>${highlightYaml(yamlSnippet)}</pre>
    </div>`;
  }

  const popup = document.createElement('div');
  popup.className = 'assertion-popup';
  popup.innerHTML = html;
  document.body.appendChild(popup);

  const pw = popup.offsetWidth, ph = popup.offsetHeight;
  // Position: prefer below the clicked row, centered on it; fall back to above
  let left = rect.left + (rect.width - pw) / 2;
  let top = rect.bottom + 6;
  if (top + ph > window.innerHeight - 8) top = rect.top - ph - 6;
  if (top < 8) top = 8;
  if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
  if (left < 8) left = 8;
  popup.style.left = left + 'px';
  popup.style.top = top + 'px';
  S._assertionPopup = popup;

  // Close on outside click or Escape (deferred to avoid immediate close)
  setTimeout(() => {
    document.addEventListener('click', _assertionPopupOutsideClick, true);
    document.addEventListener('keydown', _assertionPopupEscKey);
  }, 0);
}

/** Extract a single assertion's YAML snippet from the test spec by index.
 *  For multi-turn specs, `idx` resets per turn in the log output.
 *  We detect which turn the assertion belongs to by tracking idx resets
 *  across the full assertion results list. */
export async function getAssertionYamlSnippet(idx, flatPos) {
  if (idx == null) return null;

  // If the assertion came from a template, fetch the template YAML instead
  const a = S._currentAssertions[flatPos];
  if (a?.template) {
    return await getTemplateYamlSnippet(a.template, a.tidx ?? 0);
  }

  // Get raw test name from session data (not the friendly-resolved name)
  const test = S.currentSession?.tests?.find(t => t.wsId === S.currentWsId);
  if (!test) return null;
  const testId = test.name.split('\u00d7')[0]; // strip ×mode suffix

  // Fetch and cache the spec YAML
  if (!S._assertionSpecs[testId]) {
    try {
      const data = await api(`test-spec/${encodeURIComponent(testId)}`);
      if (data?.content) {
        S._assertionSpecs[testId] = data.content;
      }
    } catch { return null; }
  }

  const yamlContent = S._assertionSpecs[testId];
  if (!yamlContent) return null;

  // Determine which turn this assertion belongs to by scanning all assertion results
  // up to flatPos and detecting idx resets (idx decreases = new turn boundary)
  const allAssertions = S._currentAssertions || [];
  let turnNumber = 0;
  let prevIdx = -1;
  const pos = flatPos != null ? flatPos : allAssertions.findIndex(a => a.idx === idx);
  for (let i = 0; i <= pos && i < allAssertions.length; i++) {
    const a = allAssertions[i];
    if (a.idx != null && a.idx <= prevIdx) turnNumber++;
    if (a.idx != null) prevIdx = a.idx;
  }

  // Parse assertion blocks from YAML
  const lines = yamlContent.split('\n');
  const turnAssertionBlocks = []; // array of arrays of assertion snippets

  // Check for multi-turn format (turns: array with nested assertions:)
  const isMultiTurn = lines.some(l => /^turns:\s*$/.test(l));

  if (isMultiTurn) {
    // Find each "assertions:" block under turns
    let inTurns = false;
    for (let i = 0; i < lines.length; i++) {
      if (/^turns:\s*$/.test(lines[i])) { inTurns = true; continue; }
      if (inTurns && lines[i].length > 0 && lines[i][0] !== ' ' && lines[i][0] !== '#') break;
      if (inTurns && /^\s+assertions:\s*$/.test(lines[i])) {
        const indent = lines[i].match(/^(\s+)/)[1].length;
        const entryIndent = indent + 2; // "  - " relative to assertions:
        const entries = [];
        let current = [];
        for (let j = i + 1; j < lines.length; j++) {
          const line = lines[j];
          // Stop at same or lesser indent (next key at turn level or top level)
          if (line.trim() && !line.startsWith(' '.repeat(indent + 1)) && line[0] !== '#') break;
          const entryRe = new RegExp(`^\\s{${entryIndent},${entryIndent + 2}}-\\s`);
          if (entryRe.test(line)) {
            if (current.length > 0) entries.push(current.join('\n'));
            current = [line];
          } else if (current.length > 0) {
            current.push(line);
          }
        }
        if (current.length > 0) entries.push(current.join('\n'));
        turnAssertionBlocks.push(entries);
      }
    }
  } else {
    // Single-turn: top-level assertions: block
    let assertionsStart = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/^assertions:\s*$/.test(lines[i])) { assertionsStart = i + 1; break; }
    }
    if (assertionsStart >= 0) {
      const entries = [];
      let current = [];
      for (let i = assertionsStart; i < lines.length; i++) {
        const line = lines[i];
        if (line.length > 0 && line[0] !== ' ' && line[0] !== '#') break;
        if (/^\s{1,4}-\s/.test(line)) {
          if (current.length > 0) entries.push(current.join('\n'));
          current = [line];
        } else if (current.length > 0) {
          current.push(line);
        }
      }
      if (current.length > 0) entries.push(current.join('\n'));
      turnAssertionBlocks.push(entries);
    }
  }

  // idx is the position in the combined (template + inline) array logged by the
  // assertion runner. Template assertions are prepended, so subtract the template
  // count in this turn to get the index into the inline-only YAML assertions block.
  let templateCountInTurn = 0;
  let curTurn = 0;
  let prev = -1;
  for (let i = 0; i < allAssertions.length; i++) {
    const aa = allAssertions[i];
    if (aa.idx != null && aa.idx <= prev) curTurn++;
    if (aa.idx != null) prev = aa.idx;
    if (curTurn === turnNumber && aa.template) templateCountInTurn++;
    if (curTurn > turnNumber) break;
  }
  const inlineIdx = idx - templateCountInTurn;

  const turnEntries = turnAssertionBlocks[turnNumber] || turnAssertionBlocks[0] || [];
  return turnEntries[inlineIdx] ?? null;
}

/** Fetch a YAML snippet from an assertion template file by template ID and index within it. */
async function getTemplateYamlSnippet(templateId, tidx) {
  // Cache key: template specs are separate from test specs
  const cacheKey = `_tpl_${templateId}`;
  if (!S._assertionSpecs[cacheKey]) {
    try {
      const data = await api(`template-spec/${encodeURIComponent(templateId)}`);
      if (data?.content) {
        S._assertionSpecs[cacheKey] = data.content;
      }
    } catch { return null; }
  }

  const yamlContent = S._assertionSpecs[cacheKey];
  if (!yamlContent) return null;

  // Parse assertion blocks from the template YAML (always has top-level "assertions:")
  const lines = yamlContent.split('\n');
  let assertionsStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^assertions:\s*$/.test(lines[i])) { assertionsStart = i + 1; break; }
  }
  if (assertionsStart < 0) return yamlContent; // fallback: show entire template

  const entries = [];
  let current = [];
  for (let i = assertionsStart; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 0 && line[0] !== ' ' && line[0] !== '#') break;
    if (/^\s{1,4}-\s/.test(line)) {
      if (current.length > 0) entries.push(current.join('\n'));
      current = [line];
    } else if (current.length > 0) {
      current.push(line);
    }
  }
  if (current.length > 0) entries.push(current.join('\n'));

  // Prepend a comment showing the template source
  const snippet = entries[tidx] ?? entries[0] ?? null;
  if (snippet) {
    return `# from: ${templateId}.yaml\n${snippet}`;
  }
  return null;
}
