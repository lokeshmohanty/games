// Tic Tac Toe — SDK v2 managed state, in TypeScript (docs/sdk-v2.md).
//
// The same rules as ../../tic-tac-toe-js, the conformance reference: the
// views, refusals, bot and result must match it call for call
// (scripts/test-conformance.mjs). The view is ./main.tsx, in Solid.

import { defineGame, type MemberId } from "../../../adapters/ts/arcade";

type Player = 1 | 2; // X, O
type Mark = 0 | Player; // 0: empty

export interface State {
	board: Mark[];
	turn: Player;
	winner: Mark | null; // 0: a draw; null: still going
	x: MemberId | null;
	o: MemberId | null;
}
export interface View extends State {
	you: Mark; // 0: a spectator
}
export interface Move {
	i: number;
}

const LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]] as const;
const winnerOf = (b: Mark[]): Mark | null => {
	for (const [x, y, z] of LINES) if (b[x] && b[x] === b[y] && b[x] === b[z]) return b[x];
	return b.every(Boolean) ? 0 : null;
};
const other = (p: Player): Player => (p === 1 ? 2 : 1);
const markOf = (s: State, id: MemberId | null | undefined): Mark => (id === s.x ? 1 : id === s.o ? 2 : 0);
// The manifest seats exactly two, so both marks have a player.
const idOf = (s: State, p: Player): MemberId => (p === 1 ? s.x : s.o)!;

export const game = defineGame<State, Move, View>({
	init({ seats }) {
		const team = (t: string, i: number) => (seats.find((p) => p.team === t) ?? seats[i])?.id ?? null;
		return { board: Array<Mark>(9).fill(0), turn: 1, winner: null, x: team("A", 0), o: team("B", 1) };
	},
	apply(s, action, by) {
		const i = action?.i;
		if (s.winner !== null) return "the game is over";
		if (markOf(s, by) !== s.turn) return "not your turn";
		if (typeof i !== "number" || !Number.isInteger(i) || i < 0 || i > 8 || s.board[i]) return "that square is taken";
		s.board[i] = s.turn;
		s.turn = other(s.turn);
		s.winner = winnerOf(s.board);
	},
	view: (s, seat) => ({ ...s, board: [...s.board], you: seat ? markOf(s, seat) : 0 }),
	turn: (s) => (s.winner === null ? [idOf(s, s.turn)] : []),
	bot(s) {
		// Win if it can, block if it must, else the centre, else the first free.
		const free = s.board.flatMap((m, i) => (m ? [] : [i]));
		const wins = (p: Player) => free.find((i) => winnerOf(s.board.map((m, j) => (j === i ? p : m))) === p);
		const i = wins(s.turn) ?? wins(other(s.turn)) ?? (free.includes(4) ? 4 : free[0]);
		return i === undefined ? null : { i };
	},
	result(s) {
		if (s.winner === null) return null;
		if (s.winner === 0) return { kind: "duel", ranking: [[idOf(s, 1), idOf(s, 2)]] };
		return { kind: "duel", ranking: [[idOf(s, s.winner)], [idOf(s, other(s.winner))]] };
	},
	skip(s) {
		s.turn = other(s.turn);
		return true;
	},
	// snapshot and restore: the defaults (the state is JSON).
});
