import { describe, expect, it } from 'vitest';
import { encodeBase64, MAX_OMP_IMAGE_BYTES, sha256Hex } from '../../runtime/byte-codec';

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

	it('rejects bytes over the 2 MiB resource bound', () => {
		const tooLarge = new Uint8Array(MAX_OMP_IMAGE_BYTES + 1);
		expect(() => sha256Hex(tooLarge)).toThrow(RangeError);
		expect(() => encodeBase64(tooLarge)).toThrow(RangeError);
	});

	it('encodes image bytes without host byte globals', () => {
		expect(encodeBase64(new Uint8Array([97, 98, 99]))).toBe('YWJj');
		expect(encodeBase64(new Uint8Array([255]))).toBe('/w==');
	});
});
