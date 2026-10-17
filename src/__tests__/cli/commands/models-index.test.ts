/**
 * @file models-index.test.ts
 * @description Tests for `maestro-cli models index`: the request crosses the
 * WS bridge in the shape the desktop handler expects, the indexer's record is
 * printed as a person reads it (and whole as JSON), and the exit code is
 * non-zero only when the indexer cannot run.
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/maestro-client', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../cli/services/maestro-client')>()),
	withMaestroClient: vi.fn(),
}));

import { modelsIndex } from '../../../cli/commands/models-index';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { ExitCode } from '../../../cli/exit-codes';
import {
	emptySemanticIndexProgress,
	type SemanticIndexProgress,
} from '../../../shared/local-models/embedding-index';
import { formatError } from '../../../cli/output/formatter';

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

const INDEXING: SemanticIndexProgress = {
	state: 'indexing',
	indexed: 1204,
	total: 3400,
	bySourceType: {
		history: { indexed: 1200, total: 3300 },
		'directors-notes': { indexed: 4, total: 4 },
		transcript: { indexed: 0, total: 96 },
	},
	modelId: 'local:bge-small-en-v1.5',
	lastPassAt: 1_700_000_000_000,
};

describe('models index command', () => {
	let logSpy: MockInstance;
	let errorSpy: MockInstance;
	let exitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
	});

	it('asks the app for the indexer record and prints state, source, and counts', async () => {
		const captured = mockSend({ success: true, progress: INDEXING });

		await modelsIndex({});

		expect(captured.payload).toEqual({ type: 'local_models_semantic_index_status' });
		expect(captured.responseType).toBe('local_models_semantic_index_status_result');
		const output = logSpy.mock.calls[0][0] as string;
		expect(output).toMatch(/SEMANTIC INDEX/);
		expect(output).toMatch(/indexing/);
		expect(output).toMatch(/local:bge-small-en-v1\.5/);
		expect(output).toMatch(/History entries\s+1200 \/ 3300/);
		expect(output).toMatch(/Director's Notes\s+4 \/ 4/);
		expect(output).toMatch(/Transcript turns\s+0 \/ 96/);
		expect(output).toMatch(/Total\s+1204 \/ 3400/);
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it('says how to turn it on when it is off, and exits 0', async () => {
		mockSend({ success: true, progress: emptySemanticIndexProgress('off') });

		await modelsIndex({});

		const output = logSpy.mock.calls[0][0] as string;
		expect(output).toMatch(/off/);
		expect(output).toMatch(/maestro-cli models assign semantic-search/);
		// Counts would only be a column of zeros.
		expect(output).not.toMatch(/History entries/);
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it('says no pass has finished before the first one', async () => {
		mockSend({ success: true, progress: { ...emptySemanticIndexProgress('idle'), modelId: 'x' } });

		await modelsIndex({});

		expect(logSpy.mock.calls[0][0]).toMatch(/No pass has finished yet/);
	});

	it('exits non-zero when the indexer cannot run, showing why', async () => {
		mockSend({
			success: true,
			progress: {
				...INDEXING,
				state: 'unavailable',
				reason: 'BGE Small is not downloaded. Download it in Settings -> Local Models.',
			},
		});

		await expect(modelsIndex({})).rejects.toThrow('__exit__');

		const output = logSpy.mock.calls[0][0] as string;
		expect(output).toMatch(/unavailable/);
		expect(output).toMatch(/BGE Small is not downloaded/);
		expect(exitSpy).toHaveBeenCalledWith(ExitCode.GeneralError);
	});

	it('prints the whole record as JSON, with success reflecting the exit code', async () => {
		mockSend({ success: true, progress: INDEXING });

		await modelsIndex({ json: true });

		expect(JSON.parse(logSpy.mock.calls[0][0] as string)).toEqual({ success: true, ...INDEXING });
	});

	it('reports a refused request from the app', async () => {
		mockSend({ success: false, error: 'indexer exploded' });

		await expect(modelsIndex({})).rejects.toThrow('__exit__');

		expect(errorSpy).toHaveBeenCalledWith(formatError('indexer exploded'));
	});

	it('reports a bridge failure as JSON when asked', async () => {
		vi.mocked(withMaestroClient).mockRejectedValue(new Error('Maestro desktop app is not running'));

		await expect(modelsIndex({ json: true })).rejects.toThrow('__exit__');

		expect(JSON.parse(logSpy.mock.calls[0][0] as string)).toEqual({
			success: false,
			error: 'Maestro desktop app is not running',
		});
	});
});
