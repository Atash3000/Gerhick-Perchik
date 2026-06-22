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
