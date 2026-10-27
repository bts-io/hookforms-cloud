import { Context, Next } from 'hono';
import type { Env } from '../types';

const WINDOW_SECONDS = 60;
const LIMIT = 100;

function getClientIp(c: Context): string {
  return (
    c.req.header('CF-Connecting-IP') ||
    c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ||
    '0.0.0.0'
  );
}

/**
 * Fixed-window rate limiter on Cloudflare KV. The window number is part of the key, so each
 * window starts from zero; the TTL only cleans up old keys and never extends a window.
 */
export async function rateLimitMiddleware(
  c: Context<{ Bindings: Env }>,
  next: Next,
) {
  const path = new URL(c.req.url).pathname;
  if (path === '/health') return next();

  const ip = getClientIp(c);
  const window = Math.floor(Date.now() / 1000 / WINDOW_SECONDS);
  const key = `rl:${ip}:${window}`;

  try {
    const current = await c.env.RATE_LIMIT.get(key);
    const count = current ? parseInt(current, 10) : 0;

    if (count >= LIMIT) {
      return c.json(
        { error: { code: 429, message: 'Too many requests. Please retry later.' } },
        429,
      );
    }

    // Increment (fire-and-forget for performance)
    c.executionCtx.waitUntil(
      c.env.RATE_LIMIT.put(key, String(count + 1), {
        // KV's minimum TTL is 60 s; keep the key a little past its window.
        expirationTtl: WINDOW_SECONDS + 60,
      }),
    );

    c.header('X-RateLimit-Limit', String(LIMIT));
    c.header('X-RateLimit-Remaining', String(Math.max(0, LIMIT - count - 1)));
  } catch {
    // KV unavailable — allow request through
  }

  // Security headers
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('X-XSS-Protection', '1; mode=block');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');

  return next();
}
