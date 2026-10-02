import { isIPv6 } from 'node:net';
import type { Request, RequestHandler } from 'express';

/**
 * Rate-limit key for the client address. One IPv6 subscriber usually controls a whole /64
 * (billions of addresses), so limits keyed on the full address would be trivial to bypass.
 */
export function clientKey(req: Request): string {
  const ip = req.ip ?? 'unknown';
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) return mapped[1] as string;
  if (!isIPv6(ip)) return ip;
  const [head = '', tail = ''] = ip.toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = ip.includes('::') && tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

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
    const key = opts.key ? opts.key(req) : clientKey(req);
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
