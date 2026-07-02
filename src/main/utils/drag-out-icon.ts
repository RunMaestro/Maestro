/**
 * Drag-out cursor icon for OS file drag-and-drop (`webContents.startDrag`).
 *
 * macOS `startDrag` throws when the `icon` is empty, so we always need a valid
 * NativeImage. Rather than resolve a packaged asset path (fragile across
 * dev/packaged/SSH layouts), we synthesize a small rounded card PNG at runtime
 * with Node's built-in `zlib` - zero dependencies, no disk access, deterministic.
 * The image is built once and cached for the process lifetime.
 */

import { nativeImage, type NativeImage } from 'electron';
import zlib from 'zlib';

let cachedIcon: NativeImage | null = null;

function crc32(buf: Buffer): number {
	let c = ~0;
	for (let i = 0; i < buf.length; i++) {
		c ^= buf[i];
		for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
	}
	return ~c >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
	const typeBuf = Buffer.from(type, 'ascii');
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
	return Buffer.concat([len, typeBuf, data, crc]);
}

/** Build a 28x28 RGBA PNG: an accent-bordered light card (a generic "file" chip). */
function buildIconPng(): Buffer {
	const W = 28;
	const H = 28;
	// Each scanline is prefixed with a filter byte (0 = none).
	const raw = Buffer.alloc((W * 4 + 1) * H);
	const put = (x: number, y: number, r: number, g: number, b: number, a: number) => {
		const rowStart = y * (W * 4 + 1);
		const o = rowStart + 1 + x * 4;
		raw[o] = r;
		raw[o + 1] = g;
		raw[o + 2] = b;
		raw[o + 3] = a;
	};
	const margin = 3;
	const corner = 3;
	for (let y = 0; y < H; y++) {
		for (let x = 0; x < W; x++) {
			const inside = x >= margin && x < W - margin && y >= margin && y < H - margin;
			const cx =
				x < margin + corner
					? margin + corner
					: x >= W - margin - corner
						? W - margin - corner - 1
						: x;
			const cy =
				y < margin + corner
					? margin + corner
					: y >= H - margin - corner
						? H - margin - corner - 1
						: y;
			const roundOk =
				(x >= margin + corner && x < W - margin - corner) ||
				(y >= margin + corner && y < H - margin - corner) ||
				Math.hypot(x - cx, y - cy) <= corner;
			if (inside && roundOk) {
				const border =
					x <= margin + 1 || x >= W - margin - 2 || y <= margin + 1 || y >= H - margin - 2;
				if (border) put(x, y, 124, 109, 242, 255);
				else put(x, y, 238, 238, 246, 255);
			} else {
				put(x, y, 0, 0, 0, 0);
			}
		}
	}
	const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(W, 0);
	ihdr.writeUInt32BE(H, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 6; // color type: RGBA
	return Buffer.concat([
		sig,
		pngChunk('IHDR', ihdr),
		pngChunk('IDAT', zlib.deflateSync(raw)),
		pngChunk('IEND', Buffer.alloc(0)),
	]);
}

/**
 * Return the cached drag-out icon, building it on first use. Guaranteed
 * non-empty so `startDrag` never throws on macOS.
 */
export function getDragOutIcon(): NativeImage {
	if (cachedIcon && !cachedIcon.isEmpty()) return cachedIcon;
	cachedIcon = nativeImage.createFromBuffer(buildIconPng());
	return cachedIcon;
}
