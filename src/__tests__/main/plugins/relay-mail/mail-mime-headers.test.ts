import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { ImapConnectionError } from '../../../../main/plugins/relay-mail/mail-errors';
import { IMAP_COMMAND_LIMITS } from '../../../../main/plugins/relay-mail/mail-imap-commands';
import { MAIL_HEADER_FIELD_LIMITS } from '../../../../main/plugins/relay-mail/mail-header-fields';
import { consumeMailHeaderDisplay } from '../../../../main/plugins/relay-mail/mail-header-projection';
import {
	consumeMailMimeHeaders,
	MAIL_MIME_HEADER_LIMITS,
} from '../../../../main/plugins/relay-mail/mail-mime-headers';

describe('closed owned MIME header descriptors', () => {
	it.each(['Subject', 'subject', 'sUbJeCt'])(
		'projects protected display field %s case-insensitively',
		(name) => {
			const input = Buffer.from(`${name}: Untrusted fixture\r\nfRoM: fixture@example.test\r\n\r\n`);
			expect(consumeMailHeaderDisplay(input)).toEqual({
				subject: 'Untrusted fixture',
				sender: 'fixture@example.test',
			});
			expect(input.every((byte) => byte === 0)).toBe(true);
		}
	);

	it.each(['Subject', 'subject', 'sUbJeCt', 'From', 'from', 'fRoM'])(
		'rejects duplicate protected display header regardless of case: %s',
		(name) => {
			const input = Buffer.from(`${name}: first\r\n${name.toUpperCase()}: second\r\n\r\n`);
			expect(() => consumeMailHeaderDisplay(input)).toThrowError(
				new ImapConnectionError('MAIL_PROTOCOL')
			);
			expect(input.every((byte) => byte === 0)).toBe(true);
		}
	);
	it.each([
		['text/plain', { mimeType: 'text/plain', transferEncoding: '7bit', charset: 'US-ASCII' }],
		...['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp'].map(
			(mimeType) => [mimeType, { mimeType, transferEncoding: '7bit' }] as const
		),
	] as const)(
		'requires and projects supported leaf %s without inferred content',
		(mimeType, expected) => {
			const input = Buffer.from(`Content-Type: ${mimeType}\r\n\r\n`);
			const alias = input.subarray(0);
			const result = consumeMailMimeHeaders(input);
			expect(result).toEqual(expected);
			expect(Object.keys(result).sort()).toEqual(Object.keys(expected).sort());
			expect(Object.isFrozen(result)).toBe(true);
			expect(alias.every((byte) => byte === 0)).toBe(true);
			alias.fill(88);
			expect(result).toEqual(expected);
			alias.fill(0);
		}
	);

	it.each(['mixed', 'alternative'])(
		'preserves exact multipart/%s boundary without children',
		(kind) => {
			const input = Buffer.from(
				`MIME-Version: 1.0\r\nContent-Type: MULTIPART/${kind}; BOUNDARY="Ab c:=?"\r\nContent-Transfer-Encoding: 8BIT\r\n\r\n`
			);
			const result = consumeMailMimeHeaders(input, true);
			expect(result).toEqual({
				mimeType: `multipart/${kind}`,
				transferEncoding: '8bit',
				boundary: 'Ab c:=?',
			});
			expect(Object.isFrozen(result)).toBe(true);
			expect(input.every((byte) => byte === 0)).toBe(true);
		}
	);

	it.each(['7bit', '8BIT', 'BaSe64', 'QUOTED-PRINTABLE'])(
		'normalizes only exact transfer token %s with surrounding whitespace',
		(encoding) => {
			const input = Buffer.from(
				`Content-Type: TEXT/PLAIN; CHARSET="uTf-8"\r\nContent-Transfer-Encoding:\t ${encoding} \t\r\n\r\n`
			);
			expect(consumeMailMimeHeaders(input)).toEqual({
				mimeType: 'text/plain',
				charset: 'UTF-8',
				transferEncoding: encoding.toLowerCase(),
			});
			expect(input.every((byte) => byte === 0)).toBe(true);
		}
	);

	it.each(['inline', 'ATTACHMENT'])(
		'preserves an untrusted exact matching filename and %s disposition',
		(disposition) => {
			const input = Buffer.from(
				`Content-Type: image/png; name = "Report 1.png"\r\nContent-Disposition: ${disposition}; FILENAME="Report 1.png"\r\n\r\n`
			);
			expect(consumeMailMimeHeaders(input)).toEqual({
				mimeType: 'image/png',
				transferEncoding: '7bit',
				disposition: disposition.toLowerCase(),
				filename: 'Report 1.png',
			});
			expect(input.every((byte) => byte === 0)).toBe(true);
		}
	);

	it.each([
		[
			'Content-Type: text/plain; charset=us-ascii; name=file.txt',
			{
				mimeType: 'text/plain',
				charset: 'US-ASCII',
				transferEncoding: '7bit',
				filename: 'file.txt',
			},
		],
		[
			'Content-Type: application/pdf\r\nContent-Disposition: attachment',
			{ mimeType: 'application/pdf', transferEncoding: '7bit', disposition: 'attachment' },
		],
		[
			'Content-Type: image/jpeg\r\nContent-Disposition: inline; filename=a.jpg',
			{
				mimeType: 'image/jpeg',
				transferEncoding: '7bit',
				disposition: 'inline',
				filename: 'a.jpg',
			},
		],
		['Content-Type: multipart/mixed; boundary="a\\\"b"', undefined],
	] as const)(
		'handles optional leaf labels without deriving body/attachment DTOs: %s',
		(wire, expected) => {
			const input = Buffer.from(wire + '\r\n\r\n');
			if (expected === undefined) {
				expect(() => consumeMailMimeHeaders(input)).toThrowError(
					new ImapConnectionError('MAIL_PROTOCOL')
				);
			} else {
				expect(consumeMailMimeHeaders(input)).toEqual(expected);
			}
			expect(input.every((byte) => byte === 0)).toBe(true);
		}
	);

	it('unfolds selected fields and validates/discards repeated ordinary headers', () => {
		const input = Buffer.from(
			'Received: synthetic-one\r\nreceived: synthetic-two\r\nSubject: ordinary\r\n\tcontinued\r\nX-Untrusted: value\r\nmime-version:\t1.0 \t\r\ncontent-type: text/plain;\r\n\tcharset = "UTF-8";\r\n name = "A B.txt"\r\n\r\n'
		);
		expect(consumeMailMimeHeaders(input, true)).toEqual({
			mimeType: 'text/plain',
			transferEncoding: '7bit',
			charset: 'UTF-8',
			filename: 'A B.txt',
		});
		expect(input.every((byte) => byte === 0)).toBe(true);
	});

	it.each([false, true])('accepts explicit root version under required=%s', (required) => {
		const input = Buffer.from('MIME-Version:\t1.0 \t\r\nContent-Type: text/plain\r\n\r\n');
		expect(consumeMailMimeHeaders(input, required).charset).toBe('US-ASCII');
		expect(input.every((byte) => byte === 0)).toBe(true);
	});

	it('requires root MIME-Version without applying that requirement to part defaults', () => {
		const input = Buffer.from('Content-Type: text/plain\r\n\r\n');
		expect(() => consumeMailMimeHeaders(input, true)).toThrowError(
			new ImapConnectionError('MAIL_PROTOCOL')
		);
		expect(input.every((byte) => byte === 0)).toBe(true);
	});
});

describe('strict MIME grammar without repair or partial success', () => {
	it.each([
		'MIME-Version: 1.0',
		'Content-Type:',
		'Content-Type: text/html',
		'Content-Type: message/rfc822',
		'Content-Type: application/octet-stream',
		'Content-Type: text /plain',
		'Content-Type: text/ plain',
		'Content-Type: text/plain (comment)',
		'Content-Type: text/plain; charset=UTF8',
		'Content-Type: text/plain; charset=latin1',
		'Content-Type: text/plain; charset=" UTF-8"',
		'Content-Type: text/plain; charset="UTF-8 "',
		'Content-Type: text/plain; charset=ISO-8859-1',
		'Content-Type: text/plain; charset=UTF-8; CHARSET=US-ASCII',
		'Content-Type: text/plain; boundary=a',
		'Content-Type: image/png; charset=UTF-8',
		'Content-Type: multipart/mixed',
		'Content-Type: multipart/mixed; boundary=""',
		'Content-Type: multipart/mixed; boundary=a; name=x',
		'Content-Type: multipart/mixed; boundary=a; BOUNDARY=b',
		'Content-Type: multipart/mixed; boundary="a "',
		'Content-Type: multipart/mixed; boundary="a@b"',
		'Content-Type: multipart/mixed; boundary=a\r\nContent-Transfer-Encoding: base64',
		'Content-Type: multipart/alternative; boundary=a\r\nContent-Transfer-Encoding: quoted-printable',
		'Content-Type: multipart/mixed; boundary=a\r\nContent-Disposition: inline',
		'Content-Type: text/plain; name=',
		'Content-Type: text/plain; name=""',
		'Content-Type: text/plain; name="unterminated',
		'Content-Type: text/plain; name="x"trailing',
		'Content-Type: text/plain; name="a\\qb"',
		'Content-Type: text/plain; name="a\tb"',
		'Content-Type: text/plain; name=a;',
		'Content-Type: text/plain; name a',
		'Content-Type: text/plain; =a',
		"Content-Type: text/plain; name*=UTF-8''a",
		'Content-Type: text/plain; name*0=a',
		'Content-Type: text/plain; name*0*=a',
		'Content-Type: text/plain; unknown=a',
		'Content-Type: text/plain; name=a; NAME=a',
		'Content-Type: image/png; name=a\r\nContent-Disposition: attachment; filename=A',
		'Content-Type: image/png\r\nContent-Disposition: form-data',
		'Content-Type: image/png\r\nContent-Disposition: attachment; size=1',
		'Content-Type: image/png\r\nContent-Disposition: attachment; filename=a; FILENAME=a',
		'Content-Type: image/png\r\nContent-Disposition: attachment; filename*=a',
		'Content-Type: text/plain\r\nMIME-Version:',
		'Content-Type: text/plain\r\nMIME-Version: 1.1',
		'Content-Type: text/plain\r\nMIME-Version: 1.0 (comment)',
		...['', 'binary', 'gzip', 'base 64', 'base64; x=a', '7bit (comment)'].map(
			(encoding) => `Content-Type: text/plain\r\nContent-Transfer-Encoding: ${encoding}`
		),
		...[
			'MIME-Version: 1.0\r\nmime-version: 1.0',
			'Content-Type: text/plain',
			'Content-Transfer-Encoding: 7bit\r\ncontent-transfer-encoding: 8bit',
			'Content-Disposition: inline\r\ncontent-disposition: inline',
			'Content-ID: x',
			'Content-Description: x',
			'content-location: x',
			'Content-X-Unknown: x',
		].map((fields) => `Content-Type: text/plain\r\n${fields}`),
	])('refuses ambiguous/unsupported grammar %s and consumes all aliases', (wire) => {
		const input = Buffer.from(wire + '\r\n\r\n');
		const alias = input.subarray(0);
		expect(() => consumeMailMimeHeaders(input)).toThrowError(
			new ImapConnectionError('MAIL_PROTOCOL')
		);
		expect(alias.every((byte) => byte === 0)).toBe(true);
	});

	it.each([
		'.',
		'..',
		'a.',
		' a',
		'a ',
		'a/b',
		'a:b',
		'a<b',
		'a>b',
		'a|b',
		'a?b',
		'a*b',
		'=?UTF-8?B?QQ==?=',
		'a\\\\b',
		'a\\"b',
	])('rejects unsafe untrusted filename %s in either label source', (filename) => {
		for (const header of [
			`Content-Type: image/png; name="${filename}"`,
			`Content-Type: image/png\r\nContent-Disposition: attachment; filename="${filename}"`,
		]) {
			const input = Buffer.from(header + '\r\n\r\n');
			expect(() => consumeMailMimeHeaders(input)).toThrowError(
				new ImapConnectionError('MAIL_PROTOCOL')
			);
			expect(input.every((byte) => byte === 0)).toBe(true);
		}
	});

	it.each([0, 1])('enforces exact filename and boundary caps, excess=%s', (excess) => {
		for (const [header, expected] of [
			[
				`Content-Type: image/png; name="${'A'.repeat(MAIL_MIME_HEADER_LIMITS.filenameBytes + excess)}"`,
				{ mimeType: 'image/png', transferEncoding: '7bit', filename: 'A'.repeat(128) },
			],
			[
				`Content-Type: image/png\r\nContent-Disposition: attachment; filename="${'A'.repeat(MAIL_MIME_HEADER_LIMITS.filenameBytes + excess)}"`,
				{
					mimeType: 'image/png',
					transferEncoding: '7bit',
					disposition: 'attachment',
					filename: 'A'.repeat(128),
				},
			],
			[
				`Content-Type: multipart/mixed; boundary="${'B'.repeat(MAIL_MIME_HEADER_LIMITS.boundaryBytes + excess)}"`,
				{ mimeType: 'multipart/mixed', transferEncoding: '7bit', boundary: 'B'.repeat(70) },
			],
		] as const) {
			const input = Buffer.from(header + '\r\n\r\n');
			if (excess)
				expect(() => consumeMailMimeHeaders(input)).toThrowError(
					new ImapConnectionError('MAIL_LIMIT')
				);
			else expect(consumeMailMimeHeaders(input)).toEqual(expected);
			expect(input.every((byte) => byte === 0)).toBe(true);
		}
	});

	it('bounds parameter scanning before semantic allowlist interpretation', () => {
		// Three parsed parameters still reject an unknown name; a fourth exceeds the scanner cap.
		for (const [suffix, code] of [
			['; unknown=x', 'MAIL_PROTOCOL'],
			['; unknown=x; fourth=y', 'MAIL_LIMIT'],
		] as const) {
			const input = Buffer.from(`Content-Type: text/plain; charset=UTF-8; name=a${suffix}\r\n\r\n`);
			expect(() => consumeMailMimeHeaders(input)).toThrowError(new ImapConnectionError(code));
			expect(input.every((byte) => byte === 0)).toBe(true);
		}
	});
});

describe('complete bounded header framing and ownership', () => {
	it.each([
		'',
		'\r\n',
		'X-Unrequested: text/plain',
		'Content-Type: text/plain\r\n',
		'Content-Type: text/plain\n\n',
		'Content-Type: text/plain\r\r\n',
		'Content-Type: text/plain\r\n\r\nbody',
		'Content-Type: text/plain\r\n\r\n\r\n',
		' orphan\r\nContent-Type: text/plain\r\n\r\n',
		': empty-name\r\nContent-Type: text/plain\r\n\r\n',
		'Bad Name: x\r\nContent-Type: text/plain\r\n\r\n',
		'NoColon\r\nContent-Type: text/plain\r\n\r\n',
	])('refuses malformed/truncated or body-suffixed complete block %j', (wire) => {
		const input = Buffer.from(wire);
		expect(() => consumeMailMimeHeaders(input)).toThrowError(
			new ImapConnectionError('MAIL_PROTOCOL')
		);
		expect(input.every((byte) => byte === 0)).toBe(true);
	});

	it.each([0, 1, 8, 10, 11, 13, 31, 127, 128, 255])('validates discarded field byte %s', (byte) => {
		const input = Buffer.concat([
			Buffer.from('X: '),
			Buffer.from([byte]),
			Buffer.from('\r\nContent-Type: text/plain\r\n\r\n'),
		]);
		expect(() => consumeMailMimeHeaders(input)).toThrowError(
			new ImapConnectionError('MAIL_PROTOCOL')
		);
		expect(input.every((value) => value === 0)).toBe(true);
	});

	it.each([undefined, null, 'Content-Type: text/plain\r\n\r\n', new Uint8Array([65])])(
		'requires owned Buffer input %j',
		(input) => {
			expect(() => consumeMailMimeHeaders(input)).toThrowError(
				new ImapConnectionError('MAIL_INVALID')
			);
		}
	);

	it.each([null, 0, 1, 'true', {}, []])(
		'rejects malformed root-version flag %j and still erases owned bytes',
		(flag) => {
			const input = Buffer.from('Content-Type: text/plain\r\n\r\n');
			expect(() => consumeMailMimeHeaders(input, flag as unknown as boolean)).toThrowError(
				new ImapConnectionError('MAIL_INVALID')
			);
			expect(input.every((byte) => byte === 0)).toBe(true);
		}
	);

	it.each([0, 1])(
		'enforces exact physical line/count/unfolded limits on discarded fields, excess=%s',
		(excess) => {
			const prefix = 'Content-Type: text/plain\r\n';
			for (const wire of [
				prefix + 'X:' + 'A'.repeat(MAIL_HEADER_FIELD_LIMITS.lineBytes - 2 + excess) + '\r\n\r\n',
				prefix + 'X: a\r\n'.repeat(MAIL_HEADER_FIELD_LIMITS.lines - 2 + excess) + '\r\n',
				prefix +
					'X:' +
					'A'.repeat(992) +
					'\r\n' +
					(' ' + 'B'.repeat(899) + '\r\n').repeat(7) +
					' ' +
					'B'.repeat(899 + excess) +
					'\r\n\r\n',
			]) {
				const input = Buffer.from(wire);
				if (excess)
					expect(() => consumeMailMimeHeaders(input)).toThrowError(
						new ImapConnectionError('MAIL_LIMIT')
					);
				else
					expect(consumeMailMimeHeaders(input)).toEqual({
						mimeType: 'text/plain',
						transferEncoding: '7bit',
						charset: 'US-ASCII',
					});
				expect(input.every((byte) => byte === 0)).toBe(true);
			}
		}
	);

	it.each([0, 1])('bounds the whole header block at exactly 64 KiB, excess=%s', (excess) => {
		const prefix = 'Content-Type: text/plain\r\n';
		const remaining = IMAP_COMMAND_LIMITS.headerBytes + excess - prefix.length - 2;
		const rows = Math.floor(remaining / 1000);
		const tail = remaining % 1000;
		const input = Buffer.from(
			prefix +
				('X:' + 'A'.repeat(996) + '\r\n').repeat(rows) +
				'X:' +
				'B'.repeat(tail - 4) +
				'\r\n\r\n'
		);
		expect(input.length).toBe(IMAP_COMMAND_LIMITS.headerBytes + excess);
		if (excess)
			expect(() => consumeMailMimeHeaders(input)).toThrowError(
				new ImapConnectionError('MAIL_LIMIT')
			);
		else expect(consumeMailMimeHeaders(input).charset).toBe('US-ASCII');
		expect(input.every((byte) => byte === 0)).toBe(true);
	});

	it('normalizes hostile Buffer method errors without exposing private content or native causes', () => {
		const input = Buffer.from('Content-Type: text/plain\r\n\r\n');
		const alias = input.subarray(0);
		Object.defineProperty(input, 'indexOf', {
			value: () => {
				throw new Error('synthetic-private-native-message');
			},
		});
		let failure: unknown;
		try {
			consumeMailMimeHeaders(input);
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(ImapConnectionError);
		expect((failure as ImapConnectionError).code).toBe('MAIL_PROTOCOL');
		expect((failure as Error).message).toBe('Unsupported or invalid mail response.');
		expect(Object.hasOwn(failure as object, 'cause')).toBe(false);
		expect(JSON.stringify(failure)).not.toContain('synthetic-private');
		expect(alias.every((byte) => byte === 0)).toBe(true);
	});
});

describe('actual display projection regressions through the canonical scanner', () => {
	it('preserves folded RFC 2047 display and never forwards ordinary/MIME fields', () => {
		const input = Buffer.from(
			'Subject: =?UTF-8?B?Q2Fmw6k=?=\r\n\t=?US-ASCII?Q?_report?=\r\nFrom: Sender\r\n\r\n'
		);
		expect(consumeMailHeaderDisplay(input)).toEqual({ subject: 'Café report', sender: 'Sender' });
		expect(input.every((byte) => byte === 0)).toBe(true);
	});

	it.each(['X-Unrequested: text/plain', 'X-Unknown: x', 'Subject: two', ' orphan'])(
		'retains the closed display allowlist/duplicate/framing refusal: %s',
		(field) => {
			const wire = field === ' orphan' ? field + '\r\nSubject: one' : 'Subject: one\r\n' + field;
			const input = Buffer.from(wire + '\r\n\r\n');
			expect(() => consumeMailHeaderDisplay(input)).toThrowError(
				new ImapConnectionError('MAIL_PROTOCOL')
			);
			expect(input.every((byte) => byte === 0)).toBe(true);
		}
	);
});
