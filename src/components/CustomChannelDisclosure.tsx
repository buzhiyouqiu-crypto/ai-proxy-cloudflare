import { ChevronDownIcon } from "@heroicons/react/24/outline";
import { useMemo, useState } from "react";
import { formatUSD } from "../utils/format";

export interface AdminChannelSummary {
	id: string;
	name: string;
	models: Array<{
		id: string;
		catalogModelId?: string | null;
	}>;
	quota: number | null;
	balance: {
		remaining: number | null;
		currency?: string;
		unit?: string;
		display?: string;
	} | null;
	isEnabled: boolean;
}

function formatChannelBalance(channel: AdminChannelSummary): string {
	if (channel.balance?.display) return channel.balance.display;
	if (channel.balance?.remaining != null) {
		const unit = channel.balance.unit || channel.balance.currency || "";
		return `${channel.balance.remaining}${unit ? ` ${unit}` : ""}`;
	}
	if (channel.quota != null) return formatUSD(channel.quota);
	return "待同步";
}

function channelOffersModel(channel: AdminChannelSummary, modelId: string) {
	return channel.models.some(
		(model) => (model.catalogModelId || model.id) === modelId,
	);
}

export function CustomChannelDisclosure({
	channels,
	modelId,
}: {
	channels: AdminChannelSummary[];
	modelId?: string;
}) {
	const [expanded, setExpanded] = useState(false);
	const enabledChannels = useMemo(
		() => channels.filter((channel) => channel.isEnabled),
		[channels],
	);
	const visibleChannels = useMemo(() => {
		if (!modelId) return enabledChannels;
		const matches = enabledChannels.filter((channel) =>
			channelOffersModel(channel, modelId),
		);
		return matches.length > 0 ? matches : enabledChannels;
	}, [enabledChannels, modelId]);

	if (visibleChannels.length === 0) return null;

	return (
		<div className="custom-channel-disclosure relative inline-flex min-w-0 flex-wrap items-center gap-1.5">
			<button
				type="button"
				aria-expanded={expanded}
				aria-label={expanded ? "收起自定义渠道" : "展开自定义渠道"}
				onClick={() => setExpanded((value) => !value)}
				className="inline-flex items-center rounded-md p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-white/10 dark:hover:text-gray-200"
			>
				<ChevronDownIcon
					className={`size-4 transition-transform ${expanded ? "rotate-180" : ""}`}
				/>
			</button>
			{expanded && (
				<div className="basis-full rounded-lg border border-gray-200 bg-white p-2 shadow-sm dark:border-white/10 dark:bg-gray-900">
					<div className="space-y-1">
						{visibleChannels.map((channel) => (
							<div
								key={channel.id}
								className="flex min-w-52 items-center justify-between gap-4 rounded-md px-2 py-1.5 text-xs"
							>
								<span className="min-w-0 truncate text-gray-700 dark:text-gray-200">
									{channel.name}
								</span>
								<span className="shrink-0 text-gray-500 dark:text-gray-400">
									剩余 {formatChannelBalance(channel)}
								</span>
							</div>
						))}
					</div>
				</div>
			)}
		</div>
	);
}
