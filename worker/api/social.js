// worker/api/social.js — friends, presence, party invites, groups.
//
// Friends (Lokesh, 2026-11-13):
//   GET    /api/friends              { friends: [{id,name,avatar,online,game}], incoming, outgoing }
//   POST   /api/friends/<id>         ask — or accept, if they asked first
//   DELETE /api/friends/<id>         unfriend, decline or withdraw
//   POST   /api/friends/<id>/invite  { code } → pushed to their open pages
//
// An account id is the friend code: the profile page shows it as a link and a
// QR, and the party screen offers ADD FRIEND on a signed-in member. Online
// means a page of theirs holds the live socket (live.js) and they have not
// chosen "appear offline"; `game` is what that page is playing.
//
// Groups:
//   GET    /api/groups                     the groups you are in
//   POST   /api/groups { name }            make one; you own it
//   POST   /api/groups/join { code }       join by its code
//   GET    /api/groups/<id>                its members (members only)
//   DELETE /api/groups/<id>                the owner deletes it
//   DELETE /api/groups/<id>/members/<acct> the owner removes someone; anyone leaves

import { HttpError, body, now, randomId } from "./http.js";

const all = async (stmt) => (await stmt.all()).results ?? [];
export const FRIENDS_MAX = 200;
export const GROUPS_MAX = 20;
export const GROUP_MEMBERS_MAX = 100;
const ONLINE_MS = 10 * 60_000; // a live page heartbeats every 4 minutes

export async function friendIds(env, me) {
	const rows = await all(env.DB.prepare("SELECT a, b FROM friends WHERE state = 'friends' AND (a = ? OR b = ?)").bind(me, me));
	return rows.map((r) => (r.a === me ? r.b : r.a));
}
const areFriends = async (env, x, y) =>
	!!(await env.DB.prepare("SELECT 1 FROM friends WHERE state = 'friends' AND ((a = ? AND b = ?) OR (a = ? AND b = ?))").bind(x, y, y, x).first());

export async function listFriends(env, me) {
	const rows = await all(
		env.DB.prepare(
			`SELECT f.a, f.b, f.state, f.at, o.id, o.name, o.avatar, o.appear_offline, p.online, p.game, p.at AS seen
			 FROM friends f JOIN accounts o ON o.id = CASE WHEN f.a = ? THEN f.b ELSE f.a END
			 LEFT JOIN presence p ON p.account = o.id
			 WHERE f.a = ? OR f.b = ? ORDER BY o.name`,
		).bind(me.id, me.id, me.id),
	);
	const person = (r) => ({ id: r.id, name: r.name, avatar: r.avatar ?? null });
	const t = now();
	return {
		friends: rows
			.filter((r) => r.state === "friends")
			.map((r) => {
				const online = !r.appear_offline && !!r.online && t - (r.seen ?? 0) < ONLINE_MS;
				return { ...person(r), online, game: online ? (r.game ?? null) : null };
			}),
		incoming: rows.filter((r) => r.state === "pending" && r.b === me.id).map(person),
		outgoing: rows.filter((r) => r.state === "pending" && r.a === me.id).map(person),
	};
}

export async function addFriend(env, me, other) {
	if (other === me.id) throw new HttpError(400, "that is you");
	const them = await env.DB.prepare("SELECT id, name FROM accounts WHERE id = ?").bind(other).first();
	if (!them) throw new HttpError(404, "no such player");
	const theirs = await env.DB.prepare("SELECT state FROM friends WHERE a = ? AND b = ?").bind(other, me.id).first();
	if (theirs) {
		// They asked first: this is the yes.
		await env.DB.prepare("UPDATE friends SET state = 'friends', at = ? WHERE a = ? AND b = ?").bind(now(), other, me.id).run();
		await push(env, other, { t: "friend", id: me.id, name: me.name, state: "friends" });
		return { state: "friends" };
	}
	const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM friends WHERE a = ? OR b = ?").bind(me.id, me.id).first();
	if (count.n >= FRIENDS_MAX) throw new HttpError(400, `at most ${FRIENDS_MAX} friends`);
	await env.DB.prepare("INSERT OR IGNORE INTO friends (a, b, state, at) VALUES (?, ?, 'pending', ?)").bind(me.id, other, now()).run();
	await push(env, other, { t: "friend", id: me.id, name: me.name, state: "asked" });
	return { state: (await env.DB.prepare("SELECT state FROM friends WHERE a = ? AND b = ?").bind(me.id, other).first())?.state ?? "pending" };
}

export async function removeFriend(env, me, other) {
	await env.DB.prepare("DELETE FROM friends WHERE (a = ? AND b = ?) OR (a = ? AND b = ?)").bind(me.id, other, other, me.id).run();
	return { state: "none" };
}

/** Invite a friend into the party with this six-digit code. */
export async function invite(env, me, other, request) {
	const { code } = await body(request);
	if (!/^\d{6}$/.test(String(code ?? ""))) throw new HttpError(400, "an invite carries the party's six-digit code");
	if (!(await areFriends(env, me.id, other))) throw new HttpError(403, "you can only invite friends");
	const delivered = await push(env, other, { t: "invite", from: { id: me.id, name: me.name }, code: String(code), at: now() });
	return { delivered };
}

/** Send `msg` to every open page of `account`; how many got it. */
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
	const name = String((await body(request)).name ?? "")
		.replace(/[\u0000-\u001f\u007f]/g, "")
		.trim();
	if (!name || name.length > 32) throw new HttpError(400, "a group's name is 1–32 characters");
	const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM group_members WHERE account = ?").bind(me.id).first();
	if (n.n >= GROUPS_MAX) throw new HttpError(400, `at most ${GROUPS_MAX} groups`);
	const id = randomId(8);
	// A join code people can say: eight letters/digits, no look-alikes.
	const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
	const code = [...crypto.getRandomValues(new Uint8Array(8))].map((x) => alphabet[x % alphabet.length]).join("");
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
	const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM group_members WHERE grp = ?").bind(g.id).first();
	if (n.n >= GROUP_MEMBERS_MAX) throw new HttpError(400, "that group is full");
	await env.DB.prepare("INSERT OR IGNORE INTO group_members (grp, account, joined) VALUES (?, ?, ?)").bind(g.id, me.id, now()).run();
	return { id: g.id, name: g.name };
}

export async function getGroup(env, me, id) {
	const g = await env.DB.prepare("SELECT id, name, owner, code, created FROM groups WHERE id = ?").bind(id).first();
	if (!g) throw new HttpError(404, "no such group");
	const members = await all(
		env.DB.prepare("SELECT a.id, a.name, a.avatar, gm.joined FROM group_members gm JOIN accounts a ON a.id = gm.account WHERE gm.grp = ? ORDER BY gm.joined").bind(id),
	);
	if (!members.some((m) => m.id === me.id)) throw new HttpError(403, "you are not in that group");
	return { ...g, mine: g.owner === me.id, members };
}

export async function deleteGroup(env, me, id) {
	const g = await env.DB.prepare("SELECT owner FROM groups WHERE id = ?").bind(id).first();
	if (!g) throw new HttpError(404, "no such group");
	if (g.owner !== me.id) throw new HttpError(403, "only its owner can delete a group");
	await env.DB.batch([env.DB.prepare("DELETE FROM group_members WHERE grp = ?").bind(id), env.DB.prepare("DELETE FROM groups WHERE id = ?").bind(id)]);
	return { deleted: true };
}

export async function removeMember(env, me, id, account) {
	const g = await env.DB.prepare("SELECT owner FROM groups WHERE id = ?").bind(id).first();
	if (!g) throw new HttpError(404, "no such group");
	if (account !== me.id && g.owner !== me.id) throw new HttpError(403, "only its owner can remove someone");
	if (account === g.owner) throw new HttpError(400, "the owner deletes the group instead of leaving it");
	await env.DB.prepare("DELETE FROM group_members WHERE grp = ? AND account = ?").bind(id, account).run();
	return { removed: true };
}
