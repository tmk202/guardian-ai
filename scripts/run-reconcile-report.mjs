#!/usr/bin/env node
// Run the reconciliation report once, by hand (Phase 5C).
//   node scripts/run-reconcile-report.mjs
// Uses the real store (GUARDIAN_DB_PATH or data/guardian.db) and real
// PayPal sandbox read-backs through the executor. Prints the report:
// every executed write checked against PayPal's current state —
// matched / mismatched (flagged RECONCILE_NEEDED) / unverifiable.
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
const { runReconcileReport } = await import("../tests-dist/lib/jobs/reconcile-report.js");

const store = getStore();
try {
  const report = await runReconcileReport(store);
  console.log(JSON.stringify(report, null, 2));
  console.log("\n--- text ---\n" + report.text);
} finally {
  store.close();
}
