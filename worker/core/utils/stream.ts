/**
 * Stream & JSON Interception Utilities
 *
 * Zero-latency interception of upstream responses via body.tee().
 * The monitor stream runs out-of-band without blocking client delivery.
 */

import { log } from "../../shared/logger";

export interface TokenUsage {
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
	/** Number of images, used by image billing fallback when usage has no tokens. */
	image_count?: number;
	cost?: number;
	estimated_cost?: number;
}

export interface InterceptCallbacks {
	onUsage: (usage: TokenUsage) => void;
	onStreamDone?: () => void;
	onStreamError?: (error: unknown) => void;
	fallbackUsage?: TokenUsage;
}

function numberValue(value: unknown): number | undefined {
	if (
		value == null ||
		(typeof value !== "number" && typeof value !== "string")
	)
		return undefined;
	const number = Number(value);
	return Number.isFinite(number) && number >= 0 ? number : undefined;
}

/** Normalize usage variants returned by OpenAI-compatible providers. */
function normalizeUsage(raw: unknown): TokenUsage | null {
	if (!raw || typeof raw !== "object") return null;
	const value = raw as Record<string, unknown>;
	const inputDetails =
		value.input_tokens_details && typeof value.input_tokens_details === "object"
			? (value.input_tokens_details as Record<string, unknown>)
			: undefined;
	const outputDetails =
		value.output_tokens_details &&
		typeof value.output_tokens_details === "object"
			? (value.output_tokens_details as Record<string, unknown>)
			: undefined;
	const inputTokens =
		numberValue(value.prompt_tokens) ??
		numberValue(value.input_tokens) ??
		numberValue(inputDetails?.total) ??
		numberValue(value.input);
	const outputTokens =
		numberValue(value.completion_tokens) ??
		numberValue(value.output_tokens) ??
		numberValue(outputDetails?.total) ??
		numberValue(value.output) ??
		numberValue(value.image_output_tokens);
	const totalTokens =
		numberValue(value.total_tokens) ??
		(inputTokens != null || outputTokens != null
			? (inputTokens ?? 0) + (outputTokens ?? 0)
			: undefined);
	const cost = numberValue(value.cost) ?? numberValue(value.total_cost);
	const estimatedCost = numberValue(value.estimated_cost);
	const imageCount =
		numberValue(value.image_count) ??
		(Array.isArray(value.images) ? value.images.length : numberValue(value.images));

	if (
		inputTokens == null &&
		outputTokens == null &&
		totalTokens == null &&
		cost == null &&
		estimatedCost == null &&
		imageCount == null
	)
		return null;

	return {
		prompt_tokens: inputTokens ?? 0,
		completion_tokens: outputTokens ?? 0,
		total_tokens: totalTokens ?? 0,
		...(imageCount != null ? { image_count: imageCount } : {}),
		...(cost != null ? { cost } : {}),
		...(estimatedCost != null ? { estimated_cost: estimatedCost } : {}),
	};
}

export function interceptResponse(
	response: Response,
	ctx: ExecutionContext,
	callbacks: InterceptCallbacks,
): Response {
	const contentType = response.headers.get("content-type") || "";

	if (contentType.includes("text/event-stream")) {
		return interceptSSEStream(response, ctx, callbacks);
	}

	if (contentType.includes("application/json")) {
		const parseTask = response
			.clone()
			.json()
			.then((body) => {
				const parsed = body as { usage?: unknown };
				const usage = normalizeUsage(parsed?.usage) ?? callbacks.fallbackUsage;
				if (usage) callbacks.onUsage(usage);
				callbacks.onStreamDone?.();
			})
			.catch((err) => callbacks.onStreamError?.(err));

		ctx.waitUntil(parseTask);
		return response;
	}

	if (callbacks.fallbackUsage) callbacks.onUsage(callbacks.fallbackUsage);
	callbacks.onStreamDone?.();
	return response;
}

function interceptSSEStream(
	response: Response,
	ctx: ExecutionContext,
	callbacks: InterceptCallbacks,
): Response {
	if (!response.body) return response;

	const [clientStream, monitorStream] = response.body.tee();

	const monitorTask = (async () => {
		const reader = monitorStream.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		let usageReported = false;

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder
					.decode(value, { stream: true })
					.replace(/\r\n/g, "\n");

				while (true) {
					const frameEnd = buffer.indexOf("\n\n");
					if (frameEnd === -1) break;

					const frame = buffer.slice(0, frameEnd);
					buffer = buffer.slice(frameEnd + 2);

					for (const line of frame.split("\n")) {
						const trimmed = line.trim();
						if (!trimmed.startsWith("data: ") || trimmed === "data: [DONE]")
							continue;

						try {
							const data = JSON.parse(trimmed.substring(6));
							const usage = normalizeUsage(data?.usage);
							if (usage) {
								usageReported = true;
								callbacks.onUsage(usage);
							}
						} catch {
							// Partial chunk — ignore
						}
					}
				}
			}
			if (!usageReported && callbacks.fallbackUsage) {
				callbacks.onUsage(callbacks.fallbackUsage);
			}
			callbacks.onStreamDone?.();
		} catch (e) {
			log.error("stream", "Monitor fatal error", {
				error: e instanceof Error ? e.message : String(e),
			});
			callbacks.onStreamError?.(e);
		}
	})();

	ctx.waitUntil(monitorTask);

	return new Response(clientStream, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
}
