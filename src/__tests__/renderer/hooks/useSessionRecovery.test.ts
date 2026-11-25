/**
 * Tests for useSessionRecovery: local, SSH, and hosted agents recover the same way. The prior
 * conversation becomes the tab's pending context and the failed prompt is re-sent; only the send
 * path's transport differs (a hosted send hands the context to the host, `sendHostedTurn()`).
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

function seed(
	liftedTo?: { peer: string; agentId: string; at: number },
	sessionSshRemoteConfig?: { enabled: boolean; remoteId: string }
) {
	const tab = createMockAITab({
		id: 'tab-1',
		logs: [{ id: 'l1', timestamp: 1, source: 'user', text: 'earlier question' }],
	});
	const session = createMockSession({
		id: 'agent-1',
		aiTabs: [tab],
		activeTabId: 'tab-1',
		...(liftedTo ? { liftedTo } : {}),
		...(sessionSshRemoteConfig ? { sessionSshRemoteConfig } : {}),
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

	it.each(['local', 'ssh', 'hosted'] as const)(
		'a %s agent recovers the same way: the prior conversation as context, the prompt re-sent',
		async (mode) => {
			seed(
				mode === 'hosted' ? { peer: 'box', agentId: 'h1', at: 1 } : undefined,
				mode === 'local' ? undefined : { enabled: true, remoteId: 'r1' }
			);
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

			// The send path routes it (spawn here, over SSH, or to the host with the context,
			// `sendHostedTurn()`); recovery itself is the same for every mode.
			expect(processInput).toHaveBeenCalledWith('retry this', {
				sessionId: 'agent-1',
				tabId: 'tab-1',
			});
			const context = useSessionStore.getState().sessions[0].aiTabs[0].pendingMergedContext;
			expect(context).toContain('# Prior Conversation (Session Recovered)');
			expect(context).toContain('User: earlier question');
			expect(mockNotifyToast).not.toHaveBeenCalled();
		}
	);
});
