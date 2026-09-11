import { Hono } from "hono";
import { CandleDao } from "../core/db/candle-dao";
import { CatalogDao } from "../core/db/catalog-dao";
import { getVisibleProviders } from "../core/providers/registry";
import { edgeCache } from "../shared/cache";
import {
	publicCustomChannelProviderId,
	CUSTOM_PROVIDER_ID,
} from "../shared/custom-channel-identity";
import type { AppEnv } from "../shared/types";

/**
 * /api/catalog — Raw model_catalog export for remote sync.
 * Self-hosted deployments fetch this to populate their local DB.
 */
export const catalogRouter = new Hono<AppEnv>();

catalogRouter.get("/", edgeCache(3600), async (c) => {
	const dao = new CatalogDao(c.env.DB);
	const rows = await dao.getAllActive();
	return c.json({
		data: rows
			// Custom channel ids and metadata are administrator-owned routing data.
			// They must not be published through the public remote-sync catalog.
			.filter((row) => row.provider_id !== "custom")
			.map(({ is_active, refreshed_at, metadata, ...entry }) => ({
				...entry,
				metadata: sanitizeCatalogMetadata(metadata),
			})),
	});
});

function sanitizeCatalogMetadata(raw: string | null): string | null {
	if (!raw) return null;
	try {
		const value = JSON.parse(raw);
		if (!value || typeof value !== "object" || Array.isArray(value))
			return null;
		const {
			channelId: _channelId,
			channelName: _channelName,
			canonicalModelId: _canonicalModelId,
			...safe
		} = value as Record<string, unknown>;
		return JSON.stringify(safe);
	} catch {
		return null;
	}
}

/** Strip markdown links and bare URLs from model descriptions */
function cleanDescription(raw: unknown): string | null {
	if (typeof raw !== "string" || !raw) return null;
	return (
		raw
			.replace(/\[([^\]]*)\]\([^)]+\)/g, "") // [text](url) → removed entirely
			.replace(/https?:\/\/\S+/g, "") // bare URLs
			.replace(/ {2,}/g, " ") // collapse multiple spaces
			.replace(/\n{3,}/g, "\n\n") // collapse excess blank lines
			.trim() || null
	);
}

/**
 * /v1/models — Public API, one entry per model.
 *
 * Pricing uses pre-aggregated candle data (updated every minute):
 * - prompt/completion from model:input / model:output candle close prices
 * - Multi-modal prices derived via discount ratio against metadata
 * - Zero real-time computation per request
 */
export const publicModelsRouter = new Hono<AppEnv>();

publicModelsRouter.get("/", async (c) => {
	// This response is filtered by the authenticated API key's allowed_models.
	// Never place it in the shared Workers Cache, whose key does not include
	// Authorization or x-api-key.
	c.header("Cache-Control", "private, no-store");
	const dao = new CatalogDao(c.env.DB);
	const candleDao = new CandleDao(c.env.DB);

	const [all, inputPrices, outputPrices, customChannels] = await Promise.all([
		dao.getActiveWithBestMultiplier(),
		candleDao.getLatestPrices("model:input"),
		candleDao.getLatestPrices("model:output"),
		c.env.DB.prepare(
			"SELECT id FROM upstream_credentials WHERE provider_id = 'custom' AND is_enabled = 1",
		).all<{ id: string }>(),
	]);

	const visibleIds = new Set(getVisibleProviders().map((p) => p.info.id));
	if ((customChannels.results ?? []).length > 0) visibleIds.add(CUSTOM_PROVIDER_ID);
	const publicCustomProviders = new Map(
		(customChannels.results ?? []).map((row) => [
			row.id,
			publicCustomChannelProviderId(row.id),
		]),
	);

	// USD-per-M-tokens → USD-per-token string (OpenRouter format)
	const toUsdPerToken = (usdPerM: number) => String(usdPerM / 1_000_000);

	// Group by model_id (Map preserves insertion order = created DESC)
	const groups = new Map<
		string,
		{
			meta: Record<string, unknown> | null;
			providers: string[];
			name: string | null;
			modelType: string;
			contextLength: number | null;
		}
	>();

	for (const row of all) {
		if (!visibleIds.has(row.provider_id)) continue;
		const customChannelId =
			row.provider_id === CUSTOM_PROVIDER_ID
				? readCatalogChannelId(row.metadata)
				: null;
		const publicProviderId =
			row.provider_id === CUSTOM_PROVIDER_ID && customChannelId
				? publicCustomProviders.get(customChannelId)
				: row.provider_id;
		if (!publicProviderId) continue;

		let g = groups.get(row.model_id);
		if (!g) {
			const meta = row.metadata ? JSON.parse(row.metadata) : null;
			g = {
				meta,
				providers: [],
				name: row.name,
				modelType: row.model_type,
				contextLength: row.context_length,
			};
			groups.set(row.model_id, g);
		}

		if (row.best_multiplier != null) {
			if (!g.providers.includes(publicProviderId))
				g.providers.push(publicProviderId);
		}
	}

	const keyAllowedModels = c.get("allowed_models");
	const typeFilter = c.req.query("type");

	const data = [...groups.entries()]
		.filter(([id, g]) => {
			if (keyAllowedModels && !keyAllowedModels.includes(id)) return false;
			if (typeFilter && g.modelType !== typeFilter) return false;
			return true;
		})
		.map(([id, g]) => {
			const m = g.meta;

			// Build pricing from candle data
			const basePricing = (m?.pricing as Record<string, string>) ?? {};
			const pricing: Record<string, string> = { ...basePricing };

			const inputClose = inputPrices.get(id);
			const outputClose = outputPrices.get(id);

			if (inputClose != null) {
				pricing.prompt = toUsdPerToken(inputClose);

				// Derive discount ratio for multi-modal pricing
				const originalPrompt =
					Number.parseFloat(basePricing.prompt || "0") * 1_000_000;
				if (originalPrompt > 0) {
					const ratio = inputClose / originalPrompt;
					for (const [key, val] of Object.entries(basePricing)) {
						if (key !== "prompt" && key !== "completion" && val) {
							pricing[key] = String(Number.parseFloat(val) * ratio);
						}
					}
				}
			}
			if (outputClose != null) {
				pricing.completion = toUsdPerToken(outputClose);
			}

			return {
				id,
				type: g.modelType,
				name: (m?.name as string) ?? g.name ?? id,
				created: (m?.created as number) ?? 0,
				description: cleanDescription(m?.description),
				hugging_face_id: (m?.hugging_face_id as string) ?? null,
				context_length: (m?.context_length as number) ?? g.contextLength,
				pricing,
				architecture: (m?.architecture as Record<string, unknown>) ?? null,
				supported_parameters: (m?.supported_parameters as string[]) ?? null,
				providers: g.providers,
			};
		});

	return c.json({ data });
});

/**
 * /api/models — Dashboard API, multi-provider comparison.
 * Returns all provider offerings with per-provider pricing.
 * Multiplier derives from candle close_price (historical record), falling back to credential best_multiplier.
 * All display data reflects historical candle records — never real-time credential predictions.
 */
export const dashboardModelsRouter = new Hono<AppEnv>();

dashboardModelsRouter.get("/", edgeCache(3600), async (c) => {
	const dao = new CatalogDao(c.env.DB);
	const candleDao = new CandleDao(c.env.DB);

	const [all, providerMuls, customChannels] = await Promise.all([
		dao.getActiveWithBestMultiplier(),
		candleDao.getLatestPrices("provider"),
		c.env.DB.prepare(
			"SELECT id FROM upstream_credentials WHERE provider_id = 'custom' AND is_enabled = 1",
		).all<{ id: string }>(),
	]);

	const visibleIds = new Set(getVisibleProviders().map((p) => p.info.id));
	if ((customChannels.results ?? []).length > 0) visibleIds.add(CUSTOM_PROVIDER_ID);
	const publicCustomProviders = new Map(
		(customChannels.results ?? []).map((row) => [
			row.id,
			publicCustomChannelProviderId(row.id),
		]),
	);

	const data = all
		.filter((m) => visibleIds.has(m.provider_id))
		.map((m) => {
			const customChannelId =
				m.provider_id === CUSTOM_PROVIDER_ID
					? readCatalogChannelId(m.metadata)
					: null;
			const providerId =
				m.provider_id === CUSTOM_PROVIDER_ID && customChannelId
					? publicCustomProviders.get(customChannelId)
					: m.provider_id;
			if (!providerId) return null;
			const mul = providerMuls.get(m.provider_id) ?? m.best_multiplier;
			const meta = m.metadata ? JSON.parse(m.metadata) : null;
			return {
				id: m.model_id,
				type: m.model_type,
				provider_id: providerId,
				name: m.name,
				description: cleanDescription(meta?.description),
				input_price: m.input_price,
				output_price: m.output_price,
				...(mul != null &&
					mul < 1 && {
						platform_input_price: m.input_price * mul,
						platform_output_price: m.output_price * mul,
					}),
				context_length: m.context_length,
				created: m.created || null,
				input_modalities: m.input_modalities
					? JSON.parse(m.input_modalities)
					: null,
				output_modalities: m.output_modalities
					? JSON.parse(m.output_modalities)
					: null,
				supported_parameters: (meta?.supported_parameters as string[]) ?? null,
			};
		})
		.filter((entry): entry is NonNullable<typeof entry> => entry !== null);

	return c.json({ data });
});

function readCatalogChannelId(metadata: string | null): string | null {
	if (!metadata) return null;
	try {
		const value = JSON.parse(metadata) as { channelId?: unknown };
		return typeof value.channelId === "string" && value.channelId
			? value.channelId
			: null;
	} catch {
		return null;
	}
}
