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

import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";

const SSM_PATHS = {
  tiingo: "/edge-hunter/tiingo/api_key",
  finnhub: "/edge-hunter/finnhub/api_key",
};

// Detection / indicator parameters (v1).
export const PARAMS = {
  maShort: 50,
  maLong: 200,
  atrPeriod: 14,
  rsiPeriod: 14,
  avgVolumeWindow: 30,
  pivotWing: 3, // bars required on each side of a swing pivot
  pivotLookback: 126, // ~6 months of trading days scanned for levels
  minTouches: 2, // a level needs at least this many pivots to be valid
};

// ---------------------------------------------------------------------------
// Secrets (SSM) — never log or return these values.
// ---------------------------------------------------------------------------
const _secretCache = new Map();
let _ssm;
function ssmClient() {
  if (!_ssm) _ssm = new SSMClient({});
  return _ssm;
}

async function getSecret(path) {
  if (_secretCache.has(path)) return _secretCache.get(path);
  const out = await ssmClient().send(
    new GetParameterCommand({ Name: path, WithDecryption: true })
  );
  const value = out?.Parameter?.Value;
  if (!value) throw new Error(`SSM parameter has no value: ${path}`);
  _secretCache.set(path, value);
  return value;
}

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
]);

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
  if (avgLoss === 0) return 100;
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
  return res.json();
}

function isoDaysAgo(days, now = new Date()) {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

// Tiingo EOD daily history → ascending adjusted OHLCV bars.
async function fetchTiingoBars(ticker, token, now = new Date()) {
  const startDate = isoDaysAgo(560, now); // ~18 months of calendar days
  const url =
    `https://api.tiingo.com/tiingo/daily/${encodeURIComponent(ticker)}/prices` +
    `?startDate=${startDate}&format=json&resampleFreq=daily&token=${token}`;
  const rows = await fetchJson(url, "Tiingo");
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

// Finnhub earnings calendar → whole days until the next future earnings date
// (null if none scheduled in the look-ahead window).
async function fetchDaysToEarnings(ticker, token, now = new Date()) {
  const from = now.toISOString().slice(0, 10);
  const to = isoDaysAgo(-90, now); // 90 days ahead
  const url =
    `https://finnhub.io/api/v1/calendar/earnings` +
    `?from=${from}&to=${to}&symbol=${encodeURIComponent(ticker)}&token=${token}`;
  const data = await fetchJson(url, "Finnhub earnings");
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

// Finnhub company profile → sector (finnhubIndustry). Informational; the
// correlation gate uses gp-watchlist.sector as source of truth.
async function fetchSector(ticker, token) {
  const url =
    `https://finnhub.io/api/v1/stock/profile2` +
    `?symbol=${encodeURIComponent(ticker)}&token=${token}`;
  try {
    const data = await fetchJson(url, "Finnhub profile");
    return data?.finnhubIndustry ?? null;
  } catch {
    return null;
  }
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
  const [tiingoKey, finnhubKey] = await Promise.all([
    getSecret(SSM_PATHS.tiingo),
    getSecret(SSM_PATHS.finnhub),
  ]);

  const bars = await fetchTiingoBars(ticker, tiingoKey, now);
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
  const ma200 = sma(closes, PARAMS.maLong);
  const atr = atrWilder(bars, PARAMS.atrPeriod);
  const rsi = rsiWilder(closes, PARAMS.rsiPeriod);
  const avgVolume30 = sma(volumes, PARAMS.avgVolumeWindow);
  const { nearestSupport, nearestResistance } = computeLevels(
    bars, atr, last.close, avgVolume30, PARAMS
  );

  const [daysToEarnings, sector] = await Promise.all([
    fetchDaysToEarnings(ticker, finnhubKey, now),
    fetchSector(ticker, finnhubKey),
  ]);

  return {
    ticker,
    close: round(last.close, 2),
    ma50: round(ma50, 2),
    ma200: round(ma200, 2),
    atr: round(atr, 2),
    rsi: round(rsi, 2),
    volume: Math.round(last.volume),
    avgVolume30: Math.round(avgVolume30),
    nearestSupport,
    nearestResistance,
    daysToEarnings,
    sector,
    dataAsOf,
    fresh: true,
  };
}
