import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// nativeImage is a main-process Electron binding; stand in a fake that records
// how many times a decode actually happened so the caching and serialization
// guarantees can be asserted directly.
const decodeCalls = { count: 0 };
let fakeSize = { width: 4000, height: 2000 };
let decodeFails = false;

vi.mock('electron', () => ({
	nativeImage: {
		createFromBuffer: () => {
			decodeCalls.count++;
			return {
				isEmpty: () => decodeFails,
				getSize: () => fakeSize,
				resize: ({ width, height }: { width: number; height: number }) => ({
					toPNG: () => Buffer.from(`resized-${width}x${height}`),
				}),
			};
		},
	},
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const { getOrCreateThumbnail, __resetThumbnailStateForTests } =
	await import('../../../main/storage/session-image-thumbnails');

describe('session-image-thumbnails', () => {
	let tmpDir: string;
	let source: string;

	// Comfortably over MIN_SOURCE_BYTES (96KB) so the "too small to bother"
	// short-circuit does not fire.
	const bigBytes = Buffer.alloc(200 * 1024, 7);

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-thumbs-'));
		source = path.join(tmpDir, `${'a'.repeat(64)}.png`);
		fs.writeFileSync(source, bigBytes);
		decodeCalls.count = 0;
		fakeSize = { width: 4000, height: 2000 };
		decodeFails = false;
		__resetThumbnailStateForTests();
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it('generates a downscaled file that fits the box and preserves aspect ratio', async () => {
		const out = await getOrCreateThumbnail(source, 400, 160);
		expect(out).not.toBeNull();
		expect(fs.existsSync(out!)).toBe(true);
		// 4000x2000 into 400x160: height is the binding constraint (scale 0.08).
		expect(fs.readFileSync(out!).toString()).toBe('resized-320x160');
	});

	it('decodes once and serves the cache on every later request', async () => {
		const first = await getOrCreateThumbnail(source, 400, 160);
		const second = await getOrCreateThumbnail(source, 400, 160);
		expect(second).toBe(first);
		expect(decodeCalls.count).toBe(1);
	});

	it('collapses concurrent requests for the same rendition into one decode', async () => {
		const results = await Promise.all([
			getOrCreateThumbnail(source, 400, 160),
			getOrCreateThumbnail(source, 400, 160),
			getOrCreateThumbnail(source, 400, 160),
		]);
		expect(new Set(results).size).toBe(1);
		expect(decodeCalls.count).toBe(1);
	});

	it('keeps separate cache files per requested box', async () => {
		const small = await getOrCreateThumbnail(source, 400, 160);
		const large = await getOrCreateThumbnail(source, 800, 320);
		expect(small).not.toBe(large);
		expect(decodeCalls.count).toBe(2);
	});

	it('returns null (serve the original) when the source already fits the box', async () => {
		fakeSize = { width: 120, height: 80 };
		expect(await getOrCreateThumbnail(source, 400, 160)).toBeNull();
	});

	it('returns null for a source too small to be worth a second file', async () => {
		const small = path.join(tmpDir, `${'b'.repeat(64)}.png`);
		fs.writeFileSync(small, Buffer.alloc(1024, 1));
		expect(await getOrCreateThumbnail(small, 400, 160)).toBeNull();
		expect(decodeCalls.count).toBe(0);
	});

	it('returns null for SVG rather than trying to rasterize it', async () => {
		const svg = path.join(tmpDir, `${'c'.repeat(64)}.svg`);
		fs.writeFileSync(svg, bigBytes);
		expect(await getOrCreateThumbnail(svg, 400, 160)).toBeNull();
		expect(decodeCalls.count).toBe(0);
	});

	it('returns null for a missing source instead of throwing', async () => {
		expect(await getOrCreateThumbnail(path.join(tmpDir, 'gone.png'), 400, 160)).toBeNull();
	});

	it('returns null when the bytes will not decode', async () => {
		decodeFails = true;
		expect(await getOrCreateThumbnail(source, 400, 160)).toBeNull();
	});

	it('leaves no temp files behind', async () => {
		await getOrCreateThumbnail(source, 400, 160);
		expect(fs.readdirSync(tmpDir).filter((f) => f.includes('.tmp-'))).toEqual([]);
	});

	it('never writes a cache file that could be addressed as a source ref', async () => {
		// REF_BASENAME_RE only accepts `<64 hex>.<ext>`; the rendition suffix must
		// keep cache files outside that pattern so they cannot be served directly.
		const out = await getOrCreateThumbnail(source, 400, 160);
		expect(/^[0-9a-f]{64}\.(png|jpe?g|gif|webp|bmp|svg)$/.test(path.basename(out!))).toBe(false);
	});
});
