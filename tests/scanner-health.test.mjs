import { test } from "node:test";
import assert from "node:assert/strict";
import { assessScanHealth, unionTickers, gatherUniverse, momentumFamilyOpen } from "../lambdas/scanner/handler.mjs";
import { planScan } from "../lambdas/scanner/orchestrate.mjs";

// --- assessScanHealth (coverage / silent-failure alarm) --------------------

test("assessScanHealth: 0 snapshots is unhealthy", () => {
  const r = assessScanHealth({ expectedCount: 10, snapshotsWritten: 0, errorCount: 0, freshDataCount: 0 });
  assert.equal(r.healthy, false);
  assert.match(r.reason, /no snapshots/);
});

test("assessScanHealth: high error rate is unhealthy", () => {
  const r = assessScanHealth({ expectedCount: 10, snapshotsWritten: 10, errorCount: 6, freshDataCount: 10 });
  assert.equal(r.healthy, false);
  assert.match(r.reason, /high error rate/);
});

test("assessScanHealth: low fresh coverage is unhealthy", () => {
  const r = assessScanHealth({ expectedCount: 10, snapshotsWritten: 4, errorCount: 0, freshDataCount: 4 });
  assert.equal(r.healthy, false);
  assert.match(r.reason, /low coverage/);
});

test("assessScanHealth: a healthy scan passes", () => {
  assert.deepEqual(
    assessScanHealth({ expectedCount: 10, snapshotsWritten: 10, errorCount: 0, freshDataCount: 9 }),
    { healthy: true, reason: null }
  );
});

// --- #4: union gather (held positions are NEVER stranded) ------------------

test("unionTickers: a held position DISABLED/absent from the watchlist is still included", () => {
  const enabled = [{ ticker: "NEW", sector: "Tech" }];
  const open = [{ ticker: "OLD", sector: "Energy" }]; // held but NOT on the enabled watchlist
  const u = unionTickers(enabled, open);
  assert.deepEqual(u.map((x) => x.ticker).sort(), ["NEW", "OLD"]); // OLD survives → gathered + managed
  assert.equal(u.find((x) => x.ticker === "OLD").sector, "Energy"); // sector preserved from the outcome
});

test("unionTickers: an enabled+held ticker appears once; the enabled sector wins", () => {
  const u = unionTickers([{ ticker: "X", sector: "Tech" }], [{ ticker: "X", sector: "STALE" }]);
  assert.equal(u.length, 1);
  assert.equal(u[0].sector, "Tech");
});

// --- gatherUniverse + the #4 end-to-end management proof -------------------

const CFG = {
  regimeMa: 200, trendMa: 100, momentumLookback: 90, gapFilterWindow: 90, gapFilterPct: 15,
  atrPeriod: 20, minPrice: 5, minDollarVol: 10_000_000, kStop: 2.5, riskPctPerTrade: 0.75,
  positionCapPct: 15, entryRankPct: 20, exitRankPct: 30, targetPositions: 15, maxPositions: 20,
  feeBps: 10, slippageBps: 5,
};
const NOW = new Date("2026-06-26T23:00:00Z"); // Fri after close → 2026-06-26 is the latest trading day

// 260 ascending bars of a clean, liquid uptrend ending on 2026-06-26.
function freshBars() {
  const out = [];
  let d = new Date("2026-06-26T00:00:00Z");
  for (let i = 259; i >= 0; i--) {
    const close = 100 + i * 0.2; // newest bar (i=0) is highest
    out.unshift({ date: d.toISOString().slice(0, 10), open: close, high: close * 1.01, low: close * 0.99, close, volume: 1_000_000 });
    d = new Date(d.getTime() - 86_400_000);
  }
  return out;
}

// Deterministic rank stub (the real rankByMomentum is covered by the portfolio tests).
function rankStub(eligible) {
  return eligible.map((g) => g.ticker).sort().map((ticker, i) => ({
    ticker, rank: i + 1, rankPct: 99 - i, inEntryZone: i === 0, inExitZone: i > 0, momentum: 1 - i * 0.1, slope: 0.001, r2: 0.9,
  }));
}

test("gatherUniverse builds md+eligibility; a fetch error becomes a NO_DATA row, not a throw", async () => {
  const fetchBars = async (t) => { if (t === "BAD") throw new Error("429 rate limited"); return freshBars(); };
  const got = await gatherUniverse([{ ticker: "GOOD", sector: "T" }, { ticker: "BAD", sector: "T" }], CFG, { fetchBars, now: NOW });
  const good = got.find((g) => g.ticker === "GOOD");
  const bad = got.find((g) => g.ticker === "BAD");
  assert.equal(good.md.fresh, true);
  assert.equal(good.eligibility.eligible, true);
  assert.equal(bad.md.fresh, false); // fetch error → NO_DATA, kept in the universe
  assert.equal(bad.fetchError, true);
});

test("#4 end-to-end: a DISABLED, still-held position is gathered AND managed (never stranded)", async () => {
  // OLD is held but not on the enabled watchlist (disabled for new buys, still owned).
  const enabled = [{ ticker: "NEW", sector: "T" }];
  const open = [{ pk: "S#OLD", sk: 1, ticker: "OLD", sector: "T", entry: 100, stop: 90, peakClose: 100, entryDate: "2026-06-01", strategyVersion: "gp-momentum-1.0.0" }];

  const tickers = unionTickers(enabled, open);
  const gathered = await gatherUniverse(tickers, CFG, { fetchBars: async () => freshBars(), now: NOW });
  const eligible = gathered.filter((g) => g.md.fresh && g.eligibility.eligible);
  const plan = planScan({
    config: CFG, regimeOn: true, asOf: "2026-06-26", gathered, ranked: rankStub(eligible),
    openOutcomes: open, governor: { blockNewBuys: false }, accountValue: 100_000, spy: { spyBelow200ma: false },
  });

  const managed = new Set([...plan.exits.map((e) => e.ticker), ...plan.refreshes.map((r) => r.ticker)]);
  assert.ok(managed.has("OLD"), "a disabled-but-held position must still be managed, never stranded");
});

test("momentumFamilyOpen: keeps gp-momentum-* positions, excludes legacy/non-momentum", () => {
  const got = momentumFamilyOpen([
    { ticker: "A", strategyVersion: "gp-momentum-1.0.0" },
    { ticker: "B", strategyVersion: "gp-momentum-1.1.0" }, // a future bump — still managed (no stranding)
    { ticker: "C", strategyVersion: "gp-2.0.0" }, // legacy — excluded (no momentum mis-close)
    { ticker: "D" }, // missing version → excluded
  ]);
  assert.deepEqual(got.map((o) => o.ticker), ["A", "B"]);
});
