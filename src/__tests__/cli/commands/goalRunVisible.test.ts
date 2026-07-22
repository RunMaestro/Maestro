/**
 * @file goalRunVisible.test.ts
 * @description Tests for `maestro-cli goal-run --visible`, which hands the run
 * to the desktop app so it appears as a live Auto Run (parity with the UI Go
 * button) instead of running headless in the CLI process.
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/maestro-client', () => ({
	withMaestroClient: vi.fn(),
}));

import { runVisibleGoalRun } from '../../../cli/commands/goal-run';
import { withMaestroClient } from '../../../cli/services/maestro-client';

const GOAL_CONFIG = { goal: 'Ship the thing', exitCriteria: 'tests pass', maxIterations: 5 };

describe('goal-run --visible (runVisibleGoalRun)', () => {
	let logSpy: MockInstance;
	let errorSpy: MockInstance;
	let exitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
	});

	function mockDesktop(response: unknown): MockInstance {
		const sendCommand = vi.fn().mockResolvedValue(response);
		vi.mocked(withMaestroClient).mockImplementation(async (action) =>
			action({ sendCommand } as never)
		);
		return sendCommand;
	}

	it('sends launch_goal_run and prints stable JSON identifiers with a deep link', async () => {
		const sendCommand = mockDesktop({
			type: 'launch_goal_run_result',
			success: true,
			tabId: 'tab-77',
		});

		await runVisibleGoalRun('agent-1', GOAL_CONFIG, true);

		expect(sendCommand).toHaveBeenCalledWith(
			{
				type: 'launch_goal_run',
				sessionId: 'agent-1',
				goal: 'Ship the thing',
				exitCriteria: 'tests pass',
				maxIterations: 5,
			},
			'launch_goal_run_result'
		);

		const output = JSON.parse(logSpy.mock.calls[0][0]);
		expect(output).toMatchObject({
			ok: true,
			mode: 'visible',
			visible: true,
			agent_id: 'agent-1',
			tab_id: 'tab-77',
			status: 'launched',
			uri: 'maestro://session/agent-1/tab/tab-77',
		});
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it('returns tab_id null and a session-only deep link when the desktop omits a tab id', async () => {
		mockDesktop({ type: 'launch_goal_run_result', success: true });

		await runVisibleGoalRun('agent-1', GOAL_CONFIG, true);

		const output = JSON.parse(logSpy.mock.calls[0][0]);
		expect(output.tab_id).toBeNull();
		expect(output.uri).toBe('maestro://session/agent-1');
	});

	it('fails closed with MAESTRO_NOT_RUNNING when the desktop app is unreachable', async () => {
		vi.mocked(withMaestroClient).mockRejectedValue(new Error('Maestro desktop app is not running'));

		await runVisibleGoalRun('agent-1', GOAL_CONFIG, true);

		const output = JSON.parse(logSpy.mock.calls[0][0]);
		expect(output.type).toBe('error');
		expect(output.code).toBe('MAESTRO_NOT_RUNNING');
		expect(exitSpy).toHaveBeenCalledWith(1);
	});

	it('maps a busy rejection to AGENT_BUSY', async () => {
		mockDesktop({
			type: 'launch_goal_run_result',
			success: false,
			error: 'Agent "Worker" is busy',
		});

		await runVisibleGoalRun('agent-1', GOAL_CONFIG, true);

		const output = JSON.parse(logSpy.mock.calls[0][0]);
		expect(output.code).toBe('AGENT_BUSY');
		expect(exitSpy).toHaveBeenCalledWith(1);
	});

	it('maps a non-busy rejection to VISIBLE_LAUNCH_REJECTED', async () => {
		mockDesktop({
			type: 'launch_goal_run_result',
			success: false,
			error: 'Session agent-1 not found',
		});

		await runVisibleGoalRun('agent-1', GOAL_CONFIG, true);

		const output = JSON.parse(logSpy.mock.calls[0][0]);
		expect(output.code).toBe('VISIBLE_LAUNCH_REJECTED');
		expect(exitSpy).toHaveBeenCalledWith(1);
	});

	it('prints human-readable output (not JSON) when useJson is false', async () => {
		mockDesktop({ type: 'launch_goal_run_result', success: true, tabId: 'tab-9' });

		await runVisibleGoalRun('agent-1', GOAL_CONFIG, false);

		const printed = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
		expect(printed).toContain('maestro://session/agent-1/tab/tab-9');
		expect(errorSpy).not.toHaveBeenCalled();
	});
});
