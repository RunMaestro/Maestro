import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture the buffers handed to nativeImage.createFromBuffer so we can assert the
// synthesized PNG is well-formed, and let the fake image report emptiness from
// the buffer length (mirrors Electron: an empty buffer -> empty NativeImage).
const createFromBuffer = vi.fn((buf: Buffer) => ({
	isEmpty: () => buf.length === 0,
	__buf: buf,
}));

vi.mock('electron', () => ({
	nativeImage: { createFromBuffer },
}));

// 8-byte PNG file signature.
const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

// `drag-out-icon` caches the built image at module scope for the process
// lifetime, so reset the module registry before each test to exercise a cold
// build. Dynamic import re-runs the module factory against the same electron mock.
async function loadFresh() {
	vi.resetModules();
	createFromBuffer.mockClear();
	return await import('../../../main/utils/drag-out-icon');
}

describe('getDragOutIcon', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('builds a non-empty NativeImage from a valid PNG buffer', async () => {
		const { getDragOutIcon } = await loadFresh();
		const icon = getDragOutIcon() as unknown as { isEmpty: () => boolean };
		expect(icon.isEmpty()).toBe(false);

		const buf: Buffer = createFromBuffer.mock.calls[0][0];
		// Valid PNG: signature + IHDR/IDAT/IEND chunk types present.
		expect(buf.subarray(0, 8).equals(PNG_SIG)).toBe(true);
		expect(buf.includes(Buffer.from('IHDR', 'ascii'))).toBe(true);
		expect(buf.includes(Buffer.from('IDAT', 'ascii'))).toBe(true);
		expect(buf.includes(Buffer.from('IEND', 'ascii'))).toBe(true);
	});

	it('declares a 28x28 RGBA image in the IHDR chunk', async () => {
		const { getDragOutIcon } = await loadFresh();
		getDragOutIcon();
		const buf: Buffer = createFromBuffer.mock.calls[0][0];
		// IHDR data begins 8 bytes after the "IHDR" type marker (skip 4-byte length
		// + 4-byte type). Width/height are the first two big-endian uint32s.
		const ihdr = buf.indexOf(Buffer.from('IHDR', 'ascii')) + 4;
		expect(buf.readUInt32BE(ihdr)).toBe(28); // width
		expect(buf.readUInt32BE(ihdr + 4)).toBe(28); // height
		expect(buf[ihdr + 8]).toBe(8); // bit depth
		expect(buf[ihdr + 9]).toBe(6); // color type: RGBA
	});

	it('caches the icon: builds once, returns the same instance on repeat calls', async () => {
		const { getDragOutIcon } = await loadFresh();
		const first = getDragOutIcon();
		const second = getDragOutIcon();
		expect(second).toBe(first);
		// Second call must hit the cache, not rebuild.
		expect(createFromBuffer).toHaveBeenCalledTimes(1);
	});
});
