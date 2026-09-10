/** OpenAI Images API compatibility routes. */

import { Hono } from "hono";
import { BadRequestError } from "../shared/errors";
import type { AppEnv } from "../shared/types";
import {
	executeImageEdit,
	executeImageGeneration,
	type GatewayResult,
} from "./gateway";

const imagesRouter = new Hono<AppEnv>();

function providerIdsFromValue(value: unknown): string[] | undefined {
	const values = Array.isArray(value) ? value : value == null ? [] : [value];
	const ids = values
		.filter((item): item is string => typeof item === "string")
		.map((item) => item.trim())
		.filter(Boolean);
	return ids.length > 0 ? ids : undefined;
}

function addGatewayHeaders(
	response: Response,
	result: GatewayResult,
): Response {
	response.headers.set("x-request-id", result.requestId);
	response.headers.set("x-provider", result.providerId);
	response.headers.set("x-credential-id", result.credentialId);
	return response;
}

imagesRouter.post("/generations", async (c) => {
	let body: Record<string, unknown>;
	try {
		body = await c.req.json();
	} catch {
		throw new BadRequestError("Invalid JSON body");
	}

	const modelId = typeof body.model === "string" ? body.model.trim() : "";
	if (!modelId) throw new BadRequestError("model is required");
	if (typeof body.prompt !== "string" || !body.prompt.trim()) {
		throw new BadRequestError("prompt is required");
	}

	const { provider: rawProvider, ...rest } = body;
	const result = await executeImageGeneration(c, {
		modelId,
		body: rest,
		providerIds: providerIdsFromValue(rawProvider),
	});
	return addGatewayHeaders(result.response, result);
});

imagesRouter.post("/edits", async (c) => {
	let form: FormData;
	try {
		form = await c.req.raw.formData();
	} catch {
		throw new BadRequestError("Invalid multipart form data");
	}

	const modelId = form.get("model");
	if (typeof modelId !== "string" || !modelId.trim()) {
		throw new BadRequestError("model is required");
	}
	const prompt = form.get("prompt");
	if (typeof prompt !== "string" || !prompt.trim()) {
		throw new BadRequestError("prompt is required");
	}
	const image = form.get("image");
	if (!(image instanceof Blob)) {
		throw new BadRequestError("image file is required");
	}

	const providerIds = providerIdsFromValue(form.getAll("provider"));
	const forwarded = new FormData();
	for (const [key, value] of form.entries()) {
		if (key !== "provider") forwarded.append(key, value);
	}

	const result = await executeImageEdit(c, {
		modelId: modelId.trim(),
		body: forwarded,
		providerIds,
	});
	return addGatewayHeaders(result.response, result);
});

export default imagesRouter;
