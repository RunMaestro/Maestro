/**
 * Tests for the DataviewJS sandbox bridge validator (src/shared/dataview/sandboxProtocol.ts, D4). This is
 * the trust boundary between note scripts and the app, so every refusal is asserted by its reason, not
 * just by `ok: false`: a test must not pass because a message failed for some other cause.
 */

import { describe, expect, it } from 'vitest';
import {
	parseSandboxMessage,
	SANDBOX_MAX_GUEST_MESSAGE_BYTES,
	type SandboxGuestMessage,
	type SandboxHostMessage,
	type SandboxParseResult,
} from '../../../shared/dataview';

type Raw = Record<string, unknown>;

function guestOk(raw: unknown): SandboxGuestMessage {
	const result = parseSandboxMessage(raw, 'guest');
	if (!result.ok) throw new Error(`expected the guest message to parse, got: ${result.reason}`);
	return result.message;
}

function hostOk(raw: unknown): SandboxHostMessage {
	const result = parseSandboxMessage(raw, 'host');
	if (!result.ok) throw new Error(`expected the host message to parse, got: ${result.reason}`);
	return result.message;
}

function reasonOf(result: SandboxParseResult<SandboxGuestMessage | SandboxHostMessage>): string {
	if (result.ok) throw new Error(`expected a refusal, got ${JSON.stringify(result.message)}`);
	return result.reason;
}

const guestReason = (raw: unknown) => reasonOf(parseSandboxMessage(raw, 'guest'));
const hostReason = (raw: unknown) => reasonOf(parseSandboxMessage(raw, 'host'));

const ioLoad = (path: unknown): Raw => ({ type: 'io.load', requestId: 'r1', path });

/** One valid message of every guest type, keyed by type. */
const VALID_GUEST: Record<SandboxGuestMessage['type'], Raw> = {
	'query.dql': { type: 'query.dql', requestId: 'q1', source: 'LIST FROM #meeting' },
	'io.load': ioLoad('Views/table/view.js'),
	'open.link': { type: 'open.link', kind: 'file', path: 'People/Ada.md', newTab: false },
	'toggle.task': { type: 'toggle.task', path: 'Tasks.md', line: 3, text: 'Ship it' },
	'render.done': { type: 'render.done', blockId: 'b-1', runId: 'run-1', height: 240 },
	'render.error': { type: 'render.error', blockId: 'b-1', runId: 'run-1', message: 'boom' },
	'eval.result': {
		type: 'eval.result',
		runId: 'inline-run-1',
		id: 'expr-1',
		outcome: { kind: 'value', value: 3 },
	},
};

function snapshot(overrides: Raw = {}): Raw {
	return {
		revision: 7,
		files: ['People/Ada.md', 'Meetings/2026-10-01.md', 'img.png'],
		folders: ['People', 'Meetings'],
		stars: ['People/Ada.md'],
		pages: [{ path: 'People/Ada.md', data: { path: 'People/Ada.md', tags: new Set(['#person']) } }],
		...overrides,
	};
}

function run(overrides: Raw = {}): Raw {
	return {
		type: 'run',
		runId: 'run-1',
		blockId: 'b-1',
		source: 'dv.table(["Name"], dv.pages("#person").map(p => [p.file.link]))',
		thisPath: 'People/Ada.md',
		snapshot: snapshot(),
		...overrides,
	};
}

function evalRun(overrides: Raw = {}): Raw {
	return {
		type: 'eval',
		runId: 'inline-run-1',
		thisPath: 'People/Ada.md',
		snapshot: snapshot(),
		expressions: [
			{ id: 'expr-1', source: 'dv.pages().length' },
			{ id: 'expr-2', source: 'dv.current().file.name' },
		],
		...overrides,
	};
}

/** One valid message of every host type, keyed by type. */
const VALID_HOST: Record<SandboxHostMessage['type'], Raw> = {
	run: run(),
	eval: evalRun(),
	'query.dql.result': {
		type: 'query.dql.result',
		requestId: 'q1',
		result: { kind: 'list', items: ['a'], warnings: [], idMeaning: { type: 'path' } },
	},
	'io.load.result': { type: 'io.load.result', requestId: 'r1', text: 'console.log(1)' },
	'request.failed': { type: 'request.failed', requestId: 'r1', message: 'refused' },
};

describe('parseSandboxMessage: valid guest messages', () => {
	it.each(Object.entries(VALID_GUEST))('accepts %s', (_type, raw) => {
		expect(guestOk(raw)).toEqual(raw);
	});

	it('accepts query.dql with an origin path', () => {
		expect(guestOk({ ...VALID_GUEST['query.dql'], originPath: 'Meetings/2026-10-01.md' })).toEqual({
			...VALID_GUEST['query.dql'],
			originPath: 'Meetings/2026-10-01.md',
		});
	});

	it('treats an optional field holding undefined as absent', () => {
		expect(guestOk({ ...VALID_GUEST['query.dql'], originPath: undefined })).toEqual(
			VALID_GUEST['query.dql']
		);
	});

	it('accepts open.link to an http or https page, normalized', () => {
		expect(
			guestOk({ type: 'open.link', kind: 'url', url: 'HTTPS://Example.com', newTab: true })
		).toEqual({ type: 'open.link', kind: 'url', url: 'https://example.com/', newTab: true });
		expect(
			guestOk({ type: 'open.link', kind: 'url', url: 'http://localhost:3000/a?b=1', newTab: false })
		).toMatchObject({ url: 'http://localhost:3000/a?b=1' });
	});

	it('normalizes paths that stay inside the root', () => {
		expect(guestOk(ioLoad('./Views/../People//Ada.md'))).toMatchObject({ path: 'People/Ada.md' });
		expect(guestOk(ioLoad('People\\Ada.md'))).toMatchObject({ path: 'People/Ada.md' });
		expect(
			guestOk({ type: 'toggle.task', path: 'a/b/../Tasks.md/', line: 1, text: '' })
		).toMatchObject({ path: 'a/Tasks.md' });
	});

	it('accepts a zero height and ids made of word characters, dots, colons, and dashes', () => {
		expect(
			guestOk({ type: 'render.done', blockId: 'L12:3.a_b', runId: 'r-0', height: 0 })
		).toMatchObject({ height: 0, blockId: 'L12:3.a_b' });
	});

	it('returns a fresh object holding only the checked fields', () => {
		const raw = { ...VALID_GUEST['io.load'] };
		const message = guestOk(raw);
		expect(message).not.toBe(raw);
		raw.path = '../../etc/passwd';
		expect(message).toMatchObject({ path: 'Views/table/view.js' });
		expect(Object.keys(message).sort()).toEqual(['path', 'requestId', 'type']);
	});
});

describe('parseSandboxMessage: valid host messages', () => {
	it.each(Object.entries(VALID_HOST))('accepts %s', (_type, raw) => {
		expect(hostOk(raw)).toEqual(raw);
	});

	it('accepts io.load.result with null text (no such file)', () => {
		expect(hostOk({ type: 'io.load.result', requestId: 'r1', text: null })).toMatchObject({
			text: null,
		});
	});

	it('passes snapshot page data through by reference, Map and Set included', () => {
		const data = { path: 'People/Ada.md', fields: new Map([['role', 'engineer']]) };
		const message = hostOk(
			run({ snapshot: snapshot({ pages: [{ path: 'People/Ada.md', data }] }) })
		);
		expect(message.type === 'run' && message.snapshot.pages[0].data).toBe(data);
	});

	it('has no size cap: a run snapshot over 1 MB is accepted', () => {
		const files = Array.from({ length: 40_000 }, (_, i) => `Notes/a-long-note-name-${i}.md`);
		expect(JSON.stringify(files).length).toBeGreaterThan(SANDBOX_MAX_GUEST_MESSAGE_BYTES);
		const message = hostOk(run({ snapshot: snapshot({ files }) }));
		expect(message.type === 'run' && message.snapshot.files).toHaveLength(40_000);
	});
});

describe('parseSandboxMessage: direction', () => {
	it.each(Object.keys(VALID_HOST))('refuses the host message %s from a guest', (type) => {
		expect(guestReason(VALID_HOST[type as SandboxHostMessage['type']])).toBe(
			`not a guest message type: ${JSON.stringify(type)}`
		);
	});

	it.each(Object.keys(VALID_GUEST))('refuses the guest message %s from the host', (type) => {
		expect(hostReason(VALID_GUEST[type as SandboxGuestMessage['type']])).toBe(
			`not a host message type: ${JSON.stringify(type)}`
		);
	});
});

describe('parseSandboxMessage: unknown and malformed messages', () => {
	it.each(['query.sql', 'index.snapshot', '', 'IO.LOAD', 'io.load '])(
		'refuses the unknown type %j',
		(type) => {
			expect(guestReason({ ...VALID_GUEST['io.load'], type })).toBe(
				`not a guest message type: ${JSON.stringify(type)}`
			);
		}
	);

	it.each([
		['null', null],
		['undefined', undefined],
		['a string', 'io.load'],
		['a number', 42],
		['an array', [VALID_GUEST['io.load']]],
		['a Map', new Map(Object.entries(VALID_GUEST['io.load']))],
		['a Date', new Date(0)],
	])('refuses %s', (_label, raw) => {
		expect(parseSandboxMessage(raw, 'guest').ok).toBe(false);
		expect(parseSandboxMessage(raw, 'host').ok).toBe(false);
	});

	it('refuses a class instance', () => {
		class FakeMessage {
			type = 'io.load';
			requestId = 'r1';
			path = 'a.md';
		}
		expect(guestReason(new FakeMessage())).toBe('guest message is not a plain object');
	});

	it('refuses a message without a string type', () => {
		expect(guestReason({ requestId: 'r1', path: 'a.md' })).toBe('guest message has no type');
		expect(guestReason({ ...VALID_GUEST['io.load'], type: 7 })).toBe('guest message has no type');
	});

	it('refuses a missing field', () => {
		const { requestId: _dropped, ...raw } = VALID_GUEST['io.load'];
		expect(guestReason(raw)).toBe('io.load is missing requestId');
		expect(hostReason({ ...VALID_HOST['io.load.result'], text: undefined })).toBe(
			'io.load.result is missing text'
		);
	});

	it('refuses an extra field, including a non-enumerable one and a symbol key', () => {
		expect(guestReason({ ...VALID_GUEST['io.load'], encoding: 'utf8' })).toBe(
			'io.load has an unexpected field "encoding"'
		);
		const hidden = Object.defineProperty({ ...VALID_GUEST['io.load'] }, 'extra', {
			value: 1,
			enumerable: false,
		});
		expect(guestReason(hidden)).toBe('io.load has an unexpected field "extra"');
		expect(guestReason({ ...VALID_GUEST['io.load'], [Symbol('x')]: 1 })).toBe(
			'io.load has an unexpected field "Symbol(x)"'
		);
	});

	it('refuses an accessor property', () => {
		const raw = { type: 'io.load', requestId: 'r1' };
		Object.defineProperty(raw, 'path', { get: () => 'a.md', enumerable: true });
		expect(guestReason(raw)).toBe('io.load.path is not a data property');
	});

	it('refuses mistyped fields', () => {
		expect(guestReason({ ...VALID_GUEST['query.dql'], source: 42 })).toBe(
			'query.dql.source is not a string'
		);
		expect(guestReason({ ...VALID_GUEST['open.link'], newTab: 'yes' })).toBe(
			'open.link.newTab is not a boolean'
		);
		expect(guestReason({ ...VALID_GUEST['render.error'], message: { text: 'x' } })).toBe(
			'render.error.message is not a string'
		);
	});

	it.each(['', 'has space', 'a/b', '<script>', 'x'.repeat(129), 'r\n1'])(
		'refuses the id %j',
		(id) => {
			expect(guestReason({ ...VALID_GUEST['io.load'], requestId: id })).toBe(
				'io.load.requestId is not a valid id'
			);
		}
	);

	it.each([0, -1, 1.5, Number.NaN, '3', Number.MAX_SAFE_INTEGER + 1])(
		'refuses the task line %j',
		(line) => {
			expect(guestReason({ ...VALID_GUEST['toggle.task'], line })).toBe(
				'toggle.task.line is not an integer of at least 1'
			);
		}
	);

	it.each([-1, Number.POSITIVE_INFINITY, Number.NaN, '240'])('refuses the height %j', (height) => {
		expect(guestReason({ ...VALID_GUEST['render.done'], height })).toBe(
			'render.done.height is not a finite number of at least 0'
		);
	});

	it.each([
		['javascript:alert(1)', 'open.link.url is not an http or https URL'],
		['file:///etc/passwd', 'open.link.url is not an http or https URL'],
		['data:text/html,<script>alert(1)</script>', 'open.link.url is not an http or https URL'],
		['mailto:someone@example.com', 'open.link.url is not an http or https URL'],
		['not a url', 'open.link.url is not a URL'],
		['//example.com/protocol-relative', 'open.link.url is not a URL'],
	])('refuses the link url %j', (url, reason) => {
		expect(guestReason({ type: 'open.link', kind: 'url', url, newTab: false })).toBe(reason);
	});

	it('refuses an open.link whose kind and target do not match', () => {
		const reason = 'open.link needs kind "file" with a path, or kind "url" with a url';
		expect(
			guestReason({ type: 'open.link', kind: 'file', url: 'https://example.com', newTab: false })
		).toBe(reason);
		expect(guestReason({ type: 'open.link', kind: 'url', path: 'a.md', newTab: false })).toBe(
			reason
		);
		expect(
			guestReason({
				type: 'open.link',
				kind: 'file',
				path: 'a.md',
				url: 'https://example.com',
				newTab: false,
			})
		).toBe(reason);
		expect(guestReason({ type: 'open.link', kind: 'shell', path: 'a.md', newTab: false })).toBe(
			reason
		);
		expect(guestReason({ type: 'open.link', kind: 'file', newTab: false })).toBe(
			'open.link.path is not a string'
		);
	});

	it('refuses malformed host messages', () => {
		expect(hostReason(run({ snapshot: snapshot({ pages: undefined }) }))).toBe(
			'run.snapshot is missing pages'
		);
		expect(hostReason(run({ snapshot: snapshot({ revision: -1 }) }))).toBe(
			'run.snapshot.revision is not an integer of at least 0'
		);
		expect(hostReason(run({ snapshot: snapshot({ files: ['a.md', 7] }) }))).toBe(
			'run.snapshot.files[] is not a string'
		);
		expect(hostReason(run({ snapshot: snapshot({ stars: 'a.md' }) }))).toBe(
			'run.snapshot.stars is not an array'
		);
		expect(hostReason(run({ snapshot: snapshot({ pages: [{ path: 'a.md', data: [] }] }) }))).toBe(
			'run.snapshot.pages[].data is not a plain object'
		);
		expect(hostReason(run({ thisPath: '../outside.md' }))).toBe(
			'run.thisPath is not a path inside the vault root: "../outside.md"'
		);
		expect(hostReason({ ...VALID_HOST['query.dql.result'], result: { kind: 'calendar' } })).toBe(
			'query.dql.result.result.kind is not a Dataview result kind'
		);
		expect(hostReason({ ...VALID_HOST['query.dql.result'], result: [] })).toBe(
			'query.dql.result.result is not a plain object'
		);
		expect(hostReason({ ...VALID_HOST['io.load.result'], text: 42 })).toBe(
			'io.load.result.text is not a string'
		);
	});
});

describe('parseSandboxMessage: inline eval (DEV-5)', () => {
	const evalResult = (outcome: unknown): Raw => ({
		type: 'eval.result',
		runId: 'inline-run-1',
		id: 'expr-1',
		outcome,
	});

	it('accepts every outcome kind', () => {
		expect(guestOk(evalResult({ kind: 'empty' }))).toEqual(evalResult({ kind: 'empty' }));
		expect(guestOk(evalResult({ kind: 'value', value: null }))).toMatchObject({
			outcome: { kind: 'value', value: null },
		});
		expect(guestOk(evalResult({ kind: 'error', message: 'Error: boom' }))).toMatchObject({
			outcome: { kind: 'error', message: 'Error: boom' },
		});
	});

	it('copies a value as plain JSON, without __proto__ keys or anything JSON cannot hold', () => {
		const value = JSON.parse('{"a":[1,{"b":"c"}],"__proto__":{"polluted":true}}');
		value.when = new Date(0);
		const message = guestOk(evalResult({ kind: 'value', value }));
		if (message.type !== 'eval.result' || message.outcome.kind !== 'value') throw new Error('kind');
		expect(message.outcome.value).not.toBe(value);
		expect(message.outcome.value).toEqual({ a: [1, { b: 'c' }], when: '1970-01-01T00:00:00.000Z' });
		expect(Object.prototype.hasOwnProperty.call(message.outcome.value, '__proto__')).toBe(false);
	});

	it('refuses a malformed outcome', () => {
		expect(guestReason(evalResult({ kind: 'value' }))).toBe(
			'eval.result.outcome of kind "value" has no value'
		);
		expect(guestReason(evalResult({ kind: 'value', value: 1, message: 'x' }))).toBe(
			'eval.result.outcome of kind "value" has a message'
		);
		expect(guestReason(evalResult({ kind: 'empty', value: 1 }))).toBe(
			'eval.result.outcome of kind "empty" has fields'
		);
		expect(guestReason(evalResult({ kind: 'error', value: 1, message: 'x' }))).toBe(
			'eval.result.outcome of kind "error" has a value'
		);
		expect(guestReason(evalResult({ kind: 'error', message: 7 }))).toBe(
			'eval.result.outcome.message is not a string'
		);
		expect(guestReason(evalResult({ kind: 'html' }))).toBe(
			'eval.result.outcome.kind is not "value", "empty", or "error"'
		);
		expect(guestReason(evalResult({ kind: 'value', value: 1, extra: 1 }))).toBe(
			'eval.result.outcome has an unexpected field "extra"'
		);
		expect(guestReason({ ...evalResult({ kind: 'empty' }), id: 'not an id!' })).toBe(
			'eval.result.id is not a valid id'
		);
	});

	it('refuses a malformed eval run', () => {
		expect(hostReason(evalRun({ expressions: 'dv.pages()' }))).toBe(
			'eval.expressions is not an array'
		);
		expect(hostReason(evalRun({ expressions: [{ id: 'expr-1' }] }))).toBe(
			'eval.expressions[] is missing source'
		);
		expect(hostReason(evalRun({ expressions: [{ id: '', source: 'x' }] }))).toBe(
			'eval.expressions[].id is not a valid id'
		);
		expect(hostReason(evalRun({ thisPath: '/etc/passwd' }))).toBe(
			'eval.thisPath is not a path inside the vault root: "/etc/passwd"'
		);
	});
});

describe('parseSandboxMessage: payload size', () => {
	/** A render.error whose JSON is exactly `bytes` long (the message is ASCII). */
	function errorOfSize(bytes: number): Raw {
		const base = { ...VALID_GUEST['render.error'], message: '' };
		return { ...base, message: 'x'.repeat(bytes - JSON.stringify(base).length) };
	}

	it('accepts a guest message of exactly 1 MB', () => {
		expect(guestOk(errorOfSize(SANDBOX_MAX_GUEST_MESSAGE_BYTES)).type).toBe('render.error');
	});

	it('refuses a guest message one byte over 1 MB', () => {
		expect(guestReason(errorOfSize(SANDBOX_MAX_GUEST_MESSAGE_BYTES + 1))).toBe(
			`guest message is ${SANDBOX_MAX_GUEST_MESSAGE_BYTES + 1} bytes, over the ${SANDBOX_MAX_GUEST_MESSAGE_BYTES}-byte cap`
		);
	});

	it('counts UTF-8 bytes, not characters', () => {
		// 400,000 euro signs: 400,000 UTF-16 units, but 1,200,000 bytes of UTF-8.
		const raw = { ...VALID_GUEST['query.dql'], source: '\u20ac'.repeat(400_000) };
		expect(JSON.stringify(raw).length).toBeLessThan(SANDBOX_MAX_GUEST_MESSAGE_BYTES);
		expect(guestReason(raw)).toMatch(/^guest message is 1200\d{3} bytes, over the/);
	});

	it('refuses an oversized path before reading it', () => {
		expect(guestReason(ioLoad(`${'a/'.repeat(600_000)}x.md`))).toMatch(/-byte cap$/);
	});

	it('refuses a guest message that is not JSON', () => {
		expect(guestReason({ ...VALID_GUEST['toggle.task'], line: BigInt(3) })).toBe(
			'guest message is not JSON'
		);
		const circular: Raw = { ...VALID_GUEST['io.load'] };
		circular.self = circular;
		expect(guestReason(circular)).toBe('guest message is not JSON');
	});
});

describe('parseSandboxMessage: paths', () => {
	const PATH_FIELDS: [string, (path: string) => Raw][] = [
		['io.load.path', (path) => ioLoad(path)],
		['query.dql.originPath', (path) => ({ ...VALID_GUEST['query.dql'], originPath: path })],
		['open.link.path', (path) => ({ ...VALID_GUEST['open.link'], path })],
		['toggle.task.path', (path) => ({ ...VALID_GUEST['toggle.task'], path })],
	];

	const ESCAPES = [
		// `../` traversal, either separator, and after normalization.
		'../secret.md',
		'..',
		'../../../../etc/passwd',
		'People/../../secret.md',
		'./../secret.md',
		'People/./../../secret.md',
		'..\\secret.md',
		'People\\..\\..\\secret.md',
		'People/..\\../secret.md',
		// Absolute paths.
		'/etc/passwd',
		'/Users/pedram/vault/People/Ada.md',
		'\\Windows\\win.ini',
		'//server/share/secret.md',
		'\\\\server\\share\\secret.md',
		'\\\\?\\C:\\Windows\\win.ini',
		// Windows drive paths, drive-relative included.
		'C:\\Windows\\win.ini',
		'C:/Windows/win.ini',
		'c:secret.md',
		'D:',
		// Segments Windows trims into `..`, and NUL.
		'.. /secret.md',
		'People/.../x.md',
		'People/. ./x.md',
		'a.md\0.png',
	];

	describe.each(PATH_FIELDS)('%s', (field, build) => {
		it.each(ESCAPES)('refuses %j', (path) => {
			expect(guestReason(build(path))).toBe(
				`${field} is not a path inside the vault root: ${JSON.stringify(path)}`
			);
		});

		it.each(['', '.', './', 'People/..'])('refuses %j, which names the vault root', (path) => {
			expect(guestReason(build(path))).toBe(`${field} names the vault root itself`);
		});
	});
});

describe('parseSandboxMessage: prototype pollution', () => {
	it('refuses an own __proto__ key and leaves Object.prototype alone', () => {
		const raw = JSON.parse(
			'{"type":"io.load","requestId":"r1","path":"a.md","__proto__":{"polluted":true}}'
		);
		expect(Object.prototype.hasOwnProperty.call(raw, '__proto__')).toBe(true);
		expect(guestReason(raw)).toBe('io.load has an unexpected field "__proto__"');
		expect(({} as Raw).polluted).toBeUndefined();
	});

	it('refuses an own constructor or prototype key', () => {
		expect(
			guestReason({ ...VALID_GUEST['io.load'], constructor: { prototype: { polluted: true } } })
		).toBe('io.load has an unexpected field "constructor"');
		expect(guestReason({ ...VALID_GUEST['render.done'], prototype: {} })).toBe(
			'render.done has an unexpected field "prototype"'
		);
		expect(({} as Raw).polluted).toBeUndefined();
	});

	it('refuses fields inherited from a prototype instead of owned', () => {
		const inherited = Object.create({ ...VALID_GUEST['io.load'] });
		expect(guestReason(inherited)).toBe('guest message is not a plain object');
		const literal = { __proto__: { requestId: 'r1', path: 'a.md' }, type: 'io.load' };
		expect(guestReason(literal)).toBe('guest message is not a plain object');
	});

	it.each(['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty', 'valueOf'])(
		'refuses %j as a message type',
		(type) => {
			expect(guestReason({ ...VALID_GUEST['io.load'], type })).toBe(
				`not a guest message type: ${JSON.stringify(type)}`
			);
			expect(hostReason({ ...VALID_HOST['request.failed'], type })).toBe(
				`not a host message type: ${JSON.stringify(type)}`
			);
		}
	);

	it('refuses a __proto__ key inside a host snapshot', () => {
		const page = JSON.parse('{"path":"a.md","data":{},"__proto__":{"polluted":true}}');
		expect(hostReason(run({ snapshot: snapshot({ pages: [page] }) }))).toBe(
			'run.snapshot.pages[] has an unexpected field "__proto__"'
		);
		const snap = JSON.parse(
			'{"revision":1,"files":[],"folders":[],"stars":[],"pages":[],"__proto__":{"polluted":true}}'
		);
		expect(hostReason(run({ snapshot: snap }))).toBe(
			'run.snapshot has an unexpected field "__proto__"'
		);
		expect(({} as Raw).polluted).toBeUndefined();
	});

	it('accepts a null-prototype message', () => {
		const raw = Object.assign(Object.create(null), VALID_GUEST['io.load']);
		expect(guestOk(raw)).toEqual(VALID_GUEST['io.load']);
	});
});
