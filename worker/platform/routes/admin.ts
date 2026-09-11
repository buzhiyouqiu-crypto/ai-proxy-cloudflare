import { Hono } from "hono";
import { z } from "zod";
import { CandleDao } from "../../core/db/candle-dao";
import { CatalogDao } from "../../core/db/catalog-dao";
import { CredentialsDao } from "../../core/db/credentials-dao";
import {
	createCustomProvider,
	parseCustomChannelMetadata,
	testCustomExtractor,
	type CustomChannelModel,
} from "../../core/providers/custom-openai-compatible";
import {
	syncAllModels,
	syncAutoCredits,
	syncFromRemote,
} from "../../core/sync/sync-service";
import { purgePublicCaches } from "../../shared/cache";
import { briefHint, decrypt, mask } from "../../shared/crypto";
import {
	encryptCustomChannelName,
	publicCustomChannelName,
	publicCustomChannelProviderId,
	resolveCustomChannelName,
} from "../../shared/custom-channel-identity";
import { BadRequestError } from "../../shared/errors";
import {
	isMonetaryBalance,
	readBalanceSnapshot,
	writeBalanceSnapshot,
} from "../../shared/provider-balance";
import type { AppEnv } from "../../shared/types";
import type { DbCredential } from "../../core/db/schema";
import { parse } from "../../shared/validate";
import { AdminDao } from "../billing/admin-dao";
import { GiftCardDao } from "../billing/gift-card-dao";

const admin = new Hono<AppEnv>();

const CustomModelInput = z.object({
	id: z.string().trim().min(1).max(200),
	catalogModelId: z.string().trim().max(200).nullable().optional(),
	catalogName: z.string().trim().max(200).nullable().optional(),
	name: z.string().trim().max(200).nullable().optional(),
	inputPrice: z.number().min(0).max(1_000_000),
	outputPrice: z.number().min(0).max(1_000_000),
	imagePrice: z.number().min(0).max(1_000_000).nullable().optional(),
	contextLength: z.number().int().positive().max(10_000_000).nullable().optional(),
	modelType: z.enum(["chat", "embedding"]).optional(),
});

const CustomChannelInput = z.object({
	name: z.string().trim().min(1).max(100),
	baseUrl: z.string().trim().url(),
	websiteUrl: z.string().trim().url().nullable().optional(),
	secret: z.string().trim().max(1000).optional(),
	requiresApiKey: z.boolean().optional(),
	models: z.array(CustomModelInput).min(1).max(100),
	defaultInputPrice: z.number().min(0).max(1_000_000).optional(),
	defaultOutputPrice: z.number().min(0).max(1_000_000).optional(),
	extractorCode: z.string().max(20_000).nullable().optional(),
	isEnabled: z.boolean().optional(),
	priceMultiplier: z.number().positive().max(10).optional(),
});

const CustomChannelUpdateInput = CustomChannelInput.partial().extend({
	isEnabled: z.boolean().optional(),
	priceMultiplier: z.number().positive().max(10).optional(),
});

const DiscoverModelsInput = z.object({
	baseUrl: z.string().trim().url(),
	secret: z.string().trim().max(1000).optional(),
	requiresApiKey: z.boolean().optional(),
	channelId: z.string().trim().min(1).optional(),
	inputPrice: z.number().min(0).max(1_000_000).default(0),
	outputPrice: z.number().min(0).max(1_000_000).default(0),
});

const TestExtractorInput = z.object({
	secret: z.string().trim().max(1000).optional(),
	extractorCode: z.string().trim().min(1).max(20_000),
});

function customCatalogEntries(
	models: Array<{
		channelId: string;
		channelName: string;
		model: CustomChannelModel;
	}>,
): Omit<
	import("../../core/db/schema").DbModelCatalog,
	"refreshed_at" | "is_active"
>[] {
	return models.map(({ channelId, channelName, model }) => {
		const catalogModelId = model.catalogModelId?.trim() || model.id.trim();
		return {
			id: `custom:${channelId}:${catalogModelId}`,
			provider_id: "custom",
			model_id: catalogModelId,
			name: model.catalogName || model.name || catalogModelId,
			model_type: model.modelType ?? "chat",
			input_price: model.inputPrice,
			output_price: model.outputPrice,
			context_length: model.contextLength ?? null,
			input_modalities:
				model.imagePrice != null ? '["text","image"]' : '["text"]',
			output_modalities: model.imagePrice != null ? '["image"]' : '["text"]',
			upstream_model_id: model.id,
			metadata: JSON.stringify({
				channelId,
				channelName,
				canonicalModelId: catalogModelId,
				upstreamModelId: model.id,
				pricing: {
					prompt: String(model.inputPrice / 1_000_000),
					completion: String(model.outputPrice / 1_000_000),
					image:
						model.imagePrice == null
							? null
							: String(model.imagePrice),
				},
				imagePricePerImage: model.imagePrice ?? null,
			}),
			created: Date.now(),
		};
	});
}

async function rebuildCustomCatalog(db: D1Database): Promise<void> {
	const rows = await db
		.prepare(
			"SELECT id, metadata FROM upstream_credentials WHERE provider_id = 'custom' AND is_enabled = 1",
		)
		.all<{ id: string; metadata: string | null }>();
	const models: Array<{
		channelId: string;
		channelName: string;
		model: CustomChannelModel;
	}> = [];
	for (const row of rows.results ?? []) {
		const channel = parseCustomChannelMetadata(row.metadata);
		if (!channel) continue;
		for (const model of channel.models) {
			models.push({
				channelId: row.id,
				channelName: channel.name,
				model,
			});
		}
	}

	const catalog = new CatalogDao(db);
	await catalog.deactivateProvider("custom");
	const entries = customCatalogEntries(models);
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
	const encryptionKey = c.env.ENCRYPTION_KEY;
	const rows = await new CredentialsDao(
		c.env.DB,
		encryptionKey,
	).getGlobal();
	const channels = await Promise.all(
		rows
			.filter((row) => row.provider_id === "custom")
			.map(async (row) => {
				const channel = parseCustomChannelMetadata(row.metadata);
				return {
					id: row.id,
					publicProviderId: publicCustomChannelProviderId(row.id),
					publicName: publicCustomChannelName(row.id),
					name: await resolveCustomChannelName(
						channel,
						row.id,
						encryptionKey,
					),
					baseUrl: channel?.baseUrl ?? "",
					requiresApiKey: channel?.requiresApiKey !== false,
					websiteUrl: channel?.websiteUrl ?? null,
					models: channel?.models ?? [],
					defaultInputPrice: channel?.defaultInputPrice ?? 0,
					defaultOutputPrice: channel?.defaultOutputPrice ?? 0,
					extractorCode: channel?.extractorCode ?? "",
					hasExtractor: Boolean(channel?.extractorCode?.trim()),
					secretHint: row.secret_hint,
					quota: row.quota,
					balance: readBalanceSnapshot(row.metadata),
					isEnabled: row.is_enabled === 1,
					priceMultiplier: row.price_multiplier,
					health: row.health_status,
					addedAt: row.added_at,
				};
			}),
	);
	return c.json({
		data: channels,
	});
});

admin.get("/channels/catalog-models", async (c) => {
	const rows = await new CatalogDao(c.env.DB).getAllActive();
	const providerRank = (modelId: string, providerId: string) => {
		const organization = modelId.includes("/")
			? modelId.slice(0, modelId.indexOf("/"))
			: null;
		if (providerId === organization || (!organization && providerId === "openai")) return 0;
		if (providerId === "openrouter") return 1;
		if (providerId === "custom") return 3;
		return 2;
	};
	const options = new Map<
		string,
		{
			id: string;
				name: string | null;
				providerId: string;
				modelType: "chat" | "embedding";
				inputPrice: number;
				outputPrice: number;
				contextLength: number | null;
			}
	>();
	for (const row of rows) {
		const current = options.get(row.model_id);
		const rank = providerRank(row.model_id, row.provider_id);
		const currentRank = current
			? providerRank(row.model_id, current.providerId)
			: Number.POSITIVE_INFINITY;
		if (!current || rank < currentRank) {
			options.set(row.model_id, {
				id: row.model_id,
				name: row.name,
				providerId: row.provider_id,
				modelType: row.model_type,
				inputPrice: Math.max(0, row.input_price),
				outputPrice: Math.max(0, row.output_price),
				contextLength: row.context_length,
			});
		}
	}
	return c.json({
		data: [...options.values()].sort((a, b) =>
			(a.name || a.id).localeCompare(b.name || b.id),
		),
	});
});

function modelEndpointCandidates(baseUrl: string): string[] {
	const normalized = baseUrl
		.replace(/\/(chat\/completions|embeddings|models)$/i, "")
		.replace(/\/+$/, "");
	const root = normalized.replace(/\/v1$/i, "");
	return [...new Set([`${normalized}/models`, `${root}/v1/models`, `${root}/models`])];
}

function discoveredModelRows(
	raw: unknown,
	inputPrice: number,
	outputPrice: number,
): CustomChannelModel[] {
	if (!raw || typeof raw !== "object") return [];
	const root = raw as Record<string, unknown>;
	const nested = root.data;
	const nestedObject =
		nested && typeof nested === "object"
			? (nested as Record<string, unknown>)
			: null;
	const resultObject =
		root.result && typeof root.result === "object"
			? (root.result as Record<string, unknown>)
			: null;
	const data: unknown[] = Array.isArray(nested)
		? nested
		: Array.isArray(nestedObject?.data)
			? nestedObject.data
			: Array.isArray(nestedObject?.models)
				? nestedObject.models
				: Array.isArray(root.models)
					? root.models
					: Array.isArray(root.result)
						? root.result
						: Array.isArray(resultObject?.models)
							? resultObject.models
							: [];

	const parsePrice = (value: unknown, perToken: boolean, fallback: number) => {
		const parsed = Number(value);
		if (!Number.isFinite(parsed) || parsed < 0) return fallback;
		return perToken ? parsed * 1_000_000 : parsed;
	};

	return data
		.map((entry) => {
			if (typeof entry === "string") {
				return {
					id: entry,
					name: entry,
					inputPrice,
					outputPrice,
					contextLength: null,
					modelType: "chat" as const,
				};
			}
			if (!entry || typeof entry !== "object") return null;
			const item = entry as Record<string, unknown>;
			const id =
				typeof item.id === "string"
					? item.id
					: typeof item.model === "string"
						? item.model
						: typeof item.model_name === "string"
							? item.model_name
							: "";
			if (!id) return null;
			const pricing =
				item.pricing && typeof item.pricing === "object"
					? (item.pricing as Record<string, unknown>)
					: {};
			const input =
				pricing.prompt ?? pricing.input_tokens ?? item.input_price ?? item.inputPrice;
			const output =
				pricing.completion ??
				pricing.output_tokens ??
				item.output_price ??
				item.outputPrice;
			const inputIsPerToken = pricing.prompt != null;
			const outputIsPerToken = pricing.completion != null;
			return {
				id,
				name:
					typeof item.name === "string"
						? item.name
						: typeof item.display_name === "string"
							? item.display_name
							: id,
				inputPrice:
					input == null
						? inputPrice
						: parsePrice(input, inputIsPerToken, inputPrice),
				outputPrice:
					output == null
						? outputPrice
						: parsePrice(output, outputIsPerToken, outputPrice),
				contextLength:
					typeof item.context_length === "number"
						? item.context_length
						: typeof item.contextLength === "number"
							? item.contextLength
							: null,
				modelType:
					typeof item.type === "string" && item.type.includes("embedding")
						? ("embedding" as const)
						: ("chat" as const),
			};
		})
		.filter((model): model is NonNullable<typeof model> => model !== null)
		.slice(0, 200);
}

admin.post("/channels/discover-models", async (c) => {
	const body = parse(
		DiscoverModelsInput,
		await c.req.json().catch(() => {
			throw new BadRequestError("Invalid JSON body", "invalid_json");
		}),
	);
	let secret = body.secret ?? "";
	let requiresApiKey = body.requiresApiKey !== false;
	if (!secret && body.channelId) {
		const row = await c.env.DB.prepare(
			"SELECT * FROM upstream_credentials WHERE id = ? AND provider_id = 'custom'",
		)
			.bind(body.channelId)
			.first<DbCredential>();
		if (!row) throw new BadRequestError("Channel not found", "credential_not_found");
		const channel = parseCustomChannelMetadata(row.metadata);
		requiresApiKey =
			body.requiresApiKey === undefined
				? channel?.requiresApiKey !== false
				: body.requiresApiKey;
		secret = await new CredentialsDao(c.env.DB, c.env.ENCRYPTION_KEY).decryptSecret(row);
	}
	if (requiresApiKey && !secret) {
		throw new BadRequestError(
			"An upstream API key is required to discover models",
			"upstream_key_required",
		);
	}
	let lastStatus = 0;
	for (const modelsUrl of modelEndpointCandidates(body.baseUrl)) {
		try {
			const headers: Record<string, string> = { Accept: "application/json" };
			if (requiresApiKey && secret) headers.Authorization = `Bearer ${secret}`;
			const response = await fetch(modelsUrl, {
				headers,
			});
			lastStatus = response.status;
			if (!response.ok) continue;
			const raw = await response.json().catch(() => ({}));
			const models = discoveredModelRows(raw, body.inputPrice, body.outputPrice);
			if (models.length > 0) {
				return c.json({ data: models, count: models.length, source: modelsUrl });
			}
		} catch {
			// Try the next common OpenAI-compatible endpoint shape.
		}
	}

	if (lastStatus > 0) {
		throw new BadRequestError(
			`Upstream model endpoints returned no models (last HTTP ${lastStatus})`,
			"upstream_models_error",
		);
	}
	throw new BadRequestError(
		"Unable to reach any compatible /models endpoint",
		"upstream_unreachable",
	);
});

admin.post("/channels/test-extractor", async (c) => {
	const body = parse(
		TestExtractorInput,
		await c.req.json().catch(() => {
			throw new BadRequestError("Invalid JSON body", "invalid_json");
		}),
	);
	const credits = await testCustomExtractor(body.extractorCode, body.secret ?? "");
	if (!credits) {
		throw new BadRequestError(
			"The extractor did not return a readable balance",
			"balance_extract_failed",
		);
	}
	return c.json({
		data: {
			remaining: credits.remaining,
			usage: credits.usage,
			currency: credits.currency,
			unit: credits.unit,
			display: credits.display,
			details: credits.details,
		},
	});
});

admin.post("/channels/:id/test-extractor", async (c) => {
	const id = c.req.param("id");
	const body = parse(
		z.object({ extractorCode: z.string().trim().min(1).max(20_000) }),
		await c.req.json().catch(() => {
			throw new BadRequestError("Invalid JSON body", "invalid_json");
		}),
	);
	const row = await c.env.DB.prepare(
		"SELECT * FROM upstream_credentials WHERE id = ? AND provider_id = 'custom'",
	)
		.bind(id)
		.first<DbCredential>();
	if (!row) throw new BadRequestError("Channel not found", "credential_not_found");
	const credits = await testCustomExtractor(
		body.extractorCode,
		await new CredentialsDao(c.env.DB, c.env.ENCRYPTION_KEY).decryptSecret(row),
	);
	if (!credits) {
		throw new BadRequestError(
			"The extractor did not return a readable balance",
			"balance_extract_failed",
		);
	}
	return c.json({
		data: {
			remaining: credits.remaining,
			usage: credits.usage,
			currency: credits.currency,
			unit: credits.unit,
			display: credits.display,
			details: credits.details,
		},
	});
});

admin.post("/channels", async (c) => {
	const body = parse(
		CustomChannelInput,
		await c.req.json().catch(() => {
			throw new BadRequestError("Invalid JSON body", "invalid_json");
		}),
	);
	const secret = body.secret ?? "";
	const requiresApiKey = body.requiresApiKey !== false;
	if (requiresApiKey && !secret) {
		throw new BadRequestError(
			"请填写上游 API Key，或勾选上游不需要 API Key",
			"upstream_key_required",
		);
	}

	const url = new URL(body.baseUrl);
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new BadRequestError("baseUrl must use http or https", "invalid_url");
	}

	const metadata = {
		type: "custom_openai" as const,
		name: "",
		nameCiphertext: "",
		baseUrl: body.baseUrl.replace(/\/+$/, ""),
		requiresApiKey,
		models: body.models,
		websiteUrl: body.websiteUrl ?? null,
		defaultInputPrice: body.defaultInputPrice ?? 0,
		defaultOutputPrice: body.defaultOutputPrice ?? 0,
		extractorCode: body.extractorCode?.trim() || null,
	};
	const dao = new CredentialsDao(c.env.DB, c.env.ENCRYPTION_KEY);
	if (secret && (await dao.existsBySecretHash(secret))) {
		throw new BadRequestError("This upstream key is already configured", "credential_duplicate");
	}

	const id = `cred_${crypto.randomUUID()}`;
	metadata.name = publicCustomChannelName(id);
	metadata.nameCiphertext = await encryptCustomChannelName(
		body.name,
		c.env.ENCRYPTION_KEY,
	);
	const credential = await dao.add({
		id,
		owner_id: c.get("owner_id"),
		provider_id: "custom",
		secret,
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
	if (!credits) {
		throw new BadRequestError("The extractor did not return a balance", "balance_extract_failed");
	}
	const dao = new CredentialsDao(c.env.DB, c.env.ENCRYPTION_KEY);
	await dao.updateMetadata(id, writeBalanceSnapshot(row.metadata, credits));
	let quota = row.quota;
	if (credits.remaining != null && isMonetaryBalance(credits, "USD")) {
		const rate = Number.parseFloat(c.env.CNY_USD_RATE || "7");
		quota = credits.currency === "CNY" ? credits.remaining / rate : credits.remaining;
		await dao.updateQuota(id, quota, "auto");
	}
	return c.json({
		data: {
			quota,
			remaining: credits.remaining,
			currency: credits.currency,
			unit: credits.unit,
			display: credits.display,
			details: credits.details,
		},
	});
});

admin.patch("/channels/:id", async (c) => {
	const body = parse(
		CustomChannelUpdateInput,
		await c.req.json().catch(() => {
			throw new BadRequestError("Invalid JSON body", "invalid_json");
		}),
	);
	const channelFields = [
		"name",
		"baseUrl",
		"websiteUrl",
		"secret",
		"requiresApiKey",
		"models",
		"defaultInputPrice",
		"defaultOutputPrice",
		"extractorCode",
	] as const;
	const hasChannelUpdate = channelFields.some((field) => body[field] !== undefined);
	if (!hasChannelUpdate && body.isEnabled == null && body.priceMultiplier == null) {
		throw new BadRequestError("No settings to update", "settings_required");
	}

	const id = c.req.param("id");
	const row = await c.env.DB.prepare(
		"SELECT * FROM upstream_credentials WHERE id = ? AND provider_id = 'custom'",
	)
		.bind(id)
		.first<DbCredential>();
	if (!row) throw new BadRequestError("Channel not found", "credential_not_found");

	if (hasChannelUpdate) {
		const current = parseCustomChannelMetadata(row.metadata);
		if (!current) {
			throw new BadRequestError("Invalid custom channel metadata", "channel_invalid");
		}
		const currentName = await resolveCustomChannelName(
			current,
			id,
			c.env.ENCRYPTION_KEY,
		);
		const metadata = {
			...current,
			name: publicCustomChannelName(id),
			nameCiphertext: await encryptCustomChannelName(
				body.name ?? currentName,
				c.env.ENCRYPTION_KEY,
			),
			baseUrl: body.baseUrl?.replace(/\/+$/, "") ?? current.baseUrl,
			requiresApiKey:
				body.requiresApiKey ?? current.requiresApiKey !== false,
			websiteUrl: body.websiteUrl === undefined ? current.websiteUrl ?? null : body.websiteUrl,
			models: body.models ?? current.models,
			defaultInputPrice: body.defaultInputPrice ?? current.defaultInputPrice ?? 0,
			defaultOutputPrice: body.defaultOutputPrice ?? current.defaultOutputPrice ?? 0,
			extractorCode:
				body.extractorCode === undefined
					? current.extractorCode ?? null
					: body.extractorCode?.trim() || null,
		};
		const url = new URL(metadata.baseUrl);
		if (url.protocol !== "http:" && url.protocol !== "https:") {
			throw new BadRequestError("baseUrl must use http or https", "invalid_url");
		}
		if (metadata.requiresApiKey && current.requiresApiKey === false && !body.secret?.trim()) {
			throw new BadRequestError(
				"请填写上游 API Key，或勾选上游不需要 API Key",
				"upstream_key_required",
			);
		}
		await new CredentialsDao(c.env.DB, c.env.ENCRYPTION_KEY).updateCustomChannel(id, {
			metadata,
			secret: body.secret,
			clearSecret: metadata.requiresApiKey === false,
			isEnabled: body.isEnabled == null ? row.is_enabled : body.isEnabled ? 1 : 0,
			priceMultiplier: body.priceMultiplier ?? row.price_multiplier,
			quotaSource: metadata.extractorCode ? "auto" : null,
		});
	} else {
		await new CredentialsDao(c.env.DB, c.env.ENCRYPTION_KEY).updateSettings(
			id,
			body.isEnabled == null ? row.is_enabled : body.isEnabled ? 1 : 0,
			body.priceMultiplier ?? row.price_multiplier,
		);
	}

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

	// Rebuild custom entries as well, so older channels created before explicit
	// catalog selection stop using the removed implicit suffix mapping.
	await rebuildCustomCatalog(c.env.DB);
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
