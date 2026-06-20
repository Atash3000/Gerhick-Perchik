// ssm.mjs — read secrets from SSM Parameter Store by PATH, decrypted in memory
// only, cached per warm container. Shared by marketdata, telegram, and narration.
//
// The value is NEVER logged, returned in bulk, or persisted. Callers pass an SSM
// path (e.g. "/edge-hunter/telegram/bot_token") and get back the decrypted value.

import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";

const _cache = new Map();
let _client;

function client() {
  if (!_client) _client = new SSMClient({});
  return _client;
}

export async function getParameter(path) {
  if (_cache.has(path)) return _cache.get(path);
  const out = await client().send(
    new GetParameterCommand({ Name: path, WithDecryption: true })
  );
  const value = out?.Parameter?.Value;
  if (!value) throw new Error(`SSM parameter has no value: ${path}`);
  _cache.set(path, value);
  return value;
}

// Test hook only — clears the per-container cache.
export function _clearCache() {
  _cache.clear();
}
