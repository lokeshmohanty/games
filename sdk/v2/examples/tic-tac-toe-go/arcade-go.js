// arcade-go.js — starts a Go game (TinyGo, -target wasm -scheduler=none) in
// the arcade's frame. Load it after wasm_exec.js (TinyGo's, which defines
// `Go`) and before your draw code. The frame can fetch nothing, so the
// module's bytes come from the shell in `init` (game.json "wasm"). main runs
// arcade.Run, then this hands its dispatch to arcade.managedJson, which says
// `ready`. Each call's JSON goes through the module's memory (run_js.go).
(async () => {
	const go = new Go();
	const { wasm } = await arcade.init;
	const { instance } = await WebAssembly.instantiate(wasm, go.importObject);
	const x = instance.exports;
	go.run(instance).catch((err) => console.error("arcade-go: main failed", err)); // runs main to its end
	const enc = new TextEncoder();
	const dec = new TextDecoder();
	arcade.managedJson((json) => {
		const call = enc.encode(json);
		try {
			new Uint8Array(x.memory.buffer, x.arcade_in(call.length), call.length).set(call);
			const n = x.arcade_dispatch(call.length);
			return dec.decode(new Uint8Array(x.memory.buffer, x.arcade_out(), n));
		} catch (err) {
			// TinyGo cannot recover a panic in WebAssembly: it traps. Say so as
			// this call's error; the Go side may not be sound after it.
			console.error("arcade-go: a rule panicked", err);
			return JSON.stringify({ err: `the Go rules panicked (${err.message})` });
		}
	});
})().catch((err) => console.error("arcade-go: the Go module did not start", err));
