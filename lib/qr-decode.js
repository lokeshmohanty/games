// lib/qr-decode.js — QR decoder, so the host can scan a guest's reply code off
// their screen instead of pasting it.
//
// Written from scratch for the same reason as the encoder: this project takes
// no third-party code, and must run from file://. The browser's own
// BarcodeDetector is used when present (Android Chrome has it), and this is the
// fallback everywhere else — desktop Chrome and iOS Safari both lack it.
//
// Pipeline: grayscale -> local adaptive threshold -> locate the three finder
// patterns -> order them -> estimate the module grid -> perspective-sample it
// -> read format info -> unmask -> de-interleave blocks -> Reed-Solomon error
// correction -> parse segments.
//
// Decoding is genuinely harder than encoding: a camera frame is skewed, blurred
// and unevenly lit, and the payload arrives with errors that have to be
// corrected rather than merely detected.

window.NeonArcade = window.NeonArcade || {};

(() => {
	// -- GF(256), same field as the encoder --------------------------------

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
	const inv = (a) => EXP[255 - LOG[a]];

	/** Evaluate a polynomial (highest-power first) at x. */
	function polyEval(poly, x) {
		let y = 0;
		for (const c of poly) y = mul(y, x) ^ c;
		return y;
	}

	/** Evaluate a polynomial stored lowest-power-first at x. */
	function evalLow(poly, x) {
		let y = 0;
		let p = 1;
		for (let i = 0; i < poly.length; i++) {
			y ^= mul(poly[i], p);
			p = mul(p, x);
		}
		return y;
	}

	/**
	 * Correct up to `ecLen/2` errors in a block, in place.
	 * Syndromes -> Berlekamp-Massey -> Chien search -> Forney.
	 * Returns false if the block is beyond repair.
	 *
	 * `block` is highest-power-first (codeword order); the locator polynomials
	 * are kept lowest-power-first, which is the conventional formulation and far
	 * easier to keep straight than mixing the two.
	 */
	function rsCorrect(block, ecLen) {
		const n = block.length;

		// Syndromes. All zero means the block arrived clean.
		const synd = new Array(ecLen).fill(0);
		let bad = false;
		for (let i = 0; i < ecLen; i++) {
			synd[i] = polyEval(block, EXP[i]);
			if (synd[i] !== 0) bad = true;
		}
		if (!bad) return true;

		// Berlekamp-Massey: find the error-locator polynomial C.
		let C = [1];
		let B = [1];
		let L = 0;
		let m = 1;
		let bScale = 1;
		for (let k = 0; k < ecLen; k++) {
			let d = synd[k];
			for (let i = 1; i <= L; i++) d ^= mul(C[i] ?? 0, synd[k - i]);
			if (d === 0) {
				m++;
				continue;
			}
			const coef = mul(d, inv(bScale));
			const prevC = C.slice();
			for (let i = 0; i < B.length; i++) {
				C[i + m] = (C[i + m] ?? 0) ^ mul(coef, B[i]);
			}
			for (let i = 0; i < C.length; i++) C[i] ??= 0;
			if (2 * L <= k) {
				L = k + 1 - L;
				B = prevC;
				bScale = d;
				m = 1;
			} else {
				m++;
			}
		}
		while (C.length > 1 && C[C.length - 1] === 0) C.pop();
		if (L === 0 || L !== C.length - 1 || L * 2 > ecLen) return false;

		// Chien search: C(a^-i) == 0 means an error at exponent i, which is
		// codeword position n-1-i.
		const positions = [];
		for (let i = 0; i < n; i++) {
			if (evalLow(C, EXP[(255 - (i % 255)) % 255]) === 0) positions.push(n - 1 - i);
		}
		if (positions.length !== L) return false;

		// Forney: omega = (S * C) mod x^ecLen.
		const omega = new Array(ecLen).fill(0);
		for (let i = 0; i < ecLen; i++) {
			for (let j = 0; j < C.length && i + j < ecLen; j++) {
				omega[i + j] ^= mul(synd[i], C[j]);
			}
		}
		// Formal derivative of C: only odd-degree terms survive in GF(2^m).
		const dC = [];
		for (let i = 1; i < C.length; i += 2) dC[i - 1] = C[i];
		for (let i = 0; i < dC.length; i++) dC[i] ??= 0;

		for (const pos of positions) {
			const exp = n - 1 - pos;
			const x = EXP[exp % 255];
			const xInv = EXP[(255 - (exp % 255)) % 255];
			const den = evalLow(dC, xInv);
			if (den === 0) return false;
			// Forney with first consecutive root a^0: e = X * omega(X^-1) / C'(X^-1).
			// The leading X is easy to drop and makes every correction wrong.
			block[pos] ^= mul(x, mul(evalLow(omega, xInv), inv(den)));
		}

		// A mis-correction usually leaves non-zero syndromes, so re-check.
		for (let i = 0; i < ecLen; i++) {
			if (polyEval(block, EXP[i]) !== 0) return false;
		}
		return true;
	}

	// -- tables (mirror of the encoder's) ----------------------------------

	const ECC_PER_BLOCK = {
		L: [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30,
			28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
			30, 30, 30, 30],
		M: [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26,
			26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
			28, 28, 28, 28],
		Q: [0, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28,
			26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
			30, 30, 30, 30],
		H: [0, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28,
			26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
			30, 30, 30, 30],
	};
	const NUM_BLOCKS = {
		L: [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9,
			10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
		M: [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17,
			17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47,
			49],
		Q: [0, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20,
			23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62,
			65, 68],
		H: [0, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25,
			25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74,
			77, 81],
	};
	const ECL_FROM_BITS = { 1: "L", 0: "M", 3: "Q", 2: "H" };

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

	function alignPositions(ver) {
		if (ver === 1) return [];
		const n = Math.floor(ver / 7) + 2;
		const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
		const out = [6];
		for (let pos = ver * 4 + 10; out.length < n; pos -= step) out.splice(1, 0, pos);
		return out;
	}

	/** Mark every function-pattern module, so the reader can skip them. */
	function functionMask(size, ver) {
		const fixed = Array.from({ length: size }, () => new Array(size).fill(false));
		const mark = (x, y) => {
			if (x >= 0 && y >= 0 && x < size && y < size) fixed[y][x] = true;
		};
		for (let i = 0; i < size; i++) {
			mark(6, i);
			mark(i, 6);
		}
		for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
			for (let dy = -4; dy <= 4; dy++) {
				for (let dx = -4; dx <= 4; dx++) mark(cx + dx, cy + dy);
			}
		}
		const pos = alignPositions(ver);
		for (let i = 0; i < pos.length; i++) {
			for (let j = 0; j < pos.length; j++) {
				const corner =
					(i === 0 && j === 0) ||
					(i === 0 && j === pos.length - 1) ||
					(i === pos.length - 1 && j === 0);
				if (corner) continue;
				for (let dy = -2; dy <= 2; dy++) {
					for (let dx = -2; dx <= 2; dx++) mark(pos[i] + dx, pos[j] + dy);
				}
			}
		}
		for (let i = 0; i < 9; i++) {
			mark(i, 8);
			mark(8, i);
		}
		for (let i = 0; i < 8; i++) {
			mark(size - 1 - i, 8);
			mark(8, size - 1 - i);
		}
		if (ver >= 7) {
			for (let i = 0; i < 18; i++) {
				mark(size - 11 + (i % 3), Math.floor(i / 3));
				mark(Math.floor(i / 3), size - 11 + (i % 3));
			}
		}
		return fixed;
	}

	// -- format info --------------------------------------------------------

	const FORMAT_MASK = 0x5412;

	function decodeFormat(bits) {
		let best = -1;
		let bestDist = 99;
		for (let d = 0; d < 32; d++) {
			let rem = d;
			for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
			const candidate = ((d << 10) | rem) ^ FORMAT_MASK;
			let dist = 0;
			let diff = candidate ^ bits;
			while (diff) {
				dist += diff & 1;
				diff >>>= 1;
			}
			if (dist < bestDist) {
				bestDist = dist;
				best = d;
			}
		}
		// More than 3 bit errors means we are not looking at format info.
		return bestDist <= 3 ? { ecl: ECL_FROM_BITS[best >> 3], mask: best & 7 } : null;
	}

	function readFormat(get, size) {
		const bitAt = (x, y) => (get(x, y) ? 1 : 0);
		let a = 0;
		for (let i = 0; i <= 5; i++) a |= bitAt(8, i) << i;
		a |= bitAt(8, 7) << 6;
		a |= bitAt(8, 8) << 7;
		a |= bitAt(7, 8) << 8;
		for (let i = 9; i < 15; i++) a |= bitAt(14 - i, 8) << i;

		let b = 0;
		for (let i = 0; i < 8; i++) b |= bitAt(size - 1 - i, 8) << i;
		for (let i = 8; i < 15; i++) b |= bitAt(8, size - 15 + i) << i;

		return decodeFormat(a) ?? decodeFormat(b);
	}

	// -- payload ------------------------------------------------------------

	/** Read the zigzag data stream, undoing the mask as we go. */
	function readCodewords(get, size, ver, maskFn) {
		const fixed = functionMask(size, ver);
		const bytes = [];
		let cur = 0;
		let count = 0;
		for (let right = size - 1; right >= 1; right -= 2) {
			if (right === 6) right = 5;
			for (let vert = 0; vert < size; vert++) {
				for (let j = 0; j < 2; j++) {
					const x = right - j;
					const upward = ((right + 1) & 2) === 0;
					const y = upward ? size - 1 - vert : vert;
					if (fixed[y][x]) continue;
					let bit = get(x, y);
					if (maskFn(x, y)) bit = !bit;
					cur = (cur << 1) | (bit ? 1 : 0);
					if (++count === 8) {
						bytes.push(cur);
						cur = 0;
						count = 0;
					}
				}
			}
		}
		return bytes;
	}

	/** Undo the block interleaving and run error correction over each block. */
	function correctBlocks(codewords, ver, ecl) {
		const numBlocks = NUM_BLOCKS[ecl][ver];
		const ecLen = ECC_PER_BLOCK[ecl][ver];
		const total = codewords.length;
		const dataTotal = total - ecLen * numBlocks;
		const shortLen = Math.floor(dataTotal / numBlocks);
		const numShort = numBlocks - (dataTotal % numBlocks);

		const dataLens = [];
		for (let b = 0; b < numBlocks; b++) {
			dataLens.push(shortLen + (b < numShort ? 0 : 1));
		}

		const blocks = dataLens.map(() => []);
		let idx = 0;
		for (let i = 0; i < shortLen + 1; i++) {
			for (let b = 0; b < numBlocks; b++) {
				if (i < dataLens[b]) blocks[b].push(codewords[idx++]);
			}
		}
		for (let i = 0; i < ecLen; i++) {
			for (let b = 0; b < numBlocks; b++) blocks[b].push(codewords[idx++]);
		}

		const out = [];
		for (const block of blocks) {
			if (!rsCorrect(block, ecLen)) return null;
			out.push(...block.slice(0, block.length - ecLen));
		}
		return out;
	}

	const ALNUM = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";

	/** Parse the mode/length/payload segments into a string. */
	function parseSegments(data, ver) {
		let bitPos = 0;
		const read = (n) => {
			let v = 0;
			for (let i = 0; i < n; i++) {
				const byte = data[bitPos >>> 3];
				if (byte === undefined) throw new Error("truncated");
				v = (v << 1) | ((byte >>> (7 - (bitPos & 7))) & 1);
				bitPos++;
			}
			return v;
		};
		const lenBits = (mode) => {
			const small = ver <= 9;
			const mid = ver <= 26;
			if (mode === 1) return small ? 10 : mid ? 12 : 14;
			if (mode === 2) return small ? 9 : mid ? 11 : 13;
			if (mode === 4) return small ? 8 : 16;
			if (mode === 8) return small ? 8 : mid ? 10 : 12;
			return 0;
		};

		const bytes = [];
		let text = "";
		while (bitPos + 4 <= data.length * 8) {
			const mode = read(4);
			if (mode === 0) break; // terminator
			const count = read(lenBits(mode));
			if (mode === 4) {
				for (let i = 0; i < count; i++) bytes.push(read(8));
			} else if (mode === 2) {
				for (let i = 0; i < count; i += 2) {
					if (i + 1 < count) {
						const v = read(11);
						text += ALNUM[Math.floor(v / 45)] + ALNUM[v % 45];
					} else {
						text += ALNUM[read(6)];
					}
				}
			} else if (mode === 1) {
				for (let i = 0; i < count; i += 3) {
					const left = count - i;
					if (left >= 3) text += String(read(10)).padStart(3, "0");
					else if (left === 2) text += String(read(7)).padStart(2, "0");
					else text += String(read(4));
				}
			} else {
				break; // ECI/kanji/structured-append are not produced by this project
			}
		}
		// Byte mode is what the lobby emits, so decode it as UTF-8.
		if (bytes.length) text = new TextDecoder().decode(new Uint8Array(bytes)) + text;
		return text;
	}

	/**
	 * Decode a already-sampled module grid.
	 * @param {(x:number,y:number)=>boolean} get
	 */
	function decodeMatrix(get, size) {
		if (size < 21 || size > 177 || (size - 17) % 4 !== 0) return null;
		const ver = (size - 17) / 4;
		const fmt = readFormat(get, size);
		if (!fmt) return null;
		const codewords = readCodewords(get, size, ver, MASKS[fmt.mask]);
		const data = correctBlocks(codewords, ver, fmt.ecl);
		if (!data) return null;
		try {
			const text = parseSegments(data, ver);
			return text ? { text, version: ver, ecl: fmt.ecl } : null;
		} catch {
			return null;
		}
	}

	// -- image processing ---------------------------------------------------

	/** Grayscale, then a block-local threshold so uneven lighting is tolerated. */
	function binarize(imageData, { smooth = false } = {}) {
		const { width: w, height: h, data } = imageData;
		let gray = new Uint8ClampedArray(w * h);
		for (let i = 0; i < w * h; i++) {
			gray[i] = (data[i * 4] * 77 + data[i * 4 + 1] * 150 + data[i * 4 + 2] * 29) >> 8;
		}

		// Optional 3x3 box blur. Sensor speckle otherwise shatters the finder
		// runs into noise and detection collapses; this is only worth paying for
		// when the sharp pass has already failed, so the caller decides.
		if (smooth) {
			const out = new Uint8ClampedArray(w * h);
			for (let y = 0; y < h; y++) {
				for (let x = 0; x < w; x++) {
					let sum = 0;
					let n = 0;
					for (let dy = -1; dy <= 1; dy++) {
						const yy = y + dy;
						if (yy < 0 || yy >= h) continue;
						for (let dx = -1; dx <= 1; dx++) {
							const xx = x + dx;
							if (xx < 0 || xx >= w) continue;
							sum += gray[yy * w + xx];
							n++;
						}
					}
					out[y * w + x] = sum / n;
				}
			}
			gray = out;
		}

		// Per-block black point, then a threshold smoothed over the surrounding
		// blocks. Using each block's own mean in isolation puts the threshold
		// right on the intensity ramp of a blurred edge, which is what made
		// out-of-focus captures fail; averaging across neighbours steadies it.
		const B = 8;
		const bw = Math.max(1, Math.ceil(w / B));
		const bh = Math.max(1, Math.ceil(h / B));
		const black = new Float32Array(bw * bh);
		for (let by = 0; by < bh; by++) {
			for (let bx = 0; bx < bw; bx++) {
				let sum = 0;
				let n = 0;
				let min = 255;
				let max = 0;
				for (let y = by * B; y < Math.min((by + 1) * B, h); y++) {
					for (let x = bx * B; x < Math.min((bx + 1) * B, w); x++) {
						const v = gray[y * w + x];
						sum += v;
						n++;
						if (v < min) min = v;
						if (v > max) max = v;
					}
				}
				let avg;
				if (max - min > 24) {
					avg = sum / n;
				} else {
					// Low-contrast block: assume it is all background. Half the local
					// minimum keeps a quiet zone from being read as modules, unless
					// neighbours say this really is a dark region.
					avg = min / 2;
					if (by > 0 && bx > 0) {
						const near =
							(black[(by - 1) * bw + bx] +
								2 * black[by * bw + bx - 1] +
								black[(by - 1) * bw + bx - 1]) /
							4;
						if (min < near) avg = near;
					}
				}
				black[by * bw + bx] = avg;
			}
		}

		const bits = new Uint8Array(w * h);
		for (let by = 0; by < bh; by++) {
			for (let bx = 0; bx < bw; bx++) {
				// Average the black points over a 5x5 block window.
				const x0 = Math.min(Math.max(bx, 2), bw - 3);
				const y0 = Math.min(Math.max(by, 2), bh - 3);
				let sum = 0;
				let n = 0;
				for (let dy = -2; dy <= 2; dy++) {
					for (let dx = -2; dx <= 2; dx++) {
						const yy = y0 + dy;
						const xx = x0 + dx;
						if (yy < 0 || yy >= bh || xx < 0 || xx >= bw) continue;
						sum += black[yy * bw + xx];
						n++;
					}
				}
				const t = sum / n;
				for (let y = by * B; y < Math.min((by + 1) * B, h); y++) {
					for (let x = bx * B; x < Math.min((bx + 1) * B, w); x++) {
						bits[y * w + x] = gray[y * w + x] <= t ? 1 : 0; // 1 = dark
					}
				}
			}
		}
		return { bits, width: w, height: h };
	}

	/**
	 * Find finder-pattern centres by scanning for the 1:1:3:1:1 dark/light run
	 * signature, horizontally then confirming vertically.
	 */
	function findFinders({ bits, width: w, height: h }) {
		const dark = (x, y) => x >= 0 && y >= 0 && x < w && y < h && bits[y * w + x] === 1;

		/** Does a 5-run window match the 1:1:3:1:1 finder signature? */
		const crossOk = (c) => {
			let total = 0;
			for (let i = 0; i < 5; i++) {
				if (c[i] === 0) return false;
				total += c[i];
			}
			if (total < 7) return false;
			const unit = total / 7;
			const tol = unit / 2;
			return (
				Math.abs(unit - c[0]) < tol &&
				Math.abs(unit - c[1]) < tol &&
				Math.abs(unit * 3 - c[2]) < tol * 3 &&
				Math.abs(unit - c[3]) < tol &&
				Math.abs(unit - c[4]) < tol
			);
		};

		/** Centre of the middle run, measured back from the run's end. */
		const centreFromEnd = (c, end) => end - c[4] - c[3] - c[2] / 2;

		/**
		 * Re-run the 1:1:3:1:1 test along the perpendicular axis through a
		 * candidate. A row hit alone is often a coincidence; requiring both axes
		 * (and a comparable total thickness) removes almost all of them.
		 */
		const crossCheck = (cx, cy, maxCount, originalTotal, vertical) => {
			const c = [0, 0, 0, 0, 0];
			const at = (i) => (vertical ? dark(cx, i) : dark(i, cy));
			const limit = vertical ? h : w;
			let i = vertical ? cy : cx;

			while (i >= 0 && at(i)) { c[2]++; i--; }
			if (i < 0) return null;
			while (i >= 0 && !at(i) && c[1] <= maxCount) { c[1]++; i--; }
			if (i < 0 || c[1] > maxCount) return null;
			while (i >= 0 && at(i) && c[0] <= maxCount) { c[0]++; i--; }
			if (c[0] > maxCount) return null;

			i = (vertical ? cy : cx) + 1;
			while (i < limit && at(i)) { c[2]++; i++; }
			if (i >= limit) return null;
			while (i < limit && !at(i) && c[3] <= maxCount) { c[3]++; i++; }
			if (i >= limit || c[3] > maxCount) return null;
			while (i < limit && at(i) && c[4] <= maxCount) { c[4]++; i++; }
			if (c[4] > maxCount) return null;

			const total = c[0] + c[1] + c[2] + c[3] + c[4];
			if (5 * Math.abs(total - originalTotal) >= 2 * originalTotal) return null;
			return crossOk(c) ? centreFromEnd(c, i) : null;
		};

		const centres = [];
		const record = (cx, cy, total) => {
			const maxCount = Math.ceil((total / 7) * 2);
			const ry = crossCheck(Math.round(cx), cy, maxCount, total, true);
			if (ry === null) return;
			// Both coordinates must be whole pixels: they index the bitmap directly,
			// and a fractional index silently reads undefined.
			const rx = crossCheck(Math.round(cx), Math.round(ry), maxCount, total, false);
			if (rx === null) return;
			const size = total / 7;
			// Merge with an existing centre if they describe the same pattern.
			const hit = centres.find(
				(m) =>
					Math.abs(m.x - rx) < m.size &&
					Math.abs(m.y - ry) < m.size &&
					Math.abs(m.size - size) < Math.max(1, m.size * 0.5),
			);
			if (hit) {
				hit.x = (hit.x * hit.n + rx) / (hit.n + 1);
				hit.y = (hit.y * hit.n + ry) / (hit.n + 1);
				hit.size = (hit.size * hit.n + size) / (hit.n + 1);
				hit.n++;
			} else {
				centres.push({ x: rx, y: ry, size, n: 1 });
			}
		};

		// Walk each row through the state machine 0=dark,1=light,2=dark,3=light,4=dark.
		for (let y = 0; y < h; y++) {
			const c = [0, 0, 0, 0, 0];
			let state = 0;
			for (let x = 0; x < w; x++) {
				if (dark(x, y)) {
					if ((state & 1) === 1) state++; // was counting light
					c[state]++;
				} else if ((state & 1) === 0) {
					// was counting dark
					if (state === 4) {
						if (crossOk(c)) {
							record(centreFromEnd(c, x), y, c[0] + c[1] + c[2] + c[3] + c[4]);
							// Drop the two oldest runs; the current light pixel starts c[3].
							c[0] = c[2]; c[1] = c[3]; c[2] = c[4]; c[3] = 1; c[4] = 0;
							state = 3;
						} else {
							// Not a finder: drop the two oldest runs and keep going.
							c[0] = c[2]; c[1] = c[3]; c[2] = c[4]; c[3] = 1; c[4] = 0;
							state = 3;
						}
					} else {
						c[++state]++;
					}
				} else {
					c[state]++;
				}
			}
			// A pattern flush against the right edge still counts.
			if (state === 4 && crossOk(c)) {
				record(centreFromEnd(c, w), y, c[0] + c[1] + c[2] + c[3] + c[4]);
			}
		}

		return centres.filter((m) => m.n >= 2).sort((a, b) => b.n - a.n);
	}

	/** Label the three finders as top-left, top-right and bottom-left. */
	function orderFinders(f) {
		const [a, b, c] = f;
		const d = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
		// The corner opposite the longest side is the top-left.
		const sides = [
			{ len: d(b, c), corner: a, other: [b, c] },
			{ len: d(a, c), corner: b, other: [a, c] },
			{ len: d(a, b), corner: c, other: [a, b] },
		].sort((p, q) => q.len - p.len)[0];
		const tl = sides.corner;
		let [p, q] = sides.other;
		// Cross product decides which of the two remaining is the top-right.
		const cross =
			(p.x - tl.x) * (q.y - tl.y) - (p.y - tl.y) * (q.x - tl.x);
		if (cross < 0) [p, q] = [q, p];
		return { tl, tr: p, bl: q };
	}

	/**
	 * Best guess at the module dimension, snapped to the nearest legal 4n+17.
	 * Averaging both edges is steadier than trusting one.
	 */
	function estimateSize({ tl, tr, bl }) {
		const moduleSize = (tl.size + tr.size + bl.size) / 3;
		const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
		const raw = (dist(tl, tr) + dist(tl, bl)) / 2 / moduleSize + 7;
		return 17 + 4 * Math.round((raw - 17) / 4);
	}

	/**
	 * Legal dimensions to try, nearest the estimate first. Rotation biases the
	 * estimate low, so the window reaches further up than down.
	 */
	function sizeCandidates(est) {
		const out = [];
		for (let d = 21; d <= 177; d += 4) {
			if (d >= est - 12 && d <= est + 40) out.push(d);
		}
		return out.sort((a, b) => Math.abs(a - est) - Math.abs(b - est));
	}

	/** Sample the module grid by mapping the three finder centres onto it. */
	function sampleGrid(img, { tl, tr, bl }, size) {
		if (!Number.isFinite(size) || size < 21 || size > 177) return null;

		// Finder centres sit 3.5 modules in from each corner.
		const ax = tl.x;
		const ay = tl.y;
		const ux = (tr.x - tl.x) / (size - 7);
		const uy = (tr.y - tl.y) / (size - 7);
		const vx = (bl.x - tl.x) / (size - 7);
		const vy = (bl.y - tl.y) / (size - 7);

		const { bits, width: w, height: h } = img;
		const at = (fx, fy) => {
			const px = Math.round(ax + fx * ux + fy * vx);
			const py = Math.round(ay + fx * uy + fy * vy);
			if (px < 0 || py < 0 || px >= w || py >= h) return 0;
			return bits[py * w + px] === 1 ? 1 : 0;
		};
		// Majority of five points inside the module rather than its exact centre.
		// A blurred capture bleeds neighbouring modules into each other, and one
		// unlucky centre pixel then flips the bit; five votes ride that out.
		const get = (mx, my) => {
			// tl is the centre of module 3, so module mx's centre is (mx - 3) steps
			// away. Using 3.5 would sample each module's leading edge instead.
			const fx = mx - 3;
			const fy = my - 3;
			const q = 0.25;
			const sum =
				at(fx, fy) +
				at(fx - q, fy) +
				at(fx + q, fy) +
				at(fx, fy - q) +
				at(fx, fy + q);
			return sum >= 3;
		};
		return { get, size };
	}

	/**
	 * Decode a QR from an ImageData. Returns `{ text }` or null.
	 * Tries the raw image and an inverted copy (light-on-dark codes).
	 */
	NeonArcade.qrDecode = (imageData) => {
		// Sharp first (cheapest and most accurate), then smoothed for noisy
		// frames; inverted covers light-on-dark codes. First success wins.
		for (const [smooth, invert] of [
			[false, false],
			[true, false],
			[false, true],
			[true, true],
		]) {
			const img = binarize(imageData, { smooth });
			if (invert) for (let i = 0; i < img.bits.length; i++) img.bits[i] ^= 1;
			const finders = findFinders(img);
			if (finders.length < 3) continue;
			// Try the most prominent triples; extra candidates are usually noise.
			const tries = Math.min(finders.length, 5);
			for (let i = 0; i < tries; i++) {
				for (let j = i + 1; j < tries; j++) {
					for (let k = j + 1; k < tries; k++) {
						const ordered = orderFinders([finders[i], finders[j], finders[k]]);
						// The module size is measured along image rows, so a rotated code
						// inflates it and the dimension comes out low. Rather than trust
						// one estimate, sweep the plausible dimensions nearest it: a wrong
						// dimension fails Reed-Solomon, so decodeMatrix is a reliable
						// oracle and a false positive is effectively impossible.
						for (const size of sizeCandidates(estimateSize(ordered))) {
							const grid = sampleGrid(img, ordered, size);
							if (!grid) continue;
							const res = decodeMatrix(grid.get, grid.size);
							if (res) return res;
						}
					}
				}
			}
		}
		return null;
	};

	// Exposed so tests can isolate the vision stages from the coding stages.
	NeonArcade._qrdectest = {
		binarize,
		findFinders,
		orderFinders,
		estimateSize,
		sampleGrid,
		decodeMatrix,
		rsCorrect,
	};

	/** True when the browser can decode QR codes natively (fast path). */
	NeonArcade.qrNativeAvailable = () =>
		typeof window.BarcodeDetector !== "undefined";

	/**
	 * Open the camera and watch for a QR code.
	 *
	 * Returns `{ video, stop }` — mount `video` wherever it should appear and
	 * call `stop()` when finished; it releases the camera, which browsers do not
	 * do on their own and which leaves the recording indicator on.
	 *
	 * Uses the platform decoder when the browser has one (Android Chrome) and
	 * falls back to this file's decoder everywhere else.
	 */
	NeonArcade.scanQr = ({ onResult, onError }) => {
		const video = document.createElement("video");
		video.playsInline = true;
		video.muted = true;
		video.setAttribute("playsinline", ""); // iOS refuses inline playback without it

		const canvas = document.createElement("canvas");
		const ctx = canvas.getContext("2d", { willReadFrequently: true });
		let stream = null;
		let timer = null;
		let stopped = false;
		let detector = null;

		const stop = () => {
			stopped = true;
			clearTimeout(timer);
			for (const track of stream?.getTracks() ?? []) track.stop();
			stream = null;
			video.srcObject = null;
		};

		const tick = async () => {
			if (stopped) return;
			try {
				if (video.readyState >= 2 && video.videoWidth) {
					let hit = null;
					if (detector) {
						const found = await detector.detect(video);
						hit = found?.[0]?.rawValue ?? null;
					}
					if (!hit) {
						// Cap the working size: decoding cost scales with pixels and a
						// code that fills a 640px frame is already plenty of detail.
						const scale = Math.min(1, 640 / video.videoWidth);
						canvas.width = Math.round(video.videoWidth * scale);
						canvas.height = Math.round(video.videoHeight * scale);
						ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
						const res = NeonArcade.qrDecode(
							ctx.getImageData(0, 0, canvas.width, canvas.height),
						);
						hit = res?.text ?? null;
					}
					if (hit && !stopped) {
						stop();
						onResult(hit);
						return;
					}
				}
			} catch {
				// A single bad frame is not fatal; keep scanning.
			}
			timer = setTimeout(tick, 120);
		};

		(async () => {
			if (!navigator.mediaDevices?.getUserMedia) {
				onError?.(
					"This browser cannot open the camera here. Camera access needs an https:// page — paste the code instead.",
				);
				return;
			}
			try {
				stream = await navigator.mediaDevices.getUserMedia({
					video: { facingMode: { ideal: "environment" } },
				});
			} catch (err) {
				onError?.(
					err?.name === "NotAllowedError"
						? "Camera permission was denied — paste the code instead."
						: "Could not open the camera — paste the code instead.",
				);
				return;
			}
			if (stopped) {
				for (const track of stream.getTracks()) track.stop();
				return;
			}
			video.srcObject = stream;
			try {
				await video.play();
			} catch {}
			if (NeonArcade.qrNativeAvailable()) {
				try {
					detector = new window.BarcodeDetector({ formats: ["qr_code"] });
				} catch {}
			}
			tick();
		})();

		return { video, stop };
	};
})();
