// Shared application state — all modules import and mutate this object.
const doc = typeof document !== 'undefined' ? document : null;
const metaContent = (name) => doc?.querySelector(`meta[name="${name}"]`)?.content;

const S = {
  sessions: [],
  currentSession: null,
  currentTab: 'conversation',
  filter: 'all',
  logEntries: null,
  conversationData: {},
  auditData: {},
  notifyData: {},
  llmRequestsData: {},
  currentWsId: null,
  showUsageInfo: false,
  showEntryTime: false,
  auditWsFilter: 'all',
  logWsFilter: 'all',
  logData: {},
  _assertionSpecs: {},    // testId -> parsed YAML assertions array
  _currentAssertions: [],  // assertion results for the current workspace
  dualviewCommitsData: {},
  cumulativeSymbols: [],
  symValueMap: {},
  gitLogData: {},
  gitWsFilter: 'all',
  symbolTableWsFilter: null,
  currentFilePath: null,
  currentFileView: 'root',
  testNames: {},          // testId (e.g. "UT-01") -> human-readable name
  testTags: {},           // testId (e.g. "UT-01") -> ["web_fetch", "multi-tool"]
  tagFilter: null,        // currently selected tag filter (null = show all)
  showToolTags: false,    // toggle visibility of tag filter bar + tag badges in test items
  testSpecCache: {},
  currentSpecTestId: null,
  _argPopup: null,
  _assertionPopup: null,
  _ftFileContents: [],
  convObserver: null,
  _liveRefreshTimer: null,
  autoRefresh: true,
  _collapsedSessions: new Set(),  // session IDs explicitly folded by the user
  showOutlineTiming: false,
  _outlineThinkings: [],
  _suppressPopstate: false,   // suppress next popstate when we pushState ourselves

  // Bot dashboard mode — determined by URL path (/e2e/ or /bot/)
  mode: metaContent('dashboard-mode') || 'e2e',
  e2eDualView: true,          // e2e: shared DualView rendering (persisted, default on)
  botAvailable: false,
  botBatches: [],             // BotBatchSummary[]
  botCollectedSessions: {},   // platform -> [{sessionKey, label, batches: [...]}]
  currentBotBatch: null,      // selected bot batch (deploy)
  currentBotSession: null,    // selected bot conversation session
  botHistoryView: 'dual',     // 'dual' | 'agent' | 'human' | 'both' for bot Session History
  botSimpleMode: false,       // DualView: plain-language labels + hide expert details (persisted)
  _botExchangeScope: null,    // DualView: index of the sub-session the lanes are scoped to (null = full session)
  botRawMode: false,
  botDarkMode: false,
  botInspectorCollapsed: false,
  currentBotFileView: 'trusted', // 'trusted' = AgentView, 'untrusted' = HumanView
  _collectedSessionKey: null,    // currently selected collected session key

  // Eval dashboard mode
  evalAvailable: false,
  evalRuns: [],                 // EvalRunSummary[]
  currentEvalRunId: null,       // selected runId string
  currentEvalResult: null,      // PinchBench result.json for selected run
  currentEvalMeta: null,        // meta.json for selected run
  currentEvalTask: null,        // selected task_id for transcript view
  currentEvalTranscript: null,  // transcript entries for selected task
  evalStatus: null,             // { running, runId, phase, model }
  _evalPollTimer: null,
  _collapsedEvalRuns: new Set(),
};

export default S;

export const DASHBOARD_TZ = metaContent('dashboard-timezone') || undefined;
export const DASHBOARD_MODE = metaContent('dashboard-mode') || 'e2e';
export const DASHBOARD_MODES = (metaContent('dashboard-modes') || 'e2e,bot,eval')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export async function api(path) {
  const base = metaContent('base-path') || '';
  const res = await fetch(base + '/api/' + path);
  return res.json();
}
