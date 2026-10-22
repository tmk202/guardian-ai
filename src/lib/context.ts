// Context assembly (ARCHITECTURE-DETAIL.md §1.3) — Phase 1C.
//
// Context is a finite resource: each Coordinator turn loads only what is
// relevant to the task at hand —
//   1. a compact merchant snapshot (~300 words max),
//   2. at most MAX_MEMORY_ITEMS memory entries matching the entities in the
//      task (customer email, invoice id, dispute id), newest first,
//   3. open work: PENDING approvals (from the Phase 1B store) and tracked
//      cases whose deadline falls within the next 7 days.
// The return value carries a size report so callers (and tests) can see how
// much was loaded instead of guessing.
import { DEFAULT_MERCHANT_ID, type GuardianStore } from "./db";
import {
  getMerchantProfile,
  memoryRead,
  type MemoryEntry,
} from "./memory";

export const MAX_MEMORY_ITEMS = 8;
export const DEADLINE_WINDOW_DAYS = 7;

export interface ContextTask {
  /** free-text user request / internal task brief */
  text?: string;
  /** entities known upfront (skips extraction) */
  entities?: string[];
  merchantId?: string;
  /** reference time for deadline math (tests inject this) */
  now?: Date;
}

export interface OpenWork {
  pendingApprovals: {
    id: string;
    tool: string;
    amountUsd: number | null;
    reason: string | null;
    expiresAt: string;
  }[];
  upcomingCases: {
    id: string;
    status: string | null;
    deadlineAt: string;
    daysLeft: number;
  }[];
}

export interface AssembledContext {
  merchantId: string;
  entities: string[];
  merchantProfile: MemoryEntry | undefined;
  merchantSnapshot: string;
  relevantMemory: MemoryEntry[];
  openWork: OpenWork;
  /** ready-to-inject text block for the Coordinator prompt */
  text: string;
  stats: {
    memoryCount: number;
    snapshotWords: number;
    charCount: number;
  };
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const INVOICE_RE = /\bINV2-[A-Z0-9][A-Z0-9-]*\b/gi;
const CASE_RE = /\bPP-[A-Z]-[A-Z0-9][A-Z0-9-]*\b/gi;

/** Pull the entities §1.3 queries memory by out of a free-text task. */
export function extractEntities(text: string): string[] {
  const found: string[] = [];
  for (const re of [EMAIL_RE, INVOICE_RE, CASE_RE]) {
    for (const m of text.matchAll(re)) {
      const v = m[0];
      if (!found.includes(v)) found.push(v);
    }
  }
  return found;
}

function renderMerchantSnapshot(
  store: GuardianStore,
  merchantId: string,
  profile: MemoryEntry | undefined
): string {
  if (!profile) {
    const row = store.merchants.get(merchantId);
    let name = merchantId;
    try {
      name = JSON.parse(row?.profile_json ?? "{}").business_name ?? merchantId;
    } catch {
      /* keep id as name */
    }
    return `Merchant: ${name} (${merchantId}). No memory profile recorded yet.`;
  }
  const b = profile.body;
  const s = (v: unknown) => (v === null || v === undefined ? "—" : String(v));
  const lines = [
    `Shop: ${s(b.business_name)} (PayPal merchant ${s(b.merchant_id)}, ${s(b.environment)}).`,
    `PayPal email: ${s(b.paypal_email)}. Timezone: ${s(b.timezone)}. Currency: ${s(b.currency)}.`,
    `Approvals: sensitive actions need human approval; auto-approve threshold $${s(b.approval_threshold_usd)}.`,
    `Reminder tone: ${s(b.reminder_tone)}. Quiet hours: ${s(b.quiet_hours)}. Daily digest: ${s(b.daily_digest_time)}.`,
  ];
  if (b.notes) lines.push(`Notes: ${s(b.notes)}`);
  return lines.join("\n");
}

function compactBody(e: MemoryEntry): string {
  const json = JSON.stringify(e.body);
  return json.length > 600 ? json.slice(0, 600) + "…" : json;
}

export function assembleContext(
  store: GuardianStore,
  task: ContextTask | string
): AssembledContext {
  const t: ContextTask = typeof task === "string" ? { text: task } : task;
  const merchantId = t.merchantId ?? DEFAULT_MERCHANT_ID;
  const now = t.now ?? new Date();

  const entities = [
    ...new Set([...(t.entities ?? []), ...extractEntities(t.text ?? "")]),
  ];

  const profile = getMerchantProfile(store, merchantId);
  const merchantSnapshot = renderMerchantSnapshot(store, merchantId, profile);

  // §1.3 point 3: memory relevant to the task's entities, capped. Without
  // any entity, fall back to the freshest case/episodic entries so the
  // Coordinator still walks in knowing the shop's open threads.
  let relevantMemory: MemoryEntry[];
  if (entities.length) {
    // Entity-driven only: §1.3 forbids loading the whole memory "just in case".
    relevantMemory = memoryRead(store, merchantId, {
      entities,
      limit: MAX_MEMORY_ITEMS,
    }).filter((e) => e.kind !== "A"); // the profile is already the snapshot
  } else {
    relevantMemory = memoryRead(store, merchantId, { limit: MAX_MEMORY_ITEMS })
      .filter((e) => e.kind !== "A")
      .slice(0, MAX_MEMORY_ITEMS);
  }

  // §1.3 point 4: open work — pending approvals + cases nearing deadline.
  const pendingApprovals = store
    .approvals.list(merchantId, "PENDING")
    .map((a) => ({
      id: a.id,
      tool: a.tool,
      amountUsd: a.amount_usd,
      reason: a.reason,
      expiresAt: a.expires_at,
    }));
  const windowMs = DEADLINE_WINDOW_DAYS * 24 * 3600_000;
  const upcomingCases = store
    .cases.list(merchantId)
    .filter((c) => {
      if (!c.deadline_at) return false;
      if (c.status && /closed|resolved/i.test(c.status)) return false;
      const d = new Date(c.deadline_at).getTime() - now.getTime();
      return d >= -24 * 3600_000 && d <= windowMs;
    })
    .map((c) => ({
      id: c.id,
      status: c.status,
      deadlineAt: c.deadline_at as string,
      daysLeft: Math.max(
        0,
        Math.round((new Date(c.deadline_at as string).getTime() - now.getTime()) / (24 * 3600_000))
      ),
    }));

  const openWork: OpenWork = { pendingApprovals, upcomingCases };

  const sections: string[] = ["MERCHANT SNAPSHOT", merchantSnapshot];
  if (pendingApprovals.length || upcomingCases.length) {
    const lines: string[] = ["", "OPEN WORK"];
    for (const a of pendingApprovals) {
      lines.push(
        `- Approval PENDING: ${a.tool} (id ${a.id}${a.amountUsd != null ? `, $${a.amountUsd}` : ""}, expires ${a.expiresAt})`
      );
    }
    for (const c of upcomingCases) {
      lines.push(`- Case ${c.id}: deadline ${c.deadlineAt} (${c.daysLeft}d left, status ${c.status ?? "—"})`);
    }
    sections.push(...lines);
  }
  if (relevantMemory.length) {
    sections.push("", "RELEVANT MEMORY");
    for (const e of relevantMemory) {
      sections.push(`- [${e.kind} · ${e.entityKey}] ${compactBody(e)}`);
    }
  }
  const text = sections.join("\n");

  return {
    merchantId,
    entities,
    merchantProfile: profile,
    merchantSnapshot,
    relevantMemory,
    openWork,
    text,
    stats: {
      memoryCount: relevantMemory.length,
      snapshotWords: merchantSnapshot.split(/\s+/).filter(Boolean).length,
      charCount: text.length,
    },
  };
}
