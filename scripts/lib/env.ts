/**
 * Generic .env config loader and multi-provider auth profile builder.
 *
 * Centralizes API key management so adding a new provider key only requires
 * updating `.env.example` and `LLM_PROVIDERS` / `FORWARD_ENV_KEYS` here.
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── LLM provider registry ───────────────────────────────────────────────────

interface LLMProvider {
  profileId: string;   // e.g. "anthropic:default"
  provider: string;    // e.g. "anthropic"
  envKey: string;      // e.g. "ANTHROPIC_API_KEY"
}

const LLM_PROVIDERS: readonly LLMProvider[] = [
  { profileId: "anthropic:default", provider: "anthropic", envKey: "ANTHROPIC_API_KEY" },
  { profileId: "openai:default",    provider: "openai",    envKey: "OPENAI_API_KEY" },
  { profileId: "google:default",    provider: "google",    envKey: "GEMINI_API_KEY" },
];

// ── Tool / non-LLM keys to forward into Docker containers ───────────────────

export const FORWARD_ENV_KEYS: readonly string[] = [
  "BRAVE_API_KEY",
  "HF_TOKEN",
  "TOGETHER_API_KEY",
];

// ── .env file loader ────────────────────────────────────────────────────────

let _loaded = false;

/**
 * Parse a `.env` file and set values in `process.env`.
 * Existing env vars are never overwritten (CLI / shell > .env).
 */
export function loadEnvFile(filePath?: string): void {
  if (_loaded) return;
  _loaded = true;

  const target = filePath ?? resolve(__dirname, "../../.env");
  let raw: string;
  try {
    raw = readFileSync(target, "utf-8");
  } catch {
    return; // .env not present — not an error
  }

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (!(key in process.env) || !process.env[key]) {
      process.env[key] = value;
    }
  }
}

// ── Docker env forwarding ───────────────────────────────────────────────────

/**
 * Collect tool/non-LLM keys from `process.env` for Docker `-e` injection.
 * Returns only keys that have a non-empty value.
 */
export function getForwardEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of FORWARD_ENV_KEYS) {
    const val = process.env[key]?.trim();
    if (val) env[key] = val;
  }
  return env;
}

// ── OpenAI Codex OAuth loader ───────────────────────────────────────────────

interface CodexOAuthCreds {
  access: string;
  refresh: string;
  accountId?: string;
  email?: string;
  expires: number;  // unix ms
}

function decodeJwtExpMs(jwt: string): number | null {
  const parts = jwt.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1]!.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8"),
    ) as { exp?: unknown; email?: unknown };
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

function decodeJwtEmail(jwt: string): string | undefined {
  const parts = jwt.split(".");
  if (parts.length < 2) return undefined;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1]!.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8"),
    ) as { email?: unknown };
    return typeof payload.email === "string" ? payload.email : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve OpenAI Codex OAuth credentials from (in order):
 *   1. env vars: OPENAI_CODEX_ACCESS / _REFRESH / _ACCOUNT_ID / _EMAIL
 *   2. ~/.codex/auth.json (Codex CLI's auth store)
 *
 * Returns null when no credentials are available.
 */
export function resolveCodexOAuth(): CodexOAuthCreds | null {
  const envAccess = process.env["OPENAI_CODEX_ACCESS"]?.trim();
  const envRefresh = process.env["OPENAI_CODEX_REFRESH"]?.trim();
  if (envAccess && envRefresh) {
    const access = envAccess;
    return {
      access,
      refresh: envRefresh,
      accountId: process.env["OPENAI_CODEX_ACCOUNT_ID"]?.trim() || undefined,
      email: process.env["OPENAI_CODEX_EMAIL"]?.trim() || decodeJwtEmail(access),
      expires: decodeJwtExpMs(access) ?? 0,
    };
  }

  const codexPath = join(homedir(), ".codex", "auth.json");
  if (!existsSync(codexPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(codexPath, "utf-8")) as {
      tokens?: {
        access_token?: string;
        refresh_token?: string;
        account_id?: string;
        id_token?: string;
      };
    };
    const access = raw.tokens?.access_token?.trim();
    const refresh = raw.tokens?.refresh_token?.trim();
    if (!access || !refresh) return null;
    return {
      access,
      refresh,
      accountId: raw.tokens?.account_id?.trim() || undefined,
      email: raw.tokens?.id_token ? decodeJwtEmail(raw.tokens.id_token) : decodeJwtEmail(access),
      expires: decodeJwtExpMs(access) ?? 0,
    };
  } catch {
    return null;
  }
}

// ── Auth profiles builder ───────────────────────────────────────────────────

type AuthProfileEntry =
  | { type: "api_key"; provider: string; key: string }
  | {
      type: "oauth";
      provider: string;
      access: string;
      refresh: string;
      expires: number;
      accountId?: string;
      email?: string;
    };

/**
 * Build `auth-profiles.json` content with all available LLM provider keys.
 *
 * - Reads each provider key from `process.env` (populated by loadEnvFile + shell).
 * - `overrides` takes precedence (e.g. CLI `--anthropic-key`).
 * - Providers with no key are omitted from the output.
 * - If Codex OAuth credentials are available (env vars or ~/.codex/auth.json),
 *   emit an `openai-codex:default` OAuth profile alongside API-key profiles.
 * - Throws if zero providers / OAuth profiles are available.
 *
 * @returns JSON string ready to write as auth-profiles.json.
 */
export function buildAuthProfiles(
  overrides?: Partial<Record<string, string>>,
): string {
  const profiles: Record<string, AuthProfileEntry> = {};

  for (const p of LLM_PROVIDERS) {
    const key = overrides?.[p.envKey]?.trim() || process.env[p.envKey]?.trim();
    if (key) {
      profiles[p.profileId] = {
        type: "api_key",
        provider: p.provider,
        key,
      };
    }
  }

  const codex = resolveCodexOAuth();
  if (codex) {
    profiles["openai-codex:default"] = {
      type: "oauth",
      provider: "openai-codex",
      access: codex.access,
      refresh: codex.refresh,
      expires: codex.expires,
      ...(codex.accountId ? { accountId: codex.accountId } : {}),
      ...(codex.email ? { email: codex.email } : {}),
    };
  }

  if (Object.keys(profiles).length === 0) {
    const envNames = LLM_PROVIDERS.map(p => p.envKey).join(", ");
    throw new Error(
      `No LLM credentials found. Set at least one of: ${envNames}, ` +
      `or provide OPENAI_CODEX_ACCESS + OPENAI_CODEX_REFRESH (or ~/.codex/auth.json).\n` +
      `  via environment variable, .env file, or --anthropic-key flag.`,
    );
  }

  return JSON.stringify({ version: 1, profiles }, null, 2);
}
