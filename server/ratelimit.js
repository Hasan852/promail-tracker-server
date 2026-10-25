// server/ratelimit.js — tiny in-memory fixed-window rate limiter (v2.2.0).
// No dependencies. Buckets are swept periodically; the timer is unref'd so it
// never keeps the process alive on its own.

function createRateLimiter({ windowMs, max }) {
  const buckets = new Map(); // key -> { count, resetAt }
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, e] of buckets) {
      if (e.resetAt <= now) buckets.delete(k);
    }
  }, Math.min(windowMs, 60000));
  if (typeof sweep.unref === 'function') sweep.unref();

  function allow(key) {
    const now = Date.now();
    let e = buckets.get(key);
    if (!e || e.resetAt <= now) {
      e = { count: 0, resetAt: now + windowMs };
      buckets.set(key, e);
    }
    e.count += 1;
    return e.count <= max;
  }

  function stop() {
    clearInterval(sweep);
    buckets.clear();
  }

  return { allow, stop };
}

module.exports = { createRateLimiter };
