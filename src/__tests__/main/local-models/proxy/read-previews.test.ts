/**
 * @file read-previews.test.ts
 *
 * Delta and unchanged-read previews over the repeated reads the analyzer
 * approved. A preview measures what a re-read could shrink to and labels the
 * figure a potential reduction. It never edits a request, opens the cache, or
 * compares a diff against a baseline the model is not proven to hold.
 */

import { beforeEach, describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({
	app: { getPath: () => '/tmp/read-previews-unused' },
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

// Previews never open the cache. Any use of these two accessors fails the test.
vi.mock('../../../../main/local-models/proxy/compression-cache', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('../../../../main/local-models/proxy/compression-cache')>();
	return {
		...actual,
		getCompressionCache: vi.fn(() => {
			throw new Error('previews must not open the compression cache');
		}),
		createCompressionCache: vi.fn(() => {
			throw new Error('previews must not create a compression cache');
		}),
	};
});

// The real diff, counted: a bound must stop the work before it starts.
vi.mock('diff', async (importOriginal) => {
	const actual = await importOriginal<typeof import('diff')>();
	return { ...actual, structuredPatch: vi.fn(actual.structuredPatch) };
});

import { structuredPatch } from 'diff';
import {
	buildReadPreviews,
	READ_PREVIEW_LIMITS,
	READ_PREVIEW_NOTE,
	resultDeliveries,
	type ReadPreview,
	type ReadPreviewLimits,
	type ReadPreviewReport,
	type RequestView,
	type ResultDelivery,
} from '../../../../main/local-models/proxy/read-previews';
import {
	analyzeReadOpportunities,
	readEventsFromDescriptors,
	type ReadEvent,
	type ReadOpportunityReport,
} from '../../../../main/local-models/proxy/read-opportunities';
import {
	findToolResultDescriptors,
	MIN_SAVING_RATIO,
} from '../../../../main/local-models/proxy/compress';
import {
	contentHash,
	createCompressionCache,
	getCompressionCache,
} from '../../../../main/local-models/proxy/compression-cache';
import { parseJsonSpans } from '../../../../main/local-models/proxy/json-spans';
import { estimateTokenCount } from '../../../../shared/formatters';
import {
	body,
	deepFreeze,
	event,
	FILE,
	numbered,
	read,
	ROOT,
	type ApiKind,
	type Item,
} from '../../../helpers/proxyReadRequests';

const SECOND = `${ROOT}/src/b.ts`;
const CONTENT = Array.from(
	{ length: 200 },
	(_, index) => `export const value${index + 1} = ${index + 1}; // generated line`
);
const EDITED_LINE = 'export const value120 = 999; // edited';

/** The lines with the 1-based `line` replaced. */
function replaceLine(lines: readonly string[], line: number, text: string): string[] {
	return lines.map((value, index) => (index === line - 1 ? text : value));
}

/** Lines `from` to `to` (1-based, inclusive) of CONTENT as unchanged diff lines. */
function context(from: number, to: number): string[] {
	return CONTENT.slice(from - 1, to).map((line) => ` ${line}`);
}

const hash12 = (text: string) => contentHash(text).slice(0, 12);

function viewOf(
	kind: ApiKind,
	items: Item[]
): RequestView & { root: NonNullable<ReturnType<typeof parseJsonSpans>> } {
	const text = body(kind, items);
	const root = parseJsonSpans(text);
	if (!root) throw new Error('fixture is not JSON');
	return { body: text, root, descriptors: findToolResultDescriptors(kind, text, root) };
}

interface Run {
	view: ReturnType<typeof viewOf>;
	events: ReadEvent[];
	report: ReadOpportunityReport;
	previews: ReadPreviewReport;
}

/** The analyzer's two steps and then the previews, over a request body, the way a caller composes them. */
function run(
	kind: ApiKind,
	items: Item[],
	options: {
		deliveries?: Map<number, ResultDelivery>;
		limits?: Partial<ReadPreviewLimits>;
	} = {}
): Run {
	const view = viewOf(kind, items);
	const scan = readEventsFromDescriptors({
		kind,
		body: view.body,
		root: view.root,
		descriptors: view.descriptors,
		roots: [ROOT],
	});
	const report = analyzeReadOpportunities(scan.events, { complete: scan.complete });
	// Nothing rewrites the request: the model is shown what the agent sent.
	const deliveries = options.deliveries ?? resultDeliveries(view, view);
	const previews = buildReadPreviews({
		report,
		events: scan.events,
		deliveries,
		limits: options.limits,
	});
	return { view, events: scan.events, report, previews };
}

/** Previews over events supplied directly, with the same delivery for every result. */
function previewEvents(
	events: ReadEvent[],
	options: {
		delivery?: ResultDelivery | null;
		limits?: Partial<ReadPreviewLimits>;
		report?: ReadOpportunityReport;
	} = {}
): ReadPreviewReport {
	const delivery = options.delivery === undefined ? 'whole' : options.delivery;
	const deliveries = new Map<number, ResultDelivery>();
	if (delivery) events.forEach((entry) => deliveries.set(entry.order, delivery));
	return buildReadPreviews({
		report: options.report ?? analyzeReadOpportunities(events),
		events,
		deliveries,
		limits: options.limits,
	});
}

/** The `index`th entry, which must be a preview. */
function previewAt(
	report: ReadPreviewReport,
	index = 0
): Extract<ReadPreview, { status: 'preview' }> {
	const entry = report.previews[index];
	if (entry?.status !== 'preview') {
		throw new Error(`entry ${index} is ${JSON.stringify(entry)}, not a preview`);
	}
	return entry;
}

const reasons = (report: ReadPreviewReport) =>
	report.previews.map((entry) => (entry.status === 'unsupported' ? entry.reason : entry.kind));

const editedText = numbered(replaceLine(CONTENT, 120, EDITED_LINE));

beforeEach(() => {
	vi.mocked(structuredPatch).mockClear();
});

describe('read previews: identical re-reads', () => {
	it.each(['anthropic-messages', 'openai-chat-completions', 'openai-responses'] as const)(
		'previews an identical re-read in %s as a short reference to the earlier read',
		(kind) => {
			const tool = kind === 'anthropic-messages' ? 'Read' : 'read_file';
			const text = numbered(CONTENT);
			const { previews } = run(kind, [read(text, undefined, tool), read(text, undefined, tool)]);

			const callId = kind === 'anthropic-messages' ? 'toolu_0' : 'call_0';
			const preview = previewAt(previews);
			expect(preview.kind).toBe('unchanged');
			expect(preview.text).toBe(
				`[maestro-preview unchanged-read baseline=${callId} sha256=${hash12(text)} lines=200]`
			);
			expect(preview.changes).toBeNull();
			expect(reasons(previews)).toEqual(['unchanged']);
			expect(structuredPatch).not.toHaveBeenCalled();
		}
	);

	it('names both versions of the pair and keeps their source hashes', () => {
		const text = numbered(CONTENT);
		const { previews, report } = run('anthropic-messages', [read(text), read(text)]);

		const preview = previewAt(previews);
		expect(preview.baseline).toMatchObject({
			order: 0,
			callId: 'toolu_0',
			path: FILE,
			hash: contentHash(text),
			chars: text.length,
			lines: 200,
		});
		expect(preview.target).toMatchObject({
			order: 1,
			callId: 'toolu_1',
			path: FILE,
			hash: contentHash(text),
		});
		const finding = report.findings[1];
		if (finding.status !== 'repeat') throw new Error('expected a repeat');
		expect(preview.baseline).toEqual(finding.baseline);
		expect(preview.target).toEqual(finding.read);
	});

	it('says why a baseline counts as visible, and on no other ground', () => {
		const text = numbered(CONTENT);
		const preview = previewAt(run('anthropic-messages', [read(text), read(text)]).previews);

		expect(preview.baselineBasis).toBe('same-request-delivered-whole');
	});

	it('refuses a reference that is not smaller than a short re-read', () => {
		const { previews } = run('anthropic-messages', [read('one line'), read('one line')]);

		expect(reasons(previews)).toEqual(['insufficient-reduction']);
		expect(previews.counts.potentialTokens).toBe(0);
	});

	it('holds the preview to the compressor bar: at least MIN_SAVING_RATIO smaller, marker counted', () => {
		const single = (length: number) => {
			const text = 'x'.repeat(length);
			return run('anthropic-messages', [read(text), read(text)]).previews;
		};
		// One line of any length gets a marker of one length.
		const markerChars = previewAt(single(4000)).text.length;
		const keep = 1 - MIN_SAVING_RATIO;

		const longEnough = Math.ceil(markerChars / keep) + 1;
		const tooShort = Math.floor(markerChars / keep) - 1;
		expect(previewAt(single(longEnough)).potential.reducibleChars).toBe(longEnough - markerChars);
		expect(reasons(single(tooShort))).toEqual(['insufficient-reduction']);
	});
});

describe('read previews: deltas', () => {
	it('previews a small edit of a numbered read as one hunk with the file line numbers', () => {
		const before = numbered(CONTENT);
		const { previews } = run('anthropic-messages', [read(before), read(editedText)]);

		const preview = previewAt(previews);
		expect(preview.kind).toBe('delta');
		expect(preview.changes).toEqual({ hunks: 1, added: 1, removed: 1 });
		expect(preview.text).toBe(
			[
				`[maestro-preview read-delta baseline=toolu_0 sha256=${hash12(before)} target-sha256=${hash12(editedText)} positions=file lines=+1/-1]`,
				'@@ -117,7 +117,7 @@',
				...context(117, 119),
				`-${CONTENT[119]}`,
				`+${EDITED_LINE}`,
				...context(121, 123),
				'',
			].join('\n')
		);
	});

	it('measures the preview against the re-read as sent, markers included', () => {
		const { previews } = run('anthropic-messages', [read(numbered(CONTENT)), read(editedText)]);

		const preview = previewAt(previews);
		expect(preview.potential).toEqual({
			kind: 'potential-reduction',
			realized: false,
			basis: 'text-as-sent',
			tokenCountKind: 'character-estimate',
			fullChars: editedText.length,
			fullTokens: estimateTokenCount(editedText),
			previewChars: preview.text.length,
			previewTokens: estimateTokenCount(preview.text),
			reducibleChars: editedText.length - preview.text.length,
			reducibleTokens: estimateTokenCount(editedText) - estimateTokenCount(preview.text),
		});
		expect(preview.potential.reducibleChars).toBeGreaterThan(0);
		expect(preview.text.length).toBeLessThanOrEqual(editedText.length * (1 - MIN_SAVING_RATIO));
	});

	it('previews a plain read with line positions of the returned text', () => {
		const before = CONTENT.join('\n');
		const after = replaceLine(CONTENT, 120, EDITED_LINE).join('\n');
		const preview = previewAt(run('anthropic-messages', [read(before), read(after)]).previews);

		expect(preview.text.split('\n')[0]).toContain('positions=text lines=+1/-1]');
		expect(preview.text).toContain('@@ -117,7 +117,7 @@\n');
		expect(preview.text).toContain(`-${CONTENT[119]}\n+${EDITED_LINE}\n`);
	});

	it('shifts the hunk positions by the first line number an offset read printed', () => {
		const before = numbered(CONTENT, 100);
		const after = numbered(replaceLine(CONTENT, 21, EDITED_LINE), 100);
		const { previews } = run('anthropic-messages', [
			read(before, { file_path: FILE, offset: 100 }),
			read(after, { file_path: FILE, offset: 100 }),
		]);

		const preview = previewAt(previews);
		expect(preview.text).toContain('positions=file');
		expect(preview.text).toContain('@@ -117,7 +117,7 @@\n');
	});

	it('diffs a numbered read without its numbers, so lines that only moved are not changes', () => {
		const inserted = [
			...CONTENT.slice(0, 10),
			'export const inserted = true;',
			...CONTENT.slice(10),
		];
		const { previews } = run('anthropic-messages', [
			read(numbered(CONTENT)),
			read(numbered(inserted)),
		]);

		const preview = previewAt(previews);
		// Every line after the insertion prints a different number; none of them is a change.
		expect(preview.changes).toEqual({ hunks: 1, added: 1, removed: 0 });
		expect(preview.text).toContain('@@ -8,6 +8,7 @@\n');
		expect(preview.text).toContain('+export const inserted = true;\n');
		expect(preview.text).not.toContain('→');
	});

	it('keeps the zero-length range convention with no context, shifted by the printed numbers', () => {
		const inserted = [
			...CONTENT.slice(0, 10),
			'export const inserted = true;',
			...CONTENT.slice(10),
		];
		const { previews } = run(
			'anthropic-messages',
			[
				read(numbered(CONTENT, 100), { file_path: FILE, offset: 100 }),
				read(numbered(inserted, 100), { file_path: FILE, offset: 100 }),
			],
			{ limits: { contextLines: 0 } }
		);

		// Inserted after file line 109 (the tenth line printed), as file line 110.
		expect(previewAt(previews).text).toContain(
			'@@ -109,0 +110,1 @@\n+export const inserted = true;\n'
		);
	});

	it('reads the older tab-separated numbering the same way', () => {
		const before = numbered(CONTENT, 1, '\t');
		const after = numbered(replaceLine(CONTENT, 120, EDITED_LINE), 1, '\t');
		const preview = previewAt(run('anthropic-messages', [read(before), read(after)]).previews);

		expect(preview.text).toContain('positions=file');
		expect(preview.text).toContain('@@ -117,7 +117,7 @@\n');
		expect(preview.text).not.toContain('\t');
	});

	it('keeps carriage returns in the lines of a file with Windows line endings', () => {
		const before = CONTENT.join('\r\n');
		const after = replaceLine(CONTENT, 120, EDITED_LINE).join('\r\n');
		const preview = previewAt(run('anthropic-messages', [read(before), read(after)]).previews);

		expect(preview.changes).toEqual({ hunks: 1, added: 1, removed: 1 });
		expect(preview.text).toContain(`-${CONTENT[119]}\r\n+${EDITED_LINE}\r\n`);
	});

	it('merges edits close together into one hunk and keeps distant ones apart', () => {
		const close = replaceLine(replaceLine(CONTENT, 100, 'a'), 104, 'b');
		const apart = replaceLine(replaceLine(CONTENT, 20, 'a'), 180, 'b');

		const merged = previewAt(
			run('anthropic-messages', [read(numbered(CONTENT)), read(numbered(close))]).previews
		);
		const split = previewAt(
			run('anthropic-messages', [read(numbered(CONTENT)), read(numbered(apart))]).previews
		);
		expect(merged.changes).toEqual({ hunks: 1, added: 2, removed: 2 });
		expect(split.changes).toEqual({ hunks: 2, added: 2, removed: 2 });
		expect(split.text.match(/^@@ /gm)).toHaveLength(2);
	});

	it('handles edits at the first and last line', () => {
		const first = previewAt(
			run('anthropic-messages', [
				read(numbered(CONTENT)),
				read(numbered(['export const first = 0;', ...CONTENT])),
			]).previews
		);
		const last = previewAt(
			run('anthropic-messages', [
				read(`${numbered(CONTENT)}\n`),
				read(`${numbered(CONTENT.slice(0, -1))}\n`),
			]).previews
		);

		expect(first.text).toContain('@@ -1,3 +1,4 @@\n+export const first = 0;\n');
		expect(last.text).toContain('@@ -197,4 +197,3 @@\n');
		expect(last.text).toContain(`-${CONTENT[199]}`);
	});

	describe('a missing final newline', () => {
		const withNewline = `${numbered(CONTENT)}\n`;
		const without = numbered(CONTENT);
		const last = CONTENT[199];

		it('is a change, never an unchanged read', () => {
			const { report, previews } = run('anthropic-messages', [read(withNewline), read(without)]);

			const finding = report.findings[1];
			expect(finding.status === 'repeat' && finding.relation).toBe('changed');
			expect(previewAt(previews).kind).toBe('delta');
		});

		it('marks a re-read that lost its final newline', () => {
			const preview = previewAt(
				run('anthropic-messages', [read(withNewline), read(without)]).previews
			);

			expect(preview.text).toContain(
				[
					'@@ -197,4 +197,4 @@',
					...context(197, 199),
					`-${last}`,
					`+${last}`,
					'\\ No newline at end of file',
					'',
				].join('\n')
			);
			expect(preview.changes).toEqual({ hunks: 1, added: 1, removed: 1 });
		});

		it('marks a re-read that gained one', () => {
			const preview = previewAt(
				run('anthropic-messages', [read(without), read(withNewline)]).previews
			);

			expect(preview.text).toContain(
				[
					'@@ -197,4 +197,4 @@',
					...context(197, 199),
					`-${last}`,
					'\\ No newline at end of file',
					`+${last}`,
					'',
				].join('\n')
			);
		});
	});

	it('refuses a pair that differs only in how the line numbers are printed', () => {
		const narrow = CONTENT.map((line, index) => `${String(index + 1).padStart(4)}→${line}`).join(
			'\n'
		);
		const { report, previews } = run('anthropic-messages', [read(numbered(CONTENT)), read(narrow)]);

		const finding = report.findings[1];
		expect(finding.status === 'repeat' && finding.relation).toBe('changed');
		expect(reasons(previews)).toEqual(['no-line-changes']);
	});

	describe('huge diffs', () => {
		const alpha = Array.from({ length: 300 }, (_, index) => `alpha ${index} line of the old file`);
		const beta = Array.from({ length: 300 }, (_, index) => `beta ${index} line of the new file`);

		it('gives up when the change is longer than the edit budget', () => {
			const { previews } = run('anthropic-messages', [
				read(alpha.join('\n')),
				read(beta.join('\n')),
			]);

			expect(reasons(previews)).toEqual(['diff-too-large']);
			expect(structuredPatch).toHaveBeenCalledTimes(1);
			expect(vi.mocked(structuredPatch).mock.calls[0][6]).toMatchObject({
				maxEditLength: READ_PREVIEW_LIMITS.maxEditLines,
			});
		});

		it('refuses a delta within the edit budget that is not smaller than the re-read', () => {
			const before = alpha.slice(0, 120);
			const after = before.map((line, index) => (index < 100 ? `rewritten ${index}` : line));
			const { previews } = run('anthropic-messages', [
				read(before.join('\n')),
				read(after.join('\n')),
			]);

			expect(reasons(previews)).toEqual(['insufficient-reduction']);
		});

		it('counts a changed line as one removal and one addition against the budget', () => {
			const run1 = (maxEditLines: number) =>
				run('anthropic-messages', [read(numbered(CONTENT)), read(editedText)], {
					limits: { maxEditLines },
				}).previews;

			expect(reasons(run1(2))).toEqual(['delta']);
			expect(reasons(run1(1))).toEqual(['diff-too-large']);
		});
	});
});

describe('read previews: baseline visibility', () => {
	const text = numbered(CONTENT);
	const items = () => [read(text), read(editedText)];

	it('refuses when the model is shown another text for the baseline', () => {
		const { previews } = run('anthropic-messages', items(), {
			deliveries: new Map<number, ResultDelivery>([
				[0, 'replaced'],
				[1, 'whole'],
			]),
		});

		expect(reasons(previews)).toEqual(['baseline-replaced']);
		expect(structuredPatch).not.toHaveBeenCalled();
	});

	it('refuses when nothing says what the model is shown for the baseline', () => {
		const onlyTarget = run('anthropic-messages', items(), {
			deliveries: new Map<number, ResultDelivery>([[1, 'whole']]),
		}).previews;
		const empty = run('anthropic-messages', items(), { deliveries: new Map() }).previews;

		expect(reasons(onlyTarget)).toEqual(['baseline-unproven']);
		expect(reasons(empty)).toEqual(['baseline-unproven']);
	});

	it('does not read the age of a baseline as evidence that it is retained', () => {
		// Two reads next to each other, and two with many other results between them: same answer.
		const filler = Array.from({ length: 30 }, (_, index) =>
			read(`other ${index}`, { file_path: SECOND, offset: index + 1, limit: 1 })
		);
		const near = run('anthropic-messages', [read(text), read(editedText)], {
			deliveries: new Map(),
		}).previews;
		const far = run('anthropic-messages', [read(text), ...filler, read(editedText)], {
			deliveries: new Map(),
		}).previews;

		expect(reasons(near)).toEqual(['baseline-unproven']);
		expect(reasons(far)).toEqual(['baseline-unproven']);
	});

	it('refuses a baseline the proxy shortened, from the sent and forwarded bodies', () => {
		const sent = viewOf('anthropic-messages', items());
		const forwarded = viewOf('anthropic-messages', [
			read('[maestro-compressed sha256=abc original_tokens=3000]'),
			read(editedText),
		]);
		const deliveries = resultDeliveries(sent, forwarded);

		expect(deliveries.get(0)).toBe('replaced');
		expect(deliveries.get(1)).toBe('whole');
		expect(reasons(run('anthropic-messages', items(), { deliveries }).previews)).toEqual([
			'baseline-replaced',
		]);
	});

	it('previews against a whole baseline when only the re-read was shortened, and says so', () => {
		const deliveries = new Map<number, ResultDelivery>([
			[0, 'whole'],
			[1, 'replaced'],
		]);
		const preview = previewAt(run('anthropic-messages', items(), { deliveries }).previews);

		expect(preview.targetDelivery).toBe('replaced');
		expect(preview.potential.basis).toBe('text-as-sent');
	});

	it('marks a re-read with no delivery evidence unproven', () => {
		const deliveries = new Map<number, ResultDelivery>([[0, 'whole']]);

		expect(
			previewAt(run('anthropic-messages', items(), { deliveries }).previews).targetDelivery
		).toBe('unproven');
	});

	it('refuses a baseline that is itself the target of a preview, so the totals stay additive', () => {
		const second = numbered(replaceLine(CONTENT, 50, 'export const value50 = 0;'));
		const third = numbered(replaceLine(CONTENT, 150, 'export const value150 = 0;'));
		const { previews } = run('anthropic-messages', [read(text), read(second), read(third)]);

		expect(reasons(previews)).toEqual(['delta', 'baseline-previewed']);
		expect(previews.counts).toMatchObject({
			examined: 2,
			delta: 1,
			unsupported: 1,
			unsupportedByReason: { 'baseline-previewed': 1 },
		});
		expect(previews.counts.potentialChars).toBe(previewAt(previews).potential.reducibleChars);
	});

	it('lets a later pair through when the earlier pair had no preview', () => {
		const second = numbered(replaceLine(CONTENT, 50, 'export const value50 = 0;'));
		const third = numbered(replaceLine(CONTENT, 150, 'export const value150 = 0;'));
		const { previews } = run('anthropic-messages', [read(text), read(second), read(third)], {
			deliveries: new Map<number, ResultDelivery>([
				[0, 'replaced'],
				[1, 'whole'],
				[2, 'whole'],
			]),
		});

		expect(reasons(previews)).toEqual(['baseline-replaced', 'delta']);
	});

	it('chains identical re-reads the same way', () => {
		const { previews } = run('anthropic-messages', [read(text), read(text), read(text)]);

		expect(reasons(previews)).toEqual(['unchanged', 'baseline-previewed']);
	});
});

describe('resultDeliveries', () => {
	const text = numbered(CONTENT);
	const items = [read(text), read(editedText)];

	it('calls every result whole when the forwarded body is the sent body', () => {
		const sent = viewOf('anthropic-messages', items);

		expect([...resultDeliveries(sent, sent)]).toEqual([
			[0, 'whole'],
			[1, 'whole'],
		]);
	});

	it('calls a result whole when only another result changed', () => {
		const sent = viewOf('anthropic-messages', items);
		const forwarded = viewOf('anthropic-messages', [read(text), read('short')]);

		expect([...resultDeliveries(sent, forwarded)]).toEqual([
			[0, 'whole'],
			[1, 'replaced'],
		]);
	});

	it('proves nothing when the results cannot be lined up', () => {
		const sent = viewOf('anthropic-messages', items);
		const forwarded = viewOf('anthropic-messages', [read(text)]);

		expect(resultDeliveries(sent, forwarded).size).toBe(0);
	});

	it('has no entry for a result whose text cannot be read on both sides', () => {
		const parts = (...texts: string[]) => ({
			tool: 'Read',
			input: { file_path: FILE },
			output: texts.map((part) => ({ type: 'text', text: part })),
		});
		const sent = viewOf('anthropic-messages', [parts('a', 'b'), read(text)]);
		const forwarded = viewOf('anthropic-messages', [parts('a', 'c'), read('short')]);

		expect([...resultDeliveries(sent, forwarded)]).toEqual([[1, 'replaced']]);
	});

	it('reads the same way in the other two APIs', () => {
		for (const kind of ['openai-chat-completions', 'openai-responses'] as const) {
			const sent = viewOf(kind, items);
			const forwarded = viewOf(kind, [read('short'), read(editedText)]);

			expect([...resultDeliveries(sent, forwarded)]).toEqual([
				[0, 'replaced'],
				[1, 'whole'],
			]);
		}
	});
});

describe('read previews: source integrity', () => {
	const text = numbered(CONTENT);
	const pair = () => [event(0, { text, callId: 'a' }), event(1, { text: editedText, callId: 'b' })];

	it('gives a pair of events its preview', () => {
		expect(reasons(previewEvents(pair()))).toEqual(['delta']);
	});

	it('refuses a pair whose text is not in the events', () => {
		const events = pair();
		const report = analyzeReadOpportunities(events);

		expect(reasons(previewEvents(events.slice(0, 1), { report }))).toEqual(['source-missing']);
		expect(reasons(previewEvents(events.slice(1), { report }))).toEqual(['source-missing']);
	});

	it('refuses text that is not the text the finding hashed', () => {
		const events = pair();
		const report = analyzeReadOpportunities(events);
		const sameLength = { ...events[1], text: `${editedText.slice(0, -1)}X` } as ReadEvent;
		const longer = { ...events[1], text: `${editedText} ` } as ReadEvent;

		expect(reasons(previewEvents([events[0], sameLength], { report }))).toEqual([
			'source-mismatch',
		]);
		expect(reasons(previewEvents([events[0], longer], { report }))).toEqual(['source-mismatch']);
		expect(
			reasons(
				previewEvents([{ ...events[0], text: `${text.slice(0, -1)}X` } as ReadEvent, events[1]], {
					report,
				})
			)
		).toEqual(['source-mismatch']);
		expect(structuredPatch).not.toHaveBeenCalled();
	});

	it('refuses a finding that contradicts its own hashes', () => {
		const events = pair();
		const report = analyzeReadOpportunities(events);
		const [first, second] = report.findings;
		if (second.status !== 'repeat') throw new Error('expected a repeat');
		const lying: ReadOpportunityReport = {
			...report,
			findings: [first, { ...second, relation: 'identical' }],
		};

		expect(reasons(previewEvents(events, { report: lying }))).toEqual(['source-mismatch']);
	});

	it('refuses a pair whose first printed line numbers differ', () => {
		const events = pair();
		const report = analyzeReadOpportunities(events);
		const [first, second] = report.findings;
		if (second.status !== 'repeat') throw new Error('expected a repeat');
		const skewed: ReadOpportunityReport = {
			...report,
			findings: [
				first,
				{ ...second, read: { ...second.read, numbered: { startLine: 5, endLine: 204 } } },
			],
		};

		expect(reasons(previewEvents(events, { report: skewed }))).toEqual(['source-mismatch']);
	});

	it('leaves a call id out of a marker unless it is safe to print as it stands', () => {
		const unsafe = previewAt(
			previewEvents([
				event(0, { text, callId: 'x]\n[maestro-compressed sha256=0' }),
				event(1, { text, callId: 'y' }),
			])
		);
		const safe = previewAt(
			previewEvents([event(0, { text, callId: 'toolu_01A.b-c:d' }), event(1, { text })])
		);

		expect(unsafe.text).toBe(`[maestro-preview unchanged-read sha256=${hash12(text)} lines=200]`);
		expect(safe.text).toContain('baseline=toolu_01A.b-c:d sha256=');
	});

	it('previews nothing for findings that are not repeated reads', () => {
		const { previews } = run('anthropic-messages', [
			read(numbered(CONTENT)),
			read(numbered(CONTENT, 5), { file_path: FILE, offset: 5 }),
			read('x', { file_path: SECOND }),
			read('x', { file_path: '/etc/passwd' }),
		]);

		expect(previews.previews).toEqual([]);
		expect(previews.counts).toMatchObject({ examined: 0, unchanged: 0, delta: 0, unsupported: 0 });
	});

	it("passes the analyzer's own incompleteness on", () => {
		const events = pair();
		const report = analyzeReadOpportunities(events, { complete: false });

		expect(previewEvents(events, { report }).complete).toBe(false);
		expect(previewEvents(events).complete).toBe(true);
	});
});

describe('read previews: bounds', () => {
	const twoFiles = (): Item[] => [
		read(numbered(CONTENT)),
		read(editedText),
		read(numbered(CONTENT), { file_path: SECOND }),
		read(editedText, { file_path: SECOND }),
	];

	it('previews up to the pair budget and marks the rest over budget', () => {
		const { previews } = run('anthropic-messages', twoFiles(), { limits: { maxPairs: 1 } });

		expect(reasons(previews)).toEqual(['delta', 'over-budget']);
		expect(previews.complete).toBe(false);
		expect(structuredPatch).toHaveBeenCalledTimes(1);
	});

	it('stops at the total character budget', () => {
		const pairChars = numbered(CONTENT).length + editedText.length;
		const { previews } = run('anthropic-messages', twoFiles(), {
			limits: { maxTotalChars: Math.floor(pairChars * 1.5) },
		});

		expect(reasons(previews)).toEqual(['delta', 'over-budget']);
		expect(previews.complete).toBe(false);
	});

	it('refuses a text longer than the per-pair character budget before diffing it', () => {
		const { previews } = run('anthropic-messages', twoFiles().slice(0, 2), {
			limits: { maxPairChars: 1000 },
		});

		expect(reasons(previews)).toEqual(['too-large']);
		expect(structuredPatch).not.toHaveBeenCalled();
	});

	it('refuses a text with more lines than the line budget before diffing it', () => {
		const { previews } = run('anthropic-messages', twoFiles().slice(0, 2), {
			limits: { maxLines: 199 },
		});

		expect(reasons(previews)).toEqual(['too-many-lines']);
		expect(structuredPatch).not.toHaveBeenCalled();
		expect(
			reasons(
				run('anthropic-messages', twoFiles().slice(0, 2), { limits: { maxLines: 200 } }).previews
			)
		).toEqual(['delta']);
	});

	it('echoes the limits it used and keeps the defaults for the rest', () => {
		const { previews } = run('anthropic-messages', twoFiles().slice(0, 2), {
			limits: { maxLines: 300 },
		});

		expect(previews.limits).toEqual({ ...READ_PREVIEW_LIMITS, maxLines: 300 });
		expect(READ_PREVIEW_LIMITS).toEqual({
			maxPairs: 64,
			maxPairChars: 262_144,
			maxTotalChars: 2_097_152,
			maxLines: 5_000,
			maxEditLines: 256,
			contextLines: 3,
		});
		expect(Object.isFrozen(READ_PREVIEW_LIMITS)).toBe(true);
	});

	it('keeps fewer context lines when asked', () => {
		const { previews } = run('anthropic-messages', twoFiles().slice(0, 2), {
			limits: { contextLines: 1 },
		});

		expect(previewAt(previews).text).toContain('@@ -119,3 +119,3 @@\n');
	});

	it('gives every approved pair exactly one entry, in order', () => {
		const { previews, report } = run('anthropic-messages', twoFiles(), { limits: { maxPairs: 1 } });

		const repeats = report.findings.filter((finding) => finding.status === 'repeat');
		expect(previews.previews).toHaveLength(repeats.length);
		expect(previews.counts.examined).toBe(repeats.length);
		expect(previews.counts.unchanged + previews.counts.delta + previews.counts.unsupported).toBe(
			previews.counts.examined
		);
		expect(previews.previews.map((entry) => entry.target.order)).toEqual([1, 3]);
	});
});

describe('read previews: a potential reduction, not a saving', () => {
	const items = () => [read(numbered(CONTENT)), read(editedText), read(editedText)];

	it('labels the report and every figure as a potential reduction measured on text as sent', () => {
		const { previews } = run('anthropic-messages', items());

		expect(previews).toMatchObject({ version: 1, mode: 'preview', note: READ_PREVIEW_NOTE });
		expect(READ_PREVIEW_NOTE).toMatch(/potential reduction/i);
		expect(READ_PREVIEW_NOTE).toMatch(/nothing was saved/);
		for (const entry of previews.previews) {
			if (entry.status !== 'preview') continue;
			expect(entry.potential).toMatchObject({
				kind: 'potential-reduction',
				realized: false,
				basis: 'text-as-sent',
				tokenCountKind: 'character-estimate',
			});
		}
	});

	it('uses no field that reads as a realized saving', () => {
		const { previews } = run('anthropic-messages', items());

		const keys = new Set<string>();
		JSON.stringify(previews, (key, value) => {
			keys.add(key);
			return value;
		});
		expect([...keys].filter((key) => /sav(ed|ings?)|realiz/i.test(key))).toEqual(['realized']);
		expect(previews.counts).toHaveProperty('potentialChars');
		expect(previews.counts).toHaveProperty('potentialTokens');
	});

	it('totals the potential of the previews it built and nothing else', () => {
		const alpha = Array.from({ length: 300 }, (_, index) => `alpha ${index} old line`);
		const beta = Array.from({ length: 300 }, (_, index) => `beta ${index} new line`);
		const { previews } = run('anthropic-messages', [
			read(numbered(CONTENT)),
			read(editedText),
			read(numbered(alpha), { file_path: SECOND }),
			read(numbered(beta), { file_path: SECOND }),
		]);

		expect(reasons(previews)).toEqual(['delta', 'diff-too-large']);
		const built = previews.previews.filter((entry) => entry.status === 'preview');
		expect(built).toHaveLength(1);
		expect(previews.counts.potentialChars).toBe(
			built.reduce(
				(sum, entry) => sum + (entry.status === 'preview' ? entry.potential.reducibleChars : 0),
				0
			)
		);
		expect(previews.counts.potentialTokens).toBe(
			built.reduce(
				(sum, entry) => sum + (entry.status === 'preview' ? entry.potential.reducibleTokens : 0),
				0
			)
		);
	});

	it('holds file text only in the preview text', () => {
		const secret = 'export const SECRET_MARKER_VALUE = 1;';
		const { previews } = run('anthropic-messages', [
			read(numbered([...CONTENT, secret])),
			read(numbered([...CONTENT.slice(0, 119), 'changed', ...CONTENT.slice(120), secret])),
		]);

		expect(previews.previews).toHaveLength(1);
		const withoutText = JSON.stringify(previews, (key, value) =>
			key === 'text' ? undefined : value
		);
		expect(withoutText).not.toContain('SECRET_MARKER_VALUE');
		expect(withoutText).not.toContain('generated line');
	});
});

describe('read previews: observation only', () => {
	it('is deterministic', () => {
		const first = run('anthropic-messages', [read(numbered(CONTENT)), read(editedText)]);
		const again = buildReadPreviews({
			report: first.report,
			events: first.events,
			deliveries: resultDeliveries(first.view, first.view),
		});

		expect(again).toEqual(first.previews);
	});

	it('does not depend on the clock', () => {
		const first = run('anthropic-messages', [read(numbered(CONTENT)), read(editedText)]);
		let now = 0;
		const spy = vi.spyOn(Date, 'now').mockImplementation(() => (now += 3_600_000));
		try {
			const later = buildReadPreviews({
				report: first.report,
				events: first.events,
				deliveries: resultDeliveries(first.view, first.view),
			});
			expect(later).toEqual(first.previews);
		} finally {
			spy.mockRestore();
		}
		expect(vi.mocked(structuredPatch).mock.calls[0][6]).not.toHaveProperty('timeout');
	});

	it('changes none of its inputs', () => {
		const first = run('anthropic-messages', [read(numbered(CONTENT)), read(editedText)]);
		const events = deepFreeze(structuredClone(first.events));
		const report = deepFreeze(structuredClone(first.report));
		const limits = Object.freeze({ maxPairs: 8 });
		const bodyBefore = first.view.body;

		const previews = buildReadPreviews({
			report,
			events,
			deliveries: resultDeliveries(first.view, first.view),
			limits,
		});

		expect(previews.previews).toHaveLength(1);
		expect(first.view.body).toBe(bodyBefore);
		expect(events).toEqual(first.events);
		expect(report).toEqual(first.report);
	});

	it('never opens or creates the compression cache', () => {
		run('anthropic-messages', [read(numbered(CONTENT)), read(editedText), read(editedText)]);

		expect(getCompressionCache).not.toHaveBeenCalled();
		expect(createCompressionCache).not.toHaveBeenCalled();
	});

	it('keeps nothing between calls', () => {
		const a = run('anthropic-messages', [read(numbered(CONTENT)), read(editedText)]);
		const b = run('anthropic-messages', [read(numbered(CONTENT)), read(editedText)]);

		expect(b.previews).toEqual(a.previews);
		expect(b.previews.previews[0]).not.toBe(a.previews.previews[0]);
	});
});
