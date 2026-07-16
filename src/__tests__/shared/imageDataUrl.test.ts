import { describe, expect, it } from 'vitest';
import { parseImageDataUrl } from '../../shared/imageDataUrl';

const PNG_BASE64 = 'aGVsbG8=';

describe('parseImageDataUrl', () => {
	it.each([
		['png', `data:image/png;base64,${PNG_BASE64}`, undefined, 'image/png', 'png', 5],
		[
			'jpeg with jpg filename',
			`data:image/jpeg;base64,${PNG_BASE64}`,
			'photo.jpg',
			'image/jpeg',
			'jpg',
			5,
		],
		['svg', `data:image/svg+xml;base64,${PNG_BASE64}`, 'icon.svg', 'image/svg+xml', 'svg', 5],
	])('parses valid %s data URLs', (_name, value, filename, mimeType, extension, byteLength) => {
		const parsed = parseImageDataUrl(value, { filename });
		expect(parsed).toMatchObject({ mimeType, extension, base64: PNG_BASE64, byteLength });
		expect(parsed?.bytes).toEqual(new Uint8Array([104, 101, 108, 108, 111]));
	});

	it.each([
		['missing data prefix', `image/png;base64,${PNG_BASE64}`],
		['unsupported MIME', `data:image/bmp;base64,${PNG_BASE64}`],
		['parameterized MIME', `data:image/png;charset=utf-8;base64,${PNG_BASE64}`],
		['whitespace in payload', `data:image/png;base64,aGVs bG8=`],
		['Unicode payload', 'data:image/png;base64,8J+YgA==é'],
		['invalid padding', 'data:image/png;base64,aGVsbG8'],
		['invalid alphabet', 'data:image/png;base64,aGVsbG8!'],
	])('rejects %s', (_name, value) => {
		expect(parseImageDataUrl(value)).toBeNull();
	});

	it('rejects oversized payloads before decoding', () => {
		expect(
			parseImageDataUrl(`data:image/png;base64,${PNG_BASE64}`, { maximumBytes: 4 })
		).toBeNull();
	});

	it('rejects a MIME and filename extension mismatch', () => {
		expect(
			parseImageDataUrl(`data:image/png;base64,${PNG_BASE64}`, { filename: 'photo.jpg' })
		).toBeNull();
	});
});
