#!/usr/bin/env node
// Test runner: compile the Phase 1 foundation modules (db/policy/hash/
// approvals/executor) with the project's own TypeScript into tests-dist/,
// then run the node:test suites in tests/. No extra dependencies.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsc = path.join(root, "node_modules", ".bin", "tsc");

execFileSync(tsc, ["-p", "tsconfig.tests.json"], { cwd: root, stdio: "inherit" });
execFileSync("node", ["--test", "tests/*.test.mjs"], { cwd: root, stdio: "inherit" });
