/**
 * @file agent-control.test.ts
 * @description Tests for focus-agent and switch-mode CLI commands
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/maestro-client', () => ({ withMaestroClient: vi.fn() }));
vi.mock('../../../cli/services/storage', () => ({
	resolveAgentId: vi.fn((id: string) => id),
	readActiveAgentId: vi.fn(() => null),
}));
vi.mock('../../../cli/output/formatter', () => ({
	formatError: vi.fn((msg) => `Error: ${msg}`),
	formatSuccess: vi.fn((msg) => `Success: ${msg}`),
}));

import { focusAgent, switchMode } from '../../../cli/commands/agent-control';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { resolveAgentId, readActiveAgentId } from '../../../cli/services/storage';
import { formatError } from '../../../cli/output/formatter';

function mockSend(result: Record<string, unknown>) {
	let captured: Record<string, unknown> = {};
	vi.mocked(withMaestroClient).mockImplementation(async (action) =>
		action({
			sendCommand: vi.fn().mockImplementation((payload: Record<string, unknown>) => {
				captured = payload;
				return Promise.resolve(result);
			}),
		} as never)
	);
	return () => captured;
}

describe('focus-agent / switch-mode commands', () => {
	let processExitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(resolveAgentId).mockImplementation((id: string) => id);
		vi.mocked(readActiveAgentId).mockReturnValue(null);
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
	});

	it('focus-agent sends select_session with focus:true', async () => {
		const getPayload = mockSend({ success: true });
		await focusAgent('agent-1', {});
		const p = getPayload();
		expect(p.type).toBe('select_session');
		expect(p.sessionId).toBe('agent-1');
		expect(p.focus).toBe(true);
		expect(p.tabId).toBeUndefined();
	});

	it('focus-agent includes tabId when --tab is given', async () => {
		const getPayload = mockSend({ success: true });
		await focusAgent('agent-1', { tab: 'tab-9' });
		expect(getPayload().tabId).toBe('tab-9');
	});

	it('switch-mode sends mode and uses mode_switch_result', async () => {
		let responseType = '';
		vi.mocked(withMaestroClient).mockImplementation(async (action) =>
			action({
				sendCommand: vi.fn().mockImplementation((_payload, rt: string) => {
					responseType = rt;
					return Promise.resolve({ success: true });
				}),
			} as never)
		);
		await switchMode('agent-1', 'terminal', {});
		expect(responseType).toBe('mode_switch_result');
	});

	it('switch-mode normalizes case', async () => {
		const getPayload = mockSend({ success: true });
		await switchMode('agent-1', 'AI', {});
		expect(getPayload().mode).toBe('ai');
	});

	describe('switch-mode --background', () => {
		// switch-mode is the one focus-moving verb that creates nothing, so it has
		// no background surface to fall back on: the mode change IS the view change
		// for whoever is on that agent. `--background` therefore means "skip it
		// rather than move me", and the CLI has to decide because the desktop's
		// switch_mode is fire-and-forget - a renderer-side decline would come back
		// looking exactly like a success.
		it('refuses when the target is the agent currently on screen', async () => {
			vi.mocked(readActiveAgentId).mockReturnValue('agent-1');

			await expect(switchMode('agent-1', 'terminal', { background: true })).rejects.toThrow(
				'__exit__'
			);

			expect(withMaestroClient).not.toHaveBeenCalled();
			expect(formatError).toHaveBeenCalledWith(expect.stringContaining('--focus'));
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});

		it('goes through for an agent that is not on screen', async () => {
			vi.mocked(readActiveAgentId).mockReturnValue('some-other-agent');
			const getPayload = mockSend({ success: true });

			await switchMode('agent-1', 'terminal', { background: true });

			// Switching an off-screen agent changes no pixels, so background
			// placement has nothing to object to.
			expect(getPayload().mode).toBe('terminal');
			expect(getPayload().background).toBe(true);
		});

		it('switches the on-screen agent anyway with --focus', async () => {
			vi.mocked(readActiveAgentId).mockReturnValue('agent-1');
			const getPayload = mockSend({ success: true });

			await switchMode('agent-1', 'terminal', { focus: true });

			expect(getPayload().background).toBe(false);
			expect(processExitSpy).not.toHaveBeenCalled();
		});

		it('defaults to foreground, so the plain verb still works on screen', async () => {
			vi.mocked(readActiveAgentId).mockReturnValue('agent-1');
			const getPayload = mockSend({ success: true });

			await switchMode('agent-1', 'terminal', {});

			expect(getPayload().background).toBe(false);
			expect(processExitSpy).not.toHaveBeenCalled();
		});
	});

	it('switch-mode rejects an invalid mode before connecting', async () => {
		await expect(switchMode('agent-1', 'banana', {})).rejects.toThrow('__exit__');
		expect(formatError).toHaveBeenCalledWith(expect.stringContaining('Invalid mode'));
		expect(withMaestroClient).not.toHaveBeenCalled();
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});
});
