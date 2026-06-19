// Manual verification helper (NOT part of the deployed stack).
// Fetches one ticker via the real feeds, runs it through scoring, and prints both
// objects. Reads API keys from SSM by path; prints NO secret values.
//
//   node scripts/sample-msft.mjs MSFT
//
// Requires AWS credentials in the environment (local profile) with read access to
// the /edge-hunter/* SSM parameters.

import { getMarketData } from "../lambdas/shared/marketdata.mjs";
import { score } from "../lambdas/shared/scoring.mjs";

const ticker = process.argv[2] || "MSFT";

// Tunables that would normally come from gp-config (Phase 3). Hardcoded HERE only
// for this manual demo — never in the Lambdas.
const demoConfig = {
  buyScoreThreshold: 60,
  atrStopMultiple: 1.5,
  minRiskReward: 2.0,
  maxCorrelatedPositions: 3,
  alertMode: "observe",
  feeBps: 10,
  slippageBps: 5,
};

// Run-level context the scanner will supply later. Neutral defaults for the demo.
const demoContext = { spyBelow200ma: false, correlatedPositions: 0, newsLevel: "none" };

const md = await getMarketData(ticker);
console.log(`\n=== marketdata: ${ticker} ===`);
console.log(JSON.stringify(md, null, 2));

const result = score(md, demoConfig, demoContext);
console.log(`\n=== scoring: ${ticker} ===`);
console.log(JSON.stringify(result, null, 2));
