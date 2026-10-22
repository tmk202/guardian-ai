// Subscription plans & entitlements (PHASES 5.1, commercial frame) —
// Phase 5D.
//
// FRAMEWORK ONLY: no payment rail is connected, nothing is charged, and
// no price is defined anywhere in this codebase (see BILLING.md). What
// exists is the entitlement layer a rail will plug into: plan
// definitions in config/plans.yaml, a pure checkEntitlement(), and the
// merchant's current plan read from their profile (memory kind A,
// field `plan`, defaulting to "free" — pre-Phase-5 profiles without the
// field keep working unchanged).
import fs from "node:fs";
import path from "node:path";
import type { GuardianStore } from "./db";
import { parseSimpleYaml } from "./policy";
import { getMerchantProfile } from "./memory";
import { DEFAULT_MERCHANT_ID } from "./db";

/** Feature ids a plan can grant — the job/worker names of this codebase. */
export const PLAN_FEATURES = [
  "digest",
  "deadline-radar",
  "hold-radar",
  "analyst",
  "collections",
  "risk-scan",
  "scam-shield",
  "appeal-packet",
  "outcomes-scan",
  "reconcile-report",
] as const;
export type PlanFeature = (typeof PLAN_FEATURES)[number];

export interface PlanDef {
  id: string;
  label: string;
  /** null = unlimited */
  max_merchants: number | null;
  /** null = unlimited */
  max_tracked_cases: number | null;
  features: string[];
}

export const DEFAULT_PLANS: Record<string, PlanDef> = {
  free: {
    id: "free",
    label: "Free",
    max_merchants: 1,
    max_tracked_cases: 10,
    features: ["digest", "deadline-radar", "hold-radar"],
  },
  pro: {
    id: "pro",
    label: "Pro",
    max_merchants: 5,
    max_tracked_cases: null,
    features: [...PLAN_FEATURES],
  },
};

export const DEFAULT_PLAN_ID = "free";

// --- loading (same subset-YAML approach as policy.ts) ----------------------

export function plansPath(): string {
  return (
    process.env.GUARDIAN_PLANS_PATH ||
    path.join(process.cwd(), "config", "plans.yaml")
  );
}

function planFromRaw(id: string, raw: Record<string, unknown>): PlanDef | null {
  const fallback = DEFAULT_PLANS[id];
  const features = Array.isArray(raw.features)
    ? raw.features.filter((f): f is string => typeof f === "string")
    : fallback?.features;
  if (!features) return null;
  const numOrNull = (v: unknown, fb: number | null): number | null =>
    typeof v === "number" ? v : v === null ? null : fb;
  return {
    id,
    label: typeof raw.label === "string" ? raw.label : fallback?.label ?? id,
    max_merchants: numOrNull(raw.max_merchants, fallback?.max_merchants ?? null),
    max_tracked_cases: numOrNull(raw.max_tracked_cases, fallback?.max_tracked_cases ?? null),
    features,
  };
}

export function loadPlans(file: string = plansPath()): Record<string, PlanDef> {
  try {
    if (fs.existsSync(file)) {
      const parsed = parseSimpleYaml(fs.readFileSync(file, "utf8"));
      const rawPlans = parsed.plans as Record<string, Record<string, unknown>> | undefined;
      if (rawPlans && typeof rawPlans === "object") {
        const out: Record<string, PlanDef> = {};
        for (const [id, raw] of Object.entries(rawPlans)) {
          const plan = planFromRaw(id, raw ?? {});
          if (plan) out[id] = plan;
        }
        if (out[DEFAULT_PLAN_ID]) return out;
      }
    }
  } catch {
    // Unparseable plans file must never crash the gate — use defaults.
  }
  return JSON.parse(JSON.stringify(DEFAULT_PLANS)) as Record<string, PlanDef>;
}

let cached: Record<string, PlanDef> | null = null;
export function getPlans(): Record<string, PlanDef> {
  if (!cached) cached = loadPlans();
  return cached;
}
export function resetPlansCache(): void {
  cached = null;
}

export function getPlan(planId: string): PlanDef {
  const plans = getPlans();
  return plans[planId] ?? plans[DEFAULT_PLAN_ID] ?? DEFAULT_PLANS[DEFAULT_PLAN_ID];
}

// --- entitlement check (pure) ------------------------------------------------

export interface EntitlementCheck {
  allowed: boolean;
  /** the plan actually applied (falls back to Free for unknown ids) */
  plan: PlanDef;
  feature: string;
  reason: string;
}

export function checkEntitlement(planId: string, feature: string): EntitlementCheck {
  const plans = getPlans();
  const known = planId in plans;
  const plan = getPlan(planId);
  const allowed = plan.features.includes(feature);
  return {
    allowed,
    plan,
    feature,
    reason: !known
      ? `unknown plan "${planId}" — treated as ${plan.label}; ${allowed ? "feature included" : "feature not included"}`
      : allowed
        ? `${plan.label} plan includes ${feature}`
        : `${feature} is not included in the ${plan.label} plan`,
  };
}

// --- merchant plan (memory A, field `plan`) -----------------------------------

export interface MerchantPlan {
  /** plan id in force (the declared value when known, else "free") */
  planId: string;
  /** the raw `plan` value on the profile, null when never declared */
  declared: string | null;
  plan: PlanDef;
}

export function getMerchantPlan(
  store: GuardianStore,
  merchantId: string = DEFAULT_MERCHANT_ID
): MerchantPlan {
  const profile = getMerchantProfile(store, merchantId);
  const raw = profile?.body.plan;
  const declared = typeof raw === "string" && raw.trim() ? raw.trim() : null;
  const plans = getPlans();
  const planId = declared && declared in plans ? declared : DEFAULT_PLAN_ID;
  return { planId, declared, plan: getPlan(planId) };
}
