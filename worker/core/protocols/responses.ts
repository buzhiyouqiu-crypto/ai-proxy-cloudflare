/**
 * OpenAI Responses API ↔ OpenAI Chat Completions conversion.
 *
 * Keyloom's routing core speaks Chat Completions internally. This adapter lets
 * Responses API clients (including Codex-compatible clients) use the same
 * model catalog, credential dispatch, failover, and billing pipeline.
 */

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as JsonObject)
		: null;
}

function asString(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function stringifyToolOutput(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return String(value ?? "");
	}
}

function mapContentPart(part: unknown, input: boolean): JsonObject | null {
	const value = asObject(part);
	if (!value) return null;
	const type = asString(value.type);

	if (type === "input_text" || type === "output_text" || type === "text") {
		return { type: "text", text: asString(value.text) ?? "" };
	}

	if (type === "input_image" || type === "image" || type === "image_url") {
		const rawImage = value.image_url ?? value.image;
		const image = asObject(rawImage);
		const url =
			asString(rawImage) ??
			asString(image?.url) ??
			asString(image?.image_url);
		if (url) return { type: "image_url", image_url: { url } };
	}

	if (type === "input_file" || type === "file") {
		const url = asString(value.file_url) ?? asString(value.file_data);
		if (url) {
			return {
				type: "text",
				text: `[Attached file: ${url}]`,
			};
		}
	}

	// Chat Completions uses the same shape for already-normalized image parts.
	if (input && type === "image_url" && asObject(value.image_url)) {
		return value;
	}
	return null;
}

function mapContent(content: unknown, input = true): unknown {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return content == null ? "" : String(content);

	const parts = content
		.map((part) => mapContentPart(part, input))
		.filter((part): part is JsonObject => part !== null);
	if (parts.length === 1 && parts[0].type === "text") return parts[0].text;
	return parts;
}

function appendMessage(
	messages: JsonObject[],
	role: string,
	content: unknown,
): void {
	const normalizedRole =
		role === "system" || role === "developer" ? role : role || "user";
	messages.push({
		role: normalizedRole,
		content: mapContent(content, normalizedRole !== "assistant"),
	});
}

function appendInputItem(messages: JsonObject[], item: unknown): void {
	if (typeof item === "string") {
		appendMessage(messages, "user", item);
		return;
	}

	const value = asObject(item);
	if (!value) return;
	const type = asString(value.type);

	if (type === "function_call") {
		const callId = asString(value.call_id) ?? asString(value.id) ?? crypto.randomUUID();
		messages.push({
			role: "assistant",
			content: null,
			tool_calls: [
				{
					id: callId,
					type: "function",
					function: {
						name: asString(value.name) ?? "function",
						arguments: asString(value.arguments) ?? "{}",
					},
				},
			],
		});
		return;
	}

	if (type === "function_call_output") {
		messages.push({
			role: "tool",
			tool_call_id: asString(value.call_id) ?? asString(value.id) ?? "",
			content: stringifyToolOutput(value.output),
		});
		return;
	}

	if (type === "reasoning" || type === "item_reference") return;

	const role = asString(value.role);
	if (role) {
		appendMessage(messages, role, value.content);
		return;
	}

	// A single input_text/input_image item is accepted by a few Responses
	// clients even though the public API normally wraps it in a message.
	if (type) appendMessage(messages, "user", [value]);
}

function mapTools(raw: unknown): JsonObject[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const tools: JsonObject[] = [];
	for (const rawTool of raw) {
		const tool = asObject(rawTool);
		if (!tool) continue;
		const nested = asObject(tool.function);
		if (nested && asString(tool.type) === "function") {
			tools.push(tool);
			continue;
		}
		const name = asString(tool.name);
		if (!name || asString(tool.type) !== "function") continue;
		tools.push({
			type: "function",
			function: {
				name,
				description: asString(tool.description) ?? undefined,
				parameters: tool.parameters ?? {},
				strict: tool.strict,
			},
		});
	}
	return tools.length > 0 ? tools : undefined;
}

function mapToolChoice(raw: unknown): unknown {
	if (typeof raw === "string") return raw;
	const value = asObject(raw);
	if (!value) return raw;
	if (value.type === "function" && typeof value.name === "string") {
		return { type: "function", function: { name: value.name } };
	}
	return raw;
}

function mapResponseFormat(text: unknown): JsonObject | undefined {
	const textConfig = asObject(text);
	const format = asObject(textConfig?.format);
	if (!format || typeof format.type !== "string") return undefined;
	if (format.type === "json_object") return { type: "json_object" };
	if (format.type !== "json_schema") return undefined;
	return {
		type: "json_schema",
		json_schema: {
			name: asString(format.name) ?? "response",
			description: format.description,
			schema: format.schema ?? {},
			strict: format.strict,
		},
	};
}

export function toChatRequest(body: JsonObject): JsonObject {
	const messages: JsonObject[] = [];
	if (typeof body.instructions === "string" && body.instructions) {
		appendMessage(messages, "system", body.instructions);
	}

	if (typeof body.input === "string") {
		appendMessage(messages, "user", body.input);
	} else if (Array.isArray(body.input)) {
		for (const item of body.input) appendInputItem(messages, item);
	}

	const result: JsonObject = {
		model: body.model,
		messages,
	};
	if (body.max_output_tokens != null) result.max_tokens = body.max_output_tokens;
	if (body.temperature != null) result.temperature = body.temperature;
	if (body.top_p != null) result.top_p = body.top_p;
	if (body.stream != null) result.stream = body.stream;
	if (body.parallel_tool_calls != null) {
		result.parallel_tool_calls = body.parallel_tool_calls;
	}
	if (body.reasoning != null) result.reasoning = body.reasoning;

	const tools = mapTools(body.tools);
	if (tools) result.tools = tools;
	if (body.tool_choice != null) result.tool_choice = mapToolChoice(body.tool_choice);

	const responseFormat = mapResponseFormat(body.text);
	if (responseFormat) result.response_format = responseFormat;
	return result;
}

function numberValue(value: unknown): number {
	const number = Number(value);
	return Number.isFinite(number) && number >= 0 ? number : 0;
}

function responseUsage(raw: unknown): JsonObject {
	const usage = asObject(raw);
	const inputDetails = asObject(usage?.prompt_tokens_details);
	const outputDetails = asObject(usage?.completion_tokens_details);
	const inputTokens = numberValue(usage?.prompt_tokens ?? usage?.input_tokens);
	const outputTokens = numberValue(
		usage?.completion_tokens ?? usage?.output_tokens,
	);
	return {
		input_tokens: inputTokens,
		input_tokens_details: {
			cached_tokens: numberValue(inputDetails?.cached_tokens),
		},
		output_tokens: outputTokens,
		output_tokens_details: {
			reasoning_tokens: numberValue(outputDetails?.reasoning_tokens),
		},
		total_tokens: numberValue(usage?.total_tokens) || inputTokens + outputTokens,
	};
}

function contentText(content: unknown): { text: string; refusal: string | null } {
	if (typeof content === "string") return { text: content, refusal: null };
	if (!Array.isArray(content)) return { text: "", refusal: null };
	let text = "";
	let refusal: string | null = null;
	for (const rawPart of content) {
		const part = asObject(rawPart);
		if (!part) continue;
		if (part.type === "text" || part.type === "output_text") {
			text += asString(part.text) ?? "";
		} else if (part.type === "refusal") {
			refusal = (refusal ?? "") + (asString(part.refusal) ?? "");
		}
	}
	return { text, refusal };
}

function responseOutput(message: JsonObject | null): {
	output: JsonObject[];
	outputText: string;
} {
	if (!message) return { output: [], outputText: "" };
	const { text, refusal } = contentText(message.content);
	const output: JsonObject[] = [];
	if (text || refusal) {
		const content: JsonObject[] = [];
		if (text) content.push({ type: "output_text", text, annotations: [], logprobs: [] });
		if (refusal) content.push({ type: "refusal", refusal });
		output.push({
			id: `msg_${crypto.randomUUID().slice(0, 12)}`,
			type: "message",
			role: "assistant",
			status: "completed",
			phase: "final_answer",
			content,
		});
	}

	const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
	for (const rawCall of toolCalls) {
		const call = asObject(rawCall);
		const fn = asObject(call?.function);
		if (!fn) continue;
		const callId = asString(call?.id) ?? `call_${crypto.randomUUID().slice(0, 12)}`;
		output.push({
			id: callId,
			type: "function_call",
			status: "completed",
			call_id: callId,
			name: asString(fn.name) ?? "function",
			arguments: asString(fn.arguments) ?? "{}",
		});
	}
	return { output, outputText: text };
}

export function toResponsesResponse(
	openai: JsonObject,
	request: JsonObject,
): JsonObject {
	const choice = Array.isArray(openai.choices)
		? asObject(openai.choices[0])
		: null;
	const message = asObject(choice?.message);
	const finishReason = asString(choice?.finish_reason);
	const incomplete = finishReason === "length" || finishReason === "content_filter";
	const result = responseOutput(message);
	const responseId = asString(openai.id)?.replace(/^chatcmpl-/, "") ?? crypto.randomUUID();
	const reasoning = asString(message?.reasoning_content) ?? asString(message?.reasoning);
	if (reasoning) {
		result.output.unshift({
			id: `rs_${crypto.randomUUID().slice(0, 12)}`,
			type: "reasoning",
			status: "completed",
			summary: [{ type: "summary_text", text: reasoning }],
		});
	}

	return {
		id: `resp_${responseId}`,
		object: "response",
		created_at: Math.floor(Date.now() / 1000),
		status: incomplete ? "incomplete" : "completed",
		error: null,
		incomplete_details: incomplete
			? { reason: finishReason === "content_filter" ? "content_filter" : "max_output_tokens" }
			: null,
		instructions: request.instructions ?? null,
		metadata: request.metadata ?? null,
		model: request.model,
		output: result.output,
		output_text: result.outputText,
		parallel_tool_calls: request.parallel_tool_calls ?? true,
		temperature: request.temperature ?? null,
		tool_choice: request.tool_choice ?? "auto",
		tools: request.tools ?? [],
		top_p: request.top_p ?? null,
		max_output_tokens: request.max_output_tokens ?? null,
		previous_response_id: null,
		reasoning: request.reasoning ?? null,
		service_tier: "default",
		store: false,
		truncation: request.truncation ?? "disabled",
		usage: responseUsage(openai.usage),
	};
}

interface StreamToolState {
	id: string;
	callId: string;
	name: string;
	arguments: string;
	outputIndex: number;
}

interface StreamState {
	responseId: string;
	createdAt: number;
	model: unknown;
	text: { id: string; outputIndex: number; value: string } | null;
	reasoning: { id: string; outputIndex: number; value: string } | null;
	tools: Map<number, StreamToolState>;
	nextOutputIndex: number;
	finishReason: string | null;
	usage: unknown;
}

function streamOutput(state: StreamState, status: string): JsonObject[] {
	const output: Array<{ index: number; item: JsonObject }> = [];
	if (state.text) {
		output.push({
			index: state.text.outputIndex,
			item: {
				id: state.text.id,
				type: "message",
				role: "assistant",
				status,
				phase: "final_answer",
				content: [
					{
						type: "output_text",
						text: state.text.value,
						annotations: [],
						logprobs: [],
					},
				],
			},
		});
	}
	if (state.reasoning) {
		output.push({
			index: state.reasoning.outputIndex,
			item: {
				id: state.reasoning.id,
				type: "reasoning",
				status,
				summary: [{ type: "summary_text", text: state.reasoning.value }],
				content: [{ type: "reasoning_text", text: state.reasoning.value }],
			},
		});
	}
	for (const tool of state.tools.values()) {
		output.push({
			index: tool.outputIndex,
			item: {
				id: tool.id,
				type: "function_call",
				status,
				call_id: tool.callId,
				name: tool.name || "function",
				arguments: tool.arguments,
			},
		});
	}
	return output.sort((a, b) => a.index - b.index).map(({ item }) => item);
}

function streamResponse(state: StreamState, status: string): JsonObject {
	return {
		id: state.responseId,
		object: "response",
		created_at: state.createdAt,
		status,
		error: null,
		incomplete_details: status === "incomplete" ? { reason: "max_output_tokens" } : null,
		instructions: null,
		metadata: null,
		model: state.model,
		output: streamOutput(state, status),
		output_text: state.text?.value ?? "",
		parallel_tool_calls: true,
		temperature: null,
		tool_choice: "auto",
		tools: [],
		top_p: null,
		store: false,
		usage: responseUsage(state.usage),
	};
}

export function createOpenAIToResponsesStream(
	model: unknown,
): TransformStream<Uint8Array, Uint8Array> {
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();
	const state: StreamState = {
		responseId: `resp_${crypto.randomUUID().slice(0, 20)}`,
		createdAt: Math.floor(Date.now() / 1000),
		model,
		text: null,
		reasoning: null,
		tools: new Map(),
		nextOutputIndex: 0,
		finishReason: null,
		usage: null,
	};
	let sequence = 0;
	let started = false;
	let finalized = false;
	let buffer = "";

	function emit(
		controller: TransformStreamDefaultController<Uint8Array>,
		type: string,
		data: JsonObject,
	) {
		controller.enqueue(
			encoder.encode(
				`event: ${type}\ndata: ${JSON.stringify({ type, ...data, sequence_number: sequence++ })}\n\n`,
			),
		);
	}

	function start(controller: TransformStreamDefaultController<Uint8Array>) {
		if (started) return;
		started = true;
		emit(controller, "response.created", {
			response: streamResponse(state, "in_progress"),
		});
		emit(controller, "response.in_progress", {
			response: streamResponse(state, "in_progress"),
		});
	}

	function ensureText(controller: TransformStreamDefaultController<Uint8Array>) {
		if (state.text) return state.text;
		state.text = {
			id: `msg_${crypto.randomUUID().slice(0, 12)}`,
			outputIndex: state.nextOutputIndex++,
			value: "",
		};
		emit(controller, "response.output_item.added", {
			output_index: state.text.outputIndex,
			item: {
				id: state.text.id,
				type: "message",
				role: "assistant",
				status: "in_progress",
				phase: "final_answer",
				content: [],
			},
		});
		emit(controller, "response.content_part.added", {
			output_index: state.text.outputIndex,
			content_index: 0,
			item_id: state.text.id,
			part: { type: "output_text", text: "", annotations: [], logprobs: [] },
		});
		return state.text;
	}

	function ensureReasoning(controller: TransformStreamDefaultController<Uint8Array>) {
		if (state.reasoning) return state.reasoning;
		state.reasoning = {
			id: `rs_${crypto.randomUUID().slice(0, 12)}`,
			outputIndex: state.nextOutputIndex++,
			value: "",
		};
		emit(controller, "response.output_item.added", {
			output_index: state.reasoning.outputIndex,
			item: {
				id: state.reasoning.id,
				type: "reasoning",
				status: "in_progress",
				summary: [],
				content: [],
			},
		});
		emit(controller, "response.content_part.added", {
			output_index: state.reasoning.outputIndex,
			content_index: 0,
			item_id: state.reasoning.id,
			part: { type: "reasoning_text", text: "" },
		});
		return state.reasoning;
	}

	function ensureTool(
		controller: TransformStreamDefaultController<Uint8Array>,
		index: number,
		id?: string,
	) {
		const existing = state.tools.get(index);
		if (existing) return existing;
		const callId = id || `call_${crypto.randomUUID().slice(0, 12)}`;
		const tool: StreamToolState = {
			id: callId,
			callId,
			name: "",
			arguments: "",
			outputIndex: state.nextOutputIndex++,
		};
		state.tools.set(index, tool);
		emit(controller, "response.output_item.added", {
			output_index: tool.outputIndex,
			item: {
				id: tool.id,
				type: "function_call",
				status: "in_progress",
				call_id: tool.callId,
				name: "function",
				arguments: "",
			},
		});
		return tool;
	}

	function finish(controller: TransformStreamDefaultController<Uint8Array>) {
		if (finalized) return;
		finalized = true;
		const incomplete =
			state.finishReason === "length" || state.finishReason === "content_filter";
		const status = incomplete ? "incomplete" : "completed";

		if (state.text) {
			emit(controller, "response.output_text.done", {
				output_index: state.text.outputIndex,
				content_index: 0,
				item_id: state.text.id,
				text: state.text.value,
			});
			emit(controller, "response.content_part.done", {
				output_index: state.text.outputIndex,
				content_index: 0,
				item_id: state.text.id,
				part: {
					type: "output_text",
					text: state.text.value,
					annotations: [],
					logprobs: [],
				},
			});
			emit(controller, "response.output_item.done", {
				output_index: state.text.outputIndex,
				item: streamOutput(state, status).find((item) => item.id === state.text?.id),
			});
		}

		if (state.reasoning) {
			emit(controller, "response.reasoning_text.done", {
				output_index: state.reasoning.outputIndex,
				content_index: 0,
				item_id: state.reasoning.id,
				text: state.reasoning.value,
			});
			emit(controller, "response.content_part.done", {
				output_index: state.reasoning.outputIndex,
				content_index: 0,
				item_id: state.reasoning.id,
				part: { type: "reasoning_text", text: state.reasoning.value },
			});
			emit(controller, "response.output_item.done", {
				output_index: state.reasoning.outputIndex,
				item: streamOutput(state, status).find(
					(item) => item.id === state.reasoning?.id,
				),
			});
		}

		for (const tool of state.tools.values()) {
			emit(controller, "response.function_call_arguments.done", {
				output_index: tool.outputIndex,
				item_id: tool.id,
				name: tool.name || "function",
				arguments: tool.arguments,
			});
			emit(controller, "response.output_item.done", {
				output_index: tool.outputIndex,
				item: streamOutput(state, status).find((item) => item.id === tool.id),
			});
		}

		emit(controller, incomplete ? "response.incomplete" : "response.completed", {
			response: streamResponse(state, status),
		});
	}

	function processData(
		controller: TransformStreamDefaultController<Uint8Array>,
		data: string,
	) {
		if (data === "[DONE]") {
			finish(controller);
			return;
		}
		let chunk: JsonObject;
		try {
			chunk = JSON.parse(data) as JsonObject;
		} catch {
			return;
		}
		if (chunk.usage) state.usage = chunk.usage;
		const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
		for (const rawChoice of choices) {
			const choice = asObject(rawChoice);
			const delta = asObject(choice?.delta);
			if (!delta) continue;
			const text = asString(delta.content);
			if (text) {
				const target = ensureText(controller);
				target.value += text;
				emit(controller, "response.output_text.delta", {
					output_index: target.outputIndex,
					content_index: 0,
					item_id: target.id,
					delta: text,
					logprobs: [],
				});
			}

			const reasoning =
				asString(delta.reasoning_content) ?? asString(delta.reasoning);
			if (reasoning) {
				const target = ensureReasoning(controller);
				target.value += reasoning;
				emit(controller, "response.reasoning_text.delta", {
					output_index: target.outputIndex,
					content_index: 0,
					item_id: target.id,
					delta: reasoning,
				});
			}

			if (Array.isArray(delta.tool_calls)) {
				for (const rawCall of delta.tool_calls) {
					const call = asObject(rawCall);
					const index = Number(call?.index ?? 0);
					const tool = ensureTool(controller, Number.isInteger(index) ? index : 0, asString(call?.id) ?? undefined);
					const fn = asObject(call?.function);
					const name = asString(fn?.name);
					if (name) tool.name = name;
					const argumentsDelta = asString(fn?.arguments);
					if (argumentsDelta) {
						tool.arguments += argumentsDelta;
						emit(controller, "response.function_call_arguments.delta", {
							output_index: tool.outputIndex,
							item_id: tool.id,
							delta: argumentsDelta,
						});
					}
				}
			}
			if (choice?.finish_reason != null) {
				state.finishReason = asString(choice.finish_reason);
			}
		}
	}

	function processFrame(
		controller: TransformStreamDefaultController<Uint8Array>,
		frame: string,
	) {
		const data = frame
			.split("\n")
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trimStart())
			.join("\n")
			.trim();
		if (data) processData(controller, data);
	}

	return new TransformStream<Uint8Array, Uint8Array>({
		start(controller) {
			start(controller);
		},
		transform(chunk, controller) {
			start(controller);
			buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
			while (true) {
				const end = buffer.indexOf("\n\n");
				if (end < 0) break;
				const frame = buffer.slice(0, end);
				buffer = buffer.slice(end + 2);
				processFrame(controller, frame);
			}
		},
		flush(controller) {
			if (buffer.trim()) processFrame(controller, buffer);
			finish(controller);
		},
	});
}
