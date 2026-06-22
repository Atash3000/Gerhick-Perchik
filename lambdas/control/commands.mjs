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
  const arg =
    rawArg && (cmd === "enable" || cmd === "disable")
      ? rawArg.toUpperCase()
      : rawArg
        ? rawArg.toLowerCase()
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

function bucketKey(score) {
  if (typeof score !== "number") return "n/a";
  return `${Math.floor(score / 10) * 10}s`;
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const round = (n, dp = 2) => (n == null ? null : Math.round(n * 10 ** dp) / 10 ** dp);

// Summarize CLOSED outcomes for one strategy version, optionally since an epoch
// (ms). Buckets by score band. Pure.
export function computeStats(outcomes, { strategyVersion, sinceEpochMs } = {}) {
  const rows = outcomes.filter(
    (o) =>
      o.status === "CLOSED" &&
      (!strategyVersion || o.strategyVersion === strategyVersion) &&
      (!sinceEpochMs || (typeof o.sk === "number" && o.sk >= sinceEpochMs))
  );

  const summarize = (set) => {
    const n = set.length;
    const wins = set.filter((o) => o.outcome === "TARGET").length;
    const stops = set.filter((o) => o.outcome === "STOP").length;
    const timeouts = set.filter((o) => o.outcome === "TIMEOUT").length;
    const profits = set.map((o) => o.profitPct).filter((x) => typeof x === "number");
    const rs = set.map(realizedR).filter((x) => x != null);
    return {
      n,
      wins,
      stops,
      timeouts,
      winRate: n ? round((wins / n) * 100, 1) : null,
      avgProfitPct: round(mean(profits), 2),
      avgR: round(mean(rs), 2),
    };
  };

  const buckets = {};
  for (const o of rows) {
    const k = bucketKey(o.score);
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
  lines.push(`(${o.wins} target / ${o.stops} stop / ${o.timeouts} timeout)`);
  const keys = Object.keys(stats.byBucket).sort();
  if (keys.length) {
    lines.push("By score:");
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
