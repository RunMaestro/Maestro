import { describe, it, expect } from 'vitest';

import { createPreviewMarkerCodec, hexToUtf8, utf8ToHex } from '../../shared/previewMarker';

describe('utf8ToHex / hexToUtf8', () => {
	it('round-trips Unicode and URL-hostile characters', () => {
		const value = '/data/naïve #1 ?50% 数据.db';
		expect(hexToUtf8(utf8ToHex(value))).toBe(value);
	});

	it('emits lowercase hex, two digits per byte', () => {
		expect(utf8ToHex('/a')).toBe('2f61');
	});

	it('rejects anything that is not clean lowercase hex', () => {
		expect(hexToUtf8('')).toBeNull();
		expect(hexToUtf8('abc')).toBeNull();
		expect(hexToUtf8('zz')).toBeNull();
		expect(hexToUtf8('2F61')).toBeNull();
	});
});

describe('createPreviewMarkerCodec', () => {
	const codec = createPreviewMarkerCodec('maestro-test');

	it('builds a marker under its own scheme and recovers the path', () => {
		const marker = codec.build('/data/file.bin');
		expect(marker).toBe(`maestro-test://preview/${utf8ToHex('/data/file.bin')}`);
		expect(codec.scheme).toBe('maestro-test');
		expect(codec.is(marker)).toBe(true);
		expect(codec.parse(marker)).toBe('/data/file.bin');
	});

	it("never accepts another format's marker", () => {
		const other = createPreviewMarkerCodec('maestro-other');
		const marker = other.build('/data/file.bin');
		expect(codec.is(marker)).toBe(false);
		expect(codec.parse(marker)).toBeNull();
	});

	it('rejects non-markers and malformed payloads', () => {
		expect(codec.is(null)).toBe(false);
		expect(codec.is(undefined)).toBe(false);
		expect(codec.is('plain text')).toBe(false);
		expect(codec.parse('maestro-test://preview/zz')).toBeNull();
	});
});
