import { clerkMiddleware, getAuth } from "@hono/clerk-auth";
import { type Context, Hono, type Next } from "hono";
import { cors } from "hono/cors";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ApiKeysDao } from "./core/db/api-keys-dao";
import { CandleDao } from "./core/db/candle-dao";
import {
	syncAllModels,
	syncAutoCredits,
	syncFromRemote,
} from "./core/sync/sync-service";
import { sweepAutoTopUp } from "./platform/billing/auto-topup-service";
import adminRouter from "./platform/routes/admin";
import creditsRouter, { webhookRouter } from "./platform/routes/credits";
import apiKeysRouter from "./routes/api-keys";
import assistantRouter from "./routes/assistant";
import chatRouter from "./routes/chat";
import credentialsRouter from "./routes/credentials";
import embeddingsRouter from "./routes/embeddings";
import messagesRouter from "./routes/messages";
import {
	catalogRouter,
	dashboardModelsRouter,
	publicModelsRouter,
} from "./routes/models";
import systemRouter from "./routes/system";
import threadsRouter from "./routes/threads";
import { sha256 } from "./shared/crypto";
import {
	ApiError,
	AuthenticationError,
	IpNotAllowedError,
	KeyExpiredError,
	KeyQuotaExceededError,
} from "./shared/errors";
import { log } from "./shared/logger";
import type { AppEnv, Env } from "./shared/types";

const CORE_OWNER = "self";
const DEFAULT_CORS_ORIGIN = "https://keyloom.cc.cd";
const DEFAULT_BODY_LIMIT = 2 * 1024 * 1024;
const CHAT_BODY_LIMIT = 10 * 1024 * 1024;

const app = new Hono<AppEnv>();

app.onError((err, c) => {
	if (err instanceof ApiError) {
		const level = err.statusCode >= 500 ? "error" : "warn";
		log[level]("api", err.message, {
			status: err.statusCode,
			type: err.type,
			code: err.code,
			path: c.req.path,
		});
		return c.json(err.toJSON(), err.statusCode as ContentfulStatusCode);
	}
	log.error("unhandled", err instanceof Error ? err.message : String(err), {
		path: c.req.path,
		stack: err instanceof Error ? err.stack : undefined,
	});
	return c.json(
		{ error: { message: "Internal server error", type: "server_error" } },
		500,
	);
});

app.use(
	"*",
	cors({
		origin: (origin, c) => {
			// The OpenAI-compatible API is intentionally usable from browser
			// clients. Management endpoints, however, should only be callable
			// cross-origin by the deployed Keyloom frontend.
			if (c.req.path.startsWith("/v1/")) return origin || null;
			return origin === (c.env.CORS_ORIGIN || DEFAULT_CORS_ORIGIN)
				? origin
				: null;
		},
		allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
		allowHeaders: [
			"Content-Type",
			"Authorization",
			"x-api-key",
			"anthropic-version",
			"x-keyaos-depth",
		],
		exposeHeaders: ["x-request-id", "x-provider", "x-credential-id"],
	}),
);

function requestBodyLimit(path: string): number {
	return path === "/api/chat" ||
		path === "/api/threads" ||
		path.startsWith("/api/threads/") ||
		path === "/v1/chat/completions" ||
		path === "/v1/messages" ||
		path === "/v1/embeddings"
		? CHAT_BODY_LIMIT
		: DEFAULT_BODY_LIMIT;
}

async function enforceRequestBodyLimit(c: Context<AppEnv>, next: Next) {
	if (["GET", "HEAD", "OPTIONS"].includes(c.req.method)) return next();

	const limit = requestBodyLimit(c.req.path);
	const contentLength = c.req.header("content-length");
	if (contentLength) {
		const bytes = Number(contentLength);
		if (!Number.isSafeInteger(bytes) || bytes > limit) {
			return c.json(
				{
					error: {
						message: `Request body exceeds ${Math.floor(limit / 1024 / 1024)} MiB limit`,
						type: "invalid_request_error",
						code: "request_body_too_large",
					},
				},
				413,
			);
		}
	}

	// Content-Length is optional for chunked requests. Inspect a clone so the
	// route can still consume the original body, while stopping as soon as the
	// configured limit is crossed.
	const clonedBody = c.req.raw.clone().body;
	if (!clonedBody) return next();
	const reader = clonedBody.getReader();
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > limit) {
				await reader.cancel();
				return c.json(
					{
						error: {
							message: `Request body exceeds ${Math.floor(limit / 1024 / 1024)} MiB limit`,
							type: "invalid_request_error",
							code: "request_body_too_large",
						},
					},
					413,
				);
			}
		}
	} finally {
		reader.releaseLock();
	}
	return next();
}

app.use("/api/*", enforceRequestBodyLimit);
app.use("/v1/*", enforceRequestBodyLimit);

// Baseline response hardening. These headers are safe for the SPA and API
// responses and prevent MIME sniffing, referrer leakage, and unnecessary
// browser capability exposure.
app.use("*", async (c, next) => {
	await next();
	c.header("X-Content-Type-Options", "nosniff");
	c.header("Referrer-Policy", "strict-origin-when-cross-origin");
	c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
	if (new URL(c.req.url).protocol === "https:") {
		c.header(
			"Strict-Transport-Security",
			"max-age=31536000; includeSubDomains",
		);
	}
});

app.get("/health", (c) => c.json({ status: "ok" }));

// ─── Auth: Management API (/api/*) ─────────────────────
app.use("/api/*", async (c, next) => {
	if (c.req.path.startsWith("/api/webhooks/")) return next();
	if (
		c.req.method === "GET" &&
		((c.req.path === "/api/providers" && c.req.query("all") !== "1") ||
			c.req.path === "/api/models" ||
			c.req.path === "/api/catalog" ||
			c.req.path.startsWith("/api/sparklines/") ||
			c.req.path.startsWith("/api/candles/"))
	)
		return next();

	if (c.env.CLERK_SECRET_KEY) {
		await clerkMiddleware()(c, async () => {});
		const auth = getAuth(c);
		if (auth?.userId) {
			c.set("owner_id", auth.userId);
			return next();
		}
		throw new AuthenticationError("Invalid or missing Clerk session");
	}

	const token = c.req
		.header("Authorization")
		?.replace(/^Bearer\s+/i, "")
		.trim();
	if (!token || token !== c.env.ADMIN_TOKEN) {
		throw new AuthenticationError("Invalid or missing admin token");
	}
	c.set("owner_id", CORE_OWNER);
	return next();
});

// ─── Auth: Downstream API (/v1/*) ──────────────────────
app.use("/v1/*", async (c, next) => {
	const token =
		c.req
			.header("Authorization")
			?.replace(/^Bearer\s+/i, "")
			.trim() || c.req.header("x-api-key")?.trim();
	if (!token) throw new AuthenticationError("Missing authorization token");

	const keyHash = await sha256(token);
	const key = await new ApiKeysDao(c.env.DB, c.env.ENCRYPTION_KEY).getByHash(
		keyHash,
	);
	if (key?.is_enabled === 1) {
		if (key.expires_at && key.expires_at <= Date.now()) {
			throw new KeyExpiredError();
		}
		if (key.quota_limit != null && key.quota_used >= key.quota_limit) {
			throw new KeyQuotaExceededError();
		}
		if (key.allowed_ips) {
			const clientIp =
				c.req.header("cf-connecting-ip") ||
				c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
			const allowed: string[] = JSON.parse(key.allowed_ips);
			if (clientIp && allowed.length > 0 && !allowed.includes(clientIp)) {
				throw new IpNotAllowedError();
			}
		}
		c.set("owner_id", key.owner_id);
		c.set("api_key_id", key.id);
		if (key.allowed_models) {
			c.set("allowed_models", JSON.parse(key.allowed_models) as string[]);
		}
		return next();
	}

	if (c.env.CLERK_SECRET_KEY) {
		try {
			await clerkMiddleware()(c, async () => {});
			const auth = getAuth(c);
			if (auth?.userId) {
				c.set("owner_id", auth.userId);
				return next();
			}
		} catch {
			// Not a valid Clerk JWT — fall through
		}
	}

	if (token === c.env.ADMIN_TOKEN) {
		c.set("owner_id", CORE_OWNER);
		return next();
	}

	throw new AuthenticationError("Invalid or inactive authentication");
});

// ─── Management API ─────────────────────────────────────
app.route("/api/credentials", credentialsRouter);
app.route("/api/api-keys", apiKeysRouter);
app.route("/api/models", dashboardModelsRouter);
app.route("/api/catalog", catalogRouter);
app.route("/api", systemRouter);

app.route("/api/chat", assistantRouter);
app.route("/api/threads", threadsRouter);

// ─── Platform-only routes (gated at request time) ───────
const platformNotFound = (c: Context) =>
	c.json(
		{ error: { message: "Not Found", type: "invalid_request_error" } },
		404,
	);

app.use("/api/credits/*", async (c, next) =>
	c.env.CLERK_SECRET_KEY ? next() : platformNotFound(c),
);
app.route("/api/credits", creditsRouter);

app.use("/api/admin/*", async (c, next) =>
	c.env.PLATFORM_OWNER_ID ? next() : platformNotFound(c),
);
app.route("/api/admin", adminRouter);

app.use("/api/webhooks/*", async (c, next) =>
	c.env.STRIPE_WEBHOOK_SECRET ? next() : platformNotFound(c),
);
app.route("/api/webhooks", webhookRouter);

// ─── OpenAI-compatible API ──────────────────────────────
app.route("/v1/chat", chatRouter);
app.route("/v1/embeddings", embeddingsRouter);
app.route("/v1/models", publicModelsRouter);

app.get("/v1/credits", async (c) => {
	const { WalletDao } = await import("./platform/billing/wallet-dao");
	const balance = await new WalletDao(c.env.DB).getBalance(c.get("owner_id"));
	return c.json({ data: { balance } });
});

// ─── Anthropic-compatible API ───────────────────────────
app.route("/v1/messages", messagesRouter);

// ─── SPA Fallback ───────────────────────────────────────
app.notFound(async (c) => {
	if (c.req.path.startsWith("/api/") || c.req.path.startsWith("/v1/")) {
		return c.json(
			{ error: { message: "Not Found", type: "invalid_request_error" } },
			404,
		);
	}
	if (c.env.ASSETS) {
		try {
			const res = await c.env.ASSETS.fetch(c.req.raw);
			if (res.status === 404) {
				const url = new URL(c.req.url);
				url.pathname = "/";
				return c.env.ASSETS.fetch(new Request(url.toString(), c.req.raw));
			}
			return res;
		} catch {
			// Ignore ASSETS errors
		}
	}
	return c.text("Not Found", 404);
});

export default {
	fetch: app.fetch,

	async scheduled(
		event: ScheduledEvent,
		env: Env,
		ctx: ExecutionContext,
	): Promise<void> {
		const candleDao = new CandleDao(env.DB);
		const rate = Number.parseFloat(env.CNY_USD_RATE || "7");

		ctx.waitUntil(
			event.cron === "0 */6 * * *"
				? (async () => {
						if (env.LOCAL_SYNC) {
							await syncAllModels(env.DB, rate, env);
						} else {
							await syncFromRemote(env.DB);
						}
						await syncAutoCredits(env.DB, env.ENCRYPTION_KEY, rate);
						await candleDao.pruneOldCandles();
					})()
				: (async () => {
						await candleDao.aggregate(Date.now() - 60_000);
						await sweepAutoTopUp(env.DB, env.STRIPE_SECRET_KEY);
					})(),
		);
	},
};

// Keep the old class export so existing Durable Object instances can be
// updated safely when this Worker replaces the previous implementation.
export { UsageDbDurableObject } from "./compat/usage-db";
