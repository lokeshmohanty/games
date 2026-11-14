// games/neon-survival-mp/neon-survival-mp.js — Neon Survival, an SDK v2
// managed game that ticks.
//
// Co-op: everyone seated is in the same run, dodging the same swarm, and
// sharing one score. Spectators watch without a ship of their own. With one
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
//   score, ms, lastSpawn, spawnRate, gone: { id: 1 } }
let s = null;
let live = false; // these rules are the running simulation: we are the host
let version = 0; // bumped on every change, so a tick's view is built once
const polled = new Set(); // bot seats asked for a move since the last tick

const shipOf = (id) => s?.ships[id] ?? null;
const aliveShips = () => Object.values(s.ships).filter((p) => p.alive);
const newShip = (bot) =>
	bot
		? { x: Math.random() * (s.w - 80) + 40, y: Math.random() * (s.h - 80) + 40, alive: true, bot: true }
		: { x: s.w / 2, y: s.h / 2, alive: true, bot: false };

function spawnEnemy() {
	const { w: W, h: H } = s;
	const side = Math.floor(Math.random() * 4);
	let x, y;
	if (side === 0) {
		x = Math.random() * W;
		y = -20;
	} else if (side === 1) {
		x = W + 20;
		y = Math.random() * H;
	} else if (side === 2) {
		x = Math.random() * W;
		y = H + 20;
	} else {
		x = -20;
		y = Math.random() * H;
	}
	// Home toward a ship still flying.
	const targets = aliveShips();
	if (targets.length === 0) return;
	const target = targets[Math.floor(Math.random() * targets.length)];
	const angle = Math.atan2(target.y - y, target.x - x);
	const speed = 1.5 + s.score / 15;
	s.enemies.push({ x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, size: ENEMY_SIZE });
}

function spawnGem() {
	s.gems.push({ id: ++s.nextGem, x: Math.random() * (s.w - 20) + 10, y: Math.random() * (s.h - 20) + 10, size: GEM_SIZE });
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
	if (s.ms - s.lastSpawn > s.spawnRate) {
		spawnEnemy();
		s.lastSpawn = s.ms;
		s.spawnRate = Math.max(SPAWN_INTERVAL_MIN, SPAWN_INTERVAL_INIT - s.score * 10);
	}
	if (s.gems.length < MAX_GEMS && Math.random() < 0.02) spawnGem();

	for (const e of s.enemies) {
		e.x += e.vx;
		e.y += e.vy;
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
				break;
			}
		}
		if (!ship.alive) continue;
		for (let i = s.gems.length - 1; i >= 0; i--) {
			const g = s.gems[i];
			if (Math.hypot(ship.x - g.x, ship.y - g.y) < PLAYER_SIZE / 2 + g.size) {
				s.gems.splice(i, 1);
				s.score++;
			}
		}
	}
}

/**
 * What every seat sees: the whole world, packed flat — enemies as
 * [x, y, vx, vy, …], gems as [id, x, y, …], ships as { id: [x, y, alive, bot] }.
 * Built once per change, however many phones are sent it.
 */
let packed = null;
let packedAt = -1;
function pack() {
	if (packedAt === version) return packed;
	const e = new Array(s.enemies.length * 4);
	s.enemies.forEach((en, i) => {
		e[i * 4] = r1(en.x);
		e[i * 4 + 1] = r1(en.y);
		e[i * 4 + 2] = r2(en.vx);
		e[i * 4 + 3] = r2(en.vy);
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
	for (const [id, p] of Object.entries(s.ships)) ships[id] = [r1(p.x), r1(p.y), p.alive ? 1 : 0, p.bot ? 1 : 0];
	return { m: s.match, w: s.w, h: s.h, score: s.score, g, s: ships };
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
	init({ seats, match }) {
		const { w, h } = box();
		s = { match, w, h, frames: 2, ships: {}, enemies: [], gems: [], nextGem: 0, score: 0, ms: 0, lastSpawn: -1e9, spawnRate: SPAWN_INTERVAL_INIT, gone: {} };
		for (const p of seats) s.ships[p.id] = newShip(p.bot);
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
			if (!ship && !s.gone[id]) ship = s.ships[id] = { ...to, alive: true, bot: false };
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
		// Co-op: everyone in the run shares it and its score.
		return { kind: "coop", ranking: [ids], scores: Object.fromEntries(ids.map((id) => [id, s.score])) };
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
		live = true;
		version++;
		feed();
	},
});

// ------------------------------------------------------------- the screen

const style = document.createElement("style");
style.textContent = `
	#game { position: absolute; inset: 0; display: flex; flex-direction: column;
		align-items: center; justify-content: center; }
	#ui { position: absolute;
		/* Clears the fixed "all games" pill in the top-left corner. */
		top: 58px; left: 12px; right: 12px; display: flex; justify-content: space-between;
		align-items: center; pointer-events: none; z-index: 5; font-size: 0.9rem; }
	#ui .stat { background: color-mix(in oklch, var(--bg) 60%, transparent);
		padding: 4px 12px; border-radius: 6px; border: 1px solid var(--border); }
	#score { color: var(--accent); font-weight: bold; text-shadow: 0 0 8px var(--accent-glow); }
	#alive { color: var(--good); text-shadow: 0 0 8px var(--glow); }
	#me-color { width: 14px; height: 14px; border-radius: 50%; display: inline-block;
		vertical-align: middle; margin-left: 8px; box-shadow: 0 0 8px currentColor; }
	#gameCanvas { border: 2px solid var(--border); box-shadow: 0 0 20px var(--glow);
		touch-action: none; max-width: 95vw; max-height: 80vh; }
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

/** "rgba(r, g, b, a)" with its alpha replaced. */
const alpha = (rgba, a) => rgba.replace(/,\s*[\d.]+\)$/, `, ${a})`);
// A halo is the neon theme's, not paper's: its glow token is transparent.
const glowsOn = () => !/,\s*0\)$/.test(arcade.theme?.tokens.glow ?? ", 0)");

/**
 * A ship's colour: one of the theme's eight player colours, picked from its
 * id — so every phone works it out for itself, in its own theme.
 */
const colors = new Map(); // id -> colour, until the theme changes
function colorFor(id) {
	if (colors.has(id)) return colors.get(id);
	let h = 0;
	for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
	const color = arcade.theme.players[h % 8];
	colors.set(id, color);
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
	} else x.fillRect(pad - half, pad - half, size, size);
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
	const key = `${cur.v.score}|${n}|${cur.v.you}|${me?.[2]}`;
	if (key === lastHud) return;
	lastHud = key;
	scoreEl.textContent = "Score: " + cur.v.score;
	aliveEl.textContent = "Alive: " + n;
	const myColor = cur.v.you ? colorFor(cur.v.you) : "transparent";
	meColorEl.style.color = meColorEl.style.background = myColor;
	// Everyone down: the shell's card says GAME OVER; the score stays under it.
	let msg = "";
	if (n === 0 && Object.keys(cur.v.s).length) msg = "Final Score: " + cur.v.score;
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
	else for (const en of s.enemies) stamp(enemy, en.x + en.vx * ahead, en.y + en.vy * ahead);

	for (const [id, p] of Object.entries(v.s)) {
		if (id === v.you) continue;
		const [x, y] = shipAt(id, p, now);
		c2d.globalAlpha = p[2] ? 1 : 0.3;
		stamp(glow("square", PLAYER_SIZE, colorFor(id), blur), x, y);
		c2d.globalAlpha = 1;
	}

	const me = mine();
	if (me) {
		const myColor = colorFor(v.you);
		if (me[2]) {
			const [x, y] = pointer ? [pointer.x, pointer.y] : shipAt(v.you, me, now);
			stamp(glow("square", PLAYER_SIZE, myColor, blur), x, y);
		} else {
			// ghost: dim outline
			c2d.globalAlpha = 0.3;
			c2d.shadowBlur = blur ? 5 * px : 0;
			c2d.shadowColor = myColor;
			c2d.strokeStyle = myColor;
			c2d.lineWidth = 1;
			c2d.strokeRect(me[0] - PLAYER_SIZE / 2, me[1] - PLAYER_SIZE / 2, PLAYER_SIZE, PLAYER_SIZE);
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
function handleInput(clientX, clientY) {
	const me = mine();
	// Seated and flying (or seated mid-run and about to be).
	if (!cur?.v.you || (me && !me[2])) return;
	const rect = canvas.getBoundingClientRect();
	// CSS pixels to world units.
	pointer = {
		x: clamp(((clientX - rect.left) * W) / (rect.width || W), 0, W),
		y: clamp(((clientY - rect.top) * H) / (rect.height || H), 0, H),
	};
	const wait = SEND_MS - (performance.now() - lastSend);
	if (wait <= 0) send();
	else if (!sendTimer) sendTimer = setTimeout(send, wait);
}

addEventListener("mousemove", (e) => handleInput(e.clientX, e.clientY));
for (const type of ["touchstart", "touchmove"]) {
	addEventListener(
		type,
		(e) => {
			if (!aliveCount()) return;
			handleInput(e.touches[0].clientX, e.touches[0].clientY);
			e.preventDefault();
		},
		{ passive: false },
	);
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
arcade.debug = () => ({ active: aliveCount() > 0, match: cur?.v.m ?? null, you: cur?.v.you ?? null, score: cur?.v.score ?? 0, alive: aliveCount(), enemies: live ? s.enemies.length : cur ? cur.v.e.length / 4 : 0, host: live, simMs: live ? Math.round(s.ms) : null });
