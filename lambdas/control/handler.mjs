// control/handler.mjs — Telegram webhook + ops-alert forwarder (Phase 7).
//
// Two event shapes:
//   1. SNS (the gp-ops-alerts topic) — forward the CloudWatch alarm to Telegram.
//      This completes the Phase 6 ops chain: failures now page you.
//   2. HTTP (Lambda Function URL) — a Telegram webhook update. Verify the secret
//      header and the chat id, then run the command.
//
// Commands: /start /stop /mode /enable /disable /stats. The parsing and stats
// math live in commands.mjs (pure); this file is orchestration + I/O.
//
// Auth: the endpoint is protected by Telegram's secret-token header
// (/gerchik/telegram/webhook_secret), and commands are only honored from the
// configured dedicated chat id. /mode live is therefore a HUMAN action — the only
// sanctioned way to go live.

import { getParameter } from "../shared/ssm.mjs";
import { sendTelegram } from "../shared/telegram.mjs";
import { setScheduleEnabled } from "../shared/schedule.mjs";
import { setAlertMode } from "../shared/config.mjs";
import { createStore } from "../shared/store.mjs";
import { STRATEGY_VERSION } from "../shared/version.mjs";
import { parseCommand, computeStats, formatStats, formatAlarm, HELP } from "./commands.mjs";

const WEBHOOK_SECRET_PATH = "/gerchik-perchik/telegram/webhook_secret";
const CHAT_ID_PATH = "/gerchik-perchik/telegram/chat_id";

export async function handler(event) {
  // 1) SNS ops alarm → Telegram.
  if (event?.Records?.[0]?.Sns) {
    for (const r of event.Records) {
      try {
        await sendTelegram(formatAlarm(r.Sns.Message));
      } catch (e) {
        console.error(`gp_scan_failed: ops forward: ${e.message}`);
      }
    }
    return { ok: true };
  }

  // 2) Telegram webhook. Protect the public Function URL with the secret header.
  const headers = lowerKeys(event?.headers ?? {});
  const expectedSecret = await getParameter(WEBHOOK_SECRET_PATH);
  if (headers["x-telegram-bot-api-secret-token"] !== expectedSecret) {
    return { statusCode: 401, body: "unauthorized" };
  }

  const update = parseBody(event);
  const message = update?.message ?? update?.channel_post;
  const text = message?.text;
  const chatId = message?.chat?.id;

  // Only honor commands from the dedicated channel.
  const allowedChatId = await getParameter(CHAT_ID_PATH);
  if (String(chatId) !== String(allowedChatId)) {
    return { statusCode: 200, body: "ignored" }; // ack so Telegram won't retry
  }

  let reply;
  try {
    reply = await dispatch(text);
  } catch (e) {
    console.error(`gp_scan_failed: control ${text}: ${e.message}`);
    reply = `⚠️ Command failed: ${e.message}`;
  }
  if (reply) {
    try {
      await sendTelegram(reply, { chatId: String(chatId) });
    } catch (e) {
      console.error(`gp_scan_failed: control reply: ${e.message}`);
    }
  }
  return { statusCode: 200, body: "ok" };
}

// Run a command and return the reply text (or null to stay silent).
async function dispatch(text) {
  const parsed = parseCommand(text);
  if (!parsed) return null; // not a command

  switch (parsed.cmd) {
    case "start":
      await setScheduleEnabled(true);
      return "▶️ Scanner + labeler schedules ENABLED.";
    case "stop":
      await setScheduleEnabled(false);
      return "⏸️ Scanner + labeler schedules DISABLED.";
    case "mode": {
      if (parsed.arg !== "observe" && parsed.arg !== "live") {
        return "Usage: /mode observe|live";
      }
      await setAlertMode(parsed.arg);
      return parsed.arg === "live"
        ? "🔴 alertMode = LIVE — messages will omit the OBSERVE disclaimer."
        : "📋 alertMode = observe.";
    }
    case "enable":
    case "disable": {
      if (!parsed.arg) return `Usage: /${parsed.cmd} <TICKER>`;
      const store = createStore();
      const res = await store.setWatchlistEnabled(parsed.arg, parsed.cmd === "enable");
      if (!res.ok) return `${parsed.arg} is not on the watchlist.`;
      return parsed.cmd === "enable" ? `✅ Enabled ${parsed.arg}.` : `🚫 Disabled ${parsed.arg}.`;
    }
    case "stats": {
      const store = createStore();
      const outcomes = await store.listOutcomesByStatus("CLOSED");
      let sinceEpochMs;
      let label;
      const m = parsed.arg && /^(\d+)d$/.exec(parsed.arg);
      if (m) {
        const days = Number(m[1]);
        sinceEpochMs = Date.now() - days * 86_400_000;
        label = `${days}d`;
      }
      const stats = computeStats(outcomes, { strategyVersion: STRATEGY_VERSION, sinceEpochMs });
      return formatStats(stats, label);
    }
    default:
      return HELP;
  }
}

function lowerKeys(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k.toLowerCase()] = v;
  return out;
}

function parseBody(event) {
  let raw = event?.body;
  if (!raw) return null;
  if (event.isBase64Encoded) raw = Buffer.from(raw, "base64").toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
