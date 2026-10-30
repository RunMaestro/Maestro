import { Buffer } from 'node:buffer';
import { describe, expect, it, vi, afterEach } from 'vitest';
import {
	assertImapQuotedString,
	assertImapUid,
	eraseImapFrameLiterals,
	IMAP_COMMAND_LIMITS,
	IMAP_HEADER_FIELDS,
	prepareImapCommand,
	validateImapCommandResult,
	type FixedImapCommand,
} from '../../../../main/plugins/relay-mail/mail-imap-commands';
import { ImapConnectionError } from '../../../../main/plugins/relay-mail/mail-errors';
import {
	ImapResponseDecoder,
	IMAP_FRAMING_LIMITS,
	type ImapResponseFrame,
} from '../../../../main/plugins/relay-mail/mail-imap-framing';

// Use real framing; semantic fixtures below must be complete, parseable rev1 wire.
function decode(wire: string | Buffer): ImapResponseFrame[] {
	const decoder = new ImapResponseDecoder();
	try {
		const frames = decoder.push(typeof wire === 'string' ? Buffer.from(wire) : wire);
		decoder.finish();
		return frames;
	} finally {
		decoder.dispose();
	}
}

function rejected(work: () => unknown, code = 'MAIL_PROTOCOL'): void {
	let error: unknown;
	try {
		work();
	} catch (caught) {
		error = caught;
	}
	expect(error).toBeInstanceOf(ImapConnectionError);
	expect(error).toMatchObject({ name: 'ImapConnectionError', code });
	expect(error).not.toHaveProperty('cause');
	expect(String(error)).not.toMatch(/synthetic-secret|peer-private|BODY\[/);
}

const headers = `HEADER.FIELDS (${IMAP_HEADER_FIELDS.join(' ')})`;
afterEach(() => vi.restoreAllMocks());

describe('host-private fixed IMAP commands', () => {
	it.each([
		[
			{ kind: 'login', username: 'u"\\', password: 'synthetic-secret"\\' },
			'LOGIN "u\\"\\\\" "synthetic-secret\\"\\\\"',
		],
		[{ kind: 'login', username: 'u', password: '' }, 'LOGIN "u" ""'],
		[{ kind: 'examine', mailbox: 'A&B&-"\\' }, 'EXAMINE "A&-B&--\\"\\\\"'],
		[{ kind: 'search', fromUid: '1', toUid: '4294967295' }, 'UID SEARCH UID 1:4294967295'],
		[
			{ kind: 'search', fromUid: '9', toUid: '9', text: 'x"\\' },
			'UID SEARCH UID 9:9 OR HEADER SUBJECT "x\\"\\\\" HEADER FROM "x\\"\\\\"',
		],
		[{ kind: 'fetch', uid: '9', content: 'headers' }, `UID FETCH 9 (UID BODY.PEEK[${headers}])`],
		[{ kind: 'fetch', uid: '9', content: 'source' }, 'UID FETCH 9 (UID BODY.PEEK[])'],
		[
			{ kind: 'fetch', uid: '9', content: 'part', part: '1.999' },
			'UID FETCH 9 (UID BODY.PEEK[1.999])',
		],
		[{ kind: 'noop' }, 'NOOP'],
		[{ kind: 'logout' }, 'LOGOUT'],
	] as const)('builds only the fixed wire operation %j', (input, body) => {
		expect(IMAP_HEADER_FIELDS.join(' ')).toBe(
			'SUBJECT FROM TO CC DATE MESSAGE-ID IN-REPLY-TO REFERENCES MIME-VERSION CONTENT-TYPE CONTENT-TRANSFER-ENCODING CONTENT-DISPOSITION'
		);
		const command = prepareImapCommand('A1', input);
		expect(command.bytes.toString('ascii')).toBe(`A1 ${body}\r\n`);
		expect(Object.isFrozen(command)).toBe(true);
		expect(command).not.toHaveProperty('password');
		expect(command).not.toHaveProperty('username');
		expect(Object.keys(command).sort()).toEqual(
			(input.kind === 'fetch'
				? ['tag', 'kind', 'bytes', 'uid', 'section', 'literalLimit']
				: input.kind === 'search'
					? ['tag', 'kind', 'bytes', 'fromUid', 'toUid']
					: ['tag', 'kind', 'bytes']
			).sort()
		);
		command.bytes.fill(0);
	});
	it('preserves independent bytes and validates exact field ceilings before allocation', () => {
		const login = { kind: 'login', username: 'u'.repeat(256), password: 'p'.repeat(1024) } as const;
		const first = prepareImapCommand('A999999', login);
		const second = prepareImapCommand('A1', login);
		expect(first.bytes.toString()).toBe(
			`A999999 LOGIN "${login.username}" "${login.password}"\r\n`
		);
		first.bytes.fill(0);
		expect(second.bytes.toString()).toContain(login.password);
		second.bytes.fill(0);
		const mailbox = prepareImapCommand('A1', { kind: 'examine', mailbox: '&'.repeat(256) });
		expect(mailbox.bytes.toString()).toBe(`A1 EXAMINE "${'&-'.repeat(256)}"\r\n`);
		mailbox.bytes.fill(0);
		prepareImapCommand('A1', {
			kind: 'search',
			fromUid: '1',
			toUid: '1',
			text: 'x'.repeat(512),
		}).bytes.fill(0);
		prepareImapCommand('A1', {
			kind: 'fetch',
			uid: '1',
			content: 'part',
			part: Array(16).fill('999').join('.'),
		}).bytes.fill(0);
		const allocation = vi.spyOn(Buffer, 'from');
		for (const input of [
			{ ...login, username: 'u'.repeat(257) },
			{ ...login, password: 'p'.repeat(1025) },
			{ kind: 'examine', mailbox: 'x'.repeat(257) },
			{ kind: 'search', fromUid: '1', toUid: '1', text: 'x'.repeat(513) },
			{ kind: 'fetch', uid: '1', content: 'part', part: Array(17).fill('1').join('.') },
		])
			rejected(() => prepareImapCommand('A1', input as FixedImapCommand), 'MAIL_INVALID');
		expect(allocation).not.toHaveBeenCalled();
	});
	it.each(['', 'A0', 'A01', 'A1000000', 'a1', 'Z1', 'A1\r\n', 1, null])(
		'refuses invalid tag %j',
		(tag) => {
			rejected(() => prepareImapCommand(tag as string, { kind: 'noop' }), 'MAIL_INVALID');
		}
	);
	it.each([
		null,
		'NOOP',
		[],
		{},
		{ kind: 'SELECT', mailbox: 'INBOX' },
		{ kind: 'store', uid: '1' },
		{ kind: 'append', bytes: 'synthetic-secret' },
		{ kind: 'raw', command: 'NOOP' },
		{ kind: 'noop', command: 'STORE' },
		{ kind: 'logout', endpoint: 'peer-private' },
		{ kind: 'login', username: '', password: 'p' },
		{ kind: 'login', username: 'u' },
		{ kind: 'login', username: 'u', password: 'p', tls: false },
		{ kind: 'examine', mailbox: '' },
		{ kind: 'examine', mailbox: '日本' },
		{ kind: 'examine', mailbox: 'INBOX\r\nA2 STORE 1' },
		{ kind: 'search', fromUid: '2', toUid: '1' },
		{ kind: 'search', fromUid: '1', toUid: '*' },
		{ kind: 'search', fromUid: '1', toUid: '2', text: '' },
		{ kind: 'search', fromUid: '1', toUid: '2', text: 'é' },
		{ kind: 'search', fromUid: '1', toUid: '2', body: 'x' },
		{ kind: 'fetch', uid: '01', content: 'source' },
		{ kind: 'fetch', uid: '1', content: 'raw' },
		{ kind: 'fetch', uid: '1', content: 'headers', part: '1' },
		{ kind: 'fetch', uid: '1', content: 'source', section: 'TEXT' },
		{ kind: 'fetch', uid: '1', content: 'part', part: '0' },
		{ kind: 'fetch', uid: '1', content: 'part', part: '01' },
		{ kind: 'fetch', uid: '1', content: 'part', part: '1000' },
		{ kind: 'fetch', uid: '1', content: 'part', part: '1.0' },
		{ kind: 'fetch', uid: '1', content: 'part', part: '1.' },
		{ kind: 'fetch', uid: '1', content: 'part', part: '1]<0>' },
	])('rejects raw, write, unknown or malformed command %j', (input) => {
		rejected(() => prepareImapCommand('A1', input as FixedImapCommand), 'MAIL_INVALID');
	});
	it.each(['0', '01', '-1', '1.0', '1e2', '4294967296', '99999999999', '1 ', '*', '', 1, null])(
		'rejects noncanonical UID %j',
		(uid) => {
			rejected(() => assertImapUid(uid), 'MAIL_INVALID');
			rejected(() => assertImapUid(uid, 'MAIL_PROTOCOL'));
		}
	);
	it('shares exact UID and printable-ASCII quoted-string rules without allocating', () => {
		const allocation = vi.spyOn(Buffer, 'from');
		assertImapUid('1');
		assertImapUid('4294967295');
		assertImapQuotedString(' "\\~', 4);
		assertImapQuotedString('', 0, true);
		for (const value of ['', 'abcde', '\t', '\r', '\n', '\0', '\x7f', 'é', 1, null])
			rejected(() => assertImapQuotedString(value, 4), 'MAIL_INVALID');
		for (const cap of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
			rejected(() => assertImapQuotedString('x', cap), 'MAIL_INVALID');
		expect(allocation).not.toHaveBeenCalled();
	});
});

describe('real framed IMAP command response semantics', () => {
	it.each([
		['A1 OK peer-private synthetic-secret\r\n', 'status'],
		['* OK [ALERT] peer-private\r\nA1 OK [alert] peer-private\r\n', 'status'],
		['A1 OK [CAPABILITY IMAP4rev1 AUTH=PLAIN X-FIXTURE] ready\r\n', 'status'],
		['* CAPABILITY IMAP4rev1 AUTH=PLAIN\r\nA1 OK logged in\r\n', 'status'],
	])('accepts LOGIN without forwarding opaque status text', (wire, kind) => {
		const command = prepareImapCommand('A1', { kind: 'login', username: 'u', password: 'p' });
		expect(validateImapCommandResult(command, decode(wire))).toEqual({ kind });
		command.bytes.fill(0);
	});
	it.each([
		['', 'MAIL_PROTOCOL'],
		['A2 OK peer-private\r\n', 'MAIL_PROTOCOL'],
		['a1 OK peer-private\r\n', 'MAIL_PROTOCOL'],
		['A1 NO synthetic-secret\r\n', 'MAIL_UNAVAILABLE'],
		['A1 BAD peer-private\r\n', 'MAIL_UNAVAILABLE'],
		['A1 OK earlier\r\nA1 OK last\r\n', 'MAIL_PROTOCOL'],
		['A1 OK done\r\n* OK late\r\n', 'MAIL_PROTOCOL'],
		['* BYE peer-private\r\nA1 OK done\r\n', 'MAIL_PROTOCOL'],
		['* NO peer-private\r\nA1 OK done\r\n', 'MAIL_PROTOCOL'],
		['* BAD peer-private\r\nA1 OK done\r\n', 'MAIL_PROTOCOL'],
		['* 1 EXISTS\r\nA1 OK done\r\n', 'MAIL_PROTOCOL'],
		['A1 OK [CAPABILITY AUTH=PLAIN] peer-private\r\n', 'MAIL_PROTOCOL'],
		['A1 OK [CAPABILITY IMAP4rev1 "bad"] peer-private\r\n', 'MAIL_PROTOCOL'],
		['* CAPABILITY IMAP4rev1\r\n* CAPABILITY IMAP4rev1\r\nA1 OK done\r\n', 'MAIL_PROTOCOL'],
		['* CAPABILITY IMAP4rev1] "bad"\r\nA1 OK done\r\n', 'MAIL_PROTOCOL'],
		[`A1 OK [CAPABILITY IMAP4rev1 ${'X '.repeat(64)}X] ready\r\n`, 'MAIL_LIMIT'],
		['A1 OK [ALERT extra] peer-private\r\n', 'MAIL_PROTOCOL'],
		['A1 OK [UIDVALIDITY 1] peer-private\r\n', 'MAIL_PROTOCOL'],
		['A1 OK [READ-ONLY] peer-private\r\n', 'MAIL_PROTOCOL'],
		['A1 OK [ALERT]suffix\r\n', 'MAIL_PROTOCOL'],
		['A1 OK [broken peer-private\r\n', 'MAIL_PROTOCOL'],
	])('rejects completion/status/login data %j', (wire, code) => {
		const command = prepareImapCommand('A1', { kind: 'login', username: 'u', password: '' });
		rejected(() => validateImapCommandResult(command, decode(wire)), code);
		command.bytes.fill(0);
	});
	it('requires exactly the READ-ONLY EXAMINE data and one untagged namespace', () => {
		const command = prepareImapCommand('A1', { kind: 'examine', mailbox: 'INBOX' });
		const data = '* FLAGS (\\Seen)\r\n* 0 EXISTS\r\n* 0 RECENT\r\n';
		const namespace = '* oK [uidvalidity 4294967295] peer-private\r\n';
		const end = 'A1 oK [read-only] peer-private\r\n';
		const extras =
			'* OK [UIDNEXT 1] next\r\n* OK [UNSEEN 1] unseen\r\n* OK [PERMANENTFLAGS (\\Seen \\* $Forwarded)] flags\r\n* OK [HIGHESTMODSEQ 9223372036854775807] metadata\r\n* OK [ALERT] alert\r\n';
		expect(validateImapCommandResult(command, decode(data + namespace + extras + end))).toEqual({
			kind: 'examine',
			uidValidity: '4294967295',
			uidNext: '1',
		});
		for (const wire of [
			data + end,
			namespace + end,
			data + namespace + namespace + end,
			data + namespace + 'A1 OK ordinary\r\n',
			data + 'A1 OK [UIDVALIDITY 1] namespace\r\n',
			data.replace('* 0 RECENT\r\n', '* 0 EXISTS\r\n') + namespace + end,
			data + '* SEARCH 1\r\n' + namespace + end,
			data + namespace + 'A1 OK [READ-WRITE] peer-private\r\n',
			data + namespace + '* OK [HIGHESTMODSEQ 0] invalid\r\n' + end,
			data + namespace + '* OK [HIGHESTMODSEQ 9223372036854775808] overflow\r\n' + end,
			data + namespace + '* OK [HIGHESTMODSEQ 1 extra] invalid\r\n' + end,
			data + namespace + '* OK [NOMODSEQ 1] invalid\r\n' + end,
		])
			rejected(() => validateImapCommandResult(command, decode(wire)));
		expect(
			validateImapCommandResult(
				command,
				decode(data + namespace + '* OK [NOMODSEQ] none\r\n' + end)
			)
		).toEqual({ kind: 'examine', uidValidity: '4294967295' });
		command.bytes.fill(0);
	});
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
		'\\*',
	])('accepts bounded passive PERMANENTFLAGS atom %s', (flag) => {
		const command = prepareImapCommand('A1', { kind: 'examine', mailbox: 'INBOX' });
		const wire = `* FLAGS ()\r\n* 0 EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY 1] valid\r\n* OK [PERMANENTFLAGS (\\Seen ${flag})] metadata\r\nA1 OK [READ-ONLY] done\r\n`;
		expect(validateImapCommandResult(command, decode(wire))).toEqual({
			kind: 'examine',
			uidValidity: '1',
		});
		command.bytes.fill(0);
	});

	it.each([
		'[UIDVALIDITY 0]',
		'[UIDVALIDITY 01]',
		'[UIDVALIDITY 4294967296]',
		'[UIDVALIDITY]',
		'[UIDNEXT 0]',
		'[UNSEEN -1]',
		'[READ-ONLY extra]',
		'[UIDNOTSTICKY]',
		'[PERMANENTFLAGS]',
		'[PERMANENTFLAGS (*)]',
		'[PERMANENTFLAGS (foo*bar)]',
		'[PERMANENTFLAGS (\\foo*)]',
		'[PERMANENTFLAGS (\\**)]',
		'[PERMANENTFLAGS (bad"flag)]',
		'[PERMANENTFLAGS (bad\\flag)]',
		'[PERMANENTFLAGS (bad{flag)]',
		'[PERMANENTFLAGS (bad]flag)]',
		'[PERMANENTFLAGS ( leading)]',
		'[PERMANENTFLAGS (trailing )]',
		'[PERMANENTFLAGS (two  flags)]',
		`[PERMANENTFLAGS (${'+'.repeat(65)})]`,

		'[PERMANENTFLAGS (bad%flag)]',
		'[PERMANENTFLAGS (\\Seen)]tail',
	])('refuses unsupported or malformed EXAMINE status code %s', (code) => {
		const command = prepareImapCommand('A1', { kind: 'examine', mailbox: 'INBOX' });
		const wire = '* FLAGS ()\r\n* 0 EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY 1] valid\r\n';
		rejected(() =>
			validateImapCommandResult(
				command,
				decode(`${wire}* OK ${code} peer-private\r\nA1 OK [READ-ONLY] done\r\n`)
			)
		);
		command.bytes.fill(0);
	});

	it('sorts complete unique SEARCH references, including empty and exact 1024 cap', () => {
		const command = prepareImapCommand('A1', { kind: 'search', fromUid: '1', toUid: '4294967295' });
		expect(validateImapCommandResult(command, decode('* SEARCH\r\nA1 OK done\r\n'))).toEqual({
			kind: 'search',
			uids: [],
		});
		expect(
			validateImapCommandResult(command, decode('* sEaRcH 4294967295 9 1\r\nA1 OK done\r\n'))
		).toEqual({ kind: 'search', uids: ['1', '9', '4294967295'] });
		expect(IMAP_COMMAND_LIMITS.searchUids).toBe(1024);
		const uids = Array.from({ length: 1024 }, (_, i) => String(1024 - i));
		expect(
			validateImapCommandResult(command, decode(`* SEARCH ${uids.join(' ')}\r\nA1 OK done\r\n`))
		).toEqual({ kind: 'search', uids: [...uids].reverse() });
		rejected(
			() =>
				validateImapCommandResult(
					command,
					decode(`* SEARCH ${uids.join(' ')} 1025\r\nA1 OK done\r\n`)
				),
			'MAIL_LIMIT'
		);
		command.bytes.fill(0);
	});

	it.each([
		'* SEARCH 9 9',
		'* SEARCH 8',
		'* SEARCH 11',
		'* SEARCH 9\r\n* SEARCH 10',
		'* 1 EXISTS',
		'',
	])('refuses duplicate, out-of-range or incomplete SEARCH %j', (line) => {
		const command = prepareImapCommand('A1', { kind: 'search', fromUid: '9', toUid: '10' });
		rejected(() =>
			validateImapCommandResult(command, decode(`${line ? line + '\r\n' : ''}A1 OK done\r\n`))
		);
		command.bytes.fill(0);
	});

	it.each([
		[{ kind: 'fetch', uid: '9', content: 'source' }, '', 24 * 1024 * 1024],
		[{ kind: 'fetch', uid: '9', content: 'headers' }, headers, 64 * 1024],
		[{ kind: 'fetch', uid: '9', content: 'part', part: '1.2' }, '1.2', 8 * 1024 * 1024],
	] as const)(
		'transfers exactly one owned literal for %j in either attribute order',
		(input, section, limit) => {
			const command = prepareImapCommand('A1', input);
			expect(command).toMatchObject({ uid: '9', section, literalLimit: limit });
			for (const payload of [Buffer.alloc(0), Buffer.from([0, 255, 13, 10, 41, 123])]) {
				for (const uidFirst of [true, false]) {
					const wire = Buffer.concat([
						Buffer.from(
							`* 7 fEtCh (${uidFirst ? 'uid 9 ' : ''}body[${section.toLowerCase()}] {${payload.length}}\r\n`
						),
						payload,
						Buffer.from(`${uidFirst ? '' : ' UID 9'})\r\nA1 OK done\r\n`),
					]);
					const frames = decode(wire);
					const literal = frames.flatMap((f) =>
						f.kind === 'data' ? f.parts.filter(Buffer.isBuffer) : []
					)[0];
					const result = validateImapCommandResult(command, frames);
					expect(result).toEqual({ kind: 'fetch', uid: '9', bytes: payload });
					if (result.kind !== 'fetch') throw new Error('Expected FETCH');
					expect(result.bytes).toBe(literal);
					wire.fill(0);
					expect(result.bytes).toEqual(payload);
					eraseImapFrameLiterals(frames);
					eraseImapFrameLiterals(frames);
					expect(result.bytes.every((byte) => byte === 0)).toBe(true);
				}
			}
			command.bytes.fill(0);
		}
	);

	it.each([
		'(UID 8 BODY[] {1}\r\nX)',
		'(UID 09 BODY[] {1}\r\nX)',
		'(UID 9 BODY[1] {1}\r\nX)',
		'(UID 9 BODY.PEEK[] {1}\r\nX)',
		'(UID 9 BODY[]<0> {1}\r\nX)',
		'(UID 9 BODY[] {1}\r\nX FLAGS (\\Seen))',
		'(UID 9 UID 9 BODY[] {1}\r\nX)',
		'(UID 9 BODY[] NIL)',
		'(UID 9 BODY[] "X")',
		'(UID 9 BODY[] {1}\r\nX BODY[] {1}\r\nY)',
	])(
		'rejects extra, wrong, partial or nonliteral FETCH attributes %j and erases owned bytes',
		(body) => {
			const command = prepareImapCommand('A1', { kind: 'fetch', uid: '9', content: 'source' });
			const frames = decode(`* 1 FETCH ${body}\r\nA1 OK peer-private\r\n`);
			const literals = frames.flatMap((f) =>
				f.kind === 'data' ? f.parts.filter(Buffer.isBuffer) : []
			);
			rejected(() => validateImapCommandResult(command, frames));
			for (const literal of literals) expect(literal.every((byte) => byte === 0)).toBe(true);
			command.bytes.fill(0);
		}
	);

	it('erases every decoded literal on later failure without altering original wire', () => {
		const command = prepareImapCommand('A1', { kind: 'fetch', uid: '9', content: 'source' });
		for (const ending of [
			'A2 OK wrong\r\n',
			'A1 NO synthetic-secret\r\n',
			'A1 BAD peer-private\r\n',
			'A1 OK [CAPABILITY IMAP4rev1] private\r\n',
			'A1 OK done\r\n',
		]) {
			const wire = Buffer.from(
				`* 1 FETCH (UID 9 BODY[] {1}\r\nX)\r\n* 2 FETCH (UID 9 BODY[] {1}\r\nY)\r\n${ending}`
			);
			const original = Buffer.from(wire);
			const frames = decode(wire);
			const literals = frames.flatMap((f) =>
				f.kind === 'data' ? f.parts.filter(Buffer.isBuffer) : []
			);
			expect(literals).toHaveLength(2);
			rejected(
				() => validateImapCommandResult(command, frames),
				/A1 (NO|BAD)/.test(ending) ? 'MAIL_UNAVAILABLE' : 'MAIL_PROTOCOL'
			);
			expect(literals.map((b) => b.toString('hex'))).toEqual(['00', '00']);
			expect(wire).toEqual(original);
		}
		rejected(() => validateImapCommandResult(command, decode('A1 OK done\r\n')), 'MAIL_STALE');
		command.bytes.fill(0);
	});

	it.each([
		['headers', 64 * 1024],
		['part', 8 * 1024 * 1024],
	] as const)('enforces exact %s literal cap after framing', (content, cap) => {
		const command = prepareImapCommand(
			'A1',
			content === 'part'
				? { kind: 'fetch', uid: '9', content, part: '1' }
				: { kind: 'fetch', uid: '9', content }
		);
		for (const size of [cap, cap + 1]) {
			const wire = Buffer.concat([
				Buffer.from(`* 1 FETCH (UID 9 BODY[${command.section}] {${size}}\r\n`),
				Buffer.alloc(size, 88),
				Buffer.from(')\r\nA1 OK done\r\n'),
			]);
			const frames = decode(wire);
			const literal = frames.flatMap((f) =>
				f.kind === 'data' ? f.parts.filter(Buffer.isBuffer) : []
			)[0];
			if (size === cap) {
				const result = validateImapCommandResult(command, frames);
				expect(result.kind).toBe('fetch');
				if (result.kind === 'fetch') {
					expect(result.uid).toBe('9');
					expect(result.bytes).toBe(literal);
				}
				expect(literal[0]).toBe(88);
				eraseImapFrameLiterals(frames);
			} else rejected(() => validateImapCommandResult(command, frames), 'MAIL_LIMIT');
			expect(literal.every((byte) => byte === 0)).toBe(true);
		}
		command.bytes.fill(0);
	});

	it('validates full-source ceiling and malformed internal frame lengths without wire bypass', () => {
		const command = prepareImapCommand('A1', { kind: 'fetch', uid: '9', content: 'source' });
		const cap = IMAP_FRAMING_LIMITS.literalBytes;
		const wire = Buffer.concat([
			Buffer.from(`* 1 FETCH (UID 9 BODY[] {${cap}}\r\n`),
			Buffer.alloc(cap, 88),
			Buffer.from(')\r\nA1 OK done\r\n'),
		]);
		const frames = decode(wire);
		const result = validateImapCommandResult(command, frames);
		if (result.kind !== 'fetch') throw new Error('Expected FETCH');
		expect(result.bytes.length).toBe(cap);
		eraseImapFrameLiterals(frames);
		expect(result.bytes.every((byte) => byte === 0)).toBe(true);
		// Defensive checks on typed internal records, not supported malformed wire.
		for (const marker of ['2', '99999999999', 'missing']) {
			const literal = Buffer.from('X');
			const corrupt: ImapResponseFrame[] = [
				{
					kind: 'data',
					name: 'FETCH',
					parts: ['* 1 FETCH ', `(UID 9 BODY[] {${marker}}`, literal, ')'],
				},
				...decode('A1 OK done\r\n'),
			];
			rejected(() => validateImapCommandResult(command, corrupt));
			expect(literal[0]).toBe(0);
		}
		command.bytes.fill(0);
	});

	it('requires LOGOUT BYE once and permits only NOOP EXISTS/RECENT data', () => {
		const noop = prepareImapCommand('A1', { kind: 'noop' });
		expect(
			validateImapCommandResult(noop, decode('* 0 EXISTS\r\n* 2 RECENT\r\nA1 OK done\r\n'))
		).toEqual({ kind: 'status' });
		expect(validateImapCommandResult(noop, decode('A1 OK done\r\n'))).toEqual({ kind: 'status' });
		rejected(() => validateImapCommandResult(noop, decode('* FLAGS ()\r\nA1 OK done\r\n')));
		const logout = prepareImapCommand('A1', { kind: 'logout' });
		expect(
			validateImapCommandResult(
				logout,
				decode('* OK warning\r\n* BYE peer-private\r\nA1 OK done\r\n')
			)
		).toEqual({ kind: 'status' });
		for (const wire of [
			'A1 OK done\r\n',
			'* BYE once\r\n* BYE twice\r\nA1 OK done\r\n',
			'* BYE close\r\n* OK late\r\nA1 OK done\r\n',
			'* 1 EXISTS\r\n* BYE close\r\nA1 OK done\r\n',
		])
			rejected(() => validateImapCommandResult(logout, decode(wire)));
		noop.bytes.fill(0);
		logout.bytes.fill(0);
	});

	it('bounds complete response count and erases consumer literals on overflow', () => {
		const command = prepareImapCommand('A1', { kind: 'noop' });
		const frames = decode('* OK opaque\r\n'.repeat(255) + 'A1 OK done\r\n');
		expect(frames).toHaveLength(256);
		expect(validateImapCommandResult(command, frames)).toEqual({ kind: 'status' });
		const literal = Buffer.from('synthetic-secret');
		const extra: ImapResponseFrame = { kind: 'data', name: 'FETCH', parts: [literal] };
		rejected(() => validateImapCommandResult(command, [extra, ...frames]));
		expect(literal.every((byte) => byte === 0)).toBe(true);
		command.bytes.fill(0);
	});
});
