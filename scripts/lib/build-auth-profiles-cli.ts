#!/usr/bin/env node
/**
 * Print auth-profiles.json to stdout using env vars (+ ~/.codex/auth.json).
 * Exits 1 if no credentials are available — callers should fall back.
 *
 * Usage: npx tsx scripts/lib/build-auth-profiles-cli.ts > auth-profiles.json
 */
import { buildAuthProfiles, loadEnvFile } from "./env.js";

loadEnvFile();
try {
  process.stdout.write(buildAuthProfiles() + "\n");
} catch (err) {
  process.stderr.write(`${(err as Error).message}\n`);
  process.exit(1);
}
