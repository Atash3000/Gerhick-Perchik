// cache.mjs — disk bar cache so the robustness battery doesn't re-hit Tiingo.
// Keyed by ticker + startDate. Stores adjusted OHLCV + fetchedAt for staleness.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const keyFile = (dir, ticker, startDate) => join(dir, `${ticker}_${startDate}.json`);

export function readCache(dir, ticker, startDate) {
  const f = keyFile(dir, ticker, startDate);
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; }
}

export function writeCache(dir, ticker, startDate, bars, fetchedAt) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(keyFile(dir, ticker, startDate), JSON.stringify({ bars, fetchedAt }));
}
