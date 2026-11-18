import * as v8 from 'v8';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mediaSubtype, parseBase64DataUrl } from '../../shared/dataUrl';
import { parseDataUrl } from '../../shared/maestro-lib/launch/image-refs';
import { buildStreamJsonMessage } from '../../shared/maestro-lib/launch/stream-json-message';

describe('parseBase64DataUrl', () => {
	it('splits the media type from the payload', () => {
		expect(parseBase64DataUrl('data:image/png;base64,iVBORw0KGgo=')).toEqual({
			mediaType: 'image/png',
			base64: 'iVBORw0KGgo=',
		});
		expect(parseBase64DataUrl('data:application/pdf;base64,JVBERi0=')).toEqual({
			mediaType: 'application/pdf',
			base64: 'JVBERi0=',
		});
	});

	it('rejects values that are not base64 data URLs', () => {
		expect(parseBase64DataUrl('data:image/png;base64,')).toBeNull();
		expect(parseBase64DataUrl('data:image/png,rawtext')).toBeNull();
		expect(parseBase64DataUrl('data:;base64,AAAA')).toBeNull();
		expect(parseBase64DataUrl('maestro-image://store/abc.png')).toBeNull();
		expect(parseBase64DataUrl('')).toBeNull();
		expect(parseBase64DataUrl(undefined as unknown as string)).toBeNull();
	});
});

describe('mediaSubtype', () => {
	it('returns the subtype under the requested type', () => {
		expect(mediaSubtype('image/png')).toBe('png');
		expect(mediaSubtype('image/svg+xml')).toBe('svg+xml');
		expect(mediaSubtype('application/pdf', 'application')).toBe('pdf');
	});

	it('returns null for another type or an empty subtype', () => {
		expect(mediaSubtype('application/pdf')).toBeNull();
		expect(mediaSubtype('image/')).toBeNull();
	});
});

// Regression: an SSH agent's held queue message with a 4.3 MB screenshot
// failed `process:spawn` with "Maximum call stack size exceeded" on every
// retry, in a desktop app that had run for days, while every fresh process
// handled the same image. A long-running process makes V8 compile new
// regexps WITHOUT optimization; the old `(.+)$` payload capture then pushed
// backtrack state per character and overflowed past ~2.5M characters.
// `--no-regexp-optimization` puts this worker in that state.
describe('multi-megabyte data URLs with regexp optimization off', () => {
	// 4.3 MB of image bytes is ~5.7M base64 characters.
	const LARGE = `data:image/png;base64,${'iVBORw0KGgo'.repeat(520_000)}`;

	beforeAll(() => {
		v8.setFlagsFromString('--no-regexp-optimization');
	});

	afterAll(() => {
		v8.setFlagsFromString('--regexp-optimization');
	});

	it('reproduces the overflow with the old payload-capturing pattern', () => {
		const oldPattern = new RegExp('^data:(image\\/[^;]+);base64,(.+)$');
		expect(() => oldPattern.exec(LARGE)).toThrow(/Maximum call stack size exceeded/);
	});

	it('parses the payload without scanning it', () => {
		const parsed = parseBase64DataUrl(LARGE);
		expect(parsed?.mediaType).toBe('image/png');
		expect(parsed?.base64.length).toBe(LARGE.length - 'data:image/png;base64,'.length);
	});

	it('image-refs parseDataUrl keeps the payload verbatim', () => {
		const parsed = parseDataUrl(LARGE);
		expect(parsed?.mediaType).toBe('image/png');
		expect(parsed?.base64).toBe(LARGE.slice('data:image/png;base64,'.length));
	});

	it('builds the SSH stream-json stdin message (the wrap-spawn-for-ssh path)', () => {
		const message = JSON.parse(buildStreamJsonMessage('look at this', [LARGE]));
		const [image, text] = message.message.content;
		expect(image.source.media_type).toBe('image/png');
		expect(image.source.data.length).toBe(LARGE.length - 'data:image/png;base64,'.length);
		expect(text).toEqual({ type: 'text', text: 'look at this' });
	});
});
