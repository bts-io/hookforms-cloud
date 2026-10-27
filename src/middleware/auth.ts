import { Context, Next } from 'hono';
import type { Env, ApiKey } from '../types';

/**
 * Verify an API key against the admin key or D1-stored keys.
 * Uses constant-time comparison for the admin key.
 */
export async function verifyApiKey(
  apiKey: string,
  env: Env,
): Promise<{ key: ApiKey | null; isAdmin: boolean }> {
  // Check admin key first (constant-time via subtle crypto)
  const encoder = new TextEncoder();
  const a = encoder.encode(apiKey);
  const b = encoder.encode(env.ADMIN_API_KEY);

  if (a.byteLength === b.byteLength) {
    const isEqual = await crypto.subtle.timingSafeEqual(a, b);
    if (isEqual) {
      return {
        isAdmin: true,
        key: {
          id: 'admin',
          name: 'admin',
          key_hash: '',
          key_prefix: '',
          scopes: JSON.stringify(['webhooks', 'admin']),
          is_active: 1,
          last_used_at: null,
          created_at: new Date().toISOString(),
        },
      };
    }
  }

  // Look up by prefix in D1
  const prefix = apiKey.substring(0, 12);
  const results = await env.DB.prepare(
    'SELECT * FROM api_keys WHERE key_prefix = ? AND is_active = 1',
  )
    .bind(prefix)
    .all<ApiKey>();

  if (!results.results?.length) return { key: null, isAdmin: false };

  // Hash the provided key and compare
  for (const dbKey of results.results) {
    const keyHash = await hashKey(apiKey);
    if (keyHash === dbKey.key_hash) {
      // Update last_used_at
      await env.DB.prepare('UPDATE api_keys SET last_used_at = datetime("now") WHERE id = ?')
        .bind(dbKey.id)
        .run();
      return { key: dbKey, isAdmin: false };
    }
  }

  return { key: null, isAdmin: false };
}

export async function hashKey(key: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(key);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function generateKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const base64 = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
  return `hf_${base64}`;
}

/**
 * Middleware: require a valid API key with the given scope.
 */
export function requireScope(scope: string) {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const apiKey = c.req.header('X-API-Key');
    if (!apiKey) {
      return c.json({ error: { code: 401, message: 'Missing API key' } }, 401);
    }

    const { key, isAdmin } = await verifyApiKey(apiKey, c.env);
    if (!key) {
      return c.json({ error: { code: 401, message: 'Invalid API key' } }, 401);
    }

    if (isAdmin) {
      c.set('apiKey' as never, key);
      return next();
    }

    const scopes: string[] = JSON.parse(key.scopes);
    if (!scopes.includes(scope) && !scopes.includes('admin')) {
      return c.json(
        { error: { code: 403, message: `Key lacks required scope: ${scope}` } },
        403,
      );
    }

    c.set('apiKey' as never, key);
    return next();
  };
}

/**
 * True when the key that passed requireScope also holds `scope` (admin holds every scope).
 * For routes where one action needs more than the route's own scope.
 */
export function keyHasScope(c: Context<{ Bindings: Env }>, scope: string): boolean {
  const key = c.get('apiKey' as never) as ApiKey | undefined;
  if (!key) return false;
  try {
    const scopes: string[] = JSON.parse(key.scopes);
    return scopes.includes(scope) || scopes.includes('admin');
  } catch {
    return false;
  }
}
