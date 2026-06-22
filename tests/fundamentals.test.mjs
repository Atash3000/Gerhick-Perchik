import { test } from "node:test";
import assert from "node:assert/strict";
import { extractFundamentals, getFundamentals } from "../lambdas/shared/fundamentals.mjs";

// Real Finnhub metric shape (subset, verified live on the free tier).
const METRIC = {
  epsGrowthQuarterlyYoy: 23.32,
  revenueGrowthQuarterlyYoy: 18.3,
  epsGrowthTTMYoy: 29.75,
  epsGrowth5Y: 18.8,
  revenueGrowth5Y: 14.52,
  grossMarginTTM: 68.31,
  roeTTM: 33.13,
  "totalDebt/totalEquityQuarterly": 0.249,
};

test("extractFundamentals maps the curated O'Neil capture set", () => {
  const f = extractFundamentals(METRIC);
  assert.equal(f.epsGrowthQtr, 23.32);
  assert.equal(f.salesGrowthQtr, 18.3);
  assert.equal(f.annualEpsGrowth, 29.75);
  assert.equal(f.epsGrowth5Y, 18.8);
  assert.equal(f.salesGrowth5Y, 14.52);
  assert.equal(f.grossMarginTTM, 68.31);
  assert.equal(f.roeTTM, 33.13);
  assert.equal(f.debtToEquity, 0.249);
});

test("extractFundamentals returns all-null on empty/missing metric", () => {
  const f = extractFundamentals(null);
  assert.equal(f.epsGrowthQtr, null);
  assert.equal(f.debtToEquity, null);
  // falls back across candidate keys
  assert.equal(extractFundamentals({ epsGrowth3Y: 12 }).annualEpsGrowth, 12);
  assert.equal(extractFundamentals({ grossMarginAnnual: 50 }).grossMarginTTM, 50);
});

test("getFundamentals parses a 200 response via injected fetch", async () => {
  const fetchFn = async () => ({ ok: true, json: async () => ({ metric: METRIC }) });
  const f = await getFundamentals("MSFT", { apiKey: "K", fetchFn });
  assert.equal(f.epsGrowthQtr, 23.32);
  assert.equal(f.roeTTM, 33.13);
});

test("getFundamentals is best-effort — returns nulls on non-200 or throw, never rejects", async () => {
  const non200 = await getFundamentals("X", { apiKey: "K", fetchFn: async () => ({ ok: false }) });
  assert.equal(non200.epsGrowthQtr, null);

  const threw = await getFundamentals("X", { apiKey: "K", fetchFn: async () => { throw new Error("net"); } });
  assert.equal(threw.salesGrowthQtr, null);
});
