// Minimal in-memory stand-ins for the Worker bindings, so route and queue code can run under `bun test`.
// D1 is backed by bun:sqlite with the real migrations applied, KV by a Map, the queue by an array.
import { Database } from 'bun:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Env } from '../src/types';

const MIGRATIONS = join(import.meta.dir, '..', 'migrations');

// Workers expose crypto.subtle.timingSafeEqual; Bun does not.
const subtle = crypto.subtle as SubtleCrypto & {
  timingSafeEqual?: (a: ArrayBufferView, b: ArrayBufferView) => boolean;
};
if (!subtle.timingSafeEqual) {
  subtle.timingSafeEqual = (a, b) => {
    const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const y = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    if (x.length !== y.length) return false;
    let diff = 0;
    for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
    return diff === 0;
  };
}

class Stmt {
  constructor(
    private db: Database,
    private sql: string,
    private params: unknown[] = [],
  ) {}
  bind(...params: unknown[]) {
    return new Stmt(this.db, this.sql, params);
  }
  private args() {
    return this.params.map((p) =>
      p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p,
    ) as never[];
  }
  async first<T>(col?: string): Promise<T | null> {
    const row = this.db.query(this.sql).get(...this.args()) as Record<string, unknown> | null;
    if (!row) return null;
    return (col ? row[col] : row) as T;
  }
  async all<T>() {
    return { results: this.db.query(this.sql).all(...this.args()) as T[], success: true, meta: {} };
  }
  async run() {
    const r = this.db.query(this.sql).run(...this.args());
    return { success: true, meta: { changes: r.changes } };
  }
}

export type FakeD1 = ReturnType<typeof makeD1>;

export function makeD1() {
  const db = new Database(':memory:');
  for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort()) {
    db.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
  }
  return {
    raw: db,
    prepare: (sql: string) => new Stmt(db, sql),
    batch: async (stmts: Stmt[]) => Promise.all(stmts.map((s) => s.run())),
    exec: async (sql: string) => db.exec(sql),
  };
}

export function makeKV() {
  const store = new Map<string, { value: string; ttl?: number }>();
  const puts: { key: string; value: string; opts?: { expirationTtl?: number } }[] = [];
  return {
    store,
    puts,
    async get(key: string) {
      return store.get(key)?.value ?? null;
    },
    async put(key: string, value: string, opts?: { expirationTtl?: number }) {
      puts.push({ key, value, opts });
      store.set(key, { value, ttl: opts?.expirationTtl });
    },
    async delete(key: string) {
      store.delete(key);
    },
  };
}

export function makeQueue<T = Record<string, unknown>>() {
  const sent: T[] = [];
  return {
    sent,
    async send(body: T) {
      sent.push(body);
    },
  };
}

export function makeEnv(overrides: Record<string, unknown> = {}) {
  const DB = makeD1();
  const RATE_LIMIT = makeKV();
  const EMAIL_QUEUE = makeQueue();
  const env = {
    DB,
    RATE_LIMIT,
    EMAIL_QUEUE,
    STORAGE: {},
    ADMIN_API_KEY: 'test-admin-key',
    ...overrides,
  } as unknown as Env;
  return { env, DB, RATE_LIMIT, EMAIL_QUEUE };
}

export function makeCtx() {
  const pending: Promise<unknown>[] = [];
  return {
    pending,
    waitUntil(p: Promise<unknown>) {
      pending.push(p);
    },
    passThroughOnException() {},
    async settle() {
      // waitUntil work can schedule more waitUntil work, so drain until nothing new arrives.
      let seen = 0;
      while (seen < pending.length) {
        const batch = pending.slice(seen);
        seen = pending.length;
        await Promise.allSettled(batch);
      }
    },
  };
}

export const ADMIN = { 'X-API-Key': 'test-admin-key', 'Content-Type': 'application/json' };

export function seedInbox(
  DB: FakeD1,
  fields: Partial<Record<string, string | number | null>> & { slug: string },
) {
  const id = (fields.id as string) || crypto.randomUUID();
  const cols: Record<string, unknown> = { ...fields, id };
  const keys = Object.keys(cols);
  DB.raw
    .query(
      `INSERT INTO webhook_inboxes (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
    )
    .run(...(Object.values(cols) as never[]));
  return id;
}

export function seedChannel(DB: FakeD1, inboxId: string, type: string, config: unknown) {
  const id = crypto.randomUUID();
  DB.raw
    .query('INSERT INTO notification_channels (id, inbox_id, type, config) VALUES (?, ?, ?, ?)')
    .run(id, inboxId, type, JSON.stringify(config));
  return id;
}

/** Call the Worker's fetch handler and wait for every waitUntil task. */
export async function call(env: Env, path: string, init?: RequestInit) {
  const { default: worker } = await import('../src/index');
  const ctx = makeCtx();
  const res = await worker.fetch(new Request(`https://x.test${path}`, init), env, ctx as never);
  await ctx.settle();
  return res;
}

/** Replace global fetch for one test; returns the recorded requests. */
export function mockFetch(
  respond: (req: Request) => Response | Promise<Response> = () => new Response('ok'),
) {
  const calls: Request[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as never, init);
    calls.push(req.clone());
    return respond(req);
  }) as typeof fetch;
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}
