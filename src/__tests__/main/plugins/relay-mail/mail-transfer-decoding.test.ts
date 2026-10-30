import { Buffer } from 'node:buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImapConnectionError } from '../../../../main/plugins/relay-mail/mail-errors';
import { IMAP_FRAMING_LIMITS } from '../../../../main/plugins/relay-mail/mail-imap-framing';
import { consumeMailHeaderDisplay } from '../../../../main/plugins/relay-mail/mail-header-projection';
import {
	consumeMailTransferBytes,
	decodeMailBase64,
	MAIL_TRANSFER_LIMITS,
} from '../../../../main/plugins/relay-mail/mail-transfer-decoding';

afterEach(() => vi.restoreAllMocks());

describe('complete owned MIME transfer bytes', () => {
	it.each([
		['7bit', 'A\t B\r\nfinal', 'A\t B\r\nfinal'],
		['8BIT', 'A\r\n', 'A\r\n'],
		['BaSe64', 'QQ==\r\n', 'A'],
		['QUOTED-PRINTABLE', 'A_=20B=09C=0D=0A', 'A_ B\tC\r\n'],
		['quoted-printable', 'A=\r\nB\r\nfinal', 'AB\r\nfinal'],
		['quoted-printable', 'A \tB', 'A \tB'],
	])('decodes %s completely and erases every input alias', (encoding, wire, expected) => {
		const input = Buffer.from(wire);
		const alias = input.subarray(0);
		const output = consumeMailTransferBytes(input, encoding, Buffer.byteLength(expected));
		try {
			expect(output.toString()).toBe(expected);
			expect(output.length).toBe(Buffer.byteLength(expected));
			expect(output === input).toBe(false);
			expect(alias.equals(Buffer.alloc(alias.length))).toBe(true);
			alias.fill(88);
			expect(output.toString()).toBe(expected);
		} finally {
			input.fill(0);
			output.fill(0);
		}
	});

	it.each(['7bit', '8bit', 'base64', 'quoted-printable'])('accepts empty %s parts', (encoding) => {
		const input = Buffer.alloc(0);
		const output = consumeMailTransferBytes(input, encoding, 1);
		expect(output === input).toBe(false);
		expect(output).toHaveLength(0);
	});

	it('preserves high bytes only for 8bit, including a final unterminated ordinary line', () => {
		const input = Buffer.from([0x80, 0xff, 13, 10, 0x81]);
		const output = consumeMailTransferBytes(input, '8bit', input.length);
		try {
			expect([...output]).toEqual([0x80, 0xff, 13, 10, 0x81]);
			expect([...input]).toEqual([0, 0, 0, 0, 0]);
		} finally {
			output.fill(0);
		}
	});

	it.each(['7bit', '8bit'])('enforces the exact %s identity line ceiling', (encoding) => {
		const input = Buffer.from('A'.repeat(MAIL_TRANSFER_LIMITS.identityLineBytes) + '\r\nB');
		const output = consumeMailTransferBytes(input, encoding, input.length);
		try {
			expect(output.toString()).toBe('A'.repeat(998) + '\r\nB');
			expect(input.equals(Buffer.alloc(input.length))).toBe(true);
		} finally {
			output.fill(0);
		}
		const over = Buffer.from('A'.repeat(MAIL_TRANSFER_LIMITS.identityLineBytes + 1));
		expect(() => consumeMailTransferBytes(over, encoding, over.length)).toThrowError(
			new ImapConnectionError('MAIL_LIMIT')
		);
		expect(over.equals(Buffer.alloc(over.length))).toBe(true);
	});

	it.each([
		['7bit', [0x80]],
		['7bit', [0xff]],
		['7bit', [0]],
		['8bit', [0]],
		['7bit', [65, 10, 66]],
		['8bit', [65, 13, 66]],
		['8bit', [65, 13]],
	])('rejects invalid %s identity bytes %j without partial output', (encoding, values) => {
		const input = Buffer.from(values);
		expect(() => consumeMailTransferBytes(input, encoding, 100)).toThrowError(
			new ImapConnectionError('MAIL_PROTOCOL')
		);
		expect(input.equals(Buffer.alloc(input.length))).toBe(true);
	});

	it.each([
		undefined,
		null,
		0,
		'',
		'binary',
		'gzip',
		' base64',
		'base64 ',
		'báse64',
		'x'.repeat(17),
	])('refuses unsupported encoding %j and consumes input', (encoding) => {
		const input = Buffer.from('synthetic-private');
		expect(() => consumeMailTransferBytes(input, encoding, 100)).toThrowError(
			new ImapConnectionError(typeof encoding === 'string' ? 'MAIL_PROTOCOL' : 'MAIL_INVALID')
		);
		expect(input.equals(Buffer.alloc(input.length))).toBe(true);
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
		8 * 1024 * 1024 + 1,
	])('refuses invalid required cap %j before output allocation', (cap) => {
		const input = Buffer.from('QQ==');
		const from = vi.spyOn(Buffer, 'from');
		const alloc = vi.spyOn(Buffer, 'alloc');
		expect(() => consumeMailTransferBytes(input, 'base64', cap as number)).toThrowError(
			new ImapConnectionError('MAIL_INVALID')
		);
		expect(from).not.toHaveBeenCalled();
		expect(alloc).not.toHaveBeenCalled();
		expect([...input]).toEqual([0, 0, 0, 0]);
	});

	it.each([undefined, null, 'QQ==', new Uint8Array([65])])(
		'refuses non-owned input %j',
		(input) => {
			expect(() => consumeMailTransferBytes(input, 'base64', 100)).toThrowError(
				new ImapConnectionError('MAIL_INVALID')
			);
		}
	);

	it.each([
		['7bit', 'AB'],
		['8bit', 'AB'],
		['base64', 'QUI='],
		['quoted-printable', '=41=42'],
	])('refuses %s decoded overflow before allocation', (encoding, wire) => {
		const input = Buffer.from(wire);
		const from = vi.spyOn(Buffer, 'from');
		const alloc = vi.spyOn(Buffer, 'alloc');
		expect(() => consumeMailTransferBytes(input, encoding, 1)).toThrowError(
			new ImapConnectionError('MAIL_LIMIT')
		);
		expect(from).not.toHaveBeenCalled();
		expect(alloc).not.toHaveBeenCalled();
		expect([...input].every((byte) => byte === 0)).toBe(true);
	});

	it('refuses complete input beyond the framing ceiling before output allocation', () => {
		const input = Buffer.alloc(IMAP_FRAMING_LIMITS.literalBytes + 1, 65);
		const from = vi.spyOn(Buffer, 'from');
		const alloc = vi.spyOn(Buffer, 'alloc');
		expect(() =>
			consumeMailTransferBytes(input, '7bit', MAIL_TRANSFER_LIMITS.decodedBytes)
		).toThrowError(new ImapConnectionError('MAIL_LIMIT'));
		expect(from).not.toHaveBeenCalled();
		expect(alloc).not.toHaveBeenCalled();
		expect(input.every((byte) => byte === 0)).toBe(true);
	});

	it('accepts the maximum decoded identity payload without truncation', () => {
		const input = Buffer.alloc(MAIL_TRANSFER_LIMITS.decodedBytes, 'A\r\nB');
		const output = consumeMailTransferBytes(input, '8bit', MAIL_TRANSFER_LIMITS.decodedBytes);
		try {
			expect(output.length).toBe(MAIL_TRANSFER_LIMITS.decodedBytes);
			expect(output.subarray(0, 4).toString()).toBe('A\r\nB');
			expect(output.subarray(-4).toString()).toBe('A\r\nB');
			expect(input.every((byte) => byte === 0)).toBe(true);
		} finally {
			output.fill(0);
		}
	});
});

describe('strict complete base64 payloads and shared header B decoding', () => {
	it.each([undefined, null, 0, -1, 1.5, NaN, Infinity, MAIL_TRANSFER_LIMITS.decodedBytes + 1])(
		'requires a tighten-only cap in the shared non-consuming core: %j',
		(cap) => {
			expect(() => decodeMailBase64('QQ==', cap as number)).toThrowError(
				new ImapConnectionError('MAIL_INVALID')
			);
		}
	);

	it('rejects excessive encoded input and noncanonical pad bits before allocation', () => {
		const from = vi.spyOn(Buffer, 'from');
		expect(() => decodeMailBase64('QUJDQUJD', 1)).toThrowError(
			new ImapConnectionError('MAIL_LIMIT')
		);
		expect(() => decodeMailBase64('QR==', 1)).toThrowError(
			new ImapConnectionError('MAIL_PROTOCOL')
		);
		expect(from).not.toHaveBeenCalled();
	});

	it.each([
		['', []],
		['AA==', [0]],
		['AAA=', [0, 0]],
		['AAAA', [0, 0, 0]],
		['+/8=', [251, 255]],
	])('decodes canonical %j at the exact byte cap', (wire, expected) => {
		const output = decodeMailBase64(wire, Math.max(1, expected.length));
		try {
			expect([...output]).toEqual(expected);
		} finally {
			output.fill(0);
		}
	});

	it.each(['Q\r\nQ==', 'QQ\r\n==\r\n', 'Q\r\nU\r\nJ\r\nD', 'QUJD\r\n'])(
		'accepts wrap %j',
		(wire) => {
			const input = Buffer.from(wire);
			const output = consumeMailTransferBytes(input, 'base64', 3);
			try {
				expect(output.toString()).toBe(
					wire.startsWith('Q\r\nQ') || wire.startsWith('QQ') ? 'A' : 'ABC'
				);
				expect(input.every((byte) => byte === 0)).toBe(true);
			} finally {
				output.fill(0);
			}
		}
	);

	it.each([
		'Q',
		'QQ',
		'QQ=',
		'====',
		'=AAA',
		'Q===',
		'QQ==AAAA',
		'QQ==QQ==',
		'QR==',
		'QUJ=',
		'QQ-=',
		'QQ_=',
		'Q Q==',
		'QQ==\t',
		'QQ==\n',
		'QQ==\r',
		'\r\nQQ==',
		'QQ==\r\n\r\n',
		'QQ==\rX',
		'QQ==\u0080',
	])('refuses malformed MIME base64 %j and erases input', (wire) => {
		const input = Buffer.from(wire);
		expect(() => consumeMailTransferBytes(input, 'base64', 100)).toThrowError(
			new ImapConnectionError('MAIL_PROTOCOL')
		);
		expect(input.every((byte) => byte === 0)).toBe(true);
	});

	it('enforces the exact encoded line boundary', () => {
		const input = Buffer.from('AAAA'.repeat(19) + '\r\nAA==');
		const output = consumeMailTransferBytes(input, 'base64', 58);
		expect(output.length).toBe(58);
		expect(output.every((byte) => byte === 0)).toBe(true);
		output.fill(0);
		const over = Buffer.from('AAAA'.repeat(20));
		expect(() => consumeMailTransferBytes(over, 'base64', 60)).toThrowError(
			new ImapConnectionError('MAIL_LIMIT')
		);
		expect(over.every((byte) => byte === 0)).toBe(true);
	});

	it.each(['QR==', 'QUJ=', 'QQ==AAAA', 'Q Q=='])(
		'shares strict B validation with actual headers: %s',
		(wire) => {
			const header = Buffer.from(`Subject: =?UTF-8?B?${wire}?=\r\n\r\n`);
			expect(() => consumeMailHeaderDisplay(header)).toThrowError(
				new ImapConnectionError('MAIL_PROTOCOL')
			);
			expect(header.every((byte) => byte === 0)).toBe(true);
		}
	);

	it('preserves actual B/Q charset, adjacent-word and underscore header behavior', () => {
		const input = Buffer.from(
			'Subject: =?UTF-8?B?w6k=?= =?US-ASCII?Q?_A=5F?=\r\nFrom: =?ISO-8859-1?B?6Q==?=\r\n\r\n'
		);
		const result = consumeMailHeaderDisplay(input);
		expect(result).toEqual({ subject: 'é A_', sender: 'é' });
		expect(Object.isFrozen(result)).toBe(true);
		expect(input.every((byte) => byte === 0)).toBe(true);
	});
});

describe('strict quoted-printable lines', () => {
	it.each([
		'=',
		'=4',
		'=GG',
		'=af',
		'=0a',
		'A \r\n',
		'A\t',
		'A ',
		'A\nB',
		'A\rB',
		'=\r\n',
		'A=\r\n',
		'A\u0080',
		'A\0',
	])('refuses malformed %j', (wire) => {
		const input = Buffer.from(wire);
		expect(() => consumeMailTransferBytes(input, 'quoted-printable', 100)).toThrowError(
			new ImapConnectionError('MAIL_PROTOCOL')
		);
		expect(input.every((byte) => byte === 0)).toBe(true);
	});

	it.each(['A'.repeat(76), 'A'.repeat(73) + '=42', 'A'.repeat(75) + '=\r\nB'])(
		'accepts the exact physical-line boundary',
		(wire) => {
			const input = Buffer.from(wire);
			const output = consumeMailTransferBytes(input, 'quoted-printable', 100);
			try {
				expect(output.toString()).toBe(
					wire === 'A'.repeat(76)
						? wire
						: wire.startsWith('A'.repeat(75))
							? 'A'.repeat(75) + 'B'
							: 'A'.repeat(73) + 'B'
				);
				expect(input.every((byte) => byte === 0)).toBe(true);
			} finally {
				output.fill(0);
			}
		}
	);

	it.each(['A'.repeat(77), 'A'.repeat(74) + '=42', 'A'.repeat(76) + '=\r\nB'])(
		'refuses physical-line overflow',
		(wire) => {
			const input = Buffer.from(wire);
			expect(() => consumeMailTransferBytes(input, 'quoted-printable', 100)).toThrowError(
				new ImapConnectionError('MAIL_LIMIT')
			);
			expect(input.every((byte) => byte === 0)).toBe(true);
		}
	);
});

describe('failed allocation ownership and content-free errors', () => {
	it('erases a malformed native base64 allocation before throwing', () => {
		const input = Buffer.from('QQ==');
		const allocation = Buffer.alloc(2, 83);
		vi.spyOn(Buffer, 'from').mockImplementationOnce(() => allocation);
		expect(() => consumeMailTransferBytes(input, 'base64', 1)).toThrowError(
			new ImapConnectionError('MAIL_PROTOCOL')
		);
		expect([...allocation]).toEqual([0, 0]);
		expect([...input]).toEqual([0, 0, 0, 0]);
	});

	it('erases an allocated quoted-printable result when the fill pass fails', () => {
		const input = Buffer.from('AB=43');
		const allocation = Buffer.alloc(3, 83);
		vi.spyOn(Buffer, 'alloc').mockImplementationOnce(() => {
			input[3] = 71; // Allocation seam mutates validated input: second pass must refuse.
			return allocation;
		});
		expect(() => consumeMailTransferBytes(input, 'quoted-printable', 3)).toThrowError(
			new ImapConnectionError('MAIL_PROTOCOL')
		);
		expect([...allocation]).toEqual([0, 0, 0]);
		expect(input.every((byte) => byte === 0)).toBe(true);
	});

	it.each(['base64', 'quoted-printable', '7bit'])(
		'normalizes hostile native allocation errors for %s',
		(encoding) => {
			const input = Buffer.from(encoding === 'base64' ? 'QQ==' : 'A');
			const nativeError = new Error('synthetic-private-content');
			const spy = vi.spyOn(Buffer, encoding === 'quoted-printable' ? 'alloc' : 'from');
			spy.mockImplementationOnce(() => {
				throw nativeError;
			});
			let caught: unknown;
			try {
				consumeMailTransferBytes(input, encoding, 1);
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(ImapConnectionError);
			expect(caught).toMatchObject({
				code: 'MAIL_PROTOCOL',
				message: 'Unsupported or invalid mail response.',
			});
			expect(caught === nativeError).toBe(false);
			expect(caught).not.toHaveProperty('cause');
			expect(String(caught)).not.toContain('synthetic-private-content');
			expect(input.every((byte) => byte === 0)).toBe(true);
		}
	);
});
