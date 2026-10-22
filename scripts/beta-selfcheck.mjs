#!/usr/bin/env node
// Beta self-check (Phase 4D): is this merchant setup actually complete?
//   node scripts/beta-selfcheck.mjs
// Verifies, with evidence: credentials + a real OAuth token, the scopes
// the app actually holds (Invoicing? Transaction Search?), the webhook
// registration and its URL, a store write/read round-trip, and the job
// secret. Prints a PASS/WARN/FAIL table; exit code 1 only on FAIL.
// Credential values are never printed.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
try {
  process.loadEnvFile(path.join(root, ".env.local"));
} catch {
  /* .env.local optional — missing credentials are a FAIL line, not a crash */
}

execFileSync(path.join(root, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.tests.json"], {
  cwd: root,
  stdio: "inherit",
});

const { runBetaSelfCheck, formatSelfCheck } = await import("../tests-dist/lib/selfcheck.js");

const result = await runBetaSelfCheck();
console.log(formatSelfCheck(result));
process.exit(result.ok ? 0 : 1);
