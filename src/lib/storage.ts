// D1 stores small application metadata and R2 stores encrypted vault objects.
// The adapter intentionally exposes the small subset of the KV API used by the
// existing worker so the routing and authentication code remains unchanged.

export interface AppStorage {
  get(key: string): Promise<string | null>;
  get<T = unknown>(key: string, type: 'json'): Promise<T | null>;
  get(key: string, type: 'arrayBuffer'): Promise<ArrayBuffer | null>;
  put(key: string, value: string | ArrayBuffer | ArrayBufferView): Promise<void>;
  delete(key: string): Promise<void>;
}

const VAULT_KEY_PREFIX = 'vault:';
const initializedDatabases = new WeakMap<object, Promise<void>>();

function isR2Key(key: string): boolean {
  return key.startsWith(VAULT_KEY_PREFIX);
}

function r2Key(key: string): string {
  return `keyloom/${key}`;
}

function ensureD1Schema(db: D1Database): Promise<void> {
  const existing = initializedDatabases.get(db);
  if (existing) return existing;

  const initialization = db
    .prepare(
      `CREATE TABLE IF NOT EXISTS app_kv (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    )
    .run()
    .then(() => undefined);
  initializedDatabases.set(db, initialization);
  return initialization;
}

export class D1R2Storage implements AppStorage {
  constructor(
    private readonly db: D1Database,
    private readonly bucket: R2Bucket,
  ) {}

  async get(key: string): Promise<string | null>;
  async get<T = unknown>(key: string, type: 'json'): Promise<T | null>;
  async get(key: string, type: 'arrayBuffer'): Promise<ArrayBuffer | null>;
  async get(key: string, type?: 'json' | 'arrayBuffer'): Promise<unknown> {
    if (isR2Key(key)) {
      const object = await this.bucket.get(r2Key(key));
      if (!object) return null;
      if (type === 'arrayBuffer') return object.arrayBuffer();
      const text = await object.text();
      return type === 'json' ? JSON.parse(text) : text;
    }

    await ensureD1Schema(this.db);
    const row = await this.db
      .prepare('SELECT value FROM app_kv WHERE key = ?1')
      .bind(key)
      .first<{ value: string }>();
    if (!row) return null;
    return type === 'json' ? JSON.parse(row.value) : row.value;
  }

  async put(key: string, value: string | ArrayBuffer | ArrayBufferView): Promise<void> {
    if (isR2Key(key)) {
      await this.bucket.put(r2Key(key), value);
      return;
    }

    await ensureD1Schema(this.db);
    const text = typeof value === 'string' ? value : new TextDecoder().decode(value);
    const now = Date.now();
    await this.db
      .prepare(
        `INSERT INTO app_kv (key, value, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .bind(key, text, now)
      .run();
  }

  async delete(key: string): Promise<void> {
    if (isR2Key(key)) {
      await this.bucket.delete(r2Key(key));
      return;
    }

    await ensureD1Schema(this.db);
    await this.db.prepare('DELETE FROM app_kv WHERE key = ?1').bind(key).run();
  }
}

export function getStorage(env: Pick<Env, 'DB' | 'VAULT_BUCKET'>): AppStorage {
  if (!env.DB) throw new Error('D1 binding DB is not configured');
  if (!env.VAULT_BUCKET) throw new Error('R2 binding VAULT_BUCKET is not configured');
  return new D1R2Storage(env.DB, env.VAULT_BUCKET);
}
