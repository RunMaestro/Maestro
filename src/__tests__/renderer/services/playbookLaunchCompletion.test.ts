/**
 * Tests for reporting the end of a launched Auto Run. The renderer cannot tell a launched run from
 * an ordinary one, so it asks main whether the agent has a running launch whenever any Auto Run
 * ends, and reports only when it does. The cases that matter: an ordinary run costs one question
 * and nothing else, a launched run is reported with exactly the fields a launch record keeps (a
 * stopped one included), and a failure on either call never rejects and never passes for a launch
 * that ended.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../renderer/stores/notificationStore', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../renderer/stores/notificationStore')>()),
	notifyToast: vi.fn(),
}));
vi.mock('../../../renderer/utils/sentry', () => ({
	captureException: vi.fn(),
	captureMessage: vi.fn(),
}));
vi.mock('../../../renderer/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
	reportLaunchedRunCompletion,
	type LaunchedRunEnd,
} from '../../../renderer/services/playbookLaunchCompletion';
import { notifyToast } from '../../../renderer/stores/notificationStore';
import { logger } from '../../../renderer/utils/logger';
import { captureException } from '../../../renderer/utils/sentry';
import type { PlaybookLaunchRecord } from '../../../shared/marketplace-types';
import { createMockLaunchRecord } from '../../helpers';

const listLaunches = vi.mocked(window.maestro.marketplace.listLaunches);
const completeLaunch = vi.mocked(window.maestro.marketplace.completeLaunch);

/** The end of a six-task run on `session-1`, as `BatchCompleteInfo` reports it. */
function end(overrides: Partial<LaunchedRunEnd> = {}): LaunchedRunEnd {
	return {
		sessionId: 'session-1',
		completedTasks: 6,
		totalTasks: 6,
		elapsedTimeMs: 125_000,
		totalCostUsd: 1.25,
		wasStopped: false,
		...overrides,
	};
}

/** Main answers a list of the agent's launches. */
function mainHasLaunches(launches: PlaybookLaunchRecord[]): void {
	listLaunches.mockResolvedValue({ success: true, launches });
}

beforeEach(() => {
	vi.clearAllMocks();
	mainHasLaunches([createMockLaunchRecord()]);
	completeLaunch.mockReset();
	completeLaunch.mockResolvedValue({ success: true, launch: createMockLaunchRecord() });
});

describe('reportLaunchedRunCompletion', () => {
	describe('an ordinary Auto Run', () => {
		it('asks main for the launches of the agent that finished, and for nothing else', async () => {
			mainHasLaunches([]);

			await reportLaunchedRunCompletion(end({ sessionId: 'agent-7' }));

			expect(listLaunches).toHaveBeenCalledTimes(1);
			expect(listLaunches).toHaveBeenCalledWith({ sessionId: 'agent-7' });
		});

		it('ends nothing when the agent has no launches', async () => {
			mainHasLaunches([]);

			await expect(reportLaunchedRunCompletion(end())).resolves.toBe(false);

			expect(completeLaunch).not.toHaveBeenCalled();
			expect(notifyToast).not.toHaveBeenCalled();
		});

		it.each(['completed', 'stopped', 'failed'] as const)(
			'ends nothing when the only launch on the agent is %s',
			async (status) => {
				mainHasLaunches([createMockLaunchRecord({ status, finishedAt: 2_000 })]);

				await expect(reportLaunchedRunCompletion(end())).resolves.toBe(false);

				expect(completeLaunch).not.toHaveBeenCalled();
			}
		);

		it('ends nothing when main answers without a list', async () => {
			listLaunches.mockResolvedValue({ success: true });

			await expect(reportLaunchedRunCompletion(end())).resolves.toBe(false);

			expect(completeLaunch).not.toHaveBeenCalled();
		});
	});

	describe('a launched Auto Run', () => {
		it('reports the end of the running launch, and resolves true because the outro follows', async () => {
			await expect(reportLaunchedRunCompletion(end())).resolves.toBe(true);

			expect(completeLaunch).toHaveBeenCalledTimes(1);
			expect(completeLaunch).toHaveBeenCalledWith('launch-1', {
				completedTasks: 6,
				totalTasks: 6,
				elapsedTimeMs: 125_000,
				totalCostUsd: 1.25,
				wasStopped: false,
			});
			expect(notifyToast).not.toHaveBeenCalled();
			expect(captureException).not.toHaveBeenCalled();
			expect(logger.warn).not.toHaveBeenCalled();
		});

		it('sends only the fields a launch record keeps, from a whole BatchCompleteInfo', async () => {
			const info = {
				...end(),
				sessionName: 'Research agent',
				inputTokens: 90_000,
				outputTokens: 12_000,
				documentsProcessed: 4,
				kind: 'spec-driven',
			};

			await reportLaunchedRunCompletion(info);

			expect(completeLaunch.mock.calls[0][1]).toStrictEqual({
				completedTasks: 6,
				totalTasks: 6,
				elapsedTimeMs: 125_000,
				totalCostUsd: 1.25,
				wasStopped: false,
			});
		});

		it('reports a stopped run as stopped, with the tasks it got through', async () => {
			await expect(
				reportLaunchedRunCompletion(end({ completedTasks: 2, totalTasks: 6, wasStopped: true }))
			).resolves.toBe(true);

			expect(completeLaunch).toHaveBeenCalledWith(
				'launch-1',
				expect.objectContaining({ completedTasks: 2, totalTasks: 6, wasStopped: true })
			);
		});

		it('reports a run that took no time and cost nothing', async () => {
			await reportLaunchedRunCompletion(end({ elapsedTimeMs: 0, totalCostUsd: 0 }));

			expect(completeLaunch).toHaveBeenCalledWith(
				'launch-1',
				expect.objectContaining({ elapsedTimeMs: 0, totalCostUsd: 0 })
			);
		});

		it.each([
			['first', 0],
			['last', 2],
		])('ends the running launch when it is the %s launch in the list', async (_, at) => {
			const launches = [
				createMockLaunchRecord({ launchId: 'old-1', status: 'completed', finishedAt: 2_000 }),
				createMockLaunchRecord({ launchId: 'old-2', status: 'stopped', finishedAt: 3_000 }),
			];
			launches.splice(at, 0, createMockLaunchRecord({ launchId: 'running-one' }));
			mainHasLaunches(launches);

			await reportLaunchedRunCompletion(end());

			expect(completeLaunch).toHaveBeenCalledTimes(1);
			expect(completeLaunch.mock.calls[0][0]).toBe('running-one');
		});
	});

	describe('when main cannot say whether a launch is running', () => {
		it('treats the run as an ordinary one and logs the reason without the class name', async () => {
			listLaunches.mockResolvedValue({
				success: false,
				error: 'RangeError: limit must be a positive whole number, not 0',
			});

			await expect(reportLaunchedRunCompletion(end())).resolves.toBe(false);

			expect(completeLaunch).not.toHaveBeenCalled();
			expect(logger.warn).toHaveBeenCalledWith(
				'Could not read the launches of session-1: limit must be a positive whole number, not 0',
				'[PlaybookLaunchCompletion]'
			);
			// Main logged the failure itself, and nothing is wrong in the renderer.
			expect(captureException).not.toHaveBeenCalled();
			expect(notifyToast).not.toHaveBeenCalled();
		});

		it('says so when main gives no reason', async () => {
			listLaunches.mockResolvedValue({ success: false });

			await reportLaunchedRunCompletion(end());

			expect(logger.warn).toHaveBeenCalledWith(
				'Could not read the launches of session-1: no reason given',
				'[PlaybookLaunchCompletion]'
			);
		});

		it('reports a call that rejects, and still resolves false', async () => {
			const fault = new Error('Error invoking remote method: no handler');
			listLaunches.mockRejectedValue(fault);

			await expect(reportLaunchedRunCompletion(end())).resolves.toBe(false);

			expect(captureException).toHaveBeenCalledWith(fault, {
				extra: { operation: 'playbookLaunchCompletion:listLaunches', sessionId: 'session-1' },
			});
			expect(completeLaunch).not.toHaveBeenCalled();
			expect(notifyToast).not.toHaveBeenCalled();
		});
	});

	describe('when main cannot end the launch', () => {
		it('tells the person, with the reason and without the class name, and resolves false', async () => {
			completeLaunch.mockResolvedValue({
				success: false,
				error: 'Error: ENOSPC: no space left on device',
			});

			await expect(reportLaunchedRunCompletion(end())).resolves.toBe(false);

			expect(notifyToast).toHaveBeenCalledTimes(1);
			expect(notifyToast).toHaveBeenCalledWith({
				color: 'red',
				title: 'Playbook launch not completed',
				message:
					'"Market Research" has ended, but Maestro could not finish the launch: ENOSPC: no space left on device',
				sessionId: 'session-1',
			});
			expect(logger.warn).toHaveBeenCalledWith(
				'Launch launch-1 of research-market ended but main could not complete it: ENOSPC: no space left on device',
				'[PlaybookLaunchCompletion]'
			);
			// A refusal is main's own answer, already logged there. It is not a renderer fault.
			expect(captureException).not.toHaveBeenCalled();
		});

		it('says so when main gives no reason', async () => {
			completeLaunch.mockResolvedValue({ success: false });

			await reportLaunchedRunCompletion(end());

			expect(notifyToast).toHaveBeenCalledWith(
				expect.objectContaining({
					message:
						'"Market Research" has ended, but Maestro could not finish the launch: no reason given',
				})
			);
		});

		it('reports a call that rejects, strips the Electron wrapper from what it shows, and resolves false', async () => {
			const fault = new Error(
				"Error invoking remote method 'marketplace:completeLaunch': Error: store is locked"
			);
			completeLaunch.mockRejectedValue(fault);

			await expect(reportLaunchedRunCompletion(end())).resolves.toBe(false);

			expect(captureException).toHaveBeenCalledWith(fault, {
				extra: {
					operation: 'playbookLaunchCompletion:completeLaunch',
					launchId: 'launch-1',
					sessionId: 'session-1',
				},
			});
			expect(notifyToast).toHaveBeenCalledWith(
				expect.objectContaining({
					color: 'red',
					message:
						'"Market Research" has ended, but Maestro could not finish the launch: store is locked',
					sessionId: 'session-1',
				})
			);
		});

		it('names the playbook the launch was made from, not a later manifest', async () => {
			mainHasLaunches([createMockLaunchRecord({ playbookTitle: 'Code Review', playbookId: 'cr' })]);
			completeLaunch.mockResolvedValue({ success: false, error: 'boom' });

			await reportLaunchedRunCompletion(end());

			expect(notifyToast).toHaveBeenCalledWith(
				expect.objectContaining({
					message: '"Code Review" has ended, but Maestro could not finish the launch: boom',
				})
			);
		});
	});
});
