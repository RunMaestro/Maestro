import { describe, it, expect } from 'vitest';
import { buildImagePromptPrefix } from '../../../../main/process-manager/utils/imageUtils';
import {
	buildAcpPromptFileContent,
	type AcpPromptBlock,
	type EmbeddedImageSupport,
} from '../../../../shared/maestro-lib/launch/image-refs';

describe('imageUtils', () => {
	describe('buildImagePromptPrefix', () => {
		it('should return empty string for empty array', () => {
			expect(buildImagePromptPrefix([])).toBe('');
		});

		it('should return prefix with single image path', () => {
			const result = buildImagePromptPrefix(['/tmp/maestro-image-123-0.png']);
			expect(result).toBe('[Attached images: /tmp/maestro-image-123-0.png]\n\n');
		});

		it('should return prefix with multiple image paths', () => {
			const result = buildImagePromptPrefix([
				'/tmp/maestro-image-123-0.png',
				'/tmp/maestro-image-123-1.jpg',
			]);
			expect(result).toBe(
				'[Attached images: /tmp/maestro-image-123-0.png, /tmp/maestro-image-123-1.jpg]\n\n'
			);
		});

		it('should handle Windows-style paths', () => {
			const result = buildImagePromptPrefix([
				'C:\\Users\\test\\AppData\\Local\\Temp\\maestro-image-0.png',
			]);
			expect(result).toBe(
				'[Attached images: C:\\Users\\test\\AppData\\Local\\Temp\\maestro-image-0.png]\n\n'
			);
		});
	});
});

describe('buildAcpPromptFileContent', () => {
	// Synthetic bytes exercise encoding/limits, not native image decoding or model support.
	const image = { type: 'image', data: 'AQID', mimeType: 'image/png' } as const;
	const support: EmbeddedImageSupport = {
		mimeTypes: ['image/png', 'image/jpeg'],
		maxCount: 2,
		maxBytesPerImage: 3,
		maxTotalBytes: 6,
	};

	it('preserves mixed content order and emits only ACP wire fields at exact image limits', () => {
		const blocks = [
			{ type: 'text', text: '  before\n雪 🐾\t', path: 'private-text-path' },
			{ ...image, path: 'private-image-path', uri: 'maestro-image://private-image-ref' },
			{ type: 'text', text: '' },
			{ ...image, data: 'BAUG', mimeType: 'image/jpeg' },
			{ type: 'text', text: '\n after  ' },
		] as const;
		const before = JSON.stringify(blocks);
		const result = buildAcpPromptFileContent(blocks, support);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(result.error);
		expect(result.hasImages).toBe(true);
		expect(JSON.parse(result.content)).toEqual({
			type: 'acp',
			content: [
				{ type: 'text', text: '  before\n雪 🐾\t' },
				image,
				{ type: 'text', text: '' },
				{ type: 'image', data: 'BAUG', mimeType: 'image/jpeg' },
				{ type: 'text', text: '\n after  ' },
			],
		});
		expect(result.content).not.toMatch(/private-|maestro-image:|Attached images/);
		expect(JSON.stringify(blocks)).toBe(before);
	});

	it.each(['YQ==', 'YWI=', 'YWJj'])('counts decoded bytes for canonical base64 %s', (data) => {
		const bytes = Buffer.from(data, 'base64').length;
		const block = { ...image, data };
		expect(
			buildAcpPromptFileContent([block], {
				...support,
				maxBytesPerImage: bytes,
				maxTotalBytes: bytes,
			})
		).toEqual({
			ok: true,
			content: JSON.stringify({ type: 'acp', content: [block] }),
			hasImages: true,
		});
	});

	it.each([
		['null input', null],
		['non-array input', { type: 'text', text: 'private-text' }],
		['empty list', []],
		['null block', [null]],
		['non-string text', [{ type: 'text', text: 7 }]],
		['missing image data', [{ type: 'image', mimeType: 'image/png' }]],
		['non-string image data', [{ type: 'image', data: 7, mimeType: 'image/png' }]],
		['non-string MIME', [{ type: 'image', data: 'AQID', mimeType: 7 }]],
		['resource path', [{ type: 'resource', uri: 'file:///private-image-path' }]],
		['tool-read image', [{ type: 'image', path: 'private-image-path', mimeType: 'image/png' }]],
	])('refuses %s without a partial or text-only result', (_name, blocks) => {
		const result = buildAcpPromptFileContent(blocks as unknown as AcpPromptBlock[], support);
		expect(result).toEqual({ ok: false, error: expect.any(String) });
		expect(JSON.stringify(result)).not.toMatch(/private-|file:\/\//);
	});

	it.each([
		['image/webp', ['image/png']],
		['text/plain', ['text/plain']],
		['IMAGE/png', ['IMAGE/png']],
		['image/', ['image/']],
		['image/png;private-parameter', ['image/png;private-parameter']],
	] as const)(
		'refuses unsupported or malformed MIME %s even if supplied by a caller',
		(mimeType, mimeTypes) => {
			expect(
				buildAcpPromptFileContent([{ ...image, mimeType }], {
					...support,
					mimeTypes,
				})
			).toEqual({
				ok: false,
				error: 'The embedded image MIME type is not supported for this turn.',
			});
		}
	);

	it.each([
		'',
		'YQ',
		'YQ===',
		'YQ==\n',
		'YR==',
		'!!!!',
		'data:image/png;base64,YQ==',
		'maestro-image://private-ref',
	])('refuses malformed base64 or unresolved image reference %j', (data) => {
		const result = buildAcpPromptFileContent(
			[
				{ type: 'text', text: 'private-text' },
				{ ...image, data },
			],
			{ ...support, maxBytesPerImage: 100, maxTotalBytes: 100 }
		);
		expect(result).toEqual({
			ok: false,
			error: 'An embedded image must contain valid base64 bytes.',
		});
		expect(JSON.stringify(result)).not.toContain('private-');
	});

	it('refuses images when admission support is absent', () => {
		expect(buildAcpPromptFileContent([image])).toEqual({
			ok: false,
			error: 'Embedded images require explicit support and bounded image limits.',
		});
	});

	it.each(['maxCount', 'maxBytesPerImage', 'maxTotalBytes'] as const)(
		'requires a positive safe integer for %s',
		(key) => {
			for (const limit of [undefined, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
				expect(buildAcpPromptFileContent([image], { ...support, [key]: limit })).toEqual({
					ok: false,
					error: 'Embedded images require explicit support and bounded image limits.',
				});
			}
		}
	);

	it.each([
		['count', [image, image, image], support, 'The prompt exceeds the admitted image count.'],
		[
			'per-image bytes',
			[image],
			{ ...support, maxBytesPerImage: 2 },
			'The prompt exceeds the admitted image byte limits.',
		],
		[
			'total bytes',
			[image, image],
			{ ...support, maxTotalBytes: 5 },
			'The prompt exceeds the admitted image byte limits.',
		],
	] as const)(
		'refuses excess %s without returning accepted earlier blocks',
		(_name, images, limits, error) => {
			expect(
				buildAcpPromptFileContent([{ type: 'text', text: 'private-text' }, ...images], limits)
			).toEqual({
				ok: false,
				error,
			});
		}
	);
});
