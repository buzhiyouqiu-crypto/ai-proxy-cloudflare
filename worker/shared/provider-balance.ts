import type {
	ProviderBalanceSnapshot,
	ProviderCredits,
} from "../core/providers/interface";

/** The existing metadata column is also used by custom-channel configuration. */
export function readBalanceSnapshot(
	metadata: string | null,
): ProviderBalanceSnapshot | null {
	if (!metadata) return null;
	try {
		const value = JSON.parse(metadata) as Record<string, unknown>;
		const balance = value.balance;
		if (!balance || typeof balance !== "object") return null;
		const snapshot = balance as Partial<ProviderBalanceSnapshot>;
		if (typeof snapshot.updatedAt !== "number") return null;
		if (snapshot.remaining !== null && typeof snapshot.remaining !== "number") {
			return null;
		}
		return snapshot as ProviderBalanceSnapshot;
	} catch {
		return null;
	}
}

export function writeBalanceSnapshot(
	metadata: string | null,
	credits: ProviderCredits,
): string {
	let value: Record<string, unknown> = {};
	if (metadata) {
		try {
			const parsed = JSON.parse(metadata);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				value = parsed as Record<string, unknown>;
			}
		} catch {
			// Preserve a valid balance snapshot even if old metadata was malformed.
		}
	}

	const snapshot: ProviderBalanceSnapshot = {
		remaining: credits.remaining,
		usage: credits.usage,
		currency: credits.currency,
		unit: credits.unit,
		display: credits.display,
		details: credits.details,
		updatedAt: Date.now(),
	};
	value.balance = snapshot;
	return JSON.stringify(value);
}

export function isMonetaryBalance(
	credits: ProviderCredits,
	providerCurrency: "USD" | "CNY",
): boolean {
	if (credits.unit && !["USD", "CNY"].includes(credits.unit.toUpperCase())) {
		return false;
	}
	return (
		(credits.currency ?? providerCurrency) === "USD" ||
		(credits.currency ?? providerCurrency) === "CNY"
	);
}
