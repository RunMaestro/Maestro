/**
 * Regression coverage for the stale busy state that strands a queued group chat
 * message forever (F4 / H2).
 *
 * `handleOpenGroupChat` destructures `groupChatStates` out of the store ONCE, at
 * the top, and then awaits twice - `groupChat.load` and `groupChat.getMessages` -
 * before writing `setGroupChatState(groupChatStates.get(id))`. That map is a
 * snapshot taken before the awaits, so a `groupChat:stateChange` carrying `idle`
 * that lands while either promise is in flight is overwritten by the pre-await
 * value on the way out.
 *
 * The cost is not a briefly wrong label. The execution queue drain reads ONLY
 * the scalar `groupChatState`, and nothing ever re-derives it: no timer, no
 * retry, no reconciliation on reconnect. So a client that loses this race keeps
 * a permanently busy mirror, its queued messages never send, and the user is
 * shown a QUEUED badge for messages that will never leave the device. That is
 * exactly what happened to a phone whose two messages sat queued across a
 * 44 minute idle window and never reached the moderator.
 *
 * The window is wide on the client where it matters most: on the web bridge both
 * awaits are WebSocket round trips rather than in-process IPC, and a phone opens
 * the room on every wake.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { useGroupChatHandlers } from '../../../renderer/hooks/groupChat/useGroupChatHandlers';
import { useGroupChatStore } from '../../../renderer/stores/groupChatStore';
import { useUIStore } from '../../../renderer/stores/uiStore';

const CHAT_ID = 'gc-race';

const baseState = {
	groupChats: [],
	activeGroupChatId: null,
	groupChatMessages: [],
	groupChatState: 'moderator-thinking' as const,
	participantStates: new Map(),
	moderatorUsage: null,
	groupChatStates: new Map([[CHAT_ID, 'moderator-thinking' as const]]),
	allGroupChatParticipantStates: new Map(),
	unreadGroupChatIds: new Set<string>(),
	groupChatQueues: {},
	groupChatReadOnlyMode: false,
	groupChatRightTab: 'participants' as const,
	groupChatParticipantColors: {},
	groupChatStagedImagesById: {},
	participantLiveOutput: new Map(),
	groupChatError: null,
};

describe('opening a group chat does not resurrect a stale busy state', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		useGroupChatStore.setState(baseState);
		useUIStore.setState({ activeFocus: 'main' });

		(window as any).maestro.groupChat = {
			load: vi.fn().mockResolvedValue({ id: CHAT_ID, name: 'Race', participants: [] }),
			// The moderator finishes while the transcript is still loading. This is
			// the real ordering on a phone: the room is opened on wake, and the
			// `idle` frame is already on the wire behind the load.
			getMessages: vi.fn().mockImplementation(async () => {
				useGroupChatStore.getState().setGroupChatStates((prev) => {
					const next = new Map(prev);
					next.set(CHAT_ID, 'idle');
					return next;
				});
				return [];
			}),
			onMessage: vi.fn().mockReturnValue(() => {}),
			onStateChange: vi.fn().mockReturnValue(() => {}),
			// The queue moved into main, so the hook loads it on open and subscribes to
			// the broadcast. Without these the hook throws before it does anything else.
			getQueue: vi.fn().mockResolvedValue({ items: [], paused: false }),
			submitMessage: vi.fn().mockResolvedValue({ items: [], paused: false }),
			queueRemove: vi
				.fn()
				.mockResolvedValue({ state: { items: [], paused: false }, refused: false }),
			queueReorder: vi
				.fn()
				.mockResolvedValue({ state: { items: [], paused: false }, refused: false }),
			queueResume: vi.fn().mockResolvedValue({ items: [], paused: false }),
			onQueueState: vi.fn().mockReturnValue(() => {}),
			onParticipantsChanged: vi.fn().mockReturnValue(() => {}),
			onModeratorUsage: vi.fn().mockReturnValue(() => {}),
			onParticipantState: vi.fn().mockReturnValue(() => {}),
			onModeratorSessionIdChanged: vi.fn().mockReturnValue(() => {}),
		};
		(window as any).maestro.settings = {
			get: vi.fn().mockResolvedValue(undefined),
			set: vi.fn().mockResolvedValue(undefined),
		};
	});

	it('adopts the state that arrived during the load, not the one snapshotted before it', async () => {
		const { result } = renderHook(() => useGroupChatHandlers());

		await act(async () => {
			await result.current.handleOpenGroupChat(CHAT_ID);
		});

		// The authoritative per-chat map says idle, so the scalar the drain reads
		// must agree with it. Before the fix this is 'moderator-thinking', taken
		// from the map as it looked before `getMessages` resolved.
		expect(useGroupChatStore.getState().groupChatStates.get(CHAT_ID)).toBe('idle');
		expect(useGroupChatStore.getState().groupChatState).toBe('idle');
	});
});
