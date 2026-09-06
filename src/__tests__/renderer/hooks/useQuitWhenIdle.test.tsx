/**
 * Tests for useQuitWhenIdle.
 *
 * This is the auto-quit path: unlike the quit-confirmation dialog it does not
 * ask, it just quits the moment `collectActiveOperations` reports nothing in
 * flight. That makes it the sharpest consumer of the group-chat liveness
 * predicate in both directions - a stale "running" room means the app can never
 * auto-quit again, and a missed genuinely-busy room means it quits mid-turn.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

const mockGetActiveProcesses = vi.fn();
const mockGetActiveCueRuns = vi.fn();
const confirmQuit = vi.fn();

// Augment the real jsdom `window` rather than replacing it - this suite renders
// hooks, and swapping the global out from under React breaks its DOM access.
(globalThis as unknown as { window: Record<string, unknown> }).window.maestro = {
	process: { getActiveProcesses: mockGetActiveProcesses },
	cue: { getActiveRuns: mockGetActiveCueRuns },
	app: { confirmQuit },
	sessions: { setActiveSessionId: vi.fn() },
};

import { useQuitWhenIdle } from '../../../renderer/hooks/useQuitWhenIdle';
import { useQuitWhenIdleStore } from '../../../renderer/stores/quitWhenIdleStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useBatchStore } from '../../../renderer/stores/batchStore';
import { useGroupChatStore } from '../../../renderer/stores/groupChatStore';
import { useFeedbackDraftStore } from '../../../renderer/stores/feedbackDraftStore';
import type { GroupChat } from '../../../renderer/types';

beforeEach(() => {
	vi.clearAllMocks();
	mockGetActiveProcesses.mockResolvedValue([]);
	mockGetActiveCueRuns.mockResolvedValue([]);
	useSessionStore.setState({ sessions: [], activeSessionId: '' });
	useBatchStore.setState({ batchRunStates: {} });
	useFeedbackDraftStore.setState({ hasDraft: false });
	useGroupChatStore.setState({
		groupChats: [],
		activeGroupChatId: null,
		groupChatStates: new Map(),
		groupChatState: 'idle',
		participantStates: new Map(),
		allGroupChatParticipantStates: new Map(),
	});
	useQuitWhenIdleStore.setState({ armed: true });
});

describe('useQuitWhenIdle', () => {
	it('quits when the only "active" room is a stale entry for a deleted chat', async () => {
		useGroupChatStore.setState({
			groupChats: [],
			groupChatStates: new Map([['deleted-room', 'agent-working']]),
		});

		renderHook(() => useQuitWhenIdle());

		await vi.waitFor(() => expect(confirmQuit).toHaveBeenCalledTimes(1));
	});

	it('stays put while a room is genuinely busy', async () => {
		useGroupChatStore.setState({
			groupChats: [{ id: 'room-a' }] as GroupChat[],
			groupChatStates: new Map([['room-a', 'agent-working']]),
		});

		renderHook(() => useQuitWhenIdle());

		await new Promise((r) => setTimeout(r, 50));
		expect(confirmQuit).not.toHaveBeenCalled();
	});

	it('stays put when the moderator is idle but a participant is still working', async () => {
		useGroupChatStore.setState({
			groupChats: [{ id: 'room-a' }] as GroupChat[],
			groupChatStates: new Map([['room-a', 'idle']]),
			allGroupChatParticipantStates: new Map([['room-a', new Map([['Atlas', 'working']])]]),
		});

		renderHook(() => useQuitWhenIdle());

		await new Promise((r) => setTimeout(r, 50));
		expect(confirmQuit).not.toHaveBeenCalled();
	});

	it('does nothing at all until armed', async () => {
		useQuitWhenIdleStore.setState({ armed: false });

		renderHook(() => useQuitWhenIdle());

		await new Promise((r) => setTimeout(r, 50));
		expect(confirmQuit).not.toHaveBeenCalled();
	});
});
