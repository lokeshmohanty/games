// worker/api/social.js — friends, presence, party invites, groups.
//
// Friends (Lokesh, 2026-11-13; fixed and extended 2026-11-16):
//   GET    /api/friends              { friends: [{id,name,avatar,online,game,muted}],
//                                      incoming, outgoing, blocked }
//   GET    /api/friends/recent       { players: [{id,name,avatar,game,at}] } —
//                                      people from your recent ranked matches
//                                      who are not friends, blocked or hidden
//   POST   /api/friends/<who>        ask — or accept, if they asked first.
//                                    <who> is an account id or a friend code
//   DELETE /api/friends/<id>         unfriend, decline (remembered: no new ask
//                                    from them for DECLINE_COOLDOWN_MS) or withdraw
//   POST/DELETE /api/friends/<id>/block   block (ends everything, they cannot ask) / unblock
//   POST/DELETE /api/friends/<id>/mute    mute a friend's invites / unmute
//   POST   /api/friends/<id>/invite  { code, game? } → { invited: true }: pushed to
//                                    their open pages and kept for INVITE_TTL_MS;
//                                    with no page open, a notification to each
//                                    device that turned them on (push.js)
//   GET    /api/invites              { invites: [{ from: {id,name}, code, at }] }
//   DELETE /api/invites/<sender>     JOIN or NOT NOW: forget that invite
//   POST   /api/me/friend-code       a new friend code; the old one dies
//
// `friends` rows: (a, b, state). 'pending' a asked b; 'friends' (one row per
// pair); 'declined' a asked, b said no, at = when; 'blocked' a blocked b.
//
// The friend code (0005): eight letters and digits without look-alikes,
// given lazily, rotatable. A friend link or QR carries it (./?page=profile&u=
// <code>); a link by account id still works (the id is public on boards
// anyway — block is the answer to someone who uses it). Looking a code up is
// charged to the sender's address like a write, so codes cannot be walked.
// Online means a page of theirs holds the live socket (live.js) and they have
// not chosen "appear offline"; `game` is what that page is playing.
//
// Groups:
//   GET    /api/groups                     the groups you are in
//   POST   /api/groups { name }            make one; you own it
//   POST   /api/groups/join { code }       join by its code (not if removed)
//   GET    /api/groups/<id>                members, the games they play; the
//                                          owner also sees who was removed
//   PATCH  /api/groups/<id> { name }       the owner renames it
//   DELETE /api/groups/<id>                the owner deletes it
//   POST   /api/groups/<id>/code           the owner rotates the join code
//   POST   /api/groups/<id>/owner { account }  the owner hands it to a member
//   DELETE /api/groups/<id>/members/<acct> the owner removes someone (banned, and
//                                          the code rotates); anyone leaves — the
//                                          owner too: the longest-standing member
//                                          owns it next, and the last one out
//                                          deletes it
//   DELETE /api/groups/<id>/bans/<acct>    the owner lets someone back

import { HttpError, body, now, randomId, testing } from "./http.js";
import { pushInvite } from "./push.js";

const all = async (stmt) => (await stmt.all()).results ?? [];
export const FRIENDS_MAX = 200;
export const GROUPS_MAX = 20;
export const GROUP_MEMBERS_MAX = 100;
const ONLINE_MS = 10 * 60_000; // a live page heartbeats every 4 minutes
export const DECLINE_COOLDOWN_MS = 7 * 86_400_000;
const REQUEST_PUSH_MS = 86_400_000; // one pushed request per pair a day
export const INVITE_TTL_MS = 10 * 60_000;
const INVITE_AGAIN_MS = 20_000; // one invite per friend this often
const INVITES_PER_SENDER = 20; // friends invited per INVITE_TTL_MS
const INVITES_PER_RECIPIENT = 10; // invites waiting for one person
const friendsMax = (env) => Number(env.FRIENDS_MAX ?? FRIENDS_MAX);
const groupsMax = (env) => Number(env.GROUPS_MAX ?? GROUPS_MAX);
const inviteTtl = (env) => Number(env.INVITE_TTL_MS ?? INVITE_TTL_MS);

// Codes people can say: no 0/O, 1/I/L.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const newCode = () => [...crypto.getRandomValues(new Uint8Array(8))].map((x) => ALPHABET[x % ALPHABET.length]).join("");
const CODE = /^[A-HJKMNP-Z2-9]{4}-?[A-HJKMNP-Z2-9]{4}$/i;
/** A friend code (any case, a dash or not), as opposed to an account id (12 characters). */
export const isFriendCode = (x) => CODE.test(String(x));
const normal = (x) => String(x).toUpperCase().replace(/-/g, "");

/**
 * The account `who` names — an account id, or a friend code (charged to the
 * address through `gate`, which resolves false when it is spent: 429).
 */
export async function findAccount(env, who, gate = null, cols = "id, name, avatar, created, hide_public") {
	if (isFriendCode(who)) {
		if (gate && !(await gate())) throw new HttpError(429, "too many lookups from this address; wait a few minutes");
		return env.DB.prepare(`SELECT ${cols} FROM accounts WHERE friend_code = ?`).bind(normal(who)).first();
	}
	return env.DB.prepare(`SELECT ${cols} FROM accounts WHERE id = ?`).bind(String(who)).first();
}

/** The account's friend code, made the first time it is asked for. */
export async function ensureFriendCode(env, account) {
	if (account.friend_code) return account.friend_code;
	for (let i = 0; i < 4; i++) {
		try {
			await env.DB.prepare("UPDATE accounts SET friend_code = ? WHERE id = ? AND friend_code IS NULL").bind(newCode(), account.id).run();
			break;
		} catch (err) {
			if (!/UNIQUE/i.test(String(err?.message))) throw err; // a collision: draw again
		}
	}
	const row = await env.DB.prepare("SELECT friend_code FROM accounts WHERE id = ?").bind(account.id).first();
	account.friend_code = row?.friend_code ?? null;
	return account.friend_code;
}

export async function rotateFriendCode(env, me) {
	for (let i = 0; i < 4; i++) {
		const code = newCode();
		try {
			await env.DB.prepare("UPDATE accounts SET friend_code = ? WHERE id = ?").bind(code, me.id).run();
			return { friendCode: code };
		} catch (err) {
			if (!/UNIQUE/i.test(String(err?.message))) throw err;
		}
	}
	throw new HttpError(503, "could not make a new code; try again");
}

export async function friendIds(env, me) {
	const rows = await all(env.DB.prepare("SELECT a, b FROM friends WHERE state = 'friends' AND (a = ? OR b = ?)").bind(me, me));
	return [...new Set(rows.map((r) => (r.a === me ? r.b : r.a)))];
}
export const areFriends = async (env, x, y) =>
	!!(await env.DB.prepare("SELECT 1 FROM friends WHERE state = 'friends' AND ((a = ? AND b = ?) OR (a = ? AND b = ?))").bind(x, y, y, x).first());

const pairRows = (env, x, y) => all(env.DB.prepare("SELECT a, b, state, at FROM friends WHERE (a = ? AND b = ?) OR (a = ? AND b = ?)").bind(x, y, y, x));
const friendCount = async (env, id) =>
	(await env.DB.prepare("SELECT COUNT(*) AS n FROM friends WHERE state = 'friends' AND (a = ? OR b = ?)").bind(id, id).first()).n;

export async function listFriends(env, me) {
	const rows = await all(
		env.DB.prepare(
			`SELECT f.a, f.b, f.state, f.at, o.id, o.name, o.avatar, o.appear_offline, p.online, p.game, p.at AS seen,
			        EXISTS (SELECT 1 FROM mutes m WHERE m.account = ? AND m.muted = o.id) AS muted
			 FROM friends f JOIN accounts o ON o.id = CASE WHEN f.a = ? THEN f.b ELSE f.a END
			 LEFT JOIN presence p ON p.account = o.id
			 WHERE (f.a = ? OR f.b = ?) AND f.state != 'declined' ORDER BY o.name`,
		).bind(me.id, me.id, me.id, me.id),
	);
	const person = (r) => ({ id: r.id, name: r.name, avatar: r.avatar ?? null });
	const t = now();
	// One relation per person: a friendship outranks a request left from
	// crossing asks, and our own block hides everything else of theirs. A
	// block of theirs on us is invisible: our request to them stays in our
	// outgoing list, as any other would.
	const friendsWith = new Set(rows.filter((r) => r.state === "friends").map((r) => r.id));
	const blockedBy = new Set(rows.filter((r) => r.state === "blocked" && r.a === me.id).map((r) => r.id));
	const seen = new Set();
	return {
		friends: rows
			.filter((r) => r.state === "friends" && !blockedBy.has(r.id) && !seen.has(r.id) && seen.add(r.id))
			.map((r) => {
				const online = !r.appear_offline && !!r.online && t - (r.seen ?? 0) < ONLINE_MS;
				return { ...person(r), online, game: online ? (r.game ?? null) : null, muted: !!r.muted };
			}),
		incoming: rows.filter((r) => r.state === "pending" && r.b === me.id && !friendsWith.has(r.id) && !blockedBy.has(r.id)).map(person),
		outgoing: rows.filter((r) => r.state === "pending" && r.a === me.id && !friendsWith.has(r.id) && !blockedBy.has(r.id)).map(person),
		blocked: rows.filter((r) => r.state === "blocked" && r.a === me.id).map(person),
	};
}

/**
 * Ask `who` (an account id or a friend code) — or say yes, if they asked
 * first. Pushes only what is new: a request the first time, a yes once.
 */
export async function addFriend(env, me, who, gate = null) {
	const them = await findAccount(env, who, gate, "id, name");
	if (!them) throw new HttpError(404, "no such player");
	const other = them.id;
	if (other === me.id) throw new HttpError(400, "that is you");
	const rows = await pairRows(env, me.id, other);
	const mine = rows.find((r) => r.a === me.id);
	const theirs = rows.find((r) => r.a === other);
	// Blocked by them: everything goes as for anyone — the request is kept,
	// in our outgoing list — but they never see it and nothing is pushed.
	const silent = theirs?.state === "blocked";
	if (mine?.state === "blocked") throw new HttpError(400, "you blocked them — unblock them first");
	if (mine?.state === "friends" || theirs?.state === "friends") return { state: "friends" };
	if (theirs?.state === "pending") return accept(env, me, them);
	if (mine?.state === "pending") return { state: "pending" };
	if (mine?.state === "declined" && now() - mine.at < DECLINE_COOLDOWN_MS) {
		const days = Math.ceil((DECLINE_COOLDOWN_MS - (now() - mine.at)) / 86_400_000);
		throw new HttpError(429, `they said no for now; you can ask again in ${days} day${days === 1 ? "" : "s"}`);
	}
	const mineOut = await env.DB.prepare("SELECT COUNT(*) AS n FROM friends WHERE a = ? AND state = 'pending'").bind(me.id).first();
	if ((await friendCount(env, me.id)) + mineOut.n >= friendsMax(env)) throw new HttpError(400, `at most ${friendsMax(env)} friends`);
	// Who declined may change their mind: their 'declined' row goes, and this
	// is a new request of their own.
	const stmts = [];
	if (theirs?.state === "declined") stmts.push(env.DB.prepare("DELETE FROM friends WHERE a = ? AND b = ? AND state = 'declined'").bind(other, me.id));
	stmts.push(
		env.DB.prepare(
			`INSERT INTO friends (a, b, state, at) VALUES (?, ?, 'pending', ?)
			 ON CONFLICT (a, b) DO UPDATE SET state = 'pending', at = excluded.at WHERE friends.state = 'declined'`,
		).bind(me.id, other, now()),
	);
	const res = await env.DB.batch(stmts);
	// They asked at the same moment (crossing requests): that is a yes.
	const crossed = await env.DB.prepare("SELECT 1 FROM friends WHERE a = ? AND b = ? AND state = 'pending'").bind(other, me.id).first();
	if (crossed) return accept(env, me, them);
	if (res.at(-1)?.meta?.changes && !silent && (await firstAskToday(env, me.id, other))) {
		await push(env, other, { t: "friend", id: me.id, name: me.name, state: "asked" });
	}
	return { state: "pending" };
}

/**
 * At most one pushed request per pair a day, however often it is withdrawn
 * and asked again (D1 `request_pushes`). True when this one may be pushed.
 */
async function firstAskToday(env, asker, target) {
	const t = now();
	const res = await env.DB.prepare(
		`INSERT INTO request_pushes (asker, target, at) VALUES (?, ?, ?)
		 ON CONFLICT (asker, target) DO UPDATE SET at = excluded.at WHERE request_pushes.at <= ?`,
	)
		.bind(asker, target, t, t - REQUEST_PUSH_MS)
		.run();
	return !!res.meta?.changes;
}

/** `them` asked `me`: the friendship, within both friend caps. */
async function accept(env, me, them) {
	const max = friendsMax(env);
	if ((await friendCount(env, me.id)) >= max) throw new HttpError(400, `at most ${max} friends — remove someone first`);
	if ((await friendCount(env, them.id)) >= max) throw new HttpError(400, `${them.name} has ${max} friends already`);
	const [made] = await env.DB.batch([
		env.DB.prepare("UPDATE friends SET state = 'friends', at = ? WHERE a = ? AND b = ? AND state = 'pending'").bind(now(), them.id, me.id),
		// Our own request, crossing theirs, is answered by this.
		env.DB.prepare(
			"DELETE FROM friends WHERE a = ? AND b = ? AND state = 'pending' AND EXISTS (SELECT 1 FROM friends WHERE a = ? AND b = ? AND state = 'friends')",
		).bind(me.id, them.id, them.id, me.id),
	]);
	if (made?.meta?.changes) {
		await push(env, them.id, { t: "friend", id: me.id, name: me.name, state: "friends" });
		return { state: "friends" };
	}
	// Nothing changed: they withdrew, or a crossing ask got there first. Say
	// what is true now, so the page does not announce a friendship.
	const now2 = await pairRows(env, me.id, them.id);
	if (now2.some((r) => r.state === "friends")) return { state: "friends" };
	return { state: now2.some((r) => r.a === me.id && r.state === "pending") ? "pending" : "none" };
}

/** Unfriend, withdraw — or decline, which is remembered. Never lifts a block. */
export async function removeFriend(env, me, other) {
	await env.DB.batch([
		env.DB.prepare("UPDATE friends SET state = 'declined', at = ? WHERE a = ? AND b = ? AND state = 'pending'").bind(now(), other, me.id),
		env.DB.prepare("DELETE FROM friends WHERE a = ? AND b = ? AND state = 'pending'").bind(me.id, other),
		env.DB.prepare("DELETE FROM friends WHERE state = 'friends' AND ((a = ? AND b = ?) OR (a = ? AND b = ?))").bind(me.id, other, other, me.id),
		...forgetPair(env, me.id, other),
	]);
	return { state: "none" };
}

/** Waiting invites and mutes between two people (unfriended, blocked). */
const forgetPair = (env, x, y) => [
	env.DB.prepare("DELETE FROM invites WHERE (recipient = ? AND sender = ?) OR (recipient = ? AND sender = ?)").bind(x, y, y, x),
	env.DB.prepare("DELETE FROM mutes WHERE (account = ? AND muted = ?) OR (account = ? AND muted = ?)").bind(x, y, y, x),
];

export async function block(env, me, who) {
	const them = await findAccount(env, who, null, "id");
	if (!them) throw new HttpError(404, "no such player");
	const other = them.id;
	if (other === me.id) throw new HttpError(400, "that is you");
	await env.DB.batch([
		// Our own rows go (a request of ours, a friendship). Of theirs, only a
		// friendship: a request they are waiting on and a decline's cooldown
		// stay exactly as they were, so nothing they can see tells a block
		// from a request nobody answered (listFriends hides it from us).
		env.DB.prepare("DELETE FROM friends WHERE a = ? AND b = ?").bind(me.id, other),
		env.DB.prepare("DELETE FROM friends WHERE a = ? AND b = ? AND state = 'friends'").bind(other, me.id),
		env.DB.prepare("INSERT INTO friends (a, b, state, at) VALUES (?, ?, 'blocked', ?)").bind(me.id, other, now()),
		...forgetPair(env, me.id, other),
	]);
	return { state: "blocked" };
}

/**
 * Lift a block. A request of theirs that waited through it is left alone:
 * it shows as incoming now, to answer, and nothing changes on their side.
 */
export async function unblock(env, me, who) {
	const other = (await findAccount(env, who, null, "id"))?.id ?? who;
	const lifted = await env.DB.prepare("DELETE FROM friends WHERE a = ? AND b = ? AND state = 'blocked'").bind(me.id, other).run();
	return { state: "none", lifted: !!lifted.meta?.changes };
}

export async function mute(env, me, other, on) {
	if (on) {
		if (!(await areFriends(env, me.id, other))) throw new HttpError(400, "you can only mute a friend");
		await env.DB.batch([
			env.DB.prepare("INSERT OR IGNORE INTO mutes (account, muted, at) VALUES (?, ?, ?)").bind(me.id, other, now()),
			env.DB.prepare("DELETE FROM invites WHERE recipient = ? AND sender = ?").bind(me.id, other),
		]);
	} else await env.DB.prepare("DELETE FROM mutes WHERE account = ? AND muted = ?").bind(me.id, other).run();
	return { muted: !!on };
}

/**
 * People from your most recent ranked matches you might add: not you, not a
 * friend, nobody blocked either way, nobody hidden from public boards.
 * Bounded: the last 50 matches, a dozen people.
 */
export async function recentPlayers(env, me) {
	const players = await all(
		env.DB.prepare(
			`SELECT a.id, a.name, a.avatar, m.game, MAX(m.at) AS at
			 FROM (SELECT p.match FROM match_players p JOIN matches mm ON mm.id = p.match WHERE p.account = ? ORDER BY mm.at DESC LIMIT 50) mine
			 JOIN matches m ON m.id = mine.match
			 JOIN match_players q ON q.match = mine.match AND q.account != ?
			 JOIN accounts a ON a.id = q.account
			 WHERE a.hide_public = 0
			   AND NOT EXISTS (SELECT 1 FROM friends f WHERE f.state = 'friends'
			                   AND ((f.a = ? AND f.b = a.id) OR (f.a = a.id AND f.b = ?)))
			   -- our blocks only: theirs on us must not show
			   AND NOT EXISTS (SELECT 1 FROM friends f WHERE f.state = 'blocked' AND f.a = ? AND f.b = a.id)
			 GROUP BY a.id ORDER BY at DESC LIMIT 12`,
		).bind(me.id, me.id, me.id, me.id, me.id),
	);
	return { players: players.map((p) => ({ id: p.id, name: p.name, avatar: p.avatar ?? null, game: p.game, at: p.at })) };
}

// ------------------------------------------------------------------ invites

/**
 * Invite a friend into the party with this six-digit code: pushed to their
 * open pages, and kept for INVITE_TTL_MS for when they next open the arcade.
 * The answer is the same whether any page of theirs got it — a friend who
 * appears offline must not be given away by a count.
 *
 * With no page of theirs open, it goes to their devices as a notification
 * (Web Push, push.js; opt-in per device). Both deliveries run after the
 * answer (ctx.waitUntil), so neither its words nor its timing say which.
 * `game`: the name of the game the party is on, for the notification's body.
 */
export async function invite(env, me, other, request, { ctx = null } = {}) {
	const { code, game: gameName } = await body(request);
	if (!/^\d{6}$/.test(String(code ?? ""))) throw new HttpError(400, "an invite carries the party's six-digit code");
	if (!(await areFriends(env, me.id, other))) throw new HttpError(403, "you can only invite friends");
	const t = now();
	const since = t - inviteTtl(env);
	const last = await env.DB.prepare("SELECT at FROM invites WHERE recipient = ? AND sender = ?").bind(other, me.id).first();
	if (last && t - last.at < INVITE_AGAIN_MS) throw new HttpError(429, "you invited them just now");
	const sent = await env.DB.prepare("SELECT COUNT(*) AS n FROM invites WHERE sender = ? AND at > ?").bind(me.id, since).first();
	if (sent.n >= INVITES_PER_SENDER) throw new HttpError(429, "that is a lot of invites; wait a few minutes");
	// Muted by them: answered the same, and nothing is pushed or kept.
	if (await env.DB.prepare("SELECT 1 FROM mutes WHERE account = ? AND muted = ?").bind(other, me.id).first()) return { invited: true };
	const waiting = await env.DB.prepare("SELECT COUNT(*) AS n FROM invites WHERE recipient = ? AND sender != ? AND at > ?").bind(other, me.id, since).first();
	if (waiting.n >= INVITES_PER_RECIPIENT) throw new HttpError(429, "they have plenty of invites waiting; try again soon");
	await env.DB.batch([
		env.DB.prepare("DELETE FROM invites WHERE recipient = ? AND at <= ?").bind(other, since),
		env.DB.prepare(
			"INSERT INTO invites (recipient, sender, code, at) VALUES (?, ?, ?, ?) ON CONFLICT (recipient, sender) DO UPDATE SET code = excluded.code, at = excluded.at",
		).bind(other, me.id, String(code), t),
	]);
	const msg = { t: "invite", from: { id: me.id, name: me.name }, code: String(code), at: t };
	const game = typeof gameName === "string" ? cleanName(gameName).slice(0, 40) : "";
	const loopback = testing(env, request);
	const deliver = async () => {
		if (!(await push(env, other, msg))) await pushInvite(env, other, { ...msg, ...(game ? { game } : {}) }, { ttlMs: inviteTtl(env), loopback });
	};
	if (ctx?.waitUntil) ctx.waitUntil(deliver());
	else await deliver();
	return { invited: true };
}

/** The invites waiting for you, newest first (and the expired ones gone). */
export async function listInvites(env, me) {
	const since = now() - inviteTtl(env);
	const rows = await all(
		env.DB.prepare(
			`SELECT i.sender, i.code, i.at, a.name FROM invites i JOIN accounts a ON a.id = i.sender
			 WHERE i.recipient = ? AND i.at > ? ORDER BY i.at DESC LIMIT 5`,
		).bind(me.id, since),
	);
	await env.DB.prepare("DELETE FROM invites WHERE recipient = ? AND at <= ?").bind(me.id, since).run();
	return { invites: rows.map((r) => ({ from: { id: r.sender, name: r.name }, code: r.code, at: r.at })), ttl: inviteTtl(env) };
}

export async function dismissInvite(env, me, sender) {
	await env.DB.prepare("DELETE FROM invites WHERE recipient = ? AND sender = ?").bind(me.id, sender).run();
	return { dismissed: true };
}

/** Send `msg` to every open page of `account`; how many got it (never told to a sender). */
export async function push(env, account, msg) {
	if (!env.LIVE) return 0;
	try {
		const res = await env.LIVE.get(env.LIVE.idFromName(account)).fetch("https://live/push", {
			method: "POST",
			body: JSON.stringify(msg),
		});
		return (await res.json()).delivered ?? 0;
	} catch (err) {
		console.error("push", err);
		return 0;
	}
}

// ------------------------------------------------------------------ groups

const cleanName = (raw) =>
	String(raw ?? "")
		.replace(/[\u0000-\u001f\u007f]/g, "")
		.trim();
const groupCount = async (env, account) => (await env.DB.prepare("SELECT COUNT(*) AS n FROM group_members WHERE account = ?").bind(account).first()).n;

export async function listGroups(env, me) {
	return {
		groups: await all(
			env.DB.prepare(
				`SELECT g.id, g.name, g.code, g.owner = ? AS mine, (SELECT COUNT(*) FROM group_members m WHERE m.grp = g.id) AS members
				 FROM group_members gm JOIN groups g ON g.id = gm.grp WHERE gm.account = ? ORDER BY g.name`,
			).bind(me.id, me.id),
		),
	};
}

export async function createGroup(env, me, request) {
	const name = cleanName((await body(request)).name);
	if (!name || name.length > 32) throw new HttpError(400, "a group's name is 1–32 characters");
	if ((await groupCount(env, me.id)) >= groupsMax(env)) throw new HttpError(400, `at most ${groupsMax(env)} groups`);
	const id = randomId(8);
	// A join code people can say: eight letters/digits, no look-alikes.
	const code = newCode();
	await env.DB.batch([
		env.DB.prepare("INSERT INTO groups (id, name, owner, code, created) VALUES (?, ?, ?, ?, ?)").bind(id, name, me.id, code, now()),
		env.DB.prepare("INSERT INTO group_members (grp, account, joined) VALUES (?, ?, ?)").bind(id, me.id, now()),
	]);
	return { id, name, code, mine: 1, members: 1 };
}

export async function joinGroup(env, me, request) {
	const code = String((await body(request)).code ?? "")
		.toUpperCase()
		.replace(/[^A-Z0-9]/g, "");
	const g = await env.DB.prepare("SELECT id, name FROM groups WHERE code = ?").bind(code).first();
	if (!g) throw new HttpError(404, "no group has that code");
	if (await env.DB.prepare("SELECT 1 FROM group_members WHERE grp = ? AND account = ?").bind(g.id, me.id).first()) return { id: g.id, name: g.name };
	if (await env.DB.prepare("SELECT 1 FROM group_bans WHERE grp = ? AND account = ?").bind(g.id, me.id).first()) {
		throw new HttpError(403, "the group's owner removed you from it");
	}
	if ((await groupCount(env, me.id)) >= groupsMax(env)) throw new HttpError(400, `at most ${groupsMax(env)} groups — leave one first`);
	const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM group_members WHERE grp = ?").bind(g.id).first();
	if (n.n >= GROUP_MEMBERS_MAX) throw new HttpError(400, "that group is full");
	await env.DB.prepare("INSERT OR IGNORE INTO group_members (grp, account, joined) VALUES (?, ?, ?)").bind(g.id, me.id, now()).run();
	return { id: g.id, name: g.name };
}

export async function getGroup(env, me, id) {
	const g = await env.DB.prepare("SELECT id, name, owner, code, created FROM groups WHERE id = ?").bind(id).first();
	if (!g) throw new HttpError(404, "no such group");
	const members = await all(
		env.DB.prepare("SELECT a.id, a.name, a.avatar, gm.joined FROM group_members gm JOIN accounts a ON a.id = gm.account WHERE gm.grp = ? ORDER BY gm.joined, a.id").bind(id),
	);
	if (!members.some((m) => m.id === me.id)) throw new HttpError(403, "you are not in that group");
	// The games its members are ranked in: the boards worth a link (the
	// group's board then counts only their games against each other).
	const games = (
		await all(
			env.DB.prepare(
				`SELECT r.game, COUNT(*) AS n FROM ratings r JOIN group_members gm ON gm.account = r.account
				 WHERE gm.grp = ? GROUP BY r.game ORDER BY n DESC, r.game LIMIT 24`,
			).bind(id),
		)
	).map((r) => r.game);
	const mine = g.owner === me.id;
	const out = { ...g, mine, members, games };
	if (mine) {
		out.bans = await all(env.DB.prepare("SELECT a.id, a.name, b.at FROM group_bans b JOIN accounts a ON a.id = b.account WHERE b.grp = ? ORDER BY b.at DESC LIMIT 100").bind(id));
	}
	return out;
}

/** The group, if `me` owns it; else 404 or 403. */
async function owned(env, me, id) {
	const g = await env.DB.prepare("SELECT id, name, owner, code FROM groups WHERE id = ?").bind(id).first();
	if (!g) throw new HttpError(404, "no such group");
	if (g.owner !== me.id) throw new HttpError(403, "only the group's owner can do that");
	return g;
}

export async function renameGroup(env, me, id, request) {
	await owned(env, me, id);
	const name = cleanName((await body(request)).name);
	if (!name || name.length > 32) throw new HttpError(400, "a group's name is 1–32 characters");
	await env.DB.prepare("UPDATE groups SET name = ? WHERE id = ?").bind(name, id).run();
	return { id, name };
}

/** A fresh join code for the group (the old one stops working). */
async function newGroupCode(env, id) {
	for (let i = 0; i < 4; i++) {
		const code = newCode();
		try {
			await env.DB.prepare("UPDATE groups SET code = ? WHERE id = ?").bind(code, id).run();
			return code;
		} catch (err) {
			if (!/UNIQUE/i.test(String(err?.message))) throw err;
		}
	}
	throw new HttpError(503, "could not make a new code; try again");
}

export async function rotateGroupCode(env, me, id) {
	await owned(env, me, id);
	return { id, code: await newGroupCode(env, id) };
}

export async function transferGroup(env, me, id, request) {
	await owned(env, me, id);
	const to = String((await body(request)).account ?? "");
	if (to === me.id) return { id, owner: me.id };
	// One statement: the new owner is a member at that instant (not one who
	// left a moment ago), and we still own it.
	const res = await env.DB.prepare(
		"UPDATE groups SET owner = ? WHERE id = ? AND owner = ? AND EXISTS (SELECT 1 FROM group_members WHERE grp = ? AND account = ?)",
	)
		.bind(to, id, me.id, id, to)
		.run();
	if (!res.meta?.changes) throw new HttpError(400, "the new owner must be a member");
	return { id, owner: to };
}

export async function deleteGroup(env, me, id) {
	await owned(env, me, id);
	await env.DB.batch([
		env.DB.prepare("DELETE FROM group_members WHERE grp = ?").bind(id),
		env.DB.prepare("DELETE FROM group_bans WHERE grp = ?").bind(id),
		env.DB.prepare("DELETE FROM groups WHERE id = ?").bind(id),
	]);
	return { deleted: true };
}

/**
 * Someone leaves (anyone, the owner too), or the owner removes them — which
 * keeps them out (group_bans) and rotates the code, since they know it.
 */
export async function removeMember(env, me, id, account) {
	const g = await env.DB.prepare("SELECT owner FROM groups WHERE id = ?").bind(id).first();
	if (!g) throw new HttpError(404, "no such group");
	if (account === me.id) {
		await env.DB.batch(handover(env, me.id, id));
		return { removed: true };
	}
	if (g.owner !== me.id) throw new HttpError(403, "only its owner can remove someone");
	// Only a member is removed (and banned); removing one again is a no-op.
	// Nobody else can be banned ahead of time.
	if (!(await env.DB.prepare("SELECT 1 FROM group_members WHERE grp = ? AND account = ?").bind(id, account).first())) {
		if (await env.DB.prepare("SELECT 1 FROM group_bans WHERE grp = ? AND account = ?").bind(id, account).first()) return { removed: true };
		throw new HttpError(404, "they are not in this group");
	}
	await env.DB.batch([
		env.DB.prepare("DELETE FROM group_members WHERE grp = ? AND account = ?").bind(id, account),
		env.DB.prepare("INSERT OR REPLACE INTO group_bans (grp, account, at) VALUES (?, ?, ?)").bind(id, account, now()),
	]);
	return { removed: true, code: await newGroupCode(env, id) };
}

export async function unban(env, me, id, account) {
	await owned(env, me, id);
	await env.DB.prepare("DELETE FROM group_bans WHERE grp = ? AND account = ?").bind(id, account).run();
	return { unbanned: true };
}

/**
 * `account` leaves `grp` — or every group, with no `grp` (deleting the
 * account, worker/api/me.js): a group it owns passes to its longest-standing
 * other member, and one with nobody left is deleted. Statements for one
 * batch, so ownership moves before the membership goes.
 */
export function handover(env, account, grp = null) {
	const only = grp ? " AND id = ?" : "";
	const args = grp ? [grp] : [];
	return [
		env.DB.prepare(
			`UPDATE groups SET owner = (SELECT gm.account FROM group_members gm WHERE gm.grp = groups.id AND gm.account != ? ORDER BY gm.joined, gm.account LIMIT 1)
			 WHERE owner = ?${only} AND EXISTS (SELECT 1 FROM group_members gm WHERE gm.grp = groups.id AND gm.account != ?)`,
		).bind(account, account, ...args, account),
		env.DB.prepare(`DELETE FROM group_members WHERE account = ?${grp ? " AND grp = ?" : ""}`).bind(account, ...args),
		// Still ours: nobody else was in it.
		env.DB.prepare(`DELETE FROM group_bans WHERE grp IN (SELECT id FROM groups WHERE owner = ?${only})`).bind(account, ...args),
		env.DB.prepare(`DELETE FROM groups WHERE owner = ?${only}`).bind(account, ...args),
	];
}
