/**
 * @file app-stats.test.ts
 * @description `maestro-cli app-stats`: asks the app for the same snapshot the
 * Application Stats modal reads, prints it, and exits non-zero on failure.
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';
import { createAppStatsSnapshot } from '../../helpers/appStatsSnapshot';

vi.mock('../../../cli/services/maestro-client', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../cli/services/maestro-client')>()),
	withMaestroClient: vi.fn(),
}));

import { appStats } from '../../../cli/commands/app-stats';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { ExitCode } from '../../../cli/exit-codes';

function mockSend(result: Record<string, unknown>) {
	const captured: { payload?: Record<string, unknown>; responseType?: string } = {};
	vi.mocked(withMaestroClient).mockImplementation(async (action) =>
		action({
			sendCommand: vi.fn().mockImplementation((payload: Record<string, unknown>, rt: string) => {
				captured.payload = payload;
				captured.responseType = rt;
				return Promise.resolve(result);
			}),
		} as never)
	);
	return captured;
}

describe('app-stats command', () => {
	let logSpy: MockInstance;
	let exitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
	});

	it('asks the app for app_stats and prints the report', async () => {
		const cap = mockSend({ success: true, snapshot: createAppStatsSnapshot() });
		await appStats({});
		expect(cap.payload).toEqual({ type: 'app_stats' });
		expect(cap.responseType).toBe('app_stats_result');
		const printed = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
		expect(printed).toContain('APPLICATION STATS');
		expect(printed).toContain('LOCAL MODELS DISK');
		expect(printed).toContain('Qwen3 4B');
	});

	it('prints the snapshot as JSON with --json', async () => {
		const snapshot = createAppStatsSnapshot();
		mockSend({ success: true, snapshot });
		await appStats({ json: true });
		const parsed = JSON.parse(String(logSpy.mock.calls[0][0]));
		expect(parsed.success).toBe(true);
		expect(parsed.totals).toEqual(snapshot.totals);
		expect(parsed.localModels.disk.totalBytes).toBe(snapshot.localModels.disk.totalBytes);
	});

	it('exits non-zero when the app could not build the snapshot', async () => {
		mockSend({ success: false, error: 'boom' });
		await expect(appStats({})).rejects.toThrow('__exit__');
		expect(exitSpy).toHaveBeenCalledWith(ExitCode.GeneralError);
	});
});
