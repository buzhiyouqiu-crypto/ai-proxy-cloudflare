import { CheckIcon, ClipboardDocumentIcon } from "@heroicons/react/20/solid";
import type React from "react";
import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { useTranslation } from "react-i18next";
import { useAuth } from "../auth";
import type { ApiKeyInfo } from "../types/api-key";
import { toastApiError } from "../utils/toast-error";
import { Modal } from "./Modal";
import { Button, Input } from "./ui";

interface GeneratedKey {
	name: string;
	plainKey: string;
}

interface Props {
	open: boolean;
	onClose: () => void;
	apiKey: ApiKeyInfo | null;
	onCreated: () => void;
}

type NameRule = "random" | "prefix_sequence";

export function CloneApiKeyModal({ open, onClose, apiKey, onCreated }: Props) {
	const { t } = useTranslation();
	const { getToken } = useAuth();
	const [nameRule, setNameRule] = useState<NameRule>("prefix_sequence");
	const [prefix, setPrefix] = useState("");
	const [startNumber, setStartNumber] = useState("1");
	const [count, setCount] = useState("1");
	const [generatedKeys, setGeneratedKeys] = useState<GeneratedKey[] | null>(
		null,
	);
	const [submitting, setSubmitting] = useState(false);
	const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

	useEffect(() => {
		if (open && apiKey) {
			setNameRule("prefix_sequence");
			setPrefix(`${apiKey.name}-`);
			setStartNumber("1");
			setCount("1");
			setGeneratedKeys(null);
			setCopiedIndex(null);
		}
	}, [open, apiKey]);

	const handleClose = () => {
		onClose();
		setTimeout(() => {
			setGeneratedKeys(null);
			setSubmitting(false);
			setCopiedIndex(null);
		}, 200);
	};

	const handleSubmit = async (event: React.FormEvent) => {
		event.preventDefault();
		if (!apiKey) return;

		const countValue = Number(count);
		const startValue = startNumber.trim() ? Number(startNumber) : 1;
		if (!Number.isInteger(countValue) || countValue < 1 || countValue > 50) {
			toast.error(t("api_keys.clone_count_error"));
			return;
		}
		if (nameRule === "prefix_sequence" && !prefix.trim()) {
			toast.error(t("api_keys.clone_prefix_required"));
			return;
		}

		setSubmitting(true);
		const tid = toast.loading(t("common.loading"));
		try {
			const res = await fetch(`/api/api-keys/${apiKey.id}/clone`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${await getToken()}`,
				},
				body: JSON.stringify({
					count: countValue,
					nameRule,
					prefix: prefix.trim(),
					startNumber: Number.isInteger(startValue) ? startValue : 1,
				}),
			});
			const result = await res.json().catch(() => null);
			if (!res.ok) {
				toastApiError(result, t, tid);
				return;
			}

			const keys = result?.data?.keys as GeneratedKey[] | undefined;
			if (!keys?.length) {
				toast.error(t("common.error"), { id: tid });
				return;
			}
			setGeneratedKeys(keys);
			onCreated();
			toast.success(t("api_keys.clone_success", { count: keys.length }), {
				id: tid,
			});
		} catch (error) {
			console.error(error);
			toast.error(t("common.error"), { id: tid });
		} finally {
			setSubmitting(false);
		}
	};

	const copyKey = async (key: string, index?: number) => {
		try {
			await navigator.clipboard.writeText(key);
			if (index !== undefined) {
				setCopiedIndex(index);
				setTimeout(() => setCopiedIndex(null), 1500);
			}
			toast.success(t("api_keys.copied"));
		} catch {
			toast.error(t("common.error"));
		}
	};

	if (!apiKey) return null;

	const labelCls = "block text-sm font-medium text-gray-700 dark:text-gray-300";
	const isResult = generatedKeys !== null;

	return (
		<Modal
			open={open}
			onClose={handleClose}
			title={
				isResult ? t("api_keys.clone_result_title") : t("api_keys.clone_title")
			}
			size="lg"
		>
			{isResult ? (
				<div className="space-y-4">
					<div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-200">
						⚠️ {t("api_keys.clone_copy_warning")}
					</div>
					<div className="space-y-2">
						{generatedKeys.map((key, index) => (
							<div
								key={key.plainKey}
								className="rounded-lg border border-gray-200 p-3 dark:border-white/10"
							>
								<div className="mb-1 text-xs font-medium text-gray-500 dark:text-gray-400">
									{key.name}
								</div>
								<div className="flex items-center gap-2">
									<code className="min-w-0 flex-1 break-all text-xs text-gray-800 dark:text-gray-200">
										{key.plainKey}
									</code>
									<button
										type="button"
										onClick={() => copyKey(key.plainKey, index)}
										className="shrink-0 rounded-lg bg-brand-500 px-2.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-brand-600"
									>
										{copiedIndex === index ? (
											<span className="flex items-center gap-1">
												<CheckIcon className="size-3.5" />
												{t("api_keys.copied")}
											</span>
										) : (
											<span className="flex items-center gap-1">
												<ClipboardDocumentIcon className="size-3.5" />
												{t("common.copy")}
											</span>
										)}
									</button>
								</div>
							</div>
						))}
					</div>
					<div className="flex justify-end gap-3">
						<Button
							variant="secondary"
							onClick={() =>
								copyKey(
									generatedKeys
										.map((key) => `${key.name}\t${key.plainKey}`)
										.join("\n"),
								)
							}
						>
							<ClipboardDocumentIcon className="size-4" />
							{t("api_keys.clone_copy_all")}
						</Button>
						<Button onClick={handleClose}>{t("common.confirm")}</Button>
					</div>
				</div>
			) : (
				<form onSubmit={handleSubmit} className="space-y-5">
					<p className="text-sm text-gray-500 dark:text-gray-400">
						{t("api_keys.clone_description", { name: apiKey.name })}
					</p>

					<div>
						<span className={labelCls}>{t("api_keys.clone_name_rule")}</span>
						<div className="mt-2 grid gap-2 sm:grid-cols-2">
							{(
								[
									["prefix_sequence", t("api_keys.clone_prefix_sequence")],
									["random", t("api_keys.clone_random")],
								] as const
							).map(([value, label]) => (
								<button
									key={value}
									type="button"
									onClick={() => setNameRule(value)}
									className={`rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
										nameRule === value
											? "border-brand-500 bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300"
											: "border-gray-200 text-gray-600 hover:bg-gray-50 dark:border-white/10 dark:text-gray-400 dark:hover:bg-white/5"
									}`}
								>
									{label}
								</button>
							))}
						</div>
					</div>

					{nameRule === "prefix_sequence" && (
						<div className="grid gap-4 sm:grid-cols-2">
							<div>
								<label htmlFor="clone-key-prefix" className={labelCls}>
									{t("api_keys.clone_prefix")}
								</label>
								<Input
									id="clone-key-prefix"
									value={prefix}
									onChange={(event) => setPrefix(event.target.value)}
									className="mt-1"
									placeholder={t("api_keys.clone_prefix_placeholder")}
								/>
							</div>
							<div>
								<label htmlFor="clone-key-start" className={labelCls}>
									{t("api_keys.clone_start_number")}
								</label>
								<Input
									type="number"
									id="clone-key-start"
									value={startNumber}
									onChange={(event) => setStartNumber(event.target.value)}
									className="mt-1"
									min="0"
								/>
							</div>
						</div>
					)}

					<div>
						<label htmlFor="clone-key-count" className={labelCls}>
							{t("api_keys.clone_count")}
						</label>
						<Input
							type="number"
							id="clone-key-count"
							value={count}
							onChange={(event) => setCount(event.target.value)}
							className="mt-1"
							min="1"
							max="50"
						/>
						<p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
							{t("api_keys.clone_count_hint")}
						</p>
					</div>

					<div className="flex justify-end gap-3">
						<Button variant="secondary" onClick={handleClose}>
							{t("common.cancel")}
						</Button>
						<Button type="submit" disabled={submitting}>
							{submitting ? t("common.loading") : t("api_keys.clone_submit")}
						</Button>
					</div>
				</form>
			)}
		</Modal>
	);
}
