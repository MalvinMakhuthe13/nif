/**
 * NIFRateLimit — Sliding Window Rate Limiter
 * © Fumoca Technologies · fumoca.co.za
 *
 * Tiered limits by route sensitivity:
 *   upload  → 10 requests / 10 minutes (per user)
 *   auth    → 20 requests / 15 minutes (per IP)
 *   api     → 300 requests / minute    (per user)
 *   public  → 60 requests / minute     (per IP)
 *
 * Uses in-memory Map with TTL cleanup — no Redis dependency.
 * For multi-instance deployments swap _store for a Redis adapter.
 */

const _store = new Map(); // key → { count, resetAt }

function _cleanup() {
  const now = Date.now();
  for (const [key, val] of _store) {
    if (now > val.resetAt) _store.delete(key);
  }
}
setInterval(_cleanup, 60_000);

/**
 * @param {object} opts
 *   max       number  max requests in window
 *   windowMs  number  window size in ms
 *   keyFn     fn(req) → string  key extractor
 *   message   string  error message
 */
export function rateLimit({ max, windowMs, keyFn, message = 'Too many requests' }) {
  return (req, res, next) => {
    const key = `rl:${keyFn(req)}`;
    const now = Date.now();
    const rec = _store.get(key);

    if (!rec || now > rec.resetAt) {
      _store.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    rec.count++;
    if (rec.count > max) {
      const retryAfter = Math.ceil((rec.resetAt - now) / 1000);
      res.setHeader('Retry-After', retryAfter);
      res.setHeader('X-RateLimit-Limit',     max);
      res.setHeader('X-RateLimit-Remaining', 0);
      res.setHeader('X-RateLimit-Reset',     Math.ceil(rec.resetAt / 1000));
      return res.status(429).json({ error: message, retryAfter });
    }

    res.setHeader('X-RateLimit-Limit',     max);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, max - rec.count));
    res.setHeader('X-RateLimit-Reset',     Math.ceil(rec.resetAt / 1000));
    next();
  };
}

// Pre-built limiters for common tiers
const ip  = (req) => req.ip ?? req.connection?.remoteAddress ?? 'unknown';
const uid = (req) => req.user?.id ?? ip(req);

export const limitUpload  = rateLimit({ max:10,  windowMs:10*60_000, keyFn:uid, message:'Upload limit reached — max 10 uploads per 10 minutes' });
export const limitAuth    = rateLimit({ max:20,  windowMs:15*60_000, keyFn:ip,  message:'Too many auth attempts — try again in 15 minutes' });
export const limitAPI     = rateLimit({ max:300, windowMs:60_000,    keyFn:uid, message:'API rate limit exceeded — max 300 requests per minute' });
export const limitPublic  = rateLimit({ max:60,  windowMs:60_000,    keyFn:ip,  message:'Rate limit exceeded' });
export const limitExport  = rateLimit({ max:3,   windowMs:60*60_000, keyFn:uid, message:'Export limit reached — max 3 exports per hour' });
export const limitLicense = rateLimit({ max:5,   windowMs:60*60_000, keyFn:uid, message:'License creation limit — max 5 per hour' });
