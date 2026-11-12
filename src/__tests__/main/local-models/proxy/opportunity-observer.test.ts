/**
 * @file opportunity-observer.test.ts
 *
 * The read opportunities the proxy reports. One request is examined for the
 * results it ADDS (the run of tool results at its end), so a read that later
 * requests carry in their history is not counted again; every number is
 * potential and never realized; a preview that leaves the process is redacted
 * and cut; and the observer runs one pass at a time, off the request, with a
 * failure that stays its own.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({
	app: { getPath: () => '/tmp/opportunity-observer-unused' },
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

// Observation never opens the cache. Any use of these two accessors fails the test.
vi.mock('../../../../main/local-models/proxy/compression-cache', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('../../../../main/local-models/proxy/compression-cache')>();
	return {
		...actual,
		getCompressionCache: vi.fn(() => {
			throw new Error('observation must not open the compression cache');
		}),
		createCompressionCache: vi.fn(() => {
			throw new Error('observation must not create a compression cache');
		}),
	};
});

// Counts the turns a pass hands back to the event loop.
const yields = vi.hoisted(() => ({ count: 0 }));
vi.mock('../../../../main/utils/concurrency', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../../main/utils/concurrency')>()),
	yieldToEventLoop: () => {
		yields.count++;
		return Promise.resolve();
	},
}));

import {
	createOpportunityLedger,
	createOpportunityObserver,
	observeRequest,
	OPPORTUNITY_OBSERVER_LIMITS,
	type OpportunityObserverLimits,
	type RequestObservation,
} from '../../../../main/local-models/proxy/opportunity-observer';
import {
	createCompressionCache,
	getCompressionCache,
} from '../../../../main/local-models/proxy/compression-cache';
import type { TokenProxyObservedRequest } from '../../../../main/local-models/proxy/server';
import {
	TOKEN_PROXY_OPPORTUNITY_NOTE,
	TOKEN_PROXY_UNAVAILABLE_IDENTITY,
	type TokenProxyObservationSkip,
	type TokenProxyOpportunity,
} from '../../../../shared/local-models/token-proxy';
import { TS_MODULE } from '../../../helpers/codeStructureFixtures';
import {
	body,
	deepFreeze,
	numbered,
	read,
	ROOT,
	type ApiKind,
	type Item,
} from '../../../helpers/proxyReadRequests';

const API_KINDS: ApiKind[] = ['anthropic-messages', 'openai-chat-completions', 'openai-responses'];
const NOW = 1_700_000_000_000;
const NOTES = `${ROOT}/docs/notes.txt`;
const OTHER = `${ROOT}/docs/other.txt`;

/** A plain-text file long enough that a marker or a delta is far shorter than a re-read. */
const TEXT = Array.from(
	{ length: 60 },
	(_, i) => `line ${i}: text that makes this line long enough`
);
const TEXT_EDITED = TEXT.map((line, i) => (i === 30 ? 'line 30: this line was edited' : line));

const readNotes = (lines: readonly string[] = TEXT, path = NOTES) =>
	read(numbered(lines), { file_path: path });

function request(kind: ApiKind, sent: string, forwarded = sent): TokenProxyObservedRequest {
	return { kind, route: 'anthropic', agentId: 'agent-1', sent, forwarded };
}

async function observe(
	kind: ApiKind,
	items: Item[],
	options: { forwarded?: string; roots?: string[]; limits?: OpportunityObserverLimits } = {}
): Promise<RequestObservation> {
	const sent = body(kind, items);
	const result = await observeRequest(
		request(kind, sent, options.forwarded ?? sent),
		options.roots ?? [ROOT],
		NOW,
		options.limits
	);
	if ('skipped' in result) throw new Error(`the request was skipped as ${result.skipped}`);
	return result;
}

/** The same request with one more user message after its results: a new prompt. */
function withPrompt(text: string): string {
	const parsed = JSON.parse(text) as { messages?: unknown[]; input?: unknown[] };
	(parsed.messages ?? parsed.input)!.push({ role: 'user', content: 'Now do the next thing.' });
	return JSON.stringify(parsed);
}

/** `text` with the LAST occurrence of `search` replaced. */
function replaceLast(text: string, search: string, replacement: string): string {
	const at = text.lastIndexOf(search);
	return text.slice(0, at) + replacement + text.slice(at + search.length);
}

describe('what a request adds', () => {
	it.each(API_KINDS)(
		'previews an unchanged re-read at the end of the history (%s)',
		async (kind) => {
			const obs = await observe(kind, [readNotes(), readNotes()]);

			expect(obs.withReads).toBe(true);
			expect(obs.reads).toMatchObject({
				examined: 1,
				first: 0,
				identical: 1,
				changed: 0,
				unsupported: 0,
			});
			expect(obs.previews).toMatchObject({ examined: 1, unchanged: 1, delta: 0, unsupported: 0 });
			expect(obs.previews.potentialTokens).toBeGreaterThan(0);
			expect(obs.opportunities).toHaveLength(1);
			const [only] = obs.opportunities;
			expect(only).toMatchObject({
				kind: 'unchanged-read',
				observedAt: NOW,
				agentId: 'agent-1',
				route: 'anthropic',
				requestKind: kind,
				path: NOTES,
				baselineBasis: 'same-request-delivered-whole',
				delivery: 'whole',
				parser: null,
				changes: null,
				cut: false,
				redacted: false,
			});
			expect(only.sourceHash).toMatch(/^[0-9a-f]{12}$/);
			expect(only.baseline?.hash).toBe(only.sourceHash);
			expect(only.baseline?.callId).not.toBe(only.callId);
			expect(only.text).toMatch(/^\[maestro-preview unchanged-read /);
			expect(only.potential).toMatchObject({
				kind: 'potential-reduction',
				realized: false,
				basis: 'text-as-sent',
				tokenCountKind: 'character-estimate',
			});
			expect(only.potential.reducibleTokens).toBeGreaterThan(0);
		}
	);

	it.each(API_KINDS)('previews the lines a changed re-read differs by (%s)', async (kind) => {
		const obs = await observe(kind, [readNotes(), readNotes(TEXT_EDITED)]);

		expect(obs.reads).toMatchObject({ examined: 1, identical: 0, changed: 1 });
		expect(obs.previews).toMatchObject({ examined: 1, unchanged: 0, delta: 1 });
		const [only] = obs.opportunities;
		expect(only.kind).toBe('read-delta');
		expect(only.changes).toEqual({ hunks: 1, added: 1, removed: 1 });
		expect(only.sourceHash).not.toBe(only.baseline?.hash);
		expect(only.text).toContain('line 30: this line was edited');
	});

	it.each(API_KINDS)(
		'counts a read once: the next request carries it in its history (%s)',
		async (kind) => {
			const repeat = [readNotes(), readNotes()];
			const first = await observe(kind, repeat);
			const second = await observe(kind, [...repeat, readNotes(TEXT, OTHER)]);

			expect(first.reads).toMatchObject({ examined: 1, identical: 1 });
			// The repeat is history now. Only the file this request added is examined.
			expect(second.reads).toMatchObject({ examined: 1, first: 1, identical: 0, changed: 0 });
			expect(second.opportunities).toEqual([]);
		}
	);

	it.each(API_KINDS)('counts every result of the newest turn (%s)', async (kind) => {
		const obs = await observe(kind, [
			readNotes(),
			[readNotes(TEXT_EDITED), readNotes(TEXT, OTHER)],
		]);

		expect(obs.reads).toMatchObject({ examined: 2, first: 1, changed: 1 });
		expect(obs.opportunities.map((entry) => entry.kind)).toEqual(['read-delta']);
	});

	it.each(API_KINDS)('adds nothing when the request ends in a new prompt (%s)', async (kind) => {
		const sent = withPrompt(body(kind, [readNotes(), readNotes()]));
		const result = await observeRequest(request(kind, sent), [ROOT], NOW);

		expect(result).toMatchObject({
			withReads: false,
			reads: { examined: 0 },
			previews: { examined: 0 },
			outlines: { examined: 0 },
			opportunities: [],
		});
	});

	it.each(API_KINDS)('adds nothing when the newest result is not a read (%s)', async (kind) => {
		const obs = await observe(kind, [
			readNotes(),
			readNotes(),
			{ tool: 'Bash', input: { command: 'ls' }, output: 'file.txt' },
		]);

		expect(obs.withReads).toBe(false);
		expect(obs.reads.examined).toBe(0);
	});

	it('examines the newest reads of a long history, not the oldest', async () => {
		const history = Array.from({ length: 300 }, (_, i) =>
			readNotes(TEXT, `${ROOT}/docs/f${i}.txt`)
		);
		const obs = await observe('anthropic-messages', [
			...history,
			readNotes(TEXT, `${ROOT}/docs/f299.txt`),
		]);

		// 300 reads exceed the analyzer's 256-read bound. The oldest are left out of the
		// window, so the read the request adds is related to the one before it.
		expect(obs.reads).toMatchObject({ examined: 1, identical: 1 });
		expect(obs.reads.unsupportedByReason['over-budget']).toBeUndefined();
	});
});

describe('what is refused, and why', () => {
	it('names the reason a request is not examined', async () => {
		const sent = body('anthropic-messages', [readNotes(), readNotes()]);
		const run = (
			over: Partial<TokenProxyObservedRequest>,
			roots = [ROOT],
			limits?: OpportunityObserverLimits
		) => observeRequest({ ...request('anthropic-messages', sent), ...over }, roots, NOW, limits);

		await expect(
			run({}, [ROOT], { ...OPPORTUNITY_OBSERVER_LIMITS, maxBodyChars: 10 })
		).resolves.toEqual({
			skipped: 'too-large',
		});
		await expect(run({}, [])).resolves.toEqual({ skipped: 'no-workspace' });
		await expect(run({ sent: 'not json', forwarded: 'not json' })).resolves.toEqual({
			skipped: 'unreadable',
		});
	});

	it('reports why a newest read cannot be related, by reason', async () => {
		const obs = await observe('anthropic-messages', [
			readNotes(),
			[
				read(numbered(TEXT.slice(5, 10)), { file_path: NOTES, offset: 5, limit: 5 }),
				readNotes(TEXT, '/elsewhere/outside.txt'),
				{ ...readNotes(), isError: true },
			],
		]);

		expect(obs.reads).toMatchObject({ examined: 3, unsupported: 3 });
		expect(obs.reads.unsupportedByReason).toEqual({
			'partial-range': 1,
			'outside-workspace': 1,
			'failed-read': 1,
		});
		expect(obs.opportunities).toEqual([]);
	});

	it('refuses a request that continues server-held history', async () => {
		const sent = body('openai-responses', [readNotes(), readNotes()], {
			previous_response_id: 'resp_1',
		});
		const result = await observeRequest(request('openai-responses', sent), [ROOT], NOW);

		expect(result).toMatchObject({ reads: { examined: 1, unsupported: 1 } });
		expect((result as RequestObservation).reads.unsupportedByReason).toEqual({
			'incremental-history': 1,
		});
	});

	it('does not preview against a baseline the proxy shortened', async () => {
		const sent = body('anthropic-messages', [readNotes(), readNotes()]);
		const literal = JSON.stringify(numbered(TEXT));
		const forwarded = sent.replace(literal, JSON.stringify('[shortened by the proxy]'));
		const obs = await observe('anthropic-messages', [readNotes(), readNotes()], { forwarded });

		expect(forwarded).not.toBe(sent);
		expect(obs.previews).toMatchObject({ examined: 1, unsupported: 1 });
		expect(obs.previews.unsupportedByReason).toEqual({ 'baseline-replaced': 1 });
		expect(obs.opportunities).toEqual([]);
	});

	it('claims nothing about delivery it cannot line up', async () => {
		const obs = await observe('anthropic-messages', [readNotes(), readNotes()], {
			forwarded: '{"not":"a message list"}',
		});

		expect(obs.previews.unsupportedByReason).toEqual({ 'baseline-unproven': 1 });
	});

	it('lines the forwarded request up with the window when the history is long', async () => {
		const history = Array.from({ length: 300 }, (_, i) =>
			readNotes(TEXT, `${ROOT}/docs/f${i}.txt`)
		);
		const items = [...history, readNotes(TEXT, `${ROOT}/docs/f299.txt`)];
		const sent = body('anthropic-messages', items);
		// The proxy shortened the baseline: the second-to-last copy of the same text.
		const literal = JSON.stringify(numbered(TEXT));
		const at = sent.lastIndexOf(literal, sent.lastIndexOf(literal) - 1);
		const forwarded =
			sent.slice(0, at) + JSON.stringify('[shortened]') + sent.slice(at + literal.length);
		const obs = await observe('anthropic-messages', items, { forwarded });

		expect(obs.previews.unsupportedByReason).toEqual({ 'baseline-replaced': 1 });
	});

	it('marks a request whose newest turn passed a work bound as incomplete', async () => {
		const paths = Array.from({ length: 66 }, (_, i) => `${ROOT}/docs/f${i}.txt`);
		const obs = await observe('anthropic-messages', [
			...paths.map((path) => readNotes(TEXT, path)),
			paths.map((path) => readNotes(TEXT, path)),
		]);

		// The previews are bounded at 64 pairs; the last two have none, and the report says so.
		expect(obs.incomplete).toBe(true);
		expect(obs.reads).toMatchObject({ examined: 66, identical: 66 });
		expect(obs.previews.unsupportedByReason).toEqual({ 'over-budget': 2 });
		expect(obs.opportunities).toHaveLength(64);
	});

	it('says when the proxy shortened the re-read itself, so the figures overlap', async () => {
		const sent = body('anthropic-messages', [readNotes(), readNotes()]);
		const forwarded = replaceLast(sent, JSON.stringify(numbered(TEXT)), JSON.stringify('[short]'));
		const obs = await observe('anthropic-messages', [readNotes(), readNotes()], { forwarded });

		expect(obs.opportunities).toHaveLength(1);
		expect(obs.opportunities[0].delivery).toBe('replaced');
	});
});

describe('source outlines', () => {
	it('outlines a source file the newest result returned', async () => {
		const obs = await observe('anthropic-messages', [
			readNotes(TS_MODULE, `${ROOT}/src/module.ts`),
		]);

		expect(obs.reads).toMatchObject({ examined: 1, first: 1 });
		expect(obs.outlines).toMatchObject({ examined: 1, outlined: 1, unsupported: 0 });
		expect(obs.previews.examined).toBe(0);
		const [outline] = obs.opportunities;
		expect(outline).toMatchObject({
			kind: 'code-outline',
			path: `${ROOT}/src/module.ts`,
			baseline: null,
			baselineBasis: null,
			parser: { name: '@lezer/javascript', dialect: 'ts' },
			changes: null,
			delivery: 'whole',
		});
		expect(outline.text).toMatch(/^\[maestro-preview code-structure /);
		expect(outline.potential.realized).toBe(false);
	});

	it('keeps an outline and a re-read preview apart: they are alternatives, never a sum', async () => {
		const path = `${ROOT}/src/module.ts`;
		const obs = await observe('anthropic-messages', [
			readNotes(TS_MODULE, path),
			readNotes(TS_MODULE, path),
		]);

		expect(obs.previews.unchanged).toBe(1);
		expect(obs.outlines.outlined).toBe(1);
		expect(obs.opportunities.map((entry) => entry.kind).sort()).toEqual([
			'code-outline',
			'unchanged-read',
		]);
	});
});

describe('what leaves the process', () => {
	// Assembled at run time: a literal key in a test file is what a secret scanner blocks a push for.
	const secret = ['sk', 'abcd1234'.repeat(4)].join('-');

	it('redacts a secret-shaped value in a preview', async () => {
		const source = [`export const API_KEY = '${secret}';`, ...TS_MODULE];
		const obs = await observe('anthropic-messages', [readNotes(source, `${ROOT}/src/keys.ts`)]);

		const [outline] = obs.opportunities;
		expect(outline.redacted).toBe(true);
		expect(outline.text).toContain('API_KEY');
		expect(outline.text).toContain('[REDACTED_');
		expect(JSON.stringify(obs)).not.toContain(secret);
	});

	it('cuts a long preview at a line break and says how long it was', async () => {
		const limits = { ...OPPORTUNITY_OBSERVER_LIMITS, maxPreviewChars: 300 };
		const obs = await observe('anthropic-messages', [readNotes(TEXT), readNotes(TEXT_EDITED)], {
			limits,
		});

		const [only] = obs.opportunities;
		expect(only.cut).toBe(true);
		expect(only.text.length).toBeLessThanOrEqual(300);
		expect(only.textChars).toBeGreaterThan(only.text.length);
		// The cut falls between lines of the preview, not inside one.
		const shownLines = only.text.split('\n');
		expect(shownLines[shownLines.length - 1]).toMatch(/long enough$/);
	});
});

describe('contract', () => {
	it('is deterministic, takes frozen input and never opens the cache', async () => {
		const roots = deepFreeze([ROOT]);
		const sent = body('anthropic-messages', [readNotes(), readNotes(TEXT_EDITED)]);
		const first = await observeRequest(request('anthropic-messages', sent), roots, NOW);
		const second = await observeRequest(request('anthropic-messages', sent), roots, NOW);

		expect(second).toEqual(first);
		expect(getCompressionCache).not.toHaveBeenCalled();
		expect(createCompressionCache).not.toHaveBeenCalled();
	});

	it('hands the event loop a turn between the steps of a pass, and none when there is nothing to do', async () => {
		yields.count = 0;
		await observe('anthropic-messages', [readNotes(), readNotes()]);
		// After the scan, after the analysis and after the previews.
		expect(yields.count).toBe(3);

		yields.count = 0;
		await observe('anthropic-messages', [{ tool: 'Bash', input: { command: 'ls' }, output: 'x' }]);
		expect(yields.count).toBe(0);
	});

	it('names no figure as a saving and marks every one as not realized', async () => {
		const obs = await observe('anthropic-messages', [
			readNotes(),
			readNotes(TEXT_EDITED),
			readNotes(TS_MODULE, `${ROOT}/src/module.ts`),
		]);
		const keys: string[] = [];
		const walk = (value: unknown): void => {
			if (Array.isArray(value)) value.forEach(walk);
			else if (value && typeof value === 'object') {
				for (const [key, child] of Object.entries(value)) {
					keys.push(key);
					walk(child);
				}
			}
		};
		walk(obs);

		expect(keys.filter((key) => /sav(e|ing)/i.test(key))).toEqual([]);
		for (const entry of obs.opportunities) expect(entry.potential.realized).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// The tallies
// ---------------------------------------------------------------------------

function zero(): RequestObservation {
	return {
		withReads: true,
		incomplete: false,
		reads: {
			examined: 0,
			first: 0,
			identical: 0,
			changed: 0,
			unsupported: 0,
			unsupportedByReason: {},
		},
		previews: {
			examined: 0,
			unchanged: 0,
			delta: 0,
			unsupported: 0,
			unsupportedByReason: {},
			potentialChars: 0,
			potentialTokens: 0,
		},
		outlines: {
			examined: 0,
			outlined: 0,
			unsupported: 0,
			unsupportedByReason: {},
			potentialChars: 0,
			potentialTokens: 0,
		},
		opportunities: [],
	};
}

function entry(callId: string): TokenProxyOpportunity {
	return {
		kind: 'unchanged-read',
		observedAt: NOW,
		agentId: 'agent-1',
		route: 'anthropic',
		requestKind: 'anthropic-messages',
		tool: 'Read',
		callId,
		path: NOTES,
		sourceHash: 'a'.repeat(12),
		baseline: { callId: 'earlier', hash: 'a'.repeat(12) },
		baselineBasis: 'same-request-delivered-whole',
		delivery: 'whole',
		potential: {
			kind: 'potential-reduction',
			realized: false,
			basis: 'text-as-sent',
			tokenCountKind: 'character-estimate',
			fullChars: 400,
			fullTokens: 100,
			previewChars: 40,
			previewTokens: 10,
			reducibleChars: 360,
			reducibleTokens: 90,
		},
		parser: null,
		changes: null,
		text: 'preview',
		textChars: 7,
		cut: false,
		redacted: false,
	};
}

describe('the ledger', () => {
	it('starts empty and says what it is', () => {
		const ledger = createOpportunityLedger({ now: () => NOW });
		const snapshot = ledger.snapshot();

		expect(snapshot).toMatchObject({
			version: 1,
			mode: 'observation',
			note: TOKEN_PROXY_OPPORTUNITY_NOTE,
			realized: false,
			tokenCountKind: 'character-estimate',
			since: NOW,
			coverage: {
				scope: 'process-lifetime',
				attribution: 'newest-tool-results',
				observed: 0,
				withReads: 0,
				incomplete: 0,
				skipped: { busy: 0, 'too-large': 0, unreadable: 0, 'no-workspace': 0, failed: 0 },
			},
			identity: { known: ['agent'], unavailable: [...TOKEN_PROXY_UNAVAILABLE_IDENTITY] },
			limits: {
				bodyChars: OPPORTUNITY_OBSERVER_LIMITS.maxBodyChars,
				readsPerRequest: 256,
				previewPairs: 64,
				outlineSources: 32,
				recentPreviews: OPPORTUNITY_OBSERVER_LIMITS.maxRecent,
				previewTextChars: OPPORTUNITY_OBSERVER_LIMITS.maxPreviewChars,
			},
			recent: [],
		});
		expect(snapshot.identity.unavailable).toEqual(['tab', 'native-session', 'subagent', 'window']);
		expect(snapshot.identity.note).toMatch(/tab, a native session, a subagent or a context window/);
	});

	it('adds requests together, reasons included, and keeps previews and outlines apart', () => {
		const ledger = createOpportunityLedger();
		const a = zero();
		a.reads = {
			...a.reads,
			examined: 3,
			first: 1,
			identical: 1,
			unsupported: 1,
			unsupportedByReason: { 'partial-range': 1 },
		};
		a.previews = {
			...a.previews,
			examined: 1,
			unchanged: 1,
			potentialChars: 400,
			potentialTokens: 100,
		};
		a.outlines = {
			...a.outlines,
			examined: 2,
			outlined: 1,
			unsupported: 1,
			unsupportedByReason: { 'parse-error': 1 },
			potentialChars: 800,
			potentialTokens: 200,
		};
		const b = zero();
		b.incomplete = true;
		b.reads = {
			...b.reads,
			examined: 1,
			unsupported: 1,
			unsupportedByReason: { 'partial-range': 2, 'failed-read': 1 },
		};
		b.previews = { ...b.previews, potentialChars: 40, potentialTokens: 10 };

		ledger.record(a);
		ledger.record(b);
		ledger.record({ ...zero(), withReads: false });
		const snapshot = ledger.snapshot();

		expect(snapshot.coverage).toMatchObject({ observed: 3, withReads: 2, incomplete: 1 });
		expect(snapshot.reads).toMatchObject({ examined: 4, first: 1, identical: 1, unsupported: 2 });
		expect(snapshot.reads.unsupportedByReason).toEqual({ 'partial-range': 3, 'failed-read': 1 });
		expect(snapshot.previews).toMatchObject({
			unchanged: 1,
			potentialChars: 440,
			potentialTokens: 110,
		});
		expect(snapshot.outlines).toMatchObject({
			outlined: 1,
			potentialChars: 800,
			potentialTokens: 200,
			unsupportedByReason: { 'parse-error': 1 },
		});
	});

	it('counts a request that was read and not examined, by reason', () => {
		const ledger = createOpportunityLedger();
		const reasons: TokenProxyObservationSkip[] = ['busy', 'busy', 'too-large', 'failed'];
		for (const reason of reasons) ledger.skip(reason);

		expect(ledger.snapshot().coverage.skipped).toEqual({
			busy: 2,
			'too-large': 1,
			unreadable: 0,
			'no-workspace': 0,
			failed: 1,
		});
		expect(ledger.snapshot().coverage.observed).toBe(0);
	});

	it('keeps the newest previews, newest request first', () => {
		const ledger = createOpportunityLedger({
			limits: { ...OPPORTUNITY_OBSERVER_LIMITS, maxRecent: 3 },
		});
		ledger.record({ ...zero(), opportunities: [entry('a1'), entry('a2')] });
		ledger.record({ ...zero(), opportunities: [entry('b1')] });
		expect(ledger.snapshot().recent.map((item) => item.callId)).toEqual(['b1', 'a2', 'a1']);

		ledger.record({ ...zero(), opportunities: [entry('c1'), entry('c2')] });
		expect(ledger.snapshot().recent.map((item) => item.callId)).toEqual(['c2', 'c1', 'b1']);
	});

	it('saturates instead of overflowing', () => {
		const ledger = createOpportunityLedger();
		const big = zero();
		big.reads = {
			...big.reads,
			examined: Number.MAX_SAFE_INTEGER,
			unsupportedByReason: { x: Number.MAX_SAFE_INTEGER },
		};
		ledger.record(big);
		ledger.record(big);

		expect(ledger.snapshot().reads.examined).toBe(Number.MAX_SAFE_INTEGER);
		expect(ledger.snapshot().reads.unsupportedByReason.x).toBe(Number.MAX_SAFE_INTEGER);
	});

	it('hands out copies: a caller cannot reach the ledger through a snapshot', () => {
		const ledger = createOpportunityLedger();
		ledger.record({ ...zero(), opportunities: [entry('a1')] });
		const snapshot = ledger.snapshot();
		snapshot.reads.examined = 99;
		snapshot.coverage.skipped.busy = 99;
		snapshot.recent[0].potential.reducibleTokens = 99;
		snapshot.recent.length = 0;

		const again = ledger.snapshot();
		expect(again.reads.examined).toBe(0);
		expect(again.coverage.skipped.busy).toBe(0);
		expect(again.recent[0].potential.reducibleTokens).toBe(90);
	});

	it('starts over on reset, with a new start time', () => {
		let clock = NOW;
		const ledger = createOpportunityLedger({ now: () => clock });
		ledger.record({ ...zero(), opportunities: [entry('a1')] });
		ledger.skip('busy');
		clock = NOW + 5_000;
		ledger.reset();

		expect(ledger.snapshot()).toMatchObject({
			since: NOW + 5_000,
			coverage: { observed: 0, skipped: { busy: 0 } },
			recent: [],
		});
	});
});

// ---------------------------------------------------------------------------
// The observer
// ---------------------------------------------------------------------------

describe('the observer', () => {
	const repeatRequest = () => {
		const sent = body('anthropic-messages', [readNotes(), readNotes()]);
		return request('anthropic-messages', sent);
	};

	it('returns at once and examines the request on a later turn', async () => {
		const rootsFor = vi.fn(() => [ROOT]);
		const observer = createOpportunityObserver({ rootsFor, now: () => NOW });

		observer.observe(repeatRequest());
		// None of the work, not even the first slice, is done in the caller's turn.
		expect(rootsFor).not.toHaveBeenCalled();
		expect(observer.snapshot().coverage.observed).toBe(0);
		await observer.idle();
		expect(rootsFor).toHaveBeenCalledTimes(1);

		expect(observer.snapshot()).toMatchObject({
			coverage: { observed: 1, withReads: 1 },
			reads: { identical: 1 },
			previews: { unchanged: 1 },
		});
	});

	it("asks for the agent's working directories when it examines, and names the agent", async () => {
		const rootsFor = vi.fn(() => [ROOT]);
		const observer = createOpportunityObserver({ rootsFor });

		observer.observe(repeatRequest());
		await observer.idle();

		expect(rootsFor).toHaveBeenCalledWith('agent-1');
		expect(observer.snapshot().recent[0].agentId).toBe('agent-1');
	});

	it('examines one request at a time and counts the one that arrives meanwhile', async () => {
		const observer = createOpportunityObserver({ rootsFor: () => [ROOT] });

		observer.observe(repeatRequest());
		observer.observe(repeatRequest());
		await observer.idle();
		observer.observe(repeatRequest());
		await observer.idle();

		const { coverage } = observer.snapshot();
		expect(coverage.observed).toBe(2);
		expect(coverage.skipped.busy).toBe(1);
	});

	it('counts a body over the limit without examining it', async () => {
		const observer = createOpportunityObserver({
			rootsFor: () => [ROOT],
			limits: { ...OPPORTUNITY_OBSERVER_LIMITS, maxBodyChars: 10 },
		});

		observer.observe(repeatRequest());
		await observer.idle();

		expect(observer.snapshot().coverage).toMatchObject({
			observed: 0,
			skipped: { 'too-large': 1 },
		});
	});

	it('counts a request for an agent with no working directory', async () => {
		const observer = createOpportunityObserver({ rootsFor: () => [] });

		observer.observe(repeatRequest());
		await observer.idle();

		expect(observer.snapshot().coverage.skipped['no-workspace']).toBe(1);
	});

	it('reports a failed pass, keeps the failure its own, and examines the next request', async () => {
		const onFailure = vi.fn();
		const boom = new Error('roots unavailable');
		const rootsFor = vi
			.fn<() => string[]>()
			.mockImplementationOnce(() => {
				throw boom;
			})
			.mockReturnValue([ROOT]);
		const observer = createOpportunityObserver({ rootsFor, onFailure });

		expect(() => observer.observe(repeatRequest())).not.toThrow();
		await observer.idle();
		expect(onFailure).toHaveBeenCalledWith(boom);
		expect(observer.snapshot().coverage.skipped.failed).toBe(1);

		observer.observe(repeatRequest());
		await observer.idle();
		expect(observer.snapshot().coverage.observed).toBe(1);
	});

	it('forgets everything on reset', async () => {
		const observer = createOpportunityObserver({ rootsFor: () => [ROOT] });
		observer.observe(repeatRequest());
		await observer.idle();
		observer.reset();

		expect(observer.snapshot()).toMatchObject({
			coverage: { observed: 0 },
			reads: { examined: 0 },
			recent: [],
		});
	});
});
