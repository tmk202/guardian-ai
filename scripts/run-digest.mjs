#!/usr/bin/env node
// Build the morning digest once, by hand (Phase 2C).
//   node scripts/run-digest.mjs
// Uses the real store (GUARDIAN_DB_PATH or data/guardian.db) and the real
// PayPal sandbox readers through the executor. Prints the digest JSON and
// its text summary. Idempotent per merchant-local day.
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
const { runDigest } = await import("../tests-dist/lib/jobs/digest.js");

const store = getStore();
try {
  const report = await runDigest(store);
  console.log(JSON.stringify(report, null, 2));
  console.log("\n--- text ---\n" + report.text);
} finally {
  store.close();
}
