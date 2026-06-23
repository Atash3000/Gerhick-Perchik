// marketdata.mjs — one module wrapping Tiingo (EOD history) + Finnhub (earnings,
// sector) behind a single getMarketData(ticker). Returns exactly the fields the
// scoring function needs.
//
// Secrets: API keys are read at runtime from SSM by PATH and decrypted in memory
// only. They are never logged, printed, returned, or persisted. Keys are reused
// from the account-level /edge-hunter/* params (see CLAUDE.md).
//
// Modeling conventions (signed off, v1):
//   - SMA(50/200) on adjusted daily closes
//   - ATR(14), Wilder/RMA smoothing
//   - RSI(14), Wilder/RMA smoothing
//   - avgVolume30 = simple mean of last 30 daily volumes
//   - Support/Resistance = swing-pivot fractals (3 bars L / 3 bars R), clustered,
//     merged within min(0.75*ATR, 1.0% of price), levels need >=2 touches.
//   - Adjusted OHLCV is used throughout so splits/dividends don't corrupt
//     historical levels or indicator math.

import { getParameter } from "./ssm.mjs";
import { finnhub, tiingo, withRetry, isRateLimited } from "./ratelimit.mjs";

// SSM PATHS (never the values). Driven by env so the Tiingo key can be moved to a
// DEDICATED Gerchik-Perchik key without a code change — see docs (Tiingo free tier
// caps unique symbols at 500/month, and the Edge Hunter key is shared, which
// starves us). Tiingo defaults to the DEDICATED premium /gerchik key (cap
// removed); Finnhub stays on the shared /edge-hunter key (still reused — no
// premium replacement). The deployed stack sets these via env from TiingoKeyPath
// / FinnhubKeyPath; the fallbacks are for local scripts run without the env set.
export const KEY_PATHS = {
  tiingo: process.env.TIINGO_KEY_PATH || "/gerchik/tiingo/api_key",
  finnhub: process.env.FINNHUB_KEY_PATH || "/edge-hunter/finnhub/api_key",
};
const SSM_PATHS = KEY_PATHS;

// Detection / indicator parameters (v1).
export const PARAMS = {
  maShort: 50,
  maMid: 150, // Minervini trend template
  maLong: 200,
  maSlopeLag: 30, // bars back to measure 200MA slope ("rising")
  breakoutShort: 20, // Turtle short breakout channel
  breakoutLong: 55, // Turtle long breakout channel
  atrPeriod: 14,
  rsiPeriod: 14,
  avgVolumeWindow: 30,
  pivotWing: 3, // bars required on each side of a swing pivot
  pivotLookback: 126, // ~6 months of trading days scanned for levels
  minTouches: 2, // a level needs at least this many pivots to be valid
};

// Secrets are read via the shared ssm.mjs helper (getParameter) — decrypted in
// memory only, cached per warm container, never logged.

// ---------------------------------------------------------------------------
// US market trading-day calendar (weekend + holiday aware) for the freshness gate.
// Static NYSE holiday set; extend per year. EOD data is considered "published"
// after ~18:00 ET on a trading day.
// ---------------------------------------------------------------------------
const MARKET_HOLIDAYS = new Set([
  // 2025
  "2025-01-01", "2025-01-20", "2025-02-17", "2025-04-18", "2025-05-26",
  "2025-06-19", "2025-07-04", "2025-09-01", "2025-11-27", "2025-12-25",
  // 2026
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25",
  "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  // 2027 (NYSE: New Year observed 2027-01-01; MLK; Washington; Good Friday;
  // Memorial; Juneteenth observed 06-18; Independence observed 07-05; Labor;
  // Thanksgiving; Christmas observed 12-24).
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31",
  "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
]);
// NOTE: this static set must be extended each year (or replaced with an exchange
// calendar source) — the freshness gate will mis-classify holidays past the last
// listed year. Tracked as a known limitation.

function isWeekend(dateStr) {
  // Use noon UTC to get an unambiguous weekday for a calendar date.
  const day = new Date(`${dateStr}T12:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}

export function isTradingDay(dateStr) {
  return !isWeekend(dateStr) && !MARKET_HOLIDAYS.has(dateStr);
}

function prevDay(dateStr) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function etNow(now = new Date()) {
  // Returns { date: 'YYYY-MM-DD', hour: 0-23 } in America/New_York.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", hour12: false,
  }).formatToParts(now);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  let hour = parseInt(p.hour, 10);
  if (hour === 24) hour = 0; // some ICU builds emit 24 for midnight
  return { date: `${p.year}-${p.month}-${p.day}`, hour };
}

// The most recent trading day whose EOD bar should exist by now.
export function mostRecentTradingDay(now = new Date()) {
  const { date, hour } = etNow(now);
  let d = date;
  // Today's bar isn't available until after the close + data settle (~18:00 ET).
  if (!(isTradingDay(d) && hour >= 18)) d = prevDay(d);
  while (!isTradingDay(d)) d = prevDay(d);
  return d;
}

// ---------------------------------------------------------------------------
// Indicators (pure).
// ---------------------------------------------------------------------------
export function sma(values, period) {
  if (values.length < period) return null;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i++) sum += values[i];
  return sum / period;
}

// SMA `period` ending `lag` bars before the latest bar (for slope/trend-template).
export function smaLagged(values, period, lag) {
  if (values.length < period + lag) return null;
  return sma(values.slice(0, values.length - lag), period);
}

// % change of the `period`-SMA now vs `lag` bars ago — Minervini "200MA rising".
// Positive = the MA is sloping up.
export function maSlopePct(values, period, lag) {
  const now = sma(values, period);
  const then = smaLagged(values, period, lag);
  if (now == null || then == null || !(then > 0)) return null;
  return Math.round((now / then - 1) * 1e4) / 1e2;
}

// Highest high over the `n` bars BEFORE the latest bar (Turtle breakout: a close
// above this is a fresh N-day high). Returns null if not enough history.
export function priorHighN(bars, n) {
  if (bars.length < n + 1) return null;
  const window = bars.slice(bars.length - 1 - n, bars.length - 1);
  let hi = -Infinity;
  for (const b of window) if (b.high > hi) hi = b.high;
  return hi === -Infinity ? null : hi;
}

// Wilder/RMA ATR. bars: [{high, low, close}] ascending.
export function atrWilder(bars, period = 14) {
  if (bars.length < period + 1) return null;
  const tr = [];
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].high, l = bars[i].low, pc = bars[i - 1].close;
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  // Seed with simple average of first `period` true ranges, then Wilder-smooth.
  let atr = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < tr.length; i++) {
    atr = (atr * (period - 1) + tr[i]) / period;
  }
  return atr;
}

// Wilder/RMA RSI. closes ascending.
export function rsiWilder(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const ch = closes[i] - closes[i - 1];
    if (ch >= 0) gain += ch; else loss -= ch;
  }
  let avgGain = gain / period, avgLoss = loss / period;
  for (let i = period + 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const g = ch >= 0 ? ch : 0;
    const l = ch < 0 ? -ch : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
  }
  // A dead-flat series has no gains AND no losses → neutral, not overbought.
  if (avgGain === 0 && avgLoss === 0) return 50;
  if (avgLoss === 0) return 100; // only gains → genuinely overbought
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// ---------------------------------------------------------------------------
// Swing-pivot support/resistance.
// bars ascending: [{high, low, close, volume}]. Returns { nearestSupport,
// nearestResistance } where each is { price, touches, strength, brokenSupport }
// or null when no valid level exists on that side.
// ---------------------------------------------------------------------------
export function computeLevels(bars, atr, close, avgVolume, params = PARAMS) {
  const wing = params.pivotWing;
  const window = bars.slice(-params.pivotLookback);
  if (window.length < 2 * wing + 1 || !atr || atr <= 0) {
    return { nearestSupport: null, nearestResistance: null };
  }

  // 1) Find swing pivots (fractals). A pivot high's high strictly exceeds the
  //    `wing` bars on each side; a pivot low's low is strictly below them.
  const pivots = [];
  for (let i = wing; i < window.length - wing; i++) {
    const h = window[i].high, l = window[i].low;
    let isHigh = true, isLow = true;
    for (let j = i - wing; j <= i + wing; j++) {
      if (j === i) continue;
      if (window[j].high >= h) isHigh = false;
      if (window[j].low <= l) isLow = false;
    }
    if (isHigh) pivots.push({ price: h, idx: i, volume: window[i].volume, kind: "high" });
    if (isLow) pivots.push({ price: l, idx: i, volume: window[i].volume, kind: "low" });
  }
  if (pivots.length === 0) {
    return { nearestSupport: null, nearestResistance: null };
  }

  // 2) Cluster pivots into levels by price proximity. Merge while the gap to the
  //    running cluster mean is within min(0.75*ATR, 1.0% of price).
  pivots.sort((a, b) => a.price - b.price);
  const lastIdx = window.length - 1;
  const clusters = [];
  let cur = [pivots[0]];
  const tol = (priceRef) => Math.min(0.75 * atr, 0.01 * priceRef);
  for (let i = 1; i < pivots.length; i++) {
    const mean = cur.reduce((s, p) => s + p.price, 0) / cur.length;
    if (pivots[i].price - mean <= tol(mean)) {
      cur.push(pivots[i]);
    } else {
      clusters.push(cur);
      cur = [pivots[i]];
    }
  }
  clusters.push(cur);

  // 3) Build levels; reject those with too few touches; score strength.
  const levels = clusters
    .filter((c) => c.length >= params.minTouches)
    .map((c) => {
      const price = c.reduce((s, p) => s + p.price, 0) / c.length;
      const touches = c.length;
      const recencyIdx = Math.max(...c.map((p) => p.idx));
      const ageSpan = recencyIdx - Math.min(...c.map((p) => p.idx));
      const volPerTouch = c.reduce((s, p) => s + p.volume, 0) / touches;
      const fromLows = c.filter((p) => p.kind === "low").length;
      // Strength 0..1: touches + recency + age-span + volume-near-level.
      const nTouch = Math.min(touches / 5, 1);
      const nRecency = recencyIdx / lastIdx;
      const nAge = Math.min(ageSpan / window.length, 1);
      const nVol = avgVolume > 0 ? Math.min(volPerTouch / avgVolume, 2) / 2 : 0;
      const strength =
        0.4 * nTouch + 0.25 * nRecency + 0.2 * nAge + 0.15 * nVol;
      return { price, touches, strength: round(strength, 4), fromLows };
    });

  // 4) Classify vs current close. A level above price is resistance; below is
  //    support. A former-support level now above price is "broken support".
  let nearestResistance = null;
  let nearestSupport = null;
  for (const lv of levels) {
    if (lv.price > close) {
      if (!nearestResistance || lv.price < nearestResistance.price) {
        nearestResistance = {
          price: round(lv.price, 4),
          touches: lv.touches,
          strength: lv.strength,
          brokenSupport: lv.fromLows > lv.touches / 2,
        };
      }
    } else if (lv.price < close) {
      if (!nearestSupport || lv.price > nearestSupport.price) {
        nearestSupport = {
          price: round(lv.price, 4),
          touches: lv.touches,
          strength: lv.strength,
          brokenSupport: false,
        };
      }
    }
  }
  return { nearestSupport, nearestResistance };
}

function round(n, dp = 2) {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

// ---------------------------------------------------------------------------
// External feeds.
// ---------------------------------------------------------------------------
async function fetchJson(url, label) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`${label} request failed: ${res.status} ${res.statusText}`);
  }
  // Some providers (e.g. Tiingo) return HTTP 200 with a PLAIN-TEXT body on rate
  // limit / quota errors ("You have run out of your ... API limit"). Parsing that
  // as JSON yields an opaque "Unexpected token" error, so read text first and
  // surface a clear, classified message.
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    const snippet = text.slice(0, 80).replace(/\s+/g, " ").trim();
    if (/limit|exceed|rate|quota/i.test(text)) {
      throw new Error(`${label} rate-limited / quota: ${snippet}`);
    }
    throw new Error(`${label} non-JSON response: ${snippet}`);
  }
}

function isoDaysAgo(days, now = new Date()) {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

// Tiingo EOD daily history → ascending adjusted OHLCV bars from startDate.
async function fetchTiingoBars(ticker, token, startDate) {
  const url =
    `https://api.tiingo.com/tiingo/daily/${encodeURIComponent(ticker)}/prices` +
    `?startDate=${startDate}&format=json&resampleFreq=daily&token=${token}`;
  // Throttle (avoid burst 429s) + bounded retry on a transient/rate-limit 429.
  const rows = await tiingo(() => withRetry(() => fetchJson(url, "Tiingo"), { shouldRetry: isRateLimited }));
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(`Tiingo returned no bars for ${ticker}`);
  }
  return rows
    .map((r) => ({
      date: r.date.slice(0, 10),
      open: r.adjOpen ?? r.open,
      high: r.adjHigh ?? r.high,
      low: r.adjLow ?? r.low,
      close: r.adjClose ?? r.close,
      volume: r.adjVolume ?? r.volume,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// Public: raw ascending adjusted daily bars for a ticker. The labeler uses this
// to walk a signal forward from its entry date. `startDate` defaults to ~18
// months back (enough for indicator math); pass the entry date for labeling.
// Reads the Tiingo key from SSM (cached); the same adjusted series is used here
// and in getMarketData so entry/stop/target comparisons stay consistent.
export async function getDailyBars(ticker, { startDate, now = new Date() } = {}) {
  const token = await getParameter(SSM_PATHS.tiingo);
  const start = startDate ?? isoDaysAgo(560, now);
  return fetchTiingoBars(ticker, token, start);
}

// Finnhub earnings calendar → whole days until the next future earnings date
// (null if none scheduled in the look-ahead window).
//
// Resilience: Tiingo bars are the primary feed; Finnhub earnings is secondary.
// A Finnhub outage/rate-limit must NOT fail an otherwise-healthy, Tiingo-backed
// ticker — and must never abort the SPY regime check (getMarketRegime calls
// getMarketData("SPY"), so an uncaught throw here would null the regime and abort
// the whole scan). On failure we return null and let the scoring earnings gate
// treat unknown earnings as "not within 3 days" (fail-open) — mirroring
// fetchProfile's defensive pattern. We log a WARN, not the `gp_scan_failed`
// keyword, so this tolerated condition does not trip the ops alarm.
async function fetchDaysToEarnings(ticker, token, now = new Date()) {
  const from = now.toISOString().slice(0, 10);
  const to = isoDaysAgo(-90, now); // 90 days ahead
  const url =
    `https://finnhub.io/api/v1/calendar/earnings` +
    `?from=${from}&to=${to}&symbol=${encodeURIComponent(ticker)}&token=${token}`;
  let data;
  try {
    data = await finnhub(() => fetchJson(url, "Finnhub earnings"));
  } catch (err) {
    console.warn(`Finnhub earnings unavailable for ${ticker} (continuing, earnings gate fails open): ${err.message}`);
    return null;
  }
  const dates = (data?.earningsCalendar ?? [])
    .map((e) => e.date)
    .filter(Boolean)
    .filter((d) => d >= from)
    .sort();
  if (dates.length === 0) return null;
  const MS = 24 * 60 * 60 * 1000;
  const next = new Date(`${dates[0]}T00:00:00Z`);
  const today = new Date(`${from}T00:00:00Z`);
  return Math.round((next - today) / MS);
}

// Finnhub company profile → { sector, name, marketCapMillions }. One call covers
// all three (used for the correlation-gate sector and the alert's name/market cap).
async function fetchProfile(ticker, token) {
  const url =
    `https://finnhub.io/api/v1/stock/profile2` +
    `?symbol=${encodeURIComponent(ticker)}&token=${token}`;
  try {
    const d = await finnhub(() => fetchJson(url, "Finnhub profile"));
    return {
      sector: d?.finnhubIndustry ?? null,
      name: d?.name ?? null,
      marketCapMillions: typeof d?.marketCapitalization === "number" ? d.marketCapitalization : null,
    };
  } catch {
    return { sector: null, name: null, marketCapMillions: null };
  }
}

// Latest-bar % change vs the prior close (pure).
export function pctChange(bars) {
  if (bars.length < 2) return null;
  const last = bars[bars.length - 1].close;
  const prev = bars[bars.length - 2].close;
  if (!(prev > 0)) return null;
  return round((last / prev - 1) * 100, 2);
}

// Price return over the last `n` bars, % (pure). Raw relative-strength input —
// the percentile RS RANK across the universe is computed at analysis time, not
// here (it needs all tickers). null when history is short.
export function returnPct(bars, n) {
  if (bars.length < n + 1) return null;
  const last = bars[bars.length - 1].close;
  const past = bars[bars.length - 1 - n].close;
  if (!(past > 0)) return null;
  return round((last / past - 1) * 100, 2);
}

// 52-week high/low from the last ~252 trading bars (pure).
export function range52w(bars) {
  const w = bars.slice(-252);
  if (w.length === 0) return { low52: null, high52: null };
  let lo = Infinity;
  let hi = -Infinity;
  for (const b of w) {
    if (b.low < lo) lo = b.low;
    if (b.high > hi) hi = b.high;
  }
  return { low52: round(lo, 2), high52: round(hi, 2) };
}

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------
// Returns exactly the fields scoring needs, plus freshness metadata:
//   { ticker, close, ma50, ma200, atr, rsi, volume, avgVolume30,
//     nearestSupport, nearestResistance, daysToEarnings, sector,
//     dataAsOf, fresh }
// When the feed is stale or too short, returns { fresh: false } with dataAsOf so
// scoring can short-circuit to NO_DATA. Never throws on staleness — only on I/O.
export async function getMarketData(ticker, opts = {}) {
  const now = opts.now ?? new Date();
  const bars = await getDailyBars(ticker, { now });
  const dataAsOf = bars[bars.length - 1].date;
  const expected = mostRecentTradingDay(now);
  const fresh = dataAsOf >= expected;

  // Need enough history for the longest lookback (SMA200 / pivots).
  const minBars = Math.max(PARAMS.maLong, PARAMS.pivotLookback) + 1;
  if (!fresh || bars.length < minBars) {
    return {
      ticker,
      fresh: false,
      dataAsOf,
      reason: !fresh
        ? `stale feed: latest bar ${dataAsOf} < expected ${expected}`
        : `insufficient history: ${bars.length} bars (< ${minBars})`,
    };
  }

  const closes = bars.map((b) => b.close);
  const volumes = bars.map((b) => b.volume);
  const last = bars[bars.length - 1];

  const ma50 = sma(closes, PARAMS.maShort);
  const ma150 = sma(closes, PARAMS.maMid);
  const ma200 = sma(closes, PARAMS.maLong);
  const ma200SlopePct = maSlopePct(closes, PARAMS.maLong, PARAMS.maSlopeLag);
  const high20d = priorHighN(bars, PARAMS.breakoutShort);
  const high55d = priorHighN(bars, PARAMS.breakoutLong);
  const atr = atrWilder(bars, PARAMS.atrPeriod);
  const rsi = rsiWilder(closes, PARAMS.rsiPeriod);
  const avgVolume30 = sma(volumes, PARAMS.avgVolumeWindow);
  const { nearestSupport, nearestResistance } = computeLevels(
    bars, atr, last.close, avgVolume30, PARAMS
  );

  const { low52, high52 } = range52w(bars);
  const changePct = pctChange(bars);
  // Raw relative-strength inputs (1/3/6/12-month price returns) — captured for
  // later RS-rank analysis; not scored.
  const return21d = returnPct(bars, 21);
  const return63d = returnPct(bars, 63);
  const return126d = returnPct(bars, 126);
  const return252d = returnPct(bars, 252);

  const finnhubKey = await getParameter(SSM_PATHS.finnhub);
  const [daysToEarnings, profile] = await Promise.all([
    fetchDaysToEarnings(ticker, finnhubKey, now),
    fetchProfile(ticker, finnhubKey),
  ]);

  return {
    ticker,
    name: profile.name,
    marketCapMillions: profile.marketCapMillions,
    // Decision-relevant fields are kept at FULL PRECISION so scoring derives
    // stop/R:R and evaluates the close>200MA / R:R / RSI-band / ATR-stop gates on
    // exact numbers. Rounding happens only at the persistence boundary
    // (store.snapshotMetrics) and the display boundary (narration) — never before
    // the decision. Display-only fields (low52/high52/high20d/55d) stay rounded.
    close: last.close,
    pctChange: changePct,
    low52,
    high52,
    ma50,
    ma150,
    ma200,
    // v2 (captured, not yet scored — for Phase 8 analysis):
    ma200SlopePct, // >0 means the 200MA is rising (Minervini)
    high20d: high20d == null ? null : round(high20d, 2), // Turtle 20-day breakout level
    high55d: high55d == null ? null : round(high55d, 2), // Turtle 55-day breakout level
    return21d, return63d, return126d, return252d, // raw RS inputs (not scored)
    atr,
    rsi,
    volume: Math.round(last.volume),
    avgVolume30: Math.round(avgVolume30),
    nearestSupport,
    nearestResistance,
    daysToEarnings,
    sector: profile.sector,
    dataAsOf,
    fresh: true,
  };
}
