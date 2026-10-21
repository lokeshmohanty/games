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
// between sockets, holds rejoin claims, and hands out ICE config; game data
// never crosses it, exactly as docs/room-server.md records. All the rules —
// capacity, claims, rate limits, TTLs — live in hub.js, which knows nothing
// about Cloudflare, which is what makes them testable.
//
// State survives eviction twice over: claims (the rejoin secrets' hashes)
// persist in storage, and hibernating sockets carry their member id and IP
// as an attachment, so a woken object rebinds its sockets instead of
// dropping a live party's signalling.

import { makeHub } from "./hub.js";

// What a client gets when no TURN credential is configured: the same
// STUN-only list lib/net.js ships, so behaviour is unchanged rather than
// silently different.
const STUN_ONLY = { servers: [{ urls: "stun:stun.cloudflare.com:3478" }, { urls: "stun:stun.l.google.com:19302" }] };

// A fetched TURN credential is reused for this long before refetching.
const ICE_CACHE_MS = 60 * 60 * 1000;

export default {
	/**
	 * Route one connection to the object that owns its room code. Everything
	 * else about the request — the upgrade above all — passes through as
	 * it arrived.
	 */
	async fetch(request, env) {
		const url = new URL(request.url);
		const code = url.pathname.match(/^\/room\/(\d{6})$/)?.[1];
		if (!code) return new Response("not found", { status: 404 });
		if (request.headers.get("Upgrade") !== "websocket") {
			return new Response("websocket required", { status: 426 });
		}
		const id = env.ROOM.idFromName("code:" + code);
		return env.ROOM.get(id).fetch(request);
	},
};

export class RoomSignal {
	constructor(state, env) {
		this.state = state;
		this.env = env;
		this.code = null; // from the first routed URL; this object is one room
		this.hub = null;
		this.iceCache = null; // { value, at }
	}

	/** The code this object was routed by, read off the URL it was fetched on. */
	codeOf(request) {
		return new URL(request.url).pathname.match(/^\/room\/(\d{6})$/)?.[1] ?? null;
	}

	/**
	 * Build the hub on first use and, after an eviction, stand the room back
	 * up: claims come back from storage, live sockets from hibernation, and
	 * the two are re-bound by the attachment each socket carries.
	 */
	async ensure(request) {
		if (this.hub) return;
		this.code = this.codeOf(request) ?? this.code;
		this.hub = makeHub(
			{ send: (socket, msg) => socket.send(JSON.stringify(msg)) },
			{ ice: () => this.ice(), now: Date.now },
		);
		const stored = await this.state.storage.get("room");
		if (stored) this.hub.restore(stored);
		for (const ws of this.state.getWebSockets()) {
			this.hub.rebind(ws, this.code, attachmentOf(ws).id);
		}
	}

	async fetch(request) {
		await this.ensure(request);
		if (request.headers.get("Upgrade") !== "websocket") {
			return new Response("websocket required", { status: 426 });
		}
		const [client, server] = Object.values(new WebSocketPair());
		this.state.acceptWebSocket(server);
		return new Response(null, { status: 101, webSocket: client });
	}

	async webSocketMessage(ws, message) {
		let msg;
		try {
			msg = JSON.parse(message);
		} catch {
			return; // not protocol: ignore rather than guess
		}
		const ip = attachmentOf(ws).ip;
		if (msg.t === "host") {
			// The client drew this code; a collision with a live party answers
			// "taken" and the client redraws. Never join a host into an
			// existing party — that would hand one party's offers to another.
			const reply = await this.hub.host(ws, ip, msg, this.code);
			ws.send(JSON.stringify(reply));
			if (reply.t === "error") return ws.close(4400, reply.reason);
			ws.serializeAttachment({ id: msg.id, ip });
			await this.persist();
		} else if (msg.t === "join") {
			// The message's code has to name this object's room; anything else
			// is a misdelivered join, not a guess of this room's code.
			if (msg.code !== this.code) {
				ws.send(JSON.stringify({ t: "error", reason: "bad-code" }));
				return ws.close(4400, "bad-code");
			}
			const reply = await this.hub.join(ws, ip, msg);
			ws.send(JSON.stringify(reply));
			if (reply.t === "error") return ws.close(4400, reply.reason);
			ws.serializeAttachment({ id: msg.id, ip });
			await this.persist();
		} else if (msg.t === "offer" || msg.t === "answer") {
			this.hub.relay(ws, msg);
			await this.persist(); // a relay touches, and touches move the TTL
		} else if (msg.t === "leave") {
			this.hub.leave(ws);
			ws.close(1000, "leave");
			await this.persist();
		}
	}

	async webSocketClose(ws) {
		this.hub?.leave(ws);
		await this.persist();
	}

	async webSocketLeave(ws) {
		// Hibernation eviction path: same treatment as a close.
		this.hub?.leave(ws);
		await this.persist();
	}

	async alarm() {
		const next = this.hub?.sweep();
		if (next) {
			await this.persist();
			this.state.storage.setAlarm(next);
		} else {
			// Nothing left to sweep: the room is gone, so its storage is too.
			this.state.storage.delete("room");
			this.state.storage.deleteAlarm();
		}
	}

	/**
	 * Persist the claims and re-arm the alarm. Called after every mutation,
	 * because a claim that existed only in memory would die with the object —
	 * and a rejoin that fails because the server was busy is exactly the
	 * brittleness the room server exists to remove.
	 */
	async persist() {
		const room = this.hub.snapshot(this.code);
		if (!room) {
			this.state.storage.delete("room");
			this.state.storage.deleteAlarm();
			return;
		}
		await this.state.storage.put("room", room);
		const next = this.hub.sweep();
		if (next) this.state.storage.setAlarm(next);
		else this.state.storage.deleteAlarm();
	}

	/**
	 * TURN config for joiners. A Metered credential-scoped key (the kind
	 * Metered documents as front-end-safe) is fetched and cached by the
	 * object, so no credential ever lands in the repo and rotation is theirs.
	 * Unconfigured or unreachable, the answer is the STUN-only list —
	 * behaviour identical to the no-room-server path, never silence.
	 */
	async ice() {
		const { TURN_APP, TURN_API_KEY } = this.env;
		if (!TURN_APP || !TURN_API_KEY) return STUN_ONLY;
		if (this.iceCache && Date.now() - this.iceCache.at < ICE_CACHE_MS) return this.iceCache.value;
		try {
			const res = await fetch(
				`https://${TURN_APP}.metered.live/api/v1/turn/credentials?apiKey=${TURN_API_KEY}`,
			);
			if (!res.ok) throw new Error(String(res.status));
			const servers = await res.json();
			this.iceCache = { value: { servers }, at: Date.now() };
			return this.iceCache.value;
		} catch {
			// A failed TURN fetch must not cost a party its signalling.
			return STUN_ONLY;
		}
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
