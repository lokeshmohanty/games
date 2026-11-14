// sdk/v2/adapters/ts/arcade.ts — SDK v2 for TypeScript (docs/sdk-v2.md).
//
// Typed wrappers over `window.arcade` (sdk/v2/runtime.js, which the shell
// inlines ahead of the game's own script). The message types come straight
// from the generated bindings, so there is one source of truth: change
// protocol.json, run `just bindings`, and a game that no longer fits the wire
// stops type-checking. Only types are imported from there; nothing of it ships.
//
// A managed game is `defineGame<State, Action, View>({ … })`: the adapter
// keeps the state, unpacks each `rules` call and hands your functions the
// state and the arguments they need. See README.md for the minimal game.

import type { Init, Json, MemberId, Party, Reply, RulesCall, RulesCallSeatsItem, ToFrame, ToShell, ToastKind } from "../../bindings/protocol";

export type { Json, Member, MemberId, Party, Theme } from "../../bindings/protocol";

// -- the runtime, typed --------------------------------------------------------

/** The shell's message of type `T`. */
export type Message<T extends ToFrame["t"]> = Extract<ToFrame, { t: T }>;
/** What a game sends as message `T`, without the envelope (`v`, `t`, `id`). */
export type Fields<T extends ToShell["t"]> = Omit<Extract<ToShell, { t: T }>, "v" | "t" | "id">;

/** A rule as sdk/v2/runtime.js calls it: one `rulesCall` in, its value out. */
export type RawRules = Partial<Record<RulesCall["fn"], (call: RulesCall) => unknown>>;

/** `window.arcade`, as sdk/v2/runtime.js defines it. */
export interface Arcade {
	readonly version: 2;
	/** { self, host, members }, kept current; null before `init`. */
	party: Party | null;
	/** A WASM game's module bytes (manifest `runtime: "wasm"`). */
	wasm: ArrayBuffer | null;
	/** The `init` message. */
	init: Promise<Init>;
	/** The last view this phone was sent (null before the first). */
	view: Json;
	on<T extends ToFrame["t"]>(t: T, fn: (m: Message<T>) => void): () => void;
	on(t: "*", fn: (m: ToFrame) => void): () => void;
	send<T extends ToShell["t"]>(t: T, fields: Fields<T>, transfer?: Transferable[]): void;
	request<T extends ToShell["t"]>(t: T, fields: Fields<T>, transfer?: Transferable[]): Promise<Reply>;
	/** Answer the shell's own requests: ok as a boolean, or the reply's fields. */
	answer<T extends ToFrame["t"]>(t: T, fn: (m: Message<T>) => boolean | Record<string, unknown> | Promise<boolean | Record<string, unknown>>): void;
	isHost(): boolean;
	ready(): void;
	result(r: Record<string, unknown>): void;
	toast(text: string, kind?: ToastKind): void;
	channel(
		ch: string,
		onMessage?: (d: Json, from: MemberId) => void,
	): { send(d: Json, to?: MemberId): void; emitAs(bot: MemberId, d: Json, to?: MemberId): void; off(): void };
	/** For tests: `arcade.debug = () => arcade.view`. */
	debug: (() => unknown) | null;
	managed(rules: RawRules): void;
	managedJson(dispatch: (json: string) => string): void;
	act(a: Json): void;
	input(i: Json): void;
}

declare global {
	interface Window {
		arcade: Arcade;
	}
}

/** `window.arcade`, typed. */
export const arcade: Arcade = window.arcade;

// -- managed state (Layer 2) ---------------------------------------------------

/** A seated player, as `init` gives them. */
export type Seat = RulesCallSeatsItem;

/** What a match starts from. */
export interface Start {
	/** The seated players, in party order. */
	seats: Seat[];
	/** The manifest's `opts`. */
	opts: Record<string, unknown>;
	/** A random seed. */
	seed: number;
	/** Which match of this run: 0, then 1 on the first rematch… */
	match: number;
}

/** sdk.md "Reporting a result". */
export interface GameResult {
	kind: "duel" | "ffa" | "teams" | "coop" | "local";
	/** Places: ranking[0] won; several ids in one slot are a tie or a team. */
	ranking: MemberId[][];
	scores?: Record<MemberId, number>;
}

type KeysOf<T> = T extends unknown ? keyof T : never;
/**
 * A move as it arrives: from another phone, so not to be trusted. Every field
 * of `A` is there to read but `unknown` until checked (a union's fields too),
 * and the whole may be missing. TypeScript then makes `apply` check it.
 */
export type Untrusted<A> = [A] extends [object] ? { readonly [K in KeysOf<A>]?: unknown } | null | undefined : unknown;

/**
 * A managed game's rules over a state `S`. The adapter keeps the state: each
 * rule gets it first. `apply`, `skip` and `tick` change it in place.
 */
export interface Rules<S, A, V> {
	/** A new match. Return its state. */
	init(start: Start): S;
	/** Apply `by`'s move. Return nothing to allow it, or the reason it is refused. */
	apply(s: S, action: Untrusted<A>, by: MemberId): string | void;
	/** What `seat` may see (null: a spectator). It must be JSON. */
	view(s: S, seat: MemberId | null): V;
	/** Whose move it is: drives the bots and the turn-wait banner. */
	turn(s: S): MemberId[];
	/** A bot's move (null: none). In a ticking game, its input. */
	bot(s: S, seat: MemberId): A | null;
	/** The outcome once the match is over, else null. */
	result(s: S): GameResult | null;
	/** What the heir needs to carry on. Default: the state itself (it must then be JSON). */
	snapshot?(s: S): Json;
	/** The heir's state, from `snapshot`. Default: the snapshot itself. Give both or neither. */
	restore?(snapshot: Json): S;
	/** The host chose SKIP TURN for `seat`. Return true if it skipped. */
	skip?(s: S, seat: MemberId): boolean;
	/** With manifest `tick`: one fixed step, with each seat's latest input. */
	tick?(s: S, inputs: Record<MemberId, Untrusted<A>>, dt: number): void;
}

/** What `defineGame` gives back: the moves, typed. */
export interface Game<A> {
	/** This player's move; a refusal comes back as `rejected { reason }`. */
	act(a: A): void;
	/** A ticking game: this player's latest input. */
	input(a: A): void;
}

/**
 * Hand the platform your rules. It runs them on the host, sends each phone
 * its view (read it with `arcade.on("view")` or `createView` from ./solid),
 * moves the bots, reports the result and hands over to the heir.
 */
export function defineGame<S, A, V>(rules: Rules<S, A, V>): Game<A> {
	let state: S | undefined;
	let started = false;
	const s = (): S => {
		if (!started) throw new Error("no match yet: init comes first");
		return state as S;
	};
	const raw: RawRules = {
		init: (c) => {
			state = rules.init({ seats: c.seats ?? [], opts: c.opts ?? {}, seed: c.seed ?? 0, match: c.match ?? 0 });
			started = true;
		},
		apply: (c) => rules.apply(s(), c.action as Untrusted<A>, c.by as MemberId) ?? null,
		view: (c) => rules.view(s(), c.seat ?? null),
		turn: () => rules.turn(s()),
		bot: (c) => rules.bot(s(), c.seat as MemberId),
		result: () => rules.result(s()),
		snapshot: () => (rules.snapshot ? rules.snapshot(s()) : s()),
		restore: (c) => {
			state = rules.restore ? rules.restore(c.snapshot ?? null) : (c.snapshot as S);
			started = true;
		},
	};
	// Left out, the runtime answers for them: skip is "cannot", tick an error.
	const { skip, tick } = rules;
	if (skip) raw.skip = (c) => skip.call(rules, s(), c.seat as MemberId);
	if (tick) raw.tick = (c) => tick.call(rules, s(), (c.inputs ?? {}) as Record<MemberId, Untrusted<A>>, c.dt ?? 0);
	arcade.managed(raw);
	return {
		act: (a) => arcade.act(a as Json),
		input: (a) => arcade.input(a as Json),
	};
}
