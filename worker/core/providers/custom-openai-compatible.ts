import type { DbCredential } from "../db/schema";
import type {
	ProviderAdapter,
	ProviderCredits,
	ProviderInfo,
} from "./interface";

export interface CustomChannelModel {
	id: string;
	/** Optional catalog target selected explicitly by the administrator. */
	catalogModelId?: string | null;
	catalogName?: string | null;
	name?: string | null;
	inputPrice: number;
	outputPrice: number;
	/** Optional fallback price in USD per generated/edited image. */
	imagePrice?: number | null;
	contextLength?: number | null;
	modelType?: "chat" | "embedding";
}

export interface CustomChannelMetadata {
	type: "custom_openai";
	name: string;
	/** Public alias; the real channel name is kept in nameCiphertext. */
	nameCiphertext?: string | null;
	baseUrl: string;
	models: CustomChannelModel[];
	/** Defaults to true for channels created before this field existed. */
	requiresApiKey?: boolean;
	websiteUrl?: string | null;
	defaultInputPrice?: number;
	defaultOutputPrice?: number;
	extractorCode?: string | null;
}

export function parseCustomChannelMetadata(
	metadata: string | null,
): CustomChannelMetadata | null {
	if (!metadata) return null;
	try {
		const value = JSON.parse(metadata) as Partial<CustomChannelMetadata>;
		if (
			value.type !== "custom_openai" ||
			typeof value.name !== "string" ||
			typeof value.baseUrl !== "string" ||
			!Array.isArray(value.models)
		)
			return null;
		return {
			...(value as CustomChannelMetadata),
			requiresApiKey: value.requiresApiKey !== false,
		};
	} catch {
		return null;
	}
}

function normalizeBaseUrl(value: string): string {
	return value.replace(/\/+$/, "");
}

interface ExtractorRequest {
	url: string;
	method: string;
	headers: Record<string, string>;
}

function replaceSecret(value: string, secret: string): string {
	return value
		.replace(/\$\{API_KEY\}|\{\{API_KEY\}\}|<API_KEY>/g, secret)
		.replace(/\$\{KEY\}|\{\{KEY\}\}|<KEY>/g, secret);
}

/**
 * Parse the intentionally small, CC Switch-style request declaration.
 * Arbitrary JS is not executed in Workers; only literal request fields and
 * response property expressions are accepted.
 */
function parseExtractorRequest(code: string, secret: string): ExtractorRequest | null {
	const url = code.match(/\burl\s*:\s*["'`]([^"'`]+)["'`]/)?.[1];
	if (!url) return null;
	const method = code.match(/\bmethod\s*:\s*["'`]([^"'`]+)["'`]/)?.[1] ?? "GET";
	const headers: Record<string, string> = {};
	const headerBlock = code.match(/\bheaders\s*:\s*\{([\s\S]*?)\}\s*[,}]/)?.[1] ?? "";
	const pairPattern = /(?:["'`])?([A-Za-z0-9_-]+)(?:["'`])?\s*:\s*["'`]([^"'`]*)["'`]/g;
	for (const match of headerBlock.matchAll(pairPattern)) {
		headers[match[1]] = replaceSecret(match[2], secret);
	}
	if (
		secret &&
		!Object.keys(headers).some((key) => key.toLowerCase() === "authorization")
	) {
		headers.Authorization = `Bearer ${secret}`;
	}
	if (!secret) {
		for (const [key, value] of Object.entries(headers)) {
			if (!value || /^Bearer\s*$/i.test(value.trim())) delete headers[key];
		}
	}
	return { url: replaceSecret(url, secret), method: method.toUpperCase(), headers };
}

function valueAtPath(response: unknown, reference: string): unknown {
	const path = reference
		.replace(/^response/, "")
		.replace(/\?\./g, ".")
		.replace(/\[\s*["'`]([^"'`]+)["'`]\s*\]/g, ".$1")
		.replace(/^\./, "");
	if (!path) return response;
	return path.split(".").reduce<unknown>((value, key) => {
		if (value && typeof value === "object") {
			return (value as Record<string, unknown>)[key];
		}
		return undefined;
	}, response);
}

function splitTopLevel(expression: string, separator: string): string[] {
	const parts: string[] = [];
	let start = 0;
	let depth = 0;
	let quote = "";
	for (let i = 0; i < expression.length; i++) {
		const char = expression[i];
		if (quote) {
			if (char === quote && expression[i - 1] !== "\\") quote = "";
			continue;
		}
		if (char === "\"" || char === "'" || char === "`") {
			quote = char;
			continue;
		}
		if ("([{".includes(char)) depth++;
		else if (")]}`".includes(char)) depth--;
		if (
			depth === 0 &&
			expression.startsWith(separator, i) &&
			!(separator === "?" && expression[i + 1] === ".")
		) {
			parts.push(expression.slice(start, i).trim());
			start = i + separator.length;
			i += separator.length - 1;
		}
	}
	parts.push(expression.slice(start).trim());
	return parts;
}

function unwrapParentheses(expression: string): string {
	let value = expression.trim();
	while (value.startsWith("(") && value.endsWith(")")) {
		let depth = 0;
		let balanced = true;
		for (let i = 0; i < value.length; i++) {
			if (value[i] === "(") depth++;
			if (value[i] === ")") depth--;
			if (depth === 0 && i < value.length - 1) {
				balanced = false;
				break;
			}
		}
		if (!balanced) break;
		value = value.slice(1, -1).trim();
	}
	return value;
}

function evaluateArithmetic(expression: string): number | null {
	const compact = expression.replace(/\s+/g, "");
	const tokens = compact.match(/\d+(?:\.\d+)?|[()+\-*/]/g);
	if (!tokens || tokens.join("") !== compact) return null;
	const values: number[] = [];
	const operators: string[] = [];
	const precedence = (operator: string) => (operator === "+" || operator === "-" ? 1 : 2);
	const apply = () => {
		const operator = operators.pop();
		const right = values.pop();
		const left = values.pop();
		if (!operator || left == null || right == null) return false;
		values.push(
			operator === "+"
				? left + right
				: operator === "-"
					? left - right
					: operator === "*"
						? left * right
						: right === 0
							? Number.NaN
							: left / right,
		);
		return true;
	};
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (/\d/.test(token)) {
			values.push(Number(token));
			continue;
		}
		if (token === "(") {
			operators.push(token);
			continue;
		}
		if (token === ")") {
			while (operators.at(-1) && operators.at(-1) !== "(") {
				if (!apply()) return null;
			}
			if (operators.pop() !== "(") return null;
			continue;
		}
		while (
			operators.at(-1) &&
			operators.at(-1) !== "(" &&
			precedence(operators.at(-1) as string) >= precedence(token)
		) {
			if (!apply()) return null;
		}
		operators.push(token);
	}
	while (operators.length) if (!apply()) return null;
	return values.length === 1 && Number.isFinite(values[0]) ? values[0] : null;
}

/** Resolve the safe subset of expressions used by CC Switch-style extractors. */
function createExtractorResolver(code: string, response: unknown) {
	const variables = new Map<string, string>();
	const variablePattern =
		/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;]+);?/g;
	for (const match of code.matchAll(variablePattern)) {
		variables.set(match[1], match[2].trim());
	}

	const resolve = (rawExpression: string, stack = new Set<string>()): unknown => {
		const expression = unwrapParentheses(rawExpression.trim());
		if (!expression) return undefined;

		const coalesce = splitTopLevel(expression, "??");
		if (coalesce.length > 1) {
			for (const part of coalesce) {
				const value = resolve(part, stack);
				if (value !== null && value !== undefined) return value;
			}
			return undefined;
		}

		const ternary = splitTopLevel(expression, "?");
		if (ternary.length === 2) {
			const branches = splitTopLevel(ternary[1], ":");
			if (branches.length === 2) {
				const comparison = ternary[0].match(
					/^(.+?)\s*(===|==|!==|!=)\s*(.+)$/,
				);
				let truthy = Boolean(resolve(ternary[0], stack));
				if (comparison) {
					const left = resolve(comparison[1], stack);
					const right = resolve(comparison[3], stack);
					truthy = comparison[2].includes("!") ? left !== right : left === right;
				}
				return resolve(branches[truthy ? 0 : 1], stack);
			}
		}

		const wrapper = expression.match(
			/^(Number|parseFloat|parseInt|Math\.round)\s*\(([\s\S]*)\)$/,
		);
		if (wrapper) {
			const value = resolve(wrapper[2], stack);
			const number = Number(value);
			if (!Number.isFinite(number)) return undefined;
			return wrapper[1] === "parseInt" || wrapper[1] === "Math.round"
				? Math.round(number)
				: number;
		}

		if (
			(expression.startsWith("\"") && expression.endsWith("\"")) ||
			(expression.startsWith("'") && expression.endsWith("'"))
		) {
			return expression.slice(1, -1);
		}
		if (expression.startsWith("`") && expression.endsWith("`")) {
			return expression.slice(1, -1).replace(/\$\{([^}]+)\}/g, (_, part: string) => {
				const value = resolve(part, stack);
				return value == null ? "" : String(value);
			});
		}

		const additions = splitTopLevel(expression, "+");
		if (additions.length > 1) {
			const values = additions.map((part) => resolve(part, stack));
			if (values.some((value) => value === undefined)) return undefined;
			if (values.some((value) => typeof value === "string")) {
				return values.map((value) => String(value)).join("");
			}
			return values.reduce<number>((sum, value) => sum + Number(value), 0);
		}

		const reference = expression.match(
			/^[A-Za-z_$][\w$]*(?:(?:\?\.)?\.[A-Za-z0-9_$]+|\[\s*(?:\d+|["'][^"']+["'])\s*\])*$/,
		)?.[0];
		if (reference) {
			const root = reference.match(/^[A-Za-z_$][\w$]*/)?.[0];
			if (root === "response") return valueAtPath(response, reference);
			const variableExpression = root ? variables.get(root) : undefined;
			if (!root || !variableExpression || stack.has(root)) return undefined;
			const value = resolve(variableExpression, new Set([...stack, root]));
			const suffix = reference.slice(root.length);
			return suffix ? valueAtPath(value, `response${suffix}`) : value;
		}

		const direct = Number(expression);
		if (Number.isFinite(direct)) return direct;

		let arithmetic = expression;
		const references = expression.match(
			/[A-Za-z_$][\w$]*(?:(?:\?\.)?\.[A-Za-z0-9_$]+|\[\s*(?:\d+|["'][^"']+["'])\s*\])*/g,
		) ?? [];
		for (const referencePart of references) {
			const value = resolve(referencePart, stack);
			const number = Number(value);
			if (!Number.isFinite(number)) return undefined;
			arithmetic = arithmetic.replace(referencePart, String(number));
		}
		return evaluateArithmetic(arithmetic);
	};

	return resolve;
}

function extractPropertyExpression(code: string, property: string): string | null {
	const match = code.match(new RegExp(`\\b${property}\\s*:\\s*`));
	if (!match || match.index == null) return null;
	const start = match.index + match[0].length;
	let depth = 0;
	let quote = "";
	for (let i = start; i < code.length; i++) {
		const char = code[i];
		if (quote) {
			if (char === quote && code[i - 1] !== "\\") quote = "";
			continue;
		}
		if (char === "\"" || char === "'" || char === "`") {
			quote = char;
			continue;
		}
		if ("([{".includes(char)) depth++;
		else if (")]}".includes(char)) {
			if (depth === 0) return code.slice(start, i).trim();
			depth--;
		}
		if (depth === 0 && char === ",") return code.slice(start, i).trim();
	}
	return code.slice(start).trim();
}

function extractNumber(code: string, response: unknown): number | null {
	const expression = extractPropertyExpression(code, "remaining");
	if (!expression) return null;
	const value = createExtractorResolver(code, response)(expression);
	const number = typeof value === "number" ? value : Number(value);
	return Number.isFinite(number) ? number : null;
}

function extractText(
	code: string,
	response: unknown,
	property: string,
): string | null {
	const expression = extractPropertyExpression(code, property);
	if (!expression) return null;
	const value = createExtractorResolver(code, response)(expression);
	return value == null ? null : String(value);
}

function formatDuration(milliseconds: number): string {
	const totalMinutes = Math.max(0, Math.round(milliseconds / 60_000));
	const days = Math.floor(totalMinutes / (24 * 60));
	const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
	const minutes = totalMinutes % 60;
	if (days > 0) return `${days}d${hours}h`;
	if (hours > 0) return `${hours}h${minutes}m`;
	return `${minutes}m`;
}

/** MiniMax Token Plan /v1/token_plan/remains response. */
function parseMiniMaxTokenPlanCredits(response: unknown): ProviderCredits | null {
	if (!response || typeof response !== "object") return null;
	const root = response as Record<string, unknown>;
	const data = root.data as Record<string, unknown> | undefined;
	const rawRows = Array.isArray(root.model_remains)
		? root.model_remains
		: Array.isArray(data?.model_remains)
			? data.model_remains
			: [];
	const plans = rawRows.filter(
		(row): row is Record<string, unknown> =>
			!!row && typeof row === "object",
	);
	const plan =
		plans.find((row) => row.model_name === "general") ?? plans[0];
	if (!plan) return null;

	const interval = Number(plan.current_interval_remaining_percent);
	const weekly = Number(plan.current_weekly_remaining_percent);
	const intervalTime = Number(plan.remains_time);
	const weeklyTime = Number(plan.weekly_remains_time);
	if (![interval, weekly].some((value) => Number.isFinite(value))) return null;

	const display = [
		Number.isFinite(interval)
			? `5小时:${interval}%${Number.isFinite(intervalTime) ? ` ${formatDuration(intervalTime)}` : ""}`
			: null,
		Number.isFinite(weekly)
			? `7天:${weekly}%${Number.isFinite(weeklyTime) ? ` ${formatDuration(weeklyTime)}` : ""}`
			: null,
	]
		.filter((value): value is string => value !== null)
		.join(" · ");

	return {
		remaining: null,
		usage: null,
		unit: "PERCENT",
		display,
		details: {
			modelName: plan.model_name ?? null,
			intervalRemainingPercent: Number.isFinite(interval) ? interval : null,
			weeklyRemainingPercent: Number.isFinite(weekly) ? weekly : null,
			intervalResetMs: Number.isFinite(intervalTime) ? intervalTime : null,
			weeklyResetMs: Number.isFinite(weeklyTime) ? weeklyTime : null,
		},
	};
}

async function fetchCreditsWithExtractor(
	code: string,
	secret: string,
): Promise<ProviderCredits | null> {
	const request = parseExtractorRequest(code, secret);
	if (!request) return null;
	try {
		const response = await fetch(request.url, {
			method: request.method,
			headers: request.headers,
		});
		if (!response.ok) return null;
		const text = await response.text();
		let body: unknown = { text };
		try {
			body = JSON.parse(text);
		} catch {
			// Keep the text wrapper for extractors that use response.text.
		}
		const miniMaxCredits = parseMiniMaxTokenPlanCredits(body);
		if (miniMaxCredits) return miniMaxCredits;
		const remaining = extractNumber(code, body);
		if (remaining == null) return null;
		const unit = code.match(/\bunit\s*:\s*["'`]([^"'`]+)["'`]/)?.[1] ?? "USD";
		const normalizedUnit = unit.toUpperCase();
		const display =
			extractText(code, body, "display") ??
			extractText(code, body, "extra") ??
			(normalizedUnit.includes("%") ? `${remaining}%` : undefined);
		return {
			remaining,
			usage: null,
			currency:
				normalizedUnit === "CNY" || normalizedUnit === "USD"
					? (normalizedUnit as "CNY" | "USD")
					: undefined,
			unit,
			display,
		};
	} catch {
		return null;
	}
}

export function testCustomExtractor(
	code: string,
	secret: string,
): Promise<ProviderCredits | null> {
	return fetchCreditsWithExtractor(code, secret);
}

/** Adapter created from one administrator-managed channel credential. */
export class CustomOpenAICompatibleAdapter implements ProviderAdapter {
	readonly info: ProviderInfo;

	constructor(private readonly channel: CustomChannelMetadata) {
		this.info = {
			id: "custom",
			name: channel.name,
			logoUrl: "https://api.iconify.design/mdi:server-network.svg",
			supportsAutoCredits: false,
			currency: "USD",
			credentialGuide: { placeholder: "sk-..." },
		};
	}

	async validateKey(_secret: string): Promise<boolean> {
		return true;
	}

	async fetchCredits(_secret: string): Promise<ProviderCredits | null> {
		if (!this.channel.extractorCode) return null;
		return fetchCreditsWithExtractor(this.channel.extractorCode, _secret);
	}

	async fetchModels(): Promise<never[]> {
		return [];
	}

	private async forward(
		secret: string,
		body: Record<string, unknown>,
		endpoint: "chat/completions" | "embeddings" | "images/generations",
	): Promise<Response> {
		const requestHeaders: Record<string, string> = {
			"Content-Type": "application/json",
		};
		if (this.channel.requiresApiKey !== false && secret) {
			requestHeaders.Authorization = `Bearer ${secret}`;
		}
		const upstreamResponse = await fetch(
			`${normalizeBaseUrl(this.channel.baseUrl)}/${endpoint}`,
			{
				method: "POST",
				headers: requestHeaders,
				body: JSON.stringify(body),
			},
		);

		const headers = new Headers();
		const skipHeaders = new Set(["connection", "keep-alive", "transfer-encoding"]);
		upstreamResponse.headers.forEach((value, key) => {
			if (!skipHeaders.has(key.toLowerCase())) headers.set(key, value);
		});

		return new Response(upstreamResponse.body, {
			status: upstreamResponse.status,
			statusText: upstreamResponse.statusText,
			headers,
		});
	}

	private async forwardForm(secret: string, body: FormData): Promise<Response> {
		const requestHeaders: Record<string, string> = {};
		if (this.channel.requiresApiKey !== false && secret) {
			requestHeaders.Authorization = `Bearer ${secret}`;
		}
		const upstreamResponse = await fetch(
			`${normalizeBaseUrl(this.channel.baseUrl)}/images/edits`,
			{
				method: "POST",
				headers: requestHeaders,
				body,
			},
		);

		const headers = new Headers();
		const skipHeaders = new Set(["connection", "keep-alive", "transfer-encoding"]);
		upstreamResponse.headers.forEach((value, key) => {
			if (!skipHeaders.has(key.toLowerCase())) headers.set(key, value);
		});

		return new Response(upstreamResponse.body, {
			status: upstreamResponse.status,
			statusText: upstreamResponse.statusText,
			headers,
		});
	}

	forwardRequest(
		secret: string,
		body: Record<string, unknown>,
	): Promise<Response> {
		return this.forward(secret, body, "chat/completions");
	}

	forwardEmbedding(
		secret: string,
		body: Record<string, unknown>,
	): Promise<Response> {
		return this.forward(secret, body, "embeddings");
	}

	forwardImageGeneration(
		secret: string,
		body: Record<string, unknown>,
	): Promise<Response> {
		return this.forward(secret, body, "images/generations");
	}

	forwardImageEdit(secret: string, body: FormData): Promise<Response> {
		return this.forwardForm(secret, body);
	}
}

export function createCustomProvider(
	credential: Pick<DbCredential, "metadata">,
): CustomOpenAICompatibleAdapter | null {
	const metadata = parseCustomChannelMetadata(credential.metadata);
	return metadata ? new CustomOpenAICompatibleAdapter(metadata) : null;
}
