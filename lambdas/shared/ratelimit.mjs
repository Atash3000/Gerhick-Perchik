// ratelimit.mjs — a serial min-interval limiter to stay under a provider's
// per-minute cap. With ~40 watchlist names the scanner makes ~3 Finnhub calls per
// ticker (earnings + profile + fundamentals), which would burst past Finnhub's
// free-tier ~60/min cap. Routing those calls through `finnhub.run()` spaces them.
//
// Runtime-only module (uses Date.now/setTimeout) — fine in Lambda.

export function createLimiter(minIntervalMs) {
  let last = 0;
  let tail = Promise.resolve();
  return function run(fn) {
    const result = tail.then(async () => {
      const wait = last + minIntervalMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      last = Date.now();
      return fn();
    });
    // Advance the chain regardless of this call's success, so one failure doesn't
    // break pacing for the rest.
    tail = result.then(
      () => {},
      () => {}
    );
    return result;
  };
}

// Shared Finnhub limiter: ~50 calls/min (1200ms gap) — comfortably under the
// 60/min free-tier cap, shared across marketdata + fundamentals.
export const finnhub = createLimiter(1200);

// Tiingo limiter — the recon's "Tiingo is unthrottled" assumption was disproven by
// live 429s. This spaces Tiingo calls to avoid BURST 429s (e.g. regime + RS + the
// first tickers firing together, or concurrent runs). NOTE: it cannot raise the
// HOURLY allocation (~50/hr on free) — that ceiling is respected by keeping the
// watchlist small; see docs.
export const tiingo = createLimiter(350);

// True when an error looks like a provider rate-limit / quota response (Tiingo
// HTTP 429 or its plain-text quota body; Finnhub 429).
export function isRateLimited(err) {
  return /\b429\b|rate.?limit|quota|hourly|allocation|too many/i.test(err?.message ?? "");
}

// Retry `fn` on a transient/rate-limit error, BOUNDED. Two jobs: survive a
// transient/burst 429, and guarantee a single rate-limit response can NEVER crash
// a run — after `retries` the final throw is left for the caller to catch
// (per-ticker loop / regime guard). Hourly-allocation exhaustion won't clear in
// seconds, so retries are few. `sleep` is injectable for tests.
export async function withRetry(fn, opts = {}) {
  const {
    retries = 2,
    baseDelayMs = 600,
    shouldRetry = isRateLimited,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = opts;
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !shouldRetry(err)) throw err;
      await sleep(baseDelayMs * 2 ** attempt);
      attempt += 1;
    }
  }
}
