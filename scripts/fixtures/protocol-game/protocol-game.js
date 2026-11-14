// scripts/fixtures/protocol-game — every SDK v2 service, used once per peer,
// for scripts/test-protocol.mjs. Not a game: it runs a script of steps on
// init and reports each in `arcade.debug()`; the test reads that from every
// peer and checks each message that crossed the frame against the schema.

const steps = {}; // name -> true | "why not"
const pass = (name, ok = true, why = "") => {
	if (steps[name] === true) return;
	steps[name] = ok ? true : why || false;
	document.getElementById("log").textContent = JSON.stringify(steps, null, 1);
};
arcade.debug = () => ({ steps: { ...steps }, self: arcade.party?.self, host: arcade.party?.host });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isBot = (id) => id.startsWith("bot_");
const humans = () => arcade.party.members.filter((m) => !isBot(m.id)).map((m) => m.id);
const seated = () => arcade.party.members.filter((m) => m.team && m.team !== "spectator").map((m) => m.id);
const bots = () => arcade.party.members.filter((m) => isBot(m.id)).map((m) => m.id);
const others = () => humans().filter((id) => id !== arcade.party.self);
/** Repeat `fn` every `ms` until `done()` or `limit` ms pass: peers mount at different moments. */
const until = async (done, fn, ms = 400, limit = 20_000) => {
	for (const end = Date.now() + limit; !done() && Date.now() < end; await sleep(ms)) await fn?.();
	return done();
};

// For the test: end the game from the host's frame.
window.fixtureEnd = () => arcade.send("end");
window.fixtureAsk = () => arcade.request("ask", { text: "Protocol check: yes?", ok: "YES", cancel: "NO" }).then((m) => pass("ask", m.yes === true, "answered no"));

// The shell's request: the crown moved here.
arcade.answer("takeOver", () => {
	pass("takeOver");
	return true;
});
arcade.on("roster", () => pass("roster"));
arcade.on("theme.set", (m) => pass("theme.set", /^rgba\(/.test(m.theme.tokens.bg ?? ""), "theme.set without values"));

arcade.init.then(async (init) => {
	pass("init", init.game.id.endsWith("protocol-game") && init.features.includes("seal"), "init lacks game or features");
	pass("theme", init.theme.players.length === 8 && /^rgba\(/.test(init.theme.tokens.bg ?? ""), "theme tokens are not rgba values");
	arcade.ready();
	pass("ready");
	const me = arcade.party.self;
	const host = arcade.isHost();

	// Armed first, since the test hides tabs while the rest runs. The host's
	// turn is p2's (whoever it is): hidden, the shell's banner counts down and
	// lets the host SKIP; any phone paused while the host's tab is hidden.
	const pauses = [];
	arcade.on("paused", (m) => pauses.push(m.on));
	arcade.send("wait.pause", { on: true });
	const pausing = until(() => pauses.includes(true) && pauses.at(-1) === false, null, 200, 40_000);
	let skipped = null;
	arcade.on("wait", (m) => m.ev === "skip" && (skipped = m.who));
	if (host) arcade.send("wait.turn", { who: others().sort()[0] });

	// -- channels, binary, emitAs --------------------------------------------
	const heard = new Set();
	const ping = arcade.channel("ping", (d, from) => {
		if (d?.bin instanceof ArrayBuffer && new Uint8Array(d.bin).join() === "1,2,3") heard.add(from);
	});
	const bin = () => new Uint8Array([1, 2, 3]).buffer;
	const everyone = () => [...others(), ...bots()];
	const pinged = until(
		() => everyone().every((id) => heard.has(id)),
		() => {
			ping.send({ bin: bin() });
			if (host) for (const b of bots()) ping.emitAs(b, { bin: bin() });
		},
	).then((ok) => pass("channels+bin+emitAs", ok, `heard ${[...heard]} of ${everyone()}`));

	// -- party record, storage -----------------------------------------------
	arcade.send("meta", { patch: { fixture: me } });
	const metaSeen = until(() => humans().every((id) => arcade.party.members.find((m) => m.id === id)?.fixture === id)).then((ok) =>
		pass("meta", ok, "not every player's meta arrived"),
	);
	arcade.send("store.set", { key: "seen", value: (init.storage.seen ?? 0) + 1 });
	arcade.send("session.set", { key: "tab", value: "here" });
	arcade.send("session.set", { key: "gone", value: null });
	arcade.send("toast", { text: "protocol check running" });
	arcade.send("haptic", { ms: [10, 20, 10] });
	pass("fire-and-forget");

	// -- assets --------------------------------------------------------------
	const text = await arcade.request("asset", { path: "data.txt", as: "text" });
	const bytes = await arcade.request("asset", { path: "data.txt" });
	pass("asset", text.text === "hello arcade\n" && new TextDecoder().decode(bytes.bytes) === "hello arcade\n", "asset contents differ");
	const outside = await arcade.request("asset", { path: "../../../sw.js", as: "text" }).then(() => "served", (e) => e.message);
	pass("asset outside the folder is refused", outside !== "served", "served a file outside the folder");

	// -- commitments ---------------------------------------------------------
	const c = await arcade.request("commit", { value: { card: 7, me } });
	const good = await arcade.request("verify", { digest: c.digest, nonce: c.nonce, value: { me, card: 7 } });
	const bad = await arcade.request("verify", { digest: c.digest, nonce: c.nonce, value: { me, card: 8 } });
	pass("commit+verify", good.valid === true && bad.valid === false, `valid ${good.valid}, tampered ${bad.valid}`);

	// -- sealed messages -----------------------------------------------------
	const sealedFrom = new Map();
	arcade.on("sealed", (m) => m.ch === "hand" && sealedFrom.set(m.to ?? arcade.party.self, m));
	arcade.send("seal.listen", { ch: "hand" });
	if (host) {
		const sent = new Set();
		const ok = await until(
			() => sent.size === others().length + bots().length,
			async () => {
				for (const to of [...others(), ...bots()]) {
					if (sent.has(to)) continue;
					await arcade.request("seal.send", { ch: "hand", to, d: { card: to } }).then(() => sent.add(to), () => {});
				}
			},
			500,
		);
		pass("seal.send", ok, `sealed to ${sent.size} of ${others().length + bots().length}`);
		pass("sealed (to a bot, on the host)", await until(() => bots().every((b) => sealedFrom.get(b)?.d.card === b)), "the bot's sealed message did not come back");
	} else {
		pass("sealed", await until(() => sealedFrom.get(me)?.d.card === me && sealedFrom.get(me)?.from === arcade.party.host), "no sealed message from the host");
	}

	// -- the clock -----------------------------------------------------------
	const seen = new Set();
	arcade.on("timer", (m) => {
		if (m.name !== "t") return;
		seen.add(m.ev);
		if (m.ev === "phase" && m.info.phase === "pick") arcade.send("timer.do", { name: "t", op: "submit", value: me });
		if (m.ev === "bot") arcade.send("timer.do", { name: "t", op: "submitFor", bot: m.bot, value: m.bot });
		if (m.ev === "collect") pass("timer collect", Object.keys(m.entries).sort().join() === seated().sort().join(), `collected ${Object.keys(m.entries)} of ${seated()}`);
	});
	arcade.send("timer.open", { name: "t", rounds: 1, phases: [{ name: "pick", ms: 15_000, collect: true }], bots: true });
	await Promise.all([pinged, metaSeen]);
	if (host) {
		await sleep(1500); // every peer has opened the clock by now (and held messages cover a late one)
		arcade.send("timer.do", { name: "t", op: "start" });
	}
	pass("timer", await until(() => seen.has("finish"), null, 200, 30_000), `timer events: ${[...seen]}`);

	// -- waiting on players (the test hides tabs and presses SKIP TURN) --------
	pass("paused", await pausing, `paused events: ${pauses}`);
	arcade.send("wait.pause", { on: false });
	if (host) {
		pass("wait skip", await until(() => skipped !== null, null, 200, 30_000), "no SKIP TURN arrived");
		arcade.send("wait.turn", { who: null });
	}

	if (host) arcade.result({ kind: "ffa", ranking: [humans().concat(bots())] });
	pass("done");
});
