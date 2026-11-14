// lib/sdk-host.js — the shell's end of the SDK v2 protocol.
//
// A v2 game (manifest `sdk: 2`) runs in the same sandboxed frame as a v1 game
// (lib/bridge.js builds it), but it talks to the party only in the messages
// sdk/v2/protocol.json lists, through sdk/v2/runtime.js or any adapter that
// speaks them. This file answers those messages, against the real party.
//
// What changed from v1 (docs/sdk-v2.md has the full catalogue):
//
//   - Nothing a game needs exists only as JavaScript inside the frame. The
//     clock (lib/rounds.js), the turn-wait banner and host pause
//     (lib/games.js), and sealing and commitments (lib/secrets.js) run HERE,
//     against the shell's room, and the frame only sends and hears messages.
//     So a game in Rust or Python gets them for free. Their channels are
//     wired as `v:<name>`, apart from the game's own `g:<name>`.
//   - The roster goes to the frame only when it changes, not on a 250 ms
//     poll. (The shell still looks every 250 ms: away and reconnecting flags
//     change without a roster event.)
//   - The theme goes as values (rgba tokens, player colours, fonts), so a
//     canvas or WASM game needs no getComputedStyle.
//   - An ArrayBuffer may sit anywhere in a channel message: it crosses into
//     the frame as a transferable and between phones as `{ $bin: base64 }`.
//   - A `runtime: "wasm"` game's module is fetched while the frame is built
//     and handed over in `init`, since the frame itself may fetch nothing.
//
// Tests and the protocol check (scripts/test-protocol.mjs) watch every
// message through `NeonArcade.sdkTrace(direction, message)` when it is set.

window.NeonArcade = window.NeonArcade || {};

(() => {
	const V = 2;
	const SVC = "v:"; // the services' own channels on the wire
	const MAX_MESSAGE = 256 * 1024; // bytes of JSON in one channel message
	const FEATURES = ["timer", "wait", "seal", "haptic", "bin"];
	const MAX_TIMERS = 16; // open clocks per mount: each ticks in the shell
	const MAX_SEALED = 32; // sealed channels per mount
	// The party record's keys the shell's own services keep: a game may not
	// write them (net.js already guards id, name, team, bot).
	const SHELL_META = new Set(["pk", "away", "reconnecting"]);

	// -- binary ---------------------------------------------------------------

	const toBase64 = (bytes) => {
		let s = "";
		for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
		return btoa(s);
	};
	const fromBase64 = (str) => {
		const bin = atob(str);
		const out = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
		return out.buffer;
	};
	/** For the wire between phones: every ArrayBuffer (or view) → { $bin }. */
	const binOut = (v) => {
		if (v instanceof ArrayBuffer) return { $bin: toBase64(new Uint8Array(v)) };
		if (ArrayBuffer.isView(v)) return { $bin: toBase64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) };
		if (Array.isArray(v)) return v.map(binOut);
		if (v && typeof v === "object") {
			const o = {};
			for (const k of Object.keys(v)) o[k] = binOut(v[k]);
			return o;
		}
		return v;
	};
	/** Back again, collecting the buffers to transfer into the frame. */
	const binIn = (v, transfer) => {
		if (Array.isArray(v)) return v.map((x) => binIn(x, transfer));
		if (v && typeof v === "object") {
			const keys = Object.keys(v);
			if (keys.length === 1 && keys[0] === "$bin" && typeof v.$bin === "string") {
				try {
					const buf = fromBase64(v.$bin);
					transfer.push(buf);
					return buf;
				} catch {
					return null;
				}
			}
			const o = {};
			for (const k of keys) o[k] = binIn(v[k], transfer);
			return o;
		}
		return v;
	};

	// -- the theme, as values ---------------------------------------------------

	const themeValue = () => {
		const p = NeonArcade.palette?.() ?? {};
		const { theme = "paper", mode = "light" } = NeonArcade.theme?.get?.() ?? {};
		const tokens = {};
		for (const [k, v] of Object.entries(p)) if (typeof v === "string") tokens[k] = v;
		return {
			name: theme,
			mode,
			dark: !!p.dark,
			tokens,
			players: Array.isArray(p.players) && p.players.length === 8 ? p.players : Array(8).fill("rgba(136, 136, 136, 1)"), // theme-exempt: only if the page has no palette
			fonts: p.fonts ?? {},
		};
	};

	// -- the module of a `runtime: "wasm"` game, fetched once per page ----------

	const wasmCache = new Map();
	const wasmBytes = (game) => {
		if (game.runtime !== "wasm" || !game.wasm) return null;
		const url = new URL(game.wasm, game.base);
		if (url.origin !== new URL(game.base).origin || !url.pathname.startsWith(new URL(".", game.base).pathname)) {
			return Promise.reject(new Error("wasm outside the game folder"));
		}
		const key = url.href;
		const local = url.origin === location.origin;
		if (local && wasmCache.has(key)) return wasmCache.get(key);
		const got = fetch(url).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${game.wasm}: ${r.status}`))));
		if (local) {
			wasmCache.set(key, got);
			got.catch(() => wasmCache.delete(key));
		}
		return got;
	};
	NeonArcade.prefetchWasm = (game) => void wasmBytes(game)?.catch(() => {});

	/**
	 * Mount a v2 game into `ctx.root`. Returns the handle party.js keeps:
	 * unmount, onRoster, onPeerJoin, onPeerLeave, takeOver.
	 */
	NeonArcade.mountFrameV2 = (ctx, game) => {
		const F = NeonArcade._frames;
		const { room, root } = ctx;
		const frame = document.createElement("iframe");
		frame.className = "game-frame";
		frame.setAttribute("sandbox", "allow-scripts");
		frame.setAttribute("allow", "fullscreen; autoplay; gamepad");
		frame.title = game.name;
		root.append(frame);

		const channel = new MessageChannel();
		const port = channel.port1;
		const held = new Map(); // full wire name -> envelopes, for channels nobody has opened
		const open = new Set(); // game channels the frame listens to
		const store = F.readStore(game.id);
		const session = F.readSession(game.id);
		const wasm = wasmBytes(game);
		let hello = false;
		let started = false; // init posted: before it, a frame hears nothing else
		let closed = false;
		let lastParty = "";
		let seq = 0;
		const replies = new Map(); // id -> resolve, for the shell's own requests
		let budget = F.MAX_PER_SECOND;
		const refill = setInterval(() => (budget = F.MAX_PER_SECOND), 1000);

		const trace = (dir, m) => {
			if (!NeonArcade.sdkTrace) return;
			try {
				NeonArcade.sdkTrace(dir, m);
			} catch {}
		};
		const post = (msg, transfer) => {
			if (closed) return;
			const m = { v: V, ...msg };
			trace("toFrame", m);
			port.postMessage(m, transfer ?? []);
		};
		const reply = (re, fields = {}, transfer) => post({ t: "reply", re, ok: true, ...fields }, transfer);
		const refuse = (re, err) => post({ t: "reply", re, ok: false, err: String(err).slice(0, 300) });

		const party = () => ({ self: room.selfId, host: room.hostId(), members: room.getMembers() });
		const pushRoster = (force) => {
			if (!started) return;
			const p = party();
			const now = JSON.stringify(p);
			if (!force && now === lastParty) return;
			lastParty = now;
			post({ t: "roster", party: p });
		};
		const poll = setInterval(() => pushRoster(false), 250);
		const offTheme = NeonArcade.theme?.onChange(() => started && post({ t: "theme.set", theme: themeValue() }));

		// Messages for channels not open yet (the game's, or a service's) are
		// held, so a frame that opens a channel late still hears what came first.
		room.onStray = (env) => {
			if (!env.a?.startsWith(F.PREFIX) && !env.a?.startsWith(SVC)) return;
			const list = held.get(env.a) ?? [];
			if (list.length >= F.MAX_HELD) return;
			list.push(env);
			held.set(env.a, list);
		};
		/**
		 * Hand the held messages of exactly these wire names to their actions.
		 * Exact, not a prefix: "bid" must not take "bids"'s messages, and looking
		 * up an action creates it, after which net.js stops calling it a stray.
		 */
		const flush = (...names) => {
			for (const a of names) {
				const list = held.get(a);
				if (!list) continue;
				held.delete(a);
				const on = room.makeAction(a).onMessage;
				for (const env of list) on?.(env.d, { peerId: env.f });
			}
		};

		// The services run against the room, on channels of their own.
		const svcRoom = new Proxy(room, {
			get(target, key) {
				if (key === "makeAction") return (name) => target.makeAction(SVC + name);
				const v = Reflect.get(target, key, target);
				return typeof v === "function" ? v.bind(target) : v;
			},
		});
		const svcCtx = { ...ctx, room: svcRoom };
		const timers = new Map(); // name -> makeRounds handle
		let turnWait = null;
		let turnOf = null;
		let pause = null;
		let secrets = null;
		const sealed = new Map(); // channel -> secrets channel
		const lib = (name, ready) => (ready() ? Promise.resolve() : NeonArcade.load(name));
		const getSecrets = async () => {
			await lib("secrets", () => NeonArcade.makeSecrets);
			if (closed) throw new Error("the game ended");
			secrets ??= NeonArcade.makeSecrets(svcRoom, { onError: ({ reason }) => console.warn(`${game.id}: ${reason}`) });
			await secrets.ready();
			return secrets;
		};

		const isName = (s) => typeof s === "string" && s.length > 0 && s.length <= F.MAX_NAME;
		/**
		 * `d` as it goes on the wire (binary as base64), or null — with a
		 * warning, since a dropped message is otherwise silent — when it is over
		 * the limit or not JSON at all (a BigInt, a cycle).
		 */
		const wire = (d, what = "a message") => {
			try {
				const out = binOut(d);
				const bytes = JSON.stringify(out ?? null).length;
				if (bytes <= MAX_MESSAGE) return { d: out };
				console.warn(`${game.id}: ${what} of ${bytes} bytes is over ${MAX_MESSAGE}; not sent`);
			} catch (err) {
				console.warn(`${game.id}: ${what} is not JSON (${err.message}); not sent`);
			}
			return null;
		};
		const target = (to) => (typeof to === "string" ? { target: to } : undefined);
		const listen = (ch) => {
			if (open.has(ch)) return;
			open.add(ch);
			room.makeAction(F.PREFIX + ch).onMessage = (d, { peerId }) => {
				const transfer = [];
				post({ t: "msg", ch, d: binIn(d, transfer), from: peerId }, transfer);
			};
			flush(F.PREFIX + ch);
		};
		const sealListen = async (ch) => {
			if (sealed.has(ch)) return sealed.get(ch);
			if (sealed.size >= MAX_SEALED) throw new Error(`more than ${MAX_SEALED} sealed channels`);
			const s = await getSecrets();
			if (sealed.has(ch)) return sealed.get(ch);
			const chan = s.channel(ch);
			sealed.set(ch, chan);
			chan.onMessage = (d, { from, to }) => post(to && to !== room.selfId ? { t: "sealed", ch, d, from, to } : { t: "sealed", ch, d, from });
			flush(SVC + "s$" + ch);
			return chan;
		};

		async function onFrame(e) {
			const m = e.data;
			if (closed || !m || m.v !== V || typeof m.t !== "string") return;
			if (--budget < 0) {
				if (budget === -1) console.warn(`${game.id}: more than ${F.MAX_PER_SECOND} messages a second; dropping`);
				return;
			}
			trace("toShell", m);
			const id = Number.isInteger(m.id) && m.id > 0 ? m.id : null;
			switch (m.t) {
				case "hello": {
					if (hello) return;
					hello = true;
					const p = party();
					lastParty = JSON.stringify(p);
					const init = {
						t: "init",
						game: { id: game.id, name: game.name },
						party: p,
						seats: { min: game.seats?.min ?? 1, max: game.seats?.max ?? 16 },
						local: !!game.local,
						canEnd: !!ctx.canEnd,
						storage: store,
						session,
						theme: themeValue(),
						features: FEATURES,
					};
					if (wasm) {
						try {
							// A copy: the page keeps the original for the next mount.
							const bytes = (await wasm).slice(0);
							post({ ...init, wasm: bytes }, [bytes]);
							started = true;
						} catch (err) {
							NeonArcade.toast?.(`${game.name} failed to load: ${err.message}`, "warn");
						}
					} else {
						post(init);
						started = true;
					}
					break;
				}
				case "ready":
					frame.dataset.ready = "1";
					break;
				case "reply": {
					const resolve = replies.get(m.re);
					replies.delete(m.re);
					resolve?.(!!m.ok);
					break;
				}
				case "listen":
					if (isName(m.ch)) listen(m.ch);
					break;
				case "send": {
					const w = isName(m.ch) && wire(m.d, `"${m.ch}" message`);
					if (w) room.makeAction(F.PREFIX + m.ch).send(w.d, target(m.to));
					break;
				}
				case "emitAs": {
					const w = isName(m.ch) && NeonArcade.isBotId(m.bot) && wire(m.d, `"${m.ch}" message`);
					if (w) room.emitAs(m.bot, F.PREFIX + m.ch, w.d, target(m.to));
					break;
				}
				case "meta": {
					// net.js drops the reserved keys (id, name, team...) itself;
					// the shell's own (pk, away) go here. Checked as JSON first: a
					// value that cannot be sent would poison the party record.
					if (!m.patch || typeof m.patch !== "object" || Array.isArray(m.patch)) return;
					const patch = Object.fromEntries(Object.entries(m.patch).filter(([k]) => !SHELL_META.has(k)));
					const w = wire(patch, "meta");
					if (w) room.setMeta(w.d);
					break;
				}
				case "store.set": {
					if (typeof m.key !== "string" || m.key.length > 200) return;
					const json = JSON.stringify({ ...store, [m.key]: m.value });
					if (json.length > F.MAX_STORE) return console.warn(`${game.id}: storage over ${F.MAX_STORE} bytes; not saved`);
					store[m.key] = m.value;
					try {
						localStorage.setItem(F.storeKey(game.id), json);
					} catch {}
					break;
				}
				case "session.set": {
					if (typeof m.key !== "string" || m.key.length > 200) return;
					if (m.value == null) delete session[m.key];
					else session[m.key] = String(m.value).slice(0, 32_768);
					try {
						sessionStorage.setItem(F.sessionKey(game.id), JSON.stringify(session));
					} catch {}
					break;
				}
				case "asset":
					if (!id) return;
					try {
						const folder = new URL(game.base);
						const url = new URL(String(m.path), folder);
						if (url.origin !== folder.origin || !url.pathname.startsWith(new URL(".", folder).pathname)) throw new Error("outside the game folder");
						const res = await fetch(url);
						if (!res.ok) throw new Error(`${res.status}`);
						const type = res.headers.get("content-type") ?? "";
						if (m.as === "text") reply(id, { text: await res.text(), type });
						else {
							const bytes = await res.arrayBuffer();
							reply(id, { bytes, type }, [bytes]);
						}
					} catch (err) {
						refuse(id, `${m.path}: ${err.message}`);
					}
					break;
				case "result":
					if (m.r && typeof m.r === "object") ctx.reportResult?.(m.r, game);
					break;
				case "end":
					ctx.end();
					break;
				case "hostNew":
					if (await NeonArcade.leaveParty?.("Leave the party and host a new game?")) NeonArcade.hostNewGame?.();
					break;
				case "toast":
					NeonArcade.toast?.(String(m.text).slice(0, 200), m.kind === "warn" ? "warn" : "");
					break;
				case "ask": {
					if (!id) return;
					const opts = { ok: String(m.ok ?? "OK").slice(0, 30), cancel: String(m.cancel ?? "CANCEL").slice(0, 30) };
					reply(id, { yes: !!(await NeonArcade.ask?.(String(m.text).slice(0, 300), opts)) });
					break;
				}
				case "haptic": {
					const ms = Array.isArray(m.ms) ? m.ms.slice(0, 10).map((x) => Math.min(1000, Math.max(0, x | 0))) : Math.min(1000, Math.max(0, m.ms | 0));
					try {
						navigator.vibrate?.(ms);
					} catch {}
					break;
				}

				// -- the clock -------------------------------------------------------
				case "timer.open": {
					if (!isName(m.name) || m.name.length > 32 || timers.has(m.name) || !Array.isArray(m.phases) || !m.phases.length) return;
					if (timers.size >= MAX_TIMERS) return console.warn(`${game.id}: more than ${MAX_TIMERS} clocks; not opened`);
					await lib("rounds", () => NeonArcade.makeRounds);
					if (closed || timers.has(m.name)) return;
					const name = m.name;
					const ev = (kind, info, extra) => post({ t: "timer", name, ev: kind, info, ...extra });
					const phases = m.phases.slice(0, 32).map((p) => ({ name: String(p.name).slice(0, 64), ms: Math.max(0, p.ms | 0), collect: !!p.collect }));
					timers.set(
						name,
						NeonArcade.makeRounds(svcCtx, {
							name,
							rounds: Math.max(1, m.rounds | 0 || 1),
							phases,
							onPhase: (info) => ev("phase", info),
							onTick: (info) => ev("tick", info),
							onFinish: (info) => ev("finish", info),
							onCollect: ({ entries, ...info }) => ev("collect", info, { entries: Object.fromEntries(entries) }),
							// The frame answers with timer.do submitFor; the phase waits for it.
							botSubmit: m.bots ? (bot, info) => void ev("bot", info, { bot }) : undefined,
						}),
					);
					flush(SVC + "r$" + name, SVC + "r$" + name + "!");
					break;
				}
				case "timer.do": {
					const t = timers.get(m.name);
					if (!t) return;
					switch (m.op) {
						case "start":
							t.start();
							break;
						case "submit": {
							const w = wire(m.value, "a submission");
							if (w) t.submit(w.d);
							break;
						}
						case "submitFor": {
							const w = wire(m.value, "a submission");
							if (w) t.submitFor(m.bot, w.d);
							break;
						}
						case "next":
							t.next();
							break;
						case "adopt":
							t.adopt({ round: Number.isInteger(m.round) ? m.round : undefined, index: Number.isInteger(m.index) ? m.index : undefined });
							break;
						case "sync":
							t.sync();
							break;
						case "close":
							t.dispose();
							timers.delete(m.name);
							break;
					}
					break;
				}

				// -- waiting on players ----------------------------------------------
				case "wait.turn":
					turnOf = typeof m.who === "string" ? m.who : null;
					turnWait ??= NeonArcade.turnWait(svcCtx, {
						turn: () => turnOf,
						skip: (who) => post({ t: "wait", ev: "skip", who }),
					});
					break;
				case "wait.pause":
					if (m.on && !pause) pause = NeonArcade.hostPause(svcCtx, { onChange: (on) => post({ t: "paused", on }) });
					else if (!m.on && pause) {
						pause.dispose();
						pause = null;
					}
					break;

				// -- secrets ---------------------------------------------------------
				case "seal.listen":
					if (!isName(m.ch)) return;
					try {
						await sealListen(m.ch);
					} catch (err) {
						console.warn(`${game.id}: ${err.message}`);
					}
					break;
				case "seal.send": {
					if (!id) return;
					if (!isName(m.ch) || typeof m.to !== "string") return refuse(id, "malformed");
					// Sealed messages are JSON only: the hash and the cipher run over
					// canonical JSON, where an ArrayBuffer would become {}.
					const w = wire(m.d, "a sealed message");
					if (!w) return refuse(id, `over ${MAX_MESSAGE} bytes, or not JSON`);
					if (JSON.stringify(w.d) !== JSON.stringify(m.d)) return refuse(id, "sealed messages carry JSON only, not binary");
					try {
						// Sending opens the channel too, so a reply (or the bot's own
						// copy, on the host) is never lost to a channel nobody heard.
						const chan = await sealListen(m.ch);
						if (await chan.send(m.to, m.d)) reply(id);
						else refuse(id, "not sent (no key for that player, or no WebCrypto)");
					} catch (err) {
						refuse(id, err.message);
					}
					break;
				}
				case "commit":
					if (!id) return;
					try {
						const { digest, nonce } = await (await getSecrets()).commit(m.value);
						reply(id, { digest, nonce });
					} catch (err) {
						refuse(id, err.message);
					}
					break;
				case "verify":
					if (!id) return;
					try {
						reply(id, { valid: await (await getSecrets()).verify({ digest: m.digest, nonce: m.nonce, value: m.value }) });
					} catch (err) {
						refuse(id, err.message);
					}
					break;
			}
		}
		port.onmessage = onFrame;

		F.frameDoc(game)
			.then((doc) => {
				if (closed) return;
				// Listen only now: the empty frame's own about:blank load must
				// not be the one that gets the port.
				frame.addEventListener("load", () => frame.contentWindow?.postMessage({ t: "neon:port" }, "*", [channel.port2]), { once: true });
				frame.srcdoc = doc;
			})
			.catch((err) => {
				console.error(err);
				NeonArcade.toast?.(`${game.name} failed to load: ${err.message}`, "warn");
			});

		return {
			unmount() {
				if (closed) return;
				post({ t: "unmount" });
				closed = true;
				clearInterval(poll);
				clearInterval(refill);
				offTheme?.();
				for (const t of timers.values()) t.dispose();
				turnWait?.dispose();
				pause?.dispose();
				secrets?.dispose();
				if (room.onStray) room.onStray = null;
				for (const ch of open) room.makeAction(F.PREFIX + ch).onMessage = null;
				for (const r of replies.values()) r(false);
				port.close();
				frame.remove();
			},
			onRoster: () => pushRoster(true),
			/** The crown moved here mid-game: the frame says whether it carries on. */
			takeOver() {
				if (!started || closed) return false;
				pushRoster(false);
				return new Promise((resolve) => {
					const id = ++seq;
					replies.set(id, resolve);
					post({ t: "takeOver", id });
					setTimeout(() => replies.delete(id) && resolve(false), 2000);
				});
			},
			onPeerJoin: (id, info) => {
				pushRoster(false);
				if (started) post({ t: "join", who: id, info: info ?? {} });
			},
			onPeerLeave: (id, info) => {
				pushRoster(false);
				if (started) post({ t: "leave", who: id, info: info ?? {} });
			},
		};
	};
})();
