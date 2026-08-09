// lib/qr.js — minimal QR code encoder (byte mode), no dependencies.
//
// The invite link is long enough that typing it is not an option, so the lobby
// offers a QR alongside the copy button: the guest points a phone camera at the
// host's screen and the game opens. Every QR library worth using lives on a
// CDN, and this project deliberately has no external dependencies and must run
// from file://, so the encoder is here.
//
// Supports versions 1-40 in byte mode at ECC level L or M, which covers the
// ~550-character invite links comfortably. Structure follows the QR spec:
// build the bit stream, split into Reed-Solomon blocks, interleave, draw the
// function patterns, then pick the mask with the lowest penalty score.

window.NeonArcade = window.NeonArcade || {};

(() => {
	// Error-correction codewords per block, indexed [level][version].
	const ECC_PER_BLOCK = {
		L: [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30,
			28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
			30, 30, 30, 30],
		M: [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26,
			26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
			28, 28, 28, 28],
	};
	// Number of Reed-Solomon blocks, indexed [level][version].
	const NUM_BLOCKS = {
		L: [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9,
			10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
		M: [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17,
			17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47,
			49],
	};
	const FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };

	// -- GF(256) arithmetic, primitive polynomial 0x11D --------------------

	const EXP = new Uint8Array(512);
	const LOG = new Uint8Array(256);
	for (let i = 0, x = 1; i < 255; i++) {
		EXP[i] = x;
		LOG[x] = i;
		x <<= 1;
		if (x & 0x100) x ^= 0x11d;
	}
	for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];

	const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

	/**
	 * Reed-Solomon generator polynomial of the given degree: the product of
	 * (x - a^i) for i in [0, degree). Coefficients are highest-power first, so
	 * poly[0] is the leading 1 and rsRemainder divides by poly.slice(1).
	 */
	function rsGenerator(degree) {
		let poly = [1];
		for (let i = 0; i < degree; i++) {
			const next = new Array(poly.length + 1).fill(0);
			for (let j = 0; j < poly.length; j++) {
				next[j] ^= poly[j]; // shift up: multiply by x
				next[j + 1] ^= mul(poly[j], EXP[i]); // add the a^i term
			}
			poly = next;
		}
		return poly;
	}

	/** Remainder of `data` divided by the generator — the EC codewords. */
	function rsRemainder(data, degree) {
		const gen = rsGenerator(degree);
		const rem = new Uint8Array(degree);
		for (const byte of data) {
			const factor = byte ^ rem[0];
			rem.copyWithin(0, 1);
			rem[degree - 1] = 0;
			for (let i = 0; i < degree; i++) rem[i] ^= mul(gen[i + 1], factor);
		}
		return rem;
	}

	// -- geometry ----------------------------------------------------------

	/** Total data + EC modules available, before function patterns. */
	function rawDataModules(ver) {
		let n = (16 * ver + 128) * ver + 64;
		if (ver >= 2) {
			const numAlign = Math.floor(ver / 7) + 2;
			n -= (25 * numAlign - 10) * numAlign - 55;
			if (ver >= 7) n -= 36;
		}
		return n;
	}

	function alignPositions(ver) {
		if (ver === 1) return [];
		const numAlign = Math.floor(ver / 7) + 2;
		const step =
			ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
		const out = [6];
		for (let pos = ver * 4 + 10; out.length < numAlign; pos -= step) out.splice(1, 0, pos);
		return out;
	}

	const dataCapacityBytes = (ver, ecl) => {
		const total = Math.floor(rawDataModules(ver) / 8);
		return total - ECC_PER_BLOCK[ecl][ver] * NUM_BLOCKS[ecl][ver];
	};

	// -- encoding ----------------------------------------------------------

	function buildCodewords(bytes, ver, ecl) {
		const bits = [];
		const push = (val, len) => {
			for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
		};
		push(0b0100, 4); // byte mode
		push(bytes.length, ver <= 9 ? 8 : 16);
		for (const b of bytes) push(b, 8);

		const capacityBits = dataCapacityBytes(ver, ecl) * 8;
		push(0, Math.min(4, capacityBits - bits.length)); // terminator
		while (bits.length % 8 !== 0) bits.push(0);

		const data = [];
		for (let i = 0; i < bits.length; i += 8) {
			let byte = 0;
			for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
			data.push(byte);
		}
		for (let pad = 0xec; data.length < capacityBits / 8; pad ^= 0xec ^ 0x11) {
			data.push(pad);
		}

		// Split into blocks, compute EC, then interleave both halves.
		const numBlocks = NUM_BLOCKS[ecl][ver];
		const eccLen = ECC_PER_BLOCK[ecl][ver];
		const shortLen = Math.floor(data.length / numBlocks);
		const numShort = numBlocks - (data.length % numBlocks);

		const dataBlocks = [];
		const eccBlocks = [];
		for (let i = 0, off = 0; i < numBlocks; i++) {
			const len = shortLen + (i < numShort ? 0 : 1);
			const block = data.slice(off, off + len);
			off += len;
			dataBlocks.push(block);
			eccBlocks.push(rsRemainder(block, eccLen));
		}

		const out = [];
		for (let i = 0; i < shortLen + 1; i++) {
			for (let b = 0; b < numBlocks; b++) {
				if (i < dataBlocks[b].length) out.push(dataBlocks[b][i]);
			}
		}
		for (let i = 0; i < eccLen; i++) {
			for (let b = 0; b < numBlocks; b++) out.push(eccBlocks[b][i]);
		}
		return out;
	}

	// -- matrix ------------------------------------------------------------

	function drawFunctionPatterns(mod, fixed, size, ver) {
		const set = (x, y, dark) => {
			if (x < 0 || y < 0 || x >= size || y >= size) return;
			mod[y][x] = dark;
			fixed[y][x] = true;
		};

		// Timing patterns.
		for (let i = 0; i < size; i++) {
			set(6, i, i % 2 === 0);
			set(i, 6, i % 2 === 0);
		}

		// Finder patterns plus their separators.
		for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
			for (let dy = -4; dy <= 4; dy++) {
				for (let dx = -4; dx <= 4; dx++) {
					const d = Math.max(Math.abs(dx), Math.abs(dy));
					set(cx + dx, cy + dy, d !== 2 && d !== 4);
				}
			}
		}

		// Alignment patterns, skipping the three finder corners.
		const pos = alignPositions(ver);
		for (let i = 0; i < pos.length; i++) {
			for (let j = 0; j < pos.length; j++) {
				const corner =
					(i === 0 && j === 0) ||
					(i === 0 && j === pos.length - 1) ||
					(i === pos.length - 1 && j === 0);
				if (corner) continue;
				for (let dy = -2; dy <= 2; dy++) {
					for (let dx = -2; dx <= 2; dx++) {
						set(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
					}
				}
			}
		}

		// Reserve the format areas and set the always-dark module. Index 6 is
		// skipped in both directions: format info steps over the timing rows,
		// and reserving them here would blank two timing modules and make every
		// resulting code undecodable.
		for (let i = 0; i < 9; i++) {
			if (i !== 6) {
				set(i, 8, false);
				set(8, i, false);
			}
		}
		for (let i = 0; i < 8; i++) {
			set(size - 1 - i, 8, false);
			set(8, size - 1 - i, false);
		}
		set(8, size - 8, true);

		// Version information (versions 7 and up).
		if (ver >= 7) {
			let rem = ver;
			for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
			const bitsVal = (ver << 12) | rem;
			for (let i = 0; i < 18; i++) {
				const bit = ((bitsVal >>> i) & 1) === 1;
				set(size - 11 + (i % 3), Math.floor(i / 3), bit);
				set(Math.floor(i / 3), size - 11 + (i % 3), bit);
			}
		}
	}

	function drawFormatBits(mod, size, ecl, mask) {
		const data = (FORMAT_BITS[ecl] << 3) | mask;
		let rem = data;
		for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
		const bitsVal = ((data << 10) | rem) ^ 0x5412;
		const bit = (i) => ((bitsVal >>> i) & 1) === 1;

		// First copy: down column 8, then left along row 8, skipping timing.
		for (let i = 0; i <= 5; i++) mod[i][8] = bit(i);
		mod[7][8] = bit(6);
		mod[8][8] = bit(7);
		mod[8][7] = bit(8);
		for (let i = 9; i < 15; i++) mod[8][14 - i] = bit(i);

		// Second copy: along row 8 from the right, then up column 8 from the bottom.
		for (let i = 0; i < 8; i++) mod[8][size - 1 - i] = bit(i);
		for (let i = 8; i < 15; i++) mod[size - 15 + i][8] = bit(i);
		mod[size - 8][8] = true;
	}

	const MASKS = [
		(x, y) => (x + y) % 2 === 0,
		(x, y) => y % 2 === 0,
		(x) => x % 3 === 0,
		(x, y) => (x + y) % 3 === 0,
		(x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
		(x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
		(x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
		(x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
	];

	/** Standard penalty rules — lower is more reliably scannable. */
	function penalty(mod, size) {
		let score = 0;
		const runScore = (run) => (run >= 5 ? 3 + (run - 5) : 0);

		for (const transposed of [false, true]) {
			for (let a = 0; a < size; a++) {
				let run = 0;
				let prev = null;
				const history = [];
				for (let b = 0; b < size; b++) {
					const v = transposed ? mod[b][a] : mod[a][b];
					if (v === prev) run++;
					else {
						score += runScore(run);
						history.push(run);
						run = 1;
						prev = v;
					}
				}
				score += runScore(run);
				history.push(run);
				// Rule 3: finder-like 1:1:3:1:1 sequences.
				for (let i = 1; i + 4 < history.length; i++) {
					const [a1, b1, c1, d1, e1] = history.slice(i, i + 5);
					if (b1 === a1 && c1 === a1 * 3 && d1 === a1 && e1 === a1 && a1 > 0) {
						if (history[i - 1] >= a1 * 4 || history[i + 5] >= a1 * 4) score += 40;
					}
				}
			}
		}

		// Rule 2: 2x2 blocks of one colour.
		for (let y = 0; y < size - 1; y++) {
			for (let x = 0; x < size - 1; x++) {
				const v = mod[y][x];
				if (v === mod[y][x + 1] && v === mod[y + 1][x] && v === mod[y + 1][x + 1]) {
					score += 3;
				}
			}
		}

		// Rule 4: deviation from a 50/50 dark ratio.
		let dark = 0;
		for (const row of mod) for (const v of row) if (v) dark++;
		const total = size * size;
		const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
		return score + k * 10;
	}

	/**
	 * Encode `text` as a QR matrix.
	 * @returns {{ size: number, modules: boolean[][] }}
	 */
	NeonArcade.qrMatrix = (text, { ecl = "L", mask: forcedMask = null } = {}) => {
		const bytes = [...new TextEncoder().encode(text)];

		let ver = 0;
		for (let v = 1; v <= 40; v++) {
			// Byte mode overhead: 4 mode bits + the character-count field.
			const overhead = 4 + (v <= 9 ? 8 : 16);
			if (dataCapacityBytes(v, ecl) * 8 >= overhead + bytes.length * 8) {
				ver = v;
				break;
			}
		}
		if (!ver) throw new Error("data too long for a QR code");

		const size = ver * 4 + 17;
		const mod = Array.from({ length: size }, () => new Array(size).fill(false));
		const fixed = Array.from({ length: size }, () => new Array(size).fill(false));
		drawFunctionPatterns(mod, fixed, size, ver);

		// Zigzag placement, two columns at a time, skipping the timing column.
		const codewords = buildCodewords(bytes, ver, ecl);
		let bitIndex = 0;
		for (let right = size - 1; right >= 1; right -= 2) {
			if (right === 6) right = 5;
			for (let vert = 0; vert < size; vert++) {
				for (let j = 0; j < 2; j++) {
					const x = right - j;
					const upward = ((right + 1) & 2) === 0;
					const y = upward ? size - 1 - vert : vert;
					if (fixed[y][x]) continue;
					if (bitIndex < codewords.length * 8) {
						mod[y][x] = ((codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1) === 1;
						bitIndex++;
					}
				}
			}
		}

		// Try every mask, keep the best. `forcedMask` exists so tests can compare
		// against a reference encoder's chosen mask.
		let best = null;
		const masks = forcedMask === null ? [0, 1, 2, 3, 4, 5, 6, 7] : [forcedMask];
		for (const mask of masks) {
			const trial = mod.map((row) => [...row]);
			for (let y = 0; y < size; y++) {
				for (let x = 0; x < size; x++) {
					if (!fixed[y][x] && MASKS[mask](x, y)) trial[y][x] = !trial[y][x];
				}
			}
			drawFormatBits(trial, size, ecl, mask);
			const score = penalty(trial, size);
			if (!best || score < best.score) best = { score, modules: trial };
		}
		return { size, modules: best.modules };
	};

	/**
	 * Render `text` as a crisp QR canvas sized to whole modules, so it never
	 * lands on a half pixel and stays scannable off a screen.
	 */
	NeonArcade.qrCanvas = (text, { ecl = "L", scale = 4, quiet = 4, dark = "#000", light = "#fff" } = {}) => {
		const { size, modules } = NeonArcade.qrMatrix(text, { ecl });
		const dim = (size + quiet * 2) * scale;
		const canvas = document.createElement("canvas");
		canvas.width = dim;
		canvas.height = dim;
		const ctx = canvas.getContext("2d");
		ctx.fillStyle = light;
		ctx.fillRect(0, 0, dim, dim);
		ctx.fillStyle = dark;
		for (let y = 0; y < size; y++) {
			for (let x = 0; x < size; x++) {
				if (modules[y][x]) {
					ctx.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
				}
			}
		}
		return canvas;
	};

	// Exposed so tests can compare the coding stages against a reference encoder.
	NeonArcade._qrtest = {
		rs: (data, degree) => ({
			gen: [...rsGenerator(degree)],
			ecc: [...rsRemainder(data, degree)],
		}),
		codewords: (text, ver, ecl) =>
			buildCodewords([...new TextEncoder().encode(text)], ver, ecl),
	};
})();
