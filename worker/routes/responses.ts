/**
 * OpenAI Responses API — POST /v1/responses
 *
 * Responses requests are translated to the gateway's internal Chat
 * Completions shape, then translated back on the way out. This keeps model
 * routing, failover, usage accounting, and billing in one code path.
 */

import { Hono } from "hono";
import {
	createOpenAIToResponsesStream,
	toChatRequest,
	toResponsesResponse,
} from "../core/protocols/responses";
import { BadRequestError } from "../shared/errors";
import type { AppEnv } from "../shared/types";
import { executeCompletion } from "./gateway";

const responsesRouter = new Hono<AppEnv>();

responsesRouter.post("/", async (c) => {
	let body: Record<string, unknown>;
	try {
		body = await c.req.json();
	} catch {
		throw new BadRequestError("Invalid JSON body");
	}

	const modelId = typeof body.model === "string" ? body.model : "";
	if (!modelId) throw new BadRequestError("model is required");

	const { provider: rawProvider, ...rest } = body;
	const providerIds = rawProvider
		? Array.isArray(rawProvider)
			? rawProvider.filter((value): value is string => typeof value === "string")
			: typeof rawProvider === "string"
				? [rawProvider]
				: undefined
		: undefined;

	const result = await executeCompletion(c, {
		modelId,
		body: toChatRequest(rest),
		providerIds,
	});

	const meta = {
		"x-request-id": result.requestId,
		"x-provider": result.providerId,
		"x-credential-id": result.credentialId,
	};
	const contentType = result.response.headers.get("content-type") || "";

	if (contentType.includes("text/event-stream")) {
		if (!result.response.body) return c.text("", 502);

		return new Response(
			result.response.body.pipeThrough(createOpenAIToResponsesStream(modelId)),
			{
				status: 200,
				headers: {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
					...meta,
				},
			},
		);
	}

	const openaiJson = (await result.response.json()) as Record<string, unknown>;
	return new Response(
		JSON.stringify(toResponsesResponse(openaiJson, rest)),
		{
			status: 200,
			headers: { "Content-Type": "application/json", ...meta },
		},
	);
});

export default responsesRouter;
