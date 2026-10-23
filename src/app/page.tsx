"use client";
// Guardian console — one screen, three columns:
// sidebar (brand + 3D accent + the three jobs) · chat · activity timeline.
// The activity log is the proof of work: every PayPal tool call the agent
// makes lands there. Sensitive actions surface an ApprovalCard and only
// "run" after the user clicks Approve (guardrail by design).
import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";

const Guardian3D = dynamic(() => import("@/components/Guardian3D"), { ssr: false });

type Msg = { role: "user" | "agent"; text: string; error?: boolean };
type LogEntry = { toolName: string; summary: string; at: string };
type Approval = {
  kind: string;
  caseId: string;
  evidenceType: string;
  carrier: string;
  tracking: string;
  amount: string;
  /** durable approval id (approvals store) when the server persisted one */
  id?: string;
};

const PROMPTS = {
  invoice: "Create a $450 invoice for my customer",
  dispute: "Any disputes I should worry about?",
  report: "What came in today, and who hasn't paid me?",
};

function Shield({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 3l7 2.6v5.2c0 4.6-3 8.4-7 10.2-4-1.8-7-5.6-7-10.2V5.6L12 3z" stroke="currentColor" strokeWidth="1.7" />
      <path d="M9 12l2 2 4-4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function Check() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4.5 12.5l5 5L19.5 7" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function summarize(args: Record<string, any> = {}): string {
  if (args.invoice_id) return String(args.invoice_id);
  if (args.dispute_id) return String(args.dispute_id);
  if (args.amount) return `$${args.amount}`;
  if (args.status) return String(args.status);
  return "";
}

export default function Home() {
  const [messages, setMessages] = useState<Msg[]>([
    {
      role: "agent",
      text: "Hi, I'm Guardian — your PayPal AI employee. I can send invoices, watch your disputes and report your money. Pick a job on the left, try a suggestion below, or just tell me what to do.",
    },
  ]);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [demo, setDemo] = useState(false);
  const [approval, setApproval] = useState<{ data: Approval; status: "pending" | "approved" | "dismissed" } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, busy, approval]);

  async function send(text?: string) {
    const message = (text ?? input).trim();
    if (!message || busy) return;
    setInput("");
    setBusy(true);
    setMessages((m) => [...m, { role: "user", text: message }]);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Request failed");
      const now = new Date().toLocaleTimeString([], { hour12: false });
      const entries: LogEntry[] = (data.steps || []).flatMap((s: any) =>
        (s.toolCalls || []).map((c: any) => ({ toolName: c.toolName, summary: summarize(c.args), at: now }))
      );
      if (entries.length) setLog((l) => [...entries, ...l]);
      if (data.mode === "demo") setDemo(true);
      setMessages((m) => [...m, { role: "agent", text: data.text || "(done)" }]);
      if (data.approval) setApproval({ data: data.approval as Approval, status: "pending" });
    } catch (e) {
      setMessages((m) => [
        ...m,
        { role: "agent", error: true, text: `Something went wrong: ${e instanceof Error ? e.message : e}` },
      ]);
    } finally {
      setBusy(false);
    }
  }

  async function decide(ok: boolean) {
    if (!approval || approval.status !== "pending") return;
    const now = new Date().toLocaleTimeString([], { hour12: false });
    const applyApproved = () => {
      setLog((l) => [{ toolName: "provide_evidence", summary: approval.data.caseId, at: now }, ...l]);
      setApproval({ ...approval, status: "approved" });
      setMessages((m) => [
        ...m,
        {
          role: "agent",
          text: `Submitted. PayPal accepted the evidence package for case ${approval.data.caseId} (HTTP 200). The case stays under review until PayPal decides — I'll keep watching it for you.`,
        },
      ]);
    };
    const applyDismissed = () => {
      setApproval({ ...approval, status: "dismissed" });
      setMessages((m) => [
        ...m,
        { role: "agent", text: "No problem — I haven't submitted anything. The evidence package stays ready whenever you want it." },
      ]);
    };
    // Durable path: the decision is recorded in the approvals store and, on
    // approve, the frozen action runs through the server-side executor.
    // Without a server-issued id (store unavailable) keep the client-only flow.
    if (!approval.data.id) {
      if (ok) applyApproved(); else applyDismissed();
      return;
    }
    try {
      const res = await fetch(`/api/approvals/${approval.data.id}/decide`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: ok ? "approved" : "dismissed" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || "Decision failed");
      if (ok) applyApproved(); else applyDismissed();
    } catch (e) {
      setMessages((m) => [
        ...m,
        { role: "agent", error: true, text: `Something went wrong: ${e instanceof Error ? e.message : e}` },
      ]);
    }
  }

  return (
    <div className="shell">
      {/* ---------- sidebar ---------- */}
      <aside className="panel sidebar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
              <path d="M12 3l7 2.6v5.2c0 4.6-3 8.4-7 10.2-4-1.8-7-5.6-7-10.2V5.6L12 3z" stroke="#fff" strokeWidth="1.7" />
              <path d="M9 12l2 2 4-4.5" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <div>
            <h1>Guardian</h1>
            <span className="badge"><span className="dot" aria-hidden="true" /> PayPal Sandbox</span>
          </div>
        </div>

        <Guardian3D />

        <div className="account">
          <div className="name">Test Store</div>
          <div className="meta">Business account · sb-…@business.example.com</div>
        </div>

        <nav className="nav-jobs" aria-label="Guardian jobs">
          <span className="label">Guardian's jobs</span>
          <button className="job-btn" onClick={() => send(PROMPTS.invoice)} disabled={busy}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 3h12v18l-2-1.5L14 21l-2-1.5L10 21l-2-1.5L6 21V3z" stroke="currentColor" strokeWidth="1.6" /><path d="M9 8h6M9 12h6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
            <span><span className="t">Invoices</span><br /><span className="s">Create, send &amp; remind</span></span>
          </button>
          <button className="job-btn" onClick={() => send(PROMPTS.dispute)} disabled={busy}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 3l7 2.6v5.2c0 4.6-3 8.4-7 10.2-4-1.8-7-5.6-7-10.2V5.6L12 3z" stroke="currentColor" strokeWidth="1.6" /><path d="M12 8v4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /><circle cx="12" cy="15.4" r="0.6" fill="currentColor" /></svg>
            <span><span className="t">Dispute watch</span><br /><span className="s">Evidence, ready for approval</span></span>
          </button>
          <button className="job-btn" onClick={() => send(PROMPTS.report)} disabled={busy}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 19V5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /><path d="M4 19h16" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /><path d="M8 15l3.5-4 3 2.5L19 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
            <span><span className="t">Money report</span><br /><span className="s">In · unpaid · on hold</span></span>
          </button>
          <a className="job-btn" href="/briefing">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="4" y="5.5" width="16" height="15" rx="2.5" stroke="currentColor" strokeWidth="1.6" /><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /><path d="M8 14.5h5M8 17.5h8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
            <span><span className="t">Morning briefing</span><br /><span className="s">Today's digest &amp; to-dos</span></span>
          </a>
        </nav>

        <p className="guardrail">
          <strong>Guardrail:</strong> refunds, accepting a claim and submitting evidence always stop for your approval first.
        </p>
      </aside>

      {/* ---------- main ---------- */}
      <main className="main">
        <div className="stats">
          <section className="panel stat" aria-label="Money in">
            <div className="k">Money in <span className="pill green">Paid</span></div>
            <div className="v">$120.00</div>
            <div className="s">Earbuds invoice INV2-BYHA…A9N9</div>
          </section>
          <section className="panel stat" aria-label="Outstanding">
            <div className="k">Outstanding <span className="pill blue">1 invoice</span></div>
            <div className="v">$450.00</div>
            <div className="s">INV2-Y236…XSYC · sent, awaiting payment</div>
          </section>
          <section className="panel stat" aria-label="Under review">
            <div className="k">Under review <span className="pill amber">Dispute</span></div>
            <div className="v">$120.00</div>
            <div className="s">Case PP-R-GAW-10194043</div>
          </section>
        </div>

        <section className="panel chat" aria-label="Chat with Guardian">
          <div className="chat-head">
            <div className="who">
              <span className="avatar"><Shield size={18} /></span>
              Guardian <span style={{ color: "var(--muted)", fontWeight: 500, fontSize: 13.5 }}>· PayPal assistant</span>
            </div>
            {demo && <span className="demo-pill">Demo mode — real sandbox data</span>}
          </div>

          <div className="messages" ref={scrollRef}>
            {messages.map((m, i) => (
              <div key={i} className={`msg ${m.role}${m.error ? " error" : ""}`}>
                {m.role === "agent" ? (
                  <span className="avatar"><Shield size={17} /></span>
                ) : (
                  <span className="avatar user" aria-hidden="true">
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="8" r="3.6" stroke="currentColor" strokeWidth="1.8" /><path d="M4.5 20c1.4-3.4 4.2-5 7.5-5s6.1 1.6 7.5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
                  </span>
                )}
                <div className="bubble">{m.text}</div>
              </div>
            ))}

            {approval && (
              <div className={`approval${approval.status !== "pending" ? " done" : ""}`} role="group" aria-label="Approval needed">
                <h3>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 3l7 2.6v5.2c0 4.6-3 8.4-7 10.2-4-1.8-7-5.6-7-10.2V5.6L12 3z" stroke="currentColor" strokeWidth="1.6" /><path d="M12 8v4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /><circle cx="12" cy="15.4" r="0.6" fill="currentColor" /></svg>
                  {approval.status === "pending" && "Approval needed — submit dispute evidence?"}
                  {approval.status === "approved" && "Evidence submitted — PayPal accepted (HTTP 200)"}
                  {approval.status === "dismissed" && "Dismissed — nothing was submitted"}
                </h3>
                <dl>
                  <dt>Case</dt><dd>{approval.data.caseId} · {approval.data.amount}</dd>
                  <dt>Evidence</dt><dd>{approval.data.evidenceType}</dd>
                  <dt>Tracking</dt><dd>{approval.data.carrier} {approval.data.tracking}</dd>
                </dl>
                {approval.status === "pending" && (
                  <div className="row">
                    <button className="btn primary" onClick={() => decide(true)}>Approve &amp; submit</button>
                    <button className="btn ghost" onClick={() => decide(false)}>Dismiss</button>
                  </div>
                )}
              </div>
            )}

            {busy && (
              <div className="msg agent" aria-live="polite">
                <span className="avatar"><Shield size={17} /></span>
                <div className="bubble typing"><i /><i /><i /></div>
              </div>
            )}
          </div>

          <div className="chips">
            {Object.values(PROMPTS).map((p) => (
              <button key={p} className="chip" onClick={() => send(p)} disabled={busy}>{p}</button>
            ))}
          </div>

          <form
            className="composer"
            onSubmit={(e) => { e.preventDefault(); send(); }}
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Tell Guardian what to do…"
              aria-label="Message Guardian"
            />
            <button className="send" type="submit" disabled={busy || !input.trim()}>Send</button>
          </form>
        </section>
      </main>

      {/* ---------- activity ---------- */}
      <aside className="panel activity" aria-label="Activity log">
        <h2><span className="live-dot" aria-hidden="true" /> Activity</h2>
        <div className="sub">Every PayPal action Guardian takes, in the open.</div>
        {log.length === 0 && <p className="empty">No actions yet. Ask Guardian to do something — its PayPal tool calls will appear here.</p>}
        {log.map((e, i) => (
          <div className="entry" key={i}>
            <span className="check"><Check /></span>
            <div>
              <div className="tool">{e.toolName}</div>
              {e.summary && <div className="sum">{e.summary}</div>}
            </div>
            <span className="at">{e.at}</span>
          </div>
        ))}
      </aside>
    </div>
  );
}
