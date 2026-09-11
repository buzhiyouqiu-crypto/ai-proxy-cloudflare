import type {
	AdminChannelModelSummary,
	AdminChannelSummary,
} from "../components/CustomChannelDisclosure";
import type { ModelEntry } from "../types/model";
import type { ProviderMeta } from "../types/provider";

export const CUSTOM_PROVIDER_ID = "custom";
export const CUSTOM_CHANNEL_PREFIX = "custom:";

const CUSTOM_CHANNEL_LOGO =
	"https://api.iconify.design/mdi:server-network.svg";

export function customChannelProviderId(channelId: string): string {
	return `${CUSTOM_CHANNEL_PREFIX}${channelId}`;
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

/**
 * Expand the generic public `custom` provider into owner-only channel providers.
 * Public pages keep the generic provider and therefore do not expose channel
 * names.
 */
export function expandCustomChannelProviders(
	providers: ProviderMeta[],
	channels: AdminChannelSummary[] | null | undefined,
	isAdmin: boolean,
): ProviderMeta[] {
	const visibleChannels = enabledChannels(channels);
	if (!isAdmin || !visibleChannels) return providers;

	const generic = providers.find((provider) => provider.id === CUSTOM_PROVIDER_ID);
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
		...providers.filter((provider) => provider.id !== CUSTOM_PROVIDER_ID),
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
	if (genericEntries.length === 0) return entries;

	const expanded: ModelEntry[] = entries.filter(
		(entry) => entry.provider_id !== CUSTOM_PROVIDER_ID,
	);

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
