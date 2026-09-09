import {
	ArrowPathIcon,
	PencilSquareIcon,
	PlusIcon,
	PowerIcon,
	TrashIcon,
} from "@heroicons/react/24/outline";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import toast from "react-hot-toast";
import { useAuth } from "../../auth";
import {
	ModelCatalogSelect,
	type ModelCatalogOption,
} from "../../components/ModelCatalogSelect";
import { Button, Card, Input } from "../../components/ui";
import { useFetch } from "../../hooks/useFetch";

interface ChannelModel {
	id: string;
	catalogModelId?: string | null;
	catalogName?: string | null;
	name?: string | null;
	inputPrice: number;
	outputPrice: number;
	contextLength?: number | null;
	modelType?: "chat" | "embedding";
}

interface Channel {
	id: string;
	name: string;
	baseUrl: string;
	websiteUrl?: string | null;
	models: ChannelModel[];
	defaultInputPrice: number;
	defaultOutputPrice: number;
	extractorCode: string;
	hasExtractor: boolean;
	secretHint: string;
	quota: number | null;
	balance: {
		remaining: number | null;
		usage: number | null;
		currency?: "USD" | "CNY";
		unit?: string;
		display?: string;
		updatedAt: number;
	} | null;
	isEnabled: boolean;
	priceMultiplier: number;
	health: string;
	addedAt: number;
}

const createInitialForm = () => ({
	name: "",
	baseUrl: "",
	websiteUrl: "",
	secret: "",
	defaultInputPrice: "0",
	defaultOutputPrice: "0",
	models: [] as ChannelModel[],
	priceMultiplier: "1",
	extractorCode: `({
  request: {
    url: "https://example.com/v1/credits",
    method: "GET",
    headers: {
      Authorization: "Bearer {{API_KEY}}"
    }
  },
  extractor: function(response) {
    return {
      remaining: response.data.balance,
      unit: "USD"
    };
  }
})`,
});

export function Channels() {
	const { t } = useTranslation();
	const { getToken } = useAuth();
	const { data: channels, loading, refetch } = useFetch<Channel[]>(
		"/api/admin/channels",
		{ staleTime: 0 },
	);
	const { data: catalogModels } = useFetch<ModelCatalogOption[]>(
		"/api/admin/channels/catalog-models",
		{ staleTime: 0 },
	);
	const [form, setForm] = useState(createInitialForm);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [discovering, setDiscovering] = useState(false);
	const [testingExtractor, setTestingExtractor] = useState(false);
	const [refreshingId, setRefreshingId] = useState<string | null>(null);

	const request = async (url: string, init?: RequestInit) => {
		const token = await getToken();
		const response = await fetch(url, {
			...init,
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
				...init?.headers,
			},
		});
		const body = await response.json().catch(() => ({}));
		if (!response.ok) {
			throw new Error(body?.error?.message || `HTTP ${response.status}`);
		}
		return body;
	};

	const resetForm = () => {
		setEditingId(null);
		setForm(createInitialForm());
	};

	const editChannel = (channel: Channel) => {
		setEditingId(channel.id);
		setForm({
			name: channel.name,
			baseUrl: channel.baseUrl,
			websiteUrl: channel.websiteUrl ?? "",
			secret: "",
			defaultInputPrice: String(channel.defaultInputPrice),
			defaultOutputPrice: String(channel.defaultOutputPrice),
			models: channel.models.map((model) => ({ ...model })),
			priceMultiplier: String(channel.priceMultiplier),
			extractorCode: channel.extractorCode || "",
		});
		window.scrollTo({ top: 0, behavior: "smooth" });
	};

	const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		setSaving(true);
		try {
			if (form.models.length === 0) throw new Error("请至少添加一个模型");
			if (!editingId && !form.secret.trim()) {
				throw new Error("请填写上游 API Key");
			}
			const models = form.models.map((model, index) => {
				if (!model.id.trim()) {
					throw new Error(`第 ${index + 1} 个模型缺少上游模型 ID`);
				}
				if (model.inputPrice < 0 || model.outputPrice < 0) {
					throw new Error(`第 ${index + 1} 个模型价格不能为负数`);
				}
				return {
					...model,
					id: model.id.trim(),
					catalogModelId: model.catalogModelId?.trim() || null,
					catalogName: model.catalogModelId ? model.catalogName ?? null : null,
					name: model.name?.trim() || model.id.trim(),
				};
			});
			const payload: Record<string, unknown> = {
				name: form.name,
				baseUrl: form.baseUrl,
				websiteUrl: form.websiteUrl || null,
				models,
				defaultInputPrice: Number(form.defaultInputPrice) || 0,
				defaultOutputPrice: Number(form.defaultOutputPrice) || 0,
				extractorCode: form.extractorCode.trim() || null,
				priceMultiplier: Number(form.priceMultiplier) || 1,
			};
			if (form.secret.trim()) payload.secret = form.secret.trim();
			await request(editingId ? `/api/admin/channels/${editingId}` : "/api/admin/channels", {
				method: editingId ? "PATCH" : "POST",
				body: JSON.stringify(payload),
			});
			const wasEditing = Boolean(editingId);
			resetForm();
			refetch();
			toast.success(wasEditing ? "渠道已更新" : "渠道已添加");
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "添加渠道失败");
		} finally {
			setSaving(false);
		}
	};

	const discoverModels = async () => {
		if (!form.baseUrl || (!form.secret && !editingId)) {
			toast.error("请先填写 Base URL 和上游 API Key");
			return;
		}
		setDiscovering(true);
		try {
			const body = await request("/api/admin/channels/discover-models", {
				method: "POST",
				body: JSON.stringify({
					baseUrl: form.baseUrl,
					secret: form.secret || undefined,
					channelId: editingId || undefined,
					inputPrice: Number(form.defaultInputPrice) || 0,
					outputPrice: Number(form.defaultOutputPrice) || 0,
				}),
			});
			const models = (body.data as ChannelModel[]) ?? [];
			if (!models.length) throw new Error("上游没有返回可用模型");
			setForm((current) => {
				const merged = new Map(current.models.map((model) => [model.id, model]));
				for (const model of models) {
					const existing = merged.get(model.id);
					merged.set(model.id, {
						...model,
						...existing,
						catalogModelId: existing?.catalogModelId ?? null,
					});
				}
				return { ...current, models: [...merged.values()] };
			});
			toast.success(`已获取 ${models.length} 个模型`);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "获取模型失败");
		} finally {
			setDiscovering(false);
		}
	};

	const addManualModel = () => {
		setForm((current) => ({
			...current,
			models: [
				...current.models,
				{
					id: "",
					name: "",
					inputPrice: Number(current.defaultInputPrice) || 0,
					outputPrice: Number(current.defaultOutputPrice) || 0,
					catalogModelId: null,
					catalogName: null,
					modelType: "chat",
				},
			],
		}));
	};

	const updateModel = (index: number, patch: Partial<ChannelModel>) => {
		setForm((current) => ({
			...current,
			models: current.models.map((model, modelIndex) =>
				modelIndex === index ? { ...model, ...patch } : model,
			),
		}));
	};

	const removeModel = (index: number) => {
		setForm((current) => ({
			...current,
			models: current.models.filter((_, modelIndex) => modelIndex !== index),
		}));
	};

	const testExtractor = async () => {
		if (!form.secret.trim() && !editingId) {
			toast.error("请先填写上游 API Key");
			return;
		}
		if (!form.extractorCode.trim()) {
			toast.error("请先填写余额提取器代码");
			return;
		}
		setTestingExtractor(true);
		try {
			const body = await request(
				editingId
					? `/api/admin/channels/${editingId}/test-extractor`
					: "/api/admin/channels/test-extractor",
				{
				method: "POST",
				body: JSON.stringify(
					editingId
						? { extractorCode: form.extractorCode }
						: { secret: form.secret, extractorCode: form.extractorCode },
				),
				},
			);
			const result = body.data as {
				display?: string;
				remaining?: number | null;
				currency?: string;
				unit?: string;
			};
			const display =
				result.display ??
				(result.remaining == null
					? "已返回结果"
					: `${result.remaining} ${result.currency ?? result.unit ?? ""}`);
			toast.success(`提取成功：${display}`);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "提取器测试失败");
		} finally {
			setTestingExtractor(false);
		}
	};

	const updateChannel = async (channel: Channel) => {
		try {
			await request(`/api/admin/channels/${channel.id}`, {
				method: "PATCH",
				body: JSON.stringify({ isEnabled: !channel.isEnabled }),
			});
			refetch();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "更新渠道失败");
		}
	};

	const deleteChannel = async (channel: Channel) => {
		if (!window.confirm(`确定删除渠道“${channel.name}”吗？`)) return;
		try {
			await request(`/api/admin/channels/${channel.id}`, { method: "DELETE" });
			refetch();
			toast.success("渠道已删除");
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "删除渠道失败");
		}
	};

	const refreshBalance = async (channel: Channel) => {
		setRefreshingId(channel.id);
		try {
			await request(`/api/admin/channels/${channel.id}/refresh-balance`, { method: "POST" });
			refetch();
			toast.success("余额已刷新");
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "余额刷新失败");
		} finally {
			setRefreshingId(null);
		}
	};

	return (
		<div className="space-y-8">
			<div>
				<h1 className="text-xl font-semibold text-gray-900 dark:text-white">
					{t("admin.channels", "上游渠道")}
				</h1>
				<p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
					管理员在这里配置中转站的上游 Base URL、API Key 和模型价格。
				</p>
			</div>

			<Card>
				<div className="mb-5 flex items-center gap-2">
					{editingId ? (
						<PencilSquareIcon className="size-5 text-brand-500" />
					) : (
						<PlusIcon className="size-5 text-brand-500" />
					)}
					<h2 className="font-semibold text-gray-900 dark:text-white">
						{editingId ? "编辑 OpenAI 兼容渠道" : "添加 OpenAI 兼容渠道"}
					</h2>
				</div>
				<form onSubmit={handleSubmit} className="space-y-4">
					<div className="grid gap-4 sm:grid-cols-2">
						<label className="space-y-1 text-sm">
							<span className="font-medium text-gray-700 dark:text-gray-300">渠道名称</span>
							<Input
								required
								value={form.name}
								placeholder="例如：OpenRouter 主渠道"
								onChange={(e) => setForm({ ...form, name: e.target.value })}
							/>
						</label>
						<label className="space-y-1 text-sm">
							<span className="font-medium text-gray-700 dark:text-gray-300">Base URL</span>
							<Input
								required
								type="url"
								value={form.baseUrl}
								placeholder="https://example.com/v1"
								onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
							/>
						</label>
						<label className="space-y-1 text-sm">
							<span className="font-medium text-gray-700 dark:text-gray-300">渠道官网（可选）</span>
							<Input
								type="url"
								value={form.websiteUrl}
								placeholder="https://example.com"
								onChange={(e) => setForm({ ...form, websiteUrl: e.target.value })}
							/>
						</label>
					</div>

					<label className="block space-y-1 text-sm">
						<span className="font-medium text-gray-700 dark:text-gray-300">上游 API Key</span>
						<Input
							required={!editingId}
							type="password"
							value={form.secret}
							placeholder={editingId ? "留空表示保留当前 Key" : "不会显示给普通用户"}
							onChange={(e) => setForm({ ...form, secret: e.target.value })}
						/>
					</label>

					<div className="grid gap-4 sm:grid-cols-2">
						<label className="space-y-1 text-sm">
							<span className="font-medium text-gray-700 dark:text-gray-300">默认输入价格（USD / 1M）</span>
							<Input
								type="number"
								min="0"
								step="0.000001"
								value={form.defaultInputPrice}
								onChange={(e) => setForm({ ...form, defaultInputPrice: e.target.value })}
							/>
						</label>
						<label className="space-y-1 text-sm">
							<span className="font-medium text-gray-700 dark:text-gray-300">默认输出价格（USD / 1M）</span>
							<Input
								type="number"
								min="0"
								step="0.000001"
								value={form.defaultOutputPrice}
								onChange={(e) => setForm({ ...form, defaultOutputPrice: e.target.value })}
							/>
						</label>
					</div>

					<div className="space-y-3">
						<div className="flex flex-wrap items-center justify-between gap-3">
							<div>
								<span className="font-medium text-gray-700 dark:text-gray-300">
									模型配置
								</span>
								<p className="text-xs text-gray-500">
									先点击“获取模型”，再为每个上游模型选择要展示的已有规范模型；不选择则保留原始 ID。
								</p>
							</div>
							<div className="flex gap-2">
								<Button type="button" variant="secondary" onClick={addManualModel}>
									手动添加
								</Button>
								<Button type="button" variant="secondary" onClick={discoverModels} disabled={discovering}>
									{discovering ? "获取中…" : "获取模型"}
								</Button>
							</div>
						</div>
						{form.models.length === 0 ? (
							<div className="rounded-lg border border-dashed border-gray-300 px-4 py-6 text-center text-sm text-gray-500 dark:border-white/10">
								还没有模型；可以自动获取，或手动添加。
							</div>
						) : (
							<div className="space-y-3">
								{form.models.map((model, index) => (
									<div key={`${model.id}-${index}`} className="rounded-lg border border-gray-200 p-3 dark:border-white/10">
										<div className="grid gap-3 lg:grid-cols-5">
											<label className="space-y-1 text-xs lg:col-span-2">
												<span className="font-medium text-gray-700 dark:text-gray-300">上游模型 ID</span>
												<Input
													value={model.id}
													placeholder="gpt-5.6-luna"
													onChange={(e) => updateModel(index, { id: e.target.value })}
												/>
											</label>
												<label className="space-y-1 text-xs lg:col-span-2">
													<span className="font-medium text-gray-700 dark:text-gray-300">规范模型（可选）</span>
													<ModelCatalogSelect
														options={catalogModels ?? []}
														value={model.catalogModelId}
														onChange={(option) => {
															const value = option?.id ?? null;
															updateModel(index, {
																catalogModelId: value,
																catalogName: option?.name ?? null,
																...(option
																	? {
																		inputPrice: option.inputPrice,
																		outputPrice: option.outputPrice,
																		contextLength: option.contextLength,
																		modelType: option.modelType,
																		name: option.name || model.name || model.id,
																	}
																	: {
																		name:
																			model.name === model.catalogName ? model.id : model.name,
																	}),
															});
														}}
													/>
												</label>
											<label className="space-y-1 text-xs">
												<span className="font-medium text-gray-700 dark:text-gray-300">输入价 / 1M</span>
												<Input type="number" min="0" step="0.000001" value={model.inputPrice} onChange={(e) => updateModel(index, { inputPrice: Number(e.target.value) || 0 })} />
											</label>
											<label className="space-y-1 text-xs">
												<span className="font-medium text-gray-700 dark:text-gray-300">输出价 / 1M</span>
												<Input type="number" min="0" step="0.000001" value={model.outputPrice} onChange={(e) => updateModel(index, { outputPrice: Number(e.target.value) || 0 })} />
											</label>
										</div>
										<div className="mt-3 flex items-end gap-3">
											<label className="min-w-0 flex-1 space-y-1 text-xs">
												<span className="font-medium text-gray-700 dark:text-gray-300">显示名称</span>
												<Input value={model.name ?? ""} onChange={(e) => updateModel(index, { name: e.target.value })} />
											</label>
											<Button type="button" variant="destructive" size="sm" onClick={() => removeModel(index)}>
												删除
											</Button>
										</div>
									</div>
								))}
							</div>
						)}
					</div>

					<label className="block space-y-1 text-sm">
						<div className="flex flex-wrap items-center justify-between gap-2">
							<span className="font-medium text-gray-700 dark:text-gray-300">余额提取器代码（管理员可见）</span>
							<Button type="button" variant="secondary" size="sm" onClick={testExtractor} disabled={testingExtractor}>
								{testingExtractor ? "测试中…" : "测试提取器"}
							</Button>
						</div>
						<textarea
							rows={11}
							value={form.extractorCode}
							onChange={(e) => setForm({ ...form, extractorCode: e.target.value })}
							className="block w-full rounded-lg border border-gray-200 bg-white px-3.5 py-2 font-mono text-xs text-gray-900 placeholder:text-gray-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20 dark:border-white/10 dark:bg-white/5 dark:text-white"
						/>
						<span className="text-xs text-gray-500">
							测试只请求上游并解析结果，不会保存渠道；支持 request.url/method/headers、response 字段路径、变量和简单加减乘除。用 {"{{API_KEY}}"} 代表上游 Key；返回 unit 为 USD/CNY 时按金额处理，返回 display/extra 或百分比 unit 时按配额文本展示。
						</span>
					</label>

					<div className="flex items-end gap-4">
						<label className="w-40 space-y-1 text-sm">
							<span className="font-medium text-gray-700 dark:text-gray-300">价格乘数</span>
							<Input
								type="number"
								min="0.01"
								max="10"
								step="0.01"
								value={form.priceMultiplier}
								onChange={(e) => setForm({ ...form, priceMultiplier: e.target.value })}
							/>
						</label>
						{editingId && (
							<Button type="button" variant="secondary" onClick={resetForm}>
								取消编辑
							</Button>
						)}
						<Button type="submit" disabled={saving}>
							{saving ? "保存中…" : editingId ? "保存修改" : "添加渠道"}
						</Button>
					</div>
				</form>
			</Card>

			<Card>
				<h2 className="font-semibold text-gray-900 dark:text-white">已配置渠道</h2>
				{loading ? (
					<p className="mt-4 text-sm text-gray-500">加载中…</p>
				) : !channels?.length ? (
					<p className="mt-4 text-sm text-gray-500">暂无自定义渠道</p>
				) : (
					<div className="mt-4 space-y-3">
						{channels.map((channel) => (
							<div
								key={channel.id}
								className="flex flex-col gap-3 rounded-lg border border-gray-200 p-4 dark:border-white/10 sm:flex-row sm:items-center sm:justify-between"
							>
								<div className="min-w-0">
									<div className="flex items-center gap-2">
										<span className="font-medium text-gray-900 dark:text-white">{channel.name}</span>
										<span className={`rounded-full px-2 py-0.5 text-xs ${channel.isEnabled ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"}`}>
											{channel.isEnabled ? "已启用" : "已停用"}
										</span>
									</div>
									<div className="mt-1 truncate text-xs text-gray-500">{channel.baseUrl}</div>
									<div className="mt-1 text-xs text-gray-500">
										{channel.models.length} 个模型 · Key {channel.secretHint} · ×{channel.priceMultiplier}
									</div>
									<div className="mt-1 text-xs text-gray-500">
										{channel.hasExtractor
											? channel.balance?.display
												? `剩余配额：${channel.balance.display}`
												: `自动余额：${channel.quota == null ? "待同步" : `$${channel.quota.toFixed(4)}`}`
											: "手动价格/无余额同步"}
									</div>
								</div>
								<div className="flex shrink-0 gap-2">
									<Button variant="secondary" size="sm" onClick={() => editChannel(channel)}>
										<PencilSquareIcon className="size-4" />
										编辑
									</Button>
									{channel.hasExtractor && (
										<Button variant="secondary" size="sm" onClick={() => refreshBalance(channel)} disabled={refreshingId === channel.id}>
											<ArrowPathIcon className={`size-4 ${refreshingId === channel.id ? "animate-spin" : ""}`} />
											刷新余额
										</Button>
									)}
									<Button variant="secondary" size="sm" onClick={() => updateChannel(channel)}>
										<PowerIcon className="size-4" />
										{channel.isEnabled ? "停用" : "启用"}
									</Button>
									<Button variant="destructive" size="sm" onClick={() => deleteChannel(channel)}>
										<TrashIcon className="size-4" />
										删除
									</Button>
								</div>
							</div>
						))}
					</div>
				)}
			</Card>

			<p className="text-sm text-gray-500 dark:text-gray-400">
				预置服务商（OpenRouter、DeepSeek、OpenAI 等）仍可在“自有密钥”页面添加；本页适合 ultrarouter、OneAPI 或其他 OpenAI 兼容中转地址。
			</p>
		</div>
	);
}
