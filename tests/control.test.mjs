import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseCommand,
  computeStats,
  formatStats,
  formatAlarm,
  formatEt,
  parseTradeArgs,
  formatBought,
  formatSell,
  formatSkip,
  formatPositions,
} from "../lambdas/control/commands.mjs";

test("parseCommand handles commands, args, bot mentions, and casing", () => {
  assert.deepEqual(parseCommand("/start"), { cmd: "start", arg: null, args: [] });
  assert.equal(parseCommand("/start@gp_bot").cmd, "start");
  assert.deepEqual(parseCommand("/mode live").cmd, "mode");
  assert.equal(parseCommand("/mode live").arg, "live");
  assert.equal(parseCommand("/enable aapl").arg, "AAPL"); // tickers upper-cased
  assert.equal(parseCommand("/disable MSFT").arg, "MSFT");
  assert.equal(parseCommand("/stats 30d").arg, "30d");
  assert.equal(parseCommand("hello"), null); // not a command
  assert.equal(parseCommand(""), null);
});

// Momentum-shaped outcomes: outcome STOP|EXIT|TIMEOUT (no TARGET), rankPct (no score).
const OUTCOMES = [
  { status: "CLOSED", strategyVersion: "gp-momentum-1.0.0", outcome: "EXIT", rankPct: 95, entry: 100, stop: 90, profitPct: 9.7, sk: 1000 }, // win
  { status: "CLOSED", strategyVersion: "gp-momentum-1.0.0", outcome: "STOP", rankPct: 70, entry: 100, stop: 90, profitPct: -3.3, sk: 2000 }, // loss
  { status: "CLOSED", strategyVersion: "gp-momentum-1.0.0", outcome: "TIMEOUT", rankPct: 50, entry: 100, stop: 95, profitPct: 1.0, sk: 3000 }, // win
  { status: "CLOSED", strategyVersion: "gp-OLD", outcome: "STOP", rankPct: 90, entry: 100, stop: 90, profitPct: 5, sk: 4000 }, // other version
  { status: "OPEN", strategyVersion: "gp-momentum-1.0.0", rankPct: 99, sk: 5000 }, // open
];

test("computeStats: momentum win = profitPct>0 (not TARGET), bucketed by rank %", () => {
  const s = computeStats(OUTCOMES, { strategyVersion: "gp-momentum-1.0.0" });
  assert.equal(s.overall.n, 3); // OPEN + gp-OLD excluded
  assert.equal(s.overall.wins, 2); // 9.7 and 1.0 are after-cost positive — NOT just a TARGET
  assert.equal(s.overall.stops, 1);
  assert.equal(s.overall.exits, 1);
  assert.equal(s.overall.timeouts, 1);
  assert.equal(s.overall.winRate, 66.7); // 2/3, NOT a fake 0%
  assert.equal(s.overall.avgProfitPct, 2.47); // (9.7 - 3.3 + 1.0)/3
  assert.equal(s.overall.avgR, 0.28); // (0.97 - 0.33 + 0.2)/3
  assert.equal(s.byBucket["80-100%"].n, 1);
  assert.equal(s.byBucket["60-80%"].n, 1);
  assert.equal(s.byBucket["40-60%"].n, 1);
});

test("computeStats honors the sinceEpochMs window", () => {
  const s = computeStats(OUTCOMES, { strategyVersion: "gp-momentum-1.0.0", sinceEpochMs: 2500 });
  assert.equal(s.overall.n, 1); // only sk >= 2500 within version
});

test("formatStats renders a momentum summary, and a friendly empty message", () => {
  const s = computeStats(OUTCOMES, { strategyVersion: "gp-momentum-1.0.0" });
  const text = formatStats(s, "30d");
  assert.match(text, /Stats \(30d\) — gp-momentum-1\.0\.0/);
  assert.match(text, /win 66\.7%/);
  assert.match(text, /By rank %:/);
  assert.match(text, /80-100%:/);

  const empty = computeStats([], { strategyVersion: "gp-momentum-1.0.0" });
  assert.match(formatStats(empty), /No closed outcomes yet/);
});

const ALARM_MSG = JSON.stringify({
  AlarmName: "gp-scan-failures",
  AlarmDescription: "Sustained gp_scan_failed events from the scanner or labeler.",
  NewStateValue: "ALARM",
  OldStateValue: "OK",
  NewStateReason: "Threshold Crossed: 1 datapoint [41.0 (22/06/26 14:36:00)] was greater than or equal to the threshold (3.0).",
  StateChangeTime: "2026-06-22T14:36:00.000Z", // 14:36 UTC = 10:36 AM EDT
  Region: "us-east-1",
  Trigger: { MetricName: "ScanFailures", Namespace: "GerchikPerchik", Threshold: 3, Period: 3600, EvaluationPeriods: 1 },
});

test("formatAlarm: structured ALARM message (value, threshold, ET time, hint)", () => {
  const out = formatAlarm(ALARM_MSG);
  assert.match(out, /GERCHIK-PERCHIK · OPS ALERT/);
  assert.match(out, /🔴 ALARM — gp-scan-failures/);
  assert.match(out, /🕐 .*10:36\s?AM EDT/); // NY local, not UTC
  assert.match(out, /📊 41 failures in 1h\s+\(alarm at ≥ 3\)/);
  assert.match(out, /💬 Sustained gp_scan_failed/);
  assert.match(out, /🔎 Often a data-feed \(Tiingo\) outage/);
  assert.match(out, /📂 GerchikPerchik\/ScanFailures/);
  assert.match(out, /🌎 us-east-1/);
});

test("formatAlarm: OK state renders a green RESOLVED message", () => {
  const ok = formatAlarm(JSON.stringify({ ...JSON.parse(ALARM_MSG), NewStateValue: "OK" }));
  assert.match(ok, /🟢 RESOLVED — gp-scan-failures/);
  assert.match(ok, /✅ Recovered/);
});

test("formatAlarm tolerates non-JSON", () => {
  assert.match(formatAlarm("plain text"), /OPS ALERT/);
  assert.match(formatAlarm("plain text"), /plain text/);
});

test("formatEt converts UTC ISO to NY local (EDT in summer)", () => {
  assert.match(formatEt("2026-06-22T14:36:00Z"), /10:36\s?AM EDT/);
  assert.equal(formatEt(null), null);
  assert.equal(formatEt("not-a-date"), null);
});

test("parseCommand upper-cases tickers for bought/sell/skip", () => {
  assert.equal(parseCommand("/bought nvda 20 249.99").arg, "NVDA");
  assert.deepEqual(parseCommand("/bought nvda 20 249.99").args, ["nvda", "20", "249.99"]);
  assert.equal(parseCommand("/sell nvda 10 260").arg, "NVDA");
  assert.equal(parseCommand("/skip amd too extended").arg, "AMD");
  assert.equal(parseCommand("/positions").cmd, "positions");
});

test("parseTradeArgs validates ticker/shares/price", () => {
  assert.deepEqual(parseTradeArgs(["nvda", "20", "249.99"]), { ok: true, ticker: "NVDA", shares: 20, price: 249.99 });
  assert.equal(parseTradeArgs(["NVDA", "20"]).ok, false); // missing price
  assert.equal(parseTradeArgs(["NVDA", "2.5", "10"]).error, "shares"); // non-integer
  assert.equal(parseTradeArgs(["NVDA", "0", "10"]).error, "shares"); // non-positive
  assert.equal(parseTradeArgs(["NVDA", "10", "0"]).error, "price"); // non-positive
  assert.equal(parseTradeArgs(["NVDA", "10", "abc"]).error, "price"); // NaN
});

test("formatBought distinguishes linked vs unlinked", () => {
  const linked = { ticker: "NVDA", originalShares: 20, actualEntry: 249.99, linked: true, sourceOutcomePk: "SIGNAL#NVDA#2026-06-20", entryDate: "2026-06-23" };
  assert.match(formatBought(linked), /✅ Bought NVDA 20 @ 249\.99\./);
  assert.match(formatBought(linked), /Linked to latest GP signal \(entry 2026-06-20\)/);
  const unlinked = { ticker: "AMD", originalShares: 5, actualEntry: 100, linked: false, sourceOutcomePk: null, entryDate: "2026-06-23" };
  assert.match(formatBought(unlinked), /No open GP signal found — position created as manual\/unlinked/);
});

test("formatSell renders partial and full close", () => {
  const header = { ticker: "NVDA" };
  const partial = { closed: false, saleDollars: 100.1, salePct: 4, updatedFields: { remainingShares: 10 } };
  assert.match(formatSell(partial, header, 10, 260), /📉 Sold 10 NVDA @ 260\.00 \(\+4\.00%, \+\$100\.10\)\. 10 remain open\./);
  const full = { closed: true, updatedFields: { realizedProfitDollars: 200.2, realizedProfitPctWeighted: 4 } };
  assert.match(formatSell(full, header, 10, 265), /🏁 Closed NVDA\. Realized \+\$200\.20 \(\+4\.00% weighted\)\./);
});

test("formatSkip + formatPositions", () => {
  assert.match(formatSkip({ ticker: "NVDA", linked: true }), /⏭️ Skipped NVDA \(linked to GP signal\)\./);
  assert.match(formatSkip({ ticker: "AMD", linked: false }), /⏭️ Skipped AMD \(unlinked\)\./);
  assert.match(formatPositions([]), /No open positions\./);
  const list = formatPositions([
    { ticker: "NVDA", remainingShares: 10, originalShares: 20, avgEntryPrice: 100, realizedProfitDollars: 100, linked: true },
  ]);
  assert.match(list, /NVDA 10\/20 @ 100\.00/);
  assert.match(list, /realized \+\$100\.00/);
  assert.match(list, /linked/);
});
