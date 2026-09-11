/**
 * Stream & JSON Interception Utilities
 *
 * Zero-latency interception of upstream responses.
 * SSE bytes are passed through a single reader while usage is parsed from the
 * same stream. This avoids body.tee(), which can produce unreliable streaming
 * behavior in some Cloudflare Worker/upstream combinations.
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

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let usageReported = false;
	let finalized = false;
	let errorReported = false;
	let drainStarted = false;

	const reportError = (error: unknown) => {
		if (errorReported) return;
		errorReported = true;
		log.error("stream", "Upstream stream error", {
			error: error instanceof Error ? error.message : String(error),
		});
		callbacks.onStreamError?.(error);
	};

	const consumeFrame = (frame: string) => {
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
				// Ignore non-JSON SSE frames and partial data frames.
			}
		}
	};

	const consumeFrames = (flush: boolean) => {
		while (true) {
			const frameEnd = buffer.indexOf("\n\n");
			if (frameEnd === -1) break;

			consumeFrame(buffer.slice(0, frameEnd));
			buffer = buffer.slice(frameEnd + 2);
		}

		if (flush && buffer.trim()) {
			consumeFrame(buffer);
			buffer = "";
		}
	};

	const processChunk = (chunk: Uint8Array) => {
		buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
		consumeFrames(false);
	};

	const finalize = () => {
		if (finalized) return;
		finalized = true;
		const tail = decoder.decode();
		if (tail) buffer += tail.replace(/\r\n/g, "\n");
		consumeFrames(true);
		if (!usageReported && callbacks.fallbackUsage) {
			callbacks.onUsage(callbacks.fallbackUsage);
		}
		callbacks.onStreamDone?.();
	};

	const drainRemaining = async () => {
		if (drainStarted) return;
		drainStarted = true;

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					finalize();
					return;
				}
				processChunk(value);
			}
		} catch (error) {
			reportError(error);
		}
	};

	const clientStream = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const { done, value } = await reader.read();
				if (done) {
					finalize();
					controller.close();
					return;
				}

				// Enqueue the original bytes unchanged. Parsing happens only as a
				// side effect, so SSE framing and token deltas reach the client intact.
				processChunk(value);
				controller.enqueue(value);
			} catch (error) {
				reportError(error);
				controller.error(error);
			}
		},
		cancel() {
			// Keep consuming after a client disconnect so usage/billing can still
			// be collected without teeing the response body.
			ctx.waitUntil(drainRemaining());
		},
	});

	return new Response(clientStream, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
}
