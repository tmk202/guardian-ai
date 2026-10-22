// Merchant policy (ARCHITECTURE-DETAIL.md §5.3) — configuration, not prompt.
//
// The canonical file lives at config/policy.yaml. This loader reads it with a
// small subset YAML parser (nested maps by indentation, scalars, inline
// arrays — everything the policy file uses) so the project needs no extra
// dependency. If the file is missing or unparseable, built-in defaults that
// mirror the file are used, so a deployment that only ships src/ still runs
// with the agreed safe policy: every SENSITIVE action requires a human.
import fs from "node:fs";
import path from "node:path";

export interface GuardianPolicy {
  approvals: {
    default: string;
    auto_below_usd: number;
    expire_after_hours: number;
  };
  collections: {
    max_rung: number;
    min_gap_hours_between_reminders: number;
  };
  holds: {
    /** instant-alert threshold for newly detected holds (Phase 3A) */
    alert_min_usd: number;
  };
  notifications: {
    instant: string[];
    daily_digest_at: string;
    quiet_hours: string;
  };
  watchers: {
    deadline_scan: string;
    hold_scan: string;
    overdue_scan: string;
  };
}

export const DEFAULT_POLICY: GuardianPolicy = {
  approvals: { default: "require_human", auto_below_usd: 0, expire_after_hours: 24 },
  collections: { max_rung: 3, min_gap_hours_between_reminders: 24 },
  holds: { alert_min_usd: 0 },
  notifications: {
    instant: ["dispute_new", "deadline_lt_48h", "scam_suspect", "hold_placed"],
    daily_digest_at: "08:00",
    quiet_hours: "22:00-07:00",
  },
  watchers: { deadline_scan: "every 1h", hold_scan: "daily 07:30", overdue_scan: "daily 08:30" },
};

export const DEFAULT_POLICY_YAML = `# Guardian merchant policy — see ARCHITECTURE-DETAIL.md section 5.3.
# Changing the auto-approve threshold is a standing instruction: it must be
# confirmed in the UI, never inferred from chat.
approvals:
  default: require_human
  auto_below_usd: 0
  expire_after_hours: 24
collections:
  max_rung: 3
  min_gap_hours_between_reminders: 24
holds:
  alert_min_usd: 0
notifications:
  instant: [dispute_new, deadline_lt_48h, scam_suspect, hold_placed]
  daily_digest_at: "08:00"
  quiet_hours: "22:00-07:00"
watchers:
  deadline_scan: "every 1h"
  hold_scan: "daily 07:30"
  overdue_scan: "daily 08:30"
`;

// --- Minimal YAML subset parser (maps by indentation, scalars, [a, b]) ---
function parseScalar(raw: string): unknown {
  const v = raw.trim();
  if (v.startsWith("[") && v.endsWith("]")) {
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((s) => parseScalar(s));
  }
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    return v.slice(1, -1);
  }
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null" || v === "~") return null;
  return v;
}

export function parseSimpleYaml(text: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const stack: { indent: number; obj: Record<string, unknown> }[] = [
    { indent: -1, obj: root },
  ];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    const m = line.trim().match(/^([^:]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1].trim();
    const value = m[2];
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].obj;
    if (value === "") {
      const child: Record<string, unknown> = {};
      parent[key] = child;
      stack.push({ indent, obj: child });
    } else {
      parent[key] = parseScalar(value);
    }
  }
  return root;
}

function mergePolicy(base: GuardianPolicy, over: Record<string, unknown>): GuardianPolicy {
  const out: GuardianPolicy = JSON.parse(JSON.stringify(base));
  for (const section of Object.keys(out) as (keyof GuardianPolicy)[]) {
    const o = over[section];
    if (o && typeof o === "object" && !Array.isArray(o)) {
      for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
        if (v !== undefined && k in (out[section] as Record<string, unknown>)) {
          (out[section] as Record<string, unknown>)[k] = v;
        }
      }
    }
  }
  return out;
}

export function policyPath(): string {
  return (
    process.env.GUARDIAN_POLICY_PATH ||
    path.join(process.cwd(), "config", "policy.yaml")
  );
}

export function loadPolicy(file: string = policyPath()): GuardianPolicy {
  try {
    if (fs.existsSync(file)) {
      return mergePolicy(DEFAULT_POLICY, parseSimpleYaml(fs.readFileSync(file, "utf8")));
    }
  } catch {
    // Unparseable policy must never crash the gate — fall back to defaults.
  }
  return JSON.parse(JSON.stringify(DEFAULT_POLICY)) as GuardianPolicy;
}

let cached: GuardianPolicy | null = null;
export function getPolicy(): GuardianPolicy {
  if (!cached) cached = loadPolicy();
  return cached;
}
export function resetPolicyCache(): void {
  cached = null;
}
