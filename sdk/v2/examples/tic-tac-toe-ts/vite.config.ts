// One classic script, dist/tic-tac-toe.js: the shell inlines each <script>
// the page names into an opaque, offline frame, so the build is a single IIFE
// with nothing to import or preload (docs/sdk-v2.md, "The rules a game must
// follow").
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
	plugins: [solid()],
	// The adapter's `import "solid-js"` resolves from this folder's node_modules.
	resolve: { dedupe: ["solid-js"] },
	build: {
		lib: { entry: "src/main.tsx", formats: ["iife"], name: "ticTacToe", fileName: () => "tic-tac-toe.js" },
		outDir: "dist",
		emptyOutDir: true,
		copyPublicDir: false,
		minify: true,
		reportCompressedSize: true,
	},
});
