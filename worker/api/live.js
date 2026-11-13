// worker/api/live.js — UserLive, one Durable Object per account: the open
// pages of a signed-in player, for presence and for things pushed to them
// (a party invite, a friend request).
//
// A page opens `wss://…/live` with the session token as its WebSocket
// subprotocol (["neon", token] — a browser cannot set headers on a socket);
// the Worker checks it and hands the socket here with the account id. The
// sockets hibernate (state.acceptWebSocket), so an idle player costs nothing.
// Presence is written to D1 (`presence`), where friends lists read it:
// online on the first socket, offline when the last closes; a page says what
// it is playing with {t:"status", game} and heartbeats with {t:"ping"}.

export class UserLive {
	constructor(state, env) {
		this.state = state;
		this.env = env;
	}

	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === "/push") {
			const msg = await request.text();
			let delivered = 0;
			for (const ws of this.state.getWebSockets()) {
				try {
					ws.send(msg);
					delivered++;
				} catch {}
			}
			return Response.json({ delivered });
		}
		if (request.headers.get("Upgrade") !== "websocket") return new Response("websocket required", { status: 426 });
		const account = request.headers.get("X-Account");
		if (!account) return new Response("no account", { status: 400 });
		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);
		this.state.acceptWebSocket(server, [account]);
		await this.presence(account, 1, null);
		return new Response(null, { status: 101, webSocket: client, headers: { "Sec-WebSocket-Protocol": "neon" } });
	}

	async webSocketMessage(ws, data) {
		const [account] = this.state.getTags(ws);
		let msg;
		try {
			msg = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data));
		} catch {
			return;
		}
		if (msg?.t === "status") {
			const game = typeof msg.game === "string" && msg.game.length <= 80 ? msg.game : null;
			await this.presence(account, 1, game);
		} else if (msg?.t === "ping") {
			await this.env.DB?.prepare("UPDATE presence SET at = ? WHERE account = ?").bind(Date.now(), account).run();
			ws.send(JSON.stringify({ t: "pong" }));
		}
	}

	async webSocketClose(ws) {
		const [account] = this.state.getTags(ws);
		const left = this.state.getWebSockets().filter((s) => s !== ws).length;
		if (!left) await this.presence(account, 0, null);
	}

	async webSocketError(ws) {
		await this.webSocketClose(ws);
	}

	async presence(account, online, game) {
		if (!this.env.DB || !account) return;
		await this.env.DB.prepare(
			`INSERT INTO presence (account, online, game, at) VALUES (?, ?, ?, ?)
			 ON CONFLICT (account) DO UPDATE SET online = excluded.online, game = excluded.game, at = excluded.at`,
		)
			.bind(account, online, game, Date.now())
			.run()
			.catch((err) => console.error("presence", err));
	}
}
