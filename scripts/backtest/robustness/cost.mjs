// E — cost sensitivity: re-run at 2× slippage; the edge must survive.
export function runCostSensitivity(baseInputs, runMetrics) {
  const base = runMetrics(baseInputs, {});
  const cfg2 = { ...baseInputs.config, slippageBps: baseInputs.config.slippageBps * 2 };
  const double = runMetrics({ ...baseInputs, config: cfg2 }, {});
  return {
    base: { cagr: base.cagr, maxDrawdown: base.maxDrawdown },
    double: { cagr: double.cagr, maxDrawdown: double.maxDrawdown },
  };
}
