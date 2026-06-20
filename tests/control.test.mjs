import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseCommand,
  computeStats,
  formatStats,
  formatAlarm,
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

test("formatAlarm parses a CloudWatch SNS message, tolerates non-JSON", () => {
  const msg = JSON.stringify({
    AlarmName: "gp-scan-failures",
    NewStateValue: "ALARM",
    NewStateReason: "Threshold crossed",
  });
  const out = formatAlarm(msg);
  assert.match(out, /gp-scan-failures/);
  assert.match(out, /ALARM/);
  assert.match(formatAlarm("plain text"), /plain text/);
});
