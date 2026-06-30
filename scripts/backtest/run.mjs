// run.mjs — CLI entrypoint. Wires data → engine → metrics → benchmark →
// robustness → report, writes docs/backtest/Scorecard-run-<ts>.{md,json}.
// Thin shell: all logic lives in the pure modules. Reuses getActiveConfig +
// getDailyBars from the live stack. Nothing here is live — read-only + local files.
//
// CLI flags (all optional):
//   --refresh          ignore the disk cache and re-fetch all bars from Tiingo
//   --limit N          only run on the first N tickers (smoke-test / fast subset)
//   --since YYYY-MM-DD override the default startDate (default: 2010-01-01)
//
// The --limit / --since flags produce a SUBSET SMOKE RUN. The artifact is clearly
// marked; a full battery over the whole watchlist is build-order step 6, run by
// a human after reviewing the subset artifact.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getActiveConfig } from "../../lambdas/shared/config.mjs";
import { getDailyBars } from "../../lambdas/shared/marketdata.mjs";
import { STRATEGY_VERSION } from "../../lambdas/shared/version.mjs";
import { simulate } from "./engine.mjs";
import { computeMetrics } from "./metrics.mjs";
import { spyBuyHold } from "./benchmark.mjs";
import { buildReport } from "./report.mjs";
import { loadUniverse, buildCalendar, coverageByWindow, detectStaleAndSplits } from "./data.mjs";
import { runAblation } from "./robustness/ablation.mjs";
import { runBaselines } from "./robustness/baseline.mjs";
import { runRebalanceDays } from "./robustness/rebalance-day.mjs";
import { runCostSensitivity } from "./robustness/cost.mjs";
import { runConcentration } from "./robustness/concentration.mjs";
import { runTrendMaSweep } from "./robustness/sweep.mjs";

// ── CLI args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const refresh = args.includes("--refresh");
const limitArg = args.indexOf("--limit");
const sinceArg = args.indexOf("--since");
const limitN = limitArg !== -1 ? parseInt(args[limitArg + 1], 10) : null;
const startDate = sinceArg !== -1 ? args[sinceArg + 1] : "2010-01-01";
const isSubset = limitN != null || startDate !== "2010-01-01";

if (limitN != null && (!Number.isInteger(limitN) || limitN < 1)) {
  console.error("--limit must be a positive integer");
  process.exit(1);
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
  console.error("--since must be YYYY-MM-DD");
  process.exit(1);
}

// ── Setup ─────────────────────────────────────────────────────────────────────
const __dir = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dir, ".cache");

const config = await getActiveConfig();
const gitSha = execFileSync("git", ["rev-parse", "--short", "HEAD"]).toString().trim();
const nowIso = new Date().toISOString();

if (isSubset) {
  console.log(`\n⚠  SUBSET SMOKE RUN — limit=${limitN ?? "all"}, since=${startDate}. For a verdict, run the full battery.\n`);
}
if (refresh) console.log("--refresh: ignoring cache, re-fetching all bars from Tiingo");

// ── Watchlist ─────────────────────────────────────────────────────────────────
const watchlistRaw = JSON.parse(
  await readFile(new URL("../../seed/watchlist.json", import.meta.url))
);
let allTickers = (Array.isArray(watchlistRaw) ? watchlistRaw : watchlistRaw.tickers ?? [])
  .map((w) => (typeof w === "string" ? w : w.ticker))
  .filter(Boolean);
if (limitN != null) allTickers = allTickers.slice(0, limitN);

// ── Fetch bars (cache-first; 250 ms throttle between live fetches) ─────────────
// fetchBars closes over `startDate` so the same value is used for caching keying.
// `loadUniverse` calls fetchBars(ticker, startDate) but the second arg is ignored
// here — the cache module uses the outer startDate for the cache filename.
// --refresh: bypass the cache READ but still WRITE to the canonical CACHE_DIR so
// subsequent non-refresh runs pick up the fresh data immediately.
const fetchBars = async (ticker) => {
  await new Promise((r) => setTimeout(r, 250));
  try {
    return await getDailyBars(ticker, { startDate });
  } catch (err) {
    console.warn(`  [WARN] ${ticker}: fetch failed (${err.message}) — skipping`);
    return [];
  }
};

console.log(`Loading SPY...`);
const spyRaw = (await loadUniverse({
  tickers: ["SPY"],
  startDate,
  dir: CACHE_DIR,
  fetchBars,
  now: nowIso,
  skipCacheRead: refresh,
}))[0];

// SPY is required — the calendar, regime filter, and benchmark all depend on it.
if (!spyRaw || !spyRaw.bars || spyRaw.bars.length === 0) {
  console.error("[ERROR] SPY returned no bars — cannot build calendar/regime/benchmark. Aborting.");
  process.exit(1);
}

console.log(`Loading ${allTickers.length} universe tickers (cache-first)...`);
const universeRaw = await loadUniverse({
  tickers: allTickers,
  startDate,
  dir: CACHE_DIR,
  fetchBars,
  now: nowIso,
  throttleMs: 250,
  skipCacheRead: refresh,
});

// Filter out any ticker that returned no bars (data gap, unlisted, etc.).
// Collecting warnings to surface in the Scorecard report.
const emptyBarWarnings = [];
const universe = universeRaw.filter((u) => {
  if (!u.bars || u.bars.length === 0) {
    const msg = `${u.ticker ?? u.symbol ?? "?"}: Tiingo returned no bars — excluded from universe`;
    console.warn(`  [WARN] ${msg}`);
    emptyBarWarnings.push(msg);
    return false;
  }
  return true;
});
console.log(`Loaded ${universeRaw.length} tickers; ${universe.length} with bars (${emptyBarWarnings.length} dropped).`);

// ── Calendar ──────────────────────────────────────────────────────────────────
const calendar = buildCalendar(
  spyRaw.bars,
  startDate,
  spyRaw.bars[spyRaw.bars.length - 1].date
);
const inputs = { universe, spyBars: spyRaw.bars, calendar, config };

// ── runMetrics closure — consumed by all robustness modules ───────────────────
const runMetrics = (inp, opts) => {
  const { equityCurve, ledger } = simulate({ ...inputs, ...inp }, opts);
  return computeMetrics(equityCurve, ledger, { startEquity: config.accountSize });
};

// ── Primary run ───────────────────────────────────────────────────────────────
console.log(`Running primary simulation (${calendar.length} sessions)...`);
const { equityCurve, ledger } = simulate(inputs, {});
const strategy = computeMetrics(equityCurve, ledger, { startEquity: config.accountSize });

console.log(`Running SPY buy-and-hold benchmark...`);
const spyRun = spyBuyHold(spyRaw.bars, calendar, config.accountSize, config);
const spy = computeMetrics(spyRun.equityCurve, spyRun.ledger, { startEquity: config.accountSize });

// ── Robustness battery ────────────────────────────────────────────────────────
console.log("Running robustness battery (A/B/C/E/G/J)...");
const tests = {
  ablation: runAblation(inputs, runMetrics),
  baseline: runBaselines(inputs, runMetrics),
  rebalanceDay: runRebalanceDays(inputs, runMetrics),
  cost: runCostSensitivity(inputs, runMetrics),
  concentration: runConcentration(equityCurve),
  sweep: runTrendMaSweep(inputs, runMetrics),
};

// ── Coverage + stale warnings ─────────────────────────────────────────────────
const windows = [
  { window: "full period", start: calendar[0], end: calendar[calendar.length - 1] },
  { window: "2008-2009", start: "2008-01-01", end: "2009-12-31" },
  { window: "2020 crash", start: "2020-02-01", end: "2020-04-30" },
  { window: "2022", start: "2022-01-01", end: "2022-12-31" },
];
const coverage = coverageByWindow(universe, windows);
const warnings = [
  ...emptyBarWarnings,
  ...detectStaleAndSplits(universe, { now: nowIso, maxAgeDays: 7 }),
];

// ── Build + write report ──────────────────────────────────────────────────────
const { markdown, json } = buildReport({
  strategyVersion: STRATEGY_VERSION,
  gitSha,
  runTimestamp: nowIso,
  isSubsetRun: isSubset,
  subsetParams: isSubset ? { limit: limitN, since: startDate } : undefined,
  period: { start: calendar[0], end: calendar[calendar.length - 1] },
  universeSize: universe.length,
  params: config,
  strategy,
  spy,
  tests,
  coverage,
  warnings,
});

// Inject subset banner into the markdown if this is a smoke run.
const finalMarkdown = isSubset
  ? markdown.replace(
      "> **PRELIMINARY",
      `> **SUBSET SMOKE RUN — limit=${limitN ?? "all"} tickers, since=${startDate}. NOT a verdict.** This artifact validates the pipeline wiring only. Re-run without --limit / --since for the full step-6 production battery.\n\n> **PRELIMINARY`
    )
  : markdown;

const outDir = new URL("../../docs/backtest/", import.meta.url);
await mkdir(outDir, { recursive: true });

const stamp = nowIso.replace(/[:.]/g, "-");
const prefix = isSubset ? `Scorecard-smoke-${stamp}` : `Scorecard-run-${stamp}`;
await writeFile(new URL(`${prefix}.md`, outDir), finalMarkdown);
await writeFile(new URL(`${prefix}.json`, outDir), JSON.stringify(json, null, 2));

console.log(
  `\nPRELIMINARY (survivorship-biased). Strategy CAGR ${strategy.cagr}% vs SPY ${spy.cagr}%. Report → docs/backtest/${prefix}.md`
);
