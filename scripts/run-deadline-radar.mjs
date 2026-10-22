#!/usr/bin/env node
// Run the dispute deadline radar once, by hand (Phase 1D).
//   node scripts/run-deadline-radar.mjs
// Uses the real store (GUARDIAN_DB_PATH or data/guardian.db) and reads
// missing deadlines back from the PayPal sandbox via get_dispute through
// the executor — read-only. Prints the JSON report.
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
const { runDeadlineRadar } = await import("../tests-dist/lib/jobs/deadline-radar.js");

const store = getStore();
try {
  const report = await runDeadlineRadar(store);
  console.log(JSON.stringify(report, null, 2));
} finally {
  store.close();
}
