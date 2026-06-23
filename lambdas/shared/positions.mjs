// positions.mjs — pure builders + P/L math for manual position tracking.
// No I/O, no clock, no RNG: positionId/id and timestamps are injected by the
// caller so every function is deterministic and unit-testable. The control
// handler supplies real crypto.randomUUID() ids and ISO timestamps.

export const positionPk = (ticker) => `POSITION#${ticker}`;
export const decisionPk = (ticker) => `DECISION#${ticker}`;

// Round to 2dp at the value boundary; null for non-finite input.
const round2 = (v) =>
  typeof v === "number" && Number.isFinite(v) ? Math.round(v * 100) / 100 : null;

// POSITION_HEADER for a fresh buy (v1: exactly one buy per position).
// linkedOutcome: { pk, sk, strategyVersion, stop, entryDate } | null.
export function buildPositionHeader({
  ticker,
  shares,
  price,
  entryDate,
  positionId,
  boughtAt,
  linkedOutcome = null,
  currentStrategyVersion,
  commandSource = "telegram",
}) {
  const linked = !!linkedOutcome;
  return {
    pk: positionPk(ticker),
    sk: `${entryDate}#${positionId}`,
    recordType: "POSITION_HEADER",
    ticker,
    status: "OPEN",
    positionId,
    entryDate,
    originalShares: shares,
    remainingShares: shares,
    avgEntryPrice: price,
    actualEntry: price,
    actualEntryValue: round2(shares * price),
    boughtAt,
    soldAt: null,
    closedAt: null,
    realizedProfitDollars: 0,
    realizedProfitPctWeighted: null,
    costBasisSoldCumulative: 0,
    linked,
    sourceOutcomePk: linkedOutcome?.pk ?? null,
    sourceOutcomeSk: linkedOutcome?.sk ?? null,
    strategyVersion: linkedOutcome?.strategyVersion ?? currentStrategyVersion ?? null,
    initialStop: linkedOutcome?.stop ?? null,
    currentTrailStop: linkedOutcome?.stop ?? null,
    trailModel: "none",
    pnlBasis: "actual-fill",
    commandSource,
    notes: null,
  };
}

export function buildBuyEvent({
  ticker,
  positionId,
  entryDate,
  shares,
  price,
  boughtAt,
  commandSource = "telegram",
}) {
  return {
    pk: positionPk(ticker),
    sk: `${entryDate}#${positionId}#BUY#${boughtAt}`,
    recordType: "BUY_EVENT",
    ticker,
    positionId,
    shares,
    price,
    boughtAt,
    commandSource,
  };
}

// Apply a sell against a POSITION_HEADER. Average-cost; actual-fill P/L only.
// Returns { error, held? } on rejection, else { event, updatedFields, closed,
// saleDollars, salePct }. updatedFields are the header attributes to SET.
export function applySell(header, { sharesSold, sellPrice, soldAt, commandSource = "telegram" }) {
  if (!Number.isInteger(sharesSold) || sharesSold <= 0) return { error: "invalid-shares" };
  const remaining = header.remainingShares;
  if (sharesSold > remaining) return { error: "oversell", held: remaining };

  const avgEntryPriceAtSale = header.avgEntryPrice;
  const saleDollars = round2((sellPrice - avgEntryPriceAtSale) * sharesSold);
  const salePct = round2((sellPrice / avgEntryPriceAtSale - 1) * 100);
  const remainingSharesAfter = remaining - sharesSold;
  const realizedProfitDollars = round2((header.realizedProfitDollars ?? 0) + saleDollars);
  const costBasisSoldCumulative = round2(
    (header.costBasisSoldCumulative ?? 0) + avgEntryPriceAtSale * sharesSold
  );
  const realizedProfitPctWeighted =
    costBasisSoldCumulative > 0
      ? round2((realizedProfitDollars / costBasisSoldCumulative) * 100)
      : null;
  const closed = remainingSharesAfter === 0;

  const event = {
    pk: header.pk,
    sk: `${header.entryDate}#${header.positionId}#SELL#${soldAt}`,
    recordType: "SELL_EVENT",
    ticker: header.ticker,
    positionId: header.positionId,
    sharesSold,
    sellPrice,
    avgEntryPriceAtSale,
    realizedProfitDollars: saleDollars,
    realizedProfitPct: salePct,
    remainingSharesAfter,
    soldAt,
    commandSource,
  };

  const updatedFields = {
    remainingShares: remainingSharesAfter,
    realizedProfitDollars,
    costBasisSoldCumulative,
    realizedProfitPctWeighted,
    status: closed ? "CLOSED" : "OPEN",
    ...(closed ? { soldAt, closedAt: soldAt } : {}),
  };

  return { event, updatedFields, closed, saleDollars, salePct };
}

export function buildDecision({
  ticker,
  skippedAt,
  id,
  linkedOutcome = null,
  currentStrategyVersion,
  reason = null,
  commandSource = "telegram",
}) {
  const linked = !!linkedOutcome;
  return {
    pk: decisionPk(ticker),
    sk: `${skippedAt}#${id}`,
    recordType: "DECISION",
    decision: "SKIPPED",
    ticker,
    skippedAt,
    linked,
    sourceOutcomePk: linkedOutcome?.pk ?? null,
    sourceOutcomeSk: linkedOutcome?.sk ?? null,
    strategyVersion: linkedOutcome?.strategyVersion ?? currentStrategyVersion ?? null,
    reason,
    commandSource,
  };
}
