import { DurableObject } from "cloudflare:workers";

/**
 * Compatibility export for the Durable Object used by the previous worker.
 * Keyaos no longer routes requests through this object, but Cloudflare keeps
 * existing Durable Object instances tied to the class name.
 */
export class UsageDbDurableObject extends DurableObject {
	async fetch(): Promise<Response> {
		return new Response("UsageDbDurableObject is retired", { status: 410 });
	}
}
