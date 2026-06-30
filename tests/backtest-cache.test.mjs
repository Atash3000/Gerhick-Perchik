import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCache, writeCache } from "../scripts/backtest/cache.mjs";

test("cache: write then read returns the same bars + fetchedAt", () => {
  const dir = mkdtempSync(join(tmpdir(), "gp-cache-"));
  const bars = [{ date: "2020-01-02", open: 1, high: 2, low: 1, close: 1.5, volume: 100 }];
  writeCache(dir, "AAA", "2010-01-01", bars, "2026-06-29T00:00:00Z");
  const got = readCache(dir, "AAA", "2010-01-01");
  assert.deepEqual(got.bars, bars);
  assert.equal(got.fetchedAt, "2026-06-29T00:00:00Z");
  assert.equal(readCache(dir, "MISSING", "2010-01-01"), null);
});
