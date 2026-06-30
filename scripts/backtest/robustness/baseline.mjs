// A — dumb-baseline: does slope×R² beat plain return / plain slope? If it wins by
// < 1.5 pts CAGR, the report flags "switch to the simpler metric".
import { return126Ranker, return189Ranker, slopeRanker, momentumRanker } from "../rankers.mjs";

const RANKERS = [
  ["return126", return126Ranker],
  ["return189", return189Ranker],
  ["slopeOnly", slopeRanker],
  ["slopeR2", momentumRanker],
];

export function runBaselines(baseInputs, runMetrics) {
  return RANKERS.map(([metric, rankFn]) => ({
    metric,
    cagr: runMetrics(baseInputs, { rankFn }).cagr,
  }));
}
