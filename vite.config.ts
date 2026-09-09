import { cloudflare } from "@cloudflare/vite-plugin";
import mdx from "@mdx-js/rollup";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import remarkGfm from "remark-gfm";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [
		cloudflare(),
		tailwindcss(),
		{ enforce: "pre", ...mdx({ remarkPlugins: [remarkGfm] }) },
		react(),
	],
	resolve: {
		alias: {
			"@": "/src",
		},
	},
	define: {
		"process.env.NEXT_PUBLIC_SHOW_DEVTOOLS": JSON.stringify("false"),
		"process.env.NEXT_PUBLIC_APP_VERSION": JSON.stringify("0.0.0"),
		"process.env.NEXT_PUBLIC_WATCHA_CLIENT_ID": JSON.stringify(""),
		"process.env.WATCHA_CLIENT_SECRET": JSON.stringify(""),
	},
	server: {
		port: 5173,
	},
});
