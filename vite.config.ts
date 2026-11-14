// vite.config.ts — the shell's build (docs/spa.md).
//
// One page: index.html loads src/main.tsx, which brings in the shell's
// libraries (lib/*.js, still framework-free: the game frames inline some of
// them too) and renders the views in Solid. `base: "./"` because the site
// lives under /games/ on Pages and must also work from any folder.
// scripts/assemble.mjs then copies what is served as-is (games, sdk, lib for
// the frames, assets, the community catalog) beside the build and writes
// the service worker from what is there.
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
	base: "./",
	plugins: [solid()],
	// Static files are copied by scripts/assemble.mjs, not Vite's public dir.
	publicDir: false,
	build: {
		outDir: "dist",
		emptyOutDir: true,
		target: "es2022",
		manifest: true,
		// Named "app" so they never collide with the repo's own assets/.
		assetsDir: "app",
		rollupOptions: { input: "index.html" },
	},
	server: { port: 8000, strictPort: true },
});
