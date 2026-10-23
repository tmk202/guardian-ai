// Morning briefing — a clean, read-only rendering of the latest stored
// digest (src/lib/jobs/digest.ts writes one report per merchant per day
// into the digest job's state cursor). This page only READS that stored
// report; it never runs the digest or any worker. No report yet → an
// honest empty state, never invented numbers.
import { getStore, DEFAULT_MERCHANT_ID } from "@/lib/db";
import { DIGEST_JOB, type MorningDigest } from "@/lib/jobs/digest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Guardian — Morning Briefing",
  description: "Guardian's morning digest: money in, outstanding, at risk, on hold, reconciliation and what waits for your approval.",
};

function readLatestDigest(): { digest: MorningDigest | null; storeError: boolean } {
  try {
    const row = getStore().jobState.get(DIGEST_JOB, DEFAULT_MERCHANT_ID);
    if (!row?.cursor_json) return { digest: null, storeError: false };
    const cursor = JSON.parse(row.cursor_json) as { report?: MorningDigest };
    const report = cursor.report ?? null;
    if (report) {
      // Stored reports written before Phase 3A / 5C lack the holds and
      // reconciliation blocks — the digest job applies these same defaults
      // when it hands back a stored report; mirror them on this read path.
      report.holds ??= { total: 0, currency: "USD", count: 0, nextEstimatedRelease: null };
      report.reconciliation ??= { matched: 0, mismatched: 0, unverifiable: 0, lastRunAt: null };
    }
    return { digest: report, storeError: false };
  } catch {
    return { digest: null, storeError: true };
  }
}

const money = (amount: number, currency: string) =>
  `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;

function ShieldMark() {
  return (
    <div className="brand-mark" aria-hidden="true">
      <svg width="21" height="21" viewBox="0 0 24 24" fill="none">
        <path d="M12 3l7 2.6v5.2c0 4.6-3 8.4-7 10.2-4-1.8-7-5.6-7-10.2V5.6L12 3z" stroke="#fff" strokeWidth="1.7" />
        <path d="M9 12l2 2 4-4.5" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

export default function BriefingPage() {
  const { digest, storeError } = readLatestDigest();

  return (
    <div className="brief-wrap">
      <header className="brief-top">
        <ShieldMark />
        <div>
          <h1>Morning briefing</h1>
          <div className="when">
            {digest
              ? `${digest.date} · ${digest.timezone} · built ${new Date(digest.generatedAt).toLocaleTimeString("en-GB", { hour12: false })}`
              : "Guardian's daily money digest"}
          </div>
        </div>
        <a className="brief-back" href="/">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M15 5l-7 7 7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          Back to console
        </a>
      </header>

      {!digest && (
        <section className="panel brief-empty" aria-label="No briefing yet">
          <h2>No briefing yet</h2>
          <p>
            {storeError
              ? "Guardian's store could not be read just now, so today's digest can't be shown. Nothing was invented to fill the gap — try again in a moment."
              : "Guardian builds this briefing once a day from your real PayPal activity — money in, what's still owed, what's at risk and what is waiting for your approval. The first digest for this account hasn't been stored yet."}
          </p>
        </section>
      )}

      {digest && (
        <>
          <div className="brief-grid">
            <section className="panel brief-block" aria-label="Money in yesterday">
              <div className="k">Money in yesterday</div>
              {digest.moneyYesterday ? (
                <>
                  <div className="brief-num">{money(digest.moneyYesterday.amount, digest.moneyYesterday.currency)}</div>
                  <div className="s">Settled into your account yesterday.</div>
                </>
              ) : (
                <>
                  <div className="brief-num unavailable">Unavailable</div>
                  <div className="s">Guardian couldn't read settled transactions for yesterday — see the notes below rather than a guessed figure.</div>
                </>
              )}
            </section>

            <section className="panel brief-block" aria-label="Outstanding">
              <div className="k">Still to collect <span className="pill blue">{digest.outstanding.count} invoice{digest.outstanding.count === 1 ? "" : "s"}</span></div>
              <div className="brief-num">{money(digest.outstanding.amount, digest.outstanding.currency)}</div>
              <div className="s">Sent and awaiting payment.</div>
              {digest.overdueInvoices.length > 0 && (
                <ul>
                  {digest.overdueInvoices.map((o) => (
                    <li key={o.invoice_id}>
                      <span className="mono">{o.invoice_id}</span>
                      <span className="amt">{money(o.amount, o.currency)}</span>
                    </li>
                  ))}
                </ul>
              )}
              {digest.overdueInvoices.length > 0 && (
                <div className="s">Overdue — due dates have passed on the invoice(s) above.</div>
              )}
            </section>

            <section className="panel brief-block" aria-label="At risk">
              <div className="k">At risk <span className="pill amber">{digest.atRisk.open_disputes} open dispute{digest.atRisk.open_disputes === 1 ? "" : "s"}</span></div>
              <div className="brief-num">{money(digest.atRisk.amount, digest.atRisk.currency)}</div>
              <div className="s">Tied to disputes that are still open.</div>
              {digest.upcomingDeadlines.length > 0 && (
                <ul>
                  {digest.upcomingDeadlines.map((d) => (
                    <li key={d.caseId}>
                      <span className="mono">{d.caseId}</span>
                      <span className="amt">{d.hoursLeft}h left</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="panel brief-block" aria-label="On hold">
              <div className="k">On hold <span className="pill blue">{digest.holds.count} payment{digest.holds.count === 1 ? "" : "s"}</span></div>
              <div className="brief-num">{money(digest.holds.total, digest.holds.currency)}</div>
              <div className="s">
                {digest.holds.count === 0
                  ? "No held payments are being tracked."
                  : digest.holds.nextEstimatedRelease
                    ? `Next estimated release ${digest.holds.nextEstimatedRelease.estimated_release_at.slice(0, 10)} — ${money(digest.holds.nextEstimatedRelease.amount, digest.holds.currency)} (estimate).`
                    : "Release timing isn't estimable for these holds yet."}
              </div>
            </section>

            <section className="panel brief-block" aria-label="Reconciliation">
              <div className="k">Reconciliation</div>
              {digest.reconciliation.lastRunAt ? (
                <>
                  <div className="brief-num">{digest.reconciliation.matched} matched</div>
                  <div className="s">
                    {digest.reconciliation.mismatched} mismatched · {digest.reconciliation.unverifiable} unverifiable · last run {digest.reconciliation.lastRunAt.slice(0, 10)}.
                    Every write Guardian executed, read back and checked.
                  </div>
                </>
              ) : (
                <>
                  <div className="brief-num unavailable">No report yet</div>
                  <div className="s">The reconciliation sweep hasn't run for this account, so there is nothing to quote.</div>
                </>
              )}
            </section>

            <section className="panel brief-block" aria-label="Waiting for your approval">
              <div className="k">Waiting for you <span className="pill amber">{digest.pendingApprovals.length} pending</span></div>
              <div className="brief-num">{digest.pendingApprovals.length}</div>
              <div className="s">
                {digest.pendingApprovals.length === 0
                  ? "Nothing is waiting on your approval. Sensitive actions always stop here first."
                  : "Sensitive action(s) paused for your decision — Guardian never runs these on its own."}
              </div>
              {digest.pendingApprovals.length > 0 && (
                <ul>
                  {digest.pendingApprovals.map((p) => (
                    <li key={p.id}>
                      <span className="mono">{p.tool}</span>
                      <span className="amt">{p.amount_usd != null ? money(p.amount_usd, "USD") : "—"}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          {(digest.unhandledAlerts.length > 0 || digest.notes.length > 0) && (
            <section className="panel brief-block brief-wide" aria-label="Alerts and notes">
              <div className="k">Alerts &amp; notes</div>
              {digest.unhandledAlerts.length > 0 && (
                <div className="s">{digest.unhandledAlerts.length} instant alert(s) since the last briefing — see the Activity log in the console for detail.</div>
              )}
              {digest.notes.length > 0 && (
                <ul className="brief-notes">
                  {digest.notes.map((n, i) => (
                    <li key={i}>{n}</li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}
