// lib/markdown.js — just enough Markdown to show CONTRIBUTING.md as a page
// (contribute.html), so the guide has one source. Headings, paragraphs,
// lists (ordered and not), fenced code, inline code, bold, italic, links.
// Everything is escaped first; only these few constructs become HTML, and a
// link must be http(s), relative, or a #fragment. No raw HTML passes through.

window.NeonArcade = window.NeonArcade || {};

(() => {
	const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

	let linkBase = null; // render(md, { base }): where repo-relative links point
	function inline(text) {
		// Code spans first, set aside so nothing inside them is touched.
		const codes = [];
		let s = esc(text).replace(/`([^`]+)`/g, (_, c) => {
			codes.push(c);
			return `\u0000${codes.length - 1}\u0000`;
		});
		s = s
			.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
			.replace(/(^|[^*\w])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
			.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, label, href) => {
				const ok = /^(https?:\/\/|#|[\w./-]+$)/.test(href) && !/^javascript:/i.test(href);
				if (!ok) return label;
				// A file in the repo (docs/sdk.md, a folder) is read on GitHub; a
				// page of the site (contributors.html) or a #fragment stays here.
				if (linkBase && !/^(https?:|#)/.test(href) && !/\.html$/.test(href)) href = linkBase + href.replace(/^\.\//, "");
				const ext = /^https?:/.test(href);
				return `<a href="${href}"${ext ? ' target="_blank" rel="noopener"' : ""}>${label}</a>`;
			});
		return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
	}

	/** Markdown → HTML string. `base`: the URL repo-relative links resolve against. */
	function render(md, { base = null } = {}) {
		linkBase = base;
		const lines = md.replace(/\r\n/g, "\n").split("\n");
		const out = [];
		let para = [];
		let list = null; // { ordered, items: [] }
		const flushPara = () => {
			if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`);
			para = [];
		};
		const flushList = () => {
			if (!list) return;
			const tag = list.ordered ? "ol" : "ul";
			out.push(`<${tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join("")}</${tag}>`);
			list = null;
		};
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const fence = line.match(/^```(\w*)/);
			if (fence) {
				flushPara();
				flushList();
				const body = [];
				while (++i < lines.length && !lines[i].startsWith("```")) body.push(lines[i]);
				out.push(`<pre><code>${esc(body.join("\n"))}</code></pre>`);
				continue;
			}
			const h = line.match(/^(#{1,4})\s+(.*)$/);
			if (h) {
				flushPara();
				flushList();
				const n = h[1].length;
				const id = h[2].toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
				out.push(`<h${n} id="${id}">${inline(h[2])}</h${n}>`);
				continue;
			}
			const item = line.match(/^\s*(?:([-*])|(\d+)\.)\s+(.*)$/);
			if (item) {
				flushPara();
				const ordered = !!item[2];
				if (!list || list.ordered !== ordered) {
					flushList();
					list = { ordered, items: [] };
				}
				list.items.push(item[3]);
				continue;
			}
			if (/^\s+\S/.test(line) && list) {
				// A continuation of the last list item.
				list.items[list.items.length - 1] += " " + line.trim();
				continue;
			}
			if (!line.trim()) {
				flushPara();
				flushList();
				continue;
			}
			flushList();
			para.push(line.trim());
		}
		flushPara();
		flushList();
		return out.join("\n");
	}

	NeonArcade.markdown = { render, inline };
})();
