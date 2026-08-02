// ── main.js — App entry point, event wiring, and window-exposed handlers ──
import S, { api, DASHBOARD_MODE, DASHBOARD_MODES } from './state.js';
import { esc, localTime, usableWsIds, renderWsSelector, copyText, copyFileContent, fmtUptime, fmtElapsed, wsTestNameMap, friendlyTestName } from './utils.js';
import { renderConversation, scrollHighlight, showArgPopup, hideArgPopup, showSymValue, showBotSymbolDetails, showBotEventDetails, openBotEventLink, toggleBotRawMode, syncBotSubsession, toggleBotInspector, selectBotExchange, clearBotExchangeScope, fetchWsData, setupConvScrollTracking } from './conversation.js';
import { renderLog, switchLogWs, renderAudit, switchAuditWs, renderSymbolTable, switchSymbolTableWs, renderGit, selectGitCommit, switchGitWs, renderFilesView, renderBotFileSystem, switchBotFileView, renderFileTree, selectFileInView, loadFilesGitLog, selectFilesGitCommit, showFileVersionInView, updateFilesGitHighlight, renderTestSpec, switchSpecTest, showAssertionPopup, hideAssertionPopup } from './views.js';

// ── Tag helpers ─────────────────────────────────────────────────────────

const TAG_COLORS = {
  // tool tags
  web_fetch: 'blue', web_search: 'blue', exec: 'cyan', exec_sym: 'cyan',
  read: 'green', write: 'green', edit: 'green',
  image: 'orange', memory: 'yellow', sessions: 'yellow',
  inspect_symbol: 'purple', cron: 'pink', subagents: 'pink',
  webhook: 'orange', gws: 'orange',
  // category tags
  error: 'red', stress: 'red',
  'trust-policy': 'purple', 'input-policy': 'purple', 'output-policy': 'purple', 'tool-policy': 'purple',
  'single-tool': 'gray', 'multi-tool': 'cyan', 'multi-turn': 'cyan',
  injection: 'red', git: 'green',
};

function tagColorClass(tag) {
  return 'tag-c-' + (TAG_COLORS[tag] || 'gray');
}

/** Extract test ID (e.g. "UT-01") from a raw name like "UT-01×symbolize". */
function testIdFromName(name) {
  const sep = name.indexOf('\u00d7');
  return sep > 0 ? name.slice(0, sep) : name;
}

/**
 * Parse a security test name into its components.
 * Format: "UT-xx×IT-xx×attack-template×vector×mode"
 */
function parseSecurityTestName(name) {
  const parts = name.split('\u00d7');
  if (parts.length < 4) return null;
  return { ut: parts[0], it: parts[1], attack: parts[2], vector: parts[3], mode: parts[4] || '' };
}

/**
 * Parse the oracle reason string into structured data.
 * Input examples:
 *   "no-defense security: ATTACK_SUCCESS -- Agent executed matching commands: 'git clone' in: call exec({...})"
 *   "no-defense security: ATTACK_BLOCKED -- No commands matching [\"git clone\"] found in transcript"
 */
function parseOracleReason(reason) {
  if (!reason) return null;
  const successMatch = reason.match(/ATTACK_SUCCESS(?:\s*--|:)\s*(.+)/);
  if (successMatch) return { result: 'ATTACK_SUCCESS', detail: successMatch[1] };
  const blockedMatch = reason.match(/ATTACK_BLOCKED(?:\s*--|:)\s*(.+)/);
  if (blockedMatch) return { result: 'ATTACK_BLOCKED', detail: blockedMatch[1] };
  const noAttackMatch = reason.match(/NO_ATTACK(?:\s*--|:)\s*(.+)/);
  if (noAttackMatch) return { result: 'NO_ATTACK', detail: noAttackMatch[1] };
  return null;
}

/** Check if a test item matches the current tag filter. */
function testMatchesTagFilter(name) {
  if (!S.tagFilter) return true;
  const id = testIdFromName(name);
  const tags = S.testTags?.[id];
  return tags && tags.includes(S.tagFilter);
}

/** Render tag filter pill buttons from all available tags. */
function renderTagFilterBar() {
  const bar = document.getElementById('tag-filter-bar');
  if (!bar) return;
  if (!S.showToolTags) { bar.style.display = 'none'; return; }
  bar.style.display = '';
  const allTags = new Set();
  for (const tags of Object.values(S.testTags || {})) {
    for (const t of tags) allTags.add(t);
  }
  if (allTags.size === 0) { bar.innerHTML = ''; return; }
  const sorted = [...allTags].sort();
  let html = `<button class="tag-filter-btn${!S.tagFilter ? ' active' : ''}" data-tag="">all</button>`;
  for (const tag of sorted) {
    html += `<button class="tag-filter-btn ${tagColorClass(tag)}${S.tagFilter === tag ? ' active' : ''}" data-tag="${esc(tag)}">${esc(tag)}</button>`;
  }
  bar.innerHTML = html;
}

/** Render compact tag badges for a test ID. */
function tagBadgesHtml(testId) {
  const tags = S.testTags?.[testId];
  if (!tags || tags.length === 0) return '';
  return tags.map(t => `<span class="tag-badge ${tagColorClass(t)}" data-tag="${esc(t)}" title="${esc(t)}">${esc(t)}</span>`).join('');
}

// ── Tabs ────────────────────────────────────────────────────────────────

const DEFAULT_TABS = [
  ['conversation', 'Conversation'],
  ['files-root', 'Root'],
  ['files-trusted', 'AgentView'],
  ['files-untrusted', 'HumanView'],
  ['log', 'Log'],
  ['audit', 'Audit'],
  ['symbol-table', 'Symbol Table'],
  ['test-spec', 'Test Spec'],
];

const BOT_TABS = [
  ['conversation', 'Session History'],
  ['symbol-table', 'Symbols'],
  ['bot-files', 'File System'],
  ['audit', 'Audit Log'],
];

let allowedDashboardModes = new Set(DASHBOARD_MODES);

function tabsForCurrentMode() {
  return S.mode === 'bot' ? BOT_TABS : DEFAULT_TABS;
}

function normalizeTabForCurrentMode(tab) {
  const requested = tab || 'conversation';
  if (S.mode !== 'bot') return requested;
  if (requested === 'files-root' || requested === 'files-trusted' || requested === 'files-untrusted') return 'bot-files';
  if (requested === 'log' || requested === 'test-spec') return 'conversation';
  return BOT_TABS.some(([key]) => key === requested) ? requested : 'conversation';
}

function renderTabBar() {
  const bar = document.getElementById('tab-bar');
  if (!bar) return;
  const activeTab = normalizeTabForCurrentMode(S.currentTab);
  const tabsHtml = tabsForCurrentMode().map(([key, label]) =>
    `<button class="tab${key === activeTab ? ' active' : ''}" data-tab="${esc(key)}">${esc(label)}</button>`
  ).join('');
  if (S.mode !== 'bot') {
    bar.innerHTML = tabsHtml;
    return;
  }
  const view = S.botHistoryView || 'dual';
  const button = (key, label) =>
    `<button class="bot-view-btn${view === key ? ' active' : ''}" onclick="switchBotHistoryView('${key}')">${label}</button>`;
  const controls = activeTab === 'conversation'
    ? `<div class="bot-tab-controls">
        <div class="bot-view-switch" aria-label="Session History view">
          ${button('dual', 'DualView')}
          ${button('agent', 'AgentView')}
          ${button('human', 'HumanView')}
          ${button('both', 'Both')}
        </div>
        <label class="bot-raw-toggle"><input type="checkbox" ${S.botRawMode ? 'checked' : ''} onchange="toggleBotRawMode(this.checked)"> Raw</label>
      </div>`
    : '';
  bar.innerHTML = `<div class="bot-tab-buttons">${tabsHtml}</div>${controls}`;
}

function renderBotDarkModeToggle() {
  return `<label class="bot-dark-toggle" title="Toggle dark mode">
    <input type="checkbox" ${S.botDarkMode ? 'checked' : ''} onchange="toggleBotDarkMode(this.checked)">
    <span>Light</span>
    <span>Dark</span>
  </label>`;
}

// ── Sidebar ─────────────────────────────────────────────────────────────

function renderSidebar() {
  const list = document.getElementById('session-list');
  const filtered = S.sessions.filter(s => S.filter === 'all' || (S.filter === 'skip' ? s.skipped > 0 : S.filter === s.result.toLowerCase()));

  const groups = {};
  for (const s of filtered) {
    const day = localTime(s.date, 'date');
    if (!groups[day]) groups[day] = [];
    groups[day].push(s);
  }

  let html = '';
  for (const [day, items] of Object.entries(groups)) {
    html += `<div class="date-group"><div class="date-label">${esc(day)}</div>`;
    for (const s of items) {
      const time = localTime(s.date, 'HH:mm');
      const isActive = S.currentSession?.id === s.id;
      const active = isActive ? ' active' : '';
      const isRunning = s.result === 'RUNNING';
      const isInterrupted = s.result === 'INTERRUPTED';
      const done = s.passed + s.failed + s.skipped;
      const totalTests = s.total || s.tests.length || done;
      const isSecurity = s.attackSuccessRate != null;
      const branchBadge = s.gitBranch ? `<span class="mode-badge">${esc(s.gitBranch)}</span>` : '';
      const symFmtBadge = s.symbolFormat ? `<span class="mode-badge" style="color:var(--cyan)">${esc(s.symbolFormat)}</span>` : '';
      const defenseBadge = s.defense ? defenseBadgeHtml(s.defense, false, s.defenseDisplayName) : '';
      const policyBadge = s.openshellPolicy ? `<span class="mode-badge" style="color:var(--purple)">policy: ${esc(s.openshellPolicy)}</span>` : '';
      const elapsedLabel = s.elapsedSec != null ? `<span class="session-elapsed">${fmtElapsed(s.elapsedSec)}</span>` : '';
      let row2Content;
      if (isSecurity) {
        const secTotal = s.attackSuccessCount + s.attackBlockedCount + (s.attackInconclusive || 0);
        const secCountLabel = `${s.attackSuccessCount}/${secTotal}`;
        row2Content = `${elapsedLabel}
          <span class="asr-badge" title="${s.attackSuccessCount} succeeded, ${s.attackBlockedCount} blocked, ${s.attackInconclusive || 0} inconclusive">ASR ${s.attackSuccessRate}%</span>
          <span class="test-count">${secCountLabel}</span>`;
      } else {
        const countLabel = (isRunning || isInterrupted) ? `${done}/${totalTests}` : `${s.passed}/${s.tests.length}`;
        row2Content = `${elapsedLabel}
          <span class="test-count">${countLabel}</span>
          <span class="badge ${s.result.toLowerCase()}">${s.result === 'INTERRUPTED' ? 'STOP' : s.result}</span>`;
      }
      html += `<div class="session-item${active}" data-id="${esc(s.id)}">
        <div class="session-row1">
          <span class="session-time">${esc(time)}</span>
          ${defenseBadge}
          ${policyBadge}
          ${branchBadge}
          ${symFmtBadge}
        </div>
        <div class="session-row2">
          ${row2Content}
        </div>
      </div>`;
      // Expanded test/workspace list: running sessions default to expanded unless explicitly collapsed
      const shouldExpand = S._collapsedSessions.has(s.id) ? false : (isRunning || isActive);
      if (shouldExpand && (s.tests.length > 0 || (isRunning && s.workspaceIds.length > 0))) {
        html += '<div class="session-tests">';
        // Build unified list: completed tests + running workspaces, sorted by name
        const shownWsIds = new Set(s.tests.map(t => t.wsId).filter(Boolean));
        const items = s.tests.map(t => ({ kind: 'test', test: t, wsId: t.wsId, sortName: t.name }));
        if (isRunning) {
          for (const wsId of s.workspaceIds.filter(id => id !== '00' && !shownWsIds.has(id))) {
            const rawName = s.wsMap?.[wsId];
            items.push({ kind: 'running', test: null, wsId, sortName: rawName || `zz-ws:${wsId}` });
          }
        }
        items.sort((a, b) => a.sortName.localeCompare(b.sortName));

        const tagFiltered = S.tagFilter ? items.filter(item => {
          const name = item.kind === 'test' ? item.test.name : (item.test?.name || s.wsMap?.[item.wsId] || '');
          return testMatchesTagFilter(name);
        }) : items;

        for (const item of tagFiltered) {
          if (item.kind === 'test') {
            const t = item.test;
            const wsAttr = t.wsId ? ` data-wsid="${esc(t.wsId)}"` : '';
            const testActive = t.wsId && t.wsId === S.currentWsId && isActive ? ' active' : '';
            const elapsedStr = t.elapsed != null ? `${t.elapsed}s` : '';
            const displayName = friendlyTestName(t.name);
            const tid = testIdFromName(t.name);
            const retryBadge = t.attempt && t.attempt > 1
              ? ` <span class="retry-badge" title="Passed on attempt ${t.attempt} of ${t.maxAttempts}">retry ${t.attempt}/${t.maxAttempts}</span>`
              : '';
            const tagHtml = S.showToolTags ? tagBadgesHtml(tid) : '';
            // Security mode: show attack result instead of PASS/FAIL
            let badgeHtml;
            const oracle = isSecurity ? parseOracleReason(t.reason) : null;
            if (oracle?.result === 'ATTACK_SUCCESS') {
              badgeHtml = '<span class="badge fail" title="Attack succeeded">ATK</span>';
            } else if (oracle?.result === 'ATTACK_BLOCKED') {
              badgeHtml = '<span class="badge pass" title="Attack attempted but blocked">BLK</span>';
            } else if (oracle?.result === 'NO_ATTACK') {
              badgeHtml = '<span class="badge pass" title="Agent did not attempt the attack commands">NOA</span>';
            } else {
              const cls = t.result.toLowerCase();
              badgeHtml = `<span class="badge ${cls}">${t.result[0]}</span>`;
            }
            html += `<div class="session-test-item${testActive}"${wsAttr} data-sessionid="${esc(s.id)}">
              <div class="test-row1">
                ${badgeHtml}
                <span class="session-test-name" title="${esc(displayName)}">${esc(displayName)}</span>
                ${elapsedStr ? `<span style="font-size:9px;color:var(--fg3)">${elapsedStr}</span>` : ''}${retryBadge}
              </div>
              ${tagHtml ? `<div class="test-row2">${tagHtml}</div>` : ''}
            </div>`;
            if (t.retryAttempts && t.retryAttempts.length > 0) {
              html += '<div class="retry-attempts">';
              for (const ra of t.retryAttempts) {
                const attemptNum = ra.dir.split('-a')[1];
                const attemptActive = ra.dir === S.currentWsId && isActive ? ' active' : '';
                const attemptElapsed = ra.elapsed != null ? `${ra.elapsed}s` : '';
                html += `<div class="session-test-item attempt-item${attemptActive}" data-wsid="${esc(ra.dir)}" data-sessionid="${esc(s.id)}">
                  <div class="test-row1">
                    <span class="badge fail">F</span>
                    <span class="session-test-name" title="${esc(displayName)} (attempt ${attemptNum})">${esc(displayName)} #${attemptNum}</span>
                    ${attemptElapsed ? `<span style="font-size:9px;color:var(--fg3)">${attemptElapsed}</span>` : ''}
                  </div>
                </div>`;
              }
              html += '</div>';
            }
          } else {
            const testActive = item.wsId === S.currentWsId && isActive ? ' active' : '';
            const displayName = item.test ? friendlyTestName(item.test.name) : (s.wsMap?.[item.wsId] ? friendlyTestName(s.wsMap[item.wsId]) : `ws:${item.wsId}`);
            html += `<div class="session-test-item${testActive}" data-wsid="${esc(item.wsId)}" data-sessionid="${esc(s.id)}">
              <div class="test-row1">
                <span class="badge running">R</span>
                <span class="session-test-name" title="${esc(displayName)}">${esc(displayName)}</span>
              </div>
            </div>`;
          }
        }
        html += '</div>';
      }
    }
    html += '</div>';
  }
  list.innerHTML = html || '<div class="no-data">No sessions found</div>';
  // Scroll the active test item into view so the last test isn't clipped
  const activeTest = list.querySelector('.session-test-item.active');
  if (activeTest) {
    activeTest.scrollIntoView({ block: 'nearest' });
  } else {
    const activeSession = list.querySelector('.session-item.active');
    if (activeSession) activeSession.scrollIntoView({ block: 'nearest' });
  }
}

// ── Bot sidebar ──────────────────────────────────────────────────────────

function _platformIcon(platform) {
  const icons = { slack: '#', telegram: '✈', discord: '🎮', webchat: '💬', hook: '⚡' };
  return icons[platform] || '●';
}

function botTargetLabel(session) {
  const provider = String(session?.origin?.provider || session?.platform || session?.origin?.surface || 'agent').toLowerCase();
  const raw = session?.origin?.label || session?.label || session?.channelLabel || session?.peerId || session?.sessionId || '';
  let label = String(raw)
    .replace(/^Slack Channel:\s*/i, '')
    .replace(/^channel:/i, '')
    .trim();
  if (!label) label = session?.sessionId ? String(session.sessionId).slice(0, 12) : 'unknown';
  if (provider === 'slack' && !label.startsWith('#') && !label.startsWith('@') && !label.startsWith('slack:')) {
    label = `#${label}`;
  }
  return `${provider}:${label}`;
}

function findCollectedSession(sessionKey) {
  for (const sessions of Object.values(S.botCollectedSessions || {})) {
    const found = (sessions || []).find(s => s.sessionKey === sessionKey);
    if (found) return found;
  }
  return null;
}

function sortedCollectedBatches(collectedSession) {
  return [...(collectedSession?.batches || [])].sort((a, b) =>
    String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

function renderBotSidebar() {
  const list = document.getElementById('session-list');
  let html = '';

  // ── Bot surfaces: slack:<channel>, cron:<name>, etc. ──
  const platforms = Object.keys(S.botCollectedSessions || {});
  let renderedTargets = false;
  if (platforms.length > 0) {
    html += `<div class="sidebar-section bot-target-section"><div class="sidebar-section-title">Sessions</div>`;
    for (const platform of platforms) {
      const sessions = S.botCollectedSessions[platform];
      if (!sessions || sessions.length === 0) continue;
      for (const ps of sessions) {
        const batchCount = ps.batches?.length || 0;
        const totalMsgs = (ps.batches || []).reduce((sum, b) => sum + (b.messageCount || 0), 0);
        const latest = [...(ps.batches || [])].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0];
        const latestLabel = latest?.updatedAt ? `latest ${localTime(new Date(latest.updatedAt).toISOString(), 'HH:mm')}` : `${batchCount} runs`;
        const isExpanded = S._collectedSessionKey === ps.sessionKey;
        const isSelected = isExpanded || S.currentBotSession?.sessionKey === ps.sessionKey;
        const active = isSelected ? ' active' : '';
        const platformCls = platform === 'slack' ? 'badge-slack'
          : platform === 'telegram' ? 'badge-telegram'
          : platform === 'discord' ? 'badge-discord'
          : platform === 'cron' ? 'badge-hook'
          : 'badge-webchat';
        const label = `${platform}:${ps.label}`;
        renderedTargets = true;
        // Exchange sub-list for the loaded session: one entry per end-user
        // exchange (what the user sent → what the user saw back).
        const showExchanges = isSelected && S.currentBotSession?.sessionKey === ps.sessionKey && (S._botExchanges || []).length > 0;
        const exchangesHtml = showExchanges
          ? `<div class="bot-exchange-list">${S._botExchanges.map((x, i) => `
              <div class="bot-exchange-item${S._botExchangeScope === i ? ' active' : ''}" onclick="selectBotExchange(${i})" title="Focus this sub-session">
                <div class="bot-exchange-head">
                  <span class="bot-exchange-num">${i + 1}</span>
                  <span class="bot-exchange-tag">sub-session</span>
                  ${x.ts ? `<span class="bot-exchange-time">${esc(localTime(x.ts, 'HH:mm'))}</span>` : ''}
                </div>
                <div class="bot-exchange-msg user"><span class="bot-exchange-role">User</span><span class="bot-exchange-text">${esc(x.userText || '(empty message)')}</span></div>
                <div class="bot-exchange-msg reply">${x.replyId
                  ? `<span class="bot-exchange-role">Reply</span><span class="bot-exchange-text">${esc(x.replyText)}</span>`
                  : `<span class="bot-exchange-role">Reply</span><span class="bot-exchange-text bot-exchange-noreply">no reply yet</span>`}</div>
              </div>`).join('')}</div>`
          : '';
        html += `<div class="bot-session-item collected-session bot-target-surface${active}" data-collected-key="${esc(ps.sessionKey)}">
          <div class="bot-target-row">
            <span class="badge-platform ${platformCls}">${esc(platform)}</span>
            <span class="bot-session-label" title="${esc(label)}">${esc(label)}</span>
          </div>
          <div class="bot-target-meta">${esc(latestLabel)}${totalMsgs ? ` · ${totalMsgs} messages` : ''}</div>
          ${exchangesHtml}
        </div>`;
      }
    }
    html += '</div>';
  }

  list.innerHTML = renderedTargets ? html : '<div class="no-data">No bot sessions found</div>';
}

// ── Mode switching ───────────────────────────────────────────────────────

function switchDashboardMode(newMode) {
  if (S.mode === newMode) return;
  if (!allowedDashboardModes.has(newMode)) return;
  const base = document.querySelector('meta[name="base-path"]')?.content || '';
  window.location.href = `${base}/${newMode}/`;
}

async function selectBotSession(batch, session) {
  S.currentBotBatch = batch;
  S.currentBotSession = session;
  S.currentTab = normalizeTabForCurrentMode(S.currentTab);
  // Clear e2e state
  S.currentSession = null;
  S.currentWsId = null;
  // Clear caches
  S.conversationData = {};
  S.auditData = {};
  S.notifyData = {};
  S.llmRequestsData = {};
  S._botExchanges = [];
  S._botExchangeScope = null;

  // Update header
  const header = document.getElementById('main-header');
  const timestamp = localTime(batch.date, 'date') + ' ' + localTime(batch.date, 'HH:mm:ss');
  const statusCls = batch.status === 'RUNNING' ? 'running' : 'stopped';
  const branchTag = batch.gitBranch ? `<span class="mode-badge">${esc(batch.gitBranch)}</span>` : '';
  const friendlyName = botTargetLabel(session);
  const platform = session.platform || friendlyName.split(':')[0] || 'bot';
  const platformCls = platform === 'slack' ? 'badge-slack'
    : platform === 'telegram' ? 'badge-telegram'
    : platform === 'discord' ? 'badge-discord'
    : platform === 'cron' ? 'badge-hook'
    : 'badge-webchat';
  const modelTag = session.model ? `<span class="mode-badge">${esc(session.model)}</span>` : '';
  const messageTag = session.messageCount ? `<span>${esc(String(session.messageCount))} messages</span>` : '';

  // OpenClaw dashboard link
  let gatewayLink = '';
  if (batch.gatewayPort) {
    const gwHost = location.hostname;
    const gwUrl = `http://${gwHost}:${esc(batch.gatewayPort)}#token=${batch.gatewayToken || ''}`;
    gatewayLink = `<a href="${gwUrl}" target="_blank" rel="noopener" class="info-btn" style="text-decoration:none">OpenClaw Dashboard</a>`;
  }

  header.innerHTML = `
    <div class="bot-topbar-title">
      <span class="badge-platform ${platformCls}">${esc(platform)}</span>
      <div class="bot-topbar-copy">
        <div class="session-title">${esc(friendlyName)}</div>
        <div class="session-subtitle">${branchTag}${modelTag}<span>${esc(batch.batchId)}</span><span>${timestamp}</span>${messageTag}</div>
      </div>
    </div>
    <div class="bot-topbar-actions">
      <span class="bot-status-badge ${statusCls}">${esc(batch.status)}</span>
      ${gatewayLink}
      ${renderBotDarkModeToggle()}
    </div>`;

  document.getElementById('tab-bar').style.display = 'flex';
  renderTabBar();
  renderBotSidebar();
  await showTab(S.currentTab || 'conversation');
}

// ── Session detail ──────────────────────────────────────────────────────
function buildHash() {
  if (S.mode === 'bot') {
    let hash = '';
    if (S.currentBotBatch) {
      hash = `#batch/${encodeURIComponent(S.currentBotBatch.batchId)}`;
      if (S.currentBotSession) hash += `/session/${encodeURIComponent(S.currentBotSession.sessionId)}`;
    }
    if (hash && S.currentTab && S.currentTab !== 'conversation') hash += `/tab/${S.currentTab}`;
    else if (hash && S.botHistoryView && S.botHistoryView !== 'dual') hash += `/view/${S.botHistoryView}`;
    return hash;
  }
  let hash = '';
  if (S.currentSession) {
    hash = `#session/${encodeURIComponent(S.currentSession.id)}`;
    if (S.currentWsId) hash += `/ws/${encodeURIComponent(S.currentWsId)}`;
    if (S.currentTab && S.currentTab !== 'conversation') hash += `/tab/${S.currentTab}`;
    else if (!S.e2eDualView) hash += '/view/conv';
  }
  return hash;
}

function updateUrlState() {
  // Use hash-based routing so the server always serves index.html
  // Format: #session/<id>[/ws/<wsId>][/tab/<tab>]
  const hash = buildHash();
  const target = hash || location.pathname;
  // Push a new history entry when the hash actually changes, so the
  // browser back/forward buttons work.
  if (target !== location.hash && target !== location.pathname) {
    S._suppressPopstate = true;
    history.pushState(null, '', target);
  } else {
    history.replaceState(null, '', target);
  }
}

function parseUrlState() {
  const hash = location.hash.slice(1); // remove #
  if (!hash.startsWith('session/')) return null;
  const parts = hash.split('/');
  // session/<id>[/ws/<wsId>][/tab/<tab>][/view/dual|conv]
  const state = { session: decodeURIComponent(parts[1] || ''), ws: null, tab: null, view: null };
  for (let i = 2; i < parts.length - 1; i++) {
    if (parts[i] === 'ws') state.ws = decodeURIComponent(parts[++i] || '');
    else if (parts[i] === 'tab') state.tab = parts[++i] || null;
    else if (parts[i] === 'view') state.view = parts[++i] || null;
  }
  return state;
}

// Apply a /view/<mode> hash segment to e2e state. Returns true if it changed
// the rendered conversation view (caller must re-render in that case).
function applyE2eViewFromUrl(view) {
  if (view !== 'dual' && view !== 'conv') return false;
  const dv = view === 'dual';
  if (S.e2eDualView === dv) return false;
  S.e2eDualView = dv;
  localStorage.setItem('e2e-dualview', dv ? '1' : '0');
  return true;
}

const BOT_HISTORY_VIEWS = ['dual', 'agent', 'human', 'both'];

function updateSessionHeader() {
  if (!S.currentSession) return;
  const session = S.currentSession;
  const header = document.getElementById('main-header');
  const wsId = S.currentWsId || '??';
  const wsLogFile = `${session.id}/${wsId}.log`;
  const wsLogPath = `test/log-sessions/${wsLogFile}`;
  const wsPath = `test/log-sessions/${session.id}/${wsId}/`;
  const test = session.tests.find(t => t.wsId === wsId);
  const testName = test ? friendlyTestName(test.name) : '';
  const dockerTag = session.docker === true ? '<span class="mode-badge">docker</span>' : session.docker === false ? '<span class="mode-badge">no-docker</span>' : '';
  const branchTag = session.gitBranch ? `<span class="mode-badge">${esc(session.gitBranch)}</span>` : '';
  const symFmtTag = session.symbolFormat ? `<span class="mode-badge" style="color:var(--cyan)">fmt: ${esc(session.symbolFormat)}</span>` : '';
  const defenseTag = session.defense ? defenseBadgeHtml(session.defense, false, session.defenseDisplayName) : '';
  const policyTag = session.openshellPolicy ? `<span class="mode-badge" style="color:var(--purple)" title="OpenShell policy preset">policy: ${esc(session.openshellPolicy)}</span>` : '';
  const actorTag = session.ciActor
    ? (session.ciJobUrl
        ? `<a href="${esc(session.ciJobUrl)}" target="_blank" rel="noopener" class="mode-badge" style="color:var(--cyan);text-decoration:none">${esc(session.ciActor)}</a>`
        : `<span class="mode-badge">${esc(session.ciActor)}</span>`)
    : '';
  const timestamp = localTime(session.date, 'date') + ' ' + localTime(session.date, 'HH:mm:ss');
  const displayResult = test ? test.result : session.result;
  // Runtime metadata line
  let runtimeMetaHtml = '';
  const rm = S._assertionMeta?.runtimeMeta;
  if (rm) {
    const parts = [];
    if (rm.cwd) parts.push(`cwd: ${esc(rm.cwd)}`);
    if (rm.model) parts.push(`Model: ${esc(rm.model)}`);
    if (rm.thinking) parts.push(`Thinking: ${esc(rm.thinking)}`);
    if (parts.length > 0) {
      runtimeMetaHtml = `<div class="session-meta" style="font-size:11px;color:var(--fg3);margin-top:2px;font-family:monospace;display:flex;gap:10px;flex-wrap:wrap">${parts.map(p => `<span>${p}</span>`).join('')}</div>`;
    }
  }

  const asrHtml = session.attackSuccessRate != null
    ? `<div class="asr-summary">ASR: <strong>${session.attackSuccessRate}%</strong> <span class="asr-detail">(${session.attackSuccessCount} succeeded, ${session.attackBlockedCount} blocked${session.attackInconclusive ? `, ${session.attackInconclusive} inconclusive` : ''})</span></div>`
    : '';

  // Attack details panel for security tests
  let attackDetailsHtml = '';
  if (session.attackSuccessRate != null && test) {
    const parsed = parseSecurityTestName(test.name);
    const oracle = parseOracleReason(test.reason);
    if (parsed && oracle) {
      const oracleColor = oracle.result === 'ATTACK_SUCCESS' ? 'var(--red)'
        : oracle.result === 'ATTACK_BLOCKED' ? 'var(--green)'
        : 'var(--fg3)';
      const oracleLabel = oracle.result === 'ATTACK_SUCCESS' ? 'ATTACK SUCCEEDED'
        : oracle.result === 'ATTACK_BLOCKED' ? 'ATTACK BLOCKED'
        : 'NO ATTACK';
      // Parse matched commands from detail string into a list
      const cmdMatches = [];
      const cmdRe = /'([^']+)' in: (.+?)(?=; '|$)/g;
      let m;
      while ((m = cmdRe.exec(oracle.detail)) !== null) {
        cmdMatches.push({ pattern: m[1], call: m[2].trim() });
      }
      let oracleHtml = `<span style="font-weight:600;color:${oracleColor}">${oracleLabel}</span>`;
      if (cmdMatches.length > 0) {
        // Attack detected: show matched patterns → tool calls
        oracleHtml += `<ul style="margin:4px 0 0 12px;padding:0;list-style:disc;font-size:11px">`;
        for (const cm of cmdMatches) {
          oracleHtml += `<li><code>${esc(cm.pattern)}</code> &rarr; <span style="color:var(--fg2)">${esc(cm.call)}</span></li>`;
        }
        oracleHtml += `</ul>`;
      } else {
        // Attack blocked: parse check patterns from "No commands matching [...]"
        const patternsMatch = oracle.detail?.match(/No commands matching \[([^\]]+)\]/);
        if (patternsMatch) {
          try {
            const patterns = JSON.parse('[' + patternsMatch[1] + ']');
            oracleHtml += `<div style="font-size:11px;margin-top:4px;color:var(--fg2)">Check criteria:</div>`;
            oracleHtml += `<ul style="margin:2px 0 0 12px;padding:0;list-style:disc;font-size:11px">`;
            for (const p of patterns) oracleHtml += `<li><code>${esc(p)}</code></li>`;
            oracleHtml += `</ul>`;
          } catch { /* fallback below */ }
        }
        // tool_called_with blocked
        const toolMatch = oracle.detail?.match(/tool "?(\w+)"? was never called/);
        if (toolMatch) {
          oracleHtml += `<div style="font-size:11px;margin-top:4px;color:var(--fg2)">Checked tool: <code>${esc(toolMatch[1])}</code> — never called</div>`;
        }
      }
      attackDetailsHtml = `<div class="attack-details">
        <div class="attack-details-row"><span class="attack-details-label">Injection Task</span><span>${esc(parsed.it)}</span></div>
        <div class="attack-details-row"><span class="attack-details-label">Attack Template</span><span>${esc(parsed.attack)}</span></div>
        <div class="attack-details-row"><span class="attack-details-label">Vector</span><span>${esc(parsed.vector)}</span></div>
        <div class="attack-details-row"><span class="attack-details-label">Oracle</span><div>${oracleHtml}</div></div>
      </div>`;
    }
  }

  header.innerHTML = `
    <div class="session-title">${(() => {
      if (session.attackSuccessRate != null && test?.reason) {
        const o = parseOracleReason(test.reason);
        if (o?.result === 'ATTACK_SUCCESS') return '<span class="badge fail">ATK</span>';
        if (o?.result === 'ATTACK_BLOCKED') return '<span class="badge pass">BLK</span>';
        if (o?.result === 'NO_ATTACK') return '<span class="badge pass">NOA</span>';
      }
      return `<span class="badge ${displayResult.toLowerCase()}">${displayResult === 'INTERRUPTED' ? 'STOP' : displayResult}</span>`;
    })()
    }${testName ? ` &mdash; ${esc(testName)}` : ''}</div>
    <div class="session-subtitle" style="font-size:11px;color:var(--fg3);margin-top:2px;display:flex;align-items:center;gap:4px">
      ${defenseTag}${policyTag}${actorTag}${dockerTag}${branchTag}${symFmtTag}<span>${timestamp}</span>
      <button class="info-btn" title="Test configuration" onclick="window._showTestConfig()">test config</button>
      <button class="info-btn" title="OpenClaw configuration" onclick="window._showOclawConfig()">openclaw.json</button>
    </div>
    ${asrHtml}
    ${attackDetailsHtml}
    ${runtimeMetaHtml}
    <div class="session-meta" style="font-size:11px;color:var(--fg3);margin-top:2px;font-family:monospace">
      log: ${esc(wsLogPath)} <button class="copy-btn" onclick="navigator.clipboard.writeText('${esc(wsLogPath)}')">copy</button>
    </div>
    <div class="session-meta" style="font-size:11px;color:var(--fg3);margin-top:2px;font-family:monospace">
      ws: ${esc(wsPath)} <button class="copy-btn" onclick="navigator.clipboard.writeText('${esc(wsPath)}')">copy</button>
    </div>`;
}

async function selectSession(session) {
  S.currentSession = session;
  S.logEntries = null;
  S.logData = {};
  S.conversationData = {};
  S.auditData = {};
  S.notifyData = {};
  S.llmRequestsData = {};
  // Will be set to currentWsId after ws resolution below
  S.auditWsFilter = null;
  S.logWsFilter = null;
  S.gitLogData = {};
  S.gitWsFilter = 'all';
  S.symbolTableWsFilter = null;
  // Default to first usable workspace (excludes 00 when other IDs exist)
  const wsIds = usableWsIds(session);
  S.currentWsId = wsIds[0] || session.workspaceIds[0] || null;
  S.auditWsFilter = S.currentWsId || 'all';
  S.logWsFilter = S.currentWsId || 'all';

  updateSessionHeader();

  updateUrlState();
  document.getElementById('tab-bar').style.display = 'flex';
  renderTabBar();
  renderSidebar();
  await showTab(S.currentTab);
}

// ── Tabs ────────────────────────────────────────────────────────────────
async function showTab(tab) {
  tab = normalizeTabForCurrentMode(tab);
  S.currentTab = tab;
  updateUrlState();
  renderTabBar();
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  const content = document.getElementById('tab-content');

  // Need either an e2e session, bot session, or eval task selected
  const hasSelection = S.currentSession || (S.mode === 'bot' && S.currentBotSession) || (S.mode === 'eval' && S.currentEvalTask);
  if (!hasSelection) { content.innerHTML = ''; return; }

  try {
    if (tab === 'conversation') {
      await renderConversation(content);
      if (S.mode === 'eval') renderEvalJudge(content);
      else if (S.mode !== 'bot') updateSessionHeader();
    }
    else if (tab === 'log') await renderLog(content);
    else if (tab === 'audit') await renderAudit(content);
    else if (tab === 'symbol-table') await renderSymbolTable(content);
    else if (tab === 'bot-files') await renderBotFileSystem(content);
    else if (tab === 'files-root') await renderFilesView(content, 'root');
    else if (tab === 'files-trusted') await renderFilesView(content, 'trusted');
    else if (tab === 'files-untrusted') await renderFilesView(content, 'untrusted');
    else if (tab === 'test-spec') await renderTestSpec(content);
  } catch (err) {
    console.error(`showTab(${tab}) error:`, err);
    content.innerHTML = `<div class="no-data" style="color:var(--red)">Error rendering ${esc(tab)}: ${esc(String(err))}</div>`;
  }
}

// ── Workspace switcher ──────────────────────────────────────────────────
async function switchWorkspace(wsId) {
  S.currentWsId = wsId;
  S.logWsFilter = wsId;
  S.auditWsFilter = wsId;
  S.symbolTableWsFilter = wsId;
  S.gitWsFilter = wsId;
  updateSessionHeader();
  updateUrlState();
  renderSidebar();
  await showTab(S.currentTab);
}

// ── Helpers ─────────────────────────────────────────────────────────────
function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  const reopen = document.getElementById('sidebar-reopen');
  sidebar.classList.toggle('hidden');
  const isHidden = sidebar.classList.contains('hidden');
  reopen.style.display = isHidden ? '' : 'none';
}

function toggleAll(btn, open) {
  const container = btn.closest('#tab-content') || document.getElementById('tab-content');
  container.querySelectorAll('details:not(.jt-node)').forEach(d => d.open = open);
}

function toggleUsageInfo() {
  S.showUsageInfo = !S.showUsageInfo;
  document.querySelectorAll('.usage-detail').forEach(el => {
    el.style.display = S.showUsageInfo ? '' : 'none';
  });
  const btn = document.getElementById('usage-toggle');
  if (btn) btn.textContent = S.showUsageInfo ? 'Hide Stats' : 'Show Stats';
}

function toggleEntryTime() {
  S.showEntryTime = !S.showEntryTime;
  const scroll = document.getElementById('conv-scroll');
  if (scroll) scroll.classList.toggle('conv-show-time', S.showEntryTime);
  const btn = document.getElementById('entry-time-toggle');
  if (btn) btn.textContent = S.showEntryTime ? 'Hide Time' : 'Show Time';
}

async function switchBotHistoryView(view) {
  if (!['agent', 'human', 'both', 'dual'].includes(view)) return;
  S.botHistoryView = view;
  renderTabBar();
  if (S.mode === 'bot' && S.currentTab === 'conversation') await showTab('conversation');
  updateUrlState();
}

async function switchE2eDualView(enabled) {
  S.e2eDualView = !!enabled;
  localStorage.setItem('e2e-dualview', S.e2eDualView ? '1' : '0');
  if (S.mode === 'e2e' && S.currentTab === 'conversation') await showTab('conversation');
  updateUrlState();
}

// DualView Simple ⇄ Expert wording toggle (shared by the e2e and bot dual views).
async function toggleBotSimpleMode() {
  S.botSimpleMode = !S.botSimpleMode;
  localStorage.setItem('dualview-simple-mode', S.botSimpleMode ? '1' : '0');
  if (S.currentTab === 'conversation') await showTab('conversation');
}

// ── Config modal ────────────────────────────────────────────────────────
async function toggleConfigModal() {
  const modal = document.getElementById('config-modal');
  if (modal.classList.contains('open')) { modal.classList.remove('open'); return; }
  const tbl = document.getElementById('config-table');
  tbl.innerHTML = '<tr><td colspan="2">Loading...</td></tr>';
  modal.classList.add('open');
  try {
    const cfg = await api('config');
    const rows = [
      ['Hostname', cfg.hostname],
      ['Port', cfg.port],
      ['Session directory', cfg.sessionsDir],
      ['Auth enabled', cfg.authEnabled ? 'Yes' : 'No'],
      ['Git branch', cfg.gitBranch || '\u2014'],
      ['Git commit', cfg.gitCommit || '\u2014'],
      ['Node version', cfg.nodeVersion],
      ['Platform', cfg.platform],
      ['Uptime', fmtUptime(cfg.uptime)],
    ];
    tbl.innerHTML = rows.map(([k,v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');
  } catch(e) { tbl.innerHTML = `<tr><td colspan="2">Error: ${e.message}</td></tr>`; }
}

// ── Theme ───────────────────────────────────────────────────────────────
function setTheme(theme) {
  document.documentElement.className = theme;
  localStorage.setItem('dualview-dashboard-theme', theme);
  const sel = document.getElementById('theme-select');
  if (sel) sel.value = theme;
}

function loadTheme() {
  const saved = localStorage.getItem('dualview-dashboard-theme') || 'theme-github-dark';
  setTheme(saved);
}

function loadE2eDualView() {
  const saved = localStorage.getItem('e2e-dualview');
  S.e2eDualView = saved == null ? true : saved === '1';
  S.botSimpleMode = localStorage.getItem('dualview-simple-mode') === '1';
}

function applyBotDarkMode() {
  document.body.classList.toggle('bot-dark-mode', !!S.botDarkMode);
  document.querySelectorAll('.bot-dark-toggle input').forEach(input => { input.checked = !!S.botDarkMode; });
}

function loadBotDarkMode() {
  S.botDarkMode = localStorage.getItem('dualview-bot-dark-mode') === '1';
  applyBotDarkMode();
}

function toggleBotDarkMode(checked) {
  S.botDarkMode = !!checked;
  localStorage.setItem('dualview-bot-dark-mode', S.botDarkMode ? '1' : '0');
  applyBotDarkMode();
}

// ── Auto-refresh for live sessions ──────────────────────────────────────
function _startLiveRefresh() {
  if (S._liveRefreshTimer) return;
  S._liveRefreshTimer = setInterval(async () => {
    if (!S.autoRefresh) return;
    const hasRunning = S.sessions.some(s => s.result === 'RUNNING');
    if (!hasRunning) {
      clearInterval(S._liveRefreshTimer);
      S._liveRefreshTimer = null;
      return;
    }
    try {
      const fresh = await api('sessions');
      S.sessions = fresh;
      renderSidebar();
      // If viewing a running session, refresh its data too
      if (S.currentSession && S.currentSession.result === 'RUNNING') {
        const updated = S.sessions.find(s => s.id === S.currentSession.id);
        if (updated) {
          S.currentSession = updated;
          // Re-fetch workspace data if viewing one
          if (S.currentWsId) {
            // Preserve scroll positions across the innerHTML rerender so the
            // user isn't yanked back to the top every 5s while watching live
            // logs scroll in.
            const prevScroll = document.getElementById('conv-scroll')?.scrollTop ?? null;
            const prevOutline = document.getElementById('conv-outline')?.scrollTop ?? null;
            for (const k in S.conversationData) delete S.conversationData[k];
            for (const k in S.auditData) delete S.auditData[k];
            for (const k in S.notifyData) delete S.notifyData[k];
            for (const k in S.llmRequestsData) delete S.llmRequestsData[k];
            for (const k in S.dualviewCommitsData) delete S.dualviewCommitsData[k];
            await showTab(S.currentTab);
            // Restore scroll after the new DOM is in place. The new conv-scroll
            // element exists immediately after innerHTML, so a microtask suffices.
            queueMicrotask(() => {
              if (prevScroll != null) {
                const el = document.getElementById('conv-scroll');
                if (el) el.scrollTop = prevScroll;
              }
              if (prevOutline != null) {
                const el = document.getElementById('conv-outline');
                if (el) el.scrollTop = prevOutline;
              }
            });
          }
          updateSessionHeader();
        }
      }
    } catch { /* ignore refresh errors */ }
  }, 5000);
}
function _checkLiveRefresh() {
  if (S.sessions.some(s => s.result === 'RUNNING')) _startLiveRefresh();
}

function toggleAutoRefresh() {
  S.autoRefresh = !S.autoRefresh;
  const btn = document.getElementById('auto-refresh-btn');
  btn.classList.toggle('on', S.autoRefresh);
  btn.classList.toggle('off', !S.autoRefresh);
  // If re-enabled, kick off refresh if there are running sessions
  if (S.autoRefresh) _checkLiveRefresh();
}

// ── Resizable sidebar ───────────────────────────────────────────────────
(function() {
  const handle = document.getElementById('resize-handle');
  const sidebar = document.getElementById('sidebar');
  let dragging = false;

  handle.addEventListener('mousedown', (e) => {
    dragging = true;
    handle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const newWidth = Math.max(200, Math.min(600, e.clientX));
    sidebar.style.width = newWidth + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
})();

// ── Resizable outline sidebar ────────────────────────────────────────────
(function() {
  document.addEventListener('mousedown', (e) => {
    const handle = e.target.closest('#conv-outline-handle');
    if (!handle) return;
    const outline = document.getElementById('conv-outline');
    if (!outline) return;
    handle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const offsetLeft = outline.getBoundingClientRect().left;
    function onMove(ev) {
      const newWidth = Math.max(120, Math.min(400, ev.clientX - offsetLeft));
      outline.style.width = newWidth + 'px';
    }
    function onUp() {
      handle.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    e.preventDefault();
  });
})();

// ── Outline width controls ───────────────────────────────────────────────
function resizeOutline(factor) {
  const outline = document.getElementById('conv-outline');
  if (!outline) return;
  const cur = outline.offsetWidth;
  const next = Math.max(80, Math.min(600, Math.round(cur * factor)));
  outline.style.width = next + 'px';
}

function toggleOutlineTiming() {
  S.showOutlineTiming = !S.showOutlineTiming;
  // Re-render conversation tab to rebuild outline with/without timing
  showTab('conversation');
}

// ── Event bindings ──────────────────────────────────────────────────────
document.addEventListener('click', async (e) => {
  // Bot mode clicks
  if (S.mode === 'bot') {
    // Collected target click: open the latest concrete run for this surface.
    const persistItem = e.target.closest('.collected-session');
    if (persistItem) {
      const sessionKey = persistItem.dataset.collectedKey;
      S._collectedSessionKey = sessionKey;
      const collected = findCollectedSession(sessionKey);
      const latest = sortedCollectedBatches(collected)[0];
      const batch = latest ? S.botBatches.find(b => b.batchId === latest.batchId) : null;
      const session = batch?.sessions.find(s => s.sessionKey === sessionKey);
      if (batch && session) {
        await selectBotSession(batch, session);
        updateUrlState();
      } else {
        renderBotSidebar();
      }
      return;
    }
  }

  const toolToggle = e.target.closest('#tool-toggle');
  if (toolToggle) {
    S.showToolTags = !S.showToolTags;
    if (!S.showToolTags) S.tagFilter = null;
    toolToggle.classList.toggle('active', S.showToolTags);
    renderTagFilterBar();
    renderSidebar();
    return;
  }

  const filterBtn = e.target.closest('.filter-btn');
  if (filterBtn) {
    S.filter = filterBtn.dataset.filter;
    document.querySelectorAll('.filter-btn:not(.tool-toggle)').forEach(b => b.classList.toggle('active', b === filterBtn));
    renderSidebar();
    return;
  }

  const tagFilterBtn = e.target.closest('.tag-filter-btn');
  if (tagFilterBtn) {
    S.tagFilter = tagFilterBtn.dataset.tag || null;
    document.querySelectorAll('.tag-filter-btn').forEach(b => b.classList.toggle('active', b === tagFilterBtn));
    renderSidebar();
    return;
  }

  const tagBadge = e.target.closest('.tag-badge');
  if (tagBadge && !tagBadge.closest('.session-test-item')) {
    const tag = tagBadge.dataset.tag;
    S.tagFilter = S.tagFilter === tag ? null : tag;
    renderTagFilterBar();
    renderSidebar();
    return;
  }

  // Test item click -> navigate to that test's workspace conversation
  const testItem = e.target.closest('.session-test-item');
  if (testItem) {
    if (testItem.dataset.wsid) {
      // Select the parent session if it differs from the current one
      const sessionId = testItem.dataset.sessionid;
      if (sessionId && S.currentSession?.id !== sessionId) {
        const parentSession = S.sessions.find(s => s.id === sessionId);
        if (parentSession) await selectSession(parentSession);
      }
      S.currentWsId = testItem.dataset.wsid;
      S.logWsFilter = S.currentWsId;
      S.auditWsFilter = S.currentWsId;
      S.symbolTableWsFilter = S.currentWsId;
      S.gitWsFilter = S.currentWsId;
      S.currentTab = 'conversation';
      updateSessionHeader();
      updateUrlState();
      renderSidebar();
      await showTab('conversation');
    }
    return; // consume click even if no wsid (don't let it fall through)
  }

  const evalTaskItem = e.target.closest('.eval-task-sidebar');
  if (evalTaskItem) {
    const taskId = evalTaskItem.dataset.evalTask;
    if (taskId) {
      await selectEvalTask(taskId);
      const base = document.querySelector('meta[name="base-path"]')?.content || '';
      history.pushState(null, '', `${base}/eval/#run/${S.currentEvalRunId}/task/${taskId}`);
    }
    return;
  }

  const evalItem = e.target.closest('.eval-run-item');
  if (evalItem) {
    const runId = evalItem.dataset.evalRun;
    if (runId) {
      if (S.currentEvalRunId === runId && S.currentEvalResult) {
        if (S._collapsedEvalRuns.has(runId)) S._collapsedEvalRuns.delete(runId);
        else S._collapsedEvalRuns.add(runId);
        renderEvalSidebar();
        return;
      }
      await selectEvalRun(runId);
      const base = document.querySelector('meta[name="base-path"]')?.content || '';
      history.pushState(null, '', `${base}/eval/#run/${runId}`);
    }
    return;
  }

  const item = e.target.closest('.session-item');
  if (item) {
    const session = S.sessions.find(s => s.id === item.dataset.id);
    if (session) {
      // Toggle: clicking the already-active session folds it back
      if (S.currentSession?.id === session.id) {
        S.currentSession = null;
        S.currentWsId = null;
        S._collapsedSessions.add(session.id);
        document.getElementById('main-header').innerHTML = '';
        document.getElementById('tab-bar').style.display = 'none';
        document.getElementById('tab-content').innerHTML = '';
        updateUrlState();
        renderSidebar();
      } else {
        S._collapsedSessions.delete(session.id);
        await selectSession(session);
      }
    }
    return;
  }

  const tab = e.target.closest('.tab');
  if (tab) {
    await showTab(tab.dataset.tab);
    return;
  }
});

// ── History navigation (back/forward) ────────────────────────────────────
async function restoreFromHash() {
  const hash = location.hash.slice(1);

  // Eval mode: #run/<runId>[/task/<taskId>]
  if (S.mode === 'eval') {
    if (!hash.startsWith('run/')) {
      S.currentEvalRunId = null;
      S.currentEvalTask = null;
      S.currentEvalResult = null;
      document.getElementById('main-header').innerHTML = '<div class="welcome">Select an eval run from the sidebar</div>';
      document.getElementById('tab-bar').style.display = 'none';
      document.getElementById('tab-content').innerHTML = '';
      renderEvalSidebar();
      return;
    }
    const parts = hash.split('/');
    const runId = decodeURIComponent(parts[1] || '');
    if (runId && runId !== S.currentEvalRunId) await selectEvalRun(runId);
    if (parts[2] === 'task' && parts[3]) {
      const taskId = decodeURIComponent(parts[3]);
      if (taskId !== S.currentEvalTask) await selectEvalTask(taskId);
    } else if (S.currentEvalTask) {
      S.currentEvalTask = null;
      renderEvalMain();
      renderEvalSidebar();
    }
    return;
  }

  // Bot mode: #batch/<id>/session/<id>[/tab/<tab>][/event/<stepId>|/symbol/<symbolId>]
  if (S.mode === 'bot') {
    if (!hash.startsWith('batch/')) {
      S.currentBotBatch = null;
      S.currentBotSession = null;
      document.getElementById('main-header').innerHTML = '<div class="welcome">Select a session from the sidebar</div>';
      document.getElementById('tab-bar').style.display = 'none';
      document.getElementById('tab-content').innerHTML = '';
      renderBotSidebar();
      return;
    }
    const parts = hash.split('/');
    let batchId = null, sessionId = null, tab = null, eventId = null, symbolId = null, view = null;
    for (let i = 0; i < parts.length - 1; i++) {
      if (parts[i] === 'batch') batchId = decodeURIComponent(parts[++i] || '');
      else if (parts[i] === 'session') sessionId = decodeURIComponent(parts[++i] || '');
      else if (parts[i] === 'tab') tab = parts[++i] || null;
      else if (parts[i] === 'event') eventId = decodeURIComponent(parts[++i] || '');
      else if (parts[i] === 'symbol') symbolId = decodeURIComponent(parts[++i] || '');
      else if (parts[i] === 'view') view = parts[++i] || null;
    }
    if (eventId || symbolId) tab = 'conversation';
    if (view && BOT_HISTORY_VIEWS.includes(view)) S.botHistoryView = view;
    if (batchId) {
      const batch = S.botBatches.find(b => b.batchId === batchId);
      if (batch) {
        const session = sessionId ? batch.sessions.find(s => s.sessionId === sessionId) : null;
        if (session) await selectBotSession(batch, session);
        if (tab) await showTab(tab);
        if (symbolId) requestAnimationFrame(() => showBotSymbolDetails(symbolId));
        else if (eventId) requestAnimationFrame(() => showBotEventDetails(eventId));
      }
    }
    return;
  }

  // E2E mode: #session/<id>[/ws/<wsId>][/tab/<tab>]
  const urlState = parseUrlState();
  if (!urlState || !urlState.session) {
    S.currentSession = null;
    S.currentWsId = null;
    document.getElementById('main-header').innerHTML = '';
    document.getElementById('tab-bar').style.display = 'none';
    document.getElementById('tab-content').innerHTML = '';
    renderSidebar();
    return;
  }
  const session = S.sessions.find(s => s.id === urlState.session);
  if (!session) return;

  const viewChanged = applyE2eViewFromUrl(urlState.view);
  if (S.currentSession?.id !== session.id) {
    await selectSession(session);
  }
  if (urlState.ws && session.workspaceIds.includes(urlState.ws)) {
    if (S.currentWsId !== urlState.ws) {
      await switchWorkspace(urlState.ws);
    }
  }
  const tab = urlState.tab || 'conversation';
  if (S.currentTab !== tab) {
    await showTab(tab);
  } else if (viewChanged && tab === 'conversation') {
    await showTab(tab);
  }
}

// ── Config popup handlers ────────────────────────────────────────────
window._showTestConfig = async function() {
  if (!S.currentSession) return;
  const meta = await api(`sessions/${encodeURIComponent(S.currentSession.id)}/meta`);
  _showJsonPopup('Test Configuration', meta);
};
window._showOclawConfig = async function() {
  if (!S.currentSession) return;
  const cfg = await api(`sessions/${encodeURIComponent(S.currentSession.id)}/openclaw-config`);
  _showJsonPopup('OpenClaw Configuration', cfg);
};
function _showJsonPopup(title, data) {
  let overlay = document.getElementById('config-popup-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'config-popup-overlay';
    overlay.className = 'config-popup-overlay';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.style.display = 'none'; });
    document.body.appendChild(overlay);
  }
  overlay.innerHTML = `<div class="config-popup">
    <div class="config-popup-header">
      <span>${esc(title)}</span>
      <button onclick="document.getElementById('config-popup-overlay').style.display='none'">&times;</button>
    </div>
    <pre class="config-popup-body">${esc(JSON.stringify(data, null, 2))}</pre>
  </div>`;
  overlay.style.display = 'flex';
}

// ── Eval mode ───────────────────────────────────────────────────────────

// Render a defense badge. Shared between eval and e2e modes so the defense
// under test is labelled consistently. "dualview" + fileUntrusted gets the
// "+FU" suffix (eval-only concept; #162).
function defenseBadgeHtml(defense, fileUntrusted, displayName, extraStyle) {
  const style = extraStyle ? ` style="${extraStyle}"` : '';
  const d = defense || 'none';
  const noneCls = d === 'none' ? ' defense-none' : '';
  const label = (d === 'dualview' && fileUntrusted) ? 'DualView+FU' : d.toUpperCase();
  const titleText = (d === 'dualview' && fileUntrusted)
    ? 'DualView + workspace as untrustedDir (#162)'
    : (displayName || '');
  const title = titleText ? ` title="${esc(titleText)}"` : '';
  return `<span class="mode-badge defense-badge${noneCls}"${style}${title}>${esc(label)}</span>`;
}

function formatDurationShort(sec) {
  const total = Math.max(0, Math.round(sec));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h${minutes > 0 ? ` ${minutes}m` : ''}`;
  if (minutes > 0) return `${minutes}m${minutes < 10 && seconds > 0 ? ` ${seconds}s` : ''}`;
  return `${seconds}s`;
}

function evalLiveText(status) {
  if (!status?.running) return '';
  const completed = Number.isFinite(status.completedTasks) ? status.completedTasks : null;
  const total = Number.isFinite(status.totalTasks)
    ? status.totalTasks
    : (Number.isFinite(status.resume?.taskCount) ? status.resume.taskCount : null);
  const current = status.currentTask ? status.currentTask.replace(/^task_/, '').replaceAll('_', ' ') : '';
  const progress = completed != null && total != null ? `${completed}/${total}` : '';
  const eta = Number.isFinite(status.estimatedRemainingSec)
    ? `ETA ${formatDurationShort(status.estimatedRemainingSec)}`
    : '';
  return ['running', progress, eta, current].filter(Boolean).join(' ');
}

function renderEvalSidebar() {
  const list = document.getElementById('session-list');
  if (!S.evalRuns || S.evalRuns.length === 0) {
    list.innerHTML = '<div class="no-data">No eval runs found.<br>Run: <code>npx tsx test/eval/run-pinchbench.ts --model sonnet</code></div>';
    return;
  }

  let html = '';
  const liveText = evalLiveText(S.evalStatus);
  if (liveText) {
    html += `<div class="eval-running-banner">${esc(liveText)}</div>`;
  }

  const groups = {};
  for (const r of S.evalRuns) {
    const day = localTime(r.date, 'date');
    if (!groups[day]) groups[day] = [];
    groups[day].push(r);
  }

  for (const [day, runs] of Object.entries(groups)) {
    html += `<div class="date-group"><div class="date-label">${esc(day)}</div>`;
    for (const r of runs) {
      const isSelected = S.currentEvalRunId === r.runId;
      const active = isSelected ? ' active' : '';
      const isRunning = S.evalStatus?.running === true && S.evalStatus.runId === r.runId;
      const time = localTime(r.date, 'HH:mm');
      const modelShort = r.model.split('/').pop() || r.model;
      const dualviewBadge = defenseBadgeHtml(r.defense, r.fileUntrusted, r.defenseDisplayName);
      const runningBadge = isRunning ? '<span class="badge running">R</span>' : '';
      const pct = r.scorePct ?? 0;
      const barColor = pct >= 80 ? 'var(--green)' : pct >= 50 ? 'var(--yellow)' : 'var(--red)';
      const isCollapsed = S._collapsedEvalRuns.has(r.runId);
      const runLiveText = isRunning ? evalLiveText(S.evalStatus) : '';

      html += `<div class="session-item eval-run-item${active}" data-eval-run="${esc(r.runId)}">
        <div class="eval-run-row1">
          <span class="eval-run-time">${esc(time)}</span>
          ${runningBadge}
          ${dualviewBadge}
          <span class="eval-run-model">${esc(modelShort)}</span>
        </div>
        <div class="eval-run-row2">
          <div class="eval-run-bar-wrap">
            <div class="eval-run-bar" style="width:${pct}%;background:${barColor}"></div>
          </div>
          <span class="eval-run-pct">${r.scorePct != null ? r.scorePct.toFixed(0) + '%' : '-'}</span>
        </div>
        <div class="eval-run-row3">
          <span>${r.taskCount} tasks</span>
          ${r.gitBranch ? `<span class="mode-badge">${esc(r.gitBranch)}</span>` : ''}
        </div>
        ${runLiveText ? `<div class="eval-run-row3 eval-run-live">${esc(runLiveText)}</div>` : ''}
      </div>`;

      // Show tasks under the selected run
      if (isSelected && !isCollapsed && S.currentEvalResult?.tasks) {
        for (const t of S.currentEvalResult.tasks) {
          const taskActive = S.currentEvalTask === t.task_id ? ' active' : '';
          const score = t.grading?.mean;
          const scoreColor = score != null ? (score >= 0.9 ? 'var(--green)' : score >= 0.5 ? 'var(--yellow)' : 'var(--red)') : 'var(--fg3)';
          const taskIdx = S.currentEvalResult.tasks.indexOf(t);
          const taskName = t.frontmatter?.name || t.task_id.replace(/^task_(?:\d+_)?/, '');
          html += `<div class="eval-task-sidebar${taskActive}" data-eval-task="${esc(t.task_id)}">
            <span class="eval-task-num">#${taskIdx + 1}</span>
            <span class="eval-task-name">${esc(taskName)}</span>
            <span class="eval-task-score" style="color:${scoreColor}">${score != null ? score.toFixed(2) : '-'}</span>
          </div>`;
        }
      }
    }
    html += '</div>';
  }
  list.innerHTML = html || '<div class="no-data">No eval runs</div>';
}

async function selectEvalRun(runId) {
  S.currentEvalRunId = runId;
  S.currentEvalTask = null;
  S.currentEvalTranscript = null;
  S._collapsedEvalRuns.delete(runId);
  try {
    const [result, meta] = await Promise.all([
      api(`eval/runs/${encodeURIComponent(runId)}`),
      api(`eval/runs/${encodeURIComponent(runId)}/meta`),
    ]);
    S.currentEvalResult = result;
    S.currentEvalMeta = meta;
  } catch {
    S.currentEvalResult = null;
    S.currentEvalMeta = null;
  }
  renderEvalSidebar();
  renderEvalMain();
}

async function selectEvalTask(taskId) {
  S.currentEvalTask = taskId;
  S.currentEvalTranscript = null;
  renderEvalMain();
  if (taskId) {
    const runId = encodeURIComponent(S.currentEvalRunId);
    const tid = encodeURIComponent(taskId);
    const cacheKey = `eval:${S.currentEvalRunId}:${taskId}`;
    S.currentWsId = cacheKey;
    try {
      const [conv, audit] = await Promise.all([
        S.conversationData[cacheKey] || api(`eval/runs/${runId}/conversation/${tid}`),
        S.auditData[cacheKey] || api(`eval/runs/${runId}/audit/${tid}`).catch(() => []),
      ]);
      S.conversationData[cacheKey] = conv;
      if (audit.some(a => a.taskId)) {
        S.auditData[cacheKey] = audit;
      } else if (!S.auditData[cacheKey]) {
        // Older runs predate taskId-tagged audit records. Fall back to tool
        // call IDs from the selected transcript instead of showing run-wide
        // audit data for tasks with no tool calls.
        const taskCallIds = new Set();
        for (const e of (conv.main || [])) {
          const msg = e.message || {};
          if (msg.role === 'assistant' && Array.isArray(msg.content)) {
            for (const b of msg.content) {
              if ((b.type === 'toolCall' || b.type === 'tool_use') && b.id) taskCallIds.add(b.id);
            }
          }
          if (msg.toolCallId) taskCallIds.add(msg.toolCallId);
        }
        S.auditData[cacheKey] = audit.filter(a => taskCallIds.has(a.toolCallId));
      }
      S.notifyData[cacheKey] ||= [];
      S.llmRequestsData[cacheKey] ||= {};
      S.dualviewCommitsData[cacheKey] ||= {};
      S.currentEvalTranscript = conv.main || [];
    } catch {
      S.currentEvalTranscript = [];
    }
    // Show tab bar and render conversation tab
    const tabBar = document.getElementById('tab-bar');
    tabBar.style.display = '';
    await showTab('conversation');
  }
}

function renderEvalMain() {
  const header = document.getElementById('main-header');
  const tabBar = document.getElementById('tab-bar');
  const content = document.getElementById('tab-content');
  if (!S.currentEvalTask) tabBar.style.display = 'none';

  if (!S.currentEvalResult) {
    header.innerHTML = '<div class="welcome">Select an eval run from the sidebar</div>';
    content.innerHTML = '';
    return;
  }

  const result = S.currentEvalResult;
  const meta = S.currentEvalMeta || {};
  const tasks = result.tasks || [];
  const modelShort = (meta.model || result.model || '').split('/').pop() || '?';
  const dualviewBadge = defenseBadgeHtml(meta.defense, meta.fileUntrusted, meta.defenseDisplayName, 'font-size:11px');

  const inProgress = result.in_progress === true;
  const gradedTasks = tasks.filter(t => typeof t.grading?.mean === 'number');
  const totalScore = gradedTasks.reduce((s, t) => s + t.grading.mean, 0);
  const pct = gradedTasks.length > 0 ? ((totalScore / gradedTasks.length) * 100) : null;
  const eff = result.efficiency || {};

  const selectedTask = S.currentEvalTask ? tasks.find(t => t.task_id === S.currentEvalTask) : null;
  const taskLabel = selectedTask
    ? `<span class="eval-header-task">${esc(selectedTask.frontmatter?.name || selectedTask.task_id)}</span>`
    : '';

  const runId = meta.runId || result.run_id || S.currentEvalRunId || '';
  const resumedFrom = Array.isArray(meta.resumedFrom) ? meta.resumedFrom : [];
  const resumeBadge = resumedFrom.length > 0
    ? `<span class="eval-header-meta" title="${esc(resumedFrom.join(' → '))}">↻ resumed ×${resumedFrom.length}</span>`
    : '';
  const runIdEl = runId
    ? `<span class="eval-header-meta eval-runid" data-copy="${esc(runId)}" title="Click to copy runId (for --resume-from)">${esc(runId)}</span>`
    : '';
  const liveText = S.evalStatus?.running === true && S.evalStatus.runId === runId
    ? evalLiveText(S.evalStatus)
    : '';

  header.innerHTML = `<div class="eval-header">
    <div class="eval-header-left">
      ${taskLabel || `<strong class="eval-header-model">${esc(modelShort)}</strong>`}
      ${taskLabel ? `<span class="eval-header-meta">${esc(modelShort)}</span>` : ''}
      ${dualviewBadge}
      ${liveText ? `<span class="eval-header-meta eval-live-meta">${esc(liveText)}</span>` : ''}
      ${runIdEl}
      ${resumeBadge}
      ${meta.gitCommit ? `<span class="eval-header-meta">${esc(meta.gitCommit)}</span>` : ''}
    </div>
    <div class="eval-header-right">
      <span class="eval-header-score" style="color:${pct == null ? 'var(--fg3)' : pct >= 80 ? 'var(--green)' : pct >= 50 ? 'var(--yellow)' : 'var(--red)'}">${pct == null ? '-' : pct.toFixed(0) + '%'}</span>
      <span class="eval-header-meta">${pct == null ? (inProgress ? 'in progress' : '-') : `${totalScore.toFixed(1)}/${gradedTasks.length}`}</span>
    </div>
  </div>`;

  // Wire click-to-copy on the runId pill (rebound each render since innerHTML
  // replaces the node). Uses navigator.clipboard when available, falls back
  // to a textarea trick on insecure origins.
  const runIdNode = header.querySelector('.eval-runid');
  if (runIdNode) {
    runIdNode.addEventListener('click', async () => {
      const val = runIdNode.getAttribute('data-copy') || '';
      try {
        await navigator.clipboard.writeText(val);
      } catch {
        const ta = document.createElement('textarea');
        ta.value = val;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } finally { ta.remove(); }
      }
      const prev = runIdNode.textContent;
      runIdNode.textContent = 'copied!';
      setTimeout(() => { runIdNode.textContent = prev; }, 900);
    });
    runIdNode.style.cursor = 'pointer';
  }

  let html = '<div class="eval-content-scroll">';

  // Stats bar
  const completedTasks = result.completed_tasks ?? tasks.length;
  const totalTasks = result.total_tasks ?? tasks.length;
  const progressStr = inProgress ? `${completedTasks}/${totalTasks}` : String(tasks.length);

  html += '<div class="eval-stats-bar">';
  const pluginUsage = eff.plugin_usage || {};
  const pluginTokens = pluginUsage.total_tokens || 0;
  const pluginCost = pluginUsage.total_cost_usd || 0;
  const pluginSessions = pluginUsage.total_subagent_sessions || 0;
  const stats = [
    { label: 'Progress', value: progressStr },
    { label: 'Tokens', value: (eff.total_tokens || 0).toLocaleString() },
    { label: 'Cost', value: '$' + (eff.total_cost_usd || 0).toFixed(2) },
    { label: 'Time', value: eff.total_execution_time_seconds ? (eff.total_execution_time_seconds / 60).toFixed(1) + 'm' : '-' },
  ];
  // Surface u-llm (DUALVIEW inspect_symbol) overhead when present.
  if (pluginTokens > 0 || pluginSessions > 0) {
    stats.push({
      label: 'ULLM Tokens',
      value: pluginTokens.toLocaleString() + (pluginSessions ? ` (${pluginSessions}x)` : ''),
    });
    stats.push({ label: 'ULLM Cost', value: '$' + pluginCost.toFixed(4) });
  }
  for (const s of stats) {
    html += `<div class="eval-stat-pill"><span class="eval-stat-label">${s.label}</span><span class="eval-stat-value">${s.value}</span></div>`;
  }
  html += '</div>';

  if (!S.currentEvalTask) {
    html += '<div class="no-data" style="margin-top:20px">Select a task from the sidebar</div>';
  }

  // Transcript area
  html += '</div>';
  content.innerHTML = html;

}

function renderEvalJudge(area) {
  const tasks = S.currentEvalResult?.tasks || [];
  const task = tasks.find(t => t.task_id === S.currentEvalTask);
  if (!task?.grading?.runs?.length) return;
  const run = task.grading.runs[0];
  if (run.grading_type !== 'llm_judge' && run.grading_type !== 'hybrid') return;

  const score = run.score;
  const scoreColor = score >= 0.9 ? 'var(--green)' : score >= 0.5 ? 'var(--yellow)' : 'var(--red)';
  let html = `<div class="eval-judge-block">`;
  html += `<div class="eval-judge-header">Judge</div>`;
  html += `<div class="eval-judge-score" style="color:${scoreColor}">${score.toFixed(2)}</div>`;
  if (run.breakdown && Object.keys(run.breakdown).length > 0) {
    html += '<div class="eval-judge-criteria">';
    for (const [criterion, value] of Object.entries(run.breakdown)) {
      const pct = (Number(value) * 100);
      const barColor = pct >= 90 ? 'var(--green)' : pct >= 50 ? 'var(--yellow)' : 'var(--red)';
      const label = criterion.replace(/[_.]/g, ' ');
      html += `<div class="eval-judge-criterion">
        <span class="eval-judge-criterion-label">${esc(label)}</span>
        <div class="eval-judge-criterion-bar-wrap">
          <div class="eval-judge-criterion-bar" style="width:${pct}%;background:${barColor}"></div>
        </div>
        <span class="eval-judge-criterion-value">${Number(value).toFixed(2)}</span>
      </div>`;
    }
    html += '</div>';
  }
  if (run.notes) {
    html += `<div class="eval-judge-notes">${esc(run.notes)}</div>`;
  }
  html += '</div>';
  area.insertAdjacentHTML('beforeend', html);
}

function evalResultSignature(result) {
  const tasks = Array.isArray(result?.tasks) ? result.tasks : [];
  return JSON.stringify({
    in_progress: result?.in_progress === true,
    completed_tasks: result?.completed_tasks ?? null,
    total_tasks: result?.total_tasks ?? null,
    current_task: result?.current_task ?? null,
    tasks: tasks.map(task => ({
      task_id: task?.task_id ?? null,
      status: task?.status ?? null,
      mean: typeof task?.grading?.mean === 'number' ? task.grading.mean : null,
      runs: Array.isArray(task?.grading?.runs)
        ? task.grading.runs.map(run => ({
          score: typeof run?.score === 'number' ? run.score : null,
          type: run?.grading_type ?? null,
        }))
        : [],
    })),
  });
}

function startEvalPoll() {
  if (S._evalPollTimer) return;
  S._evalPollTimer = setInterval(async () => {
    try {
      const [status, runs] = await Promise.all([
        api('eval/status'),
        api('eval/runs'),
      ]);
      S.evalStatus = status;
      S.evalRuns = runs;
      renderEvalSidebar();

      // Refresh the currently selected run if it has new data
      if (S.currentEvalRunId) {
        const run = runs.find(r => r.runId === S.currentEvalRunId);
        if (run) {
          try {
            const result = await api(`eval/runs/${encodeURIComponent(S.currentEvalRunId)}`);
            if (evalResultSignature(result) !== evalResultSignature(S.currentEvalResult)) {
              S.currentEvalResult = result;
              renderEvalSidebar();
              renderEvalMain();
            }
          } catch { /* ignore */ }
        }
      }

      if (!status.running) {
        clearInterval(S._evalPollTimer);
        S._evalPollTimer = null;
      }
    } catch { /* ignore */ }
  }, 5_000);
}

window.addEventListener('popstate', async () => {
  // Skip popstate events triggered by our own pushState calls
  if (S._suppressPopstate) { S._suppressPopstate = false; return; }
  await restoreFromHash();
});

// ── Init ────────────────────────────────────────────────────────────────
(async () => {
  loadTheme();
  loadE2eDualView();

  // Mode is determined by the URL path (/e2e/ or /bot/), injected via meta tag
  const initMode = DASHBOARD_MODE;

  const cfg = await api('config');
  const cfgModes = Array.isArray(cfg.allowedModes) ? cfg.allowedModes.filter(Boolean) : DASHBOARD_MODES;
  allowedDashboardModes = new Set(cfgModes);
  if (initMode === 'e2e') {
    const [sessions, testNames, testTags] = await Promise.all([api('sessions'), api('test-names'), api('test-tags')]);
    S.sessions = sessions;
    S.testNames = testNames;
    S.testTags = testTags || {};
  } else {
    S.sessions = [];
    S.testNames = {};
    S.testTags = {};
  }
  S.botAvailable = cfg.botAvailable === true;
  S.evalAvailable = cfg.evalAvailable === true;

  // Show only modes enabled by the server. Bot-only dashboards hide the switcher.
  document.querySelectorAll('.mode-btn').forEach(b => {
    const mode = b.dataset.mode;
    const enabled = allowedDashboardModes.has(mode)
      && (mode === 'e2e'
        || (mode === 'bot' && (S.botAvailable || initMode === 'bot'))
        || (mode === 'eval' && (S.evalAvailable || initMode === 'eval')));
    b.hidden = !enabled;
    b.classList.toggle('active', enabled && mode === initMode);
  });
  const visibleModeCount = document.querySelectorAll('.mode-btn:not([hidden])').length;
  if (visibleModeCount > 1) document.getElementById('mode-toggle').style.display = '';

  if (cfg.ciActor) {
    const banner = document.getElementById('ci-banner');
    banner.textContent = `CI: ${cfg.ciActor}`;
    banner.style.display = '';
  }

  if (initMode === 'eval') {
    document.body.classList.add('eval-mode');
    document.getElementById('dashboard-title').textContent = 'DualView Eval Dashboard';
    const [evalRuns, evalStatus] = await Promise.all([
      api('eval/runs'),
      api('eval/status').catch(() => ({ running: false })),
    ]);
    S.evalRuns = evalRuns;
    S.evalStatus = evalStatus;
    renderEvalSidebar();
    startEvalPoll();

    // Restore from hash: #run/<runId>[/task/<taskId>]
    const hash = location.hash.slice(1);
    if (hash.startsWith('run/')) {
      const parts = hash.split('/');
      const runId = decodeURIComponent(parts[1] || '');
      if (runId) {
        await selectEvalRun(runId);
        if (parts[2] === 'task' && parts[3]) {
          await selectEvalTask(decodeURIComponent(parts[3]));
        }
      }
    }
  } else if (initMode === 'bot') {
    document.body.classList.add('bot-mode');
    loadBotDarkMode();
    document.getElementById('dashboard-title').textContent = 'DualView Bot Dashboard';
    const [botBatches, collectedSessions] = await Promise.all([
      api('bot/batches'),
      api('bot/collected/sessions').catch(() => ({})),
    ]);
    S.botBatches = botBatches;
    S.botCollectedSessions = collectedSessions;
    renderBotSidebar();

    // Restore bot state from URL hash: #batch/<id>/session/<id>[/tab/<tab>][/event/<stepId>|/symbol/<symbolId>][/view/<mode>]
    const hash = location.hash.slice(1);
    if (hash.startsWith('batch/')) {
      const parts = hash.split('/');
      let batchId = null, sessionId = null, tab = null, eventId = null, symbolId = null, view = null;
      for (let i = 0; i < parts.length - 1; i++) {
        if (parts[i] === 'batch') batchId = decodeURIComponent(parts[++i] || '');
        else if (parts[i] === 'session') sessionId = decodeURIComponent(parts[++i] || '');
        else if (parts[i] === 'tab') tab = parts[++i] || null;
        else if (parts[i] === 'event') eventId = decodeURIComponent(parts[++i] || '');
        else if (parts[i] === 'symbol') symbolId = decodeURIComponent(parts[++i] || '');
        else if (parts[i] === 'view') view = parts[++i] || null;
      }
      if (eventId || symbolId) tab = 'conversation';
      if (view && BOT_HISTORY_VIEWS.includes(view)) S.botHistoryView = view;
      if (batchId) {
        const batch = S.botBatches.find(b => b.batchId === batchId);
        if (batch) {
          const session = sessionId ? batch.sessions.find(s => s.sessionId === sessionId) : batch.sessions[0];
          if (session) {
            await selectBotSession(batch, session);
            if (tab) await showTab(tab);
            if (symbolId) requestAnimationFrame(() => showBotSymbolDetails(symbolId));
            else if (eventId) requestAnimationFrame(() => showBotEventDetails(eventId));
          }
        }
      }
    }
  } else {
    renderTagFilterBar();
    renderSidebar();
    _checkLiveRefresh();

    // Restore session/workspace/tab/view from URL hash
    const urlState = parseUrlState();
    if (urlState && urlState.session) {
      const session = S.sessions.find(s => s.id === urlState.session);
      if (session) {
        applyE2eViewFromUrl(urlState.view);
        await selectSession(session);
        if (urlState.ws && session.workspaceIds.includes(urlState.ws)) {
          await switchWorkspace(urlState.ws);
        }
        if (urlState.tab) await showTab(urlState.tab);
        return;
      }
    }

    // Auto-select when there's only one session
    const visible = S.sessions.filter(s => S.filter === 'all' || (S.filter === 'skip' ? s.skipped > 0 : S.filter === s.result.toLowerCase()));
    if (visible.length === 1) await selectSession(visible[0]);
  }
})();

// ── Expose to window for inline onclick handlers in HTML ────────────────
Object.assign(window, {
  toggleSidebar, toggleConfigModal, setTheme, toggleAll, toggleUsageInfo, toggleEntryTime, resizeOutline, toggleOutlineTiming, toggleAutoRefresh,
  switchWorkspace, switchLogWs, switchAuditWs, switchSymbolTableWs, switchGitWs, switchSpecTest,
  switchDashboardMode, switchBotHistoryView, switchE2eDualView, switchBotFileView, toggleBotDarkMode, toggleBotSimpleMode,
  selectGitCommit, selectFileInView, selectFilesGitCommit, showFileVersionInView,
  scrollHighlight, showArgPopup, hideArgPopup, showAssertionPopup, hideAssertionPopup,
  showSymValue, showBotSymbolDetails, showBotEventDetails, openBotEventLink, toggleBotRawMode, syncBotSubsession, toggleBotInspector,
  selectBotExchange, clearBotExchangeScope, showTab,
  copyText, copyFileContent, renderFilesView, renderBotSidebar,
  // State needed by inline handlers
  get currentWsId() { return S.currentWsId; },
  set currentWsId(v) { S.currentWsId = v; },
  get currentFilePath() { return S.currentFilePath; },
  set currentFilePath(v) { S.currentFilePath = v; },
  _outlineThinkings: S._outlineThinkings,
  _selectEvalTask: selectEvalTask,
});
