// worker/api/feedback.js — feedback on a game, kept in GitHub Discussions.
//
//   GET  /api/feedback/<game>   { url, comments: [{ name, text, at }] } (latest 20)
//   POST /api/feedback/<game>   { text } — signed in with GitHub connected;
//                               5 a day; 1–2000 characters
//
// One discussion per game ("Feedback: <game>") in the category named by
// GH_FEEDBACK_CATEGORY (default "Game feedback"), opened by the arcade's
// GitHub App on the first post. Each comment is the player's own: posted
// with their GitHub App user token (Lokesh, 2026-11-13: "the discussions
// should be from the users account"), so it shows as theirs, "via" the App.
// A player signed in with Google connects GitHub first (code "github").
// Moderation happens on GitHub. An "@" is broken with a zero-width space so a
// post cannot ping anyone.

import { graphql, graphqlAs } from "./github.js";
import { tokenFor } from "./vault.js";
import { repoOf } from "./github.js";
import { GAME_ID, HttpError, body, now } from "./http.js";

export const POSTS_PER_DAY = 5;
const BYLINE = /^\*\*from (.+?)\*\* · [^\n]*\n\n/;
const cacheKey = (game) => `https://feedback.cache/${encodeURIComponent(game)}`;

async function kv(env, k) {
	return (await env.DB.prepare("SELECT v FROM kv WHERE k = ?").bind(k).first())?.v ?? null;
}
async function setKv(env, k, v) {
	await env.DB.prepare("INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)").bind(k, v).run();
}

/** The repository's node id and the feedback category's, found once. */
async function ids(env) {
	const known = await kv(env, `gh:ids:${repoOf(env)}`);
	if (known) return JSON.parse(known);
	const [owner, name] = repoOf(env).split("/");
	const data = await graphql(
		env,
		`query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id discussionCategories(first: 50) { nodes { id name } } } }`,
		{ owner, name },
	);
	const want = env.GH_FEEDBACK_CATEGORY ?? "Game feedback";
	const cat = data.repository?.discussionCategories?.nodes?.find((c) => c.name === want);
	if (!cat) throw new HttpError(503, `no "${want}" discussion category on ${repoOf(env)}`);
	const out = { repo: data.repository.id, category: cat.id };
	await setKv(env, `gh:ids:${repoOf(env)}`, JSON.stringify(out));
	return out;
}

async function thread(env, game, create) {
	const row = await env.DB.prepare("SELECT discussion_id, url FROM feedback_threads WHERE game = ?").bind(game).first();
	if (row || !create) return row;
	const { repo, category } = await ids(env);
	const data = await graphql(
		env,
		`mutation($repo: ID!, $cat: ID!, $title: String!, $body: String!) {
			createDiscussion(input: { repositoryId: $repo, categoryId: $cat, title: $title, body: $body }) { discussion { id url } } }`,
		{
			repo,
			cat: category,
			title: `Feedback: ${game}`,
			body: `Feedback on **${game}**, posted from the arcade by signed-in players. Each comment starts with who sent it.`,
		},
	);
	const d = data.createDiscussion.discussion;
	await env.DB.prepare("INSERT OR IGNORE INTO feedback_threads (game, discussion_id, url) VALUES (?, ?, ?)").bind(game, d.id, d.url).run();
	return { discussion_id: d.id, url: d.url };
}

export async function getFeedback(env, game) {
	if (!GAME_ID.test(game)) throw new HttpError(400, "unknown game");
	const cache = globalThis.caches?.default;
	const hit = await cache?.match(cacheKey(game));
	if (hit) return hit.json();
	const t = await thread(env, game, false);
	let out = { url: null, comments: [] };
	if (t) {
		const data = await graphql(
			env,
			`query($id: ID!) { node(id: $id) { ... on Discussion { url comments(last: 20) { nodes { body createdAt author { login } } } } } }`,
			{ id: t.discussion_id },
		);
		const nodes = data.node?.comments?.nodes ?? [];
		out = {
			url: data.node?.url ?? t.url,
			comments: nodes
				.map((c) => {
					// The author is the player's GitHub account; older comments,
					// posted by the App, carry a "from <name>" line instead.
					const m = c.body.match(BYLINE);
					const login = c.author?.login ?? null;
					return {
						name: m ? m[1] : (login ?? "GitHub"),
						login: m ? null : login,
						text: c.body.replace(BYLINE, "").replace(/@​/g, "@"),
						at: Date.parse(c.createdAt) || null,
					};
				})
				.reverse(),
		};
	}
	await cache?.put(cacheKey(game), new Response(JSON.stringify(out), { headers: { "Cache-Control": "max-age=300" } }));
	return out;
}

export async function postFeedback(env, me, game, request) {
	if (!GAME_ID.test(game)) throw new HttpError(400, "unknown game");
	const text = String((await body(request)).text ?? "").trim();
	if (!text || text.length > 2000) throw new HttpError(400, "feedback is 1–2000 characters");
	const day = now() - 86_400_000;
	const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM feedback_log WHERE account = ? AND at > ?").bind(me.id, day).first();
	if (n.n >= POSTS_PER_DAY) throw new HttpError(429, `at most ${POSTS_PER_DAY} posts a day — thank you, though`);
	// Their own GitHub token first: no GitHub connected, no post.
	const { token } = await tokenFor(env, me.id);
	const t = await thread(env, game, true);
	const safe = text.replace(/@/g, "@​");
	const data = await graphqlAs(
		env,
		token,
		`mutation($id: ID!, $body: String!) { addDiscussionComment(input: { discussionId: $id, body: $body }) { comment { url } } }`,
		{ id: t.discussion_id, body: safe },
	);
	await env.DB.prepare("INSERT INTO feedback_log (account, at) VALUES (?, ?)").bind(me.id, now()).run();
	await globalThis.caches?.default?.delete(cacheKey(game));
	return { posted: true, url: data.addDiscussionComment?.comment?.url ?? t.url };
}
