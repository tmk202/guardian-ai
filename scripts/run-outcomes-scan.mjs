#!/usr/bin/env node
// Run the outcome scan once, by hand (Phase 5A).
//   node scripts/run-outcomes-scan.mjs
// Uses the real store (GUARDIAN_DB_PATH or data/guardian.db) and the real
// PayPal sandbox dispute read-backs through the executor. Prints the scan
// report: which tracked cases PayPal now reports RESOLVED (an outcome was
// recorded to memory kind E for each), which are still open (nothing
// recorded, nothing guessed), and any read errors.
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
const { runOutcomesScan } = await import("../tests-dist/lib/jobs/outcomes-scan.js");

const store = getStore();
try {
  const report = await runOutcomesScan(store);
  console.log(JSON.stringify(report, null, 2));
} finally {
  store.close();
}
