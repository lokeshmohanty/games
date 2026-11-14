// arcade-c.js — the page glue for a managed game written in C or C++
// (sdk/v2/adapters/c). It knows no rules: it starts the Emscripten module
// from the bytes the shell sent in `init` and hands its `dispatch` to
// arcade.managedJson, which answers the platform's `rules` requests.
//
// The page names, in order: the module's loader (emcc-game.sh builds it, and
// it defines `ArcadeC`), then this file, then the game's draw code.
//
// Strings cross as UTF-8 in the module's memory. This side owns the call it
// writes in (malloc'd, freed after the call); arcade.h owns the answer it
// returns (valid until the next dispatch), so this side only reads it.

(async () => {
	await arcade.init; // the module comes in `init` (game.json "wasm"): the frame can fetch nothing
	if (!arcade.wasm) throw new Error("arcade-c: no WebAssembly in init (game.json needs \"runtime\": \"wasm\" and \"wasm\")");
	const m = await ArcadeC({
		wasmBinary: arcade.wasm,
		print: (text) => console.log(text), // printf, for debugging
		printErr: (text) => console.warn(text),
	});
	const dispatch = (json) => {
		const size = m.lengthBytesUTF8(json) + 1;
		const call = m._malloc(size);
		if (!call) return '{"err":"out of memory"}';
		try {
			m.stringToUTF8(json, call, size);
			return m.UTF8ToString(m._dispatch(call));
		} finally {
			m._free(call);
		}
	};
	arcade.managedJson(dispatch);
})().catch((err) => console.error("arcade-c: the game's module did not start", err));
