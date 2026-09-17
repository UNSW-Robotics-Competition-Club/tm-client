import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["src/index.ts", "src/node.ts", "src/cli/main.ts"],
	format: ["esm"],
	dts: true,
	sourcemap: true,
	clean: true,
	target: "es2023",
	/**
	 * `ws` must stay external.
	 *
	 * tsup externalises `dependencies` and `peerDependencies` automatically but
	 * NOT `optionalDependencies`, so without this esbuild inlines `ws` into the
	 * bundle — and the inlined copy dies on `ws`'s conditional loading of its
	 * native `bufferutil` / `utf-8-validate` addons. The failure is invisible
	 * from source (tests import `src/` directly) and only appears in the built
	 * artifact, as `tm-cli send` reporting that `ws` could not be loaded.
	 *
	 * Keeping it external is also what makes it genuinely optional: a browser
	 * consumer resolving "." never reaches the dynamic import that names it.
	 */
	external: ["ws", "commander"],
	banner: { js: "" },
});
