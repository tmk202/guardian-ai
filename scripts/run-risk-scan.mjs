#!/usr/bin/env node
// Run the account risk scan once, by hand (Phase 4A).
//   node scripts/run-risk-scan.mjs
// Uses the real store (GUARDIAN_DB_PATH or data/guardian.db) and the real
// PayPal sandbox readers through the executor. Prints the scan report
// JSON: level LOW/WATCH/HIGH with a reason + fix-it action per signal,
// and signals_missing for anything Guardian could not measure.
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
const { runRiskScan } = await import("../tests-dist/lib/jobs/risk-scan.js");

const store = getStore();
try {
  const report = await runRiskScan(store);
  console.log(JSON.stringify(report, null, 2));
} finally {
  store.close();
}
