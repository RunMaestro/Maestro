import { Buffer } from 'node:buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImapConnectionError } from '../../../../main/plugins/relay-mail/mail-errors';
import {
	consumeMailMimeContent,
	MAIL_MIME_CONTENT_LIMITS,
} from '../../../../main/plugins/relay-mail/mail-mime-content';
import { MAIL_MIME_STRUCTURE_LIMITS } from '../../../../main/plugins/relay-mail/mail-mime-structure';

afterEach(() => vi.restoreAllMocks());

// Wire fixtures only: interpretation always uses the real complete-source consumers.
const version = 'MIME-Version: 1.0\r\n';
const plain = 'Content-Type: text/plain\r\n\r\n';
const binary = 'Content-Type: application/pdf\r\nContent-Transfer-Encoding: base64\r\n\r\n';
const encodedText =
	'Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n';
const named = 'Content-Type: text/plain; name="note.txt"\r\n\r\n';

function container(kind: string, boundary: string, parts: readonly string[]): string {
	return (
		`Content-Type: multipart/${kind}; boundary=${boundary}\r\n\r\n--${boundary}\r\n` +
		parts.join(`\r\n--${boundary}\r\n`) +
		`\r\n--${boundary}--`
	);
}

function encodedSize(size: number): string {
	const bytes = Buffer.alloc(size, 65);
	try {
		return (
			bytes
				.toString('base64')
				.match(/.{1,76}/g)
				?.join('\r\n') ?? ''
		);
	} finally {
		bytes.fill(0);
	}
}

describe('complete MIME body and attachment composition', () => {
	it.each([
		[plain, '', ''],
		[plain, 'A\r\n\t B\r\n', 'A\r\n\t B\r\n'],
		[
			'Content-Type: text/plain; charset=uTf-8\r\nContent-Transfer-Encoding: 8BiT\r\n\r\n',
			'é 🦊',
			'é 🦊',
		],
		[encodedText, 'w6kg8J+mig==', 'é 🦊'],
		[
			'Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n',
			'=C3=A9=20=F0=9F=A6=8A',
			'é 🦊',
		],
	] as const)('returns exact complete literal text and UTF-8 sizes', (header, wire, text) => {
		const input = Buffer.from(version + header + wire);
		const alias = input.subarray(0);
		const result = consumeMailMimeContent(input);
		expect(result).toEqual({
			body: { mimeType: 'text/plain', text, sizeBytes: Buffer.byteLength(text) },
			attachments: [],
		});
		expect(Object.keys(result).sort()).toEqual(['attachments', 'body']);
		expect(Object.isFrozen(result)).toBe(true);
		expect(Object.isFrozen(result.body)).toBe(true);
		expect(Object.isFrozen(result.attachments)).toBe(true);
		expect(alias.every((byte) => byte === 0)).toBe(true);
	});

	it.each([
		[named, 'private-named-text', 'text/plain', 'note.txt', 'private-named-text'],
		[
			'Content-Type: text/plain\r\nContent-Disposition: attachment\r\n\r\n',
			'A',
			'text/plain',
			'attachment',
			'A',
		],
		[binary, 'AP8=', 'application/pdf', 'attachment', '\0ÿ'],
		[
			'Content-Type: image/png\r\nContent-Disposition: inline\r\nContent-Transfer-Encoding: base64\r\n\r\n',
			'AP8=',
			'image/png',
			'attachment',
			'\0ÿ',
		],
		[
			'Content-Type: application/pdf\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n',
			'=00=FF',
			'application/pdf',
			'attachment',
			'\0ÿ',
		],
		[
			'Content-Type: text/plain; charset=UTF-8\r\nContent-Disposition: attachment; filename="empty.txt"\r\n\r\n',
			'',
			'text/plain',
			'empty.txt',
			'',
		],
	] as const)(
		'keeps named/attachment text and binary out of the body',
		(header, wire, mimeType, filename, expected) => {
			const input = Buffer.from(version + header + wire);
			const result = consumeMailMimeContent(input);
			try {
				expect(Object.keys(result)).toEqual(['attachments']);
				expect(result).not.toHaveProperty('body');
				expect(result.attachments).toHaveLength(1);
				const attachment = result.attachments[0];
				expect(Object.keys(attachment).sort()).toEqual([
					'bytes',
					'filename',
					'mimeType',
					'partId',
					'sizeBytes',
				]);
				expect(Object.isFrozen(result)).toBe(true);
				expect(Object.isFrozen(result.attachments)).toBe(true);
				expect(Object.isFrozen(attachment)).toBe(true);
				expect(attachment).toMatchObject({
					partId: '1',
					filename,
					mimeType,
					sizeBytes: Buffer.byteLength(expected, 'latin1'),
				});
				expect(attachment.bytes.toString('latin1')).toBe(expected);
				expect(input.every((byte) => byte === 0)).toBe(true);
				input.fill(88);
				expect(attachment.bytes.toString('latin1')).toBe(expected);
			} finally {
				input.fill(0);
				result.attachments.forEach((attachment) => attachment.bytes.fill(0));
			}
		}
	);

	it('preserves nested physical attachment order and distinct numeric paths/buffers', () => {
		const input = Buffer.from(
			version +
				container('mixed', 'Root', [
					container('mixed', 'Left', [binary + 'QQ==', named + 'A']),
					container('alternative', 'Choice', [plain + 'old', plain + 'last']),
					container('mixed', 'Right', [binary + 'QQ==']),
				])
		);
		const result = consumeMailMimeContent(input);
		try {
			expect(result.body).toEqual({ mimeType: 'text/plain', text: 'last', sizeBytes: 4 });
			expect(result.attachments.map((item) => item.partId)).toEqual(['1.1', '1.2', '3.1']);
			expect(result.attachments.map((item) => item.bytes.toString())).toEqual(['A', 'A', 'A']);
			expect(new Set(result.attachments.map((item) => item.bytes)).size).toBe(3);
			result.attachments[0].bytes.fill(88);
			expect(result.attachments[1].bytes.toString()).toBe('A');
			expect(result.attachments[2].bytes.toString()).toBe('A');
			expect(input.every((byte) => byte === 0)).toBe(true);
		} finally {
			result.attachments.forEach((item) => item.bytes.fill(0));
		}
	});

	it.each(['', 'last'])(
		'selects the last complete alternative, including empty text %j',
		(last) => {
			const input = Buffer.from(
				version +
					container('alternative', 'Root', [
						plain + 'discarded',
						container('alternative', 'Nested', [plain + 'earlier', plain + last]),
					])
			);
			expect(consumeMailMimeContent(input)).toEqual({
				body: { mimeType: 'text/plain', text: last, sizeBytes: last.length },
				attachments: [],
			});
			expect(input.every((byte) => byte === 0)).toBe(true);
		}
	);
});

describe('no fallback, skipped children or independent body joining', () => {
	it.each([
		container('mixed', 'Root', [plain, plain + 'second']),
		container('mixed', 'Root', [container('alternative', 'Choice', [plain]), plain]),
		container('alternative', 'Root', [binary + 'QQ==', plain]),
		container('alternative', 'Root', [plain, named + 'hidden']),
		container('alternative', 'Root', [
			plain,
			container('mixed', 'Nested', [plain, binary + 'QQ==']),
		]),
		container('alternative', 'Root', [encodedText + 'QR==', plain + 'valid']),
		container('alternative', 'Root', [encodedText + 'wA==', plain + 'valid']),
		container('alternative', 'Root', [plain + 'valid', encodedText + 'AA==']),
		container('alternative', 'Root', [plain + 'valid', 'Content-Type: text/html\r\n\r\nHTML']),
		container('mixed', 'Root', [binary + 'QQ==', 'Content-Type: message/rfc822\r\n\r\nmail']),
	])('rejects the whole message without partial success', (wire) => {
		const input = Buffer.from(version + wire);
		expect(() => consumeMailMimeContent(input)).toThrowError(
			new ImapConnectionError('MAIL_PROTOCOL')
		);
		expect(input.every((byte) => byte === 0)).toBe(true);
	});

	it.each([
		plain + 'missing root version',
		version + 'Content-Type: text/plain; charset=ISO-8859-1\r\n\r\nA',
		version + 'Content-Type: application/pdf\r\nContent-Transfer-Encoding: binary\r\n\r\nA',
		version + 'Content-Type: text/plain\n\nA',
		version + container('mixed', 'Root', [plain]).slice(0, -1),
		version + container('mixed', 'Root', [container('mixed', 'RootChild', [plain])]),
	])('retains the real source/header/transfer/charset restrictions', (wire) => {
		const input = Buffer.from(wire);
		expect(() => consumeMailMimeContent(input)).toThrowError(
			new ImapConnectionError('MAIL_PROTOCOL')
		);
		expect(input.every((byte) => byte === 0)).toBe(true);
	});
});

describe('aggregate limits before decoded allocations', () => {
	it.each([0, 1])(
		'pins aggregate body bytes across nested discarded alternatives, excess=%s',
		(excess) => {
			const half = MAIL_MIME_CONTENT_LIMITS.bodyBytes / 2;
			const input = Buffer.from(
				version +
					container('alternative', 'Root', [
						encodedText + encodedSize(half),
						container('alternative', 'Nested', [encodedText + encodedSize(half + excess), plain]),
					])
			);
			const from = vi.spyOn(Buffer, 'from');
			if (excess)
				expect(() => consumeMailMimeContent(input)).toThrowError(
					new ImapConnectionError('MAIL_LIMIT')
				);
			else
				expect(consumeMailMimeContent(input).body).toEqual({
					mimeType: 'text/plain',
					text: '',
					sizeBytes: 0,
				});
			const decoded = from.mock.calls.filter(
				(call) => (call as readonly unknown[])[1] === 'base64'
			);
			expect(decoded).toHaveLength(excess ? 1 : 2);
			expect(input.every((byte) => byte === 0)).toBe(true);
		}
	);

	it.each(['', 'QQ=='])(
		'permits only empty encoded bodies once the body budget is full: %j',
		(tail) => {
			const input = Buffer.from(
				version +
					container('alternative', 'Root', [
						encodedText + encodedSize(MAIL_MIME_CONTENT_LIMITS.bodyBytes),
						encodedText + tail,
					])
			);
			const from = vi.spyOn(Buffer, 'from');
			if (tail)
				expect(() => consumeMailMimeContent(input)).toThrowError(
					new ImapConnectionError('MAIL_LIMIT')
				);
			else expect(consumeMailMimeContent(input).body?.text).toBe('');
			expect(
				from.mock.calls.filter((call) => (call as readonly unknown[])[1] === 'base64')
			).toHaveLength(tail ? 1 : 2);
			expect(input.every((byte) => byte === 0)).toBe(true);
		}
	);

	it.each([0, 1])('pins the 16 attachment count, including empty leaves, excess=%s', (excess) => {
		const input = Buffer.from(
			version +
				container(
					'mixed',
					'Root',
					Array.from({ length: MAIL_MIME_CONTENT_LIMITS.attachments + excess }, () => binary)
				)
		);
		const from = vi.spyOn(Buffer, 'from');
		if (excess)
			expect(() => consumeMailMimeContent(input)).toThrowError(
				new ImapConnectionError('MAIL_LIMIT')
			);
		else {
			const result = consumeMailMimeContent(input);
			expect(result.attachments).toHaveLength(16);
			expect(result).not.toHaveProperty('body');
			result.attachments.forEach((item) => {
				expect(item.sizeBytes).toBe(0);
				item.bytes.fill(0);
			});
		}
		expect(
			from.mock.calls.filter((call) => (call as readonly unknown[])[1] === 'base64')
		).toHaveLength(16);
		expect(input.every((byte) => byte === 0)).toBe(true);
	});

	it.each([0, 1])('pins the exact per-attachment decoded 8 MiB ceiling, excess=%s', (excess) => {
		const input = Buffer.from(
			version + binary + encodedSize(MAIL_MIME_CONTENT_LIMITS.attachmentBytes + excess)
		);
		const from = vi.spyOn(Buffer, 'from');
		if (excess)
			expect(() => consumeMailMimeContent(input)).toThrowError(
				new ImapConnectionError('MAIL_LIMIT')
			);
		else {
			const result = consumeMailMimeContent(input);
			try {
				expect(result.attachments[0].sizeBytes).toBe(MAIL_MIME_CONTENT_LIMITS.attachmentBytes);
				expect(result.attachments[0].bytes.length).toBe(MAIL_MIME_CONTENT_LIMITS.attachmentBytes);
				expect(result.attachments[0].bytes.every((byte) => byte === 65)).toBe(true);
			} finally {
				result.attachments.forEach((item) => item.bytes.fill(0));
			}
		}
		expect(
			from.mock.calls.filter((call) => (call as readonly unknown[])[1] === 'base64')
		).toHaveLength(excess ? 0 : 1);
		expect(input.every((byte) => byte === 0)).toBe(true);
	});

	it.each(['', 'QQ=='])(
		'pins exact aggregate 16 MiB and empty leaves after exhaustion: %j',
		(tail) => {
			const full = binary + encodedSize(MAIL_MIME_CONTENT_LIMITS.attachmentBytes);
			const input = Buffer.from(
				version + container('mixed', 'Root', [full, full, binary + tail, plain])
			);
			expect(input.length).toBeLessThan(MAIL_MIME_STRUCTURE_LIMITS.sourceBytes);
			const from = vi.spyOn(Buffer, 'from');
			if (tail)
				expect(() => consumeMailMimeContent(input)).toThrowError(
					new ImapConnectionError('MAIL_LIMIT')
				);
			else {
				const result = consumeMailMimeContent(input);
				try {
					expect(result.attachments.map((item) => item.sizeBytes)).toEqual([
						MAIL_MIME_CONTENT_LIMITS.attachmentBytes,
						MAIL_MIME_CONTENT_LIMITS.attachmentBytes,
						0,
					]);
					expect(result.attachments.reduce((sum, item) => sum + item.sizeBytes, 0)).toBe(
						MAIL_MIME_CONTENT_LIMITS.attachmentAggregateBytes
					);
					expect(result.body?.text).toBe('');
				} finally {
					result.attachments.forEach((item) => item.bytes.fill(0));
				}
			}
			expect(
				from.mock.calls.filter((call) => (call as readonly unknown[])[1] === 'base64')
			).toHaveLength(tail ? 2 : 3);
			for (const result of from.mock.results)
				if (result.type === 'return')
					expect((result.value as Buffer).every((byte) => byte === 0)).toBe(true);
			expect(input.every((byte) => byte === 0)).toBe(true);
		}
	);

	it.each(['source', 'depth', 'leaves', 'line'])(
		'retains structural/raw limits before content outputs: %s',
		(mode) => {
			let wire = version + plain + 'A'.repeat(999);
			if (mode === 'source') wire = 'A'.repeat(MAIL_MIME_STRUCTURE_LIMITS.sourceBytes + 1);
			if (mode === 'depth') {
				wire = plain;
				for (let i = 0; i < MAIL_MIME_STRUCTURE_LIMITS.depth; i++)
					wire = container('mixed', `B${i}z`, [wire]);
				wire = version + wire;
			}
			if (mode === 'leaves')
				wire =
					version +
					container(
						'mixed',
						'Root',
						Array.from({ length: MAIL_MIME_STRUCTURE_LIMITS.leaves + 1 }, () => plain)
					);
			const input = Buffer.from(wire);
			const from = vi.spyOn(Buffer, 'from');
			const alloc = vi.spyOn(Buffer, 'alloc');
			expect(() => consumeMailMimeContent(input)).toThrowError(
				new ImapConnectionError('MAIL_LIMIT')
			);
			if (mode !== 'line') expect(alloc).not.toHaveBeenCalled();
			expect(from.mock.calls.some((call) => (call as readonly unknown[])[1] === 'base64')).toBe(
				false
			);
			expect(input.every((byte) => byte === 0)).toBe(true);
		}
	);
});

describe('owned intermediate cleanup and content-free errors', () => {
	it.each([false, true])(
		'erases all actual encoded/header/body copies, with late rejection=%s',
		(reject) => {
			const input = Buffer.from(
				version +
					container('mixed', 'Root', [
						binary + 'QQ==',
						plain + 'body',
						...(reject ? [encodedText + 'wA=='] : []),
					])
			);
			const from = vi.spyOn(Buffer, 'from');
			const alloc = vi.spyOn(Buffer, 'alloc');
			if (reject)
				expect(() => consumeMailMimeContent(input)).toThrowError(
					new ImapConnectionError('MAIL_PROTOCOL')
				);
			else {
				const result = consumeMailMimeContent(input);
				try {
					expect(result.body?.text).toBe('body');
					expect(result.attachments[0].bytes.toString()).toBe('A');
					for (const entry of from.mock.results)
						if (entry.type === 'return' && entry.value !== result.attachments[0].bytes)
							expect((entry.value as Buffer).every((byte) => byte === 0)).toBe(true);
				} finally {
					result.attachments.forEach((item) => item.bytes.fill(0));
				}
			}
			for (const spy of [from, alloc])
				for (const entry of spy.mock.results)
					if (entry.type === 'return')
						expect((entry.value as Buffer).every((byte) => byte === 0)).toBe(true);
			expect(alloc).toHaveBeenCalledTimes(reject ? 3 : 2);
			expect(input.every((byte) => byte === 0)).toBe(true);
		}
	);

	it.each(['protocol', 'limit', 'allocation', 'fill'])(
		'erases prior and failed attachment outputs after later %s failure',
		(mode) => {
			const later =
				mode === 'protocol'
					? encodedText + 'QR=='
					: mode === 'limit'
						? binary + encodedSize(MAIL_MIME_CONTENT_LIMITS.attachmentBytes + 1)
						: 'Content-Type: application/pdf\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n=42';
			const input = Buffer.from(version + container('mixed', 'Root', [binary + 'QQ==', later]));
			const allocations = [
				Buffer.alloc(4),
				Buffer.alloc(later.slice(later.indexOf('\r\n\r\n') + 4).length),
				Buffer.alloc(1, 83),
			];
			const from = vi.spyOn(Buffer, 'from');
			if (mode === 'allocation' || mode === 'fill') {
				const alloc = vi
					.spyOn(Buffer, 'alloc')
					.mockImplementationOnce(() => allocations[0])
					.mockImplementationOnce(() => allocations[1]);
				alloc.mockImplementationOnce(() => {
					if (mode === 'allocation') throw new Error('synthetic-private-native-detail');
					allocations[1][2] = 71; // Mutate only the real encoded leaf at the allocation seam.
					return allocations[2];
				});
			}
			let failure: unknown;
			try {
				consumeMailMimeContent(input);
			} catch (error) {
				failure = error;
			}
			expect(failure).toBeInstanceOf(ImapConnectionError);
			expect(failure).toMatchObject({ code: mode === 'limit' ? 'MAIL_LIMIT' : 'MAIL_PROTOCOL' });
			expect(failure).not.toHaveProperty('cause');
			expect(String(failure)).not.toContain('synthetic-private');
			for (const result of from.mock.results)
				if (result.type === 'return')
					expect((result.value as Buffer).every((byte) => byte === 0)).toBe(true);
			if (mode === 'allocation' || mode === 'fill')
				for (const buffer of allocations.slice(0, mode === 'fill' ? 3 : 2))
					expect(buffer.every((byte) => byte === 0)).toBe(true);
			expect(input.every((byte) => byte === 0)).toBe(true);
			allocations.forEach((buffer) => buffer.fill(0));
		}
	);

	it.each([undefined, null, {}, 'source', new Uint8Array([65])])(
		'refuses non-owned source %j with a fixed error',
		(input) => {
			expect(() => consumeMailMimeContent(input)).toThrowError(
				new ImapConnectionError('MAIL_INVALID')
			);
		}
	);
});
