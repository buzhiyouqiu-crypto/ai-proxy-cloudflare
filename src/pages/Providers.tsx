import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../auth";
import { CopyButton } from "../components/CopyButton";
import { ProviderChip } from "../components/ProviderLogo";
import { RefreshControl } from "../components/RefreshControl";
import { SearchBar } from "../components/SearchBar";
import {
	PriceRange,
	Sparkline,
	type SparklineData,
} from "../components/Sparkline";
import { Badge } from "../components/ui";
import { useAutoRefresh } from "../hooks/useAutoRefresh";
import { useFetch } from "../hooks/useFetch";
import type { ModelEntry } from "../types/model";
import type { ProviderMeta } from "../types/provider";
import { formatUSD } from "../utils/format";
import { aggregateProviders } from "../utils/providers";

const fmtMultiplier = (v: number) => `×${v.toFixed(2)}`;

interface AdminChannelSummary {
	id: string;
	name: string;
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
	if (channel.quota != null) return formatUSD(channel.quota);
	if (channel.balance?.remaining != null) {
		const unit = channel.balance.unit || channel.balance.currency || "";
		return `${channel.balance.remaining}${unit ? ` ${unit}` : ""}`;
	}
	return "待同步";
}

function CustomChannelPicker({
	channels,
}: {
	channels: AdminChannelSummary[];
}) {
	const enabledChannels = channels.filter((channel) => channel.isEnabled);
	const [selectedId, setSelectedId] = useState(enabledChannels[0]?.id ?? "");
	const selected =
		enabledChannels.find((channel) => channel.id === selectedId) ??
		enabledChannels[0];

	if (!selected) return null;

	return (
		<div
			className="flex min-w-0 flex-wrap items-center gap-1.5"
			onClick={(event) => event.stopPropagation()}
		>
			<select
				value={selected.id}
				onChange={(event) => setSelectedId(event.target.value)}
				aria-label="选择自定义渠道"
				className="max-w-48 rounded-md border border-gray-200 bg-white px-2 py-1 text-xs text-gray-700 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500/20 dark:border-white/10 dark:bg-white/5 dark:text-gray-300"
			>
				{enabledChannels.map((channel) => (
					<option key={channel.id} value={channel.id}>
						{channel.name} · 剩余 {formatChannelBalance(channel)}
					</option>
				))}
			</select>
			<span className="text-xs text-gray-500 dark:text-gray-400">
				剩余 {formatChannelBalance(selected)}
			</span>
		</div>
	);
}

export function Providers() {
	const { t } = useTranslation();
	const navigate = useNavigate();
	const { isAdmin } = useAuth();
	const {
		data: models,
		loading: modelsLoading,
		refetch: refetchModels,
	} = useFetch<ModelEntry[]>("/api/models", { requireAuth: false });
	const { data: providersData, loading: providersLoading } = useFetch<
		ProviderMeta[]
	>("/api/providers", { requireAuth: false });
	const { data: providerSparks, refetch: refetchSparks } = useFetch<
		Record<string, SparklineData>
	>("/api/sparklines/provider?sample=900000", { requireAuth: false });
	const { data: adminChannels } = useFetch<AdminChannelSummary[]>(
		"/api/admin/channels",
		{ skip: !isAdmin, staleTime: 0 },
	);

	const refetch = useCallback(() => {
		refetchModels();
		refetchSparks();
	}, [refetchModels, refetchSparks]);

	const lastUpdated = useAutoRefresh(refetch, models, 600_000);

	const groups = useMemo(
		() => aggregateProviders(models ?? [], providersData ?? []),
		[models, providersData],
	);

	const [query, setQuery] = useState("");

	const filtered = useMemo(() => {
		if (!query.trim()) return groups;
		const q = query.toLowerCase();
		return groups.filter(
			(g) =>
				g.provider.id.toLowerCase().includes(q) ||
				g.provider.name.toLowerCase().includes(q) ||
				(g.provider.id === "custom" &&
					isAdmin &&
					(adminChannels ?? []).some((channel) =>
						channel.name.toLowerCase().includes(q),
					)),
		);
	}, [adminChannels, groups, isAdmin, query]);

	const initialLoading =
		(!models || !providersData) && (modelsLoading || providersLoading);

	return (
		<div>
			<div className="sm:flex sm:items-center">
				<div className="sm:flex-auto">
					<h1 className="text-2xl font-bold text-gray-900 dark:text-white">
						{t("providers.title")}
					</h1>
					<p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
						{t("providers.subtitle")}
					</p>
				</div>
				<div className="mt-4 sm:mt-0 flex items-end gap-3">
					<RefreshControl
						loading={modelsLoading}
						lastUpdated={lastUpdated}
						onRefresh={refetch}
					/>
					{groups.length > 0 && (
						<SearchBar
							value={query}
							onChange={setQuery}
							placeholder={t("providers.search_placeholder")}
						/>
					)}
				</div>
			</div>

			{initialLoading ? (
				<div className="mt-5 rounded-xl border border-gray-200 bg-white dark:border-white/10 dark:bg-white/5 overflow-x-auto">
					<table className="min-w-full divide-y divide-gray-100 dark:divide-white/5">
						<thead>
							<tr className="text-left text-xs font-medium text-gray-400 dark:text-gray-500 whitespace-nowrap">
								<th className="py-2.5 pl-4 pr-2 sm:pl-5">
									{t("models.provider")}
								</th>
								<th className="px-2">ID</th>
								<th className="px-2 hidden md:table-cell">24h Chart</th>
								<th className="px-2 hidden md:table-cell">24h Range</th>
								<th className="px-2 text-right">Multiplier</th>
								<th className="py-2.5 pl-2 pr-4 sm:pr-5 text-right">
									{t("providers.models_count")}
								</th>
							</tr>
						</thead>
						<tbody className="divide-y divide-gray-50 dark:divide-white/[0.03]">
							{Array.from({ length: 6 }).map((_, i) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: static skeleton
								<tr key={i}>
									<td className="py-2.5 pl-4 pr-2 sm:pl-5">
										<div className="flex items-center gap-2">
											<div className="size-5 rounded-full bg-gray-200 dark:bg-white/10 animate-pulse" />
											<div className="h-4 w-24 rounded bg-gray-200 dark:bg-white/10 animate-pulse" />
										</div>
									</td>
									<td className="px-2 py-2.5">
										<div className="h-3.5 w-20 rounded bg-gray-100 dark:bg-white/5 animate-pulse" />
									</td>
									<td className="px-2 py-2.5 hidden md:table-cell">
										<div className="h-6 w-[clamp(120px,18vw,250px)] rounded bg-gray-100 dark:bg-white/5 animate-pulse" />
									</td>
									<td className="px-2 py-2.5 hidden md:table-cell">
										<div className="h-4 w-[clamp(120px,18vw,250px)] rounded bg-gray-100 dark:bg-white/5 animate-pulse" />
									</td>
									<td className="px-2 py-2.5 text-right">
										<div className="h-5 w-14 rounded bg-gray-100 dark:bg-white/5 animate-pulse ml-auto" />
									</td>
									<td className="py-2.5 pl-2 pr-4 sm:pr-5 text-right">
										<div className="h-5 w-7 rounded bg-gray-100 dark:bg-white/5 animate-pulse ml-auto" />
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			) : groups.length === 0 ? (
				<p className="mt-8 text-center text-sm text-gray-500 dark:text-gray-400">
					{t("providers.no_data")}
				</p>
			) : (
				<>
					<div className="mt-5 rounded-xl border border-gray-200 bg-white dark:border-white/10 dark:bg-white/5 overflow-x-auto">
						<table className="min-w-full divide-y divide-gray-100 dark:divide-white/5">
							<thead>
								<tr className="text-left text-xs font-medium text-gray-400 dark:text-gray-500 whitespace-nowrap">
									<th className="py-2.5 pl-4 pr-2 sm:pl-5">
										{t("models.provider")}
									</th>
									<th className="px-2">ID</th>
									<th className="px-2 hidden md:table-cell">24h Chart</th>
									<th className="px-2 hidden md:table-cell">24h Range</th>
									<th className="px-2 text-right">Multiplier</th>
									<th className="py-2.5 pl-2 pr-4 sm:pr-5 text-right">
										{t("providers.models_count")}
									</th>
								</tr>
							</thead>
							<tbody className="divide-y divide-gray-50 dark:divide-white/[0.03]">
								{filtered.map((g) => {
									const spark = providerSparks?.[g.provider.id];
									const href = `/providers/${g.provider.id}`;
									return (
										<tr
											key={g.provider.id}
											onClick={(e) => {
												if ((e.target as HTMLElement).closest("a, button, select"))
													return;
												navigate(href);
											}}
											className="even:bg-gray-50/50 hover:bg-gray-100/60 dark:even:bg-white/[0.015] dark:hover:bg-white/[0.04] transition-colors cursor-pointer"
										>
											<td className="py-2.5 pl-4 pr-2 sm:pl-5 whitespace-nowrap">
												<div className="flex flex-wrap items-center gap-2">
													<Link to={href}>
														<ProviderChip
															src={g.provider.logoUrl}
															name={g.provider.name}
															size={20}
														/>
													</Link>
													{g.provider.id === "custom" &&
														isAdmin &&
														adminChannels?.filter((channel) => channel.isEnabled)
															.length ? (
																<CustomChannelPicker channels={adminChannels} />
															) : null}
												</div>
											</td>
											<td className="px-2 py-2.5 whitespace-nowrap">
												<div className="flex items-center gap-1">
													<code className="text-xs font-mono text-gray-500 dark:text-gray-400">
														{g.provider.id}
													</code>
													<CopyButton text={g.provider.id} />
												</div>
											</td>
											<td className="px-2 py-2.5 hidden md:table-cell">
												{spark && (
													<div className="w-[clamp(120px,18vw,250px)]">
														<Sparkline data={spark} />
													</div>
												)}
											</td>
											<td className="px-2 py-2.5 hidden md:table-cell whitespace-nowrap">
												{spark && (
													<div className="w-[clamp(120px,18vw,250px)]">
														<PriceRange data={spark} format={fmtMultiplier} />
													</div>
												)}
											</td>
											<td className="px-2 py-2.5 text-right whitespace-nowrap">
												{g.bestMultiplier != null && g.bestMultiplier < 1 ? (
													<Badge variant="success">
														×{g.bestMultiplier.toFixed(3)}
													</Badge>
												) : (
													<span className="text-xs text-gray-400">—</span>
												)}
											</td>
											<td className="py-2.5 pl-2 pr-4 sm:pr-5 text-right whitespace-nowrap">
												<Badge variant="brand">{g.models.length}</Badge>
											</td>
										</tr>
									);
								})}
							</tbody>
						</table>
					</div>

					{query && (
						<p className="mt-3 text-xs text-gray-400 dark:text-gray-500">
							{t("providers.result_count", {
								count: filtered.length,
								total: groups.length,
							})}
						</p>
					)}
					{query && filtered.length === 0 && (
						<p className="mt-8 text-center text-sm text-gray-500 dark:text-gray-400">
							{t("providers.no_match", { query })}
						</p>
					)}
				</>
			)}
		</div>
	);
}
