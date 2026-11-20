/**
 * @file search.test.ts
 * @description Tests for `maestro-cli search`: the request crosses the WS
 * bridge in the shape the desktop handler expects (text by default, semantic
 * with the flag), hits are printed as a person reads them (and whole as JSON),
 * and a semantic search that cannot run exits non-zero instead of falling back.
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/maestro-client', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../cli/services/maestro-client')>()),
	withMaestroClient: vi.fn(),
}));

vi.mock('../../../cli/services/storage', () => ({
	resolveAgentId: vi.fn((ref: string) => {
		if (ref === 'nope') throw new Error("Agent not found: 'nope'");
		return `resolved-${ref}`;
	}),
}));

import { search } from '../../../cli/commands/search';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { ExitCode } from '../../../cli/exit-codes';
import type { WorkSearchResult } from '../../../shared/local-models/work-search';

function mockSend(reply: Record<string, unknown>) {
	const captured: { payload?: Record<string, unknown>; responseType?: string } = {};
	vi.mocked(withMaestroClient).mockImplementation(async (action) =>
		action({
			sendCommand: vi.fn().mockImplementation((payload: Record<string, unknown>, rt: string) => {
				captured.payload = payload;
				captured.responseType = rt;
				return Promise.resolve(reply);
			}),
		} as never)
	);
	return captured;
}

const SEMANTIC_OK: WorkSearchResult = {
	status: 'ok',
	mode: 'semantic',
	durationMs: 12,
	modelId: 'local:bge-small-en-v1.5',
	index: { state: 'indexing', indexed: 120, total: 900 },
	hits: [
		{
			sourceType: 'history',
			sourceId: 'entry-1',
			agentId: 'agent-1',
			agentName: 'Backend',
			score: 0.874,
			title: 'Fixed the login timeout',
			snippet: 'The token refresh raced the logout.',
			timestamp: Date.now() - 60_000,
			history: { type: 'USER' },
		},
		{
			sourceType: 'transcript',
			sourceId: 'tab-1#u1',
			agentId: 'agent-1',
			score: 0.61,
			title: 'Auth work',
			snippet: 'why does login time out',
			transcript: { tabId: 'tab-1', turnId: 'u1', tabName: 'Auth work' },
		},
	],
};

describe('search command', () => {
	let logSpy: MockInstance;
	let errorSpy: MockInstance;
	let exitSpy: MockInstance;

	const printed = () => logSpy.mock.calls.map((call) => String(call[0])).join('\n');

	beforeEach(() => {
		vi.clearAllMocks();
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
	});

	it('searches by text unless --semantic is passed', async () => {
		const captured = mockSend({
			success: true,
			result: { status: 'ok', mode: 'text', hits: [], durationMs: 1 },
		});

		await search('login timeout', {});

		expect(captured.payload).toEqual({
			type: 'local_models_search',
			request: { query: 'login timeout', mode: 'text' },
		});
		expect(captured.responseType).toBe('local_models_search_result');
		expect(printed()).toContain('TEXT SEARCH');
		expect(printed()).toContain('Nothing matched.');
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it('sends the semantic mode, sources, agent and limit', async () => {
		const captured = mockSend({ success: true, result: SEMANTIC_OK });

		await search('why did login break', {
			semantic: true,
			source: ['history,notes', 'transcripts'],
			agent: 'back',
			limit: '5',
		});

		expect(captured.payload).toEqual({
			type: 'local_models_search',
			request: {
				query: 'why did login break',
				mode: 'semantic',
				sourceTypes: ['history', 'directors-notes', 'transcript'],
				agentId: 'resolved-back',
				limit: 5,
			},
		});
	});

	it('prints each hit with its score, source, title, snippet, and ids', async () => {
		mockSend({ success: true, result: SEMANTIC_OK });

		await search('why did login break', { semantic: true });

		const out = printed();
		expect(out).toContain('SEMANTIC SEARCH');
		expect(out).toContain('2 results');
		expect(out).toContain('local:bge-small-en-v1.5');
		expect(out).toContain('Index is still building: 120 of 900 sources.');
		expect(out).toContain('87%');
		expect(out).toContain('History · USER · Backend');
		expect(out).toContain('Fixed the login timeout');
		expect(out).toContain('The token refresh raced the logout.');
		expect(out).toContain('agent agent-1  entry entry-1');
		expect(out).toContain('61%');
		expect(out).toContain('agent agent-1  tab tab-1');
	});

	it('prints a text hit with its match count', async () => {
		mockSend({
			success: true,
			result: {
				status: 'ok',
				mode: 'text',
				durationMs: 3,
				hits: [
					{
						sourceType: 'directors-notes',
						sourceId: 'notes-1',
						agentId: null,
						matchCount: 3,
						title: "Director's Notes (7 day lookback)",
						snippet: 'The login work shipped.',
					},
				],
			},
		});

		await search('login', {});

		expect(printed()).toContain('3 matches');
		expect(printed()).toContain('id notes-1');
	});

	it('emits the whole result as JSON', async () => {
		mockSend({ success: true, result: SEMANTIC_OK });

		await search('q', { semantic: true, json: true });

		expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toEqual({
			success: true,
			query: 'q',
			...SEMANTIC_OK,
		});
	});

	it('exits non-zero when Semantic search is off, naming the fix', async () => {
		mockSend({ success: true, result: { status: 'off' } });

		await expect(search('q', { semantic: true })).rejects.toThrow('__exit__');

		expect(String(errorSpy.mock.calls[0][0])).toContain('Semantic search is off');
		expect(String(errorSpy.mock.calls[0][0])).toContain(
			'maestro-cli models assign semantic-search <source>'
		);
		expect(exitSpy).toHaveBeenCalledWith(ExitCode.GeneralError);
	});

	it('exits non-zero with the reason when the source cannot run, as JSON too', async () => {
		mockSend({
			success: true,
			result: { status: 'unavailable', reason: 'bge-small-en-v1.5 is not downloaded.' },
		});

		await expect(search('q', { semantic: true, json: true })).rejects.toThrow('__exit__');

		expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toEqual({
			success: false,
			status: 'unavailable',
			error: 'bge-small-en-v1.5 is not downloaded.',
		});
		expect(exitSpy).toHaveBeenCalledWith(ExitCode.GeneralError);
	});

	it('refuses a bad flag before asking the app', async () => {
		mockSend({ success: true, result: SEMANTIC_OK });

		await expect(search('q', { source: ['cue'] })).rejects.toThrow('__exit__');
		expect(String(errorSpy.mock.calls[0][0])).toContain('history, notes, transcripts');

		await expect(search('q', { limit: '0' })).rejects.toThrow('__exit__');
		await expect(search('q', { agent: 'nope' })).rejects.toThrow('__exit__');
		await expect(search('   ', {})).rejects.toThrow('__exit__');
		expect(withMaestroClient).not.toHaveBeenCalled();
	});

	it('reports a bridge error', async () => {
		mockSend({ success: false, error: 'A search needs a query.' });

		await expect(search('q', {})).rejects.toThrow('__exit__');
		expect(String(errorSpy.mock.calls[0][0])).toContain('A search needs a query.');
	});
});
