import S, { DASHBOARD_TZ } from './state.js';

export function esc(s) {
  if (typeof s !== 'string') s = String(s ?? '');
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/** Highlight DUALVIEW-injected lines in a system prompt (input is already escaped). */
export function highlightAdfiSystemLines(escapedText) {
  const dualviewPatterns = /\$_DUALVIEW_SYM_|DualView_UNTRUSTED|DUALVIEW-TRUSTED|DUALVIEW-UNTRUSTED|inspect_symbol|symbol_table|symbol.*table|dualview/i;
  return escapedText.split('\n').map(line => {
    if (dualviewPatterns.test(line)) {
      return `<span class="dualview-sys-line">${line}</span>`;
    }
    return line;
  }).join('\n');
}

/** Map tool name to a small icon for the outline sidebar. */
export function toolIcon(name) {
  const n = (name || '').toLowerCase();
  if (n.includes('web_fetch') || n.includes('webfetch')) return '🌐';
  if (n.includes('inspect')) return '🔍';
  if (n.includes('exec (trusted)')) return '🔒';
  if (n.includes('exec') || n.includes('bash') || n.includes('shell')) return '⚡';
  if (n.includes('read')) return '📖';
  if (n.includes('write') || n.includes('edit')) return '✏️';
  if (n.includes('grep') || n.includes('search')) return '🔎';
  if (n.includes('glob') || n.includes('find')) return '📂';
  if (n.includes('git')) return '🔀';
  if (n.includes('agent')) return '🤖';
  if (n.includes('todo')) return '☑️';
  return '🔧';
}

/** Escape HTML then highlight DUALVIEW symbol markers and inline taint markers. */
export function escSym(s) {
  let h = esc(s);
  h = h.replace(/(\$_DUALVIEW_SYM_\w+\[\w+\](?:\.\w+)+)/g, (_, sym) => {
    const val = S.symValueMap[sym];
    const title = val ? ` title="${esc(val.length > 200 ? val.slice(0, 197) + '...' : val)}"` : '';
    return `<span class="sym-marker"${title}>${sym}</span>`;
  });
  h = h.replace(/(\$_DUALVIEW_SYM_\w+\[\w+\])(?!\.)/g, '<span class="sym-marker">$1</span>');
  h = h.replace(/(&lt;&lt;&lt;DualView_UNTRUSTED[^&]*&gt;&gt;&gt;)/g, '<span class="sym-inline-marker">$1</span>');
  h = h.replace(/(&lt;&lt;&lt;END_DualView_UNTRUSTED[^&]*&gt;&gt;&gt;)/g, '<span class="sym-inline-marker">$1</span>');
  h = h.replace(/(&lt;&lt;&lt;EXTERNAL_UNTRUSTED_CONTENT[^&]*&gt;&gt;&gt;)/g, '<span class="sym-inline-marker">$1</span>');
  h = h.replace(/(&lt;&lt;&lt;END_EXTERNAL_UNTRUSTED_CONTENT[^&]*&gt;&gt;&gt;)/g, '<span class="sym-inline-marker">$1</span>');
  return h;
}

/** Replace all $_DUALVIEW_SYM_* tokens with their resolved values (plain text, no HTML). */
export function resolveSymbols(text) {
  return text.replace(/\$_DUALVIEW_SYM_\w+\[\w+\](?:\.\w+)*/g, sym => S.symValueMap[sym] || sym);
}

/** Check if text contains any resolvable symbols. */
export function hasResolvableSymbols(text) {
  const re = /\$_DUALVIEW_SYM_\w+\[\w+\](?:\.\w+)+/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (S.symValueMap[m[0]]) return true;
  }
  return false;
}

/** Return usable concrete workspace IDs. Test wsIds are used only when they
 *  correspond to a real workspace directory, except for legacy metadata with
 *  no concrete workspace list. Sort order: canonical wsIds by test name, with
 *  each test's retry attempts grouped after it. */
export function usableWsIds(session) {
  const concreteIds = new Set(session.workspaceIds || []);
  const idSet = new Set(concreteIds);
  const allowTestOnlyIds = concreteIds.size === 0;
  if (session.tests) {
    for (const t of session.tests) {
      if (t.wsId && (allowTestOnlyIds || concreteIds.has(t.wsId))) idSet.add(t.wsId);
    }
  }
  const ids = [...idSet];
  const filtered = ids.length > 1 ? ids.filter(id => id !== '00') : ids;

  // Build parent map: attempt dir -> parent wsId (e.g., "01-a1" -> "01")
  const attemptRe = /^(\d{2})-a(\d+)$/;
  const parentOf = {};
  const attemptNum = {};
  for (const id of filtered) {
    const m = attemptRe.exec(id);
    if (m) {
      parentOf[id] = m[1];
      attemptNum[id] = parseInt(m[2], 10);
    }
  }

  // Sort canonical wsIds by test name, then insert attempt dirs after their parent
  const nameMap = {};
  if (session.tests) {
    for (const t of session.tests) {
      if (t.wsId) nameMap[t.wsId] = t.name;
    }
  }
  const canonical = filtered.filter(id => !parentOf[id]);
  canonical.sort((a, b) => (nameMap[a] || a).localeCompare(nameMap[b] || b));

  const result = [];
  for (const ws of canonical) {
    result.push(ws);
    // Append this ws's attempt dirs sorted by attempt number
    const children = filtered.filter(id => parentOf[id] === ws);
    children.sort((a, b) => (attemptNum[a] || 0) - (attemptNum[b] || 0));
    result.push(...children);
  }
  // Append any orphan attempt dirs (parent not in canonical)
  for (const id of filtered) {
    if (parentOf[id] && !result.includes(id)) result.push(id);
  }
  return result;
}

/** Strip leading timestamps from preview text. */
export function stripTs(s) {
  return s.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z?\s*/, '').replace(/^\[(?:[A-Za-z]{3} )?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}[^\]]*\]\s*/, '');
}

/** Convert an ISO timestamp string to local time display. */
export function localTime(iso, fmt) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  if (fmt === 'date') {
    return d.toLocaleDateString('sv-SE', { timeZone: DASHBOARD_TZ });
  }
  const opts = { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: DASHBOARD_TZ };
  if (fmt === 'HH:mm:ss' || fmt === 'HH:mm:ss.SSS') {
    opts.second = '2-digit';
  }
  let result = d.toLocaleTimeString('en-GB', opts);
  if (fmt === 'HH:mm:ss.SSS') {
    const ms = String(d.getMilliseconds()).padStart(3, '0');
    result += '.' + ms;
  }
  return result;
}

/** Try to pretty-print a string as JSON; return original if not valid JSON. */
export function tryPrettyJson(s) {
  try {
    const obj = JSON.parse(s);
    return JSON.stringify(obj, null, 2);
  } catch {
    return s;
  }
}

/**
 * Try to extract a prefix line and JSON body from text.
 * Returns { prefix, parsed, raw } or null if no JSON found.
 */
export function splitPrefixJson(text) {
  let prefix = '', parsed = null;
  const nlJsonMatch = text.match(/^(.*?)\n(\s*[{\[])/s);
  if (nlJsonMatch) {
    const candidate = text.slice(nlJsonMatch[1].length + 1);
    try { parsed = JSON.parse(candidate); prefix = nlJsonMatch[1]; } catch {}
  }
  if (!parsed) {
    try { parsed = JSON.parse(text); prefix = ''; } catch {}
  }
  if (!parsed) {
    for (let i = 1; i < text.length; i++) {
      if (text[i] === '{' || text[i] === '[') {
        try {
          parsed = JSON.parse(text.slice(i));
          prefix = text.slice(0, i).trim();
          break;
        } catch {}
      }
    }
  }
  if (parsed && typeof parsed === 'object') return { prefix, parsed };
  return null;
}

export function fmtUptime(s) {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return (d ? d + 'd ' : '') + (h ? h + 'h ' : '') + m + 'm';
}

/** Format seconds as compact elapsed: "42s", "3m12s", "1h5m". */
export function fmtElapsed(sec) {
  if (sec < 60) return sec + 's';
  const m = Math.floor(sec / 60), s = sec % 60;
  if (m < 60) return s ? m + 'm' + s + 's' : m + 'm';
  const h = Math.floor(m / 60), rm = m % 60;
  return rm ? h + 'h' + rm + 'm' : h + 'h';
}

/** Resolve a raw test ID like "UT-01×symbolize" to "UT-01 Fetch webpage and save summary". */
export function friendlyTestName(rawName) {
  const sep = rawName.indexOf('\u00d7'); // × separator
  const testId = sep > 0 ? rawName.slice(0, sep) : rawName;
  const friendly = S.testNames?.[testId];
  // Always strip the ×mode suffix; show friendly name when available
  return friendly ? `${testId} ${friendly}` : testId;
}

/** Build wsId → friendly test name map from current session's tests. */
export function wsTestNameMap() {
  const map = {};
  if (S.currentSession?.tests) {
    for (const t of S.currentSession.tests) {
      if (t.wsId) map[t.wsId] = friendlyTestName(t.name);
      // Map retry attempt dirs to "TestName (attempt N)" for dropdown labels
      if (t.retryAttempts) {
        for (const ra of t.retryAttempts) {
          const attemptNum = ra.dir.split('-a')[1];
          map[ra.dir] = `${friendlyTestName(t.name)} (attempt ${attemptNum})`;
        }
      }
    }
  }
  // Fallback: use wsMap from meta.json for running sessions with unresolved wsIds
  const wsMap = S.currentSession?.wsMap;
  if (wsMap) {
    for (const [wsId, rawName] of Object.entries(wsMap)) {
      if (!map[wsId]) map[wsId] = friendlyTestName(rawName);
    }
  }
  return map;
}

/** Render a workspace selector dropdown with test names. */
export function renderWsSelector(wsIds, onchangeExpr, opts = {}) {
  const nameMap = wsTestNameMap();
  const selected = opts.selected ?? S.currentWsId;
  let html = `<div class="ws-selector"><label>Test:</label><select onchange="${onchangeExpr}">`;
  if (opts.includeAll) {
    html += `<option value="all" ${selected === 'all' ? 'selected' : ''}>All tests</option>`;
  }
  for (const ws of wsIds) {
    const label = nameMap[ws] ? `${ws}: ${nameMap[ws]}` : `Workspace ${ws}`;
    html += `<option value="${ws}" ${ws === selected ? 'selected' : ''}>${esc(label)}</option>`;
  }
  html += '</select></div>';
  return html;
}

export function copyText(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    const orig = btn.textContent;
    btn.textContent = 'copied!';
    setTimeout(() => btn.textContent = orig, 1200);
  });
}

export function copyFileContent(btn) {
  const el = document.getElementById('file-content');
  if (!el) return;
  copyText(el.textContent, btn);
}

/** Syntax-highlight YAML source (returns HTML). Input is raw, unescaped YAML. */
export function highlightYaml(raw) {
  return raw.split('\n').map(line => {
    // Comments
    if (/^\s*#/.test(line)) return `<span class="ym-comment">${esc(line)}</span>`;
    // Key: value lines
    const kv = line.match(/^(\s*)([\w][\w.\-]*)(:)(.*)/);
    if (kv) {
      const [, indent, key, colon, rest] = kv;
      return esc(indent) + `<span class="ym-key">${esc(key)}</span><span class="ym-colon">${esc(colon)}</span>` + highlightYamlValue(rest);
    }
    // List item "- key: val" or "- val"
    const li = line.match(/^(\s*)(- )(.*)/);
    if (li) {
      const [, indent, dash, rest] = li;
      const liKv = rest.match(/^([\w][\w.\-]*)(:)(.*)/);
      if (liKv) {
        return esc(indent) + `<span class="ym-dash">${esc(dash)}</span><span class="ym-key">${esc(liKv[1])}</span><span class="ym-colon">${esc(liKv[2])}</span>` + highlightYamlValue(liKv[3]);
      }
      return esc(indent) + `<span class="ym-dash">${esc(dash)}</span>` + highlightYamlValue(rest);
    }
    return esc(line);
  }).join('\n');
}

function highlightYamlValue(raw) {
  if (!raw || !raw.trim()) return esc(raw);
  const trimmed = raw.trim();
  const leading = raw.slice(0, raw.length - raw.trimStart().length);
  // Inline comment
  const commentIdx = trimmed.indexOf(' #');
  let val = trimmed, comment = '';
  if (commentIdx > 0) { val = trimmed.slice(0, commentIdx); comment = trimmed.slice(commentIdx); }
  let valHtml;
  if (/^".*"$/.test(val) || /^'.*'$/.test(val)) valHtml = `<span class="ym-string">${esc(val)}</span>`;
  else if (/^(true|false|yes|no|on|off)$/i.test(val)) valHtml = `<span class="ym-bool">${esc(val)}</span>`;
  else if (/^-?\d+(\.\d+)?$/.test(val) || val === '.inf' || val === '-.inf' || val === '.nan') valHtml = `<span class="ym-number">${esc(val)}</span>`;
  else if (/^(null|~)$/i.test(val)) valHtml = `<span class="ym-null">${esc(val)}</span>`;
  else if (/^[|>]/.test(val)) valHtml = `<span class="ym-block">${esc(val)}</span>`;
  else valHtml = `<span class="ym-string">${esc(val)}</span>`;
  const commentHtml = comment ? `<span class="ym-comment">${esc(comment)}</span>` : '';
  return esc(leading) + ' ' + valHtml + commentHtml;
}
