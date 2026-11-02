import { Buffer } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImapConnectionError } from '../../../../main/plugins/relay-mail/mail-errors';
import { IMAP_COMMAND_LIMITS } from '../../../../main/plugins/relay-mail/mail-imap-commands';
import {
	consumeMailMimeSource,
	MAIL_MIME_STRUCTURE_LIMITS,
	type MailMimePart,
} from '../../../../main/plugins/relay-mail/mail-mime-structure';

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

// Fixtures describe wire bytes only; all interpretation uses the real parser.
const rootVersion = 'MIME-Version: 1.0\r\n';
const plainHeader = 'Content-Type: text/plain\r\n\r\n';

function multipart(boundary: string, children: readonly string[], kind = 'mixed'): string {
	return (
		`Content-Type: multipart/${kind}; boundary="${boundary}"\r\n\r\n` +
		children.map((child) => `--${boundary}\r\n${child}\r\n`).join('') +
		`--${boundary}--`
	);
}

function paddedHeader(size: number, root = false): string {
	const prefix = (root ? rootVersion : '') + 'Content-Type: text/plain\r\n';
	const padding = size - prefix.length - 2;
	let rows = Math.floor(padding / 1000);
	if (padding % 1000 < 4) rows--;
	const tail = padding - rows * 1000;
	return (
		prefix +
		('X:' + 'A'.repeat(996) + '\r\n').repeat(rows) +
		'X:' +
		'B'.repeat(tail - 4) +
		'\r\n\r\n'
	);
}

// Inspect closed immutable shells; callers erase the returned owned leaves.
function inspectTree(part: MailMimePart): Buffer[] {
	expect(Object.isFrozen(part)).toBe(true);
	expect(Object.isFrozen(part.headers)).toBe(true);
	if (part.kind === 'leaf') {
		expect(Object.keys(part).sort()).toEqual(['encodedBytes', 'headers', 'kind']);
		return [part.encodedBytes];
	}
	expect(Object.keys(part).sort()).toEqual(['children', 'headers', 'kind']);
	expect(Object.isFrozen(part.children)).toBe(true);
	return part.children.flatMap(inspectTree);
}

describe('complete owned MIME trees', () => {
	it.each(['', 'A', 'A\r\n', 'A\r\n\r\n', 'A\nB\rC\0'])(
		'preserves opaque root leaf bytes %j without transfer or charset interpretation',
		(body) => {
			const input = Buffer.from(rootVersion + plainHeader + body);
			const alias = input.subarray(0);
			const output = consumeMailMimeSource(input);
			const leaves = inspectTree(output);
			try {
				expect(output.headers).toEqual({
					mimeType: 'text/plain',
					transferEncoding: '7bit',
					charset: 'US-ASCII',
				});
				expect(leaves).toHaveLength(1);
				expect(leaves[0].toString()).toBe(body);
				expect(leaves[0] === input).toBe(false);
				expect(alias.every((byte) => byte === 0)).toBe(true);
				alias.fill(88);
				expect(leaves[0].toString()).toBe(body);
			} finally {
				input.fill(0);
				leaves.forEach((leaf) => leaf.fill(0));
			}
		}
	);

	it.each(['', '\r\n'])('accepts a complete final close followed by %j', (ending) => {
		const input = Buffer.from(
			rootVersion + multipart('Root', [plainHeader, plainHeader + 'A\r\n']) + ending
		);
		const output = consumeMailMimeSource(input);
		const leaves = inspectTree(output);
		try {
			expect(output.headers.mimeType).toBe('multipart/mixed');
			expect(leaves.map((leaf) => leaf.toString())).toEqual(['', 'A\r\n']);
			expect(input.every((byte) => byte === 0)).toBe(true);
		} finally {
			leaves.forEach((leaf) => leaf.fill(0));
		}
	});

	it('retains ordered mixed/alternative children and independent labeled encoded leaves', () => {
		const input = Buffer.from(
			rootVersion +
				multipart('Outer', [
					multipart('Inner', [plainHeader + 'first', plainHeader + 'second'], 'alternative'),
					'Content-Type: image/png; name="a.png"\r\nContent-Disposition: attachment; filename="a.png"\r\nContent-Transfer-Encoding: base64\r\n\r\nnot-base64',
					'Content-Type: application/pdf\r\nContent-Transfer-Encoding: 8bit\r\n\r\n\0\xff',
				]),
			'latin1'
		);
		const output = consumeMailMimeSource(input);
		const leaves = inspectTree(output);
		try {
			expect(output.kind).toBe('multipart');
			if (output.kind !== 'multipart') throw new Error('Expected test container');
			expect(output.children[0].headers.mimeType).toBe('multipart/alternative');
			expect(output.children[1].headers).toEqual({
				mimeType: 'image/png',
				transferEncoding: 'base64',
				disposition: 'attachment',
				filename: 'a.png',
			});
			expect(leaves.map((leaf) => leaf.toString('latin1'))).toEqual([
				'first',
				'second',
				'not-base64',
				'\0\xff',
			]);
			expect(new Set(leaves).size).toBe(4);
			leaves[0].fill(88);
			expect(leaves[1].toString()).toBe('second');
			expect(input.every((byte) => byte === 0)).toBe(true);
		} finally {
			leaves.forEach((leaf) => leaf.fill(0));
		}
	});

	it('recognizes only line-start delimiters and preserves exact delimiter-owned CRLF', () => {
		const body = 'A--Root\r\n--Other\r\nB\r\n';
		const input = Buffer.from(rootVersion + multipart('Root', [plainHeader + body]));
		const leaves = inspectTree(consumeMailMimeSource(input));
		try {
			expect(leaves[0].toString()).toBe(body);
		} finally {
			leaves.forEach((leaf) => leaf.fill(0));
		}
	});

	it.each(['a', 'Ab c:=?', 'B'.repeat(70)])('preserves exact supported boundary %s', (boundary) => {
		const input = Buffer.from(rootVersion + multipart(boundary, [plainHeader + 'A']));
		const output = consumeMailMimeSource(input);
		const leaves = inspectTree(output);
		try {
			expect(output.headers.boundary).toBe(boundary);
			expect(leaves[0].toString()).toBe('A');
			expect(input.every((byte) => byte === 0)).toBe(true);
		} finally {
			leaves.forEach((leaf) => leaf.fill(0));
		}
	});
});

describe('no repair, skipped parts or partial trees', () => {
	it.each([
		'',
		'\r\n',
		plainHeader + 'body',
		'MIME-Version: 1.1\r\n' + plainHeader,
		rootVersion + 'Content-Type: text/plain\n\nbody',
		rootVersion + 'Content-Type: text/plain\r\nbody',
		rootVersion + 'Content-Type: text/html\r\n\r\nbody',
		rootVersion + 'Content-Type: message/rfc822\r\n\r\nbody',
	])('refuses incomplete/unsupported root %j and erases aliases', (wire) => {
		const input = Buffer.from(wire);
		const alias = input.subarray(0);
		expect(() => consumeMailMimeSource(input)).toThrowError(
			new ImapConnectionError('MAIL_PROTOCOL')
		);
		expect(alias.every((byte) => byte === 0)).toBe(true);
	});

	it.each([
		'--Root--',
		'--Root--\r\n',
		'preamble\r\n--Root\r\n' + plainHeader + 'A\r\n--Root--',
		'\r\n--Root\r\n' + plainHeader + 'A\r\n--Root--',
		'--root\r\n' + plainHeader + 'A\r\n--Root--',
		'--Root \r\n' + plainHeader + 'A\r\n--Root--',
		'--Root\t\r\n' + plainHeader + 'A\r\n--Root--',
		'--Root\n' + plainHeader + 'A\r\n--Root--',
		'--Root\r\n' + plainHeader + 'A',
		'--Root\r\n' + plainHeader + 'A\r\n--root--',
		'--Root\r\n' + plainHeader + 'A\r\n--Root',
		'--Root\r\n' + plainHeader + 'A\r\n--Root-\r\n',
		'--Root\r\n' + plainHeader + 'A\r\n--Root-- \r\n',
		'--Root\r\n' + plainHeader + 'A\r\n--Root--\r',
		'--Root\r\n' + plainHeader + 'A\r\n--Root--\r\n\r\n',
		'--Root\r\n' + plainHeader + 'A\r\n--Root--\r\nepilogue',
		'--Root\r\n' + plainHeader + '--Root--',
		'--Root\r\nContent-Type: text/plain\r\n\r\n--Root--',
		'--Root\r\n' + plainHeader + 'A\r\n--RootSuffix\r\nB\r\n--Root--',
	])('refuses malformed multipart framing %j before leaf allocation', (body) => {
		const input = Buffer.from(
			rootVersion + 'Content-Type: multipart/mixed; boundary=Root\r\n\r\n' + body
		);
		const alloc = vi.spyOn(Buffer, 'alloc');
		expect(() => consumeMailMimeSource(input)).toThrowError(
			new ImapConnectionError('MAIL_PROTOCOL')
		);
		expect(alloc).not.toHaveBeenCalled();
		expect(input.every((byte) => byte === 0)).toBe(true);
	});

	it.each(['Root', 'RootChild', 'R'])(
		'rejects ancestor boundary equality/prefix %s',
		(boundary) => {
			const input = Buffer.from(
				rootVersion + multipart('Root', [multipart(boundary, [plainHeader + 'A'])])
			);
			expect(() => consumeMailMimeSource(input)).toThrowError(
				new ImapConnectionError('MAIL_PROTOCOL')
			);
			expect(input.every((byte) => byte === 0)).toBe(true);
		}
	);

	it('permits the same boundary in disjoint sibling containers', () => {
		const input = Buffer.from(
			rootVersion +
				multipart('Root', [
					multipart('Child', [plainHeader + 'A']),
					multipart('Child', [plainHeader + 'B']),
				])
		);
		const leaves = inspectTree(consumeMailMimeSource(input));
		try {
			expect(leaves.map((leaf) => leaf.toString())).toEqual(['A', 'B']);
		} finally {
			leaves.forEach((leaf) => leaf.fill(0));
		}
	});

	it.each([
		'Content-Type: text/html\r\n\r\nunsupported',
		'Content-Type: message/rfc822\r\n\r\nunsupported',
		'Content-Type: text/plain\r\ncontent-type: text/plain\r\n\r\nambiguous',
		'MIME-Version: 1.1\r\n' + plainHeader + 'bad version',
		'Content-Type: text/plain\r\nContent-ID: secret\r\n\r\nunknown',
		'Content-Type: text/plain\r\nmissing separator',
		multipart('Child', ['Content-Type: text/html\r\n\r\nunsupported'], 'alternative'),
		multipart('Child', [plainHeader + 'truncated']).slice(0, -2),
	])('validates a later child %j before allocating any successful sibling leaf', (child) => {
		const input = Buffer.from(
			rootVersion + multipart('Root', [plainHeader + 'synthetic-first', child])
		);
		const alloc = vi.spyOn(Buffer, 'alloc');
		expect(() => consumeMailMimeSource(input)).toThrowError(
			new ImapConnectionError('MAIL_PROTOCOL')
		);
		expect(alloc).not.toHaveBeenCalled();
		expect(input.every((byte) => byte === 0)).toBe(true);
	});
});

describe('exact complete traversal budgets', () => {
	it.each([0, 1])('counts the root and leaves toward depth, excess=%s', (excess) => {
		let wire = plainHeader + 'A';
		for (let level = 1; level < MAIL_MIME_STRUCTURE_LIMITS.depth + excess; level++)
			wire = multipart(`B${String(level).padStart(2, '0')}z`, [wire]);
		const input = Buffer.from(rootVersion + wire);
		if (excess)
			expect(() => consumeMailMimeSource(input)).toThrowError(
				new ImapConnectionError('MAIL_LIMIT')
			);
		else {
			const leaves = inspectTree(consumeMailMimeSource(input));
			expect(leaves).toHaveLength(1);
			leaves.forEach((leaf) => leaf.fill(0));
		}
		expect(input.every((byte) => byte === 0)).toBe(true);
	});

	it.each([0, 1])('bounds leaf count including empty leaves, excess=%s', (excess) => {
		const input = Buffer.from(
			rootVersion +
				multipart(
					'Root',
					Array.from({ length: MAIL_MIME_STRUCTURE_LIMITS.leaves + excess }, () => plainHeader)
				)
		);
		if (excess)
			expect(() => consumeMailMimeSource(input)).toThrowError(
				new ImapConnectionError('MAIL_LIMIT')
			);
		else {
			const leaves = inspectTree(consumeMailMimeSource(input));
			expect(leaves).toHaveLength(32);
			leaves.forEach((leaf) => leaf.fill(0));
		}
		expect(input.every((byte) => byte === 0)).toBe(true);
	});

	it.each([0, 1])('bounds nodes independently with exactly 32 leaves, excess=%s', (excess) => {
		// Root + 31 containers + 32 leaves = 64; wrapping the last leaf adds one.
		const children = Array.from({ length: MAIL_MIME_STRUCTURE_LIMITS.leaves }, (_, index) =>
			index === 31 && !excess ? plainHeader : multipart(`C${index}z`, [plainHeader])
		);
		const input = Buffer.from(rootVersion + multipart('Root', children));
		if (excess)
			expect(() => consumeMailMimeSource(input)).toThrowError(
				new ImapConnectionError('MAIL_LIMIT')
			);
		else {
			const leaves = inspectTree(consumeMailMimeSource(input));
			expect(leaves).toHaveLength(32);
			leaves.forEach((leaf) => leaf.fill(0));
		}
		expect(input.every((byte) => byte === 0)).toBe(true);
	});

	it.each([0, 1])('bounds a complete source at exactly 24 MiB, excess=%s', (excess) => {
		const prefix = rootVersion + plainHeader;
		const input = Buffer.alloc(MAIL_MIME_STRUCTURE_LIMITS.sourceBytes + excess, 65);
		input.write(prefix, 0, 'ascii');
		const alloc = vi.spyOn(Buffer, 'alloc');
		if (excess) {
			expect(() => consumeMailMimeSource(input)).toThrowError(
				new ImapConnectionError('MAIL_LIMIT')
			);
			expect(alloc).not.toHaveBeenCalled();
		} else {
			const leaves = inspectTree(consumeMailMimeSource(input));
			expect(leaves[0].length).toBe(input.length - prefix.length);
			expect(leaves[0].every((byte) => byte === 65)).toBe(true);
			leaves.forEach((leaf) => leaf.fill(0));
		}
		expect(input.every((byte) => byte === 0)).toBe(true);
	});

	it.each([0, 1])(
		'requires the header terminator inside the 64 KiB search window, excess=%s',
		(excess) => {
			const input = Buffer.from(paddedHeader(IMAP_COMMAND_LIMITS.headerBytes + excess, true) + 'A');
			if (excess)
				expect(() => consumeMailMimeSource(input)).toThrowError(
					new ImapConnectionError('MAIL_LIMIT')
				);
			else {
				const leaves = inspectTree(consumeMailMimeSource(input));
				expect(leaves[0].toString()).toBe('A');
				leaves.forEach((leaf) => leaf.fill(0));
			}
			expect(input.every((byte) => byte === 0)).toBe(true);
		}
	);

	it.each([0, 1])(
		'bounds aggregate headers across discarded fields and every part, excess=%s',
		(excess) => {
			const rootHeader = rootVersion + 'Content-Type: multipart/mixed; boundary="Root"\r\n\r\n';
			const total = MAIL_MIME_STRUCTURE_LIMITS.headerBytes + excess - rootHeader.length;
			const share = Math.floor(total / 5);
			const children = Array.from({ length: 5 }, (_, index) =>
				paddedHeader(index === 4 ? total - 4 * share : share)
			);
			expect(rootHeader.length + children.reduce((sum, child) => sum + child.length, 0)).toBe(
				MAIL_MIME_STRUCTURE_LIMITS.headerBytes + excess
			);
			const input = Buffer.from(rootVersion + multipart('Root', children));
			if (excess)
				expect(() => consumeMailMimeSource(input)).toThrowError(
					new ImapConnectionError('MAIL_LIMIT')
				);
			else {
				const leaves = inspectTree(consumeMailMimeSource(input));
				expect(leaves).toHaveLength(5);
				leaves.forEach((leaf) => leaf.fill(0));
			}
			expect(input.every((byte) => byte === 0)).toBe(true);
		}
	);
});

describe('owned failure cleanup and fixed errors', () => {
	it.each([undefined, null, 'source', new Uint8Array([65]), {}])(
		'rejects non-owned input %j',
		(input) => {
			expect(() => consumeMailMimeSource(input)).toThrowError(
				new ImapConnectionError('MAIL_INVALID')
			);
		}
	);

	it.each(['allocation', 'copy'])(
		'erases earlier and failed leaf allocations after %s failure',
		(mode) => {
			const input = Buffer.from(
				rootVersion + multipart('Root', [plainHeader + 'first', plainHeader + 'second'])
			);
			const alias = input.subarray(0);
			const allocations = [Buffer.alloc(5, 83), Buffer.alloc(6, 83)];
			const nativeError = new Error('synthetic-private-native-message');
			const alloc = vi.spyOn(Buffer, 'alloc').mockImplementationOnce(() => allocations[0]);
			if (mode === 'allocation')
				alloc.mockImplementationOnce(() => {
					throw nativeError;
				});
			else {
				alloc.mockImplementationOnce(() => allocations[1]);
				const copy = input.copy.bind(input);
				vi.spyOn(input, 'copy').mockImplementation(
					(target, targetStart, sourceStart, sourceEnd) => {
						const count = copy(target, targetStart, sourceStart, sourceEnd);
						if (target === allocations[1]) throw nativeError;
						return count;
					}
				);
			}
			let failure: unknown;
			try {
				consumeMailMimeSource(input);
			} catch (error) {
				failure = error;
			}
			expect(failure).toBeInstanceOf(ImapConnectionError);
			expect(failure).toMatchObject({
				code: 'MAIL_PROTOCOL',
				message: 'Unsupported or invalid mail response.',
			});
			expect(failure === nativeError).toBe(false);
			expect(failure).not.toHaveProperty('cause');
			expect(String(failure)).not.toContain('synthetic-private');
			expect(allocations[0].every((byte) => byte === 0)).toBe(true);
			if (mode === 'copy') expect(allocations[1].every((byte) => byte === 0)).toBe(true);
			expect(alias.every((byte) => byte === 0)).toBe(true);
			allocations.forEach((buffer) => buffer.fill(0));
		}
	);

	it.each([false, true])('erases temporary header/marker copies on failure=%s', (reject) => {
		const input = Buffer.from(
			rootVersion +
				multipart('Root', [
					plainHeader + 'A',
					reject ? 'Content-Type: text/html\r\n\r\nB' : plainHeader + 'B',
				])
		);
		const copies = vi.spyOn(Buffer, 'from');
		let output: MailMimePart | undefined;
		if (reject)
			expect(() => consumeMailMimeSource(input)).toThrowError(
				new ImapConnectionError('MAIL_PROTOCOL')
			);
		else output = consumeMailMimeSource(input);
		const temporary = copies.mock.results
			.filter((result) => result.type === 'return')
			.map((result) => result.value as Buffer);
		expect(temporary.length).toBeGreaterThanOrEqual(4);
		for (const buffer of temporary) expect(buffer.every((byte) => byte === 0)).toBe(true);
		expect(input.every((byte) => byte === 0)).toBe(true);
		if (output) inspectTree(output).forEach((leaf) => leaf.fill(0));
	});
});
