#!/usr/bin/env node
// Run the ScamShield inbound scan once, by hand (Phase 4C).
//   node scripts/run-scan-inbound.mjs
// Uses the real store (GUARDIAN_DB_PATH or data/guardian.db) and the real
// PayPal sandbox readers through the executor. Prints the scan report
// JSON: direction split, a scored verdict per inbound invoice, and the
// Customer Memory (kind B) refresh result.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
try {
  process.loadEnvFile(path.join(root, ".env.local"));
} catch {
  /* .env.local optional for a dry local DB */
}

execFileSync(path.join(root, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.tests.json"], {
  cwd: root,
  stdio: "inherit",
});

const { getStore } = await import("../tests-dist/lib/db.js");
const { runScanInbound } = await import("../tests-dist/lib/jobs/scan-inbound.js");

const store = getStore();
try {
  const report = await runScanInbound(store);
  console.log(JSON.stringify(report, null, 2));
} finally {
  store.close();
}
