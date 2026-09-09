import type { DbCredential } from "../db/schema";
import type {
	ProviderAdapter,
	ProviderCredits,
	ProviderInfo,
} from "./interface";

export interface CustomChannelModel {
	id: string;
	name?: string | null;
	inputPrice: number;
	outputPrice: number;
	contextLength?: number | null;
	modelType?: "chat" | "embedding";
}

export interface CustomChannelMetadata {
	type: "custom_openai";
	name: string;
	baseUrl: string;
	models: CustomChannelModel[];
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
		return value as CustomChannelMetadata;
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
	if (!Object.keys(headers).some((key) => key.toLowerCase() === "authorization")) {
		headers.Authorization = `Bearer ${secret}`;
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

function extractNumber(code: string, response: unknown): number | null {
	const match = code.match(/\bremaining\s*:\s*([^,}\n]+)/);
	if (!match) return null;
	let expression = match[1]
		.replace(/\b(Number|parseFloat|parseInt)\s*\(/g, "(")
		.replace(/\)+\s*$/g, "")
		.split(/\?\?|\|\|/)[0]
		.trim();
	const references = expression.match(/response(?:\?\.|\.)[A-Za-z0-9_$.[\]'`]+/g) ?? [];
	for (const reference of references) {
		const value = valueAtPath(response, reference);
		const numeric = typeof value === "number" ? value : Number(value);
		if (!Number.isFinite(numeric)) return null;
		expression = expression.replace(reference, String(numeric));
	}
	const direct = Number(expression);
	return Number.isFinite(direct) ? direct : evaluateArithmetic(expression);
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
		const remaining = extractNumber(code, body);
		if (remaining == null) return null;
		const unit = code.match(/\bunit\s*:\s*["'`]([^"'`]+)["'`]/)?.[1] ?? "USD";
		return {
			remaining,
			usage: null,
			currency: unit.toUpperCase() === "CNY" ? "CNY" : "USD",
		};
	} catch {
		return null;
	}
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
		endpoint: "chat/completions" | "embeddings",
	): Promise<Response> {
		const upstreamResponse = await fetch(
			`${normalizeBaseUrl(this.channel.baseUrl)}/${endpoint}`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${secret}`,
				},
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
}

export function createCustomProvider(
	credential: Pick<DbCredential, "metadata">,
): CustomOpenAICompatibleAdapter | null {
	const metadata = parseCustomChannelMetadata(credential.metadata);
	return metadata ? new CustomOpenAICompatibleAdapter(metadata) : null;
}
