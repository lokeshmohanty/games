// scripts/preview-media.mjs — a preview gif's light twins: poster and video.
//
// A portal card's preview gif is 0.4–1 MB; the same loop as VP9 WebM is
// ~15 KB, as H.264 MP4 ~30 KB, and its first frame as WebP ~5 KB (measured
// 2026-11-14, docs/perf.md). Beside each `<name>.gif` this writes
// `<name>.webp` (poster), `<name>.webm` and `<name>.mp4`; the catalog
// (catalog-lib.mjs) lists whichever exist, and the portal plays the video
// with the gif as the fallback when no video plays (offline, or neither format).
//
//   node scripts/preview-media.mjs [file.gif ...]   (default: every preview
//                                                    gif a game.json names)
//   --force    rebuild even when the twins are newer than the gif
//   --strict   fail when ffmpeg is missing (default: say so, change nothing)
//
// Needs ffmpeg (libwebp, libvpx-vp9, libx264). The gif stays: it is what an
// outside repo ships, and what a browser without either video gets.

import { spawnSync } from "node:child_process";
import { existsSync, globSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const hasFfmpeg = () => spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;

const ffmpeg = (args) => {
	const r = spawnSync("ffmpeg", ["-nostdin", "-v", "error", "-y", ...args], { encoding: "utf8" });
	if (r.status !== 0) throw new Error(r.stderr.trim() || `ffmpeg exited ${r.status}`);
};

/** The twins' paths for a gif: { poster, webm, mp4 }. */
export const twinsOf = (gif) => {
	const base = gif.replace(/\.gif$/i, "");
	return { poster: base + ".webp", webm: base + ".webm", mp4: base + ".mp4" };
};

/** Write whichever twins are missing or older than the gif. Returns what it wrote. */
export function makeTwins(gif, { force = false } = {}) {
	const t = twinsOf(gif);
	const stale = (f) => force || !existsSync(f) || statSync(f).mtimeMs < statSync(gif).mtimeMs;
	const even = "scale=trunc(iw/2)*2:trunc(ih/2)*2"; // H.264 and yuv420p want even sides
	const wrote = [];
	if (stale(t.poster)) {
		ffmpeg(["-i", gif, "-frames:v", "1", "-c:v", "libwebp", "-quality", "70", t.poster]);
		wrote.push(t.poster);
	}
	if (stale(t.webm)) {
		ffmpeg(["-i", gif, "-an", "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "40", "-row-mt", "1", "-pix_fmt", "yuv420p", "-vf", even, t.webm]);
		wrote.push(t.webm);
	}
	if (stale(t.mp4)) {
		ffmpeg(["-i", gif, "-an", "-c:v", "libx264", "-crf", "30", "-preset", "slow", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-vf", even, t.mp4]);
		wrote.push(t.mp4);
	}
	return wrote;
}

/** Every preview gif named by a game.json under `dirs`. */
export function previewGifs(dirs) {
	const gifs = new Set();
	for (const dir of dirs) {
		for (const file of globSync("**/game.json", { cwd: dir })) {
			try {
				const m = JSON.parse(readFileSync(join(dir, file), "utf8"));
				if (typeof m.preview !== "string" || !/\.gif$/i.test(m.preview)) continue;
				const gif = resolve(dir, dirname(file), m.preview);
				// Never outside the folder scanned: an outside repo's manifest
				// must not steer ffmpeg's output anywhere else.
				if (!gif.startsWith(resolve(dir) + "/")) continue;
				if (existsSync(gif)) gifs.add(gif);
			} catch {}
		}
	}
	return [...gifs];
}

function main() {
	const args = process.argv.slice(2);
	const force = args.includes("--force");
	const strict = args.includes("--strict");
	const named = args.filter((a) => !a.startsWith("--"));
	if (!hasFfmpeg()) {
		console.error("preview-media: ffmpeg not found — previews stay gif-only (nix shell nixpkgs#ffmpeg)");
		process.exit(strict ? 1 : 0);
	}
	const gifs = named.length ? named.map((g) => resolve(g)) : previewGifs([join(ROOT, "games"), join(ROOT, "community")].filter(existsSync));
	let n = 0;
	for (const gif of gifs) {
		const wrote = makeTwins(gif, { force });
		n += wrote.length;
		for (const f of wrote) console.log(`  ${f.slice(ROOT.length + 1)} (${(statSync(f).size / 1024).toFixed(0)} KB)`);
	}
	console.log(`preview-media: ${gifs.length} gif(s), ${n} file(s) written`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
