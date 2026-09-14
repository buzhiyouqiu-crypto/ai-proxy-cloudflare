import { enUS, zhCN } from "@clerk/localizations";
import {
	ClerkProvider,
	SignIn,
	SignUp,
	UserButton,
	useAuth as useClerkAuth,
	useUser,
} from "@clerk/react";
import { dark } from "@clerk/themes";
import { Crisp } from "crisp-sdk-web";
import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useMemo,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { Button, Input } from "./components/ui";
import { hasCrisp } from "./lib/analytics";

/** True when a real Clerk publishable key is baked in → Platform (multi-tenant) mode */
const clerkKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
export const isPlatform =
	typeof clerkKey === "string" && /^pk_(live|test)_/.test(clerkKey);

// ─── Unified Auth Context ───────────────────────────────

interface AuthContextType {
	getToken: () => Promise<string | null>;
	isLoaded: boolean;
	isSignedIn: boolean;
	/** null = not yet determined (loading), false = not admin, true = admin */
	isAdmin: boolean | null;
	signOut: () => void;
	/** Core mode only: sign in with admin token */
	signIn?: (token: string) => void;
}

const AuthContext = createContext<AuthContextType | null>(null);

const AdminOnlyModeContext = createContext<boolean | null>(null);

export function useAdminOnlyMode(): boolean | null {
	return useContext(AdminOnlyModeContext);
}

function AdminOnlyModeProvider({ children }: { children: ReactNode }) {
	const [adminOnly, setAdminOnly] = useState<boolean | null>(null);

	useEffect(() => {
		let active = true;
		fetch("/api/access-policy")
			.then(async (response) => {
				if (!response.ok) throw new Error("Failed to load access policy");
				const data = (await response.json()) as { adminOnly?: boolean };
				return data.adminOnly === true;
			})
			.then((value) => {
				if (active) setAdminOnly(value);
			})
			.catch(() => {
				// Fail closed if the policy cannot be loaded.
				if (active) setAdminOnly(true);
			});

		return () => {
			active = false;
		};
	}, []);

	return (
		<AdminOnlyModeContext.Provider value={adminOnly}>
			{children}
		</AdminOnlyModeContext.Provider>
	);
}

export function useAuth(): AuthContextType {
	const ctx = useContext(AuthContext);
	if (!ctx) throw new Error("useAuth must be used within <AuthProvider>");
	return ctx;
}

// ─── Core Auth (ADMIN_TOKEN, single tenant) ─────────────

function CoreAuthProvider({ children }: { children: ReactNode }) {
	const [token, setToken] = useState<string | null>(() =>
		localStorage.getItem("admin_token"),
	);
	const [isLoaded, setIsLoaded] = useState(() => !token);
	const [isAdmin, setIsAdmin] = useState<boolean | null>(() =>
		token ? null : false,
	);

	useEffect(() => {
		if (!token) {
			setIsAdmin(false);
			setIsLoaded(true);
			return;
		}

		let active = true;
		setIsLoaded(false);
		setIsAdmin(null);
		fetch("/api/me", {
			headers: { Authorization: `Bearer ${token}` },
		})
			.then(async (response) => {
				if (!response.ok) return false;
				const data = (await response.json()) as { isAdmin?: boolean };
				return data.isAdmin === true;
			})
			.then((valid) => {
				if (!active) return;
				if (!valid) {
					localStorage.removeItem("admin_token");
					setToken(null);
				}
				setIsAdmin(valid);
			})
			.catch(() => {
				if (!active) return;
				localStorage.removeItem("admin_token");
				setToken(null);
				setIsAdmin(false);
			})
			.finally(() => {
				if (active) setIsLoaded(true);
			});

		return () => {
			active = false;
		};
	}, [token]);

	const value = useMemo<AuthContextType>(
		() => ({
			getToken: async () => token,
			isLoaded,
			isSignedIn: !!token && isAdmin === true,
			isAdmin,
			signOut: () => {
				localStorage.removeItem("admin_token");
				setToken(null);
				setIsAdmin(false);
			},
			signIn: (t: string) => {
				localStorage.setItem("admin_token", t);
				setToken(t);
				setIsLoaded(false);
				setIsAdmin(null);
			},
		}),
		[isAdmin, isLoaded, token],
	);

	return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// ─── Platform Auth Bridge (Clerk → AuthContext) ─────────

function ClerkAuthBridge({ children }: { children: ReactNode }) {
	const clerk = useClerkAuth();
	const { user } = useUser();
	const [isAdmin, setIsAdmin] = useState<boolean | null>(null);

	useEffect(() => {
		if (!clerk.isSignedIn) {
			setIsAdmin(false);
			return;
		}
		clerk.getToken().then((t) => {
			if (!t) {
				setIsAdmin(false);
				return;
			}
			fetch("/api/me", { headers: { Authorization: `Bearer ${t}` } })
				.then((r) => r.json())
				.then((d: { isAdmin?: boolean }) => setIsAdmin(!!d.isAdmin))
				.catch(() => setIsAdmin(false));
		});
	}, [clerk.isSignedIn, clerk.getToken]);

	useEffect(() => {
		if (!hasCrisp || !user) return;
		const email = user.primaryEmailAddress?.emailAddress;
		if (email) Crisp.user.setEmail(email);
		const name = user.fullName || user.firstName;
		if (name) Crisp.user.setNickname(name);
		Crisp.session.setData({ clerk_user_id: user.id });
	}, [user]);

	const value = useMemo<AuthContextType>(
		() => ({
			getToken: () => clerk.getToken(),
			isLoaded: clerk.isLoaded,
			isSignedIn: clerk.isSignedIn ?? false,
			isAdmin,
			signOut: () => {
				if (hasCrisp) Crisp.session.reset();
				clerk.signOut();
			},
		}),
		[clerk.getToken, clerk.isLoaded, clerk.isSignedIn, clerk.signOut, isAdmin],
	);

	return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// ─── Dark Mode Detection ────────────────────────────────

function useDarkMode() {
	const [isDark, setIsDark] = useState(() =>
		document.documentElement.classList.contains("dark"),
	);

	useEffect(() => {
		const observer = new MutationObserver(() => {
			setIsDark(document.documentElement.classList.contains("dark"));
		});
		observer.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ["class"],
		});
		return () => observer.disconnect();
	}, []);

	return isDark;
}

// ─── AuthProvider (auto-selects by env) ─────────────────

const clerkLocales: Record<string, typeof enUS> = { en: enUS, zh: zhCN };

export function AuthProvider({ children }: { children: ReactNode }) {
	const isDark = useDarkMode();
	const { i18n } = useTranslation();

	if (isPlatform) {
		return (
			<AdminOnlyModeProvider>
				<ClerkProvider
					publishableKey={import.meta.env.VITE_CLERK_PUBLISHABLE_KEY}
					signInUrl="/login"
					signUpUrl="/signup"
					afterSignOutUrl="/login"
					signInFallbackRedirectUrl="/dashboard"
					signUpFallbackRedirectUrl="/dashboard"
					localization={clerkLocales[i18n.language] ?? enUS}
					appearance={{
						baseTheme: isDark ? dark : undefined,
						options: { socialButtonsVariant: "blockButton" },
						elements: {
							socialButtons: {
								display: "flex",
								flexDirection: "column",
								gap: "12px",
							},
							socialButtonsBlockButton: {
								width: "100%",
							},
						},
					}}
				>
					<ClerkAuthBridge>{children}</ClerkAuthBridge>
				</ClerkProvider>
			</AdminOnlyModeProvider>
		);
	}
	return (
		<AdminOnlyModeProvider>
			<CoreAuthProvider>{children}</CoreAuthProvider>
		</AdminOnlyModeProvider>
	);
}

// ─── AuthGuard ──────────────────────────────────────────

export function AuthSkeleton() {
	return (
		<div>
			{/* Sidebar skeleton — matches BaseSidebarLayout (w-64, top-14) */}
			<div className="hidden lg:fixed lg:inset-y-0 lg:top-14 lg:z-40 lg:flex lg:w-64 lg:flex-col">
				<div className="flex grow flex-col gap-y-3 border-r border-gray-200 bg-white px-6 pt-6 dark:border-white/10 dark:bg-black/10">
					{Array.from({ length: 5 }).map((_, i) => (
						<div
							// biome-ignore lint/suspicious/noArrayIndexKey: static skeleton
							key={i}
							className="h-9 rounded-lg bg-gray-100 dark:bg-white/5 animate-pulse"
						/>
					))}
				</div>
			</div>
			{/* Content area — matches BaseSidebarLayout (pt-14, pl-64, px/py) */}
			<main className="min-h-dvh pt-14 lg:pl-64">
				<div className="px-4 py-8 sm:px-6 lg:px-8">
					<div className="h-6 w-40 rounded bg-gray-200 dark:bg-white/10 animate-pulse" />
					<div className="mt-2 h-4 w-64 rounded bg-gray-100 dark:bg-white/5 animate-pulse" />
				</div>
			</main>
		</div>
	);
}

export function AuthGuard({
	children,
	fallback,
}: {
	children: ReactNode;
	fallback: ReactNode;
}) {
	const { isLoaded, isSignedIn } = useAuth();
	if (!isLoaded) return <AuthSkeleton />;
	return <>{isSignedIn ? children : fallback}</>;
}

/**
 * Platform users can still use a provisioned downstream API key, but only
 * the configured owner is allowed to open the management UI.
 */
export function AdminOnlyNotice() {
	const { signOut } = useAuth();

	return (
		<div className="flex min-h-dvh items-center justify-center px-6 py-16">
			<div className="w-full max-w-md rounded-2xl border border-gray-200 bg-white p-8 text-center shadow-sm dark:border-white/10 dark:bg-white/5">
				<h1 className="text-xl font-semibold text-gray-900 dark:text-white">
					API-only access
				</h1>
				<p className="mt-3 text-sm leading-6 text-gray-500 dark:text-gray-400">
					This account cannot access the management pages. Use a valid Keyloom
					API key to call the API, or sign in with the administrator account.
				</p>
				<Button type="button" variant="secondary" className="mt-6" onClick={signOut}>
					Sign out
				</Button>
			</div>
		</div>
	);
}

// ─── LoginPage ──────────────────────────────────────────

function CoreLoginForm() {
	const { signIn } = useAuth();
	const [token, setToken] = useState("");

	return (
		<form
			onSubmit={(e) => {
				e.preventDefault();
				if (token.trim()) signIn?.(token.trim());
			}}
			className="sm:mx-auto sm:w-full sm:max-w-sm flex flex-col gap-4"
		>
			<Input
				type="password"
				placeholder="Admin Token"
				value={token}
				onChange={(e) => setToken(e.target.value)}
			/>
			<Button type="submit" className="w-full">
				Sign In
			</Button>
		</form>
	);
}

export function LoginContent() {
	if (isPlatform) return <SignIn routing="path" path="/login" />;
	return <CoreLoginForm />;
}

export function SignupContent() {
	if (isPlatform) return <SignUp routing="path" path="/signup" />;
	return <CoreLoginForm />;
}

// ─── UserMenu (sidebar) ────────────────────────────────

function CoreUserMenu() {
	const { signOut } = useAuth();
	return (
		<button
			type="button"
			onClick={signOut}
			className="rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs font-medium text-gray-500 transition-colors hover:bg-gray-100 dark:border-white/10 dark:text-gray-400 dark:hover:bg-white/10"
		>
			Sign Out
		</button>
	);
}

export function UserMenu() {
	return isPlatform ? <UserButton /> : <CoreUserMenu />;
}
