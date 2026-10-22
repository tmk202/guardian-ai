#!/usr/bin/env node
// Run the Analyst worker once against the real PayPal sandbox (Phase 2B
// verification).   node scripts/run-analyst.mjs [days]
// Reads credentials from .env.local (never printed), queries through the
// executor-backed readers, prints the §3.4 JSON report.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
process.loadEnvFile(path.join(root, ".env.local"));

execFileSync(path.join(root, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.tests.json"], {
  cwd: root,
  stdio: "inherit",
});

const { getStore } = await import("../tests-dist/lib/db.js");
const { runAnalyst, executorReaders, trailingRange } = await import(
  "../tests-dist/lib/workers/analyst.js"
);

const days = Number(process.argv[2] ?? 30);
const store = getStore();
try {
  const report = await runAnalyst(store, executorReaders(), trailingRange(days));
  console.log(JSON.stringify(report, null, 2));
} finally {
  store.close();
}
