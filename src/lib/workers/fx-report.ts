// FX cost report (DEVELOPMENT-PLAN pain #7, PHASES 5.3) — Phase 5B.
//
// Sellers lose 7–9% on international payments without ever seeing why.
// This worker separates what PayPal's own transaction records actually
// say about a currency conversion: the gross in the presentment
// currency, the exchange rate PayPal applied, the gross in the
// settlement currency, and the PayPal fee — then computes the two
// honest derived numbers (net settlement, fee as a share of the
// settlement gross). Both are arithmetic over payload figures and are
// labelled computed.
//
// HONESTY CONTRACT: no external/reference exchange rate is ever
// fetched or invented, so Guardian cannot (and does not) claim what
// the "market" spread cost the merchant — only the rate PayPal states
// it applied and the fee PayPal states it charged. A transaction that
// does not carry the conversion fields in its payload is listed under
// missing_fields with the absent field names — never estimated.

export interface FxMoney {
  amount: number;
  currency: string;
}

export interface FxConversion {
  transaction_id: string;
  /** gross amount in the currency the payment was presented in */
  gross_presentment: FxMoney;
  /** rate PayPal states it applied: settlement units per 1 presentment unit */
  exchange_rate: number;
  /** gross amount in the settlement currency, as stated in the payload */
  gross_settlement: FxMoney;
  /** PayPal fee as stated in the payload (null when the payload has none) */
  fee: FxMoney | null;
  /** computed: gross_settlement − fee, when the fee is in settlement currency */
  net_settlement: FxMoney | null;
  /** computed: fee / gross_settlement × 100, same-currency fee only */
  fee_pct_of_settlement_gross: number | null;
}

export interface FxMissing {
  transaction_id: string;
  currency: string;
  /** payload fields whose absence prevents an FX breakdown */
  missing: string[];
}

export interface FxPairTotal {
  pair: string;
  count: number;
  gross_presentment: number;
  presentment_currency: string;
  gross_settlement: number;
  settlement_currency: string;
  fees_settlement: number;
}

export interface FxReport {
  status: "ok";
  base_currency: string;
  conversions: FxConversion[];
  totals: FxPairTotal[];
  missing_fields: FxMissing[];
  notes: string[];
}

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};
const round2 = (n: number) => Math.round(n * 100) / 100;

function moneyOf(v: any): FxMoney | null {
  if (!v || typeof v !== "object") return null;
  const amount = num(v.value);
  const currency = typeof v.currency_code === "string" ? v.currency_code : null;
  return amount !== null && currency ? { amount, currency } : null;
}

/**
 * Analyse Transaction Search details (`transaction_details` items).
 * A conversion is recognised ONLY when the payload carries the
 * conversion fields (exchange_rate + settlement amount, in the
 * disbursement-details naming PayPal documents: settlement_amount /
 * settlement_currency / exchange rate from presentment to settlement).
 */
export function analyzeFx(
  details: any[],
  opts: { baseCurrency: string }
): FxReport {
  const base = opts.baseCurrency || "USD";
  const conversions: FxConversion[] = [];
  const missing: FxMissing[] = [];
  const notes: string[] = [
    "Rates and amounts are PayPal's own figures from the transaction records; no external or reference exchange rate was used, so no market-spread cost is claimed.",
  ];

  for (const d of Array.isArray(details) ? details : []) {
    const info = d?.transaction_info ?? {};
    const txnId = typeof info.transaction_id === "string" ? info.transaction_id : "";
    const gross = moneyOf(info.transaction_amount);
    if (!gross) continue;

    const rate = num(info.exchange_rate);
    // Settlement amount: object form {value, currency_code} or scalar
    // value + settlement_currency — both namings appear in PayPal data.
    let settlement = moneyOf(info.settlement_amount);
    if (!settlement && info.settlement_amount !== undefined) {
      const v = num(info.settlement_amount);
      const c = typeof info.settlement_currency === "string" ? info.settlement_currency : null;
      if (v !== null && c) settlement = { amount: v, currency: c };
    }
    const fee = moneyOf(info.fee_amount);

    const hasRate = rate !== null;
    const hasSettlement = settlement !== null;
    if (hasRate && hasSettlement && settlement) {
      const sameCcyFee = fee && fee.currency === settlement.currency ? fee : null;
      conversions.push({
        transaction_id: txnId,
        gross_presentment: gross,
        exchange_rate: rate,
        gross_settlement: settlement,
        fee,
        net_settlement: sameCcyFee
          ? { amount: round2(settlement.amount - sameCcyFee.amount), currency: settlement.currency }
          : null,
        fee_pct_of_settlement_gross: sameCcyFee && settlement.amount !== 0
          ? round2((sameCcyFee.amount / settlement.amount) * 100)
          : null,
      });
      continue;
    }
    // No complete conversion record. Only worth reporting when the
    // transaction is foreign-currency for this merchant, or when SOME
    // conversion field is present but its pair is missing.
    const absent: string[] = [];
    if (!hasRate) absent.push("exchange_rate");
    if (!hasSettlement) absent.push("settlement_amount");
    if (gross.currency !== base || hasRate || hasSettlement) {
      missing.push({ transaction_id: txnId, currency: gross.currency, missing: absent });
    }
  }

  const totalsMap = new Map<string, FxPairTotal>();
  for (const c of conversions) {
    const pair = `${c.gross_presentment.currency}->${c.gross_settlement.currency}`;
    let t = totalsMap.get(pair);
    if (!t) {
      t = {
        pair,
        count: 0,
        gross_presentment: 0,
        presentment_currency: c.gross_presentment.currency,
        gross_settlement: 0,
        settlement_currency: c.gross_settlement.currency,
        fees_settlement: 0,
      };
      totalsMap.set(pair, t);
    }
    t.count++;
    t.gross_presentment = round2(t.gross_presentment + c.gross_presentment.amount);
    t.gross_settlement = round2(t.gross_settlement + c.gross_settlement.amount);
    if (c.fee && c.fee.currency === c.gross_settlement.currency) {
      t.fees_settlement = round2(t.fees_settlement + c.fee.amount);
    }
  }
  const totals = [...totalsMap.values()].sort((a, b) => a.pair.localeCompare(b.pair));

  if (conversions.length === 0) {
    notes.push("No transaction in range carried a complete currency-conversion record (exchange rate + settlement amount).");
  }
  if (missing.length > 0) {
    notes.push(
      `${missing.length} transaction(s) could not be broken down: the payload lacked conversion fields (see missing_fields). Their FX cost is unknown, not zero.`
    );
  }

  return {
    status: "ok",
    base_currency: base,
    conversions,
    totals,
    missing_fields: missing,
    notes,
  };
}
