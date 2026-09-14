import { ApiError } from "../../shared/errors";

const IMAGE_PREFIX = "generated/";
const DEFAULT_TTL_SECONDS = 24 * 60 * 60;
const MIN_TTL_SECONDS = 5 * 60;
const MAX_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

interface ImageUrlReference {
	parent: Record<string, unknown>;
	value: string;
}

function isHttpUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

function isImageUrlPath(path: string[]): boolean {
	return (
		path[0] === "data" || path.includes("images") || path.includes("image_url")
	);
}

function findImageUrlReferences(
	value: unknown,
	path: string[] = [],
	refs: ImageUrlReference[] = [],
): ImageUrlReference[] {
	if (Array.isArray(value)) {
		value.forEach((item, index) => {
			findImageUrlReferences(item, [...path, String(index)], refs);
		});
		return refs;
	}

	if (!value || typeof value !== "object") return refs;

	for (const [key, child] of Object.entries(value)) {
		if (
			key === "url" &&
			typeof child === "string" &&
			isHttpUrl(child) &&
			isImageUrlPath(path)
		) {
			refs.push({ parent: value as Record<string, unknown>, value: child });
			continue;
		}
		findImageUrlReferences(child, [...path, key], refs);
	}

	return refs;
}

function ttlSeconds(raw: string | undefined): number {
	const value = Number(raw);
	if (!Number.isFinite(value)) return DEFAULT_TTL_SECONDS;
	return Math.min(
		MAX_TTL_SECONDS,
		Math.max(MIN_TTL_SECONDS, Math.floor(value)),
	);
}

function mediaUrl(requestUrl: string, objectName: string): string {
	const url = new URL(requestUrl);
	url.pathname = `/media/${encodeURIComponent(objectName)}`;
	url.search = "";
	return url.toString();
}

function contentTypeFor(response: Response, sourceUrl: string): string {
	const contentType = response.headers.get("content-type")?.split(";", 1)[0];
	if (contentType?.startsWith("image/")) return contentType;

	const extension = new URL(sourceUrl).pathname.split(".").pop()?.toLowerCase();
	const byExtension: Record<string, string> = {
		avif: "image/avif",
		gif: "image/gif",
		jpeg: "image/jpeg",
		jpg: "image/jpeg",
		png: "image/png",
		webp: "image/webp",
	};
	return byExtension[extension ?? ""] ?? "application/octet-stream";
}

async function storeImage(
	bucket: R2Bucket,
	sourceUrl: string,
	requestUrl: string,
	ttl: number,
): Promise<string> {
	const source = await fetch(sourceUrl, {
		headers: { Accept: "image/*" },
	});
	if (!source.ok) {
		throw new ApiError(
			"Failed to retrieve generated image from upstream",
			502,
			"upstream_error",
			"image_proxy_fetch_failed",
		);
	}

	const contentLength = Number(source.headers.get("content-length"));
	if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_BYTES) {
		throw new ApiError(
			"Generated image exceeds the proxy size limit",
			502,
			"upstream_error",
			"image_proxy_size_exceeded",
		);
	}

	const body = await source.arrayBuffer();
	if (body.byteLength > MAX_IMAGE_BYTES) {
		throw new ApiError(
			"Generated image exceeds the proxy size limit",
			502,
			"upstream_error",
			"image_proxy_size_exceeded",
		);
	}

	const expiresAt = Date.now() + ttl * 1000;
	const objectName = `${expiresAt}-${crypto.randomUUID()}`;
	await bucket.put(`${IMAGE_PREFIX}${objectName}`, body, {
		httpMetadata: {
			contentType: contentTypeFor(source, sourceUrl),
			cacheControl: `public, max-age=${ttl}, immutable`,
		},
		customMetadata: { expiresAt: String(expiresAt) },
	});

	return mediaUrl(requestUrl, objectName);
}

/** Replace upstream image URLs with opaque, short-lived Keyloom URLs. */
export async function proxyImageResponse(
	response: Response,
	bucket: R2Bucket | undefined,
	requestUrl: string,
	configuredTtl?: string,
): Promise<Response> {
	const contentType = response.headers.get("content-type") || "";
	if (!contentType.includes("application/json")) return response;

	const body = await response
		.clone()
		.json()
		.catch(() => null);
	if (!body || typeof body !== "object") return response;

	const refs = findImageUrlReferences(body);
	if (refs.length === 0) return response;
	if (!bucket) {
		throw new ApiError(
			"Image proxy storage is not configured",
			503,
			"service_unavailable",
			"image_proxy_not_configured",
		);
	}

	const replacements = new Map<string, string>();
	for (const ref of refs) {
		let replacement = replacements.get(ref.value);
		if (!replacement) {
			replacement = await storeImage(
				bucket,
				ref.value,
				requestUrl,
				ttlSeconds(configuredTtl),
			);
			replacements.set(ref.value, replacement);
		}
		ref.parent.url = replacement;
	}

	const headers = new Headers(response.headers);
	headers.set("Content-Type", "application/json");
	headers.delete("Content-Length");
	headers.delete("Content-Encoding");
	headers.delete("Content-Range");
	return new Response(JSON.stringify(body), {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

/** Remove expired generated images. Deletes are free in R2. */
export async function purgeExpiredImages(bucket: R2Bucket): Promise<number> {
	let cursor: string | undefined;
	let deleted = 0;
	const now = Date.now();

	do {
		const page = await bucket.list({
			prefix: IMAGE_PREFIX,
			limit: 1000,
			...(cursor ? { cursor } : {}),
		});
		const expired = page.objects
			.filter((object) => {
				const match = object.key.match(/^generated\/(\d+)-/);
				return match ? Number(match[1]) <= now : false;
			})
			.map((object) => object.key);

		for (const key of expired) {
			await bucket.delete(key);
			deleted++;
		}
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);

	return deleted;
}
