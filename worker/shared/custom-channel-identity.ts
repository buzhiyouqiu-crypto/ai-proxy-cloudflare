import { decrypt, encrypt } from "./crypto";

export const CUSTOM_PROVIDER_ID = "custom";
export const CUSTOM_CHANNEL_PREFIX = "custom:";
export const PUBLIC_CUSTOM_CHANNEL_PREFIX = "custom:public-";

/**
 * A stable, non-sensitive public label for a custom channel.
 *
 * The credential id is never shown directly. The numeric suffix is only an
 * opaque display identifier; it is not used as a credential selector.
 */
export function publicCustomChannelSuffix(channelId: string): string {
	let hash = 2166136261;
	for (let i = 0; i < channelId.length; i++) {
		hash ^= channelId.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return String((hash >>> 0) % 1_000_000).padStart(6, "0");
}

export function publicCustomChannelName(channelId: string): string {
	return `自定义渠道${publicCustomChannelSuffix(channelId)}`;
}

export function publicCustomChannelProviderId(channelId: string): string {
	return `${PUBLIC_CUSTOM_CHANNEL_PREFIX}${publicCustomChannelSuffix(channelId)}`;
}

export function isPublicCustomChannelProviderId(providerId: string): boolean {
	return providerId.startsWith(PUBLIC_CUSTOM_CHANNEL_PREFIX);
}

export interface StoredCustomChannelIdentity {
	name?: string | null;
	nameCiphertext?: string | null;
}

export async function encryptCustomChannelName(
	name: string,
	encryptionKey: string,
): Promise<string> {
	return encrypt(name.trim(), encryptionKey);
}

/**
 * Resolve a channel name only on the server. Legacy records may still have a
 * plaintext name; new records store the public alias plus this ciphertext.
 */
export async function resolveCustomChannelName(
	identity: StoredCustomChannelIdentity | null | undefined,
	channelId: string,
	encryptionKey: string,
): Promise<string> {
	if (identity?.nameCiphertext) {
		try {
			const name = await decrypt(identity.nameCiphertext, encryptionKey);
			if (name.trim()) return name.trim();
		} catch {
			// Fall through to the safe public alias if the ciphertext is invalid.
		}
	}

	const legacyName = identity?.name?.trim();
	if (legacyName && !/^自定义渠道\d+$/.test(legacyName)) return legacyName;
	return publicCustomChannelName(channelId);
}
