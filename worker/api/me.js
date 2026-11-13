// worker/api/me.js — the signed-in player's own account: profile, settings,
// favourites, export, deletion.
//
//   GET    /api/me             { id, name, avatar, provider, hidePublic, appearOffline }
//   PATCH  /api/me             { name?, hidePublic?, appearOffline? }
//   DELETE /api/me             every row of ours, at once; the session too
//   GET    /api/me/export      all of it, as one JSON document
//   GET    /api/me/favs        { favs: [game] }
//   PUT    /api/me/favs        { favs: [game] } — replaces (the page merges first)
//   POST   /api/me/signout     ends this session only
//   POST   /api/me/link/<p>    { back } → { url }: connect GitHub or Google
//   DELETE /api/me/identities/<p>  disconnect one (never the last)

import { linkUrl, signOut } from "./auth.js";
import { GAME_ID, HttpError, body } from "./http.js";

export const profile = (a, identities = []) => ({
	id: a.id,
	name: a.name,
	avatar: a.avatar ?? null,
	provider: a.provider,
	// The sign-ins on this account; GitHub's login is what feedback is posted as.
	identities: identities.map((i) => ({ provider: i.provider, login: i.login ?? null, linked: i.linked })),
	hidePublic: !!a.hide_public,
	appearOffline: !!a.appear_offline,
});
const identitiesOf = async (env, account) =>
	(await env.DB.prepare("SELECT provider, login, linked FROM identities WHERE account = ? ORDER BY linked").bind(account).all()).results ?? [];

const all = async (stmt) => (await stmt.all()).results ?? [];

export async function getMe(env, me) {
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
	if (b.appearOffline === true) await env.DB.prepare("UPDATE presence SET online = 0 WHERE account = ?").bind(me.id).run();
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
		env.DB.prepare("DELETE FROM match_players WHERE account = ?").bind(id),
		env.DB.prepare("DELETE FROM ratings WHERE account = ?").bind(id),
		env.DB.prepare("DELETE FROM friends WHERE a = ? OR b = ?").bind(id, id),
		env.DB.prepare("DELETE FROM presence WHERE account = ?").bind(id),
		env.DB.prepare("DELETE FROM group_members WHERE account = ?").bind(id),
		env.DB.prepare("DELETE FROM group_members WHERE grp IN (SELECT id FROM groups WHERE owner = ?)").bind(id),
		env.DB.prepare("DELETE FROM groups WHERE owner = ?").bind(id),
		env.DB.prepare("DELETE FROM feedback_log WHERE account = ?").bind(id),
		env.DB.prepare("DELETE FROM accounts WHERE id = ?").bind(id),
	]);
	return { deleted: true };
}

export async function exportMe(env, me) {
	const q = (sql, ...a) => all(env.DB.prepare(sql).bind(...a));
	return {
		exported: new Date().toISOString(),
		account: { ...profile(me, await identitiesOf(env, me.id)), created: new Date(me.created).toISOString() },
		// Which sign-ins, and whether a GitHub token is kept (never the token itself).
		identities: (await q("SELECT provider, login, linked, token_enc IS NOT NULL AS githubTokenKept FROM identities WHERE account = ?", me.id)),
		favourites: (await q("SELECT game FROM favs WHERE account = ?", me.id)).map((r) => r.game),
		ratings: await q("SELECT game, elo, games, wins, best FROM ratings WHERE account = ?", me.id),
		matches: await q(
			"SELECT m.id, m.game, m.kind, m.ranking, m.scores, m.at, p.place FROM match_players p JOIN matches m ON m.id = p.match WHERE p.account = ? ORDER BY m.at DESC",
			me.id,
		),
		friends: await q("SELECT a, b, state, at FROM friends WHERE a = ? OR b = ?", me.id, me.id),
		groups: await q(
			"SELECT g.id, g.name, g.owner = ? AS owner, gm.joined FROM group_members gm JOIN groups g ON g.id = gm.grp WHERE gm.account = ?",
			me.id,
			me.id,
		),
		sessions: await q("SELECT created, exp FROM sessions WHERE account = ?", me.id),
	};
}

export async function getFavs(env, me) {
	return { favs: (await all(env.DB.prepare("SELECT game FROM favs WHERE account = ? ORDER BY game").bind(me.id))).map((r) => r.game) };
}

export async function putFavs(env, me, request) {
	const { favs } = await body(request);
	if (!Array.isArray(favs) || favs.length > 200 || !favs.every((g) => typeof g === "string" && GAME_ID.test(g))) {
		throw new HttpError(400, "favs is a list of game ids");
	}
	await env.DB.batch([
		env.DB.prepare("DELETE FROM favs WHERE account = ?").bind(me.id),
		...[...new Set(favs)].map((g) => env.DB.prepare("INSERT INTO favs (account, game) VALUES (?, ?)").bind(me.id, g)),
	]);
	return getFavs(env, me);
}

export { signOut };
