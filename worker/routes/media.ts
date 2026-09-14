import { Hono } from "hono";
import type { AppEnv } from "../shared/types";

const mediaRouter = new Hono<AppEnv>();

mediaRouter.get("/:objectName", async (c) => {
	const objectName = c.req.param("objectName");
	if (!/^\d+-[0-9a-f-]{36}$/i.test(objectName)) return c.notFound();

	const bucket = c.env.IMAGE_BUCKET;
	if (!bucket) return c.notFound();

	const object = await bucket.get(`generated/${objectName}`);
	if (!object) return c.notFound();

	const expiresAt = Number(object.customMetadata?.expiresAt);
	if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
		await bucket.delete(`generated/${objectName}`);
		return c.notFound();
	}

	const headers = new Headers();
	object.writeHttpMetadata(headers);
	headers.set("ETag", object.httpEtag);
	headers.set(
		"Cache-Control",
		headers.get("Cache-Control") || "public, max-age=300",
	);
	headers.set("X-Content-Type-Options", "nosniff");
	return new Response(object.body, { headers });
});

export default mediaRouter;
