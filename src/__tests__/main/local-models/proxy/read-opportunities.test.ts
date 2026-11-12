/**
 * @file read-opportunities.test.ts
 *
 * The read/repetition analyzer: it relates the file reads one request shows,
 * and only when the evidence says "same file, same range, still in context".
 * Everything else is an unsupported finding with a reason, never a reference,
 * and nothing it does can change a request or a cached verdict.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({
	app: { getPath: () => '/tmp/read-opportunities-unused' },
}));

vi.mock('../../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../../main/prompt-manager', () => ({
	getPrompt: vi.fn((id: string) => `PROMPT:${id}`),
}));

vi.mock('../../../../main/local-models/task-router', () => ({
	runLocalTask: vi.fn(),
}));

// The analyzer never opens the cache. Any use of these two accessors fails the test.
vi.mock('../../../../main/local-models/proxy/compression-cache', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('../../../../main/local-models/proxy/compression-cache')>();
	return {
		...actual,
		getCompressionCache: vi.fn(() => {
			throw new Error('the read analyzer must not open the compression cache');
		}),
		createCompressionCache: vi.fn(() => {
			throw new Error('the read analyzer must not create a compression cache');
		}),
	};
});

import {
	analyzeReadOpportunities,
	READ_OPPORTUNITY_LIMITS,
	readEventsFromDescriptors,
	withoutLineNumbers,
	type ReadFinding,
	type ReadOpportunityLimits,
	type ReadOpportunityReport,
} from '../../../../main/local-models/proxy/read-opportunities';
import {
	findToolResultDescriptors,
	formatCompressionMarker,
} from '../../../../main/local-models/proxy/compress';
import {
	contentHash,
	createCompressionCache,
	getCompressionCache,
} from '../../../../main/local-models/proxy/compression-cache';
import { parseJsonSpans } from '../../../../main/local-models/proxy/json-spans';
import {
	body,
	deepFreeze,
	EDITED,
	event,
	FILE,
	LINES,
	numbered,
	read,
	ROOT,
	type ApiKind,
	type Item,
} from '../../../helpers/proxyReadRequests';

/** Both steps of the analyzer, over a request body, the way a caller composes them. */
function analyze(
	kind: ApiKind,
	items: Item[],
	options: {
		extra?: Record<string, unknown>;
		roots?: string[];
		limits?: Partial<ReadOpportunityLimits>;
	} = {}
): ReadOpportunityReport {
	const text = body(kind, items, options.extra);
	const root = parseJsonSpans(text);
	if (!root) throw new Error('fixture is not JSON');
	const scan = readEventsFromDescriptors({
		kind,
		body: text,
		root,
		descriptors: findToolResultDescriptors(kind, text, root),
		roots: options.roots ?? [ROOT],
		limits: options.limits,
	});
	return analyzeReadOpportunities(scan.events, { complete: scan.complete });
}

const reasons = (report: ReadOpportunityReport) =>
	report.findings.map((finding) =>
		finding.status === 'unsupported' ? finding.reason : finding.status
	);

function only<S extends ReadFinding['status']>(
	report: ReadOpportunityReport,
	status: S,
	index = 0
): Extract<ReadFinding, { status: S }> {
	const matches = report.findings.filter(
		(finding): finding is Extract<ReadFinding, { status: S }> => finding.status === status
	);
	return matches[index];
}

describe('read opportunities: pairing through the descriptor path', () => {
	it.each(['anthropic-messages', 'openai-chat-completions', 'openai-responses'] as const)(
		'pairs an identical re-read in %s and keeps both source hashes',
		(kind) => {
			const text = numbered(LINES);
			const toolName = kind === 'anthropic-messages' ? 'Read' : 'read_file';
			const report = analyze(kind, [
				read(text, undefined, toolName),
				read(text, undefined, toolName),
			]);

			expect(reasons(report)).toEqual(['first', 'repeat']);
			const repeat = only(report, 'repeat');
			expect(repeat.relation).toBe('identical');
			expect(repeat.baseline.order).toBe(0);
			expect(repeat.read.order).toBe(1);
			expect(repeat.baseline.hash).toBe(contentHash(text));
			expect(repeat.read.hash).toBe(contentHash(text));
			expect(repeat.read).toMatchObject({
				path: FILE,
				offset: null,
				limit: null,
				numbered: { startLine: 1, endLine: 3 },
				chars: text.length,
				lines: 3,
			});
			expect(report.counts).toMatchObject({ examined: 2, first: 1, identical: 1, changed: 0 });
			expect(report).toMatchObject({ version: 1, mode: 'observation', complete: true });
		}
	);

	it('calls a re-read with different text changed and keeps each version hash', () => {
		const before = numbered(LINES);
		const after = numbered(EDITED);
		const report = analyze('anthropic-messages', [read(before), read(after)]);

		const repeat = only(report, 'repeat');
		expect(repeat.relation).toBe('changed');
		expect(repeat.baseline.hash).toBe(contentHash(before));
		expect(repeat.read.hash).toBe(contentHash(after));
		expect(report.counts).toMatchObject({ first: 1, identical: 0, changed: 1 });
	});

	it('pairs each read with the nearest earlier one', () => {
		const report = analyze('anthropic-messages', [
			read(numbered(LINES)),
			read(numbered(EDITED)),
			read(numbered(EDITED)),
		]);

		expect(reasons(report)).toEqual(['first', 'repeat', 'repeat']);
		const [changed, identical] = [only(report, 'repeat', 0), only(report, 'repeat', 1)];
		expect(changed).toMatchObject({
			relation: 'changed',
			baseline: { order: 0 },
			read: { order: 1 },
		});
		expect(identical).toMatchObject({
			relation: 'identical',
			baseline: { order: 1 },
			read: { order: 2 },
		});
	});

	it('numbers events by descriptor position, so other tools leave gaps', () => {
		const report = analyze('anthropic-messages', [
			read(numbered(LINES)),
			{ tool: 'Bash', input: { command: 'cat src/a.ts' }, output: numbered(LINES) },
			read(numbered(LINES)),
		]);

		expect(report.findings).toHaveLength(2);
		expect(only(report, 'repeat').read.order).toBe(2);
	});

	it('ignores tools that are not reads, even when their output is a file', () => {
		const report = analyze('anthropic-messages', [
			{ tool: 'Bash', input: { command: 'cat src/a.ts' }, output: numbered(LINES) },
			{
				tool: 'Task',
				input: { description: 'read it', prompt: 'read it' },
				output: numbered(LINES),
			},
			{ tool: 'mcp__files__read', input: { path: FILE }, output: numbered(LINES) },
		]);

		expect(report.findings).toEqual([]);
		expect(report.counts.examined).toBe(0);
	});

	it('does not read a result whose call is not in the request', () => {
		const text = JSON.stringify({
			model: 'claude-test',
			messages: [
				{ role: 'user', content: 'Look.' },
				{
					role: 'user',
					content: [{ type: 'tool_result', tool_use_id: 'ghost', content: numbered(LINES) }],
				},
			],
		});
		const root = parseJsonSpans(text)!;
		const scan = readEventsFromDescriptors({
			kind: 'anthropic-messages',
			body: text,
			root,
			descriptors: findToolResultDescriptors('anthropic-messages', text, root),
			roots: [ROOT],
		});

		expect(scan.events).toEqual([]);
	});

	it('compares a Windows path the same however its separators were spelled', () => {
		const report = analyze(
			'openai-chat-completions',
			[
				read(numbered(LINES), { file_path: 'C:\\work\\app\\src\\a.ts' }, 'read_file'),
				read(numbered(LINES), { file_path: 'C:/work//app/src/a.ts' }, 'read_file'),
			],
			{ roots: ['C:\\work\\app'] }
		);

		expect(reasons(report)).toEqual(['first', 'repeat']);
		expect(only(report, 'first').read.path).toBe('C:/work/app/src/a.ts');
	});

	it('compares POSIX paths after the shared normalizer, and no further', () => {
		const report = analyze('anthropic-messages', [
			read(numbered(LINES), { file_path: `${ROOT}/src//a.ts` }),
			read(numbered(LINES), { file_path: `${ROOT}/src/a.ts` }),
			read(numbered(LINES), { file_path: `${ROOT}/src/A.ts` }),
		]);

		// A different spelling of the case is a different file as far as the proof goes.
		expect(reasons(report)).toEqual(['first', 'repeat', 'first']);
	});

	it('accepts the path spellings of the supported dialects', () => {
		for (const key of ['file_path', 'filePath', 'path', 'absolute_path']) {
			const report = analyze('openai-responses', [
				read(numbered(LINES), { [key]: FILE }, 'read_file'),
				read(numbered(LINES), { [key]: FILE }, 'read_file'),
			]);
			expect(reasons(report)).toEqual(['first', 'repeat']);
		}
	});

	it('matches tool names across provider spellings', () => {
		const report = analyze('openai-chat-completions', [
			read(numbered(LINES), undefined, 'read_file'),
			read(numbered(LINES), undefined, 'readFile'),
		]);

		expect(reasons(report)).toEqual(['first', 'repeat']);
	});
});

describe('read opportunities: ranges and numbering', () => {
	it('pairs reads that sent the same offset and limit', () => {
		const slice = numbered(LINES.slice(1), 2);
		const input = { file_path: FILE, offset: 2, limit: 2 };
		const report = analyze('anthropic-messages', [read(slice, input), read(slice, input)]);

		expect(reasons(report)).toEqual(['first', 'repeat']);
		expect(only(report, 'repeat').read).toMatchObject({
			offset: 2,
			limit: 2,
			numbered: { startLine: 2, endLine: 3 },
		});
	});

	it('does not relate a different range of the same file when the lines may overlap', () => {
		const report = analyze('anthropic-messages', [
			read(numbered(LINES)),
			read(numbered(LINES.slice(1, 2), 2), { file_path: FILE, offset: 2, limit: 1 }),
		]);

		expect(reasons(report)).toEqual(['first', 'partial-range']);
		expect(report.counts.unsupportedByReason).toEqual({ 'partial-range': 1 });
	});

	it('does not relate ranges of a tool that prints no line numbers either', () => {
		const report = analyze('openai-responses', [
			read(LINES.join('\n'), { path: FILE }, 'read_file'),
			read(LINES[0], { path: FILE, offset: 0, limit: 1 }, 'read_file'),
		]);

		expect(reasons(report)).toEqual(['first', 'partial-range']);
	});

	it('keeps ranges whose printed numbers cannot overlap apart without calling them partial', () => {
		const report = analyze('anthropic-messages', [
			read(numbered(LINES.slice(0, 2)), { file_path: FILE, offset: 1, limit: 2 }),
			read(numbered(LINES.slice(2), 3), { file_path: FILE, offset: 3, limit: 2 }),
		]);

		expect(reasons(report)).toEqual(['first', 'first']);
	});

	it('still pairs a whole-file read with its predecessor across a partial read of the same file', () => {
		const report = analyze('anthropic-messages', [
			read(numbered(LINES)),
			read(numbered(LINES.slice(1, 2), 2), { file_path: FILE, offset: 2, limit: 1 }),
			read(numbered(LINES)),
		]);

		expect(reasons(report)).toEqual(['first', 'partial-range', 'repeat']);
		expect(only(report, 'repeat').baseline.order).toBe(0);
	});

	it('reads the older tab-separated numbering', () => {
		const text = numbered(LINES, 1, '\t');
		const report = analyze('anthropic-messages', [read(text), read(text)]);

		expect(only(report, 'repeat').read.numbered).toEqual({ startLine: 1, endLine: 3 });
	});

	it('compares text that carries no numbering as plain text', () => {
		const text = LINES.join('\n');
		const report = analyze('openai-responses', [
			read(text, { path: FILE }, 'read_file'),
			read(LINES.join('\n').replace('b = 2', 'b = 3'), { path: FILE }, 'read_file'),
		]);

		expect(only(report, 'repeat')).toMatchObject({
			relation: 'changed',
			read: { numbered: null },
			baseline: { numbered: null },
		});
	});

	it.each([
		['numbers out of sequence', '     1→a\n     3→b'],
		['a line that lost its number', '     1→a\n     2→b\n\n<reminder>keep going</reminder>'],
		['a repeated number', '     1→a\n     1→b'],
	])('refuses a result with %s and never uses it as a baseline', (_name, text) => {
		const report = analyze('anthropic-messages', [read(text), read(text)]);

		expect(reasons(report)).toEqual(['unknown-numbering', 'unknown-numbering']);
		// The text was examined, so its hash is still preserved.
		expect(only(report, 'unsupported').version?.hash).toBe(contentHash(text));
		expect(only(report, 'unsupported').version?.numbered).toBeNull();
	});

	it('refuses to relate equal requests when only one result prints line numbers', () => {
		const report = analyze('anthropic-messages', [read(numbered(LINES)), read(LINES.join('\n'))]);

		expect(reasons(report)).toEqual(['first', 'unknown-numbering']);
	});

	it('refuses to relate equal requests that number from different lines', () => {
		const report = analyze('anthropic-messages', [
			read(numbered(LINES, 1), { file_path: FILE, limit: 3 }),
			read(numbered(LINES, 5), { file_path: FILE, limit: 3 }),
		]);

		expect(reasons(report)).toEqual(['first', 'unknown-numbering']);
	});

	it('counts lines the way a final line feed ends one and starts none', () => {
		const lines = (text: string) =>
			only(analyzeReadOpportunities([event(0, { text })]), 'first').read.lines;

		expect([
			lines(''),
			lines('a'),
			lines('a\n'),
			lines('a\n\n'),
			lines('\n'),
			lines('a\nb'),
		]).toEqual([0, 1, 1, 2, 1, 2]);
	});
});

describe('read opportunities: results that are not a file read', () => {
	it('refuses binary-looking text but keeps its hash', () => {
		const text = `${numbered(LINES)}\0\0`;
		const report = analyze('anthropic-messages', [read(text), read(text)]);

		expect(reasons(report)).toEqual(['binary-looking', 'binary-looking']);
		expect(only(report, 'unsupported').version).toMatchObject({
			hash: contentHash(text),
			chars: text.length,
		});
	});

	it('refuses a failed read', () => {
		const report = analyze('anthropic-messages', [
			{ ...read('File does not exist.'), isError: true },
			read(numbered(LINES)),
		]);

		expect(reasons(report)).toEqual(['failed-read', 'first']);
		expect(only(report, 'unsupported').version).toBeNull();
	});

	it('does not let a failed read break the chain between two good ones', () => {
		const report = analyze('anthropic-messages', [
			read(numbered(LINES)),
			{ ...read('Permission denied.'), isError: true },
			read(numbered(LINES)),
		]);

		expect(reasons(report)).toEqual(['first', 'failed-read', 'repeat']);
		expect(only(report, 'repeat').baseline.order).toBe(0);
	});

	it('refuses text the proxy already compressed', () => {
		const original = numbered(LINES);
		const text = `${numbered(LINES.slice(0, 1))}\n${formatCompressionMarker(contentHash(original), 900)}`;
		const report = analyze('anthropic-messages', [read(text), read(original)]);

		expect(reasons(report)).toEqual(['compressed-text', 'first']);
	});

	it('refuses a result that is not exactly one plain text', () => {
		const report = analyze('anthropic-messages', [
			read(numbered(LINES)),
			{
				...read(''),
				output: [
					{ type: 'text', text: numbered(LINES) },
					{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
				],
			},
			{
				...read(''),
				output: [
					{ type: 'text', text: numbered(LINES.slice(0, 1)) },
					{ type: 'text', text: numbered(LINES.slice(1), 2) },
				],
			},
		]);

		expect(reasons(report)).toEqual(['first', 'non-text-content', 'non-text-content']);
	});

	it('accepts a result sent as a list holding one text part', () => {
		const text = numbered(LINES);
		const report = analyze('anthropic-messages', [
			read(text),
			{ ...read(''), output: [{ type: 'text', text }] },
		]);

		expect(only(report, 'repeat').relation).toBe('identical');
	});

	it.each([
		['an unknown parameter', { file_path: FILE, pages: '1-3' }],
		['two path parameters', { file_path: FILE, path: FILE }],
		['no path', { offset: 1 }],
		['a string offset', { file_path: FILE, offset: '10' }],
		['a negative offset', { file_path: FILE, offset: -1 }],
		['a fractional limit', { file_path: FILE, limit: 1.5 }],
		['an offset of ten digits', { file_path: FILE, offset: 1234567890 }],
	])('refuses a call with %s', (_name, input) => {
		const report = analyze('anthropic-messages', [read(numbered(LINES), input)]);

		expect(reasons(report)).toEqual(['unsupported-parameters']);
	});

	it('refuses a count spelled with an exponent, which JSON.parse would read as 100', () => {
		const text = body('anthropic-messages', [
			read(numbered(LINES), { file_path: FILE, limit: 100 }),
		]).replace('"limit":100', '"limit":1e2');
		const root = parseJsonSpans(text)!;
		const scan = readEventsFromDescriptors({
			kind: 'anthropic-messages',
			body: text,
			root,
			descriptors: findToolResultDescriptors('anthropic-messages', text, root),
			roots: [ROOT],
		});

		expect(text).toContain('"limit":1e2');
		expect(scan.events).toMatchObject([{ status: 'skipped', reason: 'unsupported-parameters' }]);
	});

	it('refuses a call whose arguments are not JSON', () => {
		const report = analyze('openai-chat-completions', [
			{ tool: 'read_file', input: '{"path": "', output: numbered(LINES) },
		]);

		expect(reasons(report)).toEqual(['unsupported-parameters']);
	});

	it('treats a null offset or limit as absent', () => {
		const input = { file_path: FILE, offset: null, limit: null };
		const report = analyze('anthropic-messages', [
			read(numbered(LINES), input),
			read(numbered(LINES)),
		]);

		expect(reasons(report)).toEqual(['first', 'repeat']);
	});

	it.each([
		['a relative path', 'src/a.ts'],
		['a dot segment', `${ROOT}/./src/a.ts`],
		['a dot-dot segment', `${ROOT}/src/../src/a.ts`],
		['a leading double slash', `/${ROOT}/src/a.ts`],
		['a drive-relative path', '\\work\\app\\src\\a.ts'],
		['a newline', `${ROOT}/src/a.ts\n`],
		['more characters than any system accepts', `${ROOT}/${'d/'.repeat(2100)}a.ts`],
	])('refuses %s because it does not name one file', (_name, file) => {
		const report = analyze('anthropic-messages', [read(numbered(LINES), { file_path: file })]);

		expect(reasons(report)).toEqual(['unresolved-path']);
		expect(only(report, 'unsupported').read.path).toBeNull();
	});

	it.each([
		['a path outside every root', '/etc/hosts', [ROOT]],
		['a sibling that only shares the root prefix', '/work/app-other/a.ts', [ROOT]],
		['a path when no root is supplied', FILE, []],
		['a path when the only root is relative', FILE, ['work/app']],
	])('refuses %s as outside the workspace', (_name, file, roots) => {
		const report = analyze('anthropic-messages', [read(numbered(LINES), { file_path: file })], {
			roots,
		});

		expect(reasons(report)).toEqual(['outside-workspace']);
		expect(only(report, 'unsupported').read.path).toBe(file);
	});

	it('accepts a read under a root given with a trailing slash', () => {
		const report = analyze('anthropic-messages', [read(numbered(LINES))], { roots: [`${ROOT}/`] });

		expect(reasons(report)).toEqual(['first']);
	});
});

describe('read opportunities: bounds', () => {
	it('names the explicit bounds and freezes them', () => {
		expect(READ_OPPORTUNITY_LIMITS).toEqual({
			maxReads: 256,
			maxResultChars: 1_048_576,
			maxTotalChars: 8_388_608,
		});
		expect(Object.isFrozen(READ_OPPORTUNITY_LIMITS)).toBe(true);
	});

	it('does not decode a result longer than the per-result bound', () => {
		const text = numbered(LINES);
		const report = analyze('anthropic-messages', [read(text), read('short')], {
			limits: { maxResultChars: text.length - 1 },
		});

		expect(reasons(report)).toEqual(['too-large', 'first']);
		expect(report.complete).toBe(true);
	});

	it('stops examining reads past the read bound and says the report is incomplete', () => {
		const report = analyze(
			'anthropic-messages',
			[read(numbered(LINES)), read(numbered(LINES)), read(numbered(LINES))],
			{ limits: { maxReads: 2 } }
		);

		expect(reasons(report)).toEqual(['first', 'repeat', 'over-budget']);
		expect(report.complete).toBe(false);
	});

	it('stops decoding once the total bound is spent', () => {
		const text = numbered(LINES);
		const report = analyze('anthropic-messages', [read(text), read(text), read(text)], {
			limits: { maxTotalChars: text.length + 1 },
		});

		expect(reasons(report)).toEqual(['first', 'over-budget', 'over-budget']);
		expect(report.complete).toBe(false);
	});

	it('does not count reads of other tools against the read bound', () => {
		const report = analyze(
			'anthropic-messages',
			[
				{ tool: 'Bash', input: { command: 'ls' }, output: 'a.ts' },
				{ tool: 'Bash', input: { command: 'ls' }, output: 'a.ts' },
				read(numbered(LINES)),
			],
			{ limits: { maxReads: 1 } }
		);

		expect(reasons(report)).toEqual(['first']);
		expect(report.complete).toBe(true);
	});
});

describe('read opportunities: ambiguous identity and history', () => {
	it('refuses results whose tool id is shared and relates nothing', () => {
		const report = analyze('anthropic-messages', [
			{ ...read(numbered(LINES)), id: 'dup' },
			{ ...read(numbered(LINES)), id: 'dup' },
		]);

		expect(reasons(report)).toEqual(['ambiguous-tool-id', 'ambiguous-tool-id']);
		expect(only(report, 'unsupported').read.tool).toBeNull();
		expect(report.counts.first + report.counts.identical + report.counts.changed).toBe(0);
	});

	it.each(['openai-chat-completions', 'openai-responses'] as const)(
		'refuses a shared tool id in %s too',
		(kind) => {
			const report = analyze(kind, [
				{ ...read(numbered(LINES), undefined, 'read_file'), id: 'dup' },
				{ ...read(numbered(LINES), undefined, 'read_file'), id: 'dup' },
			]);

			expect(reasons(report)).toEqual(['ambiguous-tool-id', 'ambiguous-tool-id']);
		}
	);

	it.each([
		['previous_response_id', { previous_response_id: 'resp_1' }],
		['conversation', { conversation: 'conv_1' }],
	])(
		'refuses every read of a Responses request that continues server history (%s)',
		(_name, extra) => {
			const report = analyze(
				'openai-responses',
				[
					read(numbered(LINES), undefined, 'read_file'),
					read(numbered(LINES), undefined, 'read_file'),
				],
				{ extra }
			);

			expect(reasons(report)).toEqual(['incremental-history', 'incremental-history']);
		}
	);

	it('analyzes a Responses request whose continuation fields are null', () => {
		const report = analyze(
			'openai-responses',
			[
				read(numbered(LINES), undefined, 'read_file'),
				read(numbered(LINES), undefined, 'read_file'),
			],
			{ extra: { previous_response_id: null, conversation: null } }
		);

		expect(reasons(report)).toEqual(['first', 'repeat']);
	});

	it('does not read a continuation field on an API that has none', () => {
		const report = analyze('anthropic-messages', [read(numbered(LINES)), read(numbered(LINES))], {
			extra: { previous_response_id: 'resp_1' },
		});

		expect(reasons(report)).toEqual(['first', 'repeat']);
	});

	it.each([
		['Messages', 'anthropic-messages', { edits: [{ type: 'clear_tool_uses_20250919' }] }],
		['Responses', 'openai-responses', [{ type: 'compaction', compact_threshold: 1000 }]],
	] as const)(
		'refuses reads when %s asks the provider to manage the context',
		(_name, kind, managed) => {
			const toolName = kind === 'anthropic-messages' ? 'Read' : 'read_file';
			const report = analyze(
				kind,
				[read(numbered(LINES), undefined, toolName), read(numbered(LINES), undefined, toolName)],
				{ extra: { context_management: managed } }
			);

			expect(reasons(report)).toEqual(['managed-context', 'managed-context']);
		}
	);

	it('analyzes a request whose context_management is null', () => {
		const report = analyze('anthropic-messages', [read(numbered(LINES)), read(numbered(LINES))], {
			extra: { context_management: null },
		});

		expect(reasons(report)).toEqual(['first', 'repeat']);
	});
});

describe('read opportunities: resets and other contexts', () => {
	const toolName = { 'anthropic-messages': 'Read', 'openai-responses': 'read_file' } as const;

	it.each(['anthropic-messages', 'openai-responses'] as const)(
		'refuses to reach across a compaction item in %s, and relates the reads after it',
		(kind) => {
			const text = numbered(LINES);
			const step = () => read(text, undefined, toolName[kind]);
			const report = analyze(kind, [step(), step(), 'compaction', step(), step()]);

			expect(reasons(report)).toEqual(['first', 'repeat', 'reset-between', 'repeat']);
			// The read after the reset is the baseline for the one after it, not the earlier ones.
			expect(only(report, 'repeat', 1).baseline.order).toBe(only(report, 'unsupported').read.order);
		}
	);

	it('does not call a first read after a reset a repeat of a read from before it', () => {
		const report = analyze('openai-responses', [
			read(numbered(LINES), undefined, 'read_file'),
			'compaction',
			read(numbered(EDITED), undefined, 'read_file'),
		]);

		expect(reasons(report)).toEqual(['first', 'reset-between']);
		expect(only(report, 'unsupported').version?.hash).toBe(contentHash(numbered(EDITED)));
	});

	it('treats a request without any compaction item as one epoch', () => {
		const report = analyze('openai-responses', [
			read(numbered(LINES), undefined, 'read_file'),
			read(numbered(LINES), undefined, 'read_file'),
		]);

		expect(reasons(report)).toEqual(['first', 'repeat']);
	});

	it('relates reads of the same file only inside one context', () => {
		const report = analyzeReadOpportunities([
			event(0, { context: 'main' }),
			event(1, { context: 'subagent-1' }),
			event(2, { context: 'subagent-1' }),
			event(3, { context: 'main' }),
		]);

		expect(reasons(report)).toEqual(['first', 'other-context', 'repeat', 'repeat']);
		expect(only(report, 'repeat', 0).baseline.order).toBe(1);
		expect(only(report, 'repeat', 1).baseline.order).toBe(0);
	});

	it('keeps a subagent request apart from its parent: nothing is carried between analyses', () => {
		const text = numbered(LINES);
		const parent = [read(text), read(text)];
		const subagent = [read(text)];

		const first = analyze('anthropic-messages', parent);
		const alone = analyze('anthropic-messages', subagent);
		const second = analyze('anthropic-messages', parent);

		expect(reasons(alone)).toEqual(['first']);
		expect(reasons(first)).toEqual(['first', 'repeat']);
		expect(second).toEqual(first);
	});

	it('does not pair a read with a file named in a delegated task result', () => {
		const report = analyze('anthropic-messages', [
			read(numbered(LINES)),
			{
				tool: 'Task',
				input: { description: 'check a.ts', prompt: 'check a.ts' },
				output: numbered(LINES),
			},
		]);

		expect(reasons(report)).toEqual(['first']);
	});
});

describe('read opportunities: observation only', () => {
	it('leaves every input untouched and answers the same every time', () => {
		const kind = 'anthropic-messages';
		const text = body(kind, [read(numbered(LINES)), read(numbered(EDITED))]);
		const root = parseJsonSpans(text)!;
		const descriptors = deepFreeze(findToolResultDescriptors(kind, text, root));
		const roots = deepFreeze([ROOT]);

		const scan = readEventsFromDescriptors({
			kind,
			body: text,
			root: deepFreeze(root),
			descriptors,
			roots,
		});
		deepFreeze(scan.events);
		const report = analyzeReadOpportunities(scan.events, { complete: scan.complete });
		const again = analyzeReadOpportunities(scan.events, { complete: scan.complete });

		// A write to any frozen input would have thrown above.
		expect(again).toEqual(report);
		expect(report.mode).toBe('observation');
	});

	it('never opens the compression cache', () => {
		analyze('anthropic-messages', [read(numbered(LINES)), read(numbered(LINES))]);
		analyze('openai-responses', [read(numbered(LINES), undefined, 'read_file')], {
			extra: { previous_response_id: 'resp_1' },
		});

		expect(getCompressionCache).not.toHaveBeenCalled();
		expect(createCompressionCache).not.toHaveBeenCalled();
	});

	it('reports hashes and sizes, never file text', () => {
		const secret = 'export const SECRET_MARKER_VALUE = 1;';
		const report = analyze('anthropic-messages', [
			read(numbered([secret])),
			read(numbered([secret])),
			read(`${numbered([secret])}\0`),
		]);

		expect(report.findings).toHaveLength(3);
		expect(JSON.stringify(report)).not.toContain('SECRET_MARKER_VALUE');
	});

	it('counts what it found by status and reason', () => {
		const report = analyze('anthropic-messages', [
			read(numbered(LINES)),
			read(numbered(LINES)),
			read(numbered(EDITED)),
			read(numbered(LINES.slice(1), 2), { file_path: FILE, offset: 2 }),
			read('x', { file_path: 'relative.ts' }),
			read('x', { file_path: '/etc/passwd' }),
		]);

		expect(report.counts).toEqual({
			examined: 6,
			first: 1,
			identical: 1,
			changed: 1,
			unsupported: 3,
			unsupportedByReason: { 'partial-range': 1, 'unresolved-path': 1, 'outside-workspace': 1 },
		});
	});
});

describe('read opportunities: withoutLineNumbers', () => {
	it('removes the printed number and arrow from every line and keeps the rest', () => {
		expect(withoutLineNumbers(numbered(LINES))).toBe(LINES.join('\n'));
	});

	it('keeps a final line break, and a final line without one', () => {
		expect(withoutLineNumbers(`${numbered(LINES)}\n`)).toBe(`${LINES.join('\n')}\n`);
		expect(withoutLineNumbers('    12→only')).toBe('only');
	});

	it('reads the older tab separator and any width of padding', () => {
		expect(withoutLineNumbers('1\tone\n 22\ttwo\n')).toBe('one\ntwo\n');
		expect(withoutLineNumbers(numbered(['a', 'b'], 99, '\t'))).toBe('a\nb');
	});

	it('keeps carriage returns and empty numbered lines', () => {
		expect(withoutLineNumbers('     1→a\r\n     2→\r\n     3→c\r\n')).toBe('a\r\n\r\nc\r\n');
		expect(withoutLineNumbers('     1→\n     2→\n')).toBe('\n\n');
	});

	it('removes only the first number of a line, not a number the file itself starts a line with', () => {
		expect(withoutLineNumbers('     1→12→twelve\n     2→3\tthree')).toBe('12→twelve\n3\tthree');
	});

	it('returns the text unchanged when no line carries a number', () => {
		expect(withoutLineNumbers('plain\ntext\n')).toBe('plain\ntext\n');
		expect(withoutLineNumbers('')).toBe('');
	});
});
