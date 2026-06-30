// J — trend-MA sweep (stability check, NOT optimization). Trade the locked 100.
const VALUES = [80, 90, 100, 110, 120, 150];

export function runTrendMaSweep(baseInputs, runMetrics) {
  return VALUES.map((trendMa) => {
    const m = runMetrics({ ...baseInputs, config: { ...baseInputs.config, trendMa } }, {});
    return { trendMa, cagr: m.cagr, maxDrawdown: m.maxDrawdown };
  });
}
