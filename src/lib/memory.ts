// Memory core (ARCHITECTURE-DETAIL.md §2) — Phase 1C.
//
// Memory is curated, durable knowledge — NOT a copy of the chat. The ledger
// stays the source of truth for what happened; memory is the distilled layer
// the Coordinator loads per turn (context.ts). This module owns the write
// rules of §2.4 on top of GuardianStore.memory:
//
//  1. Durable facts only. Kinds A (merchant profile), C (case memory) and
//     D (episodic notes) land here in Phase 1; B/E/F arrive in later phases.
//     Process data (tool-call trails, progress) belongs to the ledger and is
//     rejected here.
//  2. Inferences must be labelled (`inferred: true` in the body) and carry
//     low confidence — they never pose as verified facts.
//  3. No secrets. A write whose body contains credential-looking fields is
//     rejected outright; the error names the field path, never the value.
//  4. Contradictions: the newer sourced fact wins, but the old entry is
//     marked `superseded_by` — never silently deleted. Kinds A and C are
//     single-record-per-entity, so a differing write for the same entity
//     supersedes the active one; kind D is a timeline and appends.
//  Every write requires a source, so any entry can answer "how do you know?"
import type { GuardianStore, MemoryEntryRow } from "./db";
import { canonicalJson } from "./hash";

export type MemoryKind = "A" | "C" | "D";
export const MEMORY_KINDS_PHASE1: readonly MemoryKind[] = ["A", "C", "D"];

export class MemoryWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryWriteError";
  }
}

export interface MemoryWriteInput {
  merchantId: string;
  kind: MemoryKind;
  entityKey: string;
  body: Record<string, unknown>;
  /** required — where this fact comes from (user statement, POC run, tool result…) */
  source: string;
  /** 0..1; defaults to 0.9. Inferred facts are capped at 0.5. */
  confidence?: number;
  /** explicitly supersede this entry id (any kind) */
  supersedes?: number;
}

export interface MemoryWriteResult {
  id: number;
  created: boolean;
  supersededIds: number[];
}

export interface MemoryEntry {
  id: number;
  merchantId: string;
  kind: string;
  entityKey: string;
  body: Record<string, unknown>;
  source: string | null;
  confidence: number | null;
  supersededBy: number | null;
  updatedAt: string;
}

// --- §2.4 rule 3: secret / credential detection ----------------------------
// Key names that mark a field as a secret container, plus value shapes for
// well-known token formats. Detection never echoes the value back.
const SECRET_KEY_RE =
  /(password|passwd|secret|api[-_]?key|access[-_]?token|refresh[-_]?token|private[-_]?key|credential|client[-_]?secret|card[-_]?number|cvv|cvc|ssn)\b/i;
const SECRET_VALUE_RES: readonly RegExp[] = [
  /^sk-[A-Za-z0-9_-]{10,}$/, // OpenAI-style keys
  /^AKIA[0-9A-Z]{16}$/, // AWS access key id
  /^gh[pousr]_[A-Za-z0-9]{20,}$/, // GitHub tokens
  /^xox[baprs]-[A-Za-z0-9-]{10,}$/, // Slack tokens
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, // PEM material
];
// Fields that are process data, not durable facts (§2.4 rule 1).
const TRANSIENT_KEY_RE = /^(tool_?calls?|steps?|progress|raw_?response|transcript)$/i;

function scanForSecrets(value: unknown, path: string, hits: string[]): void {
  if (value && typeof value === "object") {
    if (Array.isArray(value)) {
      value.forEach((v, i) => scanForSecrets(v, `${path}[${i}]`, hits));
      return;
    }
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const p = path ? `${path}.${k}` : k;
      if (SECRET_KEY_RE.test(k)) hits.push(p);
      scanForSecrets(v, p, hits);
    }
    return;
  }
  if (typeof value === "string") {
    if (SECRET_VALUE_RES.some((re) => re.test(value.trim()))) hits.push(path || "(root)");
  }
}

function scanForTransient(value: unknown, path: string, hits: string[]): void {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const p = path ? `${path}.${k}` : k;
      if (TRANSIENT_KEY_RE.test(k)) hits.push(p);
      scanForTransient(v, p, hits);
    }
  }
}

// --- write -----------------------------------------------------------------

function toEntry(row: MemoryEntryRow): MemoryEntry {
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(row.body_json) as Record<string, unknown>;
  } catch {
    body = {};
  }
  return {
    id: row.id,
    merchantId: row.merchant_id,
    kind: row.kind,
    entityKey: row.entity_key,
    body,
    source: row.source,
    confidence: row.confidence,
    supersededBy: row.superseded_by,
    updatedAt: row.updated_at,
  };
}

function activeEntries(
  store: GuardianStore,
  merchantId: string,
  kind: string,
  entityKey: string
): MemoryEntryRow[] {
  return store.memory
    .list(merchantId, kind)
    .filter((r) => r.entity_key === entityKey && r.superseded_by === null);
}

export function memoryWrite(
  store: GuardianStore,
  input: MemoryWriteInput
): MemoryWriteResult {
  if (!MEMORY_KINDS_PHASE1.includes(input.kind)) {
    throw new MemoryWriteError(
      `Memory kind "${input.kind}" is not writable in Phase 1 (only A, C, D)`
    );
  }
  if (!input.source || !input.source.trim()) {
    throw new MemoryWriteError(
      "Memory writes require a source (§2.4: every fact must answer 'how do you know?')"
    );
  }
  if (!input.entityKey || !input.entityKey.trim()) {
    throw new MemoryWriteError("Memory writes require an entityKey");
  }
  if (!input.body || typeof input.body !== "object" || Array.isArray(input.body)) {
    throw new MemoryWriteError("Memory body must be a plain object");
  }

  const secretHits: string[] = [];
  scanForSecrets(input.body, "", secretHits);
  if (secretHits.length) {
    // Field paths only — the offending values are never written or echoed.
    throw new MemoryWriteError(
      `Refusing to store secret-looking fields in memory: ${secretHits.join(", ")} (§2.4 rule 3)`
    );
  }
  const transientHits: string[] = [];
  scanForTransient(input.body, "", transientHits);
  if (transientHits.length) {
    throw new MemoryWriteError(
      `Refusing to store process data in memory: ${transientHits.join(", ")} — that belongs in the ledger (§2.4 rule 1)`
    );
  }

  let confidence = input.confidence ?? 0.9;
  if (typeof confidence !== "number" || Number.isNaN(confidence) || confidence < 0 || confidence > 1) {
    throw new MemoryWriteError("confidence must be a number between 0 and 1");
  }
  if (input.body.inferred === true && confidence > 0.5) {
    confidence = 0.5; // §2.4 rule 2: inferences stay low-confidence until verified
  }

  const existing = activeEntries(store, input.merchantId, input.kind, input.entityKey);
  const bodyJson = canonicalJson(input.body);

  // Idempotency: an identical active fact is already stored — no duplicate.
  const identical = existing.find((r) => canonicalJson(JSON.parse(r.body_json)) === bodyJson);
  if (identical && input.supersedes === undefined) {
    return { id: identical.id, created: false, supersededIds: [] };
  }

  const id = store.memory.add({
    merchant_id: input.merchantId,
    kind: input.kind,
    entity_key: input.entityKey,
    body_json: JSON.stringify(input.body),
    source: input.source,
    confidence,
    superseded_by: null,
  });

  // §2.4 rule 4: supersede, never silently delete.
  const toSupersede = new Set<number>();
  if (input.supersedes !== undefined) toSupersede.add(input.supersedes);
  if (input.kind === "A" || input.kind === "C") {
    for (const row of existing) {
      if (row.id !== id && canonicalJson(JSON.parse(row.body_json)) !== bodyJson) {
        toSupersede.add(row.id);
      }
    }
  }
  const supersededIds: number[] = [];
  for (const oldId of toSupersede) {
    store.memory.update(oldId, { superseded_by: id });
    supersededIds.push(oldId);
    store.ledger.append({
      merchant_id: input.merchantId,
      actor: "memory",
      kind: "memory",
      result_json: JSON.stringify({
        action: "supersede",
        old_entry: oldId,
        new_entry: id,
        kind: input.kind,
        entity_key: input.entityKey,
      }),
    });
  }

  return { id, created: true, supersededIds };
}

// --- read ------------------------------------------------------------------

export interface MemoryReadQuery {
  kind?: MemoryKind;
  /** one entity: matches entity_key exactly, or appears inside the body */
  entity?: string;
  /** several entities (context assembly) */
  entities?: string[];
  includeSuperseded?: boolean;
  limit?: number;
}

export function memoryRead(
  store: GuardianStore,
  merchantId: string,
  query: MemoryReadQuery = {}
): MemoryEntry[] {
  let rows = store.memory.list(merchantId, query.kind);
  if (!query.includeSuperseded) {
    rows = rows.filter((r) => r.superseded_by === null);
  }
  const entities = [...(query.entities ?? []), ...(query.entity ? [query.entity] : [])];
  let entries = rows.map(toEntry);
  if (entities.length) {
    const scored = entries
      .map((e) => {
        let score = 0;
        for (const ent of entities) {
          if (e.entityKey === ent) score = Math.max(score, 2);
          else if (JSON.stringify(e.body).includes(ent)) score = Math.max(score, 1);
        }
        return { e, score };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || b.e.id - a.e.id);
    entries = scored.map((s) => s.e);
  } else {
    entries.sort((a, b) => b.id - a.id);
  }
  return query.limit ? entries.slice(0, query.limit) : entries;
}

/** The merchant's active profile (kind A), if one has been recorded. */
export function getMerchantProfile(
  store: GuardianStore,
  merchantId: string
): MemoryEntry | undefined {
  return memoryRead(store, merchantId, { kind: "A", limit: 1 })[0];
}
