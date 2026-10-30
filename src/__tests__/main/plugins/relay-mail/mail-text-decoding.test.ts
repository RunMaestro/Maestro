import { Buffer } from 'node:buffer';
import { TextDecoder } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { consumeMailHeaderDisplay } from '../../../../main/plugins/relay-mail/mail-header-projection';
import { ImapConnectionError } from '../../../../main/plugins/relay-mail/mail-errors';
import {
	assertMailTextCharacters,
	consumeMailPlainText,
	decodeMailCharsetBytes,
	MAIL_TEXT_LIMITS,
} from '../../../../main/plugins/relay-mail/mail-text-decoding';

afterEach(() => vi.restoreAllMocks());

describe('complete owned plain-text charset decoding', () => {
	it.each([
		['UTF-8', ''],
		['US-ASCII', ''],
		['uTf-8', '  A\t B\r\n\r\nfinal  '],
		['uS-aScIi', '\r\n\t final\r\n'],
		['UTF-8', 'é€😀 e\u0301\r\n終'],
		['US-ASCII', '<b>literal</b> & **text**'],
	])('preserves complete %s text %j and erases every input alias', (charset, text) => {
		const input = Buffer.from(text);
		const alias = input.subarray(0);
		const result = consumeMailPlainText(input, charset, Math.max(1, input.length));
		expect(result).toBe(text);
		expect(Buffer.byteLength(result)).toBe(input.length);
		expect(alias.every((byte) => byte === 0)).toBe(true);
		alias.fill(88);
		expect(result).toBe(text);
		input.fill(0);
	});

	it.each(['UTF-8', 'US-ASCII'])('accepts the exact maximum %s byte cap', (charset) => {
		const text = 'A\r\nB'.repeat(MAIL_TEXT_LIMITS.plainTextBytes / 4);
		const input = Buffer.from(text);
		expect(consumeMailPlainText(input, charset, MAIL_TEXT_LIMITS.plainTextBytes)).toBe(text);
		expect(input.every((byte) => byte === 0)).toBe(true);
	});

	it.each(['UTF-8', 'US-ASCII'])('rejects byte overflow before %s text construction', (charset) => {
		const input = Buffer.alloc(MAIL_TEXT_LIMITS.plainTextBytes + 1, 65);
		const decode = vi.spyOn(TextDecoder.prototype, 'decode');
		const toString = vi.spyOn(Buffer.prototype, 'toString');
		expect(() =>
			consumeMailPlainText(input, charset, MAIL_TEXT_LIMITS.plainTextBytes)
		).toThrowError(new ImapConnectionError('MAIL_LIMIT'));
		expect(decode).not.toHaveBeenCalled();
		expect(toString).not.toHaveBeenCalled();
		expect(input.every((byte) => byte === 0)).toBe(true);
	});

	it('counts UTF-8 bytes rather than JavaScript code units under tightened caps', () => {
		const exact = Buffer.from('😀');
		expect(consumeMailPlainText(exact, 'UTF-8', 4)).toBe('😀');
		expect([...exact]).toEqual([0, 0, 0, 0]);
		const over = Buffer.from('😀');
		const decode = vi.spyOn(TextDecoder.prototype, 'decode');
		expect(() => consumeMailPlainText(over, 'UTF-8', 3)).toThrowError(
			new ImapConnectionError('MAIL_LIMIT')
		);
		expect(decode).not.toHaveBeenCalled();
		expect([...over]).toEqual([0, 0, 0, 0]);
	});

	it.each([
		undefined,
		null,
		'1',
		0,
		-1,
		1.5,
		NaN,
		Infinity,
		Number.MAX_SAFE_INTEGER,
		MAIL_TEXT_LIMITS.plainTextBytes + 1,
	])('requires a positive tighten-only cap %j and consumes input', (cap) => {
		const input = Buffer.from('synthetic-private');
		const alias = input.subarray(0);
		const decode = vi.spyOn(TextDecoder.prototype, 'decode');
		const toString = vi.spyOn(Buffer.prototype, 'toString');
		expect(() => consumeMailPlainText(input, 'UTF-8', cap as number)).toThrowError(
			new ImapConnectionError('MAIL_INVALID')
		);
		expect(decode).not.toHaveBeenCalled();
		expect(toString).not.toHaveBeenCalled();
		expect(alias.every((byte) => byte === 0)).toBe(true);
	});

	it.each([undefined, null, 'text', new Uint8Array([65])])(
		'rejects non-owned input %j',
		(input) => {
			expect(() => consumeMailPlainText(input, 'UTF-8', 100)).toThrowError(
				new ImapConnectionError('MAIL_INVALID')
			);
		}
	);

	it.each([
		undefined,
		null,
		0,
		'',
		'utf8',
		'ascii',
		'latin1',
		'ISO-8859-1',
		'windows-1252',
		' UTF-8',
		'UTF-8 ',
		'UTF-8\t',
		'UTF-8\0',
		'UTF-8\r\n',
		'UTF-８',
		'UTF-8*en',
	])('refuses missing/aliased/unsupported charset %j without a body fallback', (charset) => {
		const input = Buffer.from('synthetic-private');
		const alias = input.subarray(0);
		expect(() => consumeMailPlainText(input, charset, 100)).toThrowError(
			new ImapConnectionError(typeof charset === 'string' ? 'MAIL_PROTOCOL' : 'MAIL_INVALID')
		);
		expect(alias.every((byte) => byte === 0)).toBe(true);
	});

	it.each([0x80, 0x81, 0xe9, 0xff])('rejects high-byte ASCII %i without masking', (byte) => {
		const input = Buffer.from([65, byte, 66]);
		expect(() => consumeMailPlainText(input, 'US-ASCII', 3)).toThrowError(
			new ImapConnectionError('MAIL_PROTOCOL')
		);
		expect([...input]).toEqual([0, 0, 0]);
	});

	it.each(
		[
			[0x80],
			[0xc0, 0xaf],
			[0xc1, 0xbf],
			[0xc2],
			[0xc2, 0x41],
			[0xe0, 0x80, 0xaf],
			[0xe2, 0x82],
			[0xe2, 0x41, 0xac],
			[0xed, 0xa0, 0x80],
			[0xed, 0xbf, 0xbf],
			[0xf0, 0x80, 0x80, 0xaf],
			[0xf0, 0x9f, 0x98],
			[0xf4, 0x90, 0x80, 0x80],
			[0xf5, 0x80, 0x80, 0x80],
			[0xff],
		].map((bytes) => ({ bytes }))
	)(
		'rejects malformed UTF-8 %j without replacement/partial success or native cause',
		({ bytes }) => {
			const input = Buffer.from([65, ...bytes, 66]);
			const alias = input.subarray(0);
			let caught: unknown;
			try {
				consumeMailPlainText(input, 'UTF-8', 100);
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(ImapConnectionError);
			expect(caught).toMatchObject({
				code: 'MAIL_PROTOCOL',
				message: 'Unsupported or invalid mail response.',
			});
			expect(caught).not.toHaveProperty('cause');
			expect(String(caught)).not.toContain('encoded');
			expect(alias.every((byte) => byte === 0)).toBe(true);
		}
	);

	it.each([
		'\0',
		'\u0001',
		'\v',
		'\f',
		'\u001b',
		'\u007f',
		'\u0080',
		'\u0085',
		'\u009f',
		'\ufeff',
		'\u00ad',
		'\u200b',
		'\u200c',
		'\u200d',
		'\u200e',
		'\u200f',
		'\u202a',
		'\u202b',
		'\u202c',
		'\u202d',
		'\u202e',
		'\u2066',
		'\u2067',
		'\u2068',
		'\u2069',
		'\u2028',
		'\u2029',
		'\r',
		'\n',
	])('rejects forbidden plain-text character %j and erases consumed aliases', (character) => {
		const input = Buffer.from('private' + character + 'suffix');
		const alias = input.subarray(0);
		expect(() => consumeMailPlainText(input, 'UTF-8', 100)).toThrowError(
			new ImapConnectionError('MAIL_PROTOCOL')
		);
		expect(alias.every((byte) => byte === 0)).toBe(true);
	});

	it.each(['\ud800', '\udfff'])('refuses surrogate %j in shared character checks', (character) => {
		expect(() => assertMailTextCharacters(character, 'plain')).toThrowError(
			new ImapConnectionError('MAIL_PROTOCOL')
		);
		expect(() => assertMailTextCharacters(character, 'display')).toThrowError(
			new ImapConnectionError('MAIL_PROTOCOL')
		);
	});

	it.each(['\t', '\r\n'])('allows %j only in plain character policy', (value) => {
		expect(() => assertMailTextCharacters(value, 'plain')).not.toThrow();
		expect(() => assertMailTextCharacters(value, 'display')).toThrowError(
			new ImapConnectionError('MAIL_PROTOCOL')
		);
	});
});

describe('bounded non-consuming shared charset core', () => {
	it.each([undefined, null, 'A', new Uint8Array([65])])(
		'refuses invalid shared input %j',
		(input) => {
			expect(() => decodeMailCharsetBytes(input as Buffer, 'UTF-8', 100)).toThrowError(
				new ImapConnectionError('MAIL_INVALID')
			);
		}
	);

	it.each([undefined, null, 0])('refuses nonstring shared charset %j', (charset) => {
		const input = Buffer.from('A');
		try {
			expect(() => decodeMailCharsetBytes(input, charset as unknown as string, 100)).toThrowError(
				new ImapConnectionError('MAIL_INVALID')
			);
			expect([...input]).toEqual([65]);
		} finally {
			input.fill(0);
		}
	});

	it.each([
		['UTF-8', [0xc2], 1, 'MAIL_PROTOCOL'],
		['US-ASCII', [0xe9], 1, 'MAIL_PROTOCOL'],
		['ISO-8859-1', [65, 66], 1, 'MAIL_LIMIT'],
	] as const)('preserves caller bytes on shared %s failure', (charset, bytes, cap, code) => {
		const input = Buffer.from(bytes);
		const alias = input.subarray(0);
		try {
			expect(() => decodeMailCharsetBytes(input, charset, cap)).toThrowError(
				new ImapConnectionError(code)
			);
			expect([...alias]).toEqual([...bytes]);
		} finally {
			input.fill(0);
		}
		expect(alias.every((byte) => byte === 0)).toBe(true);
	});

	it.each([
		['uTf-8', [0xc3, 0xa9], 'é', 2],
		['US-ASCII', [65, 9, 13, 10, 66], 'A\t\r\nB', 5],
		['iso-8859-1', [0x41, 0x80, 0x9f, 0xe9, 0xff], 'A\u0080\u009féÿ', 9],
	] as const)(
		'decodes %s at its exact UTF-8 expansion cap without consuming',
		(charset, bytes, expected, cap) => {
			const input = Buffer.from(bytes);
			const alias = input.subarray(0);
			try {
				const result = decodeMailCharsetBytes(input, charset, cap);
				expect(result).toBe(expected);
				expect(Buffer.byteLength(result)).toBe(cap);
				expect([...alias]).toEqual([...bytes]);
			} finally {
				input.fill(0);
			}
			expect(alias.every((byte) => byte === 0)).toBe(true);
		}
	);

	it('counts Latin-1 expansion before string construction, preserving refused input', () => {
		const input = Buffer.from([0x41, 0x80, 0xe9]);
		const toString = vi.spyOn(Buffer.prototype, 'toString');
		expect(() => decodeMailCharsetBytes(input, 'ISO-8859-1', 4)).toThrowError(
			new ImapConnectionError('MAIL_LIMIT')
		);
		expect(toString).not.toHaveBeenCalled();
		expect([...input]).toEqual([0x41, 0x80, 0xe9]);
		input.fill(0);
	});

	it.each(['UTF-8', 'US-ASCII', 'ISO-8859-1'])('accepts empty %s shared input', (charset) => {
		expect(decodeMailCharsetBytes(Buffer.alloc(0), charset, 1)).toBe('');
	});

	it.each([undefined, null, 0, -1, 1.5, NaN, Infinity, MAIL_TEXT_LIMITS.plainTextBytes + 1])(
		'refuses invalid shared cap %j without consuming caller bytes',
		(cap) => {
			const input = Buffer.from('A');
			try {
				expect(() => decodeMailCharsetBytes(input, 'UTF-8', cap as number)).toThrowError(
					new ImapConnectionError('MAIL_INVALID')
				);
				expect([...input]).toEqual([65]);
			} finally {
				input.fill(0);
			}
		}
	);

	it.each([
		'',
		'utf8',
		'ASCII',
		'latin1',
		'UTF-16',
		'UTF-8 ',
		' UTF-8',
		'UTF-8\0',
		'UTF-８',
		'X'.repeat(11),
	])('refuses unsupported shared token %j without consuming', (charset) => {
		const input = Buffer.from('A');
		try {
			expect(() => decodeMailCharsetBytes(input, charset, 100)).toThrowError(
				new ImapConnectionError('MAIL_PROTOCOL')
			);
			expect([...input]).toEqual([65]);
		} finally {
			input.fill(0);
		}
	});

	it('leaves BOM/control interpretation to the consumer and never guesses Windows-1252', () => {
		const input = Buffer.from([0xef, 0xbb, 0xbf, 65]);
		try {
			expect(decodeMailCharsetBytes(input, 'UTF-8', 4)).toBe('\ufeffA');
			expect([...input]).toEqual([0xef, 0xbb, 0xbf, 65]);
		} finally {
			input.fill(0);
		}
	});
});

describe('actual RFC 2047 projection regressions through the shared charset core', () => {
	it.each([
		['plain  subject', 'plain subject'],
		['=?UTF-8?B?w6k=?=', 'é'],
		['=?uTf-8?Q?=C3=A9?=', 'é'],
		['=?UTF-8?B?8J+YgA==?=', '😀'],
		['=?US-ASCII?B?QQ==?=', 'A'],
		['=?us-ascii?Q?A_B=5F?=', 'A B_'],
		['=?ISO-8859-1?B?6Q==?=', 'é'],
		['=?iso-8859-1?Q?=E9?=', 'é'],
		['=?UTF-8?B?w6k=?= \t =?US-ASCII?Q?_A?=', 'é A'],
	])('preserves %j and frozen closed header projection', (wire, expected) => {
		const input = Buffer.from(`Subject: ${wire}\r\nFrom: ${wire}\r\n\r\n`);
		const alias = input.subarray(0);
		const result = consumeMailHeaderDisplay(input);
		expect(result).toEqual({ subject: expected, sender: expected });
		expect(Object.isFrozen(result)).toBe(true);
		expect(alias.every((byte) => byte === 0)).toBe(true);
	});

	it.each([
		'=?US-ASCII?B?6Q==?=',
		'=?UTF-8?B?wA==?=',
		'=?UTF-8?Q?=ED=A0=80?=',
		'=?UTF-8?Q?=EF=BB=BF?=',
		'=?ISO-8859-1?B?gA==?=',
		'=?ISO-8859-1?Q?=9F?=',
		'=?UTF-8?Q?=E2=80=AE?=',
		'=?UTF-8?Q?=E2=80=A8?=',
		'=?US-ASCII?Q?=09?=',
		'=?US-ASCII?Q?=0D=0A?=',
		'=?UTF8?B?QQ==?=',
		'=?windows-1252?Q?=E9?=',
		'=?UTF-8?B?QR==?=',
		'=?UTF-8?Q?=c3=a9?=',
	])('rejects unsupported/malformed/unsafe encoded header %j without fallback', (wire) => {
		const input = Buffer.from(`Subject: ${wire}\r\n\r\n`);
		expect(() => consumeMailHeaderDisplay(input)).toThrowError(
			new ImapConnectionError('MAIL_PROTOCOL')
		);
		expect(input.every((byte) => byte === 0)).toBe(true);
	});
});
