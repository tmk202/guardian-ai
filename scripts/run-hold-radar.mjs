#!/usr/bin/env node
// Run the hold scan once, by hand (Phase 3A).
//   node scripts/run-hold-radar.mjs
// Uses the real store (GUARDIAN_DB_PATH or data/guardian.db) and the real
// PayPal sandbox readers through the executor. Prints the scan report
// JSON. When Transaction Search is not enabled on the app the report
// status is "unavailable" with the reason — that is the honest result.
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
const { runHoldRadar } = await import("../tests-dist/lib/jobs/hold-radar.js");

const store = getStore();
try {
  const report = await runHoldRadar(store);
  console.log(JSON.stringify(report, null, 2));
} finally {
  store.close();
}
