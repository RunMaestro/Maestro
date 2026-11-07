/**
 * @file stats-models.test.ts
 * @description Tests for `maestro-cli stats models`: the request crosses the WS
 * bridge in the shape the desktop handler expects, the record is printed as a
 * person reads it (and whole as JSON), a range that is not one of the six is
 * refused before anything is sent, and a failure the app reports is not a
 * success.
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/maestro-client', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../cli/services/maestro-client')>()),
	withMaestroClient: vi.fn(),
}));

import { statsModels } from '../../../cli/commands/stats';
import { CommandTimeoutError, withMaestroClient } from '../../../cli/services/maestro-client';
import { ExitCode } from '../../../cli/exit-codes';
import {
	BUSY_MODEL_USAGE as BUSY,
	EMPTY_MODEL_USAGE as EMPTY,
} from '../../helpers/modelUsageFixtures';

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

describe('stats models command', () => {
	it('asks the app for the range and prints every block of the record', async () => {
		const captured = mockSend({ type: 'model_usage', success: true, data: BUSY });

		await statsModels({ range: 'quarter' });

		expect(captured.payload).toEqual({ type: 'get_model_usage', range: 'quarter' });
		expect(captured.responseType).toBe('model_usage');
		const output = logSpy.mock.calls[0][0] as string;
		expect(output).toMatch(/MODEL USAGE\s+.*quarter/);
		expect(output).toContain(
			'164 requests, 1.3M tokens in, 80.1K out, 25% on this machine, 3 errors'
		);

		// Sources: the split says which unit each count is in.
		expect(output).toMatch(
			/Maestro model server\s+.*Model server.*41 requests .*\(36 runs, 4 turns, 1 routed\).*45\.0K in, 3\.2K out.*1 error.*p50 240ms {2}p95 1\.2s/
		);
		expect(output).toContain('qwen3-coder, qwen3.5-4b');
		// A provider has no single-request latency: its turns are what was timed.
		expect(output).toMatch(
			/Claude Code\s+.*Provider cloud.*40 requests .*\(40 turns\).*p50 1\.5m {2}p95 10\.0m \(turns\)/
		);
		expect(output).toContain(
			'p50 and p95 marked (turns) are whole agent turns, not single requests'
		);
		expect(output).toMatch(
			/Jev \(TypeSafe cloud\)\s+.*System One.*83 requests .*2 errors.*p50 123ms {2}p95 410ms/
		);

		// Tasks, with where each ran.
		expect(output).toMatch(/Cue gate\s+83 runs\s+.*2 errors.*p50 123ms.*Jev \(TypeSafe cloud\) 83/);
		expect(output).toMatch(/Tab naming\s+36 runs\s+.*1 error\b.*Maestro model server 36/);

		// Only an agent that launched turns on another model is listed.
		expect(output).toMatch(
			/Alpha\s+4 turns\s+36\.0K in, 2\.8K out\s+.*qwen3-coder on Maestro model server 4/
		);
		expect(output).not.toMatch(/Beta/);

		// System One: the ledger's retention is said when the range outruns it.
		expect(output).toMatch(/System One\s+.*decisions are kept 30 days/);
		expect(output).toContain(
			'90 decisions (7 from the cache): 86 answered, 3 failed open, 1 failed closed, 2 timed out, $0.001900'
		);
		expect(output).toMatch(/Auto routing\s+17 turns: low 10, medium 5, high 2/);

		// The proxy's saving is an estimate, and the report says so.
		expect(output).toMatch(/All agents\s+12 requests, 10000 tokens saved \(25%\), 14 ms average/);
		expect(output).toMatch(/Alpha\s+9 requests/);
		expect(output).toMatch(/No agent\s+3 requests, -/);
		expect(output).toContain('1 background request sent to a Local Models target');
		expect(output).toContain('Token counts are estimates at 4 characters per token.');
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it('reads the week when no range is named', async () => {
		const captured = mockSend({ type: 'model_usage', success: true, data: EMPTY });

		await statsModels({});

		expect(captured.payload).toEqual({ type: 'get_model_usage', range: 'week' });
	});

	it('says nothing ran, and where to look, for an empty range, and exits 0', async () => {
		mockSend({ type: 'model_usage', success: true, data: EMPTY });

		await statsModels({});

		const output = logSpy.mock.calls[0][0] as string;
		expect(output).toMatch(/MODEL USAGE\s+.*week/);
		expect(output).toContain('Nothing ran in this range.');
		expect(output).toContain('maestro-cli models status');
		expect(output).not.toMatch(/Sources|Tasks|System One|Token proxy/);
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it('prints the providers alone when no other model did anything', async () => {
		const provider = BUSY.sources[1];
		mockSend({
			type: 'model_usage',
			success: true,
			data: {
				...EMPTY,
				totals: { ...EMPTY.totals, requests: 40, tokensIn: 1_200_000, tokensOut: 76_000 },
				sources: [provider],
			},
		});

		await statsModels({});

		const output = logSpy.mock.calls[0][0] as string;
		expect(output).toContain(
			'40 requests, 1.2M tokens in, 76.0K out, 0% on this machine, 0 errors'
		);
		expect(output).toMatch(/Claude Code\s+.*40 requests/);
		expect(output).not.toMatch(/Tasks|Agents|System One|Token proxy/);
	});

	it('prints the whole record as JSON with --json', async () => {
		mockSend({ type: 'model_usage', success: true, data: BUSY });

		await statsModels({ range: 'quarter', json: true });

		expect(JSON.parse(logSpy.mock.calls[0][0] as string)).toEqual(BUSY);
	});

	it('refuses a range that is not one of the six before anything is sent', async () => {
		await expect(statsModels({ range: 'fortnight' })).rejects.toThrow('__exit__');

		expect(withMaestroClient).not.toHaveBeenCalled();
		expect(errorSpy.mock.calls[0][0]).toContain(
			'Invalid range "fortnight". Must be one of: day, week, month, quarter, year, all'
		);
		expect(exitSpy).toHaveBeenCalledWith(ExitCode.InvalidUsage);
	});

	it('reports a failure the app answered with, as JSON when asked', async () => {
		mockSend({ type: 'model_usage', success: false, error: 'Stats database is not ready' });

		await expect(statsModels({ json: true })).rejects.toThrow('__exit__');

		expect(JSON.parse(logSpy.mock.calls[0][0] as string)).toEqual({
			success: false,
			error: 'Stats database is not ready',
		});
		expect(errorSpy).not.toHaveBeenCalled();
		expect(exitSpy).toHaveBeenCalledWith(ExitCode.GeneralError);
	});

	it('exits with the bridge code when the app does not answer in time', async () => {
		vi.mocked(withMaestroClient).mockRejectedValue(new CommandTimeoutError('model_usage'));

		await expect(statsModels({})).rejects.toThrow('__exit__');

		expect(exitSpy).toHaveBeenCalledWith(ExitCode.Timeout);
	});
});
