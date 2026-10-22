// Postgres store (Phase 2A) — a second GuardianStore implementation behind
// the exact same interface as the SQLite one (src/lib/db.ts §8).
//
// Why a worker bridge: the GuardianStore contract is synchronous (it was
// shaped by node:sqlite's sync API), while `pg` is promise-only. Rather
// than rewriting every caller (executor, approvals, memory, jobs) to
// async, this module runs the pg pool in a dedicated worker thread and
// the main thread blocks on Atomics.wait for each query — the standard
// sync-bridge pattern in Node. Queries here are tiny bookkeeping writes
// and reads; nothing user-facing streams through this path.
//
// Selection: getStore() in db.ts picks this implementation when
// DATABASE_URL is set, SQLite otherwise. Callers never see the difference.
import { Worker } from "node:worker_threads";
import type {
  GuardianStore,
  MerchantRow,
  MemoryEntryRow,
  CaseRow,
  ApprovalRow,
  LedgerRow,
  JobStateRow,
  EventRow,
} from "./db";

// ---------------------------------------------------------------------------
// Sync bridge (main-thread side)
// ---------------------------------------------------------------------------

const CTRL_BYTES = 64;
const DATA_BYTES = 16 * 1024 * 1024; // request/response payloads are small JSON
const IDX_STATE = 0; // 0 idle · 1 request pending · 2 response ready
const IDX_REQ_LEN = 1;
const IDX_RES_LEN = 2;
const IDX_ERR = 3;

const WORKER_CODE = `
const { workerData } = require("node:worker_threads");
let Pool;
try { Pool = require("pg").Pool; }
catch (e) { Pool = null; }
const control = new Int32Array(workerData.control);
const data = new Uint8Array(workerData.data);
const pools = new Map();
const enc = new TextEncoder();
const dec = new TextDecoder();
function poolFor(conn) {
  if (!pools.has(conn)) pools.set(conn, new Pool({ connectionString: conn, max: 2 }));
  return pools.get(conn);
}
function writeResponse(obj, isErr) {
  const bytes = enc.encode(JSON.stringify(obj));
  if (bytes.length > data.length) {
    const msg = enc.encode(JSON.stringify({ error: "response too large" }));
    data.set(msg); control[2] = msg.length; control[3] = 1;
  } else {
    data.set(bytes); control[2] = bytes.length; control[3] = isErr ? 1 : 0;
  }
  Atomics.store(control, 0, 2);
  Atomics.notify(control, 0);
}
(async () => {
  while (true) {
    Atomics.wait(control, 0, 0); // sleep while idle
    if (Atomics.load(control, 0) !== 1) continue;
    let req;
    try {
      req = JSON.parse(dec.decode(data.subarray(0, control[1])));
      if (req.op === "ping") {
        if (!Pool) throw new Error("pg module failed to load in worker");
        writeResponse({ pong: true }, false);
      } else {
        const res = await poolFor(req.conn).query(req.sql, req.params || []);
        writeResponse({ rows: res.rows, rowCount: res.rowCount }, false);
      }
    } catch (e) {
      writeResponse({ error: e && e.message ? e.message : String(e) }, true);
    }
    Atomics.wait(control, 0, 2); // sleep until main thread resets to idle
  }
})();
`;

interface Bridge {
  control: Int32Array;
  data: Uint8Array;
  worker: Worker;
}

let bridge: Bridge | null = null;

function getBridge(): Bridge {
  if (bridge) return bridge;
  const controlSAB = new SharedArrayBuffer(CTRL_BYTES);
  const dataSAB = new SharedArrayBuffer(DATA_BYTES);
  // The eval worker runs as CommonJS, so it resolves "pg" itself with a
  // plain require() (see WORKER_CODE) — no path plumbing needed here, and
  // no import.meta, which the CommonJS test build forbids.
  const worker = new Worker(WORKER_CODE, {
    eval: true,
    workerData: { control: controlSAB, data: dataSAB },
  });
  worker.unref();
  bridge = {
    control: new Int32Array(controlSAB),
    data: new Uint8Array(dataSAB),
    worker,
  };
  // Boot check: proves the worker is alive and `pg` loaded inside it.
  querySyncRaw(bridge, { op: "ping" });
  return bridge;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function querySyncRaw(
  b: Bridge,
  req: { op?: string; conn?: string; sql?: string; params?: unknown[] }
): { rows: any[]; rowCount: number } {
  const bytes = enc.encode(JSON.stringify(req));
  if (bytes.length > b.data.length) throw new Error("db-pg: request too large");
  b.data.set(bytes);
  b.control[IDX_REQ_LEN] = bytes.length;
  Atomics.store(b.control, IDX_STATE, 1);
  Atomics.notify(b.control, IDX_STATE);
  const deadline = Date.now() + 60_000;
  while (Atomics.load(b.control, IDX_STATE) === 1) {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error("db-pg: query timed out (worker unresponsive)");
    Atomics.wait(b.control, IDX_STATE, 1, Math.min(left, 1000));
  }
  const len = b.control[IDX_RES_LEN];
  const isErr = b.control[IDX_ERR] === 1;
  const text = dec.decode(b.data.subarray(0, len));
  Atomics.store(b.control, IDX_STATE, 0);
  Atomics.notify(b.control, IDX_STATE);
  const parsed = JSON.parse(text);
  if (isErr) throw new Error(`db-pg: ${parsed.error ?? "unknown worker error"}`);
  return parsed;
}

function querySync(
  conn: string,
  sql: string,
  params: unknown[] = []
): { rows: any[]; rowCount: number } {
  return querySyncRaw(getBridge(), {
    conn,
    sql,
    params: params.map((p) => (p === undefined ? null : p)),
  });
}

// ---------------------------------------------------------------------------
// Schema — same 7 tables as the SQLite DDL, Postgres dialect (idempotent)
// ---------------------------------------------------------------------------

const PG_SCHEMA = `
CREATE TABLE IF NOT EXISTS merchants (
  id TEXT PRIMARY KEY,
  profile_json TEXT NOT NULL,
  policy_yaml TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_entries (
  id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  entity_key TEXT NOT NULL,
  body_json TEXT NOT NULL,
  source TEXT,
  confidence DOUBLE PRECISION,
  superseded_by INTEGER,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_merchant ON memory_entries(merchant_id, kind, entity_key);
CREATE TABLE IF NOT EXISTS cases (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  body_json TEXT NOT NULL,
  deadline_at TEXT,
  status TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  args_json TEXT NOT NULL,
  args_hash TEXT NOT NULL,
  reason TEXT,
  amount_usd DOUBLE PRECISION,
  status TEXT NOT NULL,
  created_by TEXT NOT NULL,
  decided_by TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_approvals_merchant_status ON approvals(merchant_id, status);
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  kind TEXT NOT NULL,
  tool TEXT,
  args_redacted_json TEXT,
  result_json TEXT,
  idempotency_key TEXT,
  reconcile_flag INTEGER NOT NULL DEFAULT 0,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_idem ON ledger(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_ledger_merchant_at ON ledger(merchant_id, at);
CREATE TABLE IF NOT EXISTS job_state (
  job_name TEXT NOT NULL,
  merchant_id TEXT NOT NULL,
  cursor_json TEXT,
  last_run_at TEXT,
  last_status TEXT,
  PRIMARY KEY (job_name, merchant_id)
);
CREATE TABLE IF NOT EXISTS events_inbox (
  event_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  processed_at TEXT
);
`;

const nowIso = () => new Date().toISOString();

export class PgGuardianStore implements GuardianStore {
  private conn: string;
  private closed = false;

  constructor(connectionString: string) {
    this.conn = connectionString;
    this.q(PG_SCHEMA);
    const q = (sql: string, params?: unknown[]) => this.q(sql, params);

    this.merchants = {
      get: (id) =>
        q("SELECT * FROM merchants WHERE id = $1", [id]).rows[0] as MerchantRow | undefined,
      upsert: (row) => {
        q(
          `INSERT INTO merchants (id, profile_json, policy_yaml, created_at) VALUES ($1, $2, $3, $4)
           ON CONFLICT(id) DO UPDATE SET profile_json = excluded.profile_json, policy_yaml = excluded.policy_yaml`,
          [row.id, row.profile_json, row.policy_yaml, row.created_at]
        );
      },
      count: () =>
        (q("SELECT COUNT(*) AS c FROM merchants").rows[0] as { c: number }).c,
    };
    this.memory = {
      add: (e) => {
        const r = q(
          `INSERT INTO memory_entries (merchant_id, kind, entity_key, body_json, source, confidence, superseded_by, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
          [e.merchant_id, e.kind, e.entity_key, e.body_json, e.source, e.confidence, e.superseded_by, nowIso()]
        );
        return Number(r.rows[0].id);
      },
      update: (id, fields) => {
        const cols = Object.keys(fields).filter((c) => c !== "id");
        if (!cols.length) return;
        const sets = cols.map((c, i) => `${c} = $${i + 1}`).join(", ");
        q(
          `UPDATE memory_entries SET ${sets}, updated_at = $${cols.length + 1} WHERE id = $${cols.length + 2}`,
          [...cols.map((c) => (fields as Record<string, unknown>)[c]), nowIso(), id]
        );
      },
      list: (merchantId, kind) =>
        (kind
          ? q("SELECT * FROM memory_entries WHERE merchant_id = $1 AND kind = $2 ORDER BY id DESC", [merchantId, kind])
          : q("SELECT * FROM memory_entries WHERE merchant_id = $1 ORDER BY id DESC", [merchantId])
        ).rows as MemoryEntryRow[],
    };
    this.cases = {
      upsert: (row) => {
        q(
          `INSERT INTO cases (id, merchant_id, body_json, deadline_at, status, updated_at) VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT(id) DO UPDATE SET body_json = excluded.body_json, deadline_at = excluded.deadline_at,
             status = excluded.status, updated_at = excluded.updated_at`,
          [row.id, row.merchant_id, row.body_json, row.deadline_at, row.status, nowIso()]
        );
      },
      get: (id) => q("SELECT * FROM cases WHERE id = $1", [id]).rows[0] as CaseRow | undefined,
      list: (merchantId) =>
        q("SELECT * FROM cases WHERE merchant_id = $1 ORDER BY deadline_at", [merchantId]).rows as CaseRow[],
    };
    this.approvals = {
      insert: (row) => {
        q(
          `INSERT INTO approvals (id, merchant_id, tool, args_json, args_hash, reason, amount_usd, status,
             created_by, decided_by, created_at, decided_at, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [
            row.id, row.merchant_id, row.tool, row.args_json, row.args_hash, row.reason,
            row.amount_usd, row.status, row.created_by, row.decided_by, row.created_at,
            row.decided_at, row.expires_at,
          ]
        );
      },
      get: (id) => q("SELECT * FROM approvals WHERE id = $1", [id]).rows[0] as ApprovalRow | undefined,
      update: (id, fields) => {
        const cols = Object.keys(fields);
        if (!cols.length) return;
        const sets = cols.map((c, i) => `${c} = $${i + 1}`).join(", ");
        q(`UPDATE approvals SET ${sets} WHERE id = $${cols.length + 1}`, [
          ...cols.map((c) => (fields as Record<string, unknown>)[c]),
          id,
        ]);
      },
      list: (merchantId, status) =>
        (status
          ? q("SELECT * FROM approvals WHERE merchant_id = $1 AND status = $2 ORDER BY created_at DESC", [merchantId, status])
          : q("SELECT * FROM approvals WHERE merchant_id = $1 ORDER BY created_at DESC", [merchantId])
        ).rows as ApprovalRow[],
    };
    this.ledger = {
      append: (e) => {
        const r = q(
          `INSERT INTO ledger (merchant_id, actor, kind, tool, args_redacted_json, result_json, idempotency_key, reconcile_flag, at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
          [
            e.merchant_id, e.actor, e.kind, e.tool ?? null, e.args_redacted_json ?? null,
            e.result_json ?? null, e.idempotency_key ?? null, e.reconcile_flag ? 1 : 0, nowIso(),
          ]
        );
        return Number(r.rows[0].id);
      },
      findSuccessByIdempotencyKey: (key) => {
        const rows = q("SELECT * FROM ledger WHERE idempotency_key = $1 ORDER BY id DESC", [key])
          .rows as LedgerRow[];
        return rows.find((row) => {
          try {
            return JSON.parse(row.result_json ?? "{}")?.ok === true;
          } catch {
            return false;
          }
        });
      },
      list: (merchantId, limit = 100) =>
        q("SELECT * FROM ledger WHERE merchant_id = $1 ORDER BY id DESC LIMIT $2", [merchantId, limit])
          .rows as LedgerRow[],
      byId: (id) => q("SELECT * FROM ledger WHERE id = $1", [id]).rows[0] as LedgerRow | undefined,
      flagged: (merchantId) =>
        q("SELECT * FROM ledger WHERE merchant_id = $1 AND reconcile_flag = 1 ORDER BY id", [merchantId])
          .rows as LedgerRow[],
      setReconcileFlag: (id, flag) => {
        q("UPDATE ledger SET reconcile_flag = $1 WHERE id = $2", [flag ? 1 : 0, id]);
      },
    };
    this.jobState = {
      get: (jobName, merchantId) =>
        q("SELECT * FROM job_state WHERE job_name = $1 AND merchant_id = $2", [jobName, merchantId])
          .rows[0] as JobStateRow | undefined,
      set: (row) => {
        q(
          `INSERT INTO job_state (job_name, merchant_id, cursor_json, last_run_at, last_status) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT(job_name, merchant_id) DO UPDATE SET cursor_json = excluded.cursor_json,
             last_run_at = excluded.last_run_at, last_status = excluded.last_status`,
          [row.job_name, row.merchant_id, row.cursor_json, row.last_run_at, row.last_status]
        );
      },
    };
    this.events = {
      add: (row) => {
        const r = q(
          "INSERT INTO events_inbox (event_id, type, payload_json, processed_at) VALUES ($1, $2, $3, $4) ON CONFLICT (event_id) DO NOTHING",
          [row.event_id, row.type, row.payload_json, row.processed_at]
        );
        return (r.rowCount ?? 0) > 0;
      },
      get: (eventId) =>
        q("SELECT * FROM events_inbox WHERE event_id = $1", [eventId]).rows[0] as EventRow | undefined,
      markProcessed: (eventId, at) => {
        q("UPDATE events_inbox SET processed_at = $1 WHERE event_id = $2", [at ?? nowIso(), eventId]);
      },
    };
  }

  private q(sql: string, params: unknown[] = []): { rows: any[]; rowCount: number } {
    if (this.closed) throw new Error("db-pg: store is closed");
    return querySync(this.conn, sql, params);
  }

  merchants!: GuardianStore["merchants"];
  memory!: GuardianStore["memory"];
  cases!: GuardianStore["cases"];
  approvals!: GuardianStore["approvals"];
  ledger!: GuardianStore["ledger"];
  jobState!: GuardianStore["jobState"];
  events!: GuardianStore["events"];

  close(): void {
    // The worker + pools are process-shared (keyed by connection string);
    // closing one store must not kill the bridge for the others.
    this.closed = true;
  }
}

export function createPgStore(connectionString: string): GuardianStore {
  return new PgGuardianStore(connectionString);
}
