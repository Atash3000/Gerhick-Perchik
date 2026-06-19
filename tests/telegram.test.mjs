import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSendRequest, sendTelegram } from "../lambdas/shared/telegram.mjs";

test("buildSendRequest puts the token in the path and the chat id + text in the body", () => {
  const { url, init } = buildSendRequest("TOKEN123", "-100999", "hello world");
  assert.equal(url, "https://api.telegram.org/botTOKEN123/sendMessage");
  assert.equal(init.method, "POST");
  assert.equal(init.headers["content-type"], "application/json");
  const body = JSON.parse(init.body);
  assert.equal(body.chat_id, "-100999");
  assert.equal(body.text, "hello world");
});

test("sendTelegram posts via injected fetch and returns the parsed body", async () => {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 7 } }) };
  };
  const res = await sendTelegram("hi", { token: "T", chatId: "C", fetchFn });
  assert.equal(res.result.message_id, 7);
  assert.equal(calls[0].url, "https://api.telegram.org/botT/sendMessage");
  assert.equal(JSON.parse(calls[0].init.body).chat_id, "C");
});

test("sendTelegram throws with the API description on failure", async () => {
  const fetchFn = async () => ({
    ok: false,
    status: 400,
    statusText: "Bad Request",
    json: async () => ({ ok: false, description: "chat not found" }),
  });
  await assert.rejects(
    () => sendTelegram("x", { token: "T", chatId: "C", fetchFn }),
    /chat not found/
  );
});
