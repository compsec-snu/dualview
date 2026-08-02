#!/usr/bin/env node
import { readFileSync, unlinkSync } from "node:fs";
import { spawn } from "node:child_process";

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

const specPath = process.argv[2];
if (!specPath) fail("[DualView exec argv] missing spec path");

let spec;
try {
  spec = JSON.parse(readFileSync(specPath, "utf8"));
} catch (err) {
  fail(`[DualView exec argv] failed to read spec: ${err.message}`);
}

try {
  unlinkSync(specPath);
} catch {
  // Best-effort cleanup. The spec path is random and mode 0600.
}

const command = spec.command;
const args = Array.isArray(spec.args) ? spec.args : [];
const hasProgram = spec.program && typeof spec.program === "object";
if (!hasProgram && (typeof command !== "string" || command.length === 0)) {
  fail("[DualView exec argv] invalid command", 127);
}
if (!args.every((arg) => typeof arg === "string")) {
  fail("[DualView exec argv] invalid argv");
}

const env = { ...process.env };
if (spec.env && typeof spec.env === "object" && !Array.isArray(spec.env)) {
  for (const [key, value] of Object.entries(spec.env)) {
    if (typeof value === "string") env[key] = value;
  }
}

function runCommand(argv) {
  return new Promise((resolve) => {
    if (!Array.isArray(argv) || argv.length === 0 || !argv.every((arg) => typeof arg === "string")) {
      resolve(127);
      return;
    }

    const child = spawn(argv[0], argv.slice(1), {
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);

    child.on("error", (err) => {
      process.stderr.write(`${err.message}\n`);
      resolve(err.code === "ENOENT" ? 127 : 1);
    });

    child.on("close", (code, signal) => {
      if (signal) {
        process.stderr.write(`[DualView exec argv] child terminated by signal ${signal}\n`);
        resolve(128);
        return;
      }
      resolve(code ?? 1);
    });
  });
}

async function runProgram(program) {
  if (!program || typeof program !== "object") {
    return runCommand([command, ...args]);
  }
  if (program.kind === "unsupported") {
    process.stderr.write(`[DualView exec argv] unsupported symbolized shell construct: ${program.reason}`);
    if (program.evidence) process.stderr.write(` (${program.evidence})`);
    process.stderr.write("\n");
    return 126;
  }
  if (program.kind !== "program" || !Array.isArray(program.steps) || program.steps.length === 0) {
    process.stderr.write("[DualView exec argv] invalid program\n");
    return 127;
  }

  let lastStatus = 0;
  for (let i = 0; i < program.steps.length; i++) {
    const step = program.steps[i];
    if (!step || typeof step !== "object") return 127;
    if (i > 0) {
      if (step.op === "&&" && lastStatus !== 0) continue;
      if (step.op === "||" && lastStatus === 0) continue;
      if (step.op !== "&&" && step.op !== "||") return 127;
    }
    lastStatus = await runCommand(step.argv);
  }
  return lastStatus;
}

const status = await runProgram(spec.program);
process.exit(status);
