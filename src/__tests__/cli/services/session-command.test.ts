/**
 * @file session-command.test.ts
 * @description Tests for the agent resolution helpers desktop-driving CLI
 * verbs share: `resolveAgentOrActive` and the `active` keyword of
 * `resolveTabEntry`, which is built on it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../cli/services/maestro-client', () => ({
	withMaestroClient: vi.fn(),
}));

vi.mock('../../../cli/services/storage', () => ({
	resolveAgentId: vi.fn((id: string) => `resolved-${id}`),
	readActiveAgentId: vi.fn((): string | null => 'active-agent'),
}));

import { resolveAgentOrActive, resolveTabEntry } from '../../../cli/services/session-command';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { readActiveAgentId, resolveAgentId } from '../../../cli/services/storage';

/** Stub the desktop's open-tab list. */
function stubTabs(sessions: Array<{ agentId: string; tabId: string; active: boolean }>) {
	vi.mocked(withMaestroClient).mockImplementation(async (fn) =>
		fn({ sendCommand: vi.fn(async () => ({ sessions })) } as never)
	);
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe('resolveAgentOrActive', () => {
	it('resolves --agent by ID, prefix or name', () => {
		expect(resolveAgentOrActive('agent-7', 'whose composer you mean')).toBe('resolved-agent-7');
		expect(resolveAgentId).toHaveBeenCalledWith('agent-7');
		expect(readActiveAgentId).not.toHaveBeenCalled();
	});

	it('falls back to the agent the desktop has selected', () => {
		expect(resolveAgentOrActive(undefined, 'whose composer you mean')).toBe('active-agent');
		expect(resolveAgentOrActive('', 'whose composer you mean')).toBe('active-agent');
		expect(resolveAgentId).not.toHaveBeenCalled();
	});

	it('throws, saying what the agent was wanted for, when none is recorded', () => {
		vi.mocked(readActiveAgentId).mockReturnValueOnce(null);
		expect(() => resolveAgentOrActive(undefined, 'whose composer you mean')).toThrow(
			'No active agent recorded. Pass --agent <id> to say whose composer you mean.'
		);
	});

	it('lets an --agent that names nothing fail with its own message', () => {
		vi.mocked(resolveAgentId).mockImplementationOnce(() => {
			throw new Error('Agent not found: ghost');
		});
		expect(() => resolveAgentOrActive('ghost', 'whose composer you mean')).toThrow(
			'Agent not found: ghost'
		);
	});
});

describe('resolveTabEntry with the active keyword', () => {
	const tabs = [
		{ agentId: 'active-agent', tabId: 'tab-a', active: false },
		{ agentId: 'active-agent', tabId: 'tab-b', active: true },
		{ agentId: 'resolved-agent-7', tabId: 'tab-c', active: true },
	];

	it("finds the selected tab of the desktop's agent, or of --agent", async () => {
		stubTabs(tabs);
		await expect(resolveTabEntry('active')).resolves.toMatchObject({ tabId: 'tab-b' });
		await expect(resolveTabEntry('ACTIVE', 'agent-7')).resolves.toMatchObject({ tabId: 'tab-c' });
	});

	it('keeps its message when no agent is recorded', async () => {
		stubTabs(tabs);
		vi.mocked(readActiveAgentId).mockReturnValueOnce(null);
		await expect(resolveTabEntry('active')).rejects.toThrow(
			'No active agent recorded. Pass --agent <id> to say whose active tab you mean.'
		);
	});
});
