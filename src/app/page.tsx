"use client";
// V1 UI: one screen. Left = chat with Guardian. Right = activity log showing
// every PayPal tool call the agent makes, live. No dashboard complexity.
import { useState } from "react";

type Msg = { role: "user" | "agent"; text: string };
type LogEntry = { toolName: string; at: string };

export default function Home() {
  const [messages, setMessages] = useState<Msg[]>([
    {
      role: "agent",
      text: "Hi, I'm Guardian — your PayPal assistant. Try: \"Create a $450 invoice for my customer\", \"Who hasn't paid me?\", or \"Any disputes I should worry about?\"",
    },
  ]);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [demo, setDemo] = useState(false);

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setBusy(true);
    setMessages((m) => [...m, { role: "user", text }]);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Request failed");
      if (data.mode === "demo") setDemo(true);
      const now = new Date().toLocaleTimeString();
      const entries: LogEntry[] = (data.steps || []).flatMap((s: any) =>
        (s.toolCalls || []).map((c: any) => ({ toolName: c.toolName, at: now }))
      );
      setLog((l) => [...entries, ...l]);
      setMessages((m) => [...m, { role: "agent", text: data.text || "(done)" }]);
    } catch (e) {
      setMessages((m) => [
        ...m,
        { role: "agent", text: `Something went wrong: ${e instanceof Error ? e.message : e}` },
      ]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 16, padding: 16, fontFamily: "system-ui", height: "100vh", boxSizing: "border-box" }}>
      <section style={{ display: "flex", flexDirection: "column", border: "1px solid #ddd", borderRadius: 12, padding: 16 }}>
        <h1 style={{ margin: "0 0 12px" }}>Guardian — your PayPal AI employee</h1>
        {demo && (
          <div style={{ background: "#fff7e0", border: "1px solid #e6c34a", borderRadius: 8, padding: "8px 12px", marginBottom: 12, fontSize: 13 }}>
            <strong>Demo mode.</strong> This walkthrough is scripted from Guardian's real PayPal sandbox runs — the invoice and dispute IDs are real. Connect an AI API key to run the live agent.
          </div>
        )}
        <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 8 }}>
          {messages.map((m, i) => (
            <div key={i} style={{ alignSelf: m.role === "user" ? "flex-end" : "flex-start", background: m.role === "user" ? "#0070e0" : "#f2f2f2", color: m.role === "user" ? "#fff" : "#111", padding: "8px 12px", borderRadius: 10, maxWidth: "80%", whiteSpace: "pre-wrap" }}>
              {m.text}
            </div>
          ))}
          {busy && <div style={{ color: "#666" }}>Guardian is working…</div>}
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send()}
            placeholder="Tell Guardian what to do…"
            style={{ flex: 1, padding: 10, borderRadius: 8, border: "1px solid #ccc" }}
          />
          <button onClick={send} disabled={busy} style={{ padding: "10px 16px", borderRadius: 8 }}>
            Send
          </button>
        </div>
      </section>
      <aside style={{ border: "1px solid #ddd", borderRadius: 12, padding: 16, overflowY: "auto" }}>
        <h2 style={{ marginTop: 0, fontSize: 16 }}>Activity — what Guardian did in PayPal</h2>
        {log.length === 0 && <p style={{ color: "#666" }}>No tool calls yet.</p>}
        {log.map((e, i) => (
          <div key={i} style={{ fontFamily: "monospace", fontSize: 13, padding: "4px 0", borderBottom: "1px solid #eee" }}>
            {e.at} · {e.toolName}
          </div>
        ))}
      </aside>
    </main>
  );
}
