import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * The rule that matters here is the last one.
 *
 * This package is isomorphic: the core must run in a browser, a Worker, Bun and
 * Deno, not just Node. Nothing enforces that at runtime until someone's bundle
 * breaks, and by then the offending import is three files deep and months old.
 * So the boundary is a lint error instead.
 *
 * Exactly three places may reach for Node or npm:
 *   - `src/cli/**`     — the CLI is a Node binary by definition
 *   - `src/ws/node.ts` — the one file allowed to load `ws`, via dynamic import
 *   - `test/**`        — tests may use `node:http`, `node:crypto`, anything
 */
export default tseslint.config(
	{ ignores: ["dist/**", "node_modules/**"] },
	js.configs.recommended,
	...tseslint.configs.recommended,
	{
		files: ["src/**/*.ts"],
		rules: {
			"no-restricted-imports": [
				"error",
				{
					// `patterns` entries are globs, so they match relative specifiers
					// too: a bare `ws` group also flags `./ws/types.js`, which is a
					// pure type file with no dependency on the package at all. A ban
					// on a package NAME belongs in `paths`, which matches the exact
					// specifier and nothing else.
					patterns: [
						{
							group: ["node:*"],
							message:
								"The isomorphic core cannot import Node built-ins. Only src/cli/** and src/ws/node.ts may, and src/ws/node.ts must use a dynamic import().",
						},
					],
					paths: [
						{
							name: "ws",
							message:
								"Only src/ws/node.ts may load `ws`, and only via `await import(\"ws\")` inside a function — a top-level import drags it into every browser bundle.",
						},
						{
							name: "commander",
							message: "commander belongs to the CLI. Keep it out of the importable library.",
						},
					],
				},
			],
		},
	},
	{
		files: ["src/cli/**/*.ts", "src/ws/node.ts"],
		rules: { "no-restricted-imports": "off" },
	},
	{
		files: ["test/**/*.ts", "test/**/*.mjs", "*.ts", "*.js"],
		rules: {
			"no-restricted-imports": "off",
			"@typescript-eslint/no-explicit-any": "off",
		},
	},
);
