import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	configureImageStore,
	storeInlineImage,
	resolveToDataUrl,
	resolveToDataUrlSync,
	resolveToBytesSync,
	resolveToFilePath,
	isImageRef,
	isInlineImageDataUrl,
	relocateSessionImages,
	getImageDir,
	IMAGE_REF_PREFIX,
	__resetImageStoreCacheForTests,
} from '../../../main/storage/session-image-store';

// Deterministic sample images (bytes need not be valid PNGs - the store is
// content-addressed by raw bytes).
const dataUrl = (payload: string, mime = 'image/png') =>
	`data:${mime};base64,${Buffer.from(payload).toString('base64')}`;

const IMG_A = dataUrl('image-bytes-A');
const IMG_B = dataUrl('image-bytes-B');

describe('session-image-store', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-img-test-'));
		configureImageStore(tmpDir);
	});

	afterEach(() => {
		__resetImageStoreCacheForTests();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	// Regression guard: relocated images render as `<img src="maestro-image://...">`,
	// which the renderer's Content-Security-Policy must explicitly allow in
	// img-src. Omitting it silently blocks every historical image (they show as
	// broken placeholders) even though the bytes are safe on disk - the exact bug
	// that shipped when the CSP wasn't updated alongside the store. `data:` alone
	// is NOT enough once images are refs.
	describe('renderer CSP allows the image scheme', () => {
		it('has maestro-image: in img-src', () => {
			const html = fs.readFileSync(path.resolve('src/renderer/index.html'), 'utf-8');
			const imgSrc = html.match(/img-src([^;"]*)/)?.[1] ?? '';
			expect(imgSrc).toContain('maestro-image:');
		});
	});

	describe('predicates', () => {
		it('recognizes data URLs and refs', () => {
			expect(isInlineImageDataUrl(IMG_A)).toBe(true);
			expect(isInlineImageDataUrl('maestro-image://store/abc.png')).toBe(false);
			expect(isImageRef(`${IMAGE_REF_PREFIX}abc.png`)).toBe(true);
			expect(isImageRef(IMG_A)).toBe(false);
			expect(isImageRef('/some/path.png')).toBe(false);
		});
	});

	describe('storeInlineImage', () => {
		it('stores a data URL as a content-addressed file and returns a ref', async () => {
			const ref = await storeInlineImage(IMG_A);
			expect(ref.startsWith(IMAGE_REF_PREFIX)).toBe(true);
			expect(ref).toMatch(/^maestro-image:\/\/store\/[0-9a-f]{64}\.png$/);
			const filePath = resolveToFilePath(ref)!;
			expect(fs.existsSync(filePath)).toBe(true);
			expect(fs.readFileSync(filePath).toString()).toBe('image-bytes-A');
		});

		it('dedupes identical bytes to the same ref (content addressing)', async () => {
			const ref1 = await storeInlineImage(IMG_A);
			const ref2 = await storeInlineImage(dataUrl('image-bytes-A'));
			expect(ref1).toBe(ref2);
			const files = fs.readdirSync(getImageDir());
			expect(files).toHaveLength(1);
		});

		it('gives different bytes different refs', async () => {
			const ref1 = await storeInlineImage(IMG_A);
			const ref2 = await storeInlineImage(IMG_B);
			expect(ref1).not.toBe(ref2);
			expect(fs.readdirSync(getImageDir())).toHaveLength(2);
		});

		it('passes through values that are not inline data URLs', async () => {
			const ref = `${IMAGE_REF_PREFIX}deadbeef.png`;
			expect(await storeInlineImage(ref)).toBe(ref);
			expect(await storeInlineImage('/tmp/foo.png')).toBe('/tmp/foo.png');
		});

		it('maps jpeg media type to a jpeg extension', async () => {
			const ref = await storeInlineImage(dataUrl('jpeg-bytes', 'image/jpeg'));
			expect(ref).toMatch(/\.jpeg$/);
		});
	});

	describe('resolve', () => {
		it('round-trips a ref back to a data URL (async + sync)', async () => {
			const ref = await storeInlineImage(IMG_A);
			expect(await resolveToDataUrl(ref)).toBe(IMG_A);
			expect(resolveToDataUrlSync(ref)).toBe(IMG_A);
		});

		it('passes through data URLs unchanged', async () => {
			expect(await resolveToDataUrl(IMG_A)).toBe(IMG_A);
			expect(resolveToDataUrlSync(IMG_A)).toBe(IMG_A);
			expect(resolveToBytesSync(IMG_A)?.buffer.toString()).toBe('image-bytes-A');
		});

		it('returns null for a missing ref', async () => {
			const missing = `${IMAGE_REF_PREFIX}${'a'.repeat(64)}.png`;
			expect(await resolveToDataUrl(missing)).toBeNull();
			expect(resolveToDataUrlSync(missing)).toBeNull();
			expect(resolveToBytesSync(missing)).toBeNull();
		});
	});

	describe('resolveToFilePath (traversal guard)', () => {
		it('rejects anything but a lowercase-hex sha + known image ext', () => {
			expect(resolveToFilePath(`${IMAGE_REF_PREFIX}../../etc/passwd`)).toBeNull();
			expect(resolveToFilePath(`${IMAGE_REF_PREFIX}NOTHEX.png`)).toBeNull();
			expect(resolveToFilePath(`${IMAGE_REF_PREFIX}abc.exe`)).toBeNull();
			expect(resolveToFilePath(IMG_A)).toBeNull();
			expect(resolveToFilePath(`${IMAGE_REF_PREFIX}${'a'.repeat(64)}.png`)).not.toBeNull();
		});
	});

	describe('relocateSessionImages', () => {
		it('relocates inline images in logs, staged, and queue; leaves refs alone; is idempotent', async () => {
			const sessions = [
				{
					id: 's1',
					aiTabs: [
						{
							id: 't1',
							logs: [
								{ id: 'l1', text: 'hi', images: [IMG_A] },
								{ id: 'l2', text: 'no images' },
							],
							stagedImages: [IMG_B],
						},
					],
					executionQueue: [{ id: 'q1', images: [IMG_A] }],
				},
			];

			const first = await relocateSessionImages(sessions);
			// IMG_A appears twice but dedupes to one file; relocated counts each swap.
			expect(first.relocated).toBe(3);
			const log0Images = (first.sessions[0] as any).aiTabs[0].logs[0].images as string[];
			expect(isImageRef(log0Images[0])).toBe(true);
			expect(isImageRef((first.sessions[0] as any).aiTabs[0].stagedImages[0])).toBe(true);
			expect(isImageRef((first.sessions[0] as any).executionQueue[0].images[0])).toBe(true);
			// Only two distinct images -> two files on disk.
			expect(fs.readdirSync(getImageDir())).toHaveLength(2);

			// Second pass over the already-relocated tree does nothing and is
			// reference-stable (no needless re-clone / re-write).
			const second = await relocateSessionImages(first.sessions);
			expect(second.relocated).toBe(0);
			expect(second.sessions[0]).toBe(first.sessions[0]);
		});

		it('leaves a session object untouched (same reference) when it has no inline images', async () => {
			const clean = { id: 's', aiTabs: [{ id: 't', logs: [{ id: 'l', text: 'x' }] }] };
			const result = await relocateSessionImages([clean]);
			expect(result.relocated).toBe(0);
			expect(result.sessions[0]).toBe(clean);
		});
	});
});
