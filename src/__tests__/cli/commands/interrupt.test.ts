/**
 * @file interrupt.test.ts
 * @description Tests for `maestro-cli interrupt <agent> [--tab <id>]`, the CLI path to the Stop pill.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/maestro-client', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../cli/services/maestro-client')>()),
	withMaestroClient: vi.fn(),
}));
vi.mock('../../../cli/services/storage', () => ({
	resolveAgentId: vi.fn((id: string) => id),
	readActiveAgentId: vi.fn(() => null),
}));
vi.mock('../../../cli/output/formatter', () => ({
	formatError: vi.fn((msg) => `Error: ${msg}`),
	formatSuccess: vi.fn((msg) => `Success: ${msg}`),
}));

import { interrupt } from '../../../cli/commands/interrupt';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { resolveAgentId } from '../../../cli/services/storage';
import { CALLER_AGENT_ID_ENV_VAR, CALLER_TAB_ID_ENV_VAR } from '../../../shared/agentDelegation';
import type { InterruptTurnResult } from '../../../shared/turnInterrupt';

/** The desktop's open tabs, as `list_desktop_sessions` reports them. */
const TABS = [
	{ tabId: 'tab-alpha', agentId: 'agent-1', active: true },
	{ tabId: 'tab-beta', agentId: 'agent-1', active: false },
	{ tabId: 'tab-other', agentId: 'agent-2', active: true },
];

function stopped(overrides: Partial<InterruptTurnResult> = {}): InterruptTurnResult {
	return {
		success: true,
		sessionId: 'agent-1',
		tabId: null,
		wasBusy: true,
		interrupted: true,
		stoppedTabIds: ['tab-alpha'],
		exited: true,
		...overrides,
	};
}

/** A desktop that lists TABS and answers `interrupt_turn` with `reply`. */
function mockDesktop(reply: object) {
	const sent: Array<{ payload: Record<string, unknown>; responseType: string; timeout?: number }> =
		[];
	vi.mocked(withMaestroClient).mockImplementation(async (action) =>
		action({
			sendCommand: vi
				.fn()
				.mockImplementation(
					(payload: Record<string, unknown>, responseType: string, timeout?: number) => {
						sent.push({ payload, responseType, timeout });
						if (payload.type === 'list_desktop_sessions') {
							return Promise.resolve({ sessions: TABS });
						}
						return Promise.resolve({ type: 'interrupt_turn_result', ...reply });
					}
				),
		} as never)
	);
	return () => sent.find((s) => s.payload.type === 'interrupt_turn');
}

describe('interrupt command', () => {
	let logSpy: MockInstance;
	let errorSpy: MockInstance;
	let exitSpy: MockInstance;

	const lastJson = () => JSON.parse(logSpy.mock.calls.at(-1)![0] as string);

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(resolveAgentId).mockImplementation((id: string) => id);
		// The suite itself may run inside an agent turn; the self-guard must not see it.
		vi.stubEnv(CALLER_AGENT_ID_ENV_VAR, '');
		vi.stubEnv(CALLER_TAB_ID_ENV_VAR, '');
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
			throw new Error(`__exit__${code}`);
		});
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('stops the whole agent when no tab is named', async () => {
		const sentInterrupt = mockDesktop(stopped());

		await interrupt('agent-1', {});

		expect(sentInterrupt()).toEqual({
			payload: { type: 'interrupt_turn', sessionId: 'agent-1' },
			responseType: 'interrupt_turn_result',
			timeout: 20000,
		});
		expect(logSpy).toHaveBeenCalledWith('Success: Stopped 1 turn on agent agent-1 (tab tab-alpha)');
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it('resolves a partial agent id before sending', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('agent-1');
		const sentInterrupt = mockDesktop(stopped());

		await interrupt('age', {});

		expect(resolveAgentId).toHaveBeenCalledWith('age');
		expect(sentInterrupt()?.payload.sessionId).toBe('agent-1');
	});

	it("--tab active resolves the agent's active tab", async () => {
		const sentInterrupt = mockDesktop(stopped({ tabId: 'tab-alpha' }));

		await interrupt('agent-1', { tab: 'active' });

		expect(sentInterrupt()?.payload).toEqual({
			type: 'interrupt_turn',
			sessionId: 'agent-1',
			tabId: 'tab-alpha',
		});
		expect(logSpy).toHaveBeenCalledWith('Success: Stopped 1 turn on tab tab-alpha (tab tab-alpha)');
	});

	it('--tab accepts a unique prefix', async () => {
		const sentInterrupt = mockDesktop(stopped({ tabId: 'tab-beta', stoppedTabIds: ['tab-beta'] }));

		await interrupt('agent-1', { tab: 'tab-b' });

		expect(sentInterrupt()?.payload.tabId).toBe('tab-beta');
	});

	it('refuses a tab that belongs to another agent and sends nothing', async () => {
		const sentInterrupt = mockDesktop(stopped());

		await expect(interrupt('agent-1', { tab: 'tab-other' })).rejects.toThrow('__exit__1');

		expect(errorSpy).toHaveBeenCalledWith('Error: Tab tab-other belongs to agent agent-2');
		expect(sentInterrupt()).toBeUndefined();
	});

	it('fails on an unknown tab', async () => {
		mockDesktop(stopped());

		await expect(interrupt('agent-1', { tab: 'nope', json: true })).rejects.toThrow('__exit__1');

		expect(lastJson()).toEqual({ success: false, error: 'Tab not found: nope' });
	});

	it('reports nothing running as a success, so the verb is safe to re-run', async () => {
		mockDesktop(stopped({ wasBusy: false, interrupted: false, stoppedTabIds: [], exited: false }));

		await interrupt('agent-1', {});

		expect(logSpy).toHaveBeenCalledWith('Nothing to stop: no turn is running on agent agent-1');
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it('fails on an unknown agent without reaching the desktop', async () => {
		vi.mocked(resolveAgentId).mockImplementation(() => {
			throw new Error('Agent not found: ghost');
		});

		await expect(interrupt('ghost', { json: true })).rejects.toThrow('__exit__1');

		expect(lastJson()).toEqual({ success: false, error: 'Agent not found: ghost' });
		expect(withMaestroClient).not.toHaveBeenCalled();
	});

	it('prints the result as JSON', async () => {
		mockDesktop(stopped({ tabId: 'tab-beta', stoppedTabIds: ['tab-beta'] }));

		await interrupt('agent-1', { tab: 'tab-beta', json: true });

		expect(lastJson()).toEqual({
			success: true,
			agentId: 'agent-1',
			tabId: 'tab-beta',
			wasBusy: true,
			interrupted: true,
			stoppedTabIds: ['tab-beta'],
			exited: true,
		});
	});

	it('points at tab show when the process is still exiting', async () => {
		mockDesktop(stopped({ exited: false }));

		await interrupt('agent-1', {});

		expect(logSpy).toHaveBeenCalledWith(
			'The process is still exiting; check with: maestro-cli tab show tab-alpha'
		);
	});

	it('exits 1 with the code when the desktop could not stop the turn', async () => {
		mockDesktop({ success: false, code: 'SIGNAL_FAILED', error: 'EPERM' });

		await expect(interrupt('agent-1', { json: true })).rejects.toThrow('__exit__1');

		expect(lastJson()).toEqual({ success: false, error: 'EPERM', code: 'SIGNAL_FAILED' });
	});

	it('exits 5 when the window never answered', async () => {
		mockDesktop({ success: false, code: 'RENDERER_TIMEOUT', error: 'no answer' });

		await expect(interrupt('agent-1', {})).rejects.toThrow('__exit__5');

		expect(errorSpy).toHaveBeenCalledWith('Error: no answer');
	});

	it('fails on a generic error frame instead of reading it as a success', async () => {
		vi.mocked(withMaestroClient).mockResolvedValue({
			type: 'error',
			message: 'Failed to interrupt turn: x',
		});

		await expect(interrupt('agent-1', {})).rejects.toThrow('__exit__1');

		expect(errorSpy).toHaveBeenCalledWith('Error: Failed to interrupt turn: x');
	});

	describe('self-guard', () => {
		it('refuses to stop the agent whose turn is running the command', async () => {
			vi.stubEnv(CALLER_AGENT_ID_ENV_VAR, 'agent-1');
			vi.stubEnv(CALLER_TAB_ID_ENV_VAR, 'tab-alpha');
			const sentInterrupt = mockDesktop(stopped());

			await expect(interrupt('agent-1', {})).rejects.toThrow('__exit__1');
			await expect(interrupt('agent-1', { tab: 'tab-alpha' })).rejects.toThrow('__exit__1');

			expect(sentInterrupt()).toBeUndefined();
		});

		it('lets an agent stop another of its own tabs', async () => {
			vi.stubEnv(CALLER_AGENT_ID_ENV_VAR, 'agent-1');
			vi.stubEnv(CALLER_TAB_ID_ENV_VAR, 'tab-alpha');
			const sentInterrupt = mockDesktop(stopped({ tabId: 'tab-beta' }));

			await interrupt('agent-1', { tab: 'tab-beta' });

			expect(sentInterrupt()?.payload.tabId).toBe('tab-beta');
		});
	});
});
