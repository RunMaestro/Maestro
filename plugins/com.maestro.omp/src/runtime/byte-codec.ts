/** Maximum raw bytes for one staged image attachment. */
export const MAX_OMP_IMAGE_BYTES = 2 * 1024 * 1024;
/** Maximum combined raw bytes for all staged images in one OMP prompt. */
export const MAX_OMP_PROMPT_ATTACHMENT_BYTES = MAX_OMP_IMAGE_BYTES;

const SHA256_INITIAL_STATE = new Uint32Array([
	0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

const SHA256_ROUND_CONSTANTS = new Uint32Array([
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
	0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
	0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
	0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
	0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
	0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_CHUNK_BYTES = 12 * 1024;

/** Computes SHA-256 without depending on host-provided cryptography or Node globals. */
export function sha256Hex(bytes: Uint8Array): string {
	assertBoundedBytes(bytes);
	const state = new Uint32Array(SHA256_INITIAL_STATE);
	const words = new Uint32Array(64);
	let offset = 0;
	while (offset + 64 <= bytes.byteLength) {
		sha256Block(bytes, offset, state, words);
		offset += 64;
	}

	const tail = new Uint8Array(64);
	tail.set(bytes.subarray(offset));
	tail[bytes.byteLength - offset] = 0x80;
	if (bytes.byteLength - offset >= 56) {
		sha256Block(tail, 0, state, words);
		tail.fill(0);
	}
	const bitLength = bytes.byteLength * 8;
	tail[60] = (bitLength / 0x1000000) & 0xff;
	tail[61] = (bitLength >>> 16) & 0xff;
	tail[62] = (bitLength >>> 8) & 0xff;
	tail[63] = bitLength & 0xff;
	sha256Block(tail, 0, state, words);

	return Array.from(state, (word) => word.toString(16).padStart(8, '0')).join('');
}

/** Encodes bounded resource bytes for OMP's image request format without Buffer. */
export function encodeBase64(bytes: Uint8Array): string {
	assertBoundedBytes(bytes);
	const chunks: string[] = [];
	for (let start = 0; start < bytes.byteLength; start += BASE64_CHUNK_BYTES) {
		const end = Math.min(start + BASE64_CHUNK_BYTES, bytes.byteLength);
		let chunk = '';
		for (let offset = start; offset < end; offset += 3) {
			const a = bytes[offset]!;
			const b = bytes[offset + 1];
			const c = bytes[offset + 2];
			chunk += BASE64_ALPHABET[a >>> 2];
			chunk += BASE64_ALPHABET[((a & 0x03) << 4) | ((b ?? 0) >>> 4)];
			chunk += b === undefined ? '=' : BASE64_ALPHABET[((b & 0x0f) << 2) | ((c ?? 0) >>> 6)];
			chunk += c === undefined ? '=' : BASE64_ALPHABET[c & 0x3f];
		}
		chunks.push(chunk);
	}
	return chunks.join('');
}

function assertBoundedBytes(bytes: Uint8Array): void {
	if (bytes.byteLength > MAX_OMP_IMAGE_BYTES) {
		throw new RangeError(`OMP image bytes exceed ${MAX_OMP_IMAGE_BYTES} bytes`);
	}
}

function sha256Block(
	bytes: Uint8Array,
	offset: number,
	state: Uint32Array,
	words: Uint32Array
): void {
	for (let index = 0; index < 16; index++) {
		const byteOffset = offset + index * 4;
		words[index] =
			((bytes[byteOffset]! << 24) |
				(bytes[byteOffset + 1]! << 16) |
				(bytes[byteOffset + 2]! << 8) |
				bytes[byteOffset + 3]!) >>>
			0;
	}
	for (let index = 16; index < 64; index++) {
		const previous15 = words[index - 15]!;
		const previous2 = words[index - 2]!;
		const sigma0 =
			((previous15 >>> 7) | (previous15 << 25)) ^
			((previous15 >>> 18) | (previous15 << 14)) ^
			(previous15 >>> 3);
		const sigma1 =
			((previous2 >>> 17) | (previous2 << 15)) ^
			((previous2 >>> 19) | (previous2 << 13)) ^
			(previous2 >>> 10);
		words[index] = (words[index - 16]! + sigma0 + words[index - 7]! + sigma1) >>> 0;
	}

	let a = state[0]!;
	let b = state[1]!;
	let c = state[2]!;
	let d = state[3]!;
	let e = state[4]!;
	let f = state[5]!;
	let g = state[6]!;
	let h = state[7]!;
	for (let index = 0; index < 64; index++) {
		const sigma1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
		const choose = (e & f) ^ (~e & g);
		const temporary1 = (h + sigma1 + choose + SHA256_ROUND_CONSTANTS[index]! + words[index]!) >>> 0;
		const sigma0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
		const majority = (a & b) ^ (a & c) ^ (b & c);
		const temporary2 = (sigma0 + majority) >>> 0;
		h = g;
		g = f;
		f = e;
		e = (d + temporary1) >>> 0;
		d = c;
		c = b;
		b = a;
		a = (temporary1 + temporary2) >>> 0;
	}
	state[0] = (state[0]! + a) >>> 0;
	state[1] = (state[1]! + b) >>> 0;
	state[2] = (state[2]! + c) >>> 0;
	state[3] = (state[3]! + d) >>> 0;
	state[4] = (state[4]! + e) >>> 0;
	state[5] = (state[5]! + f) >>> 0;
	state[6] = (state[6]! + g) >>> 0;
	state[7] = (state[7]! + h) >>> 0;
}
