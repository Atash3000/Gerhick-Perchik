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
// on a missing/unparseable value.
export function formatEt(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: true, timeZoneName: "short",
  }).format(d);
}

// Turn a CloudWatch-alarm SNS message into a Telegram line. Pure; tolerates
// non-JSON payloads. Adds a New-York-local timestamp (CloudWatch's own text is
// UTC, which is confusing for an NYC user).
export function formatAlarm(snsMessage) {
  let parsed;
  try {
    parsed = JSON.parse(snsMessage);
  } catch {
    return `⚠️ Ops alert: ${snsMessage}`;
  }
  const name = parsed.AlarmName ?? "alarm";
  const state = parsed.NewStateValue ?? "?";
  const reason = parsed.NewStateReason ?? "";
  const et = formatEt(parsed.StateChangeTime);
  const lines = [`⚠️ Ops alert: ${name} → ${state}`];
  if (et) lines.push(`🕐 ${et}`);
  if (reason) lines.push(`${reason}  (times above are UTC)`);
  return lines.join("\n").trim();
}
