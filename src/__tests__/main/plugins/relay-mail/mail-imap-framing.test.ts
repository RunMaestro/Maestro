import { Buffer } from 'node:buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	ImapFramingError,
	ImapResponseDecoder,
	IMAP_FRAMING_LIMITS,
	type ImapResponseFrame,
} from '../../../../main/plugins/relay-mail/mail-imap-framing';

afterEach(() => vi.restoreAllMocks());

describe('host-private incremental IMAP framing', () => {
	it('preserves exact ordered frames at every two-chunk split and byte-wise', () => {
		const payload = Buffer.from([0, 255, 13, 10, 40, 125, 34]);
		const wire = Buffer.concat([
			Buffer.from('* oK opaque {9999999999} "(\r\n* 7 FETCH (UID 9 BODY[] {7}\r\n'),
			payload,
			Buffer.from(')\r\nA1 OK complete\r\n'),
		]);
		const original = Buffer.from(wire);
		const expected = [
			{ kind: 'status', tag: null, status: 'OK', text: 'opaque {9999999999} "(' },
			{ kind: 'data', name: 'FETCH', parts: ['* 7 FETCH ', '(UID 9 BODY[] {7}', payload, ')'] },
			{ kind: 'status', tag: 'A1', status: 'OK', text: 'complete' },
		];
		for (let split = 0; split <= wire.length; split++) {
			const decoder = new ImapResponseDecoder();
			const frames = [
				...decoder.push(wire.subarray(0, split)),
				...decoder.push(wire.subarray(split)),
			];
			decoder.finish();
			expect(frames).toEqual(expected);
			if (frames[1].kind === 'data') (frames[1].parts[2] as Buffer).fill(0);
		}
		const decoder = new ImapResponseDecoder();
		const frames: ImapResponseFrame[] = [];
		for (const byte of wire) frames.push(...decoder.push(Buffer.from([byte])));
		decoder.finish();
		expect(frames).toEqual(expected);
		expect(wire).toEqual(original);
		if (frames[1].kind === 'data') (frames[1].parts[2] as Buffer).fill(0);
	});

	it.each([
		['* NO denied {1}\r\n', { kind: 'status', tag: null, status: 'NO', text: 'denied {1}' }],
		['z9 bad failed\r\n', { kind: 'status', tag: 'z9', status: 'BAD', text: 'failed' }],
		['* BYE closing\r\n', { kind: 'status', tag: null, status: 'BYE', text: 'closing' }],
		['* 0 EXISTS\r\n', { kind: 'data', name: 'EXISTS', parts: ['* 0 EXISTS'] }],
		['* 4294967295 recent\r\n', { kind: 'data', name: 'RECENT', parts: ['* 4294967295 recent'] }],
		['* SEARCH\r\n', { kind: 'data', name: 'SEARCH', parts: ['* SEARCH'] }],
		[
			'* SEARCH 9 1 4294967295\r\n',
			{ kind: 'data', name: 'SEARCH', parts: ['* SEARCH 9 1 4294967295'] },
		],
		['* FLAGS ()\r\n', { kind: 'data', name: 'FLAGS', parts: ['* FLAGS ()'] }],
		['* FLAGS ($Forwarded)\r\n', { kind: 'data', name: 'FLAGS', parts: ['* FLAGS ($Forwarded)'] }],
		[
			'* CAPABILITY IMAP4rev1\r\n',
			{ kind: 'data', name: 'CAPABILITY', parts: ['* CAPABILITY IMAP4rev1'] },
		],
		[
			'* FLAGS (\\Seen custom.flag)\r\n',
			{ kind: 'data', name: 'FLAGS', parts: ['* FLAGS (\\Seen custom.flag)'] },
		],
	])(
		'accepts restricted frame %j without interpreting status or UID semantics',
		(wire, expected) => {
			const decoder = new ImapResponseDecoder();
			expect(decoder.push(Buffer.from(wire as string))).toEqual([expected]);
			decoder.finish();
		}
	);

	it.each([
		'todo+work',
		'important!',
		'a&b',
		'a[b',
		'a}b',
		"a'b",
		'a/b',
		'a=b',
		'a`b',
		'+'.repeat(64),
		'\\X+Extension',
	])('accepts bounded RFC 3501 flag atom %s', (flag) => {
		const decoder = new ImapResponseDecoder();
		const line = `* FLAGS (\\Seen ${flag})`;
		expect(decoder.push(Buffer.from(`${line}\r\n`))).toEqual([
			{ kind: 'data', name: 'FLAGS', parts: [line] },
		]);
		decoder.finish();
	});

	it.each([
		'bad%flag',
		'bad*flag',
		'bad"flag',
		'bad\\flag',
		'bad{flag',
		'bad]flag',
		'bad(flag',
		'bad)flag',
		' leading',
		'trailing ',
		'two  flags',
		'+'.repeat(65),
		'\\' + '+'.repeat(65),
	])('refuses invalid or oversized flag atom %j', (flag) => {
		const decoder = new ImapResponseDecoder();
		expect(() => decoder.push(Buffer.from(`* FLAGS (${flag})\r\n`))).toThrowError(
			new ImapFramingError('MAIL_PROTOCOL')
		);
	});

	it('transfers distinct literal ownership, including empty and multiple parts', () => {
		const wire = Buffer.from('* 1 FETCH (A {0}\r\n B {2}\r\nZZ C {2}\r\nYY)\r\n');
		const decoder = new ImapResponseDecoder();
		const frames = decoder.push(wire);
		expect(frames).toEqual([
			{
				kind: 'data',
				name: 'FETCH',
				parts: [
					'* 1 FETCH ',
					'(A {0}',
					Buffer.alloc(0),
					' B {2}',
					Buffer.from('ZZ'),
					' C {2}',
					Buffer.from('YY'),
					')',
				],
			},
		]);
		decoder.dispose();
		if (frames[0].kind !== 'data') throw new Error('Expected FETCH');
		const literals = frames[0].parts.filter(Buffer.isBuffer);
		expect(literals).toHaveLength(3);
		expect(literals[1] === literals[2]).toBe(false);
		wire.fill(0);
		expect(literals.map((part) => part.toString())).toEqual(['', 'ZZ', 'YY']);
		literals[1].fill(65);
		expect(literals[2].toString()).toBe('YY');
		literals.forEach((part) => part.fill(0));
	});

	it('treats braces and parentheses inside quoted FETCH strings as opaque', () => {
		const decoder = new ImapResponseDecoder();
		const wire = '* 1 FETCH (X "{(}~\\\"\\\\" (NIL))\r\n';
		expect(decoder.push(Buffer.from(wire))).toEqual([
			{
				kind: 'data',
				name: 'FETCH',
				parts: ['* 1 FETCH ', wire.slice(10, -2)],
			},
		]);
		decoder.finish();
	});

	it.each([
		'* OK missing LF\n',
		'* OK bad CR\rX',
		'* OK tab\ttext\r\n',
		'* OK nul\0text\r\n',
		'* OK high\x80\r\n',
		'* OK del\x7f\r\n',
		'* OK \r\n',
		'A1 BYE closing\r\n',
		'+ continuation\r\n',
		'* PREAUTH ready\r\n',
		'* CAPABILITY\r\n',
		'* 1 EXPUNGE\r\n',
		'A-1 OK ready\r\n',
		'* 4294967296 EXISTS\r\n',
		'* SEARCH 0\r\n',
		'* SEARCH 01\r\n',
		'* SEARCH 4294967296\r\n',
		'* SEARCH 1 \r\n',
		'* FLAGS (\\*)\r\n',
		'* 0 FETCH ()\r\n',
		'* 4294967296 FETCH ()\r\n',
		'* 1 FETCH NIL\r\n',
		'* 1 FETCH ())\r\n',
		'* 1 FETCH () X\r\n',
		'* 1 FETCH (X "unterminated)\r\n',
		'* 1 FETCH (X "bad\\q")\r\n',
		'* 1 FETCH (X {1+}\r\n',
		'* 1 FETCH (X ~{1}\r\n',
		'* 1 FETCH (X {1} extra\r\n',
		'* 1 FETCH (X{1}\r\n',
		'* 1 FETCH (X {00000000001}\r\n',
		'* 1 FETCH (X })\r\n',
		'* 1 FETCH (X (NIL)\r\n',
	])('poisons malformed or unsupported framing %j with a fixed error', (wire) => {
		const decoder = new ImapResponseDecoder();
		expect(() => decoder.push(Buffer.from(wire))).toThrowError(
			new ImapFramingError('MAIL_PROTOCOL')
		);
		expect(() => decoder.push(Buffer.alloc(0))).toThrowError(new ImapFramingError('MAIL_CANCELED'));
		expect(() => decoder.finish()).toThrowError(new ImapFramingError('MAIL_CANCELED'));
	});

	it.each([undefined, null, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])(
		'refuses invalid constructor cap %j before line allocation',
		(value) => {
			const alloc = vi.spyOn(Buffer, 'alloc');
			for (const key of Object.keys(IMAP_FRAMING_LIMITS))
				expect(() => new ImapResponseDecoder({ [key]: value })).toThrowError(
					new ImapFramingError('MAIL_LIMIT')
				);
			expect(alloc).not.toHaveBeenCalled();
		}
	);

	it('permits every exact hard ceiling but never a raised or unknown cap', () => {
		expect(Object.isFrozen(IMAP_FRAMING_LIMITS)).toBe(true);
		for (const [key, value] of Object.entries(IMAP_FRAMING_LIMITS)) {
			const decoder = new ImapResponseDecoder({ [key]: value });
			decoder.dispose();
			expect(() => new ImapResponseDecoder({ [key]: value + 1 })).toThrowError(
				new ImapFramingError('MAIL_LIMIT')
			);
		}
		expect(() => new ImapResponseDecoder({ unknown: 1 } as never)).toThrowError(
			new ImapFramingError('MAIL_LIMIT')
		);
	});

	it.each([0, 1])(
		'pins the exact 64 KiB physical-line ceiling including CRLF: excess %i',
		(excess) => {
			const decoder = new ImapResponseDecoder();
			const wire = Buffer.from(
				'* OK ' + 'A'.repeat(IMAP_FRAMING_LIMITS.lineBytes - 7 + excess) + '\r\n'
			);
			if (excess) expect(() => decoder.push(wire)).toThrowError(new ImapFramingError('MAIL_LIMIT'));
			else {
				expect(decoder.push(wire)).toHaveLength(1);
				decoder.finish();
			}
		}
	);

	it.each([0, 1])('pins tightened literal size before allocation: excess %i', (excess) => {
		const decoder = new ImapResponseDecoder({ literalBytes: 3 });
		const wire = Buffer.from(`* 1 FETCH (X {${3 + excess}}\r\nABC)\r\n`);
		const alloc = vi.spyOn(Buffer, 'alloc');
		if (excess) {
			expect(() => decoder.push(wire)).toThrowError(new ImapFramingError('MAIL_LIMIT'));
			expect(alloc).not.toHaveBeenCalled();
		} else {
			const frames = decoder.push(wire);
			expect(alloc).toHaveBeenCalledExactlyOnceWith(3);
			decoder.finish();
			if (frames[0].kind !== 'data') throw new Error('Expected FETCH');
			expect((frames[0].parts[2] as Buffer).toString()).toBe('ABC');
			(frames[0].parts[2] as Buffer).fill(0);
		}
	});

	it('rejects a literal above the hard ceiling before allocating any literal', () => {
		const decoder = new ImapResponseDecoder();
		const wire = Buffer.from(`* 1 FETCH (X {${IMAP_FRAMING_LIMITS.literalBytes + 1}}\r\n`);
		const alloc = vi.spyOn(Buffer, 'alloc');
		expect(() => decoder.push(wire)).toThrowError(new ImapFramingError('MAIL_LIMIT'));
		expect(alloc).not.toHaveBeenCalled();
	});

	it('accepts an exact 24 MiB opaque literal without changing its input', () => {
		const size = IMAP_FRAMING_LIMITS.literalBytes;
		const decoder = new ImapResponseDecoder();
		const input = Buffer.alloc(size, 255);
		expect(decoder.push(Buffer.from(`* 1 FETCH (X {${size}}\r\n`))).toEqual([]);
		expect(decoder.push(input)).toEqual([]);
		const frames = decoder.push(Buffer.from(')\r\n'));
		decoder.finish();
		if (frames[0].kind !== 'data') throw new Error('Expected FETCH');
		const output = frames[0].parts[2] as Buffer;
		expect(output === input).toBe(false);
		expect(output.length).toBe(size);
		expect(output.equals(input)).toBe(true);
		output.fill(0);
		expect(input.every((byte) => byte === 255)).toBe(true);
		input.fill(0);
	});

	it.each([
		[{ lineBytes: 8 }, '* OK x\r\n', '* OK xx\r\n'],
		[{ responses: 1 }, '* OK x\r\n', '* OK x\r\n* OK y\r\n'],
		[{ depth: 2 }, '* 1 FETCH ((NIL))\r\n', '* 1 FETCH (((NIL)))\r\n'],
		[
			{ literalsPerResponse: 1 },
			'* 1 FETCH (X {0}\r\n)\r\n',
			'* 1 FETCH (X {0}\r\n Y {0}\r\n)\r\n',
		],
	])('honors tightened structural budget %j at its exact boundary', (limits, accepted, denied) => {
		const decoder = new ImapResponseDecoder(limits as Partial<typeof IMAP_FRAMING_LIMITS>);
		expect(decoder.push(Buffer.from(accepted as string))).toHaveLength(1);
		decoder.finish();
		const restricted = new ImapResponseDecoder(limits as Partial<typeof IMAP_FRAMING_LIMITS>);
		expect(() => restricted.push(Buffer.from(denied as string))).toThrowError(
			new ImapFramingError('MAIL_LIMIT')
		);
	});

	it.each([0, 1])('retains cumulative total-wire budget across pushes: excess %i', (excess) => {
		const first = Buffer.from('* OK first\r\n');
		const second = Buffer.from('* OK last\r\n');
		const decoder = new ImapResponseDecoder({ totalBytes: first.length + second.length - excess });
		expect(decoder.push(first)).toHaveLength(1);
		decoder.setLiteralLimit(0);
		if (excess) expect(() => decoder.push(second)).toThrowError(new ImapFramingError('MAIL_LIMIT'));
		else {
			expect(decoder.push(second)).toHaveLength(1);
			decoder.finish();
		}
	});

	it('refuses declared literal beyond remaining wire budget before allocation', () => {
		const wire = Buffer.from('* 1 FETCH (X {3}\r\n');
		const decoder = new ImapResponseDecoder({ totalBytes: wire.length + 2 });
		const alloc = vi.spyOn(Buffer, 'alloc');
		expect(() => decoder.push(wire)).toThrowError(new ImapFramingError('MAIL_LIMIT'));
		expect(alloc).not.toHaveBeenCalled();
	});

	it('denies an oversized chunk before parsing or literal allocation', () => {
		const decoder = new ImapResponseDecoder({ totalBytes: 1 });
		const alloc = vi.spyOn(Buffer, 'alloc');
		expect(() => decoder.push(Buffer.from('XX'))).toThrowError(new ImapFramingError('MAIL_LIMIT'));
		expect(alloc).not.toHaveBeenCalled();
	});

	it.each([0, 1])('pins exact cumulative response count: excess %i', (excess) => {
		const decoder = new ImapResponseDecoder();
		for (let i = 0; i < IMAP_FRAMING_LIMITS.responses; i++)
			expect(decoder.push(Buffer.from('* OK x\r\n'))).toHaveLength(1);
		decoder.setLiteralLimit(0);
		if (excess)
			expect(() => decoder.push(Buffer.from('* OK x\r\n'))).toThrowError(
				new ImapFramingError('MAIL_LIMIT')
			);
		else decoder.finish();
	});

	it.each([0, 1])(
		'pins exact per-response literal count including empty literals: excess %i',
		(excess) => {
			const decoder = new ImapResponseDecoder();
			const wire =
				'* 1 FETCH (' +
				'X {0}\r\n '.repeat(IMAP_FRAMING_LIMITS.literalsPerResponse + excess) +
				')\r\n';
			const alloc = vi.spyOn(Buffer, 'alloc');
			if (excess)
				expect(() => decoder.push(Buffer.from(wire))).toThrowError(
					new ImapFramingError('MAIL_LIMIT')
				);
			else {
				for (let i = 0; i < 2; i++) {
					const frames = decoder.push(Buffer.from(wire));
					if (frames[0].kind !== 'data') throw new Error('Expected FETCH');
					expect(frames[0].parts.filter(Buffer.isBuffer)).toHaveLength(
						IMAP_FRAMING_LIMITS.literalsPerResponse
					);
				}
				decoder.finish();
			}
			expect(alloc.mock.calls).toHaveLength(
				IMAP_FRAMING_LIMITS.literalsPerResponse * (excess ? 1 : 2)
			);
		}
	);

	it.each([0, 1])('pins exact FETCH nesting including the root: excess %i', (excess) => {
		const decoder = new ImapResponseDecoder();
		const depth = IMAP_FRAMING_LIMITS.depth + excess;
		const wire = Buffer.from('* 1 FETCH ' + '('.repeat(depth) + 'NIL' + ')'.repeat(depth) + '\r\n');
		if (excess) expect(() => decoder.push(wire)).toThrowError(new ImapFramingError('MAIL_LIMIT'));
		else {
			expect(decoder.push(wire)).toHaveLength(1);
			decoder.finish();
		}
	});

	it('allows zero literal cap at boundaries and restores only the constructor ceiling', () => {
		const decoder = new ImapResponseDecoder({ literalBytes: 2 });
		decoder.setLiteralLimit(0);
		expect(decoder.push(Buffer.from('* 1 FETCH (X {0}\r\n)\r\n'))).toHaveLength(1);
		decoder.setLiteralLimit(2);
		const frames = decoder.push(Buffer.from('* 1 FETCH (X {2}\r\nZZ)\r\n'));
		decoder.finish();
		if (frames[0].kind !== 'data') throw new Error('Expected FETCH');
		(frames[0].parts[2] as Buffer).fill(0);
		const zero = new ImapResponseDecoder();
		zero.setLiteralLimit(0);
		expect(() => zero.push(Buffer.from('* 1 FETCH (X {1}\r\n'))).toThrowError(
			new ImapFramingError('MAIL_LIMIT')
		);
	});

	it.each([-1, 1.5, NaN, Infinity, 3])('poisons invalid dynamic cap %j', (cap) => {
		const decoder = new ImapResponseDecoder({ literalBytes: 2 });
		expect(() => decoder.setLiteralLimit(cap)).toThrowError(new ImapFramingError('MAIL_LIMIT'));
		expect(() => decoder.setLiteralLimit(0)).toThrowError(new ImapFramingError('MAIL_CANCELED'));
	});

	it.each(['* OK pending\r', '* 1 FETCH (X {2}\r\nZ', '* 1 FETCH (X {2}\r\nZZ'])(
		'forbids mid-response cap changes and erases pending buffers: %j',
		(wire) => {
			const alloc = vi.spyOn(Buffer, 'alloc');
			const decoder = new ImapResponseDecoder();
			expect(decoder.push(Buffer.from(wire))).toEqual([]);
			expect(() => decoder.setLiteralLimit(1)).toThrowError(new ImapFramingError('MAIL_PROTOCOL'));
			for (const result of alloc.mock.results)
				if (result.type === 'return')
					expect((result.value as Buffer).every((byte) => byte === 0)).toBe(true);
		}
	);

	it.each(['', '* OK partial', '* OK cr\r', '* 1 FETCH (X {2}\r\nZ', '* 1 FETCH (X {2}\r\nZZ'])(
		'closes at EOF and refuses any incomplete response: %j',
		(wire) => {
			const alloc = vi.spyOn(Buffer, 'alloc');
			const decoder = new ImapResponseDecoder();
			expect(decoder.push(Buffer.from(wire))).toEqual([]);
			if (wire) expect(() => decoder.finish()).toThrowError(new ImapFramingError('MAIL_PROTOCOL'));
			else decoder.finish();
			decoder.dispose();
			for (const result of alloc.mock.results)
				if (result.type === 'return')
					expect((result.value as Buffer).every((byte) => byte === 0)).toBe(true);
			expect(() => decoder.push(Buffer.alloc(0))).toThrowError(
				new ImapFramingError('MAIL_CANCELED')
			);
		}
	);

	it.each(['protocol', 'responses', 'cancel'])(
		'erases line/current/completed pending literals on %s while preserving prior frames',
		(mode) => {
			const alloc = vi.spyOn(Buffer, 'alloc');
			const decoder = new ImapResponseDecoder({ responses: 2 });
			const first = decoder.push(Buffer.from('* 1 FETCH (X {2}\r\nAA)\r\n'));
			if (first[0].kind !== 'data') throw new Error('Expected FETCH');
			const transferred = first[0].parts[2] as Buffer;
			if (mode === 'cancel') {
				decoder.push(Buffer.from('* 2 FETCH (X {2}\r\nBB Y {3}\r\nC'));
				decoder.dispose();
				decoder.dispose();
			} else {
				const suffix = mode === 'protocol' ? '* PREAUTH synthetic-private\r\n' : '* OK third\r\n';
				expect(() =>
					decoder.push(Buffer.from('* 2 FETCH (X {2}\r\nBB)\r\n' + suffix))
				).toThrowError(new ImapFramingError(mode === 'protocol' ? 'MAIL_PROTOCOL' : 'MAIL_LIMIT'));
			}
			expect(transferred.toString()).toBe('AA');
			for (const result of alloc.mock.results)
				if (result.type === 'return' && result.value !== transferred)
					expect((result.value as Buffer).every((byte) => byte === 0)).toBe(true);
			transferred.fill(0);
		}
	);

	it.each(['allocation', 'copy'])(
		'normalizes native %s failure and erases earlier frames from the same push',
		(mode) => {
			const originalAlloc = Buffer.alloc;
			const alloc = vi.spyOn(Buffer, 'alloc');
			const decoder = new ImapResponseDecoder();
			const native = new Error('synthetic-private-native');
			const wire = Buffer.from('* 1 FETCH (X {2}\r\nAA)\r\n* 2 FETCH (X {2}\r\nZZ)\r\n');
			if (mode === 'allocation') {
				alloc
					.mockImplementationOnce((size) => originalAlloc(size))
					.mockImplementationOnce(() => {
						throw native;
					});
			} else {
				const original = wire.copy.bind(wire);
				vi.spyOn(wire, 'copy')
					.mockImplementationOnce(original)
					.mockImplementationOnce(() => {
						throw native;
					});
			}
			let caught: unknown;
			try {
				decoder.push(wire);
			} catch (error) {
				caught = error;
			}
			expect(caught).toEqual(new ImapFramingError('MAIL_PROTOCOL'));
			expect(caught === native).toBe(false);
			expect(caught).not.toHaveProperty('cause');
			expect(String(caught)).not.toContain('synthetic-private');
			for (const result of alloc.mock.results)
				if (result.type === 'return')
					expect((result.value as Buffer).every((byte) => byte === 0)).toBe(true);
			expect(() => decoder.finish()).toThrowError(new ImapFramingError('MAIL_CANCELED'));
		}
	);

	it.each([null, 'synthetic-private', new Uint8Array([65]), {}])(
		'refuses non-Buffer chunks %j and permanently closes',
		(chunk) => {
			const decoder = new ImapResponseDecoder();
			expect(() => decoder.push(chunk as Buffer)).toThrowError(
				new ImapFramingError('MAIL_PROTOCOL')
			);
			expect(() => decoder.push(Buffer.alloc(0))).toThrowError(
				new ImapFramingError('MAIL_CANCELED')
			);
		}
	);
});
