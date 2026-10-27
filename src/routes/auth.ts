import { Hono } from 'hono';
import type { Env } from '../types';
import { requireScope, generateKey, hashKey } from '../middleware/auth';
import { parsePaging } from '../services/pagination';

const auth = new Hono<{ Bindings: Env }>();

const KNOWN_SCOPES = ['webhooks', 'admin'];

auth.post('/keys', requireScope('admin'), async (c) => {
  const body = await c.req.json<{ name: string; scopes?: unknown }>();

  if (!body.name) {
    return c.json({ error: { code: 400, message: 'name is required' } }, 400);
  }

  const requested = body.scopes ?? [];
  if (
    !Array.isArray(requested) ||
    !requested.every((s) => typeof s === 'string' && KNOWN_SCOPES.includes(s))
  ) {
    return c.json(
      { error: { code: 400, message: `scopes must be an array of: ${KNOWN_SCOPES.join(', ')}` } },
      400,
    );
  }
  const scopeList = [...new Set(requested as string[])];

  const rawKey = generateKey();
  const keyHash = await hashKey(rawKey);
  const id = crypto.randomUUID();
  const scopes = JSON.stringify(scopeList);

  await c.env.DB.prepare(
    'INSERT INTO api_keys (id, name, key_hash, key_prefix, scopes) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(id, body.name, keyHash, rawKey.substring(0, 12), scopes)
    .run();

  const dbKey = await c.env.DB.prepare('SELECT * FROM api_keys WHERE id = ?')
    .bind(id)
    .first();

  return c.json(
    {
      data: {
        id,
        name: body.name,
        scopes: scopeList,
        is_active: true,
        created_at: (dbKey as Record<string, unknown>)?.created_at,
        last_used_at: null,
        raw_key: rawKey,
      },
    },
    201,
  );
});

auth.get('/keys', requireScope('admin'), async (c) => {
  const paging = parsePaging(c.req.query('limit'), c.req.query('offset'));
  if ('error' in paging) {
    return c.json({ error: { code: 400, message: paging.error } }, 400);
  }
  const { limit, offset } = paging;

  const total = await c.env.DB.prepare('SELECT COUNT(*) as count FROM api_keys').first<{
    count: number;
  }>();

  const results = await c.env.DB.prepare(
    'SELECT id, name, scopes, is_active, created_at, last_used_at FROM api_keys ORDER BY created_at DESC LIMIT ? OFFSET ?',
  )
    .bind(limit, offset)
    .all();

  const items = (results.results || []).map((k: Record<string, unknown>) => ({
    ...k,
    scopes: JSON.parse(k.scopes as string),
  }));

  return c.json({ data: items, meta: { total: total?.count || 0, limit, offset } });
});

auth.delete('/keys/:id', requireScope('admin'), async (c) => {
  const id = c.req.param('id');

  const key = await c.env.DB.prepare('SELECT id FROM api_keys WHERE id = ?')
    .bind(id)
    .first();

  if (!key) {
    return c.json({ error: { code: 404, message: 'API key not found' } }, 404);
  }

  await c.env.DB.prepare('UPDATE api_keys SET is_active = 0 WHERE id = ?').bind(id).run();
  return c.body(null, 204);
});

export { auth };
