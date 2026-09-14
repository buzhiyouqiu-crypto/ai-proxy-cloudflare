import { decrypt, encrypt, mask, sha256 } from "../../shared/crypto";
import type { DbApiKey } from "./schema";

export interface CreateKeyOptions {
	name: string;
	expires_at?: number | null;
	quota_limit?: number | null;
	allowed_models?: string[] | null;
	allowed_ips?: string[] | null;
}

export interface UpdateKeyFields {
	name?: string;
	is_enabled?: number;
	expires_at?: number | null;
	quota_limit?: number | null;
	allowed_models?: string[] | null;
	allowed_ips?: string[] | null;
}

export interface CloneKeyOptions {
	count: number;
	name_rule: "random" | "prefix_sequence";
	prefix?: string;
	start_number?: number;
}

export interface CreatedApiKey {
	record: DbApiKey;
	plainKey: string;
}

export class ApiKeysDao {
	constructor(
		private db: D1Database,
		private encryptionKey: string,
	) {}

	/** Creates a key and returns the plaintext key (shown once, never stored). */
	async createKey(
		owner_id: string,
		opts: CreateKeyOptions,
	): Promise<{ record: DbApiKey; plainKey: string }> {
		const id = `key_${crypto.randomUUID().replace(/-/g, "")}`;
		// Keyloom-issued downstream keys use a branded prefix. Existing keys remain
		// valid because authentication is based on the stored SHA-256 hash.
		const plainKey = `sk-keyloomai-${crypto.randomUUID().replace(/-/g, "")}`;

		const [keyHash, encryptedKey] = await Promise.all([
			sha256(plainKey),
			encrypt(plainKey, this.encryptionKey),
		]);
		const keyHint = mask(plainKey, 10, 4);

		const allowedModels = opts.allowed_models?.length
			? JSON.stringify(opts.allowed_models)
			: null;
		const allowedIps = opts.allowed_ips?.length
			? JSON.stringify(opts.allowed_ips)
			: null;

		await this.db
			.prepare(
				`INSERT INTO api_keys (id, owner_id, name, key_hash, encrypted_key, key_hint, is_enabled, expires_at, quota_limit, quota_used, allowed_models, allowed_ips, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 0, ?, ?, ?)`,
			)
			.bind(
				id,
				owner_id,
				opts.name,
				keyHash,
				encryptedKey,
				keyHint,
				opts.expires_at ?? null,
				opts.quota_limit ?? null,
				allowedModels,
				allowedIps,
				Date.now(),
			)
			.run();

		const record = await this.db
			.prepare("SELECT * FROM api_keys WHERE id = ?")
			.bind(id)
			.first<DbApiKey>();
		if (!record) throw new Error("Failed to create downstream API key");
		return { record, plainKey };
	}

	/** Clone a key's restrictions while issuing fresh independent secrets. */
	async cloneKeys(
		owner_id: string,
		sourceId: string,
		opts: CloneKeyOptions,
	): Promise<CreatedApiKey[] | null> {
		const source = await this.db
			.prepare(
				"SELECT expires_at, quota_limit, allowed_models, allowed_ips FROM api_keys WHERE id = ? AND owner_id = ?",
			)
			.bind(sourceId, owner_id)
			.first<
				Pick<
					DbApiKey,
					"expires_at" | "quota_limit" | "allowed_models" | "allowed_ips"
				>
			>();
		if (!source) return null;

		const names = Array.from({ length: opts.count }, (_, index) => {
			if (opts.name_rule === "prefix_sequence") {
				return `${opts.prefix ?? "key-"}${(opts.start_number ?? 1) + index}`;
			}
			return `Key-${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
		});

		const created = await Promise.all(
			names.map(async (name): Promise<CreatedApiKey> => {
				const id = `key_${crypto.randomUUID().replace(/-/g, "")}`;
				const plainKey = `sk-keyloomai-${crypto.randomUUID().replace(/-/g, "")}`;
				const [keyHash, encryptedKey] = await Promise.all([
					sha256(plainKey),
					encrypt(plainKey, this.encryptionKey),
				]);
				const record: DbApiKey = {
					id,
					owner_id,
					name,
					key_hash: keyHash,
					encrypted_key: encryptedKey,
					key_hint: mask(plainKey, 10, 4),
					is_enabled: 1,
					expires_at: source.expires_at,
					quota_limit: source.quota_limit,
					quota_used: 0,
					allowed_models: source.allowed_models,
					allowed_ips: source.allowed_ips,
					created_at: Date.now(),
				};
				return { record, plainKey };
			}),
		);

		await this.db.batch(
			created.map(({ record }) =>
				this.db
					.prepare(
						`INSERT INTO api_keys (id, owner_id, name, key_hash, encrypted_key, key_hint, is_enabled, expires_at, quota_limit, quota_used, allowed_models, allowed_ips, created_at)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					)
					.bind(
						record.id,
						record.owner_id,
						record.name,
						record.key_hash,
						record.encrypted_key,
						record.key_hint,
						record.is_enabled,
						record.expires_at,
						record.quota_limit,
						record.quota_used,
						record.allowed_models,
						record.allowed_ips,
						record.created_at,
					),
			),
		);

		return created;
	}

	/** Lookup a key by SHA-256 hash of the plaintext token (for auth). */
	async getByHash(keyHash: string): Promise<DbApiKey | null> {
		return this.db
			.prepare("SELECT * FROM api_keys WHERE key_hash = ?")
			.bind(keyHash)
			.first<DbApiKey>();
	}

	async listKeys(owner_id: string): Promise<DbApiKey[]> {
		const res = await this.db
			.prepare(
				"SELECT * FROM api_keys WHERE owner_id = ? ORDER BY created_at DESC",
			)
			.bind(owner_id)
			.all<DbApiKey>();
		return res.results || [];
	}

	/** Decrypt and return the full plaintext key (for reveal). */
	async revealKey(id: string, owner_id: string): Promise<string | null> {
		const row = await this.db
			.prepare(
				"SELECT encrypted_key FROM api_keys WHERE id = ? AND owner_id = ?",
			)
			.bind(id, owner_id)
			.first<{ encrypted_key: string }>();
		if (!row) return null;
		return decrypt(row.encrypted_key, this.encryptionKey);
	}

	async updateKey(
		id: string,
		owner_id: string,
		updates: UpdateKeyFields,
	): Promise<boolean> {
		const sets: string[] = [];
		const values: unknown[] = [];
		if (updates.name !== undefined) {
			sets.push("name = ?");
			values.push(updates.name);
		}
		if (updates.is_enabled !== undefined) {
			sets.push("is_enabled = ?");
			values.push(updates.is_enabled);
		}
		if (updates.expires_at !== undefined) {
			sets.push("expires_at = ?");
			values.push(updates.expires_at);
		}
		if (updates.quota_limit !== undefined) {
			sets.push("quota_limit = ?");
			values.push(updates.quota_limit);
		}
		if (updates.allowed_models !== undefined) {
			sets.push("allowed_models = ?");
			values.push(
				updates.allowed_models?.length
					? JSON.stringify(updates.allowed_models)
					: null,
			);
		}
		if (updates.allowed_ips !== undefined) {
			sets.push("allowed_ips = ?");
			values.push(
				updates.allowed_ips?.length
					? JSON.stringify(updates.allowed_ips)
					: null,
			);
		}
		if (sets.length === 0) return false;

		const result = await this.db
			.prepare(
				`UPDATE api_keys SET ${sets.join(", ")} WHERE id = ? AND owner_id = ?`,
			)
			.bind(...values, id, owner_id)
			.run();
		return (result.meta?.changes ?? 0) > 0;
	}

	/** Atomically increment quota_used after a billed request. */
	async incrementQuotaUsed(keyId: string, cost: number): Promise<void> {
		await this.db
			.prepare("UPDATE api_keys SET quota_used = quota_used + ? WHERE id = ?")
			.bind(cost, keyId)
			.run();
	}

	async resetQuotaUsed(id: string, owner_id: string): Promise<boolean> {
		const result = await this.db
			.prepare(
				"UPDATE api_keys SET quota_used = 0 WHERE id = ? AND owner_id = ?",
			)
			.bind(id, owner_id)
			.run();
		return (result.meta?.changes ?? 0) > 0;
	}

	async deleteKey(id: string, owner_id: string): Promise<boolean> {
		const result = await this.db
			.prepare("DELETE FROM api_keys WHERE id = ? AND owner_id = ?")
			.bind(id, owner_id)
			.run();
		return result.success && result.meta?.rows_written === 1;
	}
}
