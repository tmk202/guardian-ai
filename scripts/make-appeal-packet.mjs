#!/usr/bin/env node
// Build the appeal packet for one dispute case (Phase 4B).
//   node scripts/make-appeal-packet.mjs <case-id> [--out <file.md>]
// Assembles the packet from the real store (GUARDIAN_DB_PATH or
// data/guardian.db) plus live PayPal sandbox read-backs through the
// executor, and prints the Markdown (or writes it with --out). Gaps are
// listed as "MISSING: ..." — never filled in.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
try {
  process.loadEnvFile(path.join(root, ".env.local"));
} catch {
  /* .env.local optional for a dry local DB */
}

const args = process.argv.slice(2);
const caseId = args.find((a) => !a.startsWith("--"));
const outIdx = args.indexOf("--out");
const outFile = outIdx >= 0 ? args[outIdx + 1] : null;
if (!caseId) {
  console.error("usage: node scripts/make-appeal-packet.mjs <case-id> [--out <file.md>]");
  process.exit(2);
}

execFileSync(path.join(root, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.tests.json"], {
  cwd: root,
  stdio: "inherit",
});

const { getStore } = await import("../tests-dist/lib/db.js");
const { buildAppealPacket } = await import("../tests-dist/lib/workers/appeal-packet.js");

const store = getStore();
try {
  const packet = await buildAppealPacket(store, caseId);
  if (outFile) {
    fs.writeFileSync(outFile, packet.markdown);
    console.log(`packet written to ${outFile} (${packet.missing.length} missing item(s))`);
  } else {
    console.log(packet.markdown);
  }
} finally {
  store.close();
}
