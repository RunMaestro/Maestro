/**
 * @file goalRunVisible.test.ts
 * @description Tests for `maestro-cli goal-run --visible` (issue #1286).
 *
 * The visible path hands the run to the desktop app rather than executing it in
 * the CLI process. What is worth pinning down here is the CONTRACT rather than
 * the plumbing: the message the desktop receives, the identifiers handed back,
 * and - most of all - that every failure fails closed. A `--visible` run that
 * quietly degraded to a headless one would satisfy the exit code while being
 * invisible in exactly the surface the caller asked to watch.
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/storage', () => ({
	getSessionById: vi.fn(),
}));

vi.mock('../../../cli/services/agent-busy', () => ({
	checkAgentBusy: vi.fn(() => ({ busy: false })),
	waitForAgentAvailable: vi.fn(async () => {}),
}));

// The headless runner must never be reached on the --visible path.
vi.mock('../../../cli/services/goal-runner', () => ({
	runGoal: vi.fn(),
}));

vi.mock('../../../cli/services/maestro-client', async () => {
	const actual = await vi.importActual<typeof import('../../../cli/services/maestro-client')>(
		'../../../cli/services/maestro-client'
	);
	return {
		withMaestroClient: vi.fn(),
		UnsupportedCommandError: actual.UnsupportedCommandError,
		CommandTimeoutError: actual.CommandTimeoutError,
	};
});

import { goalRun } from '../../../cli/commands/goal-run';
import { getSessionById } from '../../../cli/services/storage';
import { checkAgentBusy, waitForAgentAvailable } from '../../../cli/services/agent-busy';
import { runGoal } from '../../../cli/services/goal-runner';
import {
	withMaestroClient,
	UnsupportedCommandError,
	CommandTimeoutError,
} from '../../../cli/services/maestro-client';

/** Stands in for a real `process.exit`, which never returns to its caller. */
class ProcessExit extends Error {
	constructor(readonly code: number) {
		super(`process.exit(${code})`);
	}
}

/**
 * Await a call that is expected to terminate the CLI, and assert the exit code.
 * Anything else escaping (a TypeError from a guard that did not actually stop
 * execution, say) propagates and fails the test.
 */
async function expectExit(promise: Promise<unknown>, code = 1): Promise<void> {
	await expect(promise).rejects.toBeInstanceOf(ProcessExit);
	await promise.catch((error: unknown) => {
		expect((error as ProcessExit).code).toBe(code);
	});
}

const AGENT = { id: 'agent-123', name: 'Worker', toolType: 'claude-code', cwd: '/repo' };

/** Stub the desktop round-trip and capture the message the CLI sent. */
function mockDesktop(response: Record<string, unknown>) {
	const sendCommand = vi.fn().mockResolvedValue(response);
	vi.mocked(withMaestroClient).mockImplementation(async (action) =>
		action({ sendCommand } as never)
	);
	return sendCommand;
}

/** Make the desktop round-trip blow up the way an unreachable app would. */
function mockDesktopFailure(error: Error) {
	vi.mocked(withMaestroClient).mockRejectedValue(error);
}

/** Parse the JSONL lines written to stdout. */
function jsonLines(spy: MockInstance): Array<Record<string, unknown>> {
	return spy.mock.calls
		.map((call) => String(call[0]))
		.filter((line) => line.trim().startsWith('{'))
		.map((line) => JSON.parse(line));
}

describe('goal-run --visible', () => {
	let consoleSpy: MockInstance;
	let consoleErrorSpy: MockInstance;
	let processExitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(getSessionById).mockReturnValue(AGENT as never);
		vi.mocked(checkAgentBusy).mockReturnValue({ busy: false });
		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		// Throw rather than return: a stub that returns lets execution continue
		// past a guard that would really have terminated, which quietly turns
		// "never contacted the desktop" into an unobservable claim. Throwing
		// reproduces the real control flow, so the fail-closed assertions below
		// mean what they say.
		processExitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
			throw new ProcessExit(typeof code === 'number' ? code : 0);
		});
	});

	it('sends launch_goal_run with the full goal config and never runs headlessly', async () => {
		const sendCommand = mockDesktop({ success: true, tabId: 'tab-9' });

		await goalRun('agent-123', '  ship the thing  ', {
			visible: true,
			exitCriteria: '  tests pass  ',
			maxIterations: '5',
			model: 'opus',
			effort: 'high',
		});

		expect(sendCommand).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'launch_goal_run',
				sessionId: 'agent-123',
				goal: 'ship the thing',
				exitCriteria: 'tests pass',
				maxIterations: 5,
				model: 'opus',
				effort: 'high',
			}),
			'launch_goal_run_result',
			expect.any(Number)
		);
		expect(runGoal).not.toHaveBeenCalled();
		expect(processExitSpy).not.toHaveBeenCalled();
	});

	it('omits max-iterations as null so the desktop runs indefinitely', async () => {
		const sendCommand = mockDesktop({ success: true, tabId: 'tab-9' });

		await goalRun('agent-123', 'keep going', { visible: true });

		expect(sendCommand.mock.calls[0][0]).toMatchObject({ maxIterations: null });
	});

	it('returns stable identifiers and a deep link with --json', async () => {
		mockDesktop({ success: true, tabId: 'tab-9' });

		await goalRun('agent-123', 'ship it', { visible: true, json: true });

		const launch = jsonLines(consoleSpy).find((e) => e.type === 'visible_launch');
		expect(launch).toMatchObject({
			ok: true,
			mode: 'goal',
			visible: true,
			agentId: 'agent-123',
			sessionId: 'agent-123',
			tabId: 'tab-9',
			status: 'running',
			uri: 'maestro://session/agent-123/tab/tab-9',
		});
	});

	it('falls back to an agent-scoped deep link when the desktop reports no tab', async () => {
		mockDesktop({ success: true });

		await goalRun('agent-123', 'ship it', { visible: true, json: true });

		const launch = jsonLines(consoleSpy).find((e) => e.type === 'visible_launch');
		expect(launch).toMatchObject({ tabId: null, uri: 'maestro://session/agent-123' });
	});

	it('prints the deep link and the stop hint in human mode', async () => {
		mockDesktop({ success: true, tabId: 'tab-9' });

		await goalRun('agent-123', 'ship it', { visible: true });

		const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
		expect(output).toContain('maestro://session/agent-123/tab/tab-9');
		expect(output).toContain('stop-auto-run -a agent-123');
	});

	// --- fail closed -------------------------------------------------------

	it('fails with MAESTRO_NOT_RUNNING instead of falling back to headless', async () => {
		mockDesktopFailure(new Error('Maestro desktop app is not running'));

		await expectExit(goalRun('agent-123', 'ship it', { visible: true, json: true }));

		const err = jsonLines(consoleSpy).find((e) => e.type === 'error');
		expect(err).toMatchObject({ code: 'MAESTRO_NOT_RUNNING' });
		expect(runGoal).not.toHaveBeenCalled();
	});

	it('maps an older desktop build to UNSUPPORTED_COMMAND', async () => {
		mockDesktopFailure(new UnsupportedCommandError('launch_goal_run'));

		await expectExit(goalRun('agent-123', 'ship it', { visible: true, json: true }));

		expect(jsonLines(consoleSpy).find((e) => e.type === 'error')).toMatchObject({
			code: 'UNSUPPORTED_COMMAND',
		});
	});

	it('maps an unresponsive renderer to LAUNCH_TIMEOUT', async () => {
		mockDesktopFailure(new CommandTimeoutError('launch_goal_run_result'));

		await expectExit(goalRun('agent-123', 'ship it', { visible: true, json: true }));

		expect(jsonLines(consoleSpy).find((e) => e.type === 'error')).toMatchObject({
			code: 'LAUNCH_TIMEOUT',
		});
	});

	it("surfaces the desktop's own rejection code verbatim", async () => {
		mockDesktop({ success: false, code: 'AGENT_BUSY', error: 'already running' });

		await expectExit(goalRun('agent-123', 'ship it', { visible: true, json: true }));

		expect(jsonLines(consoleSpy).find((e) => e.type === 'error')).toMatchObject({
			code: 'AGENT_BUSY',
			message: 'already running',
		});
	});

	it('falls back to VISIBLE_LAUNCH_REJECTED when the desktop sends no code', async () => {
		mockDesktop({ success: false });

		await expectExit(goalRun('agent-123', 'ship it', { visible: true, json: true }));

		expect(jsonLines(consoleSpy).find((e) => e.type === 'error')).toMatchObject({
			code: 'VISIBLE_LAUNCH_REJECTED',
		});
	});

	// --- busy handling -----------------------------------------------------

	it('refuses a busy agent with AGENT_BUSY and never contacts the desktop', async () => {
		vi.mocked(checkAgentBusy).mockReturnValue({ busy: true, reason: 'Busy in desktop app' });
		const sendCommand = mockDesktop({ success: true, tabId: 'tab-9' });

		await expectExit(goalRun('agent-123', 'ship it', { visible: true, json: true }));

		expect(jsonLines(consoleSpy).find((e) => e.type === 'error')).toMatchObject({
			code: 'AGENT_BUSY',
		});
		expect(sendCommand).not.toHaveBeenCalled();
	});

	it('waits for a busy agent instead of failing when --wait is passed', async () => {
		vi.mocked(checkAgentBusy).mockReturnValue({ busy: true, reason: 'Busy in desktop app' });
		const sendCommand = mockDesktop({ success: true, tabId: 'tab-9' });

		await goalRun('agent-123', 'ship it', { visible: true, wait: true, json: true });

		expect(waitForAgentAvailable).toHaveBeenCalled();
		expect(sendCommand).toHaveBeenCalled();
		expect(jsonLines(consoleSpy).find((e) => e.type === 'visible_launch')).toBeDefined();
	});

	it('rejects --wait without --visible rather than silently ignoring it', async () => {
		await expectExit(goalRun('agent-123', 'ship it', { wait: true, json: true }));

		expect(jsonLines(consoleSpy).find((e) => e.type === 'error')).toMatchObject({
			code: 'WAIT_REQUIRES_VISIBLE',
		});
	});

	// --- shared validation --------------------------------------------------

	it('rejects an unknown agent before contacting the desktop', async () => {
		vi.mocked(getSessionById).mockReturnValue(undefined as never);
		const sendCommand = mockDesktop({ success: true });

		await expectExit(goalRun('nope', 'ship it', { visible: true, json: true }));

		expect(jsonLines(consoleSpy).find((e) => e.type === 'error')).toMatchObject({
			code: 'AGENT_NOT_FOUND',
		});
		expect(sendCommand).not.toHaveBeenCalled();
	});

	it('rejects an empty goal', async () => {
		const sendCommand = mockDesktop({ success: true });

		await expectExit(goalRun('agent-123', '   ', { visible: true, json: true }));

		expect(jsonLines(consoleSpy).find((e) => e.type === 'error')).toMatchObject({
			code: 'EMPTY_GOAL',
		});
		expect(sendCommand).not.toHaveBeenCalled();
	});

	it('leaves the headless path untouched when --visible is absent', async () => {
		vi.mocked(runGoal).mockReturnValue(
			(async function* () {
				/* no events */
			})() as never
		);
		const sendCommand = mockDesktop({ success: true });

		// Headless still runs its own agent-detection/prompt path; all we assert
		// here is that it does NOT take the desktop handoff.
		await goalRun('agent-123', 'ship it', { json: true }).catch(() => {});

		expect(sendCommand).not.toHaveBeenCalled();
	});
});
