import mdx from "@mdx-js/rollup";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import remarkGfm from "remark-gfm";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		tailwindcss(),
		{ enforce: "pre", ...mdx({ remarkPlugins: [remarkGfm] }) },
		react(),
	],
	resolve: {
		alias: {
			"@": "/src",
		},
	},
	test: {
		include: ["src/**/*.{test,spec}.{ts,tsx}"],
		exclude: ["tests/e2e/**", "node_modules/**", "references/**"],
		passWithNoTests: true,
	},
});
