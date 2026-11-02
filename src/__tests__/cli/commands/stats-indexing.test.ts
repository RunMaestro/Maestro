/**
 * @file stats-indexing.test.ts
 * @description `maestro-cli stats-indexing`: the read half of the usage-data
 * scan progress modal.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/maestro-client', () => ({
	withMaestroClient: vi.fn(),
}));

import { statsIndexing } from '../../../cli/commands/stats';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import {
	EMPTY_STATS_INDEXING_STATE,
	STATS_INDEXING_VISIBLE_MIN_FILES,
	type StatsIndexingState,
} from '../../../shared/statsIndexing';

const scanning: StatsIndexingState = {
	jobs: [
		{
			id: 'global-stats',
			label: 'Usage totals',
			reason: 'upgrade',
			doneFiles: 10,
			totalFiles: STATS_INDEXING_VISIBLE_MIN_FILES * 2,
			doneBytes: 512,
			totalBytes: 2048,
			startedAt: Date.now(),
			updatedAt: Date.now(),
			surfaced: true,
		},
	],
};

/** Reply to each `get_stats_indexing` with the next state in `states`. */
function replyWith(...states: StatsIndexingState[]) {
	const sendCommand = vi.fn();
	for (const state of states) {
		sendCommand.mockResolvedValueOnce({ type: 'stats_indexing', data: state });
	}
	sendCommand.mockResolvedValue({ type: 'stats_indexing', data: states.at(-1) });
	vi.mocked(withMaestroClient).mockImplementation(async (action) =>
		action({ sendCommand } as never)
	);
	return sendCommand;
}

describe('stats-indexing command', () => {
	let log: MockInstance;
	let exit: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		log = vi.spyOn(console, 'log').mockImplementation(() => {});
		exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
	});

	afterEach(() => {
		log.mockRestore();
		exit.mockRestore();
	});

	it('says so when nothing is scanning', async () => {
		const send = replyWith(EMPTY_STATS_INDEXING_STATE);
		await statsIndexing({});
		expect(send).toHaveBeenCalledWith({ type: 'get_stats_indexing' }, 'stats_indexing');
		expect(log).toHaveBeenCalledWith('No usage data scan is running.');
	});

	it('prints the same summary the modal shows', async () => {
		replyWith(scanning);
		await statsIndexing({});
		const line = log.mock.calls[0][0] as string;
		expect(line).toContain('Upgrading usage data: 25%');
		expect(line).toContain('10 of 50 transcripts');
		expect(line).toContain('Usage totals');
	});

	it('emits JSON for scripts', async () => {
		replyWith(scanning);
		await statsIndexing({ json: true });
		const output = JSON.parse(log.mock.calls[0][0] as string);
		expect(output.running).toBe(true);
		expect(output.summary.fraction).toBeCloseTo(0.25);
	});

	it('--wait returns once the scan has finished', async () => {
		vi.useFakeTimers();
		try {
			const send = replyWith(scanning, EMPTY_STATS_INDEXING_STATE);
			const done = statsIndexing({ wait: true, json: true });
			await vi.advanceTimersByTimeAsync(1000);
			await done;
			expect(send).toHaveBeenCalledTimes(2);
			expect(JSON.parse(log.mock.calls.at(-1)![0] as string).running).toBe(false);
			expect(exit).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it('--wait exits non-zero when it times out mid-scan', async () => {
		vi.useFakeTimers();
		try {
			replyWith(scanning);
			const done = statsIndexing({ wait: true, timeout: '1', json: true });
			await vi.advanceTimersByTimeAsync(2000);
			await done;
			expect(exit).toHaveBeenCalledWith(1);
		} finally {
			vi.useRealTimers();
		}
	});
});
