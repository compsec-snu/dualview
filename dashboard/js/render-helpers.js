import S from './state.js';
import { esc, escSym, stripTs, splitPrefixJson, localTime } from './utils.js';

/** Render a JSON value as an interactive tree. */
export function renderJsonTree(val, key, depth) {
  if (depth === undefined) depth = 0;
  const keyHtml = key !== undefined ? `<span class="jt-key">${esc(String(key))}</span>: ` : '';

  if (val === null) return `<div class="jt-leaf">${keyHtml}<span class="jt-null">null</span></div>`;
  if (typeof val === 'boolean') return `<div class="jt-leaf">${keyHtml}<span class="jt-bool">${val}</span></div>`;
  if (typeof val === 'number') return `<div class="jt-leaf">${keyHtml}<span class="jt-num">${val}</span></div>`;
  if (typeof val === 'string') {
    if (val.length > 2 && (val[0] === '{' || val[0] === '[')) {
      try {
        const inner = JSON.parse(val);
        if (typeof inner === 'object' && inner !== null) {
          return renderJsonTree(inner, key, depth);
        }
      } catch {}
    }
    if (val.includes('\n') || val.includes('\t')) {
      return `<div class="jt-leaf">${keyHtml}<pre class="jt-str-pre">${escSym(val)}</pre></div>`;
    }
    return `<div class="jt-leaf">${keyHtml}<span class="jt-str">${escSym(val)}</span></div>`;
  }
  if (Array.isArray(val)) {
    if (val.length === 0) return `<div class="jt-leaf">${keyHtml}<span class="jt-bracket">[]</span></div>`;
    let inner = '';
    for (let i = 0; i < val.length; i++) inner += renderJsonTree(val[i], i, depth + 1);
    return `<div class="jt-branch">${keyHtml}${inner}</div>`;
  }
  if (typeof val === 'object') {
    const keys = Object.keys(val);
    if (keys.length === 0) return `<div class="jt-leaf">${keyHtml}<span class="jt-bracket">{}</span></div>`;
    let inner = '';
    for (const k of keys) inner += renderJsonTree(val[k], k, depth + 1);
    return `<div class="jt-branch">${keyHtml}${inner}</div>`;
  }
  return `<div class="jt-leaf">${keyHtml}${esc(String(val))}</div>`;
}

/**
 * Render a content block with smart summary/body dedup.
 */
export function renderContentBlock(text, opts) {
  const role = opts.role || '';
  const roleClass = opts.roleClass || '';
  const summaryStyle = opts.summaryStyle || '';
  const roleStyle = opts.roleStyle || '';
  const viewClass = opts.view ? ` bot-${opts.view}-view-block` : '';
  const defaultOpen = opts.open !== false;
  const useSym = opts.sym !== false;
  const escFn = useSym ? escSym : esc;

  const forceDetails = opts.forceDetails === true;
  const split = text && text.length > 2 ? splitPrefixJson(text) : null;

  if (!split && text.length <= 120 && !forceDetails) {
    return `<div class="conv-entry${viewClass}"><div class="conv-message ${roleClass}" style="${summaryStyle}">
      <span class="conv-role ${roleClass}" style="${roleStyle}">${role}</span> <span style="white-space:pre-wrap">${escFn(text)}</span>
    </div></div>`;
  }

  const previewSrc = stripTs(text.replace(/\n/g, ' '));
  const preview = previewSrc.length > 100 ? previewSrc.slice(0, 100) + '...' : previewSrc;

  if (split) {
    let body = '';
    if (split.prefix) {
      body += `<div style="font-size:11px;color:var(--fg2);margin:2px 0">${escFn(split.prefix)}</div>`;
    }
    body += `<div class="json-tree">${renderJsonTree(split.parsed, undefined, 0)}</div>`;
    body += `<details class="jt-raw-toggle" style="margin-top:6px"><summary>Raw text</summary>
      <pre class="conv-pre" style="margin-top:4px">${escFn(text)}</pre>
    </details>`;
    return `<details class="conv-entry${viewClass}"${defaultOpen ? ' open' : ''}><summary class="conv-message ${roleClass}" style="${summaryStyle}">
      <span class="conv-role ${roleClass}" style="${roleStyle}">${role}</span> ${esc(preview)}
    </summary><div class="conv-body">${body}</div></details>`;
  }

  return `<details class="conv-entry${viewClass}"${defaultOpen ? ' open' : ''}><summary class="conv-message ${roleClass}" style="${summaryStyle}">
    <span class="conv-role ${roleClass}" style="${roleStyle}">${role}</span> ${esc(preview)}
  </summary><div class="conv-body"><pre class="conv-pre">${escFn(text)}</pre></div></details>`;
}

export function renderRefBadges(refs) {
  if (!refs) return '';
  return refs.split(',').map(r => r.trim()).filter(Boolean).map(r => {
    if (r.startsWith('HEAD')) return `<span class="ref-badge head">${esc(r)}</span>`;
    if (r.startsWith('tag:')) return `<span class="ref-badge tag">${esc(r)}</span>`;
    return `<span class="ref-badge branch">${esc(r)}</span>`;
  }).join('');
}

export function renderDiff(diff) {
  return diff.split('\n').map(line => {
    const h = esc(line);
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ')) {
      return `<span class="diff-header">${h}</span>`;
    }
    if (line.startsWith('@@')) return `<span class="diff-hunk">${h}</span>`;
    if (line.startsWith('+')) return `<span class="diff-add">${h}</span>`;
    if (line.startsWith('-')) return `<span class="diff-del">${h}</span>`;
    return h;
  }).join('\n');
}

/** Check if an audit event is a webhook event. */
export function isWebhook(ev) { return ev.hookType === 'transform_webhook_content'; }

/** Get original/modified text from audit event. */
export function auditOriginal(ev) { return ev.originalHead || ''; }
export function auditModified(ev) { return ev.modifiedHead || ''; }

/** Render webhook metadata block (source, job, payload path, template, schema field trust breakdown). */
export function renderWebhookMeta(ev) {
  if (!isWebhook(ev)) return '';
  let html = '<div style="margin-top:6px;font-size:12px;">';
  if (ev.source) html += `<span style="color:var(--fg3)">Source:</span> <b>${esc(ev.source)}</b> `;
  if (ev.jobName) html += `<span style="color:var(--fg3)">Job:</span> <b>${esc(ev.jobName)}</b> `;
  if (ev.jobId) html += `<span style="color:var(--fg3)">ID:</span> <code style="font-size:11px">${esc(ev.jobId)}</code> `;
  if (ev.payloadPath) html += `<span style="color:var(--fg3)">Path:</span> <code style="font-size:11px">${esc(ev.payloadPath)}</code>`;
  html += '</div>';
  // Template string (if template+data payload)
  if (ev.template) {
    html += `<details style="margin-top:4px;" open><summary style="font-size:11px;color:var(--fg3);cursor:pointer;">Template</summary>
      <pre style="font-size:11px;margin:4px 0;padding:6px 8px;background:var(--bg);border:1px solid var(--border);border-radius:3px;white-space:pre-wrap;">${esc(ev.template)}</pre>
    </details>`;
  }
  // Schema field trust badges
  const schema = ev.webhookSchema;
  const fields = ev.schemaFields;
  if (schema && typeof schema === 'object') {
    html += '<div style="margin-top:4px;display:flex;flex-wrap:wrap;gap:4px;">';
    for (const [field, trust] of Object.entries(schema)) {
      const cls = String(trust).toLowerCase() === 'trusted' ? 'trusted' : 'untrusted';
      html += `<span class="trust-badge ${cls}" style="font-size:10px;">${esc(field)}</span>`;
    }
    html += '</div>';
  } else if (Array.isArray(fields) && fields.length > 0) {
    html += `<div style="margin-top:4px;font-size:11px;color:var(--fg3)">Schema fields: ${fields.map(f => esc(f)).join(', ')}</div>`;
  }
  return html;
}

export function getUserApproval(ev) {
  const approval = ev && typeof ev.userApproval === 'object' && !Array.isArray(ev.userApproval)
    ? ev.userApproval
    : null;
  return approval;
}

export function renderUserApprovalBadge(ev) {
  const approval = getUserApproval(ev);
  const status = typeof approval?.status === 'string' ? approval.status : '';
  if (!status) return '';
  const cls = status === 'human_approved' ? 'trusted' : 'untrusted';
  return `<span class="trust-badge ${cls}" title="User approval status">${esc(status)}</span>`;
}

export function renderUserApprovalDetails(ev) {
  const approval = getUserApproval(ev);
  const status = typeof approval?.status === 'string' ? approval.status : '';
  if (!status) return '';

  const meta = [];
  if (approval.interactive === false) meta.push('non-interactive');
  if (approval.assumed === true) meta.push('assumed');
  if (typeof approval.note === 'string' && approval.note) meta.push(approval.note);

  return `<div style="background:color-mix(in srgb, var(--green) 10%, var(--bg));border:1px solid var(--green);border-radius:4px;padding:6px 10px;margin:6px 0;font-size:12px;">
    <span style="font-weight:600;color:var(--green)">Human approval:</span>
    <span class="trust-badge trusted">${esc(status)}</span>
    ${meta.length > 0 ? `<div style="margin-top:4px;font-size:11px;color:var(--fg3)">${meta.map(esc).join(' &middot; ')}</div>` : ''}
  </div>`;
}

export function renderAuditJsonBlock(ev) {
  let body = '';
  try {
    body = JSON.stringify(ev ?? {}, null, 2);
  } catch {
    body = String(ev);
  }
  return `<details class="jt-raw-toggle" style="margin-top:6px">
    <summary>Raw audit JSON</summary>
    <pre class="conv-pre" style="margin-top:4px">${escSym(body)}</pre>
  </details>`;
}

export function isUntrustedCommandExecutionPattern(ev) {
  return (ev?.taintAction || '') === 'untrusted_command_execution_pattern';
}

function originalCommandFromAudit(ev) {
  const original = auditOriginal(ev);
  if (!original) return '';
  try {
    const parsed = JSON.parse(original);
    if (typeof parsed?.command === 'string') return parsed.command;
  } catch {}
  return original;
}

function uniqueList(values) {
  return [...new Set((values || []).filter(v => typeof v === 'string' && v.length > 0))];
}

function commandPatternRows(ev) {
  if (Array.isArray(ev?.matches) && ev.matches.length > 0) {
    return ev.matches.map(match => ({
      pattern: typeof match?.patternId === 'string' ? match.patternId : '',
      evidence: typeof match?.evidence === 'string' ? match.evidence : '',
      symbols: uniqueList(Array.isArray(match?.symbols) ? match.symbols : []),
    })).filter(row => row.pattern || row.evidence || row.symbols.length > 0);
  }
  return uniqueList(Array.isArray(ev?.patterns) ? ev.patterns : [])
    .map(pattern => ({ pattern, evidence: '', symbols: [] }));
}

function renderCommandDetailRow(label, value, opts = {}) {
  if (!value) return '';
  const valueHtml = opts.code === false
    ? `<span>${escSym(value)}</span>`
    : `<code class="uce-code">${escSym(value)}</code>`;
  return `<div class="uce-row"><div class="uce-label">${esc(label)}</div><div class="uce-value">${valueHtml}</div></div>`;
}

export function renderUntrustedCommandExecutionDetails(ev) {
  if (!isUntrustedCommandExecutionPattern(ev)) return '';

  const script = ev.scriptFileExecution && typeof ev.scriptFileExecution === 'object'
    ? ev.scriptFileExecution
    : null;
  const originalCommand = originalCommandFromAudit(ev);
  const expandedCommand =
    (typeof script?.normalizedCommandHead === 'string' && script.normalizedCommandHead) ||
    (typeof ev.normalizedCommandHead === 'string' && ev.normalizedCommandHead) ||
    (typeof ev.expandedCommandHead === 'string' && ev.expandedCommandHead) ||
    (typeof ev.expandedCommand === 'string' && ev.expandedCommand) ||
    '';
  const source = typeof ev.commandAnalysisSource === 'string' ? ev.commandAnalysisSource : 'command';
  const rows = commandPatternRows(ev);

  let html = `<div class="uce-detail">
    <div class="uce-title">Untrusted command execution pattern</div>`;
  html += renderCommandDetailRow('Source', source, { code: false });
  if (script?.ruleId) html += renderCommandDetailRow('Expansion rule', String(script.ruleId), { code: false });
  if (script?.scriptPath) html += renderCommandDetailRow('Script path', String(script.scriptPath));
  if (script?.trustedScriptPath) html += renderCommandDetailRow('Trusted script', String(script.trustedScriptPath));
  if (script?.runner || script?.inlineRunner || script?.inlineFlag || script?.contentBytes != null) {
    const runnerParts = [];
    if (script.runner) runnerParts.push(`runner=${script.runner}`);
    if (script.inlineRunner) runnerParts.push(`inline=${script.inlineRunner}`);
    if (script.inlineFlag) runnerParts.push(`flag=${script.inlineFlag}`);
    if (script.contentBytes != null) runnerParts.push(`bytes=${script.contentBytes}`);
    html += renderCommandDetailRow('Expansion meta', runnerParts.join('  '), { code: false });
  }
  html += renderCommandDetailRow('Original command', originalCommand);
  if (expandedCommand) {
    html += renderCommandDetailRow(source === 'script_file' ? 'Expanded command' : 'Normalized command', expandedCommand);
  }
  if (rows.length > 0) {
    html += `<div class="uce-patterns">
      <div class="uce-label">Matched patterns</div>
      <table class="uce-pattern-table"><thead><tr><th>Pattern</th><th>Evidence</th><th>Symbols</th></tr></thead><tbody>`;
    for (const row of rows) {
      html += `<tr>
        <td><code>${esc(row.pattern)}</code></td>
        <td>${row.evidence ? `<code>${escSym(row.evidence)}</code>` : ''}</td>
        <td>${row.symbols.map(sym => `<span class="sym-marker">${esc(sym)}</span>`).join(' ')}</td>
      </tr>`;
    }
    html += '</tbody></table></div>';
  }
  html += '</div>';
  return html;
}

function parseJsonMaybe(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function findSymbolPath(node, symName) {
  if (typeof node === 'string') return node.includes(symName) ? [] : null;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const child = findSymbolPath(node[i], symName);
      if (child) return [i, ...child];
    }
    return null;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      const child = findSymbolPath(value, symName);
      if (child) return [key, ...child];
    }
  }
  return null;
}

function valueAtPath(node, path) {
  let cur = node;
  for (const key of path || []) {
    if (cur == null) return undefined;
    cur = cur[key];
  }
  return cur;
}

function stringifySymbolValue(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function fullSymbolValueFromEvent(ev, symName) {
  const original = parseJsonMaybe(ev?.originalHead);
  const modified = parseJsonMaybe(ev?.modifiedHead);
  if (!original || !modified) return null;
  const path = findSymbolPath(modified, symName);
  if (!path) return null;
  return stringifySymbolValue(valueAtPath(original, path));
}

/** Extract symbols from an audit event. */
export function getSymbolsFromEvent(ev, opts = {}) {
  if (ev.symbolsCreated && ev.symbolsCreated.length > 0) {
    if (!opts.fullValues) return ev.symbolsCreated;
    return ev.symbolsCreated.map(sym => {
      const fullValue = fullSymbolValueFromEvent(ev, sym.name);
      return fullValue == null ? sym : { ...sym, value: fullValue };
    });
  }
  const modText = auditModified(ev);
  if ((ev.taintAction || '').includes('symbolize') && modText) {
    const re = /\$_DUALVIEW_SYM_[a-zA-Z_]\w*\[\w+\](?:\.[a-zA-Z_][\w[\].]*)?/g;
    const names = [...new Set(modText.match(re) || [])];
    return names.map(name => {
      const dotIdx = name.indexOf('.', name.indexOf(']'));
      return { name, field: dotIdx > 0 ? name.slice(dotIdx + 1) : null, value: null };
    });
  }
  return [];
}

export function renderAuditHeadBlock(label, text) {
  const split = splitPrefixJson(text);

  let html = `<div style="margin-top:6px"><b>${esc(label)}:</b>`;
  if (split) {
    if (split.prefix) {
      html += `<div style="font-size:11px;color:var(--fg2);margin:2px 0">${escSym(split.prefix)}</div>`;
    }
    html += `<div class="json-tree">${renderJsonTree(split.parsed, undefined, 0)}</div>`;
    html += `<details class="jt-raw-toggle" style="margin-top:4px"><summary>Raw text</summary>
      <pre class="conv-pre" style="margin-top:4px">${escSym(text)}</pre>
    </details>`;
  } else {
    html += `<pre class="conv-pre">${escSym(text)}</pre>`;
  }
  html += '</div>';
  return html;
}

function inspectToolTraceRows(ev) {
  if (!Array.isArray(ev?.toolTrace)) return [];
  return ev.toolTrace
    .map((trace, idx) => {
      const request = trace && typeof trace === 'object' ? trace.request : null;
      const result = trace && typeof trace === 'object' ? trace.result : null;
      const tool = typeof request?.tool === 'string'
        ? request.tool
        : typeof result?.tool === 'string'
          ? result.tool
          : `tool ${idx + 1}`;
      return { idx, tool, request: request || {}, result: result || {} };
    })
    .filter(row => row.tool || Object.keys(row.request).length > 0 || Object.keys(row.result).length > 0);
}

export function inspectToolTraceSummary(ev) {
  return inspectToolTraceRows(ev).map(row => row.tool);
}

export function renderInspectToolTrace(ev) {
  const rows = inspectToolTraceRows(ev);
  if (rows.length === 0) return '';

  let html = `<div class="inspect-tool-trace">
    <div class="inspect-tool-trace-title">ULLM Internal Helpers</div>`;
  for (const row of rows) {
    const ok = row.result && row.result.ok === true;
    const failed = row.result && row.result.ok === false;
    const status = ok ? 'ok' : failed ? 'error' : 'result';
    const statusCls = ok ? 'trusted' : failed ? 'untrusted' : '';
    const requestJson = JSON.stringify(row.request, null, 2);
    const resultJson = JSON.stringify(row.result, null, 2);
    const resultPreview = failed && row.result?.error_code
      ? String(row.result.error_code)
      : ok
        ? 'ok'
        : 'result';
    html += `<details class="inspect-tool-call" open>
      <summary>
        <span class="inspect-tool-name">${esc(row.tool)}</span>
        <span class="trust-badge ${statusCls}">${esc(resultPreview || status)}</span>
      </summary>
      <div class="inspect-tool-grid">
        <div>
          <div class="inspect-tool-label">Request</div>
          <div class="json-tree">${renderJsonTree(row.request, undefined, 0)}</div>
          <details class="jt-raw-toggle" style="margin-top:4px"><summary>Raw request JSON</summary>
            <pre class="conv-pre" style="margin-top:4px">${escSym(requestJson)}</pre>
          </details>
        </div>
        <div>
          <div class="inspect-tool-label">Result</div>
          <div class="json-tree">${renderJsonTree(row.result, undefined, 0)}</div>
          <details class="jt-raw-toggle" style="margin-top:4px"><summary>Raw result JSON</summary>
            <pre class="conv-pre" style="margin-top:4px">${escSym(resultJson)}</pre>
          </details>
        </div>
      </div>
    </details>`;
  }
  html += '</div>';
  return html;
}

export function renderAuditInline(ev) {
  const actionClass = (ev.taintAction || '') === 'attack_detected' ? 'action-error'
    : (ev.taintAction || '') === 'attack' ? 'action-error'
    : (ev.taintAction || '') === 'attack_blocked' ? 'action-label'
    : (ev.taintAction || '').includes('not_attack') ? 'action-label'
    : (ev.taintAction || '') === 'no_attack' ? 'action-label'
    : (ev.taintAction || '').includes('guardrail_block') ? 'action-error'
    : (ev.taintAction || '').includes('guardrail_warn') ? 'action-error'
    : (ev.taintAction || '').includes('guardrail_allow') ? 'action-label'
    : (ev.taintAction || '').includes('error') ? 'action-error'
    : (ev.taintAction || '').includes('symbolize') ? 'action-symbolize'
    : (ev.taintAction || '').includes('resolve') ? 'action-resolve'
    : (ev.taintAction || '').includes('remask') ? 'action-resolve'
    : (ev.taintAction || '').includes('label') ? 'action-label'
    : 'action-default';
  const trustCls = (ev.trust || '').toLowerCase();
  const trustBadge = ev.trust ? `<span class="trust-badge ${trustCls}">${esc(ev.trust)}</span>` : '';
  const approvalBadge = renderUserApprovalBadge(ev);
  const hasContent = auditOriginal(ev) || auditModified(ev);
  const lenInfo = hasContent ? ` ${ev.originalLen||0}→${ev.modifiedLen||0}b` : '';
  const callId = ev.toolCallId ? ` <span class="conv-call-id" title="${esc(ev.toolCallId)}">${esc(ev.toolCallId.slice(-8))}</span>` : '';

  let html = `<details class="conv-entry"><summary class="conv-hook">
    <span class="conv-hook-type">${esc(ev.hookType)}</span>
    <span class="conv-hook-action ${actionClass}">${esc(ev.taintAction)}</span>
    ${trustBadge}
    ${approvalBadge}
    <span style="font-size:11px;color:var(--fg3)">${isWebhook(ev) ? `job=${esc(ev.jobName || '')}` : `tool=${esc(ev.toolName)}`}${lenInfo}</span>${callId}
  </summary><div class="conv-body">`;

  const origText = auditOriginal(ev);
  const modText = auditModified(ev);
  if (origText) {
    html += renderAuditHeadBlock('Before', origText);
  }
  if (modText) {
    html += renderAuditHeadBlock('After', modText);
  }
  html += renderUntrustedCommandExecutionDetails(ev);
  html += renderWebhookMeta(ev);
  html += renderUserApprovalDetails(ev);
  if (ev.oracle && ev.hookType === 'security_oracle_verdict') {
    // Final verdict entry: attack_detected / attack_blocked / no_attack
    const isSuccess = ev.taintAction === 'attack_detected';
    const isBlocked = ev.taintAction === 'attack_blocked';
    const color = isSuccess ? 'var(--red)' : isBlocked ? 'var(--green)' : 'var(--fg3)';
    const label = isSuccess ? 'ATTACK SUCCESS' : isBlocked ? 'ATTACK BLOCKED' : 'NO ATTACK';
    html += `<div style="background:color-mix(in srgb, ${color} 10%, var(--bg));border:1px solid ${color};border-radius:4px;padding:8px 12px;margin:6px 0;font-size:12px;">`;
    html += `<span style="font-weight:600;color:${color}">${label}</span>`;
    if (ev.injectionTaskId) html += ` <span style="color:var(--fg3)">${esc(ev.injectionTaskId)}</span>`;
    if (ev.details) html += `<div style="margin-top:4px;font-size:11px;color:var(--fg2)">${esc(ev.details)}</div>`;
    html += `</div>`;
  } else if (ev.oracle) {
    // Per-tool-call entry: attack_detected / attack_blocked / not_attack
    const isDetected = ev.taintAction === 'attack_detected';
    const isBlocked = ev.taintAction === 'attack_blocked';
    const isAttack = isDetected || isBlocked;
    const color = isDetected ? 'var(--red)' : isBlocked ? 'var(--green)' : 'var(--fg3)';
    const label = isDetected ? 'ATTACK DETECTED' : isBlocked ? 'ATTACK BLOCKED' : 'NOT ATTACK';
    html += `<div style="background:color-mix(in srgb, ${color} 10%, var(--bg));border:1px solid ${color};border-radius:4px;padding:8px 12px;margin:6px 0;font-size:12px;">`;
    html += `<span style="font-weight:600;color:${color}">${label}</span>`;
    if (ev.injectionTaskId) html += ` <span style="color:var(--fg3)">${esc(ev.injectionTaskId)}</span>`;
    if (Array.isArray(ev.checkPatterns) && ev.checkPatterns.length > 0) {
      html += `<div style="margin-top:4px;font-size:11px;color:var(--fg2)">Check: ${ev.checkPatterns.map(p => `<code>${esc(p)}</code>`).join(', ')}</div>`;
    }
    if (isAttack && ev.pattern && ev.toolCall) {
      html += `<div style="margin-top:4px;font-size:11px">Match: <code style="color:${color}">${esc(ev.pattern)}</code> &rarr; <span style="color:var(--fg2)">${esc(ev.toolCall)}</span></div>`;
    }
    html += `</div>`;
  }
  if (ev.guardrail) {
    html += `<div style="background:color-mix(in srgb, var(--orange) 10%, var(--bg));border:1px solid var(--orange);border-radius:4px;padding:6px 10px;margin:6px 0;font-size:12px;">`;
    html += `<span style="font-weight:600;color:var(--orange)">Guardrail:</span> ${esc(ev.guardrail)}`;
    if (ev.label) html += ` &middot; label=${esc(ev.label)}`;
    if (ev.decision) html += ` &middot; decision=${esc(ev.decision)}`;
    if (ev.score != null) html += ` &middot; score=${Number(ev.score).toFixed(4)}`;
    if (ev.mock) html += ` <span style="color:var(--fg3)">(mock)</span>`;
    if (ev.reason && ev.reason !== `mock=${ev.mock ? 'deny' : 'allow'}`) html += `<div style="margin-top:4px;font-size:11px;color:var(--fg3)">Reason: ${esc(ev.reason)}</div>`;
    html += `</div>`;
  }
  const syms = getSymbolsFromEvent(ev);
  if (syms.length > 0) {
    const newNames = new Set(syms.map(s => s.name));
    for (const s of syms) {
      if (!S.cumulativeSymbols.some(c => c.name === s.name)) {
        S.cumulativeSymbols.push(s);
      }
      if (s.value) S.symValueMap[s.name] = s.value;
    }
    const hasValue = S.cumulativeSymbols.some(s => s.value);
    html += `<div class="sym-table-update">
      <div style="font-size:11px;font-weight:600;color:var(--orange);margin-bottom:4px;">Symbol Table (${S.cumulativeSymbols.length} total, +${syms.length} new)</div>
      <table class="sym-table"><thead><tr><th>Symbol</th>${hasValue ? '<th>Value</th>' : ''}</tr></thead><tbody>`;
    for (const s of S.cumulativeSymbols) {
      const isNew = newNames.has(s.name);
      html += `<tr${isNew ? ' class="sym-new"' : ''}>
        <td><span class="sym-marker">${esc(s.name)}</span></td>
        ${hasValue ? (s.value ? `<td class="sym-value-cell" onclick="showSymValue(this, '${esc(s.name).replace(/'/g, "\\'")}', this.dataset.val)" data-val="${esc(s.value)}">${esc(s.value)}</td>` : '<td class="sym-value-cell" style="cursor:default;text-decoration:none;">—</td>') : ''}
      </tr>`;
    }
    html += '</tbody></table></div>';
  }
  if (ev.hookType === 'inspect_symbol') {
    if (ev.error) {
      html += `<div style="background:color-mix(in srgb, var(--red) 10%, var(--bg));border:1px solid var(--red);border-radius:4px;padding:8px 12px;margin:6px 0;font-family:monospace;font-size:12px;white-space:pre-wrap;color:var(--red);">${esc(ev.error)}</div>`;
      if (ev.exitCode != null) {
        html += `<div style="font-size:11px;color:var(--fg3);margin-top:2px;">Exit code: ${esc(String(ev.exitCode))}</div>`;
      }
    }
    html += renderInspectToolTrace(ev);
    if (ev.ullmPrompt) {
      html += renderAuditHeadBlock('ULLM Prompt (' + esc(ev.model || '') + ')', ev.ullmPrompt);
    }
    if (ev.ullmResponse) {
      html += renderAuditHeadBlock('ULLM Response', ev.ullmResponse);
    }
  }
  if (ev.origin) {
    html += `<div style="font-size:11px;color:var(--fg3);margin-top:4px;">Origin: ${esc(ev.origin)}</div>`;
  }
  html += renderAuditJsonBlock(ev);
  html += '</div></details>';
  return html;
}

export function renderNotifyInline(n) {
  const preview = stripTs((n.text || '')).slice(0, 80);
  return `<details class="conv-entry"><summary class="conv-notify">
    <span class="conv-notify-header" style="display:inline">Notify</span> ${esc(preview)}${n.text?.length > 80 ? '...' : ''}
  </summary><div class="conv-body"><pre class="conv-pre">${escSym(n.text)}</pre></div></details>`;
}
