// lib/net.js — P2P networking core for serverless multiplayer games.
//
// Wraps Trystero (WebRTC data channels with serverless signaling over public
// Nostr relays). No server to operate: peers discover each other via Nostr,
// then all game data flows directly peer-to-peer and is end-to-end encrypted.
//
// Provides: room join, live peer roster, automatic host election, and a thin
// makeAction passthrough for typed send/receive of game messages.
//
// Host election: the peer with the lexicographically lowest selfId is the
// host. The host owns authoritative shared state (board, deck, scores, turn,
// enemy spawns). Re-elected automatically when peers join or leave.
//
// Loaded as a traditional script (not an ES module) so it works on file://
// without a local server. Trystero is imported dynamically from the CDN.

window.NeonArcade = window.NeonArcade || {};

// Start loading Trystero immediately; createRoom awaits this promise.
const _trysteroPromise = import("https://esm.run/trystero");

/**
 * Create or join a P2P room.
 *
 * @param {object} opts
 * @param {string} opts.appId        Globally-unique app id (namespaces your game on the shared relay).
 * @param {string} opts.roomId       Room code peers share to meet up.
 * @param {(peerId: string) => void} [opts.onPeerJoin]  Fired when a peer joins.
 * @param {(peerId: string) => void} [opts.onPeerLeave] Fired when a peer leaves.
 * @param {(hostId: string, isHost: boolean) => void} [opts.onHostChange] Fired when the elected host changes.
 * @returns {Promise<object>} room controller
 */
NeonArcade.createRoom = async ({
	appId,
	roomId,
	onPeerJoin,
	onPeerLeave,
	onHostChange,
}) => {
	const { joinRoom, selfId } = await _trysteroPromise;
	const room = joinRoom({ appId }, roomId);
	const peers = new Set();
	let hostId = selfId;

	room.onPeerJoin = (peerId) => {
		peers.add(peerId);
		elect();
		onPeerJoin?.(peerId);
	};

	room.onPeerLeave = (peerId) => {
		peers.delete(peerId);
		elect();
		onPeerLeave?.(peerId);
	};

	// Lowest selfId wins. selfId is a stable random hex string per page load.
	function elect() {
		const next = [selfId, ...peers].sort()[0];
		if (next !== hostId) {
			hostId = next;
			onHostChange?.(hostId, hostId === selfId);
		}
	}

	return {
		/** This peer's own stable random id. */
		selfId,
		/** Array of currently-connected peer ids. */
		getPeers: () => [...peers],
		/** Number of connected peers (not counting self). */
		peerCount: () => peers.size,
		/** True only on the elected host peer. */
		isHost: () => hostId === selfId,
		/** The current host's peer id. */
		hostId: () => hostId,
		/**
		 * Create a typed action channel.
		 * @param {string} name
		 * @param {object} [opts] Trystero action opts (e.g. { kind: 'request', onRequest }).
		 * @returns {{ send: (data: any, target?: { target: string }) => void, onMessage: (data: any, meta: { peerId: string }) => void }}
		 */
		makeAction: (name, opts) => room.makeAction(name, opts),
		/** Leave the room and close all peer connections. */
		leave: () => room.leave(),
	};
};
