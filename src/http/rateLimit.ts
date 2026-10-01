import type { Request, RequestHandler } from 'express';

export interface RateLimitOptions {
  limit: number;
  windowMs: number;
  key?: (req: Request) => string;
}

/**
 * Fixed-window limiter. Keys on req.ip, which is the real client address because
 * the app sets `trust proxy` to loopback (nginx on the same host).
 */
export function rateLimit(opts: RateLimitOptions): RequestHandler {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  const sweeper = setInterval(() => {
    const t = Date.now();
    for (const [key, bucket] of buckets) if (bucket.resetAt <= t) buckets.delete(key);
  }, opts.windowMs);
  sweeper.unref();

  return (req, res, next) => {
    const key = opts.key ? opts.key(req) : (req.ip ?? 'unknown');
    const t = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= t) {
      bucket = { count: 0, resetAt: t + opts.windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > opts.limit) {
      const retryAfter = Math.ceil((bucket.resetAt - t) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({ error: 'rate_limited', retry_after: retryAfter });
      return;
    }
    next();
  };
}
