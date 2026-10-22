#!/usr/bin/env node
// Run the overdue/collections scan once, by hand (Phase 3B).
//   node scripts/run-collections-scan.mjs
// Uses the real store (GUARDIAN_DB_PATH or data/guardian.db) and the real
// PayPal sandbox readers through the executor. Prints the scan report
// JSON. The scan only creates PENDING reminder approvals — nothing is
// sent to any customer by running this script.
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
const { runCollectionsScan } = await import("../tests-dist/lib/jobs/collections-scan.js");

const store = getStore();
try {
  const report = await runCollectionsScan(store);
  console.log(JSON.stringify(report, null, 2));
} finally {
  store.close();
}
