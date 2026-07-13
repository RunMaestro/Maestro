import { describe, expect, it } from 'vitest';
import {
	encodeBase64,
	MAX_OMP_IMAGE_BYTES,
	MAX_OMP_PROMPT_ATTACHMENT_BYTES,
	sha256Hex,
} from '../../runtime/byte-codec';

describe('sandbox-safe OMP byte codec', () => {
	it.each([
		['empty', new Uint8Array(), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
		[
			'abc',
			new TextEncoder().encode('abc'),
			'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
		],
		[
			'2 MiB',
			new Uint8Array(MAX_OMP_IMAGE_BYTES).fill(0xa5),
			'ba4f9806c2754bc4a1cc80f4b5fc67b9d88b039382ecc1f69bd1a2854c3cf1cd',
		],
	])('hashes the %s known vector', (_name, bytes, expected) => {
		expect(sha256Hex(bytes)).toBe(expected);
	});

	it('accepts just-under and exact aggregate-bound image bytes, rejects one byte over, and keeps the encoded prompt under 3 MiB', () => {
		expect(encodeBase64(new Uint8Array(MAX_OMP_IMAGE_BYTES - 1))).toHaveLength(
			4 * Math.ceil((MAX_OMP_IMAGE_BYTES - 1) / 3)
		);
		const encoded = encodeBase64(new Uint8Array(MAX_OMP_IMAGE_BYTES));
		expect(encoded).toHaveLength(4 * Math.ceil(MAX_OMP_IMAGE_BYTES / 3));
		expect(() => encodeBase64(new Uint8Array(MAX_OMP_IMAGE_BYTES + 1))).toThrow(RangeError);

		const command = {
			type: 'prompt',
			message: 'x'.repeat(65_536),
			images: [{ type: 'image', data: encoded, mimeType: 'image/png' }],
		};
		expect(Buffer.byteLength(JSON.stringify(command))).toBeLessThan(3 * 1024 * 1024);
		expect(MAX_OMP_PROMPT_ATTACHMENT_BYTES).toBe(MAX_OMP_IMAGE_BYTES);
	});

	it('encodes image bytes without host byte globals', () => {
		expect(encodeBase64(new Uint8Array([97, 98, 99]))).toBe('YWJj');
		expect(encodeBase64(new Uint8Array([255]))).toBe('/w==');
	});
});
