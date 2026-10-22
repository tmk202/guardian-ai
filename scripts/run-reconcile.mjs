#!/usr/bin/env node
// Run the RECONCILE_NEEDED sweep once, by hand (Phase 1D / 1A.4).
//   node scripts/run-reconcile.mjs
// Read-backs go through the executor against the PayPal sandbox; nothing
// is re-written — a matched row only gets its flag cleared. Prints JSON.
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
const { runReconcileSweep } = await import("../tests-dist/lib/jobs/reconcile.js");

const store = getStore();
try {
  const report = await runReconcileSweep(store);
  console.log(JSON.stringify(report, null, 2));
} finally {
  store.close();
}
