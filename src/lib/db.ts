// Durable store for Guardian (ARCHITECTURE-DETAIL.md §8) — Phase 1A.
//
// SQLite via node:sqlite (built into Node 24 — no native dependency to build).
// Callers only see the GuardianStore interface below, so swapping this
// implementation for Postgres later does not change executor/approvals code.
//
// Tables (per spec §8): merchants, memory_entries, cases, approvals, ledger,
// job_state, events_inbox. The ledger is the audit source of truth: every
// tool call, approval transition and block lands there.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_POLICY_YAML } from "./policy";

export interface MerchantRow {
  id: string;
  profile_json: string;
  policy_yaml: string;
  created_at: string;
}

export interface MemoryEntryRow {
  id: number;
  merchant_id: string;
  kind: string; // A..F per spec §2.2
  entity_key: string;
  body_json: string;
  source: string | null;
  confidence: number | null;
  superseded_by: number | null;
  updated_at: string;
}

export interface CaseRow {
  id: string; // = PayPal dispute id
  merchant_id: string;
  body_json: string;
  deadline_at: string | null;
  status: string | null;
  updated_at: string;
}

export type ApprovalStatus =
  | "PROPOSED"
  | "PENDING"
  | "APPROVED"
  | "EXECUTED"
  | "DISMISSED"
  | "EXPIRED";

export interface ApprovalRow {
  id: string;
  merchant_id: string;
  tool: string;
  args_json: string;
  args_hash: string;
  reason: string | null;
  amount_usd: number | null;
  status: ApprovalStatus;
  created_by: string;
  decided_by: string | null;
  created_at: string;
  decided_at: string | null;
  expires_at: string;
}

export type LedgerKind = "tool_call" | "approval" | "job" | "memory" | "system";

export interface LedgerRow {
  id: number;
  merchant_id: string;
  actor: string;
  kind: LedgerKind;
  tool: string | null;
  args_redacted_json: string | null;
  result_json: string | null;
  idempotency_key: string | null;
  reconcile_flag: number; // 1 = RECONCILE_NEEDED (spec §4.3 step 6)
  at: string;
}

export interface JobStateRow {
  job_name: string;
  merchant_id: string;
  cursor_json: string | null;
  last_run_at: string | null;
  last_status: string | null;
}

export interface EventRow {
  event_id: string;
  type: string;
  payload_json: string;
  processed_at: string | null;
}

export interface NewLedgerEntry {
  merchant_id: string;
  actor: string;
  kind: LedgerKind;
  tool?: string | null;
  args_redacted_json?: string | null;
  result_json?: string | null;
  idempotency_key?: string | null;
  reconcile_flag?: boolean;
}

export interface GuardianStore {
  merchants: {
    get(id: string): MerchantRow | undefined;
    upsert(row: MerchantRow): void;
    count(): number;
  };
  memory: {
    add(e: Omit<MemoryEntryRow, "id" | "updated_at">): number;
    update(id: number, fields: Partial<MemoryEntryRow>): void;
    list(merchantId: string, kind?: string): MemoryEntryRow[];
  };
  cases: {
    upsert(row: Omit<CaseRow, "updated_at">): void;
    get(id: string): CaseRow | undefined;
    list(merchantId: string): CaseRow[];
  };
  approvals: {
    insert(row: ApprovalRow): void;
    get(id: string): ApprovalRow | undefined;
    update(id: string, fields: Partial<ApprovalRow>): void;
    list(merchantId: string, status?: ApprovalStatus): ApprovalRow[];
  };
  ledger: {
    append(e: NewLedgerEntry): number;
    findSuccessByIdempotencyKey(key: string): LedgerRow | undefined;
    list(merchantId: string, limit?: number): LedgerRow[];
    byId(id: number): LedgerRow | undefined;
  };
  jobState: {
    get(jobName: string, merchantId: string): JobStateRow | undefined;
    set(row: JobStateRow): void;
  };
  events: {
    add(row: EventRow): boolean; // false when event_id already seen (dedupe)
    get(eventId: string): EventRow | undefined;
  };
  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS merchants (
  id TEXT PRIMARY KEY,
  profile_json TEXT NOT NULL,
  policy_yaml TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  entity_key TEXT NOT NULL,
  body_json TEXT NOT NULL,
  source TEXT,
  confidence REAL,
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
  amount_usd REAL,
  status TEXT NOT NULL,
  created_by TEXT NOT NULL,
  decided_by TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_approvals_merchant_status ON approvals(merchant_id, status);
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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

export class SqliteGuardianStore implements GuardianStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    if (dbPath !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);

    const d = this.db;
    this.merchants = {
      get: (id) =>
        d.prepare("SELECT * FROM merchants WHERE id = ?").get(id) as MerchantRow | undefined,
      upsert: (row) => {
        d.prepare(
          `INSERT INTO merchants (id, profile_json, policy_yaml, created_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET profile_json = excluded.profile_json, policy_yaml = excluded.policy_yaml`
        ).run(row.id, row.profile_json, row.policy_yaml, row.created_at);
      },
      count: () =>
        (d.prepare("SELECT COUNT(*) AS c FROM merchants").get() as { c: number }).c,
    };
    this.memory = {
      add: (e) => {
        const r = d
          .prepare(
            `INSERT INTO memory_entries (merchant_id, kind, entity_key, body_json, source, confidence, superseded_by, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(e.merchant_id, e.kind, e.entity_key, e.body_json, e.source, e.confidence, e.superseded_by, nowIso());
        return Number(r.lastInsertRowid);
      },
      update: (id, fields) => {
        const cols = Object.keys(fields).filter((c) => c !== "id");
        if (!cols.length) return;
        const sql = `UPDATE memory_entries SET ${cols.map((c) => `${c} = ?`).join(", ")}, updated_at = ? WHERE id = ?`;
        d.prepare(sql).run(...cols.map((c) => (fields as Record<string, unknown>)[c] as never), nowIso(), id);
      },
      list: (merchantId, kind) =>
        (kind
          ? d.prepare("SELECT * FROM memory_entries WHERE merchant_id = ? AND kind = ? ORDER BY id DESC").all(merchantId, kind)
          : d.prepare("SELECT * FROM memory_entries WHERE merchant_id = ? ORDER BY id DESC").all(merchantId)) as unknown as MemoryEntryRow[],
    };
    this.cases = {
      upsert: (row) => {
        d.prepare(
          `INSERT INTO cases (id, merchant_id, body_json, deadline_at, status, updated_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET body_json = excluded.body_json, deadline_at = excluded.deadline_at,
             status = excluded.status, updated_at = excluded.updated_at`
        ).run(row.id, row.merchant_id, row.body_json, row.deadline_at, row.status, nowIso());
      },
      get: (id) => d.prepare("SELECT * FROM cases WHERE id = ?").get(id) as CaseRow | undefined,
      list: (merchantId) =>
        d.prepare("SELECT * FROM cases WHERE merchant_id = ? ORDER BY deadline_at").all(merchantId) as unknown as CaseRow[],
    };
    this.approvals = {
      insert: (row) => {
        d.prepare(
          `INSERT INTO approvals (id, merchant_id, tool, args_json, args_hash, reason, amount_usd, status,
             created_by, decided_by, created_at, decided_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          row.id, row.merchant_id, row.tool, row.args_json, row.args_hash, row.reason,
          row.amount_usd, row.status, row.created_by, row.decided_by, row.created_at,
          row.decided_at, row.expires_at
        );
      },
      get: (id) => d.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as ApprovalRow | undefined,
      update: (id, fields) => {
        const cols = Object.keys(fields);
        if (!cols.length) return;
        const sql = `UPDATE approvals SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`;
        d.prepare(sql).run(...cols.map((c) => (fields as Record<string, unknown>)[c] as never), id);
      },
      list: (merchantId, status) =>
        (status
          ? d.prepare("SELECT * FROM approvals WHERE merchant_id = ? AND status = ? ORDER BY created_at DESC").all(merchantId, status)
          : d.prepare("SELECT * FROM approvals WHERE merchant_id = ? ORDER BY created_at DESC").all(merchantId)) as unknown as ApprovalRow[],
    };
    this.ledger = {
      append: (e) => {
        const r = d
          .prepare(
            `INSERT INTO ledger (merchant_id, actor, kind, tool, args_redacted_json, result_json, idempotency_key, reconcile_flag, at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            e.merchant_id, e.actor, e.kind, e.tool ?? null, e.args_redacted_json ?? null,
            e.result_json ?? null, e.idempotency_key ?? null, e.reconcile_flag ? 1 : 0, nowIso()
          );
        return Number(r.lastInsertRowid);
      },
      findSuccessByIdempotencyKey: (key) => {
        const rows = d
          .prepare("SELECT * FROM ledger WHERE idempotency_key = ? ORDER BY id DESC")
          .all(key) as unknown as LedgerRow[];
        return rows.find((row) => {
          try {
            return JSON.parse(row.result_json ?? "{}")?.ok === true;
          } catch {
            return false;
          }
        });
      },
      list: (merchantId, limit = 100) =>
        d.prepare("SELECT * FROM ledger WHERE merchant_id = ? ORDER BY id DESC LIMIT ?").all(merchantId, limit) as unknown as LedgerRow[],
      byId: (id) => d.prepare("SELECT * FROM ledger WHERE id = ?").get(id) as LedgerRow | undefined,
    };
    this.jobState = {
      get: (jobName, merchantId) =>
        d.prepare("SELECT * FROM job_state WHERE job_name = ? AND merchant_id = ?").get(jobName, merchantId) as JobStateRow | undefined,
      set: (row) => {
        d.prepare(
          `INSERT INTO job_state (job_name, merchant_id, cursor_json, last_run_at, last_status) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(job_name, merchant_id) DO UPDATE SET cursor_json = excluded.cursor_json,
             last_run_at = excluded.last_run_at, last_status = excluded.last_status`
        ).run(row.job_name, row.merchant_id, row.cursor_json, row.last_run_at, row.last_status);
      },
    };
    this.events = {
      add: (row) => {
        const r = d
          .prepare("INSERT OR IGNORE INTO events_inbox (event_id, type, payload_json, processed_at) VALUES (?, ?, ?, ?)")
          .run(row.event_id, row.type, row.payload_json, row.processed_at);
        return Number(r.changes) > 0;
      },
      get: (eventId) =>
        d.prepare("SELECT * FROM events_inbox WHERE event_id = ?").get(eventId) as EventRow | undefined,
    };
  }

  merchants!: GuardianStore["merchants"];
  memory!: GuardianStore["memory"];
  cases!: GuardianStore["cases"];
  approvals!: GuardianStore["approvals"];
  ledger!: GuardianStore["ledger"];
  jobState!: GuardianStore["jobState"];
  events!: GuardianStore["events"];

  close(): void {
    this.db.close();
  }
}

export function createStore(dbPath: string): GuardianStore {
  return new SqliteGuardianStore(dbPath);
}

export const DEFAULT_MERCHANT_ID =
  process.env.PAYPAL_MERCHANT_ID || "sandbox-merchant";

export function defaultDbPath(): string {
  return (
    process.env.GUARDIAN_DB_PATH ||
    path.join(process.cwd(), "data", "guardian.db")
  );
}

let singleton: GuardianStore | null = null;

/**
 * Process-wide store. Seeds the sandbox merchant (Part 8 merchants row) the
 * first time it is opened so approvals/ledger always have a merchant to
 * attach to.
 */
export function getStore(): GuardianStore {
  if (singleton) return singleton;
  const store = createStore(defaultDbPath());
  if (!store.merchants.get(DEFAULT_MERCHANT_ID)) {
    store.merchants.upsert({
      id: DEFAULT_MERCHANT_ID,
      profile_json: JSON.stringify({
        business_name: "Test Store",
        environment: process.env.PAYPAL_ENVIRONMENT || "SANDBOX",
        paypal_email: process.env.PAYPAL_SANDBOX_BUSINESS_EMAIL || null,
      }),
      policy_yaml: DEFAULT_POLICY_YAML,
      created_at: nowIso(),
    });
  }
  singleton = store;
  return singleton;
}
