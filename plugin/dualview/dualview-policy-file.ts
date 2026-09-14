import { createHash } from "crypto";
import { existsSync, lstatSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { dirname } from "path";
import {
  allocateSymbol,
  type SymbolMap,
  type SymbolMutationJournal,
} from "./dualview-symbol-table.js";

function symbolFieldForFile(file: string): string {
  return file.replace(/[^a-zA-Z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "content";
}

export function policyFileSymbolValue(file: string, content: Buffer): string {
  const sample = content.subarray(0, 8192);
  if (!sample.includes(0)) return content.toString("utf8");

  const sha256 = createHash("sha256").update(content).digest("hex");
  return `[binary policy file: ${file}; bytes=${content.length}; sha256=${sha256}]`;
}

export interface PolicyFileSymbolizeOptions {
  file: string;
  content: Buffer;
  targetPath: string;
  symbolMap: SymbolMap;
  dbPath?: string;
  callId?: string;
  journal?: SymbolMutationJournal;
}

export function symbolizePolicyFile({
  file,
  content,
  targetPath,
  symbolMap,
  dbPath,
  callId = "policy-load",
  journal,
}: PolicyFileSymbolizeOptions): string {
  const sym = allocateSymbol(symbolMap, {
    tool: "policy_file",
    field: symbolFieldForFile(file),
    value: policyFileSymbolValue(file, content),
    origin: `file:${file}`,
    callId,
  }, dbPath);
  const entry = symbolMap.symbols.get(sym);
  if (entry) journal?.inserted.set(sym, { ...entry });
  mkdirSync(dirname(targetPath), { recursive: true });
  if (existsSync(targetPath) && !lstatSync(targetPath).isFile()) {
    rmSync(targetPath, { recursive: true, force: true });
  }
  writeFileSync(targetPath, sym);
  return sym;
}
