import { randomBytes } from "crypto";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import Database from "better-sqlite3";
import { dualviewSymbolDbPath } from "./dualview-paths.js";
import { getActiveFormat } from "./dualview-symbol-format.js";

// ─────────────────────────────────────────────────────────────────────────────
// DualView persistent symbol table (SQLite-backed)
//
// Maps symbol placeholders to their original untrusted values with
// provenance metadata. Persisted to ~/.dualview/symbols.db.
// Symbol format is defined in dualview-symbol-format.ts.
// ─────────────────────────────────────────────────────────────────────────────

export interface SymbolEntry {
  value: string;
  tool: string;
  field: string | null;
  origin: string | null;
  session_key: string | null;
  call_id: string | null;
  created_at: number;
  /** Timestamp when this symbol was obsoleted (human edit, etc.). null = active. */
  obsoleted_at: number | null;
  /** What obsoleted this symbol: 'human' or a commit hash. null = active. */
  obsoleted_by: string | null;
  /** Parent symbol name if this is a derived symbol (from symbol splitting). */
  derived_from: string | null;
  /** Line range within parent value, e.g. "0:29". null if not derived. */
  line_range: string | null;
}

export interface SymbolMap {
  symbols: Map<string, SymbolEntry>;
}

export interface SymbolMutationJournal {
  inserted: Map<string, SymbolEntry>;
  updated: Map<string, { before: SymbolEntry; after: SymbolEntry }>;
}

export function createSymbolMutationJournal(): SymbolMutationJournal {
  return {
    inserted: new Map(),
    updated: new Map(),
  };
}

function cloneSymbolEntry(entry: SymbolEntry): SymbolEntry {
  return { ...entry };
}

function recordSymbolUpdate(
  journal: SymbolMutationJournal | undefined,
  symName: string,
  before: SymbolEntry,
  after: SymbolEntry,
): void {
  if (!journal) return;
  if (journal.inserted.has(symName)) {
    journal.inserted.set(symName, cloneSymbolEntry(after));
    return;
  }
  const existing = journal.updated.get(symName);
  journal.updated.set(symName, {
    before: existing?.before ?? cloneSymbolEntry(before),
    after: cloneSymbolEntry(after),
  });
}

/** Regex to detect symbol references in text. Delegates to active format. */
export function getSymbolPattern(): RegExp {
  return getActiveFormat().pattern;
}

/**
 * @deprecated Use getSymbolPattern() for format-independent code.
 * Kept for backward compatibility with existing imports.
 */
export const SYMBOL_PATTERN = /\$_DUALVIEW_SYM_[a-zA-Z_][a-zA-Z0-9_]*\[[0-9a-f]{4,8}\](?:\.[a-zA-Z_][a-zA-Z0-9_[\].]*)*|\$_DUALVIEW_SYM_[a-zA-Z_][a-zA-Z0-9_]*\[[0-9a-f]{4,8}\]/g;

/**
 * Check if a string contains any symbol references.
 */
export function hasSymbols(text: string): boolean {
  const fmt = getActiveFormat();
  if (!text.includes(fmt.prefix)) return false;
  const pat = fmt.pattern;
  pat.lastIndex = 0;
  return pat.test(text);
}

// ─────────────────────────────────────────────────────────────────────────────
// SQLite helpers
// ─────────────────────────────────────────────────────────────────────────────

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS symbols (
  sym_name    TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  tool        TEXT NOT NULL,
  field       TEXT,
  origin      TEXT,
  session_key TEXT,
  call_id     TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_symbols_value ON symbols(value);
CREATE INDEX IF NOT EXISTS idx_symbols_call_id ON symbols(call_id);
`;

/**
 * Migrate existing databases: add columns introduced after initial schema.
 */
function migrateSchema(db: InstanceType<typeof Database>): void {
  const cols = db.pragma("table_info(symbols)") as Array<{ name: string }>;
  const colNames = new Set(cols.map((c) => c.name));

  if (!colNames.has("call_id")) {
    db.exec("ALTER TABLE symbols ADD COLUMN call_id TEXT");
    db.exec("CREATE INDEX IF NOT EXISTS idx_symbols_call_id ON symbols(call_id)");
  }
  // Human-edit support: obsolescence tracking + derived symbol provenance
  if (!colNames.has("obsoleted_at")) {
    db.exec("ALTER TABLE symbols ADD COLUMN obsoleted_at INTEGER");
  }
  if (!colNames.has("obsoleted_by")) {
    db.exec("ALTER TABLE symbols ADD COLUMN obsoleted_by TEXT");
  }
  if (!colNames.has("derived_from")) {
    db.exec("ALTER TABLE symbols ADD COLUMN derived_from TEXT");
  }
  if (!colNames.has("line_range")) {
    db.exec("ALTER TABLE symbols ADD COLUMN line_range TEXT");
  }
}

/**
 * Return the default symbol DB path: ~/.dualview/symbols.db
 */
export function getSymbolDbPath(): string {
  return dualviewSymbolDbPath();
}

/**
 * Open (or create) the symbol database.
 * Defaults to ~/.dualview/symbols.db.
 * Applies WAL mode and creates the schema if needed.
 */
export function openSymbolDb(dbPath?: string): InstanceType<typeof Database> {
  const resolvedPath = dbPath ?? getSymbolDbPath();
  const dir = join(resolvedPath, "..");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const db = new Database(resolvedPath);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA_SQL);
  migrateSchema(db);
  return db;
}

/**
 * Load the symbol table from the SQLite database into a SymbolMap.
 */
export function loadSymbolMap(dbPath?: string): SymbolMap {
  const db = openSymbolDb(dbPath);
  try {
    const rows = db.prepare(
      "SELECT sym_name, value, tool, field, origin, session_key, call_id, created_at, obsoleted_at, obsoleted_by, derived_from, line_range FROM symbols",
    ).all() as Array<{
      sym_name: string; value: string; tool: string; field: string | null;
      origin: string | null; session_key: string | null; call_id: string | null; created_at: number;
      obsoleted_at: number | null; obsoleted_by: string | null;
      derived_from: string | null; line_range: string | null;
    }>;
    const symbols = new Map<string, SymbolEntry>();
    for (const row of rows) {
      symbols.set(row.sym_name, {
        value: row.value,
        tool: row.tool,
        field: row.field,
        origin: row.origin,
        session_key: row.session_key,
        call_id: row.call_id,
        created_at: row.created_at,
        obsoleted_at: row.obsoleted_at ?? null,
        obsoleted_by: row.obsoleted_by ?? null,
        derived_from: row.derived_from ?? null,
        line_range: row.line_range ?? null,
      });
    }
    return { symbols };
  } finally {
    db.close();
  }
}

/**
 * Save the symbol table to the SQLite database (upsert all entries).
 */
export function saveSymbolMap(symbolMap: SymbolMap, dbPath?: string): void {
  const db = openSymbolDb(dbPath);
  try {
    const upsert = db.prepare(`
      INSERT INTO symbols (sym_name, value, tool, field, origin, session_key, call_id, created_at,
                           obsoleted_at, obsoleted_by, derived_from, line_range)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(sym_name) DO UPDATE SET
        value = excluded.value,
        tool = excluded.tool,
        field = excluded.field,
        origin = excluded.origin,
        session_key = excluded.session_key,
        call_id = excluded.call_id,
        created_at = excluded.created_at,
        obsoleted_at = excluded.obsoleted_at,
        obsoleted_by = excluded.obsoleted_by,
        derived_from = excluded.derived_from,
        line_range = excluded.line_range
    `);

    const saveAll = db.transaction(() => {
      for (const [symName, entry] of symbolMap.symbols) {
        upsert.run(
          symName, entry.value, entry.tool, entry.field,
          entry.origin, entry.session_key, entry.call_id, entry.created_at,
          entry.obsoleted_at, entry.obsoleted_by, entry.derived_from, entry.line_range,
        );
      }
    });

    saveAll();
  } finally {
    db.close();
  }
}

export function rollbackSymbolMapChanges(
  journal: SymbolMutationJournal,
  dbPath?: string,
): void {
  const db = openSymbolDb(dbPath);
  try {
    const removeInserted = db.prepare(`
      DELETE FROM symbols
      WHERE sym_name = ?
        AND value = ? AND tool = ? AND field IS ? AND origin IS ?
        AND session_key IS ? AND call_id IS ? AND created_at = ?
        AND obsoleted_at IS ? AND obsoleted_by IS ?
        AND derived_from IS ? AND line_range IS ?
    `);
    const restoreUpdated = db.prepare(`
      UPDATE symbols
      SET value = ?, tool = ?, field = ?, origin = ?, session_key = ?, call_id = ?,
          created_at = ?, obsoleted_at = ?, obsoleted_by = ?, derived_from = ?, line_range = ?
      WHERE sym_name = ?
        AND value = ? AND tool = ? AND field IS ? AND origin IS ?
        AND session_key IS ? AND call_id IS ? AND created_at = ?
        AND obsoleted_at IS ? AND obsoleted_by IS ?
        AND derived_from IS ? AND line_range IS ?
    `);
    const values = (entry: SymbolEntry) => [
      entry.value,
      entry.tool,
      entry.field,
      entry.origin,
      entry.session_key,
      entry.call_id,
      entry.created_at,
      entry.obsoleted_at,
      entry.obsoleted_by,
      entry.derived_from,
      entry.line_range,
    ];
    const rollback = db.transaction(() => {
      for (const [symName, entry] of journal.inserted) {
        removeInserted.run(symName, ...values(entry));
      }
      for (const [symName, change] of journal.updated) {
        restoreUpdated.run(
          ...values(change.before),
          symName,
          ...values(change.after),
        );
      }
    });
    rollback();
  } finally {
    db.close();
  }
}

/**
 * Persist a single symbol to the database (incremental write).
 */
export function persistSymbol(symName: string, entry: SymbolEntry, dbPath?: string): void {
  const db = openSymbolDb(dbPath);
  try {
    db.prepare(`
      INSERT INTO symbols (sym_name, value, tool, field, origin, session_key, call_id, created_at,
                           obsoleted_at, obsoleted_by, derived_from, line_range)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(sym_name) DO UPDATE SET
        value = excluded.value,
        tool = excluded.tool,
        field = excluded.field,
        origin = excluded.origin,
        session_key = excluded.session_key,
        call_id = excluded.call_id,
        created_at = excluded.created_at,
        obsoleted_at = excluded.obsoleted_at,
        obsoleted_by = excluded.obsoleted_by,
        derived_from = excluded.derived_from,
        line_range = excluded.line_range
    `).run(
      symName, entry.value, entry.tool, entry.field,
      entry.origin, entry.session_key, entry.call_id, entry.created_at,
      entry.obsoleted_at, entry.obsoleted_by, entry.derived_from, entry.line_range,
    );
  } finally {
    db.close();
  }
}

/**
 * Atomically insert a symbol row only if sym_name is not already present.
 * Returns true if the insert succeeded, false on primary-key collision.
 *
 * Used to close cross-process symbol allocation races (issue #213 R3):
 * two concurrent allocators may pick the same hash at the in-memory level;
 * whoever reaches the DB first wins, the loser retries with a fresh hash.
 */
export function persistSymbolIfNew(symName: string, entry: SymbolEntry, dbPath?: string): boolean {
  const db = openSymbolDb(dbPath);
  try {
    const result = db.prepare(`
      INSERT OR IGNORE INTO symbols (sym_name, value, tool, field, origin, session_key, call_id, created_at,
                                     obsoleted_at, obsoleted_by, derived_from, line_range)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      symName, entry.value, entry.tool, entry.field,
      entry.origin, entry.session_key, entry.call_id, entry.created_at,
      entry.obsoleted_at, entry.obsoleted_by, entry.derived_from, entry.line_range,
    );
    return result.changes === 1;
  } finally {
    db.close();
  }
}

/**
 * Deterministic counter for integration tests.
 * When DUALVIEW_DETERMINISTIC_SYMBOLS=1, symbol hashes are sequential
 * (0001, 0002, ...) instead of random, making them predictable in test YAML.
 */
let _deterministicCounter = 0;

export function resetDeterministicCounter(): void {
  _deterministicCounter = 0;
}

/**
 * Generate a random 4-char hex string that doesn't collide with
 * any existing symbol in the map for the given tool+field combination.
 *
 * In deterministic mode (DUALVIEW_DETERMINISTIC_SYMBOLS=1), returns sequential
 * hex counters (0001, 0002, ...) for predictable integration tests.
 */
export function randomHash4(symbolMap: SymbolMap, tool: string, field?: string): string {
  const fmt = getActiveFormat();

  if (process.env.DUALVIEW_DETERMINISTIC_SYMBOLS || process.env.DualView_DETERMINISTIC_SYMBOLS) {
    for (;;) {
      const h = (++_deterministicCounter).toString(16).padStart(4, "0");
      const candidate = fmt.generate({ tool, hash: h, field });
      if (!symbolMap.symbols.has(candidate)) return h;
    }
  }

  for (let attempt = 0; attempt < 100; attempt++) {
    const h = randomBytes(2).toString("hex"); // 2 bytes = 4 hex chars
    const candidate = fmt.generate({ tool, hash: h, field });
    if (!symbolMap.symbols.has(candidate)) return h;
  }
  // Fallback: 8-char hex (effectively no collision)
  return randomBytes(4).toString("hex").slice(0, 4);
}

export interface AllocateSymbolOpts {
  tool: string;
  field?: string;
  value: string;
  origin?: string;
  sessionKey?: string;
  callId?: string;
  hash?: string;
}

/** Max attempts when retrying on DB-level symbol name collisions. */
const ALLOC_MAX_ATTEMPTS = 16;

/**
 * Allocate a new symbol for an untrusted value.
 *
 * When `dbPath` is passed and `hash` is not pre-specified, allocation is
 * race-safe across concurrent processes (issue #213 R3): each attempt
 * performs an atomic INSERT OR IGNORE at the DB layer, retrying with a
 * fresh hash on primary-key collision. The in-memory `symbolMap` is only
 * updated after the DB insert succeeds so the map never lists a sym_name
 * that belongs to another allocator.
 *
 * Without `dbPath` the allocator stays in-memory only (legacy behaviour for
 * unit fixtures). Callers that preallocate `hash` upstream skip the retry
 * loop — those paths remain vulnerable to cross-process collisions at the
 * upstream hash-selection step and should migrate to the atomic helpers
 * once the upstream sites are refactored.
 */
export function allocateSymbol(
  symbolMap: SymbolMap,
  { tool, field, value, origin, sessionKey, callId, hash }: AllocateSymbolOpts,
  dbPath?: string,
): string {
  const fmt = getActiveFormat();

  const buildEntry = (): SymbolEntry => ({
    value,
    tool,
    field: field ?? null,
    origin: origin ?? null,
    session_key: sessionKey ?? null,
    call_id: callId ?? null,
    created_at: Math.floor(Date.now() / 1000),
    obsoleted_at: null,
    obsoleted_by: null,
    derived_from: null,
    line_range: null,
  });

  // Caller-provided hash: honor it. Non-atomic (caller owns the hash
  // collision domain upstream).
  if (hash !== undefined) {
    const symName = fmt.generate({ tool, hash, field });
    const entry = buildEntry();
    symbolMap.symbols.set(symName, entry);
    if (dbPath !== undefined) persistSymbol(symName, entry, dbPath);
    return symName;
  }

  // No dbPath: legacy in-memory-only allocation for test fixtures.
  if (dbPath === undefined) {
    const h = randomHash4(symbolMap, tool, field);
    const symName = fmt.generate({ tool, hash: h, field });
    symbolMap.symbols.set(symName, buildEntry());
    return symName;
  }

  // Persistent allocation: retry loop with atomic DB insert.
  for (let attempt = 0; attempt < ALLOC_MAX_ATTEMPTS; attempt++) {
    const h = randomHash4(symbolMap, tool, field);
    const symName = fmt.generate({ tool, hash: h, field });
    const entry = buildEntry();
    if (persistSymbolIfNew(symName, entry, dbPath)) {
      symbolMap.symbols.set(symName, entry);
      return symName;
    }
    // Another process reserved this name in SQLite. Discard the candidate
    // and retry without exposing the losing value through the local map.
  }
  throw new Error(
    `allocateSymbol: exhausted ${ALLOC_MAX_ATTEMPTS} attempts for tool=${tool} field=${field ?? ""}`,
  );
}

/**
 * Resolve a symbol name to its raw value.
 */
export function resolveSymbol(symbolMap: SymbolMap, symName: string): string | null {
  const entry = symbolMap.symbols.get(symName);
  return entry?.value ?? null;
}

function resolveSymbolReference(symbolMap: SymbolMap, symName: string): string | null {
  const entry = symbolMap.symbols.get(symName);
  if (entry) return entry.value;

  const fmt = getActiveFormat();
  const fieldPath = fmt.extractFieldPath(symName);
  if (!fieldPath) return null;

  const baseName = symName.slice(0, -1 * (`.${fieldPath}`).length);
  return symbolMap.symbols.get(baseName)?.value ?? null;
}

/**
 * Find all symbol names that map to a given raw value.
 */
export function findSymbolsByValue(symbolMap: SymbolMap, rawValue: string): string[] {
  const matches: string[] = [];
  for (const [symName, entry] of symbolMap.symbols) {
    if (entry.value === rawValue) matches.push(symName);
  }
  return matches;
}

/**
 * Find all symbols associated with a given callId.
 * Returns an array of [symName, SymbolEntry] pairs.
 */
export function findSymbolsByCallId(symbolMap: SymbolMap, callId: string): Array<[string, SymbolEntry]> {
  const matches: Array<[string, SymbolEntry]> = [];
  for (const [symName, entry] of symbolMap.symbols) {
    if (entry.call_id === callId) matches.push([symName, entry]);
  }
  return matches;
}

/**
 * Replace all symbol references in a string with their raw values.
 */
export function resolveAllSymbols(text: string, symbolMap: SymbolMap): string {
  const pat = getActiveFormat().pattern;
  pat.lastIndex = 0;
  return text.replace(pat, (match) => {
    return resolveSymbolReference(symbolMap, match) ?? match;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Human-edit support: symbol obsolescence and derived symbols
// ─────────────────────────────────────────────────────────────────────────────

function symbolEntriesEqual(left: SymbolEntry, right: SymbolEntry): boolean {
  return left.value === right.value
    && left.tool === right.tool
    && left.field === right.field
    && left.origin === right.origin
    && left.session_key === right.session_key
    && left.call_id === right.call_id
    && left.created_at === right.created_at
    && left.obsoleted_at === right.obsoleted_at
    && left.obsoleted_by === right.obsoleted_by
    && left.derived_from === right.derived_from
    && left.line_range === right.line_range;
}

/**
 * Mark a symbol as obsoleted (e.g., by a human edit).
 * Updates both the in-memory map and the persistent DB.
 */
export function obsoleteSymbol(
  symbolMap: SymbolMap,
  symName: string,
  obsoletedBy: string,
  dbPath?: string,
  journal?: SymbolMutationJournal,
): void {
  const entry = symbolMap.symbols.get(symName);
  if (!entry) return;

  const db = openSymbolDb(dbPath);
  let before = cloneSymbolEntry(entry);
  let after = {
    ...before,
    obsoleted_at: Math.floor(Date.now() / 1000),
    obsoleted_by: obsoletedBy,
  };
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      const row = db.prepare(`
        SELECT value, tool, field, origin, session_key, call_id, created_at,
               obsoleted_at, obsoleted_by, derived_from, line_range
        FROM symbols WHERE sym_name = ?
      `).get(symName) as SymbolEntry | undefined;
      if (row) {
        const persisted: SymbolEntry = {
          value: row.value,
          tool: row.tool,
          field: row.field,
          origin: row.origin,
          session_key: row.session_key,
          call_id: row.call_id,
          created_at: row.created_at,
          obsoleted_at: row.obsoleted_at ?? null,
          obsoleted_by: row.obsoleted_by ?? null,
          derived_from: row.derived_from ?? null,
          line_range: row.line_range ?? null,
        };
        if (!symbolEntriesEqual(entry, persisted)) {
          throw new Error(`symbol changed concurrently: ${symName}`);
        }
        before = persisted;
        after = {
          ...persisted,
          obsoleted_at: Math.floor(Date.now() / 1000),
          obsoleted_by: obsoletedBy,
        };
        const result = db.prepare(`
          UPDATE symbols
          SET obsoleted_at = ?, obsoleted_by = ?
          WHERE sym_name = ?
            AND value = ? AND tool = ? AND field IS ? AND origin IS ?
            AND session_key IS ? AND call_id IS ? AND created_at = ?
            AND obsoleted_at IS ? AND obsoleted_by IS ?
            AND derived_from IS ? AND line_range IS ?
        `).run(
          after.obsoleted_at,
          after.obsoleted_by,
          symName,
          persisted.value,
          persisted.tool,
          persisted.field,
          persisted.origin,
          persisted.session_key,
          persisted.call_id,
          persisted.created_at,
          persisted.obsoleted_at,
          persisted.obsoleted_by,
          persisted.derived_from,
          persisted.line_range,
        );
        if (result.changes !== 1) {
          throw new Error(`symbol changed concurrently: ${symName}`);
        }
      }
      db.exec("COMMIT");
    } catch (err) {
      try { db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
      throw err;
    }
  } finally {
    db.close();
  }
  Object.assign(entry, after);
  recordSymbolUpdate(journal, symName, before, after);
}

export interface AllocateDerivedSymbolOpts {
  /** Parent symbol name. */
  parentSymName: string;
  /** Value for the derived symbol (subset of parent's value). */
  value: string;
  /** 0-indexed start line within parent value. */
  lineStart: number;
  /** 0-indexed end line (exclusive) within parent value. */
  lineEnd: number;
  /** 0-indexed derived piece ordinal within the current split operation. */
  splitIndex: number;
}

const SPLIT_FIELD_SEGMENT = "__dualview_split";

function appendSplitFieldSegment(field: string | null, splitIndex: number): string {
  const suffix = `${SPLIT_FIELD_SEGMENT}[${splitIndex}]`;
  return field ? `${field}.${suffix}` : suffix;
}

/**
 * Allocate a derived symbol from a parent symbol (for symbol splitting).
 * Inherits tool, call_id, origin, session_key from the parent. The field path
 * appends .__dualview_split[n] so nested split provenance is visible in the name.
 * Persists to both the in-memory map and the DB.
 *
 * Race-safe across concurrent processes (issue #213 R3): each attempt
 * performs an atomic INSERT OR IGNORE on the symbol DB and retries with a
 * fresh hash on primary-key collision, so two allocators can never land on
 * the same sym_name even when they share a stale in-memory view.
 */
export function allocateDerivedSymbol(
  symbolMap: SymbolMap,
  { parentSymName, value, lineStart, lineEnd, splitIndex }: AllocateDerivedSymbolOpts,
  dbPath?: string,
  journal?: SymbolMutationJournal,
): string {
  const parent = symbolMap.symbols.get(parentSymName);
  if (!parent) {
    throw new Error(`Cannot derive from unknown symbol: ${parentSymName}`);
  }

  const fmt = getActiveFormat();
  const derivedField = appendSplitFieldSegment(parent.field, splitIndex);

  const buildEntry = (): SymbolEntry => ({
    value,
    tool: parent.tool,
    field: derivedField,
    origin: parent.origin,
    session_key: parent.session_key,
    call_id: parent.call_id,
    created_at: Math.floor(Date.now() / 1000),
    obsoleted_at: null,
    obsoleted_by: null,
    derived_from: parentSymName,
    line_range: `${lineStart}:${lineEnd}`,
  });

  // Fixture path: no DB. Legacy in-memory-only allocation.
  if (dbPath === undefined) {
    const h = randomHash4(symbolMap, parent.tool, derivedField);
    const symName = fmt.generate({
      tool: parent.tool,
      hash: h,
      field: derivedField,
    });
    const entry = buildEntry();
    symbolMap.symbols.set(symName, entry);
    journal?.inserted.set(symName, cloneSymbolEntry(entry));
    return symName;
  }

  for (let attempt = 0; attempt < ALLOC_MAX_ATTEMPTS; attempt++) {
    const h = randomHash4(symbolMap, parent.tool, derivedField);
    const symName = fmt.generate({
      tool: parent.tool,
      hash: h,
      field: derivedField,
    });
    const entry = buildEntry();
    if (persistSymbolIfNew(symName, entry, dbPath)) {
      symbolMap.symbols.set(symName, entry);
      journal?.inserted.set(symName, cloneSymbolEntry(entry));
      return symName;
    }
    // Another process reserved this name in SQLite. Discard the candidate
    // and retry without exposing the losing value through the local map.
  }
  throw new Error(
    `allocateDerivedSymbol: exhausted ${ALLOC_MAX_ATTEMPTS} attempts for parent=${parentSymName}`,
  );
}

/**
 * Check if a symbol is active (not obsoleted).
 */
export function isSymbolActive(symbolMap: SymbolMap, symName: string): boolean {
  const entry = symbolMap.symbols.get(symName);
  return entry != null && entry.obsoleted_at == null;
}
