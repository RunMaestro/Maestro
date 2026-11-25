/**
 * Tests for useSessionRecovery: a hosted agent is refused before recovery changes anything,
 * because a hosted send carries no pending context and the old conversation would be dropped.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

const mockNotifyToast = vi.fn();
vi.mock('../../../renderer/stores/notificationStore', async () => {
	const actual = await vi.importActual('../../../renderer/stores/notificationStore');
	return { ...actual, notifyToast: (...args: unknown[]) => mockNotifyToast(...args) };
});

import { useSessionRecovery } from '../../../renderer/hooks/agent/useSessionRecovery';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { createMockSession } from '../../helpers/mockSession';
import { createMockAITab } from '../../helpers/mockTab';

function seed(liftedTo?: { peer: string; agentId: string; at: number }) {
	const tab = createMockAITab({
		id: 'tab-1',
		logs: [{ id: 'l1', timestamp: 1, source: 'user', text: 'earlier question' }],
	});
	const session = createMockSession({
		id: 'agent-1',
		aiTabs: [tab],
		activeTabId: 'tab-1',
		...(liftedTo ? { liftedTo } : {}),
	});
	useSessionStore.setState({ sessions: [session], activeSessionId: session.id });
	return session;
}

describe('useSessionRecovery', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		useSettingsStore.setState({ federationHostedAgents: true });
	});

	afterEach(() => {
		cleanup();
		useSettingsStore.setState({ federationHostedAgents: false });
		useSessionStore.setState({ sessions: [] });
	});

	it('refuses on a hosted agent: no re-send, no pending context, not recovering', async () => {
		seed({ peer: 'box', agentId: 'h1', at: 1 });
		const processInput = vi.fn();
		const { result } = renderHook(() =>
			useSessionRecovery({ processInputRef: { current: processInput } })
		);

		await act(async () => {
			await result.current.startRecovery({
				sessionId: 'agent-1',
				tabId: 'tab-1',
				lastUserPrompt: 'retry this',
				groomContext: false,
			});
		});

		expect(processInput).not.toHaveBeenCalled();
		expect(result.current.isRecovering).toBe(false);
		expect(useSessionStore.getState().sessions[0].aiTabs[0].pendingMergedContext).toBeUndefined();
		expect(mockNotifyToast).toHaveBeenCalledWith(
			expect.objectContaining({ title: 'Session recovery is not available on hosted agents yet' })
		);
	});

	it('still recovers a plain agent', async () => {
		seed();
		const processInput = vi.fn();
		const { result } = renderHook(() =>
			useSessionRecovery({ processInputRef: { current: processInput } })
		);

		await act(async () => {
			await result.current.startRecovery({
				sessionId: 'agent-1',
				tabId: 'tab-1',
				lastUserPrompt: 'retry this',
				groomContext: false,
			});
			await vi.waitFor(() => expect(processInput).toHaveBeenCalled());
		});

		expect(mockNotifyToast).not.toHaveBeenCalled();
	});
});
