import { Hono } from "hono";
import { z } from "zod";
import { CandleDao } from "../../core/db/candle-dao";
import { CatalogDao } from "../../core/db/catalog-dao";
import { CredentialsDao } from "../../core/db/credentials-dao";
import {
	createCustomProvider,
	parseCustomChannelMetadata,
	type CustomChannelModel,
} from "../../core/providers/custom-openai-compatible";
import {
	syncAllModels,
	syncAutoCredits,
	syncFromRemote,
} from "../../core/sync/sync-service";
import { purgePublicCaches } from "../../shared/cache";
import { briefHint, decrypt, mask } from "../../shared/crypto";
import { BadRequestError } from "../../shared/errors";
import type { AppEnv } from "../../shared/types";
import type { DbCredential } from "../../core/db/schema";
import { parse } from "../../shared/validate";
import { AdminDao } from "../billing/admin-dao";
import { GiftCardDao } from "../billing/gift-card-dao";

const admin = new Hono<AppEnv>();

const CustomModelInput = z.object({
	id: z.string().trim().min(1).max(200),
	name: z.string().trim().max(200).nullable().optional(),
	inputPrice: z.number().min(0).max(1_000_000),
	outputPrice: z.number().min(0).max(1_000_000),
	contextLength: z.number().int().positive().max(10_000_000).nullable().optional(),
	modelType: z.enum(["chat", "embedding"]).optional(),
});

const CustomChannelInput = z.object({
	name: z.string().trim().min(1).max(100),
	baseUrl: z.string().trim().url(),
	websiteUrl: z.string().trim().url().nullable().optional(),
	secret: z.string().trim().min(1).max(1000),
	models: z.array(CustomModelInput).min(1).max(100),
	defaultInputPrice: z.number().min(0).max(1_000_000).optional(),
	defaultOutputPrice: z.number().min(0).max(1_000_000).optional(),
	extractorCode: z.string().max(20_000).nullable().optional(),
	isEnabled: z.boolean().optional(),
	priceMultiplier: z.number().positive().max(10).optional(),
});

const DiscoverModelsInput = z.object({
	baseUrl: z.string().trim().url(),
	secret: z.string().trim().min(1).max(1000),
	inputPrice: z.number().min(0).max(1_000_000).default(0),
	outputPrice: z.number().min(0).max(1_000_000).default(0),
});

function customCatalogEntries(
	models: CustomChannelModel[],
): Omit<
	import("../../core/db/schema").DbModelCatalog,
	"refreshed_at" | "is_active"
>[] {
	return models.map((model) => ({
		id: `custom:${model.id}`,
		provider_id: "custom",
		model_id: model.id,
		name: model.name || model.id,
		model_type: model.modelType ?? "chat",
		input_price: model.inputPrice,
		output_price: model.outputPrice,
		context_length: model.contextLength ?? null,
		input_modalities: '["text"]',
		output_modalities: '["text"]',
		upstream_model_id: null,
		metadata: JSON.stringify({
			pricing: {
				prompt: String(model.inputPrice / 1_000_000),
				completion: String(model.outputPrice / 1_000_000),
			},
		}),
		created: Date.now(),
	}));
}

async function rebuildCustomCatalog(db: D1Database): Promise<void> {
	const rows = await db
		.prepare(
			"SELECT metadata FROM upstream_credentials WHERE provider_id = 'custom' AND is_enabled = 1",
		)
		.all<{ metadata: string | null }>();
	const models = new Map<string, CustomChannelModel>();
	for (const row of rows.results ?? []) {
		const channel = parseCustomChannelMetadata(row.metadata);
		for (const model of channel?.models ?? []) {
			const current = models.get(model.id);
			if (!current || model.inputPrice < current.inputPrice) {
				models.set(model.id, model);
			}
		}
	}

	const catalog = new CatalogDao(db);
	await catalog.deactivateProvider("custom");
	const entries = customCatalogEntries([...models.values()]);
	if (entries.length > 0) await catalog.upsert(entries);
}

admin.use("*", async (c, next) => {
	const ownerId = c.get("owner_id");
	const platformOwnerId = c.env.PLATFORM_OWNER_ID;
	if (!platformOwnerId || ownerId !== platformOwnerId) {
		return c.json(
			{ error: { message: "Forbidden", type: "authorization_error" } },
			403,
		);
	}
	return next();
});

admin.get("/overview", async (c) => {
	const dao = new AdminDao(c.env.DB, c.env.CLERK_SECRET_KEY);
	return c.json({ data: await dao.getOverview() });
});

admin.get("/users", async (c) => {
	const dao = new AdminDao(c.env.DB);
	return c.json({ data: await dao.getUsers() });
});

admin.post("/credits", async (c) => {
	const { ownerId, amount, reason } = await c.req.json<{
		ownerId: string;
		amount: number;
		reason?: string;
	}>();

	if (!ownerId || typeof amount !== "number" || amount === 0) {
		throw new BadRequestError(
			"ownerId + non-zero amount required",
			"admin_amount_required",
		);
	}

	await new AdminDao(c.env.DB).adjustCredits(ownerId, amount, reason || "");
	return c.json({ success: true });
});

admin.get("/adjustments", async (c) => {
	const limit = Math.min(Number(c.req.query("limit")) || 50, 200);
	const offset = Math.max(Number(c.req.query("offset")) || 0, 0);
	const result = await new AdminDao(c.env.DB).getAdjustments(limit, offset);
	return c.json({ rows: result.rows, total: result.total });
});

admin.get("/table/:name", async (c) => {
	const table = c.req.param("name");
	const limit = Math.min(Number(c.req.query("limit")) || 50, 200);
	const offset = Math.max(Number(c.req.query("offset")) || 0, 0);

	try {
		const result = await new AdminDao(c.env.DB).queryTable(
			table,
			limit,
			offset,
		);
		return c.json({ rows: result.rows, total: result.total });
	} catch (err) {
		throw new BadRequestError(
			err instanceof Error ? err.message : "Invalid table",
			"admin_invalid_table",
		);
	}
});

admin.get("/activity", async (c) => {
	const hours = Math.min(Number(c.req.query("hours")) || 24, 168);
	const data = await new AdminDao(c.env.DB).getActivity(hours);
	return c.json({ data });
});

// ─── Gift cards ──────────────────────────────────────────

admin.post("/gift-cards", async (c) => {
	const { amount, count } = await c.req.json<{
		amount: number;
		count: number;
	}>();

	if (!amount || amount <= 0) {
		throw new BadRequestError("amount > 0", "admin_gift_card_amount");
	}
	if (!count || !Number.isInteger(count) || count < 1 || count > 500) {
		throw new BadRequestError("count 1–500", "admin_gift_card_count");
	}

	const dao = new GiftCardDao(c.env.DB);
	const result = await dao.createBatch(c.get("owner_id"), amount, count);
	return c.json(result);
});

admin.get("/gift-cards", async (c) => {
	const limit = Math.min(Number(c.req.query("limit")) || 100, 500);
	const offset = Math.max(Number(c.req.query("offset")) || 0, 0);
	const cards = await new GiftCardDao(c.env.DB).listAll(limit, offset);
	return c.json(cards);
});

admin.get("/gift-cards/:batchId", async (c) => {
	const cards = await new GiftCardDao(c.env.DB).listBatch(
		c.req.param("batchId"),
	);
	return c.json({ data: cards });
});

// ─── One-off maintenance ─────────────────────────────────

admin.post("/remask", async (c) => {
	const ek = c.env.ENCRYPTION_KEY;
	const db = c.env.DB;
	let updated = 0;

	const keys = await db
		.prepare("SELECT id, encrypted_key FROM api_keys")
		.all<{ id: string; encrypted_key: string }>();
	for (const row of keys.results ?? []) {
		const plain = await decrypt(row.encrypted_key, ek);
		const hint = mask(plain, 10, 4);
		await db
			.prepare("UPDATE api_keys SET key_hint = ? WHERE id = ?")
			.bind(hint, row.id)
			.run();
		updated++;
	}

	const creds = await db
		.prepare("SELECT id, encrypted_secret FROM upstream_credentials")
		.all<{ id: string; encrypted_secret: string }>();
	for (const row of creds.results ?? []) {
		const plain = await decrypt(row.encrypted_secret, ek);
		const hint = briefHint(plain);
		await db
			.prepare("UPDATE upstream_credentials SET secret_hint = ? WHERE id = ?")
			.bind(hint, row.id)
			.run();
		updated++;
	}

	return c.json({ message: "Hints re-masked", updated });
});

// ─── Administrator-managed OpenAI-compatible channels ────

admin.get("/channels", async (c) => {
	const rows = await new CredentialsDao(
		c.env.DB,
		c.env.ENCRYPTION_KEY,
	).getGlobal();
	return c.json({
		data: rows
			.filter((row) => row.provider_id === "custom")
			.map((row) => {
				const channel = parseCustomChannelMetadata(row.metadata);
				return {
					id: row.id,
					name: channel?.name ?? "自定义渠道",
					baseUrl: channel?.baseUrl ?? "",
					websiteUrl: channel?.websiteUrl ?? null,
					models: channel?.models ?? [],
					defaultInputPrice: channel?.defaultInputPrice ?? 0,
					defaultOutputPrice: channel?.defaultOutputPrice ?? 0,
					hasExtractor: Boolean(channel?.extractorCode?.trim()),
					secretHint: row.secret_hint,
					quota: row.quota,
					isEnabled: row.is_enabled === 1,
					priceMultiplier: row.price_multiplier,
					health: row.health_status,
					addedAt: row.added_at,
				};
			}),
	});
});

admin.post("/channels/discover-models", async (c) => {
	const body = parse(
		DiscoverModelsInput,
		await c.req.json().catch(() => {
			throw new BadRequestError("Invalid JSON body", "invalid_json");
		}),
	);
	const modelsUrl = `${body.baseUrl.replace(/\/+$/, "")}/models`;
	let response: Response;
	try {
		response = await fetch(modelsUrl, {
			headers: { Authorization: `Bearer ${body.secret}` },
		});
	} catch {
		throw new BadRequestError("Unable to reach the upstream models endpoint", "upstream_unreachable");
	}
	if (!response.ok) {
		throw new BadRequestError(
			`Upstream /models returned HTTP ${response.status}`,
			"upstream_models_error",
		);
	}

	const raw = (await response.json().catch(() => ({}))) as Record<string, unknown>;
	const data = Array.isArray(raw.data)
		? raw.data
		: Array.isArray(raw.models)
			? raw.models
			: [];
	const models = data
		.map((entry) => {
			if (!entry || typeof entry !== "object") return null;
			const item = entry as Record<string, unknown>;
			const id = typeof item.id === "string" ? item.id : "";
			if (!id) return null;
			const pricing = item.pricing as Record<string, unknown> | undefined;
			const parsedInput = Number(pricing?.prompt) * 1_000_000;
			const parsedOutput = Number(pricing?.completion) * 1_000_000;
			return {
				id,
				name: typeof item.name === "string" ? item.name : id,
				inputPrice: Number.isFinite(parsedInput) && parsedInput >= 0 ? parsedInput : body.inputPrice,
				outputPrice: Number.isFinite(parsedOutput) && parsedOutput >= 0 ? parsedOutput : body.outputPrice,
				contextLength: typeof item.context_length === "number" ? item.context_length : null,
				modelType: "chat" as const,
			};
		})
		.filter((model): model is NonNullable<typeof model> => model !== null)
		.slice(0, 100);

	return c.json({ data: models, count: models.length });
});

admin.post("/channels", async (c) => {
	const body = parse(
		CustomChannelInput,
		await c.req.json().catch(() => {
			throw new BadRequestError("Invalid JSON body", "invalid_json");
		}),
	);

	const url = new URL(body.baseUrl);
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new BadRequestError("baseUrl must use http or https", "invalid_url");
	}

	const metadata = {
		type: "custom_openai" as const,
		name: body.name,
		baseUrl: body.baseUrl.replace(/\/+$/, ""),
		models: body.models,
		websiteUrl: body.websiteUrl ?? null,
		defaultInputPrice: body.defaultInputPrice ?? 0,
		defaultOutputPrice: body.defaultOutputPrice ?? 0,
		extractorCode: body.extractorCode?.trim() || null,
	};
	const dao = new CredentialsDao(c.env.DB, c.env.ENCRYPTION_KEY);
	if (await dao.existsBySecretHash(body.secret)) {
		throw new BadRequestError("This upstream key is already configured", "credential_duplicate");
	}

	const credential = await dao.add({
		owner_id: c.get("owner_id"),
		provider_id: "custom",
		secret: body.secret,
		quota: null,
		quotaSource: metadata.extractorCode ? "auto" : null,
		isEnabled: body.isEnabled === false ? 0 : 1,
		priceMultiplier: body.priceMultiplier ?? 1,
		metadata,
	});
	await rebuildCustomCatalog(c.env.DB);
	const origin = new URL(c.req.url).origin;
	const purged = await purgePublicCaches(origin);
	return c.json(
		{
			id: credential.id,
			secretHint: credential.secret_hint,
			models: body.models.length,
			purged,
		},
		201,
	);
});

admin.post("/channels/:id/refresh-balance", async (c) => {
	const id = c.req.param("id");
	const row = await c.env.DB.prepare(
		"SELECT * FROM upstream_credentials WHERE id = ? AND provider_id = 'custom'",
	)
		.bind(id)
		.first<DbCredential>();
	if (!row) throw new BadRequestError("Channel not found", "credential_not_found");

	const provider = createCustomProvider(row);
	if (!provider) {
		throw new BadRequestError("This channel has no valid extractor", "extractor_required");
	}
	const credits = await provider.fetchCredits(
		await new CredentialsDao(c.env.DB, c.env.ENCRYPTION_KEY).decryptSecret(row),
	);
	if (!credits || credits.remaining == null) {
		throw new BadRequestError("The extractor did not return a balance", "balance_extract_failed");
	}
	const rate = Number.parseFloat(c.env.CNY_USD_RATE || "7");
	const quota = credits.currency === "CNY" ? credits.remaining / rate : credits.remaining;
	await new CredentialsDao(c.env.DB, c.env.ENCRYPTION_KEY).updateQuota(id, quota, "auto");
	return c.json({ data: { quota, remaining: credits.remaining, currency: credits.currency ?? "USD" } });
});

admin.patch("/channels/:id", async (c) => {
	const body = parse(
		z.object({
			isEnabled: z.boolean().optional(),
			priceMultiplier: z.number().positive().max(10).optional(),
		}),
		await c.req.json().catch(() => {
			throw new BadRequestError("Invalid JSON body", "invalid_json");
		}),
	);
	if (body.isEnabled == null && body.priceMultiplier == null) {
		throw new BadRequestError("No settings to update", "settings_required");
	}

	const id = c.req.param("id");
	const row = await c.env.DB.prepare(
		"SELECT id FROM upstream_credentials WHERE id = ? AND provider_id = 'custom'",
	)
		.bind(id)
		.first<{ id: string }>();
	if (!row) throw new BadRequestError("Channel not found", "credential_not_found");

	const current = await c.env.DB.prepare(
		"SELECT is_enabled, price_multiplier FROM upstream_credentials WHERE id = ?",
	)
		.bind(id)
		.first<{ is_enabled: number; price_multiplier: number }>();
	if (!current) throw new BadRequestError("Channel not found", "credential_not_found");

	await new CredentialsDao(c.env.DB, c.env.ENCRYPTION_KEY).updateSettings(
		id,
		body.isEnabled == null ? current.is_enabled : body.isEnabled ? 1 : 0,
		body.priceMultiplier ?? current.price_multiplier,
	);
	await rebuildCustomCatalog(c.env.DB);
	await purgePublicCaches(new URL(c.req.url).origin);
	return c.json({ success: true });
});

admin.delete("/channels/:id", async (c) => {
	const id = c.req.param("id");
	const deleted = await c.env.DB.prepare(
		"DELETE FROM upstream_credentials WHERE id = ? AND provider_id = 'custom'",
	)
		.bind(id)
		.run();
	if (!deleted.success || deleted.meta?.rows_written !== 1) {
		throw new BadRequestError("Channel not found", "credential_not_found");
	}

	await rebuildCustomCatalog(c.env.DB);
	await purgePublicCaches(new URL(c.req.url).origin);
	return c.json({ success: true });
});

// ─── Manual cron triggers ───────────────────────────────

admin.post("/sync-models", async (c) => {
	const rate = Number.parseFloat(c.env.CNY_USD_RATE || "7");
	const start = Date.now();

	if (c.env.LOCAL_SYNC) {
		await syncAllModels(c.env.DB, rate, c.env);
	} else {
		await syncFromRemote(c.env.DB);
	}

	await syncAutoCredits(c.env.DB, c.env.ENCRYPTION_KEY, rate);
	const origin = new URL(c.req.url).origin;
	const purged = await purgePublicCaches(origin);
	return c.json({
		message: "Models synced",
		purged,
		elapsed: Date.now() - start,
	});
});

admin.post("/sync-candles", async (c) => {
	const dao = new CandleDao(c.env.DB);
	const start = Date.now();
	await dao.aggregate(Date.now() - 60_000);
	const origin = new URL(c.req.url).origin;
	const purged = await purgePublicCaches(origin);
	return c.json({
		message: "Candles aggregated",
		purged,
		elapsed: Date.now() - start,
	});
});

export default admin;
