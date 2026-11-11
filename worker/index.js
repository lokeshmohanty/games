// worker/index.js — the room server: a dumb routing Worker plus the
// Durable Object that holds one signalling room.
//
// The Worker only turns a room code into the object that owns it:
// wss://…/room/<code> routes to the Durable Object named code:<code>, and
// the original request is forwarded untouched — mutating a WebSocket
// upgrade request is the fragile path, so nothing mutates it. The client
// draws its own code when hosting and redraws on a collision, so the worker
// mints nothing.
//
// The object is signalling only. It ferries the packed invite/reply strings
// between sockets and holds rejoin claims; game data never crosses it, and
// neither does ICE config — NAT traversal is the same STUN path the classic
// invite flow uses (net.js DEFAULT_ICE), exactly as docs/room-server.md
// records. All the rules — capacity, claims, rate limits, TTLs — live in
// hub.js, which knows nothing about Cloudflare, which is what makes them
// testable.
//
// State survives eviction twice over: claims (the rejoin secrets' hashes)
// persist in storage, and hibernating sockets carry their room code, member
// id and IP as an attachment, so a woken object — whichever handler wakes it —
// rebuilds the hub and rebinds its sockets instead of dropping a live party's
// signalling.

import { makeHub } from "./hub.js";

const ROOM_PATH = /^\/room\/(\d{6})$/;

export default {
	/**
	 * Route one connection to the object that owns its room code. Everything
	 * else about the request — the upgrade above all — passes through as
	 * it arrived.
	 */
	async fetch(request, env) {
		const code = new URL(request.url).pathname.match(ROOM_PATH)?.[1];
		if (!code) return new Response("not found", { status: 404 });
		if (request.headers.get("Upgrade") !== "websocket") {
			return new Response("websocket required", { status: 426 });
		}
		return env.ROOM.get(env.ROOM.idFromName("code:" + code)).fetch(request);
	},
};

export class RoomSignal {
	constructor(state, env) {
		this.state = state;
		this.env = env;
		this.code = null; // this object is one room; the code names it
		this.ready = null; // Promise<hub>, built once per wake-up
	}

	/**
	 * The hub, built on first use and — after an eviction — stood back up:
	 * claims come back from storage, live sockets from hibernation, and the
	 * two are re-bound by the attachment each socket carries. Every handler
	 * goes through here, because after hibernation the first thing to run
	 * may be a message, a close or an alarm, never a fetch.
	 */
	hub(code) {
		this.code ??= code ?? null;
		this.ready ??= (async () => {
			const hub = makeHub({
				send: (socket, msg) => {
					try {
						socket.send(JSON.stringify(msg));
					} catch {} // a socket mid-close: its own close event follows
				},
			});
			const stored = await this.state.storage.get("room");
			if (stored) {
				this.code ??= stored.code;
				hub.restore(stored);
			}
			for (const ws of this.state.getWebSockets()) {
				const { id, code: wsCode } = attachmentOf(ws);
				this.code ??= wsCode ?? null;
				hub.rebind(ws, this.code, id);
			}
			return hub;
		})();
		return this.ready;
	}

	async fetch(request) {
		const code = new URL(request.url).pathname.match(ROOM_PATH)?.[1];
		await this.hub(code);
		if (request.headers.get("Upgrade") !== "websocket") {
			return new Response("websocket required", { status: 426 });
		}
		const [client, server] = Object.values(new WebSocketPair());
		this.state.acceptWebSocket(server);
		// Serialized now, not after the first join: the rate limits count
		// failures per IP, and a socket whose first message fails has to be
		// counted under its own address, not under one shared "unknown".
		server.serializeAttachment({ ip: request.headers.get("CF-Connecting-IP") ?? "unknown", code });
		return new Response(null, { status: 101, webSocket: client });
	}

	async webSocketMessage(ws, message) {
		let msg;
		try {
			msg = JSON.parse(message);
		} catch {
			return; // not protocol: ignore rather than guess
		}
		const att = attachmentOf(ws);
		const hub = await this.hub(att.code);
		const reply = (body) => ws.send(JSON.stringify(body));
		if (msg.t === "ping") {
			// The client's reachability probe: proof of life, nothing else.
			// No room, no claim, no failure counted.
			return reply({ t: "pong" });
		}
		if (msg.t === "host" || msg.t === "join") {
			// The message's code has to name this object's room; anything
			// else is a misdelivered message, not a guess of this room's code.
			const answer =
				msg.code !== this.code
					? { t: "error", reason: "bad-code" }
					: await hub[msg.t](ws, att.ip, msg);
			reply(answer);
			if (answer.t === "error") return ws.close(4400, answer.reason);
			ws.serializeAttachment({ ...att, id: msg.id });
		} else if (msg.t === "offer" || msg.t === "answer") {
			hub.relay(ws, msg); // a relay touches, and touches move the TTL
		} else if (msg.t === "leave") {
			await hub.release(ws, msg);
			ws.close(1000, "leave");
		} else {
			return;
		}
		await this.persist();
	}

	async webSocketClose(ws, code, reason) {
		(await this.hub(attachmentOf(ws).code)).leave(ws);
		await this.persist();
		// Before the 2026-04-07 compatibility date the runtime does not
		// answer a client's Close frame itself; this completes the handshake.
		// (1005/1006 are reserved and throw, hence the guard.)
		try {
			ws.close(code, reason);
		} catch {}
	}

	async webSocketError(ws) {
		(await this.hub(attachmentOf(ws).code)).leave(ws);
		await this.persist();
	}

	async alarm() {
		await this.hub();
		await this.persist();
	}

	/**
	 * Sweep, persist the claims and re-arm the alarm. Called after every
	 * mutation, because a claim that existed only in memory would die with
	 * the object — and a rejoin that fails because the server was busy is
	 * exactly the brittleness the room server exists to remove.
	 */
	async persist() {
		const hub = await this.hub();
		const next = hub.sweep();
		const room = hub.snapshot(this.code);
		if (!room) {
			// Nothing left: the room is gone, so its storage is too.
			await this.state.storage.delete("room");
			await this.state.storage.deleteAlarm();
			return;
		}
		await this.state.storage.put("room", room);
		if (next) await this.state.storage.setAlarm(next);
		else await this.state.storage.deleteAlarm();
	}
}

/** The attachment a socket carries through hibernation, or nothing. */
function attachmentOf(ws) {
	try {
		return ws.deserializeAttachment() ?? {};
	} catch {
		return {};
	}
}
