// data.mjs — universe loading (cache-first), calendar, survivorship coverage,
// and stale-cache / split-discontinuity detection. fetchBars is injected so the
// engine/tests stay offline; run.mjs passes the real getDailyBars wrapper.
import { readCache, writeCache } from "./cache.mjs";

// skipCacheRead: when true, bypass the cache read and always fetch fresh bars from
// the network — but still WRITE to the canonical dir so the next non-refresh run
// picks up the fresh data. Used by run.mjs --refresh.
export async function loadUniverse({ tickers, startDate, dir, fetchBars, now, throttleMs = 0, skipCacheRead = false }) {
  const out = [];
  for (const ticker of tickers) {
    if (!skipCacheRead) {
      const cached = readCache(dir, ticker, startDate);
      if (cached) { out.push({ ticker, bars: cached.bars, fetchedAt: cached.fetchedAt }); continue; }
    }
    if (throttleMs) await new Promise((r) => setTimeout(r, throttleMs));
    const bars = await fetchBars(ticker, startDate);
    writeCache(dir, ticker, startDate, bars, now);
    out.push({ ticker, bars, fetchedAt: now });
  }
  return out;
}

export function buildCalendar(spyBars, start, end) {
  return spyBars.map((b) => b.date).filter((d) => d >= start && d <= end);
}

export function coverageByWindow(universe, windows) {
  return windows.map(({ window, start, end }) => {
    const namesWithData = universe.filter((u) => {
      if (!u.bars.length) return false;
      return u.bars[0].date <= start && u.bars[u.bars.length - 1].date >= end;
    }).length;
    return { window, namesWithData, total: universe.length };
  });
}

export function detectStaleAndSplits(universe, { now, maxAgeDays = 7, fetchedAtByTicker = {} }) {
  const warnings = [];
  const nowMs = new Date(now).getTime();
  for (const u of universe) {
    const fa = fetchedAtByTicker[u.ticker] ?? u.fetchedAt;
    if (fa) {
      const ageDays = (nowMs - new Date(fa).getTime()) / 86400000;
      if (ageDays > maxAgeDays) warnings.push(`${u.ticker}: cache age ${Math.round(ageDays)}d > ${maxAgeDays}d threshold — consider --refresh`);
    }
    for (let i = 1; i < u.bars.length; i++) {
      const prev = u.bars[i - 1].close, cur = u.bars[i].close;
      if (prev > 0) {
        const ratio = cur / prev;
        if (ratio > 1.5 || ratio < 0.67) warnings.push(`${u.ticker}: price discontinuity ${prev}→${cur} (${u.bars[i].date}) — possible unadjusted split, --refresh`);
      }
    }
  }
  return warnings;
}
