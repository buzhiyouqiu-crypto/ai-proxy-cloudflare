import type {
	AdminChannelModelSummary,
	AdminChannelSummary,
} from "../components/CustomChannelDisclosure";
import type { ModelEntry } from "../types/model";
import type { ProviderMeta } from "../types/provider";

export const CUSTOM_PROVIDER_ID = "custom";
export const CUSTOM_CHANNEL_PREFIX = "custom:";
export const PUBLIC_CUSTOM_CHANNEL_PREFIX = "custom:public-";

const CUSTOM_CHANNEL_LOGO =
	"https://api.iconify.design/mdi:server-network.svg";

export function customChannelProviderId(channelId: string): string {
	return `${CUSTOM_CHANNEL_PREFIX}${channelId}`;
}

function publicCustomChannelSuffix(channelId: string): string {
	let hash = 2166136261;
	for (let i = 0; i < channelId.length; i++) {
		hash ^= channelId.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return String((hash >>> 0) % 1_000_000).padStart(6, "0");
}

function publicCustomChannelProviderId(channelId: string): string {
	return `${PUBLIC_CUSTOM_CHANNEL_PREFIX}${publicCustomChannelSuffix(channelId)}`;
}

function channelPublicProviderId(channel: AdminChannelSummary): string {
	return channel.publicProviderId || publicCustomChannelProviderId(channel.id);
}

function channelModelId(model: AdminChannelModelSummary): string {
	return model.catalogModelId || model.id;
}

function enabledChannels(
	channels: AdminChannelSummary[] | null | undefined,
): AdminChannelSummary[] | null {
	if (!channels) return null;
	return channels.filter((channel) => channel.isEnabled);
}

/** Replace public aliases with the real channel providers for the owner. */
export function expandCustomChannelProviders(
	providers: ProviderMeta[],
	channels: AdminChannelSummary[] | null | undefined,
	isAdmin: boolean,
): ProviderMeta[] {
	const visibleChannels = enabledChannels(channels);
	if (!isAdmin || !visibleChannels) return providers;

	const generic = providers.find((provider) => provider.id === CUSTOM_PROVIDER_ID);
	const publicProviderIds = new Set(
		visibleChannels.map((channel) => channelPublicProviderId(channel)),
	);
	const channelProviders = visibleChannels.map((channel) => ({
		...(generic ?? {
			supportsAutoCredits: false,
			authType: "api_key" as const,
			isSubscription: false,
			credentialGuide: { placeholder: "sk-..." },
		}),
		id: customChannelProviderId(channel.id),
		name: channel.name,
		logoUrl: generic?.logoUrl || CUSTOM_CHANNEL_LOGO,
	}));

	return [
		...providers.filter(
			(provider) =>
				provider.id !== CUSTOM_PROVIDER_ID &&
				!publicProviderIds.has(provider.id),
		),
		...channelProviders,
	];
}

/**
 * Expand custom model offerings so the model pages can show one provider row
 * per channel while retaining the canonical model metadata from `/api/models`.
 */
export function expandCustomChannelModels(
	entries: ModelEntry[],
	channels: AdminChannelSummary[] | null | undefined,
	isAdmin: boolean,
): ModelEntry[] {
	const visibleChannels = enabledChannels(channels);
	if (!isAdmin || !visibleChannels) return entries;

	const genericEntries = entries.filter(
		(entry) => entry.provider_id === CUSTOM_PROVIDER_ID,
	);
	const channelByPublicProviderId = new Map(
		visibleChannels.map((channel) => [channelPublicProviderId(channel), channel]),
	);
	const expanded: ModelEntry[] = [];

	for (const entry of entries) {
		if (entry.provider_id === CUSTOM_PROVIDER_ID) continue;
		const channel = channelByPublicProviderId.get(entry.provider_id);
		if (!channel) {
			expanded.push(entry);
			continue;
		}
		const model = channel.models.find(
			(item) => channelModelId(item) === entry.id,
		);
		const inputPrice = model?.inputPrice ?? entry.input_price;
		const outputPrice = model?.outputPrice ?? entry.output_price;
		const multiplier = channel.priceMultiplier ?? 1;
		expanded.push({
			...entry,
			provider_id: customChannelProviderId(channel.id),
			name:
				model?.catalogName ||
				model?.name ||
				entry.name ||
				entry.id,
			input_price: inputPrice,
			output_price: outputPrice,
			platform_input_price:
				multiplier < 1 ? inputPrice * multiplier : undefined,
			platform_output_price:
				multiplier < 1 ? outputPrice * multiplier : undefined,
			context_length: model?.contextLength ?? entry.context_length,
			type: model?.modelType ?? entry.type,
		});
	}

	for (const channel of visibleChannels) {
		for (const model of channel.models) {
			const id = channelModelId(model);
			const base = genericEntries.find((entry) => entry.id === id);
			if (!base) continue;
			const inputPrice = model.inputPrice ?? base.input_price;
			const outputPrice = model.outputPrice ?? base.output_price;
			const multiplier = channel.priceMultiplier ?? 1;

			expanded.push({
				...base,
				provider_id: customChannelProviderId(channel.id),
				name: model.catalogName || model.name || base.name || id,
				input_price: inputPrice,
				output_price: outputPrice,
				platform_input_price:
					multiplier < 1 ? inputPrice * multiplier : undefined,
				platform_output_price:
					multiplier < 1 ? outputPrice * multiplier : undefined,
				context_length: model.contextLength ?? base.context_length,
				type: model.modelType ?? base.type,
			});
		}
	}

	return expanded;
}
