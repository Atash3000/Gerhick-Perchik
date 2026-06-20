// telegram.mjs — send a message to the dedicated Gerchik-Perchik Telegram channel
// (Phase 6). Reuses the Edge Hunter bot token, but a DEDICATED chat id so technical
// alerts don't land in the Edge Hunter feed.
//
// Secrets read by path from SSM (decrypted in memory, never logged). Dedicated
// Gerchik-Perchik bot + channel (separate from Edge Hunter):
//   - /gerchik-perchik/telegram/bot_token
//   - /gerchik-perchik/telegram/chat_id

import { getParameter } from "./ssm.mjs";

export const TELEGRAM_PATHS = {
  botToken: "/gerchik-perchik/telegram/bot_token",
  chatId: "/gerchik-perchik/telegram/chat_id",
};

// Build the Bot API sendMessage request (pure — unit-testable without network or
// secrets). The token is in the URL path, as the Telegram API requires.
export function buildSendRequest(token, chatId, text) {
  return {
    url: `https://api.telegram.org/bot${token}/sendMessage`,
    init: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        // Plain text — the message is assembled deterministically and may contain
        // characters that would otherwise need Markdown/HTML escaping.
        disable_web_page_preview: true,
      }),
    },
  };
}

// Send a message. opts allows injecting token/chatId/fetch for tests; in the
// Lambda the token + chat id come from SSM and global fetch is used.
export async function sendTelegram(text, opts = {}) {
  const fetchFn = opts.fetchFn ?? fetch;
  const token = opts.token ?? (await getParameter(TELEGRAM_PATHS.botToken));
  const chatId = opts.chatId ?? (await getParameter(TELEGRAM_PATHS.chatId));

  const { url, init } = buildSendRequest(token, chatId, text);
  const res = await fetchFn(url, init);
  if (!res.ok) {
    // Telegram returns a JSON body with a description on failure.
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.description) detail += `: ${body.description}`;
    } catch {
      /* ignore parse errors */
    }
    throw new Error(`Telegram sendMessage failed: ${detail}`);
  }
  return res.json();
}
