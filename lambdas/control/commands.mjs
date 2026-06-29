// commands.mjs — pure helpers for the control Lambda: parse a Telegram command,
// compute /stats from outcomes, and format messages. No I/O — unit-tested.

export const HELP = [
  "Gerchik-Perchik control:",
  "/start — enable the scanner + labeler schedules",
  "/stop — disable them",
  "/mode observe|live — set alert mode (live is a human decision)",
  "/enable <TICKER> — add a ticker to the active scan",
  "/disable <TICKER> — remove it",
  "/stats [30d] — outcome summary for the current strategy version",
  "/analyze [30d] — Phase 8 deep-dive: profit factor + component predictors",
  "/bought <TICKER> <SHARES> <PRICE> — confirm a manual buy (links latest GP signal)",
  "/sell <TICKER> <SHARES> <PRICE> — sell part or all of an open position",
  "/skip <TICKER> [reason] — record that you skipped a signal",
  "/positions — list open positions",
].join("\n");

// "/mode live" → {cmd:'mode', arg:'live'}; "/start@gp_bot" → {cmd:'start'};
// "/enable aapl" → {cmd:'enable', arg:'AAPL'}. Returns null if not a command.
export function parseCommand(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const parts = trimmed.split(/\s+/);
  const cmd = parts[0].slice(1).split("@")[0].toLowerCase();
  const rawArg = parts[1] ?? null;
  // Tickers are upper-cased; mode/stats args stay lower-case.
  const TICKER_CMDS = new Set(["enable", "disable", "bought", "sell", "skip"]);
  const arg = rawArg
    ? TICKER_CMDS.has(cmd)
      ? rawArg.toUpperCase()
      : rawArg.toLowerCase()
    : null;
  return { cmd, arg, args: parts.slice(1) };
}

// Realized R multiple for one outcome: profit% ÷ risk% where risk% = (entry-stop)/entry.
function realizedR(o) {
  if (typeof o.entry !== "number" || typeof o.stop !== "number") return null;
  const riskPct = ((o.entry - o.stop) / o.entry) * 100;
  if (!(riskPct > 0) || typeof o.profitPct !== "number") return null;
  return o.profitPct / riskPct;
}

// Momentum buckets by rank PERCENTILE band (1 = strongest). gp-2.0.0's `score` is
// gone; rankPct tells us whether the strongest-ranked names actually won more.
function rankBucket(rankPct) {
  if (typeof rankPct !== "number" || !Number.isFinite(rankPct)) return "n/a";
  const lo = Math.min(80, Math.floor(rankPct / 20) * 20);
  return `${lo}-${lo + 20}%`;
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const round = (n, dp = 2) => (n == null ? null : Math.round(n * 10 ** dp) / 10 ** dp);

// Summarize CLOSED outcomes for one strategy version, optionally since an epoch
// (ms). Momentum: a WIN is a positive after-cost return (no TARGET — momentum has
// none); buckets by rank percentile. Pure.
export function computeStats(outcomes, { strategyVersion, sinceEpochMs } = {}) {
  const rows = outcomes.filter(
    (o) =>
      o.status === "CLOSED" &&
      (!strategyVersion || o.strategyVersion === strategyVersion) &&
      (!sinceEpochMs || (typeof o.sk === "number" && o.sk >= sinceEpochMs))
  );

  const summarize = (set) => {
    const n = set.length;
    const wins = set.filter((o) => typeof o.profitPct === "number" && o.profitPct > 0).length;
    const stops = set.filter((o) => o.outcome === "STOP").length;
    const exits = set.filter((o) => o.outcome === "EXIT").length; // scanner rank/trend close
    const timeouts = set.filter((o) => o.outcome === "TIMEOUT").length;
    const profits = set.map((o) => o.profitPct).filter((x) => typeof x === "number");
    const rs = set.map(realizedR).filter((x) => x != null);
    return {
      n,
      wins, // after-cost positive
      stops,
      exits,
      timeouts,
      winRate: n ? round((wins / n) * 100, 1) : null,
      avgProfitPct: round(mean(profits), 2),
      avgR: round(mean(rs), 2),
    };
  };

  const buckets = {};
  for (const o of rows) {
    const k = rankBucket(o.rankPct);
    (buckets[k] ??= []).push(o);
  }
  const byBucket = {};
  for (const [k, set] of Object.entries(buckets)) byBucket[k] = summarize(set);

  return { strategyVersion: strategyVersion ?? null, overall: summarize(rows), byBucket };
}

export function formatStats(stats, label) {
  const o = stats.overall;
  const lines = [`📊 Stats${label ? ` (${label})` : ""} — ${stats.strategyVersion ?? "all"}`];
  if (o.n === 0) {
    lines.push("No closed outcomes yet.");
    return lines.join("\n");
  }
  lines.push(
    `Overall: ${o.n} closed · win ${o.winRate}% · avg ${o.avgProfitPct}% · avg R ${o.avgR}`
  );
  lines.push(`(${o.wins} win / ${o.stops} stop / ${o.exits} exit / ${o.timeouts} timeout)`);
  const keys = Object.keys(stats.byBucket).sort();
  if (keys.length) {
    lines.push("By rank %:");
    for (const k of keys) {
      const b = stats.byBucket[k];
      lines.push(`  ${k}: ${b.n} · win ${b.winRate}% · avg ${b.avgProfitPct}% · R ${b.avgR}`);
    }
  }
  return lines.join("\n");
}

// Format an ISO timestamp in New York local time (handles EST/EDT). Returns null
// on a missing/unparseable value. e.g. "Jun 22, 2026, 10:36 AM EDT".
export function formatEt(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short", day: "numeric", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: true, timeZoneName: "short",
  }).format(d);
}

// Human window from period(seconds) × evaluationPeriods. e.g. 3600 → "1h".
function humanWindow(periodSec, evals = 1) {
  if (!periodSec) return null;
  const s = periodSec * evals;
  if (s % 3600 === 0) return `${s / 3600}h`;
  if (s % 60 === 0) return `${s / 60}m`;
  return `${s}s`;
}

// Turn a CloudWatch-alarm SNS message into a structured, scannable Telegram
// message — vertical layout, emoji, NY-local time, the observed value vs the
// threshold, the alarm description, and a hint for the known metric. Pure;
// tolerates non-JSON payloads.
export function formatAlarm(snsMessage) {
  let p;
  try {
    p = JSON.parse(snsMessage);
  } catch {
    return `🚨 GERCHIK-PERCHIK · OPS ALERT\n${snsMessage}`;
  }
  const state = p.NewStateValue ?? "?";
  const isAlarm = state === "ALARM";
  const isOk = state === "OK";
  const dot = isAlarm ? "🔴" : isOk ? "🟢" : "🟡";
  const verb = isAlarm ? "ALARM" : isOk ? "RESOLVED" : state;
  const name = p.AlarmName ?? "alarm";
  const et = formatEt(p.StateChangeTime);
  const trig = p.Trigger ?? {};
  const metric = trig.MetricName ? `${trig.Namespace ?? "?"}/${trig.MetricName}` : null;
  const threshold = typeof trig.Threshold === "number" ? trig.Threshold : null;
  const win = humanWindow(trig.Period, trig.EvaluationPeriods);
  const m = /\[\s*([\d.]+)\s*\(/.exec(p.NewStateReason ?? "");
  const value = m ? Number(m[1]) : null;

  const lines = ["🚨 GERCHIK-PERCHIK · OPS ALERT", "━━━━━━━━━━━━━━━━━━━━"];
  lines.push(`${dot} ${verb} — ${name}`);
  if (et) lines.push(`🕐 ${et}`);
  lines.push("");

  if (isOk) {
    lines.push(`✅ Recovered — back under the threshold${threshold != null ? ` (≥ ${threshold})` : ""}.`);
  } else if (value != null && threshold != null) {
    lines.push(`📊 ${value} failures${win ? ` in ${win}` : ""}  (alarm at ≥ ${threshold})`);
  } else if (p.NewStateReason) {
    lines.push(`📊 ${p.NewStateReason}  (times are UTC)`);
  }

  if (p.AlarmDescription) lines.push(`💬 ${p.AlarmDescription}`);
  if (isAlarm && /ScanFailures/.test(trig.MetricName ?? "")) {
    lines.push("🔎 Often a data-feed (Tiingo) outage — check scan coverage.");
  }
  lines.push("");
  if (metric) lines.push(`📂 ${metric}`);
  if (p.Region) lines.push(`🌎 ${p.Region}`);
  return lines.join("\n").trim();
}

// Parse "/bought TICKER SHARES PRICE" / "/sell TICKER SHARES PRICE" args
// (the parts after the command token). SHARES must be a positive integer;
// PRICE a positive number. Returns {ok:true, ticker, shares, price} or
// {ok:false, error:"usage"|"shares"|"price"}.
export function parseTradeArgs(args) {
  if (!args || args.length < 3) return { ok: false, error: "usage" };
  const ticker = String(args[0]).toUpperCase();
  const shares = Number(args[1]);
  const price = Number(args[2]);
  if (!Number.isInteger(shares) || shares <= 0) return { ok: false, error: "shares" };
  if (!Number.isFinite(price) || price <= 0) return { ok: false, error: "price" };
  return { ok: true, ticker, shares, price };
}

const fmtMoney = (n) => `${n < 0 ? "-" : "+"}$${Math.abs(n).toFixed(2)}`;
const fmtPct = (n) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;

export function formatBought(header) {
  const base = `✅ Bought ${header.ticker} ${header.originalShares} @ ${header.actualEntry.toFixed(2)}.`;
  if (!header.linked) {
    return `${base} No open GP signal found — position created as manual/unlinked.`;
  }
  const signalDate = header.sourceOutcomePk?.split("#")[2] ?? header.entryDate;
  return `${base} Linked to latest GP signal (entry ${signalDate}).`;
}

export function formatSell(sellResult, header, sharesSold, sellPrice) {
  const { closed, saleDollars, salePct, updatedFields } = sellResult;
  if (closed) {
    return `🏁 Closed ${header.ticker}. Realized ${fmtMoney(updatedFields.realizedProfitDollars)} (${fmtPct(updatedFields.realizedProfitPctWeighted)} weighted).`;
  }
  return `📉 Sold ${sharesSold} ${header.ticker} @ ${sellPrice.toFixed(2)} (${fmtPct(salePct)}, ${fmtMoney(saleDollars)}). ${updatedFields.remainingShares} remain open.`;
}

export function formatSkip(decision) {
  return decision.linked
    ? `⏭️ Skipped ${decision.ticker} (linked to GP signal).`
    : `⏭️ Skipped ${decision.ticker} (unlinked).`;
}

export function formatPositions(headers) {
  if (!headers.length) return "No open positions.";
  const lines = ["📂 Open positions:"];
  for (const h of headers) {
    const realized = fmtMoney(h.realizedProfitDollars ?? 0);
    lines.push(
      `• ${h.ticker} ${h.remainingShares}/${h.originalShares} @ ${h.avgEntryPrice.toFixed(2)} · realized ${realized}${h.linked ? " · linked" : ""}`
    );
  }
  return lines.join("\n");
}
