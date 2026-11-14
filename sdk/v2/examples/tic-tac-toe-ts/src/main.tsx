// The view, on every phone: a Solid component over the view signal. Same DOM
// as ../../tic-tac-toe-js (#hud, then #ttt with nine buttons).

import { Index } from "solid-js";
import { render } from "solid-js/web";
import { arcade, type MemberId } from "../../../adapters/ts/arcade";
import { createView } from "../../../adapters/ts/solid";
import { game, type View } from "./rules";

const EMPTY = Array<0>(9).fill(0);
const nameOf = (id: MemberId | null) => arcade.party?.members.find((m) => m.id === id)?.name ?? "Player";

function TicTacToe() {
	const view = createView<View>();
	const hud = () => {
		const v = view();
		if (!v || v.winner !== null) return "";
		if (!v.you) return "SPECTATING";
		return v.turn === v.you ? "YOUR TURN" : `${nameOf(v.turn === 1 ? v.x : v.o)} TO MOVE`;
	};
	return (
		<>
			<p id="hud" role="status">
				{hud()}
			</p>
			<div id="ttt">
				<Index each={view()?.board ?? EMPTY}>
					{(m, i) => (
						<button type="button" aria-label={`square ${i + 1}`} class={m() === 2 ? "o" : ""} onClick={() => game.act({ i })}>
							{m() === 1 ? "X" : m() === 2 ? "O" : ""}
						</button>
					)}
				</Index>
			</div>
		</>
	);
}

render(() => <TicTacToe />, document.getElementById("app")!);
arcade.on("rejected", (m) => arcade.toast(m.reason, "warn"));
arcade.debug = () => arcade.view; // for tests: { board, turn, winner, x, o, you }
