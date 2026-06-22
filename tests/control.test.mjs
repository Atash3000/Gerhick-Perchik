import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseCommand,
  computeStats,
  formatStats,
  formatAlarm,
  formatEt,
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

const OUTCOMES = [
  { status: "CLOSED", strategyVersion: "gp-1.0.0", outcome: "TARGET", score: 81, entry: 100, stop: 97, profitPct: 9.7, sk: 1000 },
  { status: "CLOSED", strategyVersion: "gp-1.0.0", outcome: "STOP", score: 72, entry: 100, stop: 97, profitPct: -3.3, sk: 2000 },
  { status: "CLOSED", strategyVersion: "gp-1.0.0", outcome: "TIMEOUT", score: 65, entry: 100, stop: 98, profitPct: 1.0, sk: 3000 },
  { status: "CLOSED", strategyVersion: "gp-OLD", outcome: "TARGET", score: 80, entry: 100, stop: 97, profitPct: 9.7, sk: 4000 },
  { status: "OPEN", strategyVersion: "gp-1.0.0", score: 90, sk: 5000 },
];

test("computeStats filters by status + version and computes win-rate / avg R", () => {
  const s = computeStats(OUTCOMES, { strategyVersion: "gp-1.0.0" });
  assert.equal(s.overall.n, 3); // OPEN and gp-OLD excluded
  assert.equal(s.overall.wins, 1);
  assert.equal(s.overall.stops, 1);
  assert.equal(s.overall.timeouts, 1);
  assert.equal(s.overall.winRate, 33.3);
  assert.equal(s.overall.avgProfitPct, 2.47); // (9.7 - 3.3 + 1.0)/3
  assert.equal(s.overall.avgR, 0.88); // (3.233 - 1.1 + 0.5)/3
  assert.equal(s.byBucket["80s"].n, 1);
  assert.equal(s.byBucket["70s"].n, 1);
  assert.equal(s.byBucket["60s"].n, 1);
});

test("computeStats honors the sinceEpochMs window", () => {
  const s = computeStats(OUTCOMES, { strategyVersion: "gp-1.0.0", sinceEpochMs: 2500 });
  assert.equal(s.overall.n, 1); // only sk >= 2500 within version
});

test("formatStats renders a summary, and a friendly empty message", () => {
  const s = computeStats(OUTCOMES, { strategyVersion: "gp-1.0.0" });
  const text = formatStats(s, "30d");
  assert.match(text, /Stats \(30d\) — gp-1\.0\.0/);
  assert.match(text, /win 33\.3%/);
  assert.match(text, /80s:/);

  const empty = computeStats([], { strategyVersion: "gp-1.0.0" });
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
