import {
	ArrowDownIcon,
	ArrowsUpDownIcon,
	ArrowUpIcon,
	CheckCircleIcon,
	PlusIcon,
	TrashIcon,
} from "@heroicons/react/24/outline";
import { useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { useAuth } from "../auth";
import { useFetch } from "../hooks/useFetch";
import { Button, Card, Input } from "./ui";

interface RoutingRule {
	provider_key: string;
	priority: number;
	quota_limit: number | null;
	quota_used: number;
}

interface RoutingProvider {
	providerKey: string;
	name: string;
	credentialCount: number;
	rule: RoutingRule | null;
}

interface RoutingDetail {
	enabled: boolean;
	providers: RoutingProvider[];
}

interface DraftRule {
	providerKey: string;
	quotaLimit: string;
	quotaUsed: number;
}

export function ModelRoutingEditor({ modelId }: { modelId: string }) {
	const { getToken } = useAuth();
	const {
		data: detail,
		loading,
		refetch,
	} = useFetch<RoutingDetail>(
		`/api/admin/model-routing?modelId=${encodeURIComponent(modelId)}`,
		{ staleTime: 0 },
	);
	const [enabled, setEnabled] = useState(true);
	const [rules, setRules] = useState<DraftRule[]>([]);
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		if (!detail) return;
		setEnabled(detail.enabled);
		setRules(
			detail.providers
				.filter((provider) => provider.rule)
				.sort(
					(a, b) =>
						(a.rule?.priority ?? Number.MAX_SAFE_INTEGER) -
						(b.rule?.priority ?? Number.MAX_SAFE_INTEGER),
				)
				.map((provider) => ({
					providerKey: provider.providerKey,
					quotaLimit:
						provider.rule?.quota_limit == null
							? ""
							: String(provider.rule.quota_limit),
					quotaUsed: provider.rule?.quota_used ?? 0,
				})),
		);
	}, [detail]);

	const providerByKey = useMemo(
		() =>
			new Map(
				(detail?.providers ?? []).map((provider) => [
					provider.providerKey,
					provider,
				]),
			),
		[detail],
	);
	const availableProviders = (detail?.providers ?? []).filter(
		(provider) =>
			!rules.some((rule) => rule.providerKey === provider.providerKey),
	);

	const save = async () => {
		try {
			const payload = rules.map((rule, index) => {
				const value = rule.quotaLimit.trim();
				if (value && (!/^\d+$/.test(value) || Number(value) < 1)) {
					throw new Error(`第 ${index + 1} 个供应商的限额必须是正整数`);
				}
				return {
					providerKey: rule.providerKey,
					quotaLimit: value ? Number(value) : null,
				};
			});
			setSaving(true);
			const token = await getToken();
			const response = await fetch("/api/admin/model-routing", {
				method: "PUT",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${token}`,
				},
				body: JSON.stringify({ modelId, enabled, rules: payload }),
			});
			const body = await response.json().catch(() => ({}));
			if (!response.ok) {
				throw new Error(body?.error?.message || `HTTP ${response.status}`);
			}
			refetch();
			toast.success("模型路由策略已保存");
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "保存失败");
		} finally {
			setSaving(false);
		}
	};

	const move = (index: number, direction: -1 | 1) => {
		const target = index + direction;
		if (target < 0 || target >= rules.length) return;
		setRules((current) => {
			const next = [...current];
			[next[index], next[target]] = [next[target], next[index]];
			return next;
		});
	};

	if (loading && !detail) return null;

	return (
		<Card>
			<div className="flex flex-wrap items-start justify-between gap-4">
				<div>
					<div className="flex items-center gap-2">
						<ArrowsUpDownIcon className="size-5 text-brand-500" />
						<h2 className="font-semibold text-gray-900 dark:text-white">
							管理员路由策略
						</h2>
					</div>
					<p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
						按列表顺序调用供应商；图片请求按 n 占用次数，留空表示不限。
					</p>
				</div>
				<label className="inline-flex cursor-pointer items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
					<input
						type="checkbox"
						checked={enabled}
						onChange={(event) => setEnabled(event.target.checked)}
						className="size-4 rounded border-gray-300 text-brand-600 focus:ring-brand-500"
					/>
					启用自定义顺序
				</label>
			</div>

			<div className="mt-5 space-y-3">
				{rules.length === 0 && (
					<div className="rounded-lg border border-dashed border-gray-300 px-4 py-6 text-center text-sm text-gray-500 dark:border-white/15 dark:text-gray-400">
						尚未指定供应商，将继续使用默认价格路由。
					</div>
				)}
				{rules.map((rule, index) => {
					const provider = providerByKey.get(rule.providerKey);
					return (
						<div
							key={rule.providerKey}
							className="flex flex-wrap items-center gap-3 rounded-lg border border-gray-200 p-3 dark:border-white/10"
						>
							<div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-brand-50 text-sm font-semibold text-brand-700 dark:bg-brand-500/15 dark:text-brand-300">
								{index + 1}
							</div>
							<div className="min-w-44 flex-1">
								<div className="font-medium text-gray-900 dark:text-white">
									{provider?.name ?? rule.providerKey}
								</div>
								<div className="text-xs text-gray-500">
									{provider?.credentialCount ?? 0} 个启用凭证 ·{" "}
									{rule.providerKey}
								</div>
							</div>
							<div className="w-44 space-y-1 text-xs">
								<span className="text-gray-500">请求次数限额（留空不限）</span>
								<Input
									inputMode="numeric"
									min="1"
									value={rule.quotaLimit}
									placeholder="不限"
									onChange={(event) =>
										setRules((current) =>
											current.map((item, itemIndex) =>
												itemIndex === index
													? { ...item, quotaLimit: event.target.value }
													: item,
											),
										)
									}
								/>
								<span className="block text-gray-500">
									已使用 {rule.quotaUsed} 次
								</span>
							</div>
							<div className="flex items-center gap-1">
								<Button
									variant="ghost"
									size="sm"
									disabled={index === 0}
									onClick={() => move(index, -1)}
									aria-label="上移"
								>
									<ArrowUpIcon className="size-4" />
								</Button>
								<Button
									variant="ghost"
									size="sm"
									disabled={index === rules.length - 1}
									onClick={() => move(index, 1)}
									aria-label="下移"
								>
									<ArrowDownIcon className="size-4" />
								</Button>
								<Button
									variant="ghost"
									size="sm"
									onClick={() =>
										setRules((current) =>
											current.filter((_, itemIndex) => itemIndex !== index),
										)
									}
									aria-label="移除"
								>
									<TrashIcon className="size-4 text-red-500" />
								</Button>
							</div>
						</div>
					);
				})}
			</div>

			{availableProviders.length > 0 && (
				<div className="mt-5 border-t border-gray-100 pt-4 dark:border-white/10">
					<div className="mb-2 text-xs font-medium text-gray-500">
						可添加供应商
					</div>
					<div className="flex flex-wrap gap-2">
						{availableProviders.map((provider) => (
							<Button
								key={provider.providerKey}
								variant="secondary"
								size="sm"
								onClick={() =>
									setRules((current) => [
										...current,
										{
											providerKey: provider.providerKey,
											quotaLimit: "",
											quotaUsed: 0,
										},
									])
								}
							>
								<PlusIcon className="size-4" />
								{provider.name}
								<span className="text-xs text-gray-400">
									({provider.credentialCount} 个凭证)
								</span>
							</Button>
						))}
					</div>
				</div>
			)}

			<div className="mt-5 flex justify-end">
				<Button onClick={save} disabled={saving || loading}>
					<CheckCircleIcon className="size-5" />
					{saving ? "保存中…" : "保存路由策略"}
				</Button>
			</div>
		</Card>
	);
}
