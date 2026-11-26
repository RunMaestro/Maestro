/**
 * The one image rule every pipe spawn and the headless host's turns share (`planImageDelivery`),
 * and the bounds an image from another machine must meet (`admitTurnImages`).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as v8 from 'v8';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
	admitTurnImages,
	MAX_TURN_IMAGE_BYTES,
	MAX_TURN_IMAGE_TOTAL_BYTES,
	MAX_TURN_IMAGES,
	planImageDelivery,
	writeImageTempFile,
} from '../../../../shared/maestro-lib/launch/image-delivery';
import { PROVIDER_IMAGE_MEDIA_TYPES } from '../../../../shared/maestro-lib/providers/capabilities';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
/** A data URL whose image decodes to exactly `bytes` bytes. */
const imageOfBytes = (bytes: number) =>
	`data:image/png;base64,${Buffer.alloc(bytes, 1).toString('base64')}`;

// First in the file, so no earlier test has compiled a pattern with optimization on. An aged host
// compiles new regexps without optimization; a pattern over a multi-megabyte payload then overflows
// the backtrack stack (see src/shared/dataUrl.ts). `--no-regexp-optimization` puts this worker in
// that state.
describe('admitTurnImages on multi-megabyte images with regexp optimization off', () => {
	beforeAll(() => {
		v8.setFlagsFromString('--no-regexp-optimization');
	});

	afterAll(() => {
		v8.setFlagsFromString('--regexp-optimization');
	});

	it('admits a 4 MB screenshot without scanning it with a regexp', () => {
		const screenshot = imageOfBytes(4 * 1024 * 1024);
		expect(admitTurnImages([screenshot])).toEqual({
			ok: true,
			images: [screenshot],
			bytes: 4 * 1024 * 1024,
		});
	});

	it('still refuses a multi-megabyte payload with a character outside base64', () => {
		const base64 = Buffer.alloc(4 * 1024 * 1024, 1).toString('base64');
		const middle = base64.length / 2;
		const broken = `${base64.slice(0, middle)}*${base64.slice(middle + 1)}`;
		expect(admitTurnImages([`data:image/png;base64,${broken}`])).toMatchObject({ ok: false });
	});
});

describe('admitTurnImages', () => {
	it('admits none, and inline image data URLs in order', () => {
		expect(admitTurnImages(undefined)).toEqual({ ok: true, images: [], bytes: 0 });
		expect(admitTurnImages([])).toEqual({ ok: true, images: [], bytes: 0 });
		// The decoded bytes together: 8 for the PNG, 6 for the JPEG (a merge's bounds read them).
		expect(admitTurnImages([PNG, 'data:image/jpeg;base64,/9j/4AAQ'])).toEqual({
			ok: true,
			images: [PNG, 'data:image/jpeg;base64,/9j/4AAQ'],
			bytes: 14,
		});
	});

	it.each([
		['not a list', PNG],
		['a non-string', [42]],
		['a store ref, which names the sender machine', ['maestro-image://sha256/abc']],
		['a file path', ['/etc/passwd']],
		['a non-image data URL', ['data:text/plain;base64,aGk=']],
		['bytes that are not canonical base64', ['data:image/png;base64,abc']],
	])('refuses %s', (_label, raw) => {
		expect(admitTurnImages(raw)).toMatchObject({ ok: false });
	});

	// M11: the desktop's own list (PROVIDER_IMAGE_MEDIA_TYPES), never any `image/...`.
	it.each(['image/svg+xml', 'image/x-icon', 'image/bmp', 'image/tiff'])(
		'refuses a %s image, naming the types it takes',
		(mediaType) => {
			expect(admitTurnImages([`data:${mediaType};base64,AAAA`])).toEqual({
				ok: false,
				error: 'An attached image is not PNG, JPEG, GIF or WebP. Remove it and send again.',
			});
		}
	);

	it.each(PROVIDER_IMAGE_MEDIA_TYPES)('admits a %s image', (mediaType) => {
		expect(admitTurnImages([`data:${mediaType};base64,AAAA`])).toMatchObject({ ok: true });
	});

	it('bounds the count, each image, and the total', () => {
		expect(admitTurnImages(Array.from({ length: MAX_TURN_IMAGES }, () => PNG)).ok).toBe(true);
		expect(admitTurnImages(Array.from({ length: MAX_TURN_IMAGES + 1 }, () => PNG))).toMatchObject({
			ok: false,
			error: expect.stringContaining(`${MAX_TURN_IMAGES} images`),
		});
		expect(admitTurnImages([imageOfBytes(MAX_TURN_IMAGE_BYTES + 3)])).toMatchObject({
			ok: false,
		});
		const half = Math.ceil(MAX_TURN_IMAGE_TOTAL_BYTES / 2 / 3) * 3 + 3;
		expect(admitTurnImages([imageOfBytes(half), imageOfBytes(half)])).toMatchObject({
			ok: false,
			error: expect.stringContaining('together'),
		});
	});
});

describe('writeImageTempFile', () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	});

	it('writes the decoded bytes to a fresh owner-only file, and answers null for a non-image', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-delivery-'));
		dirs.push(dir);
		const file = writeImageTempFile(PNG, 0, dir)!;
		expect(path.dirname(file)).toBe(dir);
		expect(file.endsWith('-0.png')).toBe(true);
		expect(fs.readFileSync(file)).toEqual(Buffer.from('iVBORw0KGgo=', 'base64'));
		if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
		expect(writeImageTempFile('not an image', 1, dir)).toBeNull();
	});

	it('removes the file it created when the write fails, and throws', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-delivery-'));
		dirs.push(dir);
		const io = {
			openSync: fs.openSync,
			closeSync: fs.closeSync,
			unlinkSync: fs.unlinkSync,
			writeFileSync: () => {
				throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
			},
		} as never;
		expect(() => writeImageTempFile(PNG, 0, dir, io)).toThrow('no space');
		expect(fs.readdirSync(dir)).toEqual([]);
	});

	it("never removes a file it did not create (a name that is someone else's)", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-delivery-'));
		dirs.push(dir);
		const theirs = path.join(dir, 'theirs.png');
		fs.writeFileSync(theirs, 'keep');
		let first = true;
		const io = {
			openSync: (file: string, flags: string, mode: number) => {
				if (first) {
					first = false;
					throw Object.assign(new Error('exists'), { code: 'EEXIST' });
				}
				return fs.openSync(file, flags, mode);
			},
			closeSync: fs.closeSync,
			unlinkSync: fs.unlinkSync,
			writeFileSync: fs.writeFileSync,
		} as never;
		const file = writeImageTempFile(PNG, 0, dir, io)!;
		expect(fs.readFileSync(theirs, 'utf8')).toBe('keep');
		expect(fs.existsSync(file)).toBe(true);
	});
});

describe('planImageDelivery', () => {
	const files = (_image: string, index: number) => `/tmp/image-${index}.png`;

	it('sends a stream-json reader one stdin message, flag added once', () => {
		expect(
			planImageDelivery(
				{
					args: ['--print'],
					prompt: 'look',
					images: [PNG],
					capabilities: { supportsStreamJsonInput: true },
					promptViaStdin: false,
				},
				() => {
					throw new Error('a stream-json reader needs no files');
				}
			)
		).toEqual({ via: 'stream-json', args: ['--print', '--input-format', 'stream-json'] });
		expect(
			planImageDelivery(
				{
					args: ['--input-format', 'stream-json'],
					prompt: 'look',
					images: [PNG],
					capabilities: { supportsStreamJsonInput: true },
					promptViaStdin: true,
				},
				files
			)
		).toMatchObject({ args: ['--input-format', 'stream-json'] });
	});

	it('puts image arguments before the prompt for a file reader', () => {
		expect(
			planImageDelivery(
				{
					args: ['run'],
					prompt: 'look',
					images: [PNG, PNG],
					capabilities: { supportsStreamJsonInput: false },
					imageArgs: (file) => ['-f', file],
					promptViaStdin: false,
				},
				files
			)
		).toEqual({
			via: 'files',
			args: ['run', '-f', '/tmp/image-0.png', '-f', '/tmp/image-1.png', '--', 'look'],
			prompt: 'look',
			promptInArgs: true,
			tempFiles: ['/tmp/image-0.png', '/tmp/image-1.png'],
			dropped: 0,
		});
	});

	it('names the files in the prompt for a prompt builder, or a prompt-embed resume', () => {
		expect(
			planImageDelivery(
				{
					args: ['exec'],
					prompt: 'look',
					images: [PNG],
					capabilities: { supportsStreamJsonInput: false },
					imagePromptBuilder: (paths) => `@${paths.join(' @')} `,
					noPromptSeparator: true,
					promptViaStdin: false,
				},
				files
			)
		).toMatchObject({ args: ['exec', '@/tmp/image-0.png look'], prompt: '@/tmp/image-0.png look' });
		expect(
			planImageDelivery(
				{
					args: ['exec', 'resume', 'id'],
					prompt: 'look',
					images: [PNG],
					capabilities: { supportsStreamJsonInput: false, imageResumeMode: 'prompt-embed' },
					imageArgs: (file) => ['-i', file],
					promptViaStdin: true,
				},
				files
			)
		).toEqual({
			via: 'files',
			args: ['exec', 'resume', 'id'],
			prompt: '[Attached images: /tmp/image-0.png]\n\nlook',
			promptInArgs: false,
			tempFiles: ['/tmp/image-0.png'],
			dropped: 0,
		});
	});

	it('counts an image the writer could not write, and says when a provider has no way in', () => {
		expect(
			planImageDelivery(
				{
					args: [],
					prompt: 'look',
					images: [PNG, PNG],
					capabilities: { supportsStreamJsonInput: false },
					imageArgs: (file) => ['-i', file],
					promptViaStdin: false,
				},
				(_image, index) => (index === 0 ? '/tmp/a.png' : null)
			)
		).toMatchObject({ via: 'files', tempFiles: ['/tmp/a.png'], dropped: 1 });
		expect(
			planImageDelivery(
				{
					args: [],
					prompt: 'look',
					images: [PNG],
					capabilities: { supportsStreamJsonInput: false },
					promptViaStdin: false,
				},
				files
			)
		).toEqual({ via: 'none' });
	});
});
