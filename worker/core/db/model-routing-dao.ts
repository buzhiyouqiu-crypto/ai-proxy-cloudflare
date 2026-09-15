export interface DbModelRoutePolicy {
	model_id: string;
	is_enabled: number;
	updated_by: string;
	updated_at: number;
}

export interface DbModelRouteRule {
	id: string;
	model_id: string;
	provider_key: string;
	priority: number;
	quota_limit: number | null;
	quota_used: number;
	created_at: number;
	updated_at: number;
}

export interface ModelRouteRuleInput {
	providerKey: string;
	quotaLimit: number | null;
}

export interface ModelRouteConfig {
	policy: DbModelRoutePolicy | null;
	rules: DbModelRouteRule[];
}

/** Persistent model-level provider priority and request quota state. */
export class ModelRoutingDao {
	constructor(private db: D1Database) {}

	async get(modelId: string): Promise<ModelRouteConfig> {
		const [policy, rules] = await Promise.all([
			this.db
				.prepare("SELECT * FROM model_route_policies WHERE model_id = ?")
				.bind(modelId)
				.first<DbModelRoutePolicy>(),
			this.db
				.prepare(
					"SELECT * FROM model_route_rules WHERE model_id = ? ORDER BY priority ASC",
				)
				.bind(modelId)
				.all<DbModelRouteRule>(),
		]);

		return { policy, rules: rules.results ?? [] };
	}

	async listPolicies(): Promise<DbModelRoutePolicy[]> {
		const result = await this.db
			.prepare("SELECT * FROM model_route_policies ORDER BY updated_at DESC")
			.all<DbModelRoutePolicy>();
		return result.results ?? [];
	}

	/**
	 * Save the ordered rules while preserving each existing rule's usage count.
	 * D1 batches are atomic, so a request cannot observe a half-written policy.
	 */
	async save(
		modelId: string,
		enabled: boolean,
		rules: ModelRouteRuleInput[],
		updatedBy: string,
	): Promise<ModelRouteConfig> {
		const now = Date.now();
		const existing = await this.get(modelId);
		const existingByProvider = new Map(
			existing.rules.map((rule) => [rule.provider_key, rule]),
		);
		const statements = [
			this.db
				.prepare(
					`INSERT INTO model_route_policies (model_id, is_enabled, updated_by, updated_at)
					 VALUES (?, ?, ?, ?)
					 ON CONFLICT(model_id) DO UPDATE SET
					   is_enabled = excluded.is_enabled,
					   updated_by = excluded.updated_by,
					   updated_at = excluded.updated_at`,
				)
				.bind(modelId, enabled ? 1 : 0, updatedBy, now),
		];

		const providerKeys = new Set<string>();
		for (const [index, rule] of rules.entries()) {
			providerKeys.add(rule.providerKey);
			const previous = existingByProvider.get(rule.providerKey);
			const id = previous?.id ?? `route_${crypto.randomUUID()}`;
			statements.push(
				this.db
					.prepare(
						`INSERT INTO model_route_rules
							(id, model_id, provider_key, priority, quota_limit, quota_used, created_at, updated_at)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
						 ON CONFLICT(model_id, provider_key) DO UPDATE SET
						   priority = excluded.priority,
						   quota_limit = excluded.quota_limit,
						   updated_at = excluded.updated_at`,
					)
					.bind(
						id,
						modelId,
						rule.providerKey,
						index + 1,
						rule.quotaLimit,
						previous?.quota_used ?? 0,
						previous?.created_at ?? now,
						now,
					),
			);
		}

		if (providerKeys.size === 0) {
			statements.push(
				this.db
					.prepare("DELETE FROM model_route_rules WHERE model_id = ?")
					.bind(modelId),
			);
		} else {
			const placeholders = [...providerKeys].map(() => "?").join(", ");
			statements.push(
				this.db
					.prepare(
						`DELETE FROM model_route_rules
						 WHERE model_id = ? AND provider_key NOT IN (${placeholders})`,
					)
					.bind(modelId, ...providerKeys),
			);
		}

		await this.db.batch(statements);
		return this.get(modelId);
	}

	/** Atomically reserve request units for a route rule. */
	async tryConsume(ruleId: string, units: number): Promise<boolean> {
		if (!Number.isInteger(units) || units < 1) return false;
		const result = await this.db
			.prepare(
				`UPDATE model_route_rules
				 SET quota_used = quota_used + ?, updated_at = ?
				 WHERE id = ?
				   AND (quota_limit IS NULL OR quota_used + ? <= quota_limit)`,
			)
			.bind(units, Date.now(), ruleId, units)
			.run();
		return (result.meta?.changes ?? result.meta?.rows_written ?? 0) > 0;
	}

	/** Release a reservation when the upstream request never succeeded. */
	async release(ruleId: string, units: number): Promise<void> {
		if (!Number.isInteger(units) || units < 1) return;
		await this.db
			.prepare(
				`UPDATE model_route_rules
				 SET quota_used = MAX(quota_used - ?, 0), updated_at = ?
				 WHERE id = ?`,
			)
			.bind(units, Date.now(), ruleId)
			.run();
	}
}
