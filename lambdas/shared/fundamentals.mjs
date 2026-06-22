// fundamentals.mjs — O'Neil/CAN-SLIM fundamentals, CAPTURE-ONLY (v2 groundwork).
//
// These are recorded on snapshots for later Phase-8 analysis; they are NOT scored
// and NOT gated yet. "Math decides. AI only explains. Data learns later." When
// /analyze shows whether growth/quality predicts winners, we decide weights then.
//
// Source: Finnhub /stock/metric (basic financials). Field names verified live on
// the free tier. Best-effort: any failure returns an all-null object so a
// fundamentals hiccup never sinks a scan.

import { getParameter } from "./ssm.mjs";
import { finnhub } from "./ratelimit.mjs";

// Finnhub stays a shared key (scope). Path env-driven for consistency.
const FINNHUB_KEY_PATH = process.env.FINNHUB_KEY_PATH || "/edge-hunter/finnhub/api_key";

// Pull the first present numeric value among candidate keys; else null.
function num(metric, ...keys) {
  for (const k of keys) {
    const v = metric?.[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

// Map the raw Finnhub `metric` object to our curated capture set. Pure.
export function extractFundamentals(metric) {
  const m = metric ?? {};
  return {
    epsGrowthQtr: num(m, "epsGrowthQuarterlyYoy"), // % quarterly EPS growth YoY
    salesGrowthQtr: num(m, "revenueGrowthQuarterlyYoy"), // % quarterly revenue growth YoY
    annualEpsGrowth: num(m, "epsGrowthTTMYoy", "epsGrowth3Y"), // TTM YoY (annual proxy)
    epsGrowth5Y: num(m, "epsGrowth5Y"),
    salesGrowth5Y: num(m, "revenueGrowth5Y"),
    grossMarginTTM: num(m, "grossMarginTTM", "grossMarginAnnual"), // quality
    roeTTM: num(m, "roeTTM", "roeRfy"), // institutional-quality proxy
    debtToEquity: num(m, "totalDebt/totalEquityQuarterly", "totalDebt/totalEquityAnnual"),
  };
}

const EMPTY = Object.freeze(extractFundamentals(null));

// Fetch + extract for one ticker. Best-effort: returns the all-null shape on any
// error (network, non-200, missing metric block). Never throws.
export async function getFundamentals(ticker, opts = {}) {
  try {
    const fetchFn = opts.fetchFn ?? fetch;
    const key = opts.apiKey ?? (await getParameter(FINNHUB_KEY_PATH));
    const url = `https://finnhub.io/api/v1/stock/metric?symbol=${encodeURIComponent(ticker)}&metric=all&token=${key}`;
    const res = await finnhub(() => fetchFn(url));
    if (!res.ok) return { ...EMPTY };
    const data = await res.json();
    return extractFundamentals(data?.metric);
  } catch {
    return { ...EMPTY };
  }
}
