// worker/api/me.js — the signed-in player's own account: profile, settings,
// favourites, export, deletion.
//
//   GET    /api/me             { id, name, avatar, provider, hidePublic, appearOffline,
//                              friendCode } — the code is given here the first time
//   PATCH  /api/me             { name?, hidePublic?, appearOffline? }
//   DELETE /api/me             every row of ours, at once; the session too
//   GET    /api/me/export      all of it, as one JSON document: profile, sign-ins,
//                              favourites, ratings, wins against bots, runs,
//                              matches (paged), pending reports, friends,
//                              groups, sessions, feedback posts, presence,
//                              devices getting invites as notifications (no keys)
//   GET    /api/me/favs        { favs: [id] }
//   PUT    /api/me/favs        { favs: [id] } — replaces (the page merges first);
//                              an id is a game's, "contributor:<login>" or
//                              "collection:<owner>/<repo>" (lib/stats.js favId)
//   POST   /api/me/signout     ends this session only
//   POST   /api/me/link/<p>    { back } → { url }: connect GitHub or Google
//   DELETE /api/me/identities/<p>  disconnect one (never the last)

import { linkUrl, signOut } from "./auth.js";
import { GAME_ID, HttpError, body } from "./http.js";
import { shownRating } from "./match.js";
import { ensureFriendCode, handover } from "./social.js";

const parse = (text) => {
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
};

export const profile = (a, identities = []) => ({
	id: a.id,
	name: a.name,
	avatar: a.avatar ?? null,
	provider: a.provider,
	// The sign-ins on this account; GitHub's login is what feedback is posted as.
	identities: identities.map((i) => ({ provider: i.provider, login: i.login ?? null, linked: i.linked })),
	hidePublic: !!a.hide_public,
	appearOffline: !!a.appear_offline,
	// The short, rotatable code a friend link and QR carry (social.js).
	friendCode: a.friend_code ?? null,
});
const identitiesOf = async (env, account) =>
	(await env.DB.prepare("SELECT provider, login, linked FROM identities WHERE account = ? ORDER BY linked").bind(account).all()).results ?? [];

const all = async (stmt) => (await stmt.all()).results ?? [];

// A favourite: a game, a contributor (a GitHub login) or a collection (a
// games repo). The favs table's `game` column is free text: no migration.
const LOGIN = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})";
const FAV_ID = new RegExp(`^(?:contributor:${LOGIN}|collection:${LOGIN}/(?!\\.\\.?$)[A-Za-z0-9_.-]{1,100})$`);
const favOk = (id) => typeof id === "string" && (GAME_ID.test(id) || FAV_ID.test(id));

export async function getMe(env, me) {
	await ensureFriendCode(env, me);
	return profile(me, await identitiesOf(env, me.id));
}

export async function link(env, me, provider, request) {
	const { back } = await body(request);
	if (!["github", "google"].includes(provider)) throw new HttpError(404, "no such sign-in");
	return { url: await linkUrl(env, request, me.id, provider, String(back ?? "")) };
}

/** Disconnect a sign-in (and, for GitHub, forget its kept token). Never the last one. */
export async function unlink(env, me, provider) {
	const ids = await identitiesOf(env, me.id);
	if (!ids.some((i) => i.provider === provider)) throw new HttpError(404, `no ${provider} sign-in on this account`);
	if (ids.length < 2) throw new HttpError(400, "connect another sign-in first — an account needs one");
	await env.DB.prepare("DELETE FROM identities WHERE account = ? AND provider = ?").bind(me.id, provider).run();
	return getMe(env, me);
}

export async function patchMe(env, me, request) {
	const b = await body(request);
	const sets = [];
	const args = [];
	if (b.name !== undefined) {
		const name = String(b.name).replace(/[\u0000-\u001f\u007f]/g, "").trim();
		if (!name || name.length > 24) throw new HttpError(400, "a name is 1–24 characters");
		sets.push("name = ?");
		args.push(name);
	}
	for (const [key, col] of [
		["hidePublic", "hide_public"],
		["appearOffline", "appear_offline"],
	]) {
		if (b[key] === undefined) continue;
		if (typeof b[key] !== "boolean") throw new HttpError(400, `${key} is true or false`);
		sets.push(`${col} = ?`);
		args.push(b[key] ? 1 : 0);
	}
	if (sets.length) await env.DB.prepare(`UPDATE accounts SET ${sets.join(", ")} WHERE id = ?`).bind(...args, me.id).run();
	// Appear offline is applied where presence is read (social.js listFriends),
	// never written into `presence`: turning it off again then shows the
	// player online, in their game, at once (audit D16).
	return profile(await env.DB.prepare("SELECT * FROM accounts WHERE id = ?").bind(me.id).first(), await identitiesOf(env, me.id));
}

/**
 * Everything, gone. Matches other people played stay theirs: our row in them
 * is removed and the match keeps its other players (it was their game too).
 */
export async function deleteMe(env, me) {
	const id = me.id;
	await env.DB.batch([
		env.DB.prepare("DELETE FROM sessions WHERE account = ?").bind(id),
		env.DB.prepare("DELETE FROM identities WHERE account = ?").bind(id),
		env.DB.prepare("DELETE FROM favs WHERE account = ?").bind(id),
		env.DB.prepare("DELETE FROM reports WHERE account = ?").bind(id),
		env.DB.prepare("DELETE FROM runs WHERE account = ?").bind(id),
		env.DB.prepare("DELETE FROM match_players WHERE account = ?").bind(id),
		env.DB.prepare("DELETE FROM ratings WHERE account = ?").bind(id),
		env.DB.prepare("DELETE FROM bot_wins WHERE account = ?").bind(id),
		env.DB.prepare("DELETE FROM friends WHERE a = ? OR b = ?").bind(id, id),
		env.DB.prepare("DELETE FROM presence WHERE account = ?").bind(id),
		// A group we own passes to its longest-standing member; ours alone goes.
		...handover(env, id),
		env.DB.prepare("DELETE FROM group_bans WHERE account = ?").bind(id),
		env.DB.prepare("DELETE FROM invites WHERE recipient = ? OR sender = ?").bind(id, id),
		env.DB.prepare("DELETE FROM mutes WHERE account = ? OR muted = ?").bind(id, id),
		env.DB.prepare("DELETE FROM request_pushes WHERE asker = ? OR target = ?").bind(id, id),
		env.DB.prepare("DELETE FROM push_subs WHERE account = ?").bind(id),
		env.DB.prepare("DELETE FROM invite_notices WHERE recipient = ? OR sender = ?").bind(id, id),
		env.DB.prepare("DELETE FROM feedback_log WHERE account = ?").bind(id),
		env.DB.prepare("DELETE FROM accounts WHERE id = ?").bind(id),
	]);
	return { deleted: true };
}

/**
 * Matches per export page: turning D1's rows into JSON and back is CPU on the
 * Worker (~0.75 ms a thousand, docs/accounts.md "CPU"), and the free plan
 * allows 10 ms a request. `matchesNext` names the next page, or is null.
 */
export const EXPORT_PAGE = 2000;

export async function exportMe(env, me, page = 0) {
	const q = (sql, ...a) => all(env.DB.prepare(sql).bind(...a));
	page = Number.isInteger(page) && page >= 0 ? page : 0;
	const matches = await q(
		"SELECT m.id, m.game, m.kind, m.ranking, m.scores, m.at, p.place FROM match_players p JOIN matches m ON m.id = p.match WHERE p.account = ? ORDER BY m.at DESC, m.id LIMIT ? OFFSET ?",
		me.id,
		EXPORT_PAGE + 1,
		page * EXPORT_PAGE,
	);
	return {
		exported: new Date().toISOString(),
		account: { ...profile(me, await identitiesOf(env, me.id)), created: new Date(me.created).toISOString() },
		// Which sign-ins, and whether a GitHub token is kept (never the token itself).
		identities: (await q("SELECT provider, login, linked, token_enc IS NOT NULL AS githubTokenKept FROM identities WHERE account = ?", me.id)),
		favourites: (await q("SELECT game FROM favs WHERE account = ?", me.id)).map((r) => r.game),
		// As shown everywhere else: `rated` and `provisional` on rated boards (match.js shownRating).
		ratings: (await q("SELECT game, elo, games, wins, best FROM ratings WHERE account = ?", me.id)).map((r) => shownRating(r)),
		winsAgainstBots: await q("SELECT game, wins, first, at FROM bot_wins WHERE account = ?", me.id),
		// Every run the server issued us, alone or against bots (worker/api/runs.js; kept 4 days).
		runs: await q("SELECT id, game, vs, seed, at, used, counted, daily FROM runs WHERE account = ? ORDER BY at DESC", me.id),
		// Reports of ours not yet settled, the starts we said we were seated in,
		// and outcomes not yet read back (worker/api/match.js; minutes to hours).
		reports: (await q("SELECT match, digest, payload, at FROM reports WHERE account = ? ORDER BY at DESC", me.id)).map((r) => ({
			match: r.match,
			state: r.digest === "start" ? "started" : r.digest === "counted" ? "counted" : "pending",
			at: r.at,
			...(r.payload ? { result: parse(r.payload) } : {}),
		})),
		feedbackPosts: (await q("SELECT at FROM feedback_log WHERE account = ? ORDER BY at DESC", me.id)).map((r) => r.at),
		presence: (await q("SELECT online, game, at FROM presence WHERE account = ?", me.id))[0] ?? null,
		matches: matches.slice(0, EXPORT_PAGE),
		matchesPage: page,
		matchesNext: matches.length > EXPORT_PAGE ? page + 1 : null,
		// Not a block of theirs on us: a block is never told.
		friends: await q("SELECT a, b, state, at FROM friends WHERE a = ? OR (b = ? AND state != 'blocked')", me.id, me.id),
		// Groups we were removed from, and the removals we made in ours.
		groupBans: await q("SELECT grp, account, at FROM group_bans WHERE account = ? OR grp IN (SELECT id FROM groups WHERE owner = ?)", me.id, me.id),
		groups: await q(
			"SELECT g.id, g.name, g.owner = ? AS owner, gm.joined FROM group_members gm JOIN groups g ON g.id = gm.grp WHERE gm.account = ?",
			me.id,
			me.id,
		),
		mutes: await q("SELECT muted, at FROM mutes WHERE account = ?", me.id),
		// When a request of ours was last pushed (one a pair a day).
		requestPushes: await q("SELECT target, at FROM request_pushes WHERE asker = ?", me.id),
		invites: await q("SELECT sender, recipient, code, at FROM invites WHERE recipient = ? OR sender = ?", me.id, me.id),
		sessions: await q("SELECT created, exp FROM sessions WHERE account = ?", me.id),
		// Devices getting invites as notifications (worker/api/push.js): which
		// push service, since when, last refreshed. Not the endpoint nor the
		// keys: together they let anyone send to that device, and an export
		// is a file people keep and pass around.
		// When a friend's invite last reached one of our devices as a notification.
		inviteNotices: await q("SELECT sender, code, at FROM invite_notices WHERE recipient = ?", me.id),
		pushDevices: (await q("SELECT endpoint, created, at FROM push_subs WHERE account = ? ORDER BY at DESC", me.id)).map((r) => ({
			service: new URL(r.endpoint).host,
			created: r.created,
			at: r.at,
		})),
	};
}

export async function getFavs(env, me) {
	return { favs: (await all(env.DB.prepare("SELECT game FROM favs WHERE account = ? ORDER BY game").bind(me.id))).map((r) => r.game) };
}

export async function putFavs(env, me, request) {
	const { favs } = await body(request);
	if (!Array.isArray(favs) || favs.length > 200 || !favs.every(favOk)) {
		throw new HttpError(400, "favs is a list of game, contributor: or collection: ids");
	}
	await env.DB.batch([
		env.DB.prepare("DELETE FROM favs WHERE account = ?").bind(me.id),
		...[...new Set(favs)].map((g) => env.DB.prepare("INSERT INTO favs (account, game) VALUES (?, ?)").bind(me.id, g)),
	]);
	return getFavs(env, me);
}

export { signOut };
