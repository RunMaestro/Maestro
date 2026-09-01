/**
 * Issue #1464 - after a web-desktop page reload the main process is still
 * running the agent, but restoreSession resets every agent to idle. These tests
 * pin the reconcile that puts the busy indicators back from main's live turn
 * table, and pin that it never invents busy state it wasn't told about.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useSessionRestoration } from '../../../../renderer/hooks/session/useSessionRestoration';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import { createMockSession } from '../../../helpers/mockSession';
import { createMockAITab } from '../../../helpers/mockTab';

const RUNNING_AGENT = createMockSession({
	id: 'agent-1',
	state: 'busy',
	aiTabs: [createMockAITab({ id: 'tab-1', state: 'busy' })],
	activeTabId: 'tab-1',
});

function mockMaestro(activeProcesses: unknown[]) {
	const maestro = (window as any).maestro;
	maestro.sessions = {
		...maestro.sessions,
		getAll: vi.fn().mockResolvedValue([RUNNING_AGENT]),
		getActiveSessionId: vi.fn().mockResolvedValue('agent-1'),
		setActiveSessionId: vi.fn().mockResolvedValue(undefined),
	};
	maestro.groups = { ...maestro.groups, getAll: vi.fn().mockResolvedValue([]) };
	maestro.groupChat = { ...maestro.groupChat, list: vi.fn().mockResolvedValue([]) };
	maestro.agents = { ...maestro.agents, get: vi.fn().mockResolvedValue({ id: 'claude-code' }) };
	maestro.process = {
		...maestro.process,
		getActiveProcesses: vi.fn().mockResolvedValue(activeProcesses),
	};
}

const agentState = () => useSessionStore.getState().sessions.find((s) => s.id === 'agent-1');

beforeEach(() => {
	useSessionStore.setState({ sessions: [], initialLoadComplete: false, sessionsLoaded: false });
});

describe('useSessionRestoration - live turn reattach (#1464)', () => {
	it('restores busy state for an agent main is still running', async () => {
		mockMaestro([
			{
				sessionId: 'agent-1-ai-tab-1',
				toolType: 'claude-code',
				pid: 4242,
				cwd: '/test/project',
				isTerminal: false,
				startTime: 1000,
			},
		]);

		renderHook(() => useSessionRestoration());

		await waitFor(() => expect(agentState()?.state).toBe('busy'));
		expect(agentState()).toMatchObject({ busySource: 'ai', thinkingStartTime: 1000, aiPid: 4242 });
		expect(agentState()?.aiTabs[0]).toMatchObject({ state: 'busy', thinkingStartTime: 1000 });
	});

	it('leaves the agent idle when main is running nothing for it', async () => {
		mockMaestro([]);

		renderHook(() => useSessionRestoration());

		await waitFor(() => expect(useSessionStore.getState().sessionsLoaded).toBe(true));
		expect(agentState()?.state).toBe('idle');
		expect(agentState()?.aiTabs[0].state).toBe('idle');
	});

	it('leaves the agent idle when the probe itself fails', async () => {
		mockMaestro([]);
		(window as any).maestro.process.getActiveProcesses = vi
			.fn()
			.mockRejectedValue(new Error('bridge down'));

		renderHook(() => useSessionRestoration());

		await waitFor(() => expect(useSessionStore.getState().sessionsLoaded).toBe(true));
		expect(agentState()?.state).toBe('idle');
	});
});
