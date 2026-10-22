import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { MouseEvent } from 'react';
import { useAgentSessionManagement } from '../../../../renderer/hooks/agent/useAgentSessionManagement';
import { useAgentSessionsResume } from '../../../../renderer/components/AgentSessionsBrowser/hooks/useAgentSessionsResume';
import type { AgentSession } from '../../../../renderer/hooks/agent/useSessionViewer';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import { buildUnifiedTabs, getActiveTab } from '../../../../renderer/utils/tabHelpers';
import { createMockSession } from '../../../helpers/mockSession';
import { createMockAITab } from '../../../helpers/mockTab';
import { resetStore } from '../../../helpers/resetStores';

describe('Session List Quick Resume tab visibility', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		resetStore(useSessionStore);
		vi.mocked(window.maestro.agentSessions.read).mockResolvedValue({
			messages: [
				{
					type: 'assistant',
					content: 'Resumed conversation',
					timestamp: new Date(0).toISOString(),
					uuid: 'message-1',
				},
			],
			total: 1,
			hasMore: false,
		});
	});

	it.each([
		{ hidden: false, loaded: true },
		{ hidden: false, loaded: false },
		{ hidden: true, loaded: true },
		{ hidden: true, loaded: false },
	])('shows the existing tab (hidden=$hidden, loaded=$loaded)', async ({ hidden, loaded }) => {
		const tab = createMockAITab({
			id: 'resume-tab',
			agentSessionId: 'provider-session',
			hidden,
			logs: loaded
				? [{ id: 'message-1', timestamp: 0, source: 'ai', text: 'Resumed conversation' }]
				: [],
		});
		const precedingTab = createMockAITab({ id: 'preceding-tab' });
		const followingTab = createMockAITab({ id: 'following-tab' });
		const session = createMockSession({
			toolType: 'codex',
			aiTabs: [followingTab, tab, precedingTab],
			unifiedTabOrder: [
				{ type: 'ai', id: precedingTab.id },
				{ type: 'ai', id: tab.id },
				{ type: 'ai', id: followingTab.id },
			],
			activeTabId: precedingTab.id,
		});
		useSessionStore.setState({ sessions: [session], activeSessionId: session.id });
		let resumed: Promise<boolean> | undefined;
		const onClose = vi.fn();
		const setActiveAgentSessionId = vi.fn();
		const { result } = renderHook(() => {
			const management = useAgentSessionManagement({
				setSessions: useSessionStore.getState().setSessions,
				setActiveAgentSessionId,
				setAgentSessionsOpen: vi.fn(),
				rightPanelRef: { current: null },
				defaultSaveToHistory: true,
				defaultShowThinking: 'off',
			});
			return useAgentSessionsResume({
				viewingSession: null,
				messages: [],
				starredSessions: new Set(),
				onResumeSession: (...args) => {
					resumed = management.handleResumeSession(...args);
				},
				onClose,
			});
		});
		const listedSession: AgentSession = {
			sessionId: 'provider-session',
			projectPath: session.cwd,
			timestamp: '2026-10-13T00:00:00Z',
			modifiedAt: '2026-10-13T00:00:00Z',
			firstMessage: '',
			messageCount: 1,
			sizeBytes: 0,
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
			durationSeconds: 0,
		};
		await act(async () => {
			result.current.handleQuickResume(listedSession, {
				stopPropagation: vi.fn(),
			} as unknown as MouseEvent);
			expect(await resumed).toBe(true);
		});
		const updated = useSessionStore.getState().sessions[0];
		const activeTab = getActiveTab(updated);
		expect(onClose).toHaveBeenCalledOnce();
		expect(setActiveAgentSessionId).toHaveBeenCalledWith(listedSession.sessionId);
		expect(updated.activeTabId).toBe(tab.id);
		expect(updated.aiTabs).toHaveLength(3);
		expect(
			updated.aiTabs.filter((candidate) => candidate.agentSessionId === listedSession.sessionId)
		).toHaveLength(1);
		expect(window.maestro.agentSessions.read).toHaveBeenCalledTimes(loaded ? 0 : 1);
		expect(activeTab?.logs).toHaveLength(1);
		expect(activeTab?.logs[0].text).toBe('Resumed conversation');
		expect(updated.unifiedTabOrder).toEqual(session.unifiedTabOrder);
		expect(buildUnifiedTabs(updated).map((entry) => entry.id)).toEqual([
			precedingTab.id,
			tab.id,
			followingTab.id,
		]);
		expect(activeTab?.hidden).toBe(false);
	});
});
