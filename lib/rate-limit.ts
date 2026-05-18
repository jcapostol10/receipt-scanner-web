import { LRUCache } from "lru-cache";

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 20;

const buckets = new LRUCache<string, { count: number; resetAt: number }>({
  max: 5000,
  ttl: WINDOW_MS * 2,
});

export type RateResult = { ok: true } | { ok: false; retryAfterSec: number };

export function checkRate(ip: string): RateResult {
  const now = Date.now();
  const bucket = buckets.get(ip);
  if (!bucket || bucket.resetAt < now) {
    buckets.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return { ok: true };
  }
  if (bucket.count >= MAX_PER_WINDOW) {
    return { ok: false, retryAfterSec: Math.ceil((bucket.resetAt - now) / 1000) };
  }
  bucket.count += 1;
  return { ok: true };
}
