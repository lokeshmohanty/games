// games/neon-survival-mp/neon-survival-mp.js — Neon Survival, an SDK v2
// managed game that ticks.
//
// Everyone seated is in the same run, dodging the same swarm, each scoring
// for the gems they catch (Lokesh, 2026-11-15: every player has their own
// score); the run ends when the last ship is down and ranks them by score.
// Spectators watch without a ship of their own. With one
// seat this is also the solo game, and bots fill other ships for company.
//
// The game is its rules and a canvas. The platform (lib/sdk-managed.js) steps
// `tick({ inputs, dt })` on the host 30 times a second (game.json "tick"),
// with each player's pointer as their input and each bot's `bot()`; sends
// every phone a view 15 times a second ("viewRate"); pauses everyone while
// the host is out of the app; ends the run with the shell's card and PLAY
// AGAIN; and hands the run to the heir if the host leaves. The v1 version
// did all of that by hand, over six channels, in 940 lines.
//
// The world is the host's screen, W x H CSS pixels, as it always was. Other
// phones fit it into their own screens at the same shape.

const SPAWN_INTERVAL_INIT = 1000; // ms — initial enemy spawn rate
const SPAWN_INTERVAL_MIN = 300; // ms — fastest spawn rate
const MAX_GEMS = 3;
const PLAYER_SIZE = 15;
const ENEMY_SIZE = 8;
const GEM_SIZE = 5;
// Every speed here is per animation frame at 60 Hz, as v1 ran on one: the
// simulation steps in those frames, two to a 30 Hz tick, so the swarm moves
// and collides exactly as it did.
const FRAME_MS = 1000 / 60;

// Bot ships. A person moves by pointing, which is instantaneous and has no
// speed limit at all; a bot has one, and that cap is the whole reason it can
// die. At 4px a frame it outruns the early swarm and loses to the late one,
// which is the same arc a person's run has.
const BOT_SPEED = 4;
const BOT_DANGER = 110; // px — how far ahead a bot notices an enemy
const BOT_GREED = 0.55; // pull toward a gem, relative to fleeing

// Wave events (Lokesh, 2026-11-24): every 20 s of a run, one of four, never
// the same twice running, with a banner on every phone for its first 3 s.
// - burst: a wave of BURST drones at once, from one side;
// - fast: drones launched for FAST_MS fly at FAST x the swarm's pace (and
//   three come at once, so it shows);
// - rain: RAIN gems at once, past the usual three;
// - slow: for SLOW_MS the whole swarm flies at half speed.
// Always on. Like everything random in the run, drawn from the run's seed.
const EVENT_EVERY = 20000; // ms of run time
const BANNER_MS = 3000;
const EVENTS = ["burst", "fast", "rain", "slow"];
const SIDES = ["top", "right", "bottom", "left"];
const BURST = 8;
const FAST = 1.6;
const FAST_MS = 6000;
const RAIN = 6;
const SLOW_MS = 5000;

/**
 * The box the world is drawn in: inside the canvas's CSS limits (max-width
 * 95vw, max-height 80vh), so the browser never squeezes one axis of it. The
 * host's box at the start of a run is that run's world.
 */
const box = () => ({
	w: Math.floor(Math.min(innerWidth - 24, 800, innerWidth * 0.95)),
	h: Math.floor(Math.min(innerHeight - 100, 600, innerHeight * 0.8)),
});
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;

// ------------------------------------------------------------------ rules
//
// These run only on the host's phone (and on the heir's, once it takes over).
// Every other phone holds them too, idle, in case the crown comes to it.

// { match, w, h, frames, ships: { id: { x, y, alive, bot } },
//   enemies: [{ x, y, vx, vy, size }], gems: [{ id, x, y, size }], nextGem,
//   score, ms, lastSpawn, spawnRate, gone: { id: 1 }, names: { id: name },
//   rng, event: { kind, side, at } | null, nextEvent }
let s = null;
let live = false; // these rules are the running simulation: we are the host
let version = 0; // bumped on every change, so a tick's view is built once
const polled = new Set(); // bot seats asked for a move since the last tick

/**
 * The run's random numbers: a small seeded generator (mulberry32) whose
 * whole state is `s.rng`, so the run is dealt from `seed`, replays from it,
 * and goes on unchanged under the heir. (Sparks are the only Math.random
 * left: they are each phone's own and change nothing.)
 */
function rand() {
	s.rng = (s.rng + 0x6d2b79f5) >>> 0;
	let t = s.rng;
	t = Math.imul(t ^ (t >>> 15), t | 1);
	t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
/** The event under way, if `kind` and still running. */
const during = (kind, ms) => s.event?.kind === kind && s.ms - s.event.at < ms;
/** The swarm's speed now: half under slow-mo. */
const pace = () => (s && during("slow", SLOW_MS) ? 0.5 : 1);

const shipOf = (id) => s?.ships[id] ?? null;
const aliveShips = () => Object.values(s.ships).filter((p) => p.alive);
const newShip = (bot) =>
	bot
		? { x: rand() * (s.w - 80) + 40, y: rand() * (s.h - 80) + 40, alive: true, bot: true, score: 0 }
		: { x: s.w / 2, y: s.h / 2, alive: true, bot: false, score: 0 };

/** One drone, from a random side or `side` (0 top, 1 right, 2 bottom, 3 left), homing on a ship. */
function spawnEnemy(side = Math.floor(rand() * 4)) {
	const { w: W, h: H } = s;
	let x, y;
	if (side === 0) {
		x = rand() * W;
		y = -20;
	} else if (side === 1) {
		x = W + 20;
		y = rand() * H;
	} else if (side === 2) {
		x = rand() * W;
		y = H + 20;
	} else {
		x = -20;
		y = rand() * H;
	}
	// Home toward a ship still flying.
	const targets = aliveShips();
	if (targets.length === 0) return;
	const target = targets[Math.floor(rand() * targets.length)];
	const angle = Math.atan2(target.y - y, target.x - x);
	const speed = (1.5 + s.score / 15) * (during("fast", FAST_MS) ? FAST : 1);
	s.enemies.push({ x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, size: ENEMY_SIZE });
}

function spawnGem() {
	s.gems.push({ id: ++s.nextGem, x: rand() * (s.w - 20) + 10, y: rand() * (s.h - 20) + 10, size: GEM_SIZE });
}

/** The next wave event: any but the last one, and what it does at once. */
function startEvent() {
	const last = s.event?.kind;
	const pool = EVENTS.filter((k) => k !== last);
	const kind = pool[Math.floor(rand() * pool.length)];
	const side = Math.floor(rand() * 4);
	s.event = { kind, side: kind === "burst" ? SIDES[side] : null, at: s.ms };
	if (kind === "burst") for (let i = 0; i < BURST; i++) spawnEnemy(side);
	else if (kind === "fast") for (let i = 0; i < 3; i++) spawnEnemy();
	else if (kind === "rain") for (let i = 0; i < RAIN; i++) spawnGem();
}

/**
 * One frame of bot movement: flee what is close, drift toward a gem when
 * nothing is, and stay off the walls. `ahead` is how many frames on the
 * swarm is by then, so a bot steering two frames in one tick sees it move.
 *
 * Steering is a sum of vectors rather than a plan, which is what keeps it
 * legible — and beatable. A bot cornered by two enemies from opposite sides
 * will pick the average of the two escapes and die, exactly as a flustered
 * person does.
 */
function steerBot(ship, ahead) {
	const { w: W, h: H } = s;
	let dx = 0;
	let dy = 0;

	for (const e of s.enemies) {
		const ex = ship.x - (e.x + e.vx * ahead);
		const ey = ship.y - (e.y + e.vy * ahead);
		const d = Math.hypot(ex, ey);
		if (d > BOT_DANGER || d === 0) continue;
		// Inverse-square: the nearest threat dominates, so a bot commits to one
		// escape instead of dithering between several distant ones.
		const w = (BOT_DANGER / d) ** 2;
		dx += (ex / d) * w;
		dy += (ey / d) * w;
	}

	const threatened = Math.hypot(dx, dy) > 0.001;
	let nearestGem = null;
	let nearestD = Infinity;
	for (const g of s.gems) {
		const d = Math.hypot(g.x - ship.x, g.y - ship.y);
		if (d < nearestD) {
			nearestD = d;
			nearestGem = g;
		}
	}
	if (nearestGem && nearestD > 0) {
		const pull = threatened ? BOT_GREED : 1;
		dx += ((nearestGem.x - ship.x) / nearestD) * pull;
		dy += ((nearestGem.y - ship.y) / nearestD) * pull;
	}

	// Walls push back, so a bot fleeing outward does not pin itself in a
	// corner where there is nowhere left to dodge.
	const margin = 60;
	if (ship.x < margin) dx += (margin - ship.x) / margin;
	if (ship.x > W - margin) dx -= (ship.x - (W - margin)) / margin;
	if (ship.y < margin) dy += (margin - ship.y) / margin;
	if (ship.y > H - margin) dy -= (ship.y - (H - margin)) / margin;

	const len = Math.hypot(dx, dy);
	if (len > 0.001) {
		ship.x += (dx / len) * BOT_SPEED;
		ship.y += (dy / len) * BOT_SPEED;
	}
	ship.x = clamp(ship.x, PLAYER_SIZE, W - PLAYER_SIZE);
	ship.y = clamp(ship.y, PLAYER_SIZE, H - PLAYER_SIZE);
}

/** One 60 Hz frame of the world: the spawn clock, the swarm, and what it hit. */
function step() {
	s.ms += FRAME_MS;
	if (s.ms >= s.nextEvent) {
		startEvent();
		s.nextEvent += EVENT_EVERY;
	}
	if (s.ms - s.lastSpawn > s.spawnRate) {
		spawnEnemy();
		s.lastSpawn = s.ms;
		s.spawnRate = Math.max(SPAWN_INTERVAL_MIN, SPAWN_INTERVAL_INIT - s.score * 10);
	}
	if (s.gems.length < MAX_GEMS && rand() < 0.02) spawnGem();

	const k = pace();
	for (const e of s.enemies) {
		e.x += e.vx * k;
		e.y += e.vy * k;
	}
	// Cull off-screen enemies (far gone), in place: a new array every frame
	// was garbage at 60 Hz.
	let kept = 0;
	for (const e of s.enemies) if (e.x > -100 && e.x < s.w + 100 && e.y > -100 && e.y < s.h + 100) s.enemies[kept++] = e;
	s.enemies.length = kept;

	for (const ship of Object.values(s.ships)) {
		if (!ship.alive) continue;
		for (const e of s.enemies) {
			if (Math.hypot(ship.x - e.x, ship.y - e.y) < PLAYER_SIZE / 2 + e.size) {
				ship.alive = false;
				ship.died = s.ms; // how long they lasted, for the end card
				break;
			}
		}
		if (!ship.alive) continue;
		for (let i = s.gems.length - 1; i >= 0; i--) {
			const g = s.gems[i];
			if (Math.hypot(ship.x - g.x, ship.y - g.y) < PLAYER_SIZE / 2 + g.size) {
				s.gems.splice(i, 1);
				ship.score = (ship.score ?? 0) + 1; // the catcher's
				s.score++; // the run's, which sets the swarm's pace
			}
		}
	}
}

/**
 * What every seat sees: the whole world, packed flat — enemies as
 * [x, y, vx, vy, …], gems as [id, x, y, …], ships as { id: [x, y, alive, bot, score] }.
 * Built once per change, however many phones are sent it.
 */
let packed = null;
let packedAt = -1;
function pack() {
	if (packedAt === version) return packed;
	const e = new Array(s.enemies.length * 4);
	// Velocities as flown: halved under slow-mo, so phones draw the swarm at its speed.
	const k = pace();
	s.enemies.forEach((en, i) => {
		e[i * 4] = r1(en.x);
		e[i * 4 + 1] = r1(en.y);
		e[i * 4 + 2] = r2(en.vx * k);
		e[i * 4 + 3] = r2(en.vy * k);
	});
	packed = { ...small(), e };
	packedAt = version;
	return packed;
}
/** All of a view but the swarm: a handful of gems and ships. */
function small() {
	const g = [];
	for (const gem of s.gems) g.push(gem.id, r1(gem.x), r1(gem.y));
	const ships = {};
	for (const [id, p] of Object.entries(s.ships)) ships[id] = [r1(p.x), r1(p.y), p.alive ? 1 : 0, p.bot ? 1 : 0, p.score ?? 0];
	// The event's banner, for its first seconds: [kind, side].
	const ev = s.event && s.ms - s.event.at < BANNER_MS ? [s.event.kind, s.event.side] : null;
	return { m: s.match, w: s.w, h: s.h, score: s.score, g, s: ships, ev };
}

/**
 * The host draws straight from its own simulation, every tick: the swarm
 * from `s.enemies` itself (e: null), so packing it is left to the ticks
 * that send views.
 */
function feed() {
	const self = arcade.party?.self;
	onState({ ...small(), e: null, you: shipOf(self) ? self : null }, performance.now());
}

arcade.managed({
	init({ seats, match, seed }) {
		const { w, h } = box();
		const rng = (Math.abs(Math.floor(Number(seed) || 0)) ^ 0x5e1f) >>> 0;
		s = { match, w, h, frames: 2, ships: {}, enemies: [], gems: [], nextGem: 0, score: 0, ms: 0, lastSpawn: -1e9, spawnRate: SPAWN_INTERVAL_INIT, gone: {}, names: {}, rng, event: null, nextEvent: EVENT_EVERY };
		for (const p of seats) s.ships[p.id] = newShip(p.bot);
		for (const p of seats) s.names[p.id] = p.name;
		for (let i = 0; i < 2; i++) spawnGem();
		live = true;
		version++;
		feed();
	},
	/**
	 * Inputs are where each person is pointing, in world units; a bot's is
	 * where it steered to. A tick is `frames` 60 Hz frames: a person's ship
	 * jumps to their finger, as it always did, and a bot's glides there.
	 */
	tick({ inputs, dt }) {
		const frames = Math.max(1, Math.round(dt * 60));
		s.frames = frames;
		// A bot gone from the roster is no longer asked for moves: its ship goes.
		for (const [id, p] of Object.entries(s.ships)) if (p.bot && !polled.has(id)) delete s.ships[id];
		polled.clear();
		const moves = [];
		for (const [id, i] of Object.entries(inputs ?? {})) {
			if (!i || !Number.isFinite(i.x) || !Number.isFinite(i.y)) continue;
			const to = { x: clamp(i.x, 0, s.w), y: clamp(i.y, 0, s.h) };
			let ship = s.ships[id];
			// Someone seated mid-run: their ship arrives where they point.
			if (!ship && !s.gone[id]) ship = s.ships[id] = { ...to, alive: true, bot: false, score: 0 };
			if (ship?.alive) moves.push([ship, ship.x, ship.y, to]);
		}
		for (let f = 1; f <= frames; f++) {
			for (const [ship, x0, y0, to] of moves) {
				const k = ship.bot ? f / frames : 1;
				ship.x = x0 + (to.x - x0) * k;
				ship.y = y0 + (to.y - y0) * k;
			}
			step();
		}
		version++;
		feed();
	},
	apply: () => "this game takes inputs, not moves",
	view: ({ seat }) => ({ ...pack(), you: seat }),
	turn: () => [],
	/** A bot's input: where it steers to over the next tick's frames. */
	bot({ seat }) {
		polled.add(seat);
		const ship = s.ships[seat];
		if (!ship) {
			// A bot seated mid-run enters at a random spot.
			if (!s.gone[seat]) s.ships[seat] = newShip(true);
			return null;
		}
		if (!ship.alive) return null;
		const ghost = { x: ship.x, y: ship.y };
		for (let f = 1; f <= s.frames; f++) steerBot(ghost, f);
		return { x: ghost.x, y: ghost.y };
	},
	result() {
		const ids = Object.keys(s.ships);
		if (!ids.length || aliveShips().length) return null;
		// Each by their own score; equal scores share a place.
		const by = new Map();
		for (const id of ids) {
			const n = s.ships[id].score ?? 0;
			by.set(n, [...(by.get(n) ?? []), id]);
		}
		const ranking = [...by.keys()].sort((a, b) => b - a).map((n) => by.get(n));
		// The end card's DETAILS (docs/sdk-v2.md, result `details`): how long
		// the run lasted, then each player's gems and time, best first (seven
		// at most: eight rows in all).
		const clock = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
		const nameOf = (id) => s.names?.[id] ?? arcade.party?.members?.find?.((m) => m.id === id)?.name ?? "Player";
		const details = [
			{ label: "Time survived", value: clock(s.ms) },
			...ranking
				.flat()
				.slice(0, 7)
				.map((id) => {
					const p = s.ships[id];
					return { label: nameOf(id), value: `${p.score ?? 0} ${p.score === 1 ? "gem" : "gems"} · ${clock(p.died ?? s.ms)}` };
				}),
		];
		// Alone it is a run you played (lib/stats.js counts it, best score kept),
		// not a win over nobody.
		return { kind: ids.length > 1 ? "ffa" : "coop", ranking, scores: Object.fromEntries(ids.map((id) => [id, s.ships[id].score ?? 0])), details };
	},
	// A seated player left the party for good: their ship goes with them.
	leave({ seat }) {
		if (!s.ships[seat]) return false;
		delete s.ships[seat];
		s.gone[seat] = 1;
		version++;
		feed();
		return true;
	},
	snapshot: () => s,
	restore({ snapshot }) {
		s = snapshot;
		// A copy from before the events: they start from here.
		s.rng ??= 0;
		s.event ??= null;
		s.nextEvent ??= Math.ceil((s.ms + 1) / EVENT_EVERY) * EVENT_EVERY;
		live = true;
		version++;
		feed();
	},
});

// ------------------------------------------------------------- the screen

const style = document.createElement("style");
style.textContent = `
	/* A finger drags the ship from anywhere on the screen, so the browser
	   claims no gesture anywhere (not just over the canvas): a pan or pinch it
	   took would stop the touchmoves the drag runs on. */
	html, body { touch-action: none; }
	#game { position: absolute; inset: 0; display: flex; flex-direction: column;
		align-items: center; justify-content: center; touch-action: none; }
	#ui { position: absolute;
		/* Clears the fixed "all games" pill in the top-left corner. */
		top: 58px; left: 12px; right: 12px; display: flex; justify-content: space-between;
		align-items: center; pointer-events: none; z-index: 5; font-size: 0.9rem; }
	#ui .stat { background: color-mix(in oklch, var(--bg) 60%, transparent);
		padding: 4px 12px; border-radius: 6px; border: 1px solid var(--border); }
	#score { color: var(--accent); font-weight: bold; text-shadow: 0 0 8px var(--accent-glow); }
	#alive { color: var(--good); text-shadow: 0 0 8px var(--glow); }
	#me-color { width: 14px; height: 14px; display: inline-block;
		vertical-align: middle; margin-left: 8px; box-shadow: 0 0 8px currentColor; }
	/* Your ship's shape (SHIP_SHAPES), as the canvas draws it. */
	#me-color[data-shape="triangle"] { clip-path: polygon(50% 0, 100% 80%, 0 80%); }
	#me-color[data-shape="diamond"] { clip-path: polygon(50% 0, 100% 50%, 50% 100%, 0 50%); }
	#me-color[data-shape="hexagon"] { clip-path: polygon(50% 0, 100% 25%, 100% 75%, 50% 100%, 0 75%, 0 25%); }
	#me-color[data-shape="star"] { clip-path: polygon(50% 0, 62% 35%, 100% 38%, 70% 60%, 80% 100%, 50% 76%, 20% 100%, 30% 60%, 0 38%, 38% 35%); }
	#me-color[data-shape="pentagon"] { clip-path: polygon(50% 0, 100% 38%, 81% 100%, 19% 100%, 0 38%); }
	#me-color[data-shape="octagon"] { clip-path: polygon(30% 0, 70% 0, 100% 30%, 100% 70%, 70% 100%, 30% 100%, 0 70%, 0 30%); }
	#me-color[data-shape="kite"] { clip-path: polygon(50% 0, 100% 35%, 50% 100%, 0 35%); }
	#gameCanvas { border: 2px solid var(--border); box-shadow: 0 0 20px var(--glow);
		touch-action: none; max-width: 95vw; max-height: 80vh; }
	/* A wave event's banner: under the stats, over the arena, never in the way of a finger. */
	#event { position: absolute; top: 100px; left: 50%; transform: translateX(-50%); max-width: calc(100vw - 32px);
		box-sizing: border-box; padding: 6px 14px; border-radius: 8px; pointer-events: none; z-index: 6;
		font-family: var(--font-display); font-size: clamp(1rem, 4.5vw, 1.4rem); letter-spacing: 0.06em; text-align: center;
		color: var(--warn, var(--accent)); background: color-mix(in oklch, var(--bg) 72%, transparent);
		border: 1px solid currentColor; text-shadow: 0 0 10px var(--glow); white-space: nowrap; }
	#event[hidden] { display: none; }
	@media (prefers-reduced-motion: no-preference) { #event:not([hidden]) { animation: ev-in 0.25s ease-out; } }
	@keyframes ev-in { from { opacity: 0; transform: translate(-50%, -8px); } }
	.ghost-msg { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
		color: var(--muted); font-size: 1.5rem; text-align: center; pointer-events: none;
		z-index: 4; text-shadow: 0 0 10px var(--glow); }
`;
document.head.append(style);
const canvas = document.getElementById("gameCanvas");
const c2d = canvas.getContext("2d");
const scoreEl = document.getElementById("score");
const aliveEl = document.getElementById("alive");
const meColorEl = document.getElementById("me-color");
const ghostEl = document.getElementById("ghost");
const eventEl = document.createElement("div");
eventEl.id = "event";
eventEl.hidden = true;
eventEl.setAttribute("role", "status");
eventEl.setAttribute("aria-live", "polite");
document.getElementById("game").append(eventEl);
/** A wave event's banner, from the view's [kind, side]. */
const EVENT_TEXT = {
	burst: (side) => `SWARM FROM THE ${String(side ?? "").toUpperCase()}!`,
	fast: () => "FAST DRONES!",
	rain: () => "GEM RAIN!",
	slow: () => "SLOW-MO!",
};
let lastEvent = "";
function banner(ev) {
	const text = ev ? (EVENT_TEXT[ev[0]]?.(ev[1]) ?? "") : "";
	if (text === lastEvent) return;
	lastEvent = text;
	eventEl.textContent = text;
	eventEl.hidden = !text;
}

/** "rgba(r, g, b, a)" with its alpha replaced. */
const alpha = (rgba, a) => rgba.replace(/,\s*[\d.]+\)$/, `, ${a})`);
// A halo is the neon theme's, not paper's: its glow token is transparent.
const glowsOn = () => !/,\s*0\)$/.test(arcade.theme?.tokens.glow ?? ", 0)");

/**
 * A ship's colour: one of the theme's eight player colours, its player's pick
 * (docs/sdk-v2.md "Seat colours": the party settles them, no two alike) —
 * on an older shell, picked from its id, so every phone works it out for
 * itself, in its own theme.
 */
const colors = new Map(); // "id:pick" -> colour, until the theme changes
// And each ship its own shape, so two never differ by colour alone (picked
// colours can be close, or one under colour blindness: review, 2026-11-24).
// Keyed to the player — the same index as their colour, which no one else
// in the party holds — so every phone agrees and a ship keeps its shape when
// someone else leaves mid-run; never a dot (the swarm and the gems are dots).
const SHIP_SHAPES = ["square", "triangle", "diamond", "hexagon", "star", "pentagon", "octagon", "kite"];
const shipShape = (id) => {
	const pick = arcade.colors?.[id];
	let h = 0;
	for (const c of id ?? "") h = (h * 31 + c.charCodeAt(0)) >>> 0;
	return SHIP_SHAPES[(Number.isInteger(pick) ? pick : h) % SHIP_SHAPES.length];
};
/** The outline of a ship's shape round (cx, cy), half its size across. */
function shipPath(x, shape, cx, cy, half) {
	x.beginPath();
	if (shape === "square") return x.rect(cx - half, cy - half, half * 2, half * 2);
	const n = { triangle: 3, diamond: 4, pentagon: 5, hexagon: 6, star: 10, octagon: 8, kite: 4 }[shape] ?? 4;
	for (let k = 0; k < n; k++) {
		const a = -Math.PI / 2 + (k * 2 * Math.PI) / n + (shape === "octagon" ? Math.PI / 8 : 0);
		const r = shape === "star" && k % 2 ? half * 0.5 : shape === "kite" && k === 2 ? half * 1.25 : half * 1.15;
		x[k ? "lineTo" : "moveTo"](cx + r * Math.cos(a), cy + r * Math.sin(a) * (shape === "kite" && k % 2 ? 0.7 : 1));
	}
	x.closePath();
}
function colorFor(id) {
	const pick = arcade.colors?.[id];
	const key = `${id}:${pick}`;
	if (colors.has(key)) return colors.get(key);
	let h = 0;
	for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
	const color = arcade.theme.players[Number.isInteger(pick) ? pick % 8 : h % 8];
	colors.set(key, color);
	return color;
}

// The world is W x H units; the canvas behind it holds W*scale*dpr pixels a
// side, so any phone's screen draws it sharp. DPR is capped at 2: a 3x
// backing store fills 2.25x the pixels of 2x for little a player can see,
// and fill is this game's whole cost.
let W = 0;
let H = 0;
let px = 1; // backing pixels per world unit: scale * dpr
function fit() {
	const b = box();
	W = cur ? cur.v.w : b.w;
	H = cur ? cur.v.h : b.h;
	const scale = Math.min(b.w / W, b.h / H);
	const dpr = Math.min(devicePixelRatio || 1, 2);
	px = scale * dpr;
	canvas.width = Math.round(W * px);
	canvas.height = Math.round(H * px);
	canvas.style.width = Math.round(W * scale) + "px";
	canvas.style.height = Math.round(H * scale) + "px";
	c2d.setTransform(px, 0, 0, px, 0, 0);
	glows.clear();
}

/**
 * A glowing dot or square, drawn once into its own small canvas and then
 * stamped with drawImage. shadowBlur on every entity, every frame, was the
 * costliest thing on a phone's screen. Keyed by shape, size, colour and blur;
 * emptied on a resize (px) or a theme change.
 */
const glows = new Map();
function glow(shape, size, color, blur) {
	const key = `${shape}|${size}|${color}|${blur}`;
	let g = glows.get(key);
	if (g) return g;
	const half = shape === "dot" ? size : size / 2;
	const pad = Math.ceil(half + blur * 1.5);
	const c = document.createElement("canvas");
	c.width = c.height = Math.ceil(pad * 2 * px);
	const x = c.getContext("2d");
	x.scale(px, px);
	x.shadowBlur = blur * px; // shadowBlur ignores the transform (canvas spec)
	x.shadowColor = color;
	x.fillStyle = color;
	if (shape === "dot") {
		x.beginPath();
		x.arc(pad, pad, size, 0, Math.PI * 2);
		x.fill();
	} else {
		// A ship's own shape (SHIP_SHAPES).
		shipPath(x, shape, pad, pad, half);
		x.fill();
	}
	g = { c, pad };
	if (glows.size > 256) glows.clear();
	glows.set(key, g);
	return g;
}
const stamp = (g, x, y) => c2d.drawImage(g.c, x - g.pad, y - g.pad, g.pad * 2, g.pad * 2);

// -- views: the newest two, and what changed between them --------------------
//
// The swarm flies in straight lines, so between views each enemy is drawn
// where its velocity has carried it since (dead reckoning: exact until it is
// culled). Ships turn on a whim, so they glide from the last view's spot to
// the newest over one view's interval. Your own ship is drawn under your
// finger, where the host will have it a moment later.

let cur = null; // { v, t } — the newest view, and when it came
let prev = null;
let paused = false;
let pausedLead = 0; // the swarm's lead when the pause began, held until it ends
let particles = [];
let pointer = null; // { x, y } in world units: where this player points
let decoded = null; // window.enemies / gems off the newest view, built when asked
let alive = 0; // ships still flying in the newest view

const MAX_LEAD = 12; // frames: past this a late view stops the swarm rather than flinging it

function onState(v, t) {
	if (!v) return;
	if (!cur || cur.v.m !== v.m) {
		particles = [];
		prev = null;
		// A new run puts every ship somewhere new: a drag starts from there,
		// not from where this player steered last run.
		pointer = null;
	} else {
		// Sparks are this phone's own: a gem gone was collected, a ship gone dark was hit.
		const kept = new Set();
		for (let i = 0; i < v.g.length; i += 3) kept.add(v.g[i]);
		const g0 = cur.v.g;
		for (let i = 0; i < g0.length; i += 3) if (!kept.has(g0[i])) sparks(g0[i + 1], g0[i + 2], arcade.theme.tokens.good);
		for (const [id, p] of Object.entries(v.s)) if (!p[2] && cur.v.s[id]?.[2]) sparks(p[0], p[1], colorFor(id));
		prev = cur;
	}
	const resized = !cur || cur.v.w !== v.w || cur.v.h !== v.h;
	cur = { v, t };
	decoded = null;
	alive = 0;
	for (const id in v.s) if (v.s[id][2]) alive++;
	if (resized) fit();
	hud();
	banner(v.ev);
}

function sparks(x, y, color) {
	for (let i = 0; i < 8; i++) particles.push({ x, y, vx: (Math.random() - 0.5) * 5, vy: (Math.random() - 0.5) * 5, life: 1, color });
}

/** Frames the swarm has flown since the newest view. */
function lead(now) {
	if (!cur) return 0;
	if (paused) return pausedLead;
	return clamp(((now - cur.t) / 1000) * 60, 0, MAX_LEAD);
}

/** A ship where it is drawn now: gliding from the last view's spot to this one's. */
function shipAt(id, p, now) {
	const q = prev?.v.s[id];
	const span = prev ? cur.t - prev.t : 0;
	if (!q || span <= 0 || span > 250 || paused) return [p[0], p[1]];
	const k = Math.min(1, (now - cur.t) / span);
	return [q[0] + (p[0] - q[0]) * k, q[1] + (p[1] - q[1]) * k];
}

const mine = () => (cur?.v.you ? cur.v.s[cur.v.you] : null);
const aliveCount = () => alive;

let lastHud = "";
function hud() {
	const me = mine();
	const n = aliveCount();
	// Your own score; a spectator sees the leader's.
	const best = Math.max(0, ...Object.values(cur.v.s).map((p) => p[4] ?? 0));
	const score = me ? (me[4] ?? 0) : best;
	const key = `${score}|${n}|${cur.v.you}|${me?.[2]}`;
	if (key === lastHud) return;
	lastHud = key;
	scoreEl.textContent = (me ? "Score: " : "Best: ") + score;
	aliveEl.textContent = "Alive: " + n;
	const myColor = cur.v.you ? colorFor(cur.v.you) : "transparent";
	meColorEl.style.color = meColorEl.style.background = myColor;
	if (cur.v.you) meColorEl.dataset.shape = shipShape(cur.v.you);
	// Everyone down: the shell's card says GAME OVER; the score stays under it.
	let msg = "";
	if (n === 0 && Object.keys(cur.v.s).length) msg = (me ? "Your score: " : "Best score: ") + score;
	else if (!cur.v.you) msg = "Spectating…";
	else if (me && !me[2]) msg = "You're down! Spectating…";
	ghostEl.textContent = msg;
	ghostEl.hidden = !msg;
}

// -- drawing -----------------------------------------------------------------

let lastFrame = 0;
function draw(now) {
	requestAnimationFrame(draw);
	const k = Math.min(3, lastFrame ? ((now - lastFrame) / 1000) * 60 : 1); // frames since the last draw
	lastFrame = now;
	const t = arcade.theme;
	if (!t) return;
	// A finished run with its sparks gone is a still picture: stop repainting it.
	if (cur && !aliveCount() && !particles.length) return;
	const { tokens } = t;
	const blur = glowsOn() ? 15 : 0;
	// Motion trail fade
	c2d.fillStyle = alpha(tokens.bg, 0.3);
	c2d.fillRect(0, 0, W, H);
	if (!cur) return;
	const v = cur.v;

	for (let i = 0; i < v.g.length; i += 3) stamp(glow("dot", GEM_SIZE, tokens.good, blur), v.g[i + 1], v.g[i + 2]);

	const ahead = lead(now);
	const enemy = glow("dot", ENEMY_SIZE, tokens.danger, blur);
	const e = v.e;
	if (e) for (let i = 0; i < e.length; i += 4) stamp(enemy, e[i] + e[i + 2] * ahead, e[i + 1] + e[i + 3] * ahead);
	else {
		const k = pace(); // the host's own simulation: slow-mo halves it here too
		for (const en of s.enemies) stamp(enemy, en.x + en.vx * k * ahead, en.y + en.vy * k * ahead);
	}

	for (const [id, p] of Object.entries(v.s)) {
		if (id === v.you) continue;
		const [x, y] = shipAt(id, p, now);
		c2d.globalAlpha = p[2] ? 1 : 0.3;
		stamp(glow(shipShape(id), PLAYER_SIZE, colorFor(id), blur), x, y);
		c2d.globalAlpha = 1;
	}

	const me = mine();
	if (me) {
		const myColor = colorFor(v.you);
		if (me[2]) {
			const [x, y] = pointer ? [pointer.x, pointer.y] : shipAt(v.you, me, now);
			stamp(glow(shipShape(v.you), PLAYER_SIZE, myColor, blur), x, y);
		} else {
			// ghost: dim outline
			c2d.globalAlpha = 0.3;
			c2d.shadowBlur = blur ? 5 * px : 0;
			c2d.shadowColor = myColor;
			c2d.strokeStyle = myColor;
			c2d.lineWidth = 1;
			shipPath(c2d, shipShape(v.you), me[0], me[1], PLAYER_SIZE / 2);
			c2d.stroke();
			c2d.globalAlpha = 1;
			c2d.shadowBlur = 0;
		}
	}

	// Particles (cosmetic, this phone's own)
	for (let i = particles.length - 1; i >= 0; i--) {
		const p = particles[i];
		p.x += p.vx * k;
		p.y += p.vy * k;
		p.life -= 0.02 * k;
		if (p.life <= 0) {
			particles.splice(i, 1);
			continue;
		}
		c2d.globalAlpha = p.life;
		c2d.fillStyle = p.color;
		c2d.fillRect(p.x, p.y, 2, 2);
	}
	c2d.globalAlpha = 1;
}

// -- input -------------------------------------------------------------------

// Where this player points, sent at most at the tick rate (the latest wins).
const SEND_MS = 1000 / 30;
let lastSend = 0;
let sendTimer = 0;
function send() {
	sendTimer = 0;
	lastSend = performance.now();
	if (pointer) arcade.input({ x: r1(pointer.x), y: r1(pointer.y) });
}
/**
 * Steer this player's ship to world point (x, y), kept `inset` units inside
 * the arena. The host takes it as where the ship is (tick), so a guest's
 * phone works out the point itself, whatever the gesture, and sends that.
 */
function aim(x, y, inset = 0) {
	const me = mine();
	// Seated and flying (or seated mid-run and about to be).
	if (!cur?.v.you || (me && !me[2])) return;
	pointer = { x: clamp(x, inset, W - inset), y: clamp(y, inset, H - inset) };
	const wait = SEND_MS - (performance.now() - lastSend);
	if (wait <= 0) send();
	else if (!sendTimer) sendTimer = setTimeout(send, wait);
}
/** CSS pixels on the screen to world units. */
function toWorld(clientX, clientY) {
	const rect = canvas.getBoundingClientRect();
	return { x: ((clientX - rect.left) * W) / (rect.width || W), y: ((clientY - rect.top) * H) / (rect.height || H) };
}

// A mouse points: the ship goes where the pointer is.
addEventListener("mousemove", (e) => {
	const p = toWorld(e.clientX, e.clientY);
	aim(p.x, p.y);
});

// A finger drags, anywhere on the screen (Lokesh, 2026-11-18): the ship
// moves by as much as the finger does, so it is never under the thumb
// (pointing put it there, hidden, on a phone). One finger steers, the first
// down; another finger does nothing, and when the steering one lifts, a
// finger still down takes over from where it is, so the ship never jumps.
// The ship stays wholly inside the arena; dragging on past an edge holds it
// there, and it comes back as soon as the finger turns. Steering never locks
// (review 2026-11-19): a finger already down when a run starts takes the ship
// on its first move, and a steering finger whose touchend never came (gone
// from `touches`) is replaced by the next one down.
let finger = null; // { id, x, y }: the steering touch, where it was last seen (CSS px)
const fingerFrom = (t) => ({ id: t.identifier, x: t.clientX, y: t.clientY });
const isDown = (e, id) => [...e.touches].some((t) => t.identifier === id);
addEventListener(
	"touchstart",
	(e) => {
		if (!finger || !isDown(e, finger.id)) finger = fingerFrom(e.changedTouches[0]);
		if (aliveCount()) e.preventDefault();
	},
	{ passive: false },
);
addEventListener(
	"touchmove",
	(e) => {
		if (!aliveCount()) return;
		e.preventDefault();
		if (!finger || !isDown(e, finger.id)) {
			finger = fingerFrom(e.changedTouches[0]);
			return;
		}
		const t = [...e.touches].find((t) => t.identifier === finger.id);
		const rect = canvas.getBoundingClientRect();
		const k = W / (rect.width || W); // world units per CSS px
		const me = mine();
		// From where this phone draws its ship: the point it last sent, else
		// the host's; seated mid-run with no ship yet, it arrives under the finger.
		const from = pointer ?? (me ? { x: me[0], y: me[1] } : toWorld(finger.x, finger.y));
		const dx = (t.clientX - finger.x) * k;
		const dy = (t.clientY - finger.y) * k;
		finger = fingerFrom(t);
		aim(from.x + dx, from.y + dy, PLAYER_SIZE / 2);
	},
	{ passive: false },
);
for (const type of ["touchend", "touchcancel"]) {
	addEventListener(type, (e) => {
		if (!finger || ![...e.changedTouches].some((t) => t.identifier === finger.id)) return;
		finger = e.touches.length ? fingerFrom(e.touches[0]) : null;
	});
}
addEventListener("resize", fit);

// -- the platform ------------------------------------------------------------

arcade.on("view", ({ state }) => {
	// The host draws from its own simulation (feed), at the tick rate.
	if (!live) onState(state, performance.now());
});
arcade.on("paused", ({ on }) => {
	const now = performance.now();
	if (on) {
		pausedLead = lead(now);
		paused = true;
	} else {
		paused = false;
		// Carry on from where the swarm stood, not from a lead the pause ran up.
		if (cur) cur.t = now - (pausedLead * 1000) / 60;
	}
});
arcade.on("theme.set", () => {
	colors.clear();
	glows.clear();
	lastHud = "";
	if (cur) hud();
});
arcade.init.then(() => {
	fit();
	requestAnimationFrame(draw);
});

// scripts/preview.mjs steers this game, and scripts/test-bots.mjs and
// test-party.mjs watch it, by reading its live state off the frame's window.
// On the host these are the simulation itself; elsewhere, the newest view.
function decode() {
	if (!cur) return { enemies: [], gems: [] };
	if (!decoded) {
		const { g } = cur.v;
		const e = cur.v.e ?? [];
		const enemies = [];
		for (let i = 0; i < e.length; i += 4) enemies.push({ x: e[i], y: e[i + 1], vx: e[i + 2], vy: e[i + 3], size: ENEMY_SIZE });
		const gems = [];
		for (let i = 0; i < g.length; i += 3) gems.push({ id: g[i], x: g[i + 1], y: g[i + 2], size: GEM_SIZE });
		decoded = { enemies, gems };
	}
	return decoded;
}
/** Every ship but this player's, as { id: { x, y, alive } }; `botsOnly` for the bots. */
function others(botsOnly) {
	const out = {};
	if (live) {
		for (const [id, p] of Object.entries(s.ships)) if (id !== arcade.party.self && (!botsOnly || p.bot)) out[id] = p;
	} else if (cur) {
		for (const [id, p] of Object.entries(cur.v.s)) if (id !== cur.v.you && (!botsOnly || p[3])) out[id] = { x: p[0], y: p[1], alive: !!p[2] };
	}
	return out;
}
function selfShip() {
	if (live && shipOf(arcade.party.self)) return shipOf(arcade.party.self);
	const me = mine();
	return me ? { x: pointer?.x ?? me[0], y: pointer?.y ?? me[1], alive: !!me[2] } : { x: 0, y: 0, alive: false };
}
Object.defineProperties(window, {
	player: { configurable: true, get: selfShip },
	enemies: { configurable: true, get: () => (live ? s.enemies : decode().enemies) },
	gems: { configurable: true, get: () => (live ? s.gems : decode().gems) },
	gameActive: { configurable: true, get: () => aliveCount() > 0 },
	// Every other ship, as this phone sees it; and the bots the host flies.
	peers: { configurable: true, get: () => others(false) },
	botShips: { configurable: true, get: () => (live ? others(true) : {}) },
});

/** For the tests: the run as this phone sees it. */
arcade.debug = () => ({ active: aliveCount() > 0, match: cur?.v.m ?? null, you: cur?.v.you ?? null, score: cur ? (mine()?.[4] ?? 0) : 0, alive: aliveCount(), enemies: live ? s.enemies.length : cur ? cur.v.e.length / 4 : 0, host: live, simMs: live ? Math.round(s.ms) : null, shapes: Object.fromEntries(Object.keys(cur?.v.s ?? {}).map((id) => [id, shipShape(id)])), meShape: meColorEl.dataset.shape ?? null, event: cur?.v.ev?.[0] ?? null, banner: eventEl.hidden ? null : eventEl.textContent });
