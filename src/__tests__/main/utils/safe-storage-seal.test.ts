/**
 * Tests for main/utils/safe-storage-seal.ts.
 *
 * `obscuringSeal` is what a store falls back on where the OS offers no
 * encryption. These pin what it gives (text that is not readable in the file,
 * and a file that does not open once it was touched) and that it is always
 * there.
 */

import { describe, expect, it } from 'vitest';
import { obscuringSeal, safeStorageSeal } from '../../../main/utils/safe-storage-seal';

describe('safeStorageSeal', () => {
	it('passes through to safeStorage, and never throws from available()', () => {
		const seal = safeStorageSeal({
			isEncryptionAvailable: () => {
				throw new Error('The check itself failed.');
			},
			encryptString: (text) => Buffer.from(`sealed:${text}`, 'utf8'),
			decryptString: (blob) => blob.toString('utf8').slice('sealed:'.length),
		});

		expect(seal.available()).toBe(false);
		expect(seal.unseal(seal.seal('state'))).toBe('state');
	});
});

describe('obscuringSeal', () => {
	const TEXT = JSON.stringify({ folder: '/Users/someone/audit-trail', enabled: true });

	it('is always available', () => {
		expect(obscuringSeal().available()).toBe(true);
	});

	it('gives back the text it was given, across two instances', () => {
		const sealed = obscuringSeal().seal(TEXT);
		// A file sealed in one run of the app is opened in the next.
		expect(obscuringSeal().unseal(sealed)).toBe(TEXT);
	});

	it('keeps text of any shape, the empty text included', () => {
		const seal = obscuringSeal();
		for (const text of ['', 'a', 'café \u{1F512}', 'x'.repeat(100_000)]) {
			expect(seal.unseal(seal.seal(text))).toBe(text);
		}
	});

	it('leaves nothing of the text readable in the bytes', () => {
		const sealed = obscuringSeal().seal(TEXT);
		for (const encoding of ['utf8', 'latin1', 'base64'] as const) {
			const shown = sealed.toString(encoding);
			expect(shown).not.toContain('audit-trail');
			expect(shown).not.toContain('enabled');
		}
	});

	it('seals the same text to different bytes each time', () => {
		const seal = obscuringSeal();
		const seen = new Set(Array.from({ length: 20 }, () => seal.seal(TEXT).toString('hex')));
		expect(seen.size).toBe(20);
	});

	it('does not open bytes that were changed, wherever the change is', () => {
		const seal = obscuringSeal();
		const sealed = seal.seal(TEXT);
		for (const position of [0, 11, 12, 27, 28, sealed.length - 1]) {
			const touched = Buffer.from(sealed);
			touched[position] ^= 0x01;
			expect(() => seal.unseal(touched), `byte ${position}`).toThrow();
		}
	});

	it('does not open bytes that were cut short, or that it never sealed', () => {
		const seal = obscuringSeal();
		const sealed = seal.seal(TEXT);
		expect(() => seal.unseal(sealed.subarray(0, sealed.length - 1))).toThrow();
		expect(() => seal.unseal(sealed.subarray(0, 10))).toThrow('too short');
		expect(() => seal.unseal(Buffer.alloc(0))).toThrow('too short');
		expect(() => seal.unseal(Buffer.from(TEXT, 'utf8'))).toThrow();
	});
});
