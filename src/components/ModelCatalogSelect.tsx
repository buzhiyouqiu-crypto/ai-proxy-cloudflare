import {
	CheckIcon,
	ChevronUpDownIcon,
	MagnifyingGlassIcon,
	XMarkIcon,
} from "@heroicons/react/20/solid";
import { useEffect, useMemo, useRef, useState } from "react";

export interface ModelCatalogOption {
	id: string;
	name: string | null;
	providerId: string;
	modelType: "chat" | "embedding";
	inputPrice: number;
	outputPrice: number;
	contextLength: number | null;
}

interface Props {
	options: ModelCatalogOption[];
	value?: string | null;
	onChange: (option: ModelCatalogOption | null) => void;
}

const formatPrice = (value: number) =>
	Number.isFinite(value) && value >= 0 ? `$${value}/1M` : "价格未知";

/** Single-select version of the project's searchable model selector. */
export function ModelCatalogSelect({ options, value, onChange }: Props) {
	const [open, setOpen] = useState(false);
	const [search, setSearch] = useState("");
	const containerRef = useRef<HTMLDivElement>(null);
	const searchRef = useRef<HTMLInputElement>(null);
	const selected = options.find((option) => option.id === value);

	useEffect(() => {
		if (open) searchRef.current?.focus();
	}, [open]);

	useEffect(() => {
		const handler = (event: MouseEvent) => {
			if (
				containerRef.current &&
				!containerRef.current.contains(event.target as Node)
			) {
				setOpen(false);
			}
		};
		document.addEventListener("mousedown", handler);
		return () => document.removeEventListener("mousedown", handler);
	}, []);

	const filtered = useMemo(() => {
		const query = search.trim().toLowerCase();
		if (!query) return options;
		return options.filter((option) =>
			`${option.id} ${option.name ?? ""} ${option.providerId}`
				.toLowerCase()
				.includes(query),
		);
	}, [options, search]);

	const choose = (option: ModelCatalogOption | null) => {
		onChange(option);
		setSearch("");
		setOpen(false);
	};

	return (
		<div ref={containerRef} className="relative">
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen((current) => !current)}
				className="flex min-h-10 w-full items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-left text-sm transition-colors hover:border-gray-300 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20 dark:border-white/10 dark:bg-white/5 dark:hover:border-white/20 dark:focus:border-brand-400"
			>
				{selected ? (
					<span className="min-w-0 flex-1 truncate text-gray-900 dark:text-white">
						{selected.name ? `${selected.name} · ${selected.id}` : selected.id}
					</span>
				) : (
					<span className="flex-1 truncate text-gray-500 dark:text-gray-400">
						不映射，使用原始 ID
					</span>
				)}
				<ChevronUpDownIcon className="size-4 shrink-0 text-gray-400" />
			</button>

			{open && (
				<div className="absolute z-50 mt-1 w-full min-w-[22rem] rounded-lg border border-gray-200 bg-white shadow-lg dark:border-white/10 dark:bg-gray-900">
					<div className="flex items-center gap-2 border-b border-gray-100 px-3 py-2 dark:border-white/5">
						<MagnifyingGlassIcon className="size-4 shrink-0 text-gray-400" />
						<input
							ref={searchRef}
							value={search}
							onChange={(event) => setSearch(event.target.value)}
							placeholder="搜索模型名称、ID或供应商"
							className="w-full bg-transparent text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none dark:text-white dark:placeholder:text-gray-500"
						/>
						{search && (
							<button
								type="button"
								onClick={() => setSearch("")}
								className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
								aria-label="清除搜索"
							>
								<XMarkIcon className="size-4" />
							</button>
						)}
					</div>

					<div className="max-h-72 overflow-y-auto overscroll-contain py-1">
						<button
							type="button"
							onClick={() => choose(null)}
							className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-gray-50 dark:hover:bg-white/5 ${
								!value
									? "bg-brand-50 font-medium text-brand-700 dark:bg-brand-500/10 dark:text-brand-300"
									: "text-gray-700 dark:text-gray-300"
							}`}
						>
							<span className="flex size-4 shrink-0 items-center justify-center">
								{!value && <CheckIcon className="size-4" />}
							</span>
							不映射，使用原始 ID
						</button>

						{filtered.length === 0 ? (
							<div className="px-3 py-4 text-center text-xs text-gray-400">
								没有找到匹配的模型
							</div>
						) : (
							filtered.map((option) => {
								const isSelected = option.id === value;
								return (
									<button
										key={option.id}
										type="button"
										onClick={() => choose(option)}
										className={`flex w-full items-start gap-2 px-3 py-2 text-left transition-colors hover:bg-gray-50 dark:hover:bg-white/5 ${
											isSelected
												? "bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300"
												: "text-gray-700 dark:text-gray-300"
										}`}
									>
										<span className="flex size-4 shrink-0 items-center justify-center">
											{isSelected && <CheckIcon className="size-4" />}
										</span>
										<span className="min-w-0 flex-1">
											<span className="block truncate font-medium">
												{option.name || option.id}
											</span>
											<span className="block truncate font-mono text-[11px] text-gray-400">
												{option.id} · {option.providerId}
											</span>
											<span className="mt-0.5 block text-[11px] text-gray-500">
												输入 {formatPrice(option.inputPrice)} · 输出 {formatPrice(option.outputPrice)}
											</span>
										</span>
									</button>
								);
							})
						)}
					</div>
				</div>
			)}
		</div>
	);
}
