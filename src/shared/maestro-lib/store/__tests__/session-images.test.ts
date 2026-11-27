/**
 * The one session image store the desktop and the headless host share (M10). The desktop's
 * wrapper has its own suite (`src/__tests__/main/storage/session-image-store.test.ts`).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
	createSessionImageStore,
	hasInlineSessionImages,
	sessionImageContentSha256,
} from '../session-images';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const REF = `maestro-image://store/${'a'.repeat(64)}.png`;

describe('sessionImageContentSha256', () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-session-images-'));
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('answers one hash for a pasted image as a ref and as a data URL (U16)', async () => {
		const ref = await createSessionImageStore(() => dir).storeInlineImage(PNG);
		const hash = sessionImageContentSha256(PNG);
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
		expect(sessionImageContentSha256(ref)).toBe(hash);
		expect(sessionImageContentSha256(`${ref}?tw=64&th=64`)).toBe(hash);
		expect(sessionImageContentSha256('data:image/png;base64,AAAA')).not.toBe(hash);
	});

	it('answers null for anything that is not an image', () => {
		expect(sessionImageContentSha256('maestro-image://store/../etc/passwd')).toBeNull();
		expect(sessionImageContentSha256('data:text/plain;base64,AAAA')).toBeNull();
		expect(sessionImageContentSha256(42)).toBeNull();
	});
});

describe('createSessionImageStore', () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-session-images-'));
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('stores an image once under its hash and reads it back', async () => {
		const store = createSessionImageStore(() => dir);
		const ref = await store.storeInlineImage(PNG);
		expect(await store.storeInlineImage(PNG)).toBe(ref);
		expect(fs.readdirSync(dir)).toHaveLength(1);
		expect(store.resolveToDataUrlSync(ref)).toBe(PNG);
		expect(await store.resolveToDataUrl(ref)).toBe(PNG);
		expect(fs.readdirSync(dir).some((name) => name.endsWith('.tmp'))).toBe(false);
	});

	it('keeps inline an image whose media type no ref could name, rather than lose it', async () => {
		const store = createSessionImageStore(() => dir);
		const icon = 'data:image/x-icon;base64,AAABAA==';
		expect(await store.storeInlineImage(icon)).toBe(icon);
		expect(fs.readdirSync(dir)).toEqual([]);
	});

	it('resolves nothing a store could not have written', () => {
		const store = createSessionImageStore(() => dir);
		expect(store.resolveToFilePath('maestro-image://store/../../etc/passwd')).toBeNull();
		expect(store.resolveToFilePath(`${REF}?tw=10&th=10`)).toBe(
			path.join(dir, `${'a'.repeat(64)}.png`)
		);
		expect(store.resolveToDataUrlSync(REF)).toBeNull();
	});
});

describe('hasInlineSessionImages', () => {
	it.each([
		['a transcript entry', [{ aiTabs: [{ logs: [{ images: [PNG] }] }] }]],
		['a draft', [{ aiTabs: [{ stagedImages: [PNG] }] }]],
		['a Design Mode chip', [{ aiTabs: [{ stagedDesignPicks: [{ screenshot: PNG }] }] }]],
		[
			'a closed tab',
			[{ unifiedClosedTabHistory: [{ type: 'ai', tab: { logs: [{ images: [PNG] }] } }] }],
		],
		['a stored queue item', [{ executionQueue: [{ images: [PNG] }] }]],
	])('finds an inline image on %s', (_label, sessions) => {
		expect(hasInlineSessionImages(sessions)).toBe(true);
	});

	it('finds none in refs, empty fields, and malformed entries', () => {
		expect(
			hasInlineSessionImages([
				{ aiTabs: [{ logs: [{ images: [REF] }, null, 'x'], stagedImages: [] }] },
				null,
				'agent',
				{ executionQueue: [{ images: [REF] }] },
			])
		).toBe(false);
	});
});
