/**
 * Tests for useGroupChatHandlers hook (extracted from App.tsx Phase 2B)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useGroupChatHandlers } from '../../../renderer/hooks/groupChat/useGroupChatHandlers';
import { useGroupChatStore } from '../../../renderer/stores/groupChatStore';
import { useModalStore } from '../../../renderer/stores/modalStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useUIStore } from '../../../renderer/stores/uiStore';

// Mock notifyToast (module-level export can't be spied — must vi.mock)
vi.mock('../../../renderer/stores/notificationStore', async () => {
	const actual = await vi.importActual('../../../renderer/stores/notificationStore');
	return { ...actual, notifyToast: vi.fn() };
});
import { notifyToast } from '../../../renderer/stores/notificationStore';

// ---------------------------------------------------------------------------
// Mock window.maestro.groupChat (not in global setup)
// ---------------------------------------------------------------------------
const mockGroupChat = {
	load: vi.fn().mockResolvedValue(null),
	getMessages: vi.fn().mockResolvedValue([]),
	create: vi.fn().mockResolvedValue({ id: 'gc-new', name: 'New Chat' }),
	delete: vi.fn().mockResolvedValue(undefined),
	rename: vi.fn().mockResolvedValue(undefined),
	update: vi.fn().mockResolvedValue({ id: 'gc-1', name: 'Updated' }),
	list: vi.fn().mockResolvedValue([]),
	startModerator: vi.fn().mockResolvedValue('mod-session-1'),
	sendToModerator: vi.fn().mockResolvedValue(undefined),
	onMessage: vi.fn().mockReturnValue(() => {}),
	onStateChange: vi.fn().mockReturnValue(() => {}),
	onParticipantsChanged: vi.fn().mockReturnValue(() => {}),
	onModeratorUsage: vi.fn().mockReturnValue(() => {}),
	onParticipantState: vi.fn().mockReturnValue(() => {}),
	onModeratorSessionIdChanged: vi.fn().mockReturnValue(() => {}),
};

// ---------------------------------------------------------------------------
// Store reset helper
// ---------------------------------------------------------------------------
const initialGroupChatState = {
	groupChats: [],
	activeGroupChatId: null,
	groupChatMessages: [],
	groupChatState: 'idle' as const,
	participantStates: new Map(),
	moderatorUsage: null,
	groupChatStates: new Map(),
	allGroupChatParticipantStates: new Map(),
	groupChatExecutionQueue: [],
	groupChatReadOnlyMode: false,
	groupChatRightTab: 'participants' as const,
	groupChatParticipantColors: {},
	groupChatStagedImages: [],
	groupChatError: null,
};

beforeEach(() => {
	vi.clearAllMocks();

	// Reset stores
	useGroupChatStore.setState(initialGroupChatState);
	useModalStore.setState({ modals: new Map() });
	useSessionStore.setState({ sessions: [], activeSessionId: null });
	useUIStore.setState({ activeFocus: 'main' });

	// Attach groupChat mock
	if (!(window.maestro as any).groupChat) {
		(window.maestro as any).groupChat = mockGroupChat;
	}
	Object.assign((window.maestro as any).groupChat, mockGroupChat);
});

// ===========================================================================
// Tests
// ===========================================================================

describe('useGroupChatHandlers', () => {
	// -----------------------------------------------------------------------
	// Refs
	// -----------------------------------------------------------------------
	describe('refs', () => {
		it('returns groupChatInputRef and groupChatMessagesRef', () => {
			const { result } = renderHook(() => useGroupChatHandlers());
			expect(result.current.groupChatInputRef).toBeDefined();
			expect(result.current.groupChatMessagesRef).toBeDefined();
			expect(result.current.groupChatInputRef.current).toBeNull();
			expect(result.current.groupChatMessagesRef.current).toBeNull();
		});
	});

	// -----------------------------------------------------------------------
	// Error recovery
	// -----------------------------------------------------------------------
	describe('error recovery', () => {
		it('handleClearGroupChatError clears the error in the store', () => {
			useGroupChatStore.setState({
				groupChatError: { error: { type: 'authentication' } as any, groupChatId: 'gc-1' },
			});

			const { result } = renderHook(() => useGroupChatHandlers());
			act(() => result.current.handleClearGroupChatError());

			expect(useGroupChatStore.getState().groupChatError).toBeNull();
		});

		it('groupChatRecoveryActions is an array', () => {
			const { result } = renderHook(() => useGroupChatHandlers());
			expect(Array.isArray(result.current.groupChatRecoveryActions)).toBe(true);
		});
	});

	// -----------------------------------------------------------------------
	// handleCloseGroupChat
	// -----------------------------------------------------------------------
	describe('handleCloseGroupChat', () => {
		it('resets all active group chat state', () => {
			useGroupChatStore.setState({
				activeGroupChatId: 'gc-1',
				groupChatMessages: [{ role: 'user', content: 'test' }] as any,
				groupChatState: 'moderator-thinking',
				participantStates: new Map([['agent1', 'working']]),
				groupChatError: { error: { type: 'authentication' } as any, groupChatId: 'gc-1' },
			});

			const { result } = renderHook(() => useGroupChatHandlers());
			act(() => result.current.handleCloseGroupChat());

			const state = useGroupChatStore.getState();
			expect(state.activeGroupChatId).toBeNull();
			expect(state.groupChatMessages).toEqual([]);
			expect(state.groupChatState).toBe('idle');
			expect(state.participantStates.size).toBe(0);
			expect(state.groupChatError).toBeNull();
		});
	});

	// -----------------------------------------------------------------------
	// handleOpenGroupChat
	// -----------------------------------------------------------------------
	describe('handleOpenGroupChat', () => {
		it('opens a group chat and loads messages', async () => {
			const chat = { id: 'gc-1', name: 'Test Chat', participants: [] };
			const messages = [{ role: 'user', content: 'hello' }];
			mockGroupChat.load.mockResolvedValueOnce(chat);
			mockGroupChat.getMessages.mockResolvedValueOnce(messages);
			mockGroupChat.startModerator.mockResolvedValueOnce('mod-session-1');

			const { result } = renderHook(() => useGroupChatHandlers());
			await act(async () => {
				await result.current.handleOpenGroupChat('gc-1');
			});

			const state = useGroupChatStore.getState();
			expect(state.activeGroupChatId).toBe('gc-1');
			expect(state.groupChatMessages).toEqual(messages);
			expect(mockGroupChat.startModerator).toHaveBeenCalledWith('gc-1');
		});

		it('does nothing if chat load returns null', async () => {
			mockGroupChat.load.mockResolvedValueOnce(null);

			const { result } = renderHook(() => useGroupChatHandlers());
			await act(async () => {
				await result.current.handleOpenGroupChat('gc-nonexistent');
			});

			expect(useGroupChatStore.getState().activeGroupChatId).toBeNull();
		});

		it('restores saved right tab preference from settings', async () => {
			const chat = { id: 'gc-1', name: 'Chat', participants: [] };
			mockGroupChat.load.mockResolvedValueOnce(chat);
			mockGroupChat.getMessages.mockResolvedValueOnce([]);
			mockGroupChat.startModerator.mockResolvedValueOnce(null);
			(window.maestro.settings.get as any).mockResolvedValueOnce('history');

			const { result } = renderHook(() => useGroupChatHandlers());
			await act(async () => {
				await result.current.handleOpenGroupChat('gc-1');
			});

			expect(useGroupChatStore.getState().groupChatRightTab).toBe('history');
		});

		it('restores participant states from allGroupChatParticipantStates', async () => {
			const chat = { id: 'gc-1', name: 'Chat', participants: [] };
			const savedParticipants = new Map([
				['Agent A', 'working'],
				['Agent B', 'idle'],
			]);
			useGroupChatStore.setState({
				allGroupChatParticipantStates: new Map([['gc-1', savedParticipants]]),
			});
			mockGroupChat.load.mockResolvedValueOnce(chat);
			mockGroupChat.getMessages.mockResolvedValueOnce([]);
			mockGroupChat.startModerator.mockResolvedValueOnce(null);

			const { result } = renderHook(() => useGroupChatHandlers());
			await act(async () => {
				await result.current.handleOpenGroupChat('gc-1');
			});

			const ps = useGroupChatStore.getState().participantStates;
			expect(ps.get('Agent A')).toBe('working');
			expect(ps.get('Agent B')).toBe('idle');
		});

		it('restores groupChatState from groupChatStates map', async () => {
			const chat = { id: 'gc-1', name: 'Chat', participants: [] };
			useGroupChatStore.setState({
				groupChatStates: new Map([['gc-1', 'agent-working']]),
			});
			mockGroupChat.load.mockResolvedValueOnce(chat);
			mockGroupChat.getMessages.mockResolvedValueOnce([]);
			mockGroupChat.startModerator.mockResolvedValueOnce(null);

			const { result } = renderHook(() => useGroupChatHandlers());
			await act(async () => {
				await result.current.handleOpenGroupChat('gc-1');
			});

			expect(useGroupChatStore.getState().groupChatState).toBe('agent-working');
		});
	});

	// -----------------------------------------------------------------------
	// handleCreateGroupChat
	// -----------------------------------------------------------------------
	describe('handleCreateGroupChat', () => {
		it('creates a group chat, adds to store, closes modal, and opens it', async () => {
			const newChat = { id: 'gc-new', name: 'New Chat', participants: [] };
			mockGroupChat.create.mockResolvedValueOnce(newChat);
			mockGroupChat.load.mockResolvedValueOnce(newChat);
			mockGroupChat.getMessages.mockResolvedValueOnce([]);
			mockGroupChat.startModerator.mockResolvedValueOnce('mod-id');
			useModalStore.getState().openModal('newGroupChat');

			const { result } = renderHook(() => useGroupChatHandlers());
			await act(async () => {
				await result.current.handleCreateGroupChat('New Chat', 'claude-code');
			});

			expect(mockGroupChat.create).toHaveBeenCalledWith('New Chat', 'claude-code', undefined);
			// After create, handleOpenGroupChat also sets moderatorSessionId from startModerator
			const storedChat = useGroupChatStore.getState().groupChats.find((c) => c.id === 'gc-new');
			expect(storedChat).toBeDefined();
			expect(storedChat!.name).toBe('New Chat');
			// Modal should be closed
			const modal = useModalStore.getState().modals.get('newGroupChat');
			expect(modal?.open ?? false).toBe(false);
		});

		it('shows toast on validation error and does not re-throw', async () => {
			const validationError = new Error(
				"Error invoking remote method 'groupChat:create': Invalid moderator agent ID"
			);
			mockGroupChat.create.mockRejectedValueOnce(validationError);
			useModalStore.getState().openModal('newGroupChat');

			const { result } = renderHook(() => useGroupChatHandlers());
			// Should NOT throw
			await act(async () => {
				await result.current.handleCreateGroupChat('Chat', 'bad-agent');
			});

			expect(notifyToast).toHaveBeenCalledWith(
				expect.objectContaining({ type: 'error', title: 'Group Chat' })
			);
			// Modal closed even on error
			const modal = useModalStore.getState().modals.get('newGroupChat');
			expect(modal?.open ?? false).toBe(false);
		});

		it('re-throws unexpected errors after closing modal', async () => {
			const unexpectedError = new Error('Network timeout');
			mockGroupChat.create.mockRejectedValueOnce(unexpectedError);
			useModalStore.getState().openModal('newGroupChat');

			const { result } = renderHook(() => useGroupChatHandlers());
			await expect(
				act(async () => {
					await result.current.handleCreateGroupChat('Chat', 'claude-code');
				})
			).rejects.toThrow('Network timeout');

			expect(notifyToast).toHaveBeenCalledWith(
				expect.objectContaining({ type: 'error', message: 'Failed to create group chat' })
			);
		});

		it('passes moderator config to the IPC create call', async () => {
			const newChat = { id: 'gc-new', name: 'Chat', participants: [] };
			mockGroupChat.create.mockResolvedValueOnce(newChat);
			mockGroupChat.load.mockResolvedValueOnce(newChat);
			mockGroupChat.getMessages.mockResolvedValueOnce([]);
			mockGroupChat.startModerator.mockResolvedValueOnce(null);

			const config = { customPath: '/usr/local/bin/claude', customModel: 'opus' };
			const { result } = renderHook(() => useGroupChatHandlers());
			await act(async () => {
				await result.current.handleCreateGroupChat('Chat', 'claude-code', config);
			});

			expect(mockGroupChat.create).toHaveBeenCalledWith('Chat', 'claude-code', config);
		});
	});

	// -----------------------------------------------------------------------
	// handleDeleteGroupChat
	// -----------------------------------------------------------------------
	describe('handleDeleteGroupChat', () => {
		it('deletes a group chat and removes it from the store', async () => {
			useGroupChatStore.setState({
				groupChats: [{ id: 'gc-1', name: 'Chat 1' } as any, { id: 'gc-2', name: 'Chat 2' } as any],
			});

			const { result } = renderHook(() => useGroupChatHandlers());
			await act(async () => {
				await result.current.handleDeleteGroupChat('gc-1');
			});

			expect(mockGroupChat.delete).toHaveBeenCalledWith('gc-1');
			const chats = useGroupChatStore.getState().groupChats;
			expect(chats.length).toBe(1);
			expect(chats[0].id).toBe('gc-2');
		});

		it('closes active group chat if deleting the active one', async () => {
			useGroupChatStore.setState({
				groupChats: [{ id: 'gc-1', name: 'Chat 1' } as any],
				activeGroupChatId: 'gc-1',
				groupChatMessages: [{ role: 'user', content: 'test' }] as any,
			});

			const { result } = renderHook(() => useGroupChatHandlers());
			await act(async () => {
				await result.current.handleDeleteGroupChat('gc-1');
			});

			expect(useGroupChatStore.getState().activeGroupChatId).toBeNull();
			expect(useGroupChatStore.getState().groupChatMessages).toEqual([]);
		});

		it('closes the deleteGroupChat modal after deletion', async () => {
			useGroupChatStore.setState({
				groupChats: [{ id: 'gc-1', name: 'Chat' } as any],
			});
			useModalStore.getState().openModal('deleteGroupChat', { groupChatId: 'gc-1' });

			const { result } = renderHook(() => useGroupChatHandlers());
			await act(async () => {
				await result.current.handleDeleteGroupChat('gc-1');
			});

			const modal = useModalStore.getState().modals.get('deleteGroupChat');
			expect(modal?.open ?? false).toBe(false);
		});
	});

	// -----------------------------------------------------------------------
	// handleRenameGroupChat
	// -----------------------------------------------------------------------
	describe('handleRenameGroupChat', () => {
		it('renames a group chat in the store', async () => {
			useGroupChatStore.setState({
				groupChats: [{ id: 'gc-1', name: 'Old Name' } as any],
			});

			const { result } = renderHook(() => useGroupChatHandlers());
			await act(async () => {
				await result.current.handleRenameGroupChat('gc-1', 'New Name');
			});

			expect(mockGroupChat.rename).toHaveBeenCalledWith('gc-1', 'New Name');
			expect(useGroupChatStore.getState().groupChats[0].name).toBe('New Name');
		});

		it('closes the renameGroupChat modal after rename', async () => {
			useGroupChatStore.setState({
				groupChats: [{ id: 'gc-1', name: 'Old' } as any],
			});
			useModalStore.getState().openModal('renameGroupChat', { groupChatId: 'gc-1' });

			const { result } = renderHook(() => useGroupChatHandlers());
			await act(async () => {
				await result.current.handleRenameGroupChat('gc-1', 'New');
			});

			const modal = useModalStore.getState().modals.get('renameGroupChat');
			expect(modal?.open ?? false).toBe(false);
		});
	});

	// -----------------------------------------------------------------------
	// handleUpdateGroupChat
	// -----------------------------------------------------------------------
	describe('handleUpdateGroupChat', () => {
		it('updates a group chat and replaces it in the store', async () => {
			const updated = { id: 'gc-1', name: 'Updated', moderatorAgentId: 'claude-code' };
			mockGroupChat.update.mockResolvedValueOnce(updated);
			useGroupChatStore.setState({
				groupChats: [{ id: 'gc-1', name: 'Old', moderatorAgentId: 'codex' } as any],
			});

			const { result } = renderHook(() => useGroupChatHandlers());
			await act(async () => {
				await result.current.handleUpdateGroupChat('gc-1', 'Updated', 'claude-code');
			});

			expect(useGroupChatStore.getState().groupChats[0]).toEqual(updated);
		});

		it('closes the editGroupChat modal after update', async () => {
			mockGroupChat.update.mockResolvedValueOnce({ id: 'gc-1', name: 'Updated' });
			useGroupChatStore.setState({
				groupChats: [{ id: 'gc-1', name: 'Old' } as any],
			});
			useModalStore.getState().openModal('editGroupChat', { groupChatId: 'gc-1' });

			const { result } = renderHook(() => useGroupChatHandlers());
			await act(async () => {
				await result.current.handleUpdateGroupChat('gc-1', 'Updated', 'claude-code');
			});

			const modal = useModalStore.getState().modals.get('editGroupChat');
			expect(modal?.open ?? false).toBe(false);
		});
	});

	// -----------------------------------------------------------------------
	// deleteGroupChatWithConfirmation
	// -----------------------------------------------------------------------
	describe('deleteGroupChatWithConfirmation', () => {
		it('opens a confirm modal with the chat name', () => {
			useGroupChatStore.setState({
				groupChats: [{ id: 'gc-1', name: 'My Chat' } as any],
			});

			const { result } = renderHook(() => useGroupChatHandlers());
			act(() => result.current.deleteGroupChatWithConfirmation('gc-1'));

			const confirmModal = useModalStore.getState().modals.get('confirm');
			expect(confirmModal?.open).toBe(true);
			expect((confirmModal?.data as any)?.message).toContain('My Chat');
		});

		it('does nothing for nonexistent chat', () => {
			const { result } = renderHook(() => useGroupChatHandlers());
			act(() => result.current.deleteGroupChatWithConfirmation('gc-nonexistent'));

			const confirmModal = useModalStore.getState().modals.get('confirm');
			expect(confirmModal?.open ?? false).toBe(false);
		});
	});

	// -----------------------------------------------------------------------
	// handleSendGroupChatMessage
	// -----------------------------------------------------------------------
	describe('handleSendGroupChatMessage', () => {
		it('sends message to moderator when idle', async () => {
			useGroupChatStore.setState({
				activeGroupChatId: 'gc-1',
				groupChatState: 'idle',
				groupChats: [{ id: 'gc-1', name: 'Chat' } as any],
			});

			const { result } = renderHook(() => useGroupChatHandlers());
			await act(async () => {
				await result.current.handleSendGroupChatMessage('Hello', undefined, false);
			});

			expect(mockGroupChat.sendToModerator).toHaveBeenCalledWith('gc-1', 'Hello', undefined, false);
			expect(useGroupChatStore.getState().groupChatState).toBe('moderator-thinking');
		});

		it('sends message with images', async () => {
			useGroupChatStore.setState({
				activeGroupChatId: 'gc-1',
				groupChatState: 'idle',
				groupChats: [{ id: 'gc-1', name: 'Chat' } as any],
			});

			const { result } = renderHook(() => useGroupChatHandlers());
			await act(async () => {
				await result.current.handleSendGroupChatMessage('Look at this', ['img1.png', 'img2.png']);
			});

			expect(mockGroupChat.sendToModerator).toHaveBeenCalledWith(
				'gc-1',
				'Look at this',
				['img1.png', 'img2.png'],
				undefined
			);
		});

		it('updates groupChatStates map when sending', async () => {
			useGroupChatStore.setState({
				activeGroupChatId: 'gc-1',
				groupChatState: 'idle',
				groupChats: [{ id: 'gc-1', name: 'Chat' } as any],
				groupChatStates: new Map(),
			});

			const { result } = renderHook(() => useGroupChatHandlers());
			await act(async () => {
				await result.current.handleSendGroupChatMessage('Hello');
			});

			expect(useGroupChatStore.getState().groupChatStates.get('gc-1')).toBe('moderator-thinking');
		});

		it('queues message when chat is busy', async () => {
			useGroupChatStore.setState({
				activeGroupChatId: 'gc-1',
				groupChatState: 'moderator-thinking',
				groupChats: [{ id: 'gc-1', name: 'Chat' } as any],
			});

			const { result } = renderHook(() => useGroupChatHandlers());
			await act(async () => {
				await result.current.handleSendGroupChatMessage('Queued message');
			});

			expect(mockGroupChat.sendToModerator).not.toHaveBeenCalled();
			const queue = useGroupChatStore.getState().groupChatExecutionQueue;
			expect(queue.length).toBe(1);
			expect(queue[0].text).toBe('Queued message');
		});

		it('queued item has correct structure', async () => {
			useGroupChatStore.setState({
				activeGroupChatId: 'gc-1',
				groupChatState: 'agent-working',
				groupChats: [{ id: 'gc-1', name: 'My Chat' } as any],
			});

			const { result } = renderHook(() => useGroupChatHandlers());
			await act(async () => {
				await result.current.handleSendGroupChatMessage('msg', ['img.png'], true);
			});

			const queue = useGroupChatStore.getState().groupChatExecutionQueue;
			expect(queue[0]).toEqual(
				expect.objectContaining({
					text: 'msg',
					images: ['img.png'],
					readOnlyMode: true,
					tabId: 'gc-1',
					tabName: 'My Chat',
					type: 'message',
				})
			);
			expect(queue[0].id).toBeDefined();
			expect(queue[0].timestamp).toBeDefined();
		});

		it('does nothing when no active group chat', async () => {
			const { result } = renderHook(() => useGroupChatHandlers());
			await act(async () => {
				await result.current.handleSendGroupChatMessage('test');
			});

			expect(mockGroupChat.sendToModerator).not.toHaveBeenCalled();
		});
	});

	// -----------------------------------------------------------------------
	// handleGroupChatDraftChange
	// -----------------------------------------------------------------------
	describe('handleGroupChatDraftChange', () => {
		it('updates draft message for the active group chat', () => {
			useGroupChatStore.setState({
				activeGroupChatId: 'gc-1',
				groupChats: [{ id: 'gc-1', name: 'Chat', draftMessage: '' } as any],
			});

			const { result } = renderHook(() => useGroupChatHandlers());
			act(() => result.current.handleGroupChatDraftChange('new draft'));

			expect(useGroupChatStore.getState().groupChats[0].draftMessage).toBe('new draft');
		});

		it('does nothing when no active group chat', () => {
			useGroupChatStore.setState({
				groupChats: [{ id: 'gc-1', name: 'Chat', draftMessage: '' } as any],
			});

			const { result } = renderHook(() => useGroupChatHandlers());
			act(() => result.current.handleGroupChatDraftChange('test'));

			expect(useGroupChatStore.getState().groupChats[0].draftMessage).toBe('');
		});
	});

	// -----------------------------------------------------------------------
	// Queue item management
	// -----------------------------------------------------------------------
	describe('queue item management', () => {
		it('handleRemoveGroupChatQueueItem removes item by id', () => {
			useGroupChatStore.setState({
				groupChatExecutionQueue: [
					{ id: 'q-1', text: 'first' } as any,
					{ id: 'q-2', text: 'second' } as any,
				],
			});

			const { result } = renderHook(() => useGroupChatHandlers());
			act(() => result.current.handleRemoveGroupChatQueueItem('q-1'));

			const queue = useGroupChatStore.getState().groupChatExecutionQueue;
			expect(queue.length).toBe(1);
			expect(queue[0].id).toBe('q-2');
		});

		it('handleReorderGroupChatQueueItems reorders items', () => {
			useGroupChatStore.setState({
				groupChatExecutionQueue: [
					{ id: 'q-1', text: 'first' } as any,
					{ id: 'q-2', text: 'second' } as any,
					{ id: 'q-3', text: 'third' } as any,
				],
			});

			const { result } = renderHook(() => useGroupChatHandlers());
			act(() => result.current.handleReorderGroupChatQueueItems(0, 2));

			const queue = useGroupChatStore.getState().groupChatExecutionQueue;
			expect(queue[0].id).toBe('q-2');
			expect(queue[1].id).toBe('q-3');
			expect(queue[2].id).toBe('q-1');
		});
	});

	// -----------------------------------------------------------------------
	// handleGroupChatRightTabChange
	// -----------------------------------------------------------------------
	describe('handleGroupChatRightTabChange', () => {
		it('changes the right tab and persists the preference', () => {
			useGroupChatStore.setState({ activeGroupChatId: 'gc-1' });

			const { result } = renderHook(() => useGroupChatHandlers());
			act(() => result.current.handleGroupChatRightTabChange('history'));

			expect(useGroupChatStore.getState().groupChatRightTab).toBe('history');
			expect(window.maestro.settings.set).toHaveBeenCalledWith('groupChatRightTab:gc-1', 'history');
		});
	});

	// -----------------------------------------------------------------------
	// handleJumpToGroupChatMessage
	// -----------------------------------------------------------------------
	describe('handleJumpToGroupChatMessage', () => {
		it('calls scrollToMessage on the messages ref', () => {
			const mockScrollToMessage = vi.fn();
			const { result } = renderHook(() => useGroupChatHandlers());
			// Simulate mounting the ref
			(result.current.groupChatMessagesRef as any).current = {
				scrollToMessage: mockScrollToMessage,
			};

			act(() => result.current.handleJumpToGroupChatMessage(1234567890));

			expect(mockScrollToMessage).toHaveBeenCalledWith(1234567890);
		});

		it('does nothing if ref is null', () => {
			const { result } = renderHook(() => useGroupChatHandlers());
			// Should not throw
			act(() => result.current.handleJumpToGroupChatMessage(1234567890));
		});
	});

	// -----------------------------------------------------------------------
	// handleOpenModeratorSession
	// -----------------------------------------------------------------------
	describe('handleOpenModeratorSession', () => {
		it('navigates to the session containing the moderator', () => {
			useSessionStore.setState({
				sessions: [
					{
						id: 's-1',
						name: 'Session 1',
						aiTabs: [{ id: 'tab-1', agentSessionId: 'mod-session-1' }],
					} as any,
				],
			});
			useGroupChatStore.setState({ activeGroupChatId: 'gc-1' });

			const { result } = renderHook(() => useGroupChatHandlers());
			act(() => result.current.handleOpenModeratorSession('mod-session-1'));

			expect(useGroupChatStore.getState().activeGroupChatId).toBeNull();
			expect(useSessionStore.getState().activeSessionId).toBe('s-1');
		});

		it('activates the correct tab within the session', () => {
			useSessionStore.setState({
				sessions: [
					{
						id: 's-1',
						name: 'Session 1',
						activeTabId: 'tab-other',
						aiTabs: [
							{ id: 'tab-other', agentSessionId: 'other' },
							{ id: 'tab-mod', agentSessionId: 'mod-session-1' },
						],
					} as any,
				],
			});

			const { result } = renderHook(() => useGroupChatHandlers());
			act(() => result.current.handleOpenModeratorSession('mod-session-1'));

			const session = useSessionStore.getState().sessions[0];
			expect(session.activeTabId).toBe('tab-mod');
		});

		it('closes the active group chat when navigating', () => {
			useSessionStore.setState({
				sessions: [{ id: 's-1', aiTabs: [{ id: 'tab-1', agentSessionId: 'mod-1' }] } as any],
			});
			useGroupChatStore.setState({
				activeGroupChatId: 'gc-1',
				groupChatMessages: [{ role: 'user', content: 'test' }] as any,
				groupChatState: 'moderator-thinking',
			});

			const { result } = renderHook(() => useGroupChatHandlers());
			act(() => result.current.handleOpenModeratorSession('mod-1'));

			expect(useGroupChatStore.getState().activeGroupChatId).toBeNull();
			expect(useGroupChatStore.getState().groupChatMessages).toEqual([]);
			expect(useGroupChatStore.getState().groupChatState).toBe('idle');
		});

		it('does nothing if session not found', () => {
			useSessionStore.setState({ sessions: [] });

			const { result } = renderHook(() => useGroupChatHandlers());
			act(() => result.current.handleOpenModeratorSession('nonexistent'));

			expect(useSessionStore.getState().activeSessionId).toBeNull();
		});
	});

	// -----------------------------------------------------------------------
	// handleProcessMonitorNavigateToGroupChat
	// -----------------------------------------------------------------------
	describe('handleProcessMonitorNavigateToGroupChat', () => {
		it('sets active group chat, restores state, and closes process monitor', () => {
			useGroupChatStore.setState({
				groupChatStates: new Map([['gc-1', 'agent-working']]),
				allGroupChatParticipantStates: new Map([['gc-1', new Map([['Agent A', 'working']])]]),
			});
			useModalStore.getState().openModal('processMonitor');

			const { result } = renderHook(() => useGroupChatHandlers());
			act(() => result.current.handleProcessMonitorNavigateToGroupChat('gc-1'));

			expect(useGroupChatStore.getState().activeGroupChatId).toBe('gc-1');
			expect(useGroupChatStore.getState().groupChatState).toBe('agent-working');
			const pmModal = useModalStore.getState().modals.get('processMonitor');
			expect(pmModal?.open ?? false).toBe(false);
		});
	});

	// -----------------------------------------------------------------------
	// Modal openers
	// -----------------------------------------------------------------------
	describe('modal openers', () => {
		it('handleNewGroupChat opens newGroupChat modal', () => {
			const { result } = renderHook(() => useGroupChatHandlers());
			act(() => result.current.handleNewGroupChat());

			const modal = useModalStore.getState().modals.get('newGroupChat');
			expect(modal?.open).toBe(true);
		});

		it('handleEditGroupChat opens editGroupChat modal with id', () => {
			const { result } = renderHook(() => useGroupChatHandlers());
			act(() => result.current.handleEditGroupChat('gc-1'));

			const modal = useModalStore.getState().modals.get('editGroupChat');
			expect(modal?.open).toBe(true);
			expect((modal?.data as any)?.groupChatId).toBe('gc-1');
		});

		it('handleOpenRenameGroupChatModal opens renameGroupChat modal with id', () => {
			const { result } = renderHook(() => useGroupChatHandlers());
			act(() => result.current.handleOpenRenameGroupChatModal('gc-1'));

			const modal = useModalStore.getState().modals.get('renameGroupChat');
			expect(modal?.open).toBe(true);
			expect((modal?.data as any)?.groupChatId).toBe('gc-1');
		});

		it('handleOpenDeleteGroupChatModal opens deleteGroupChat modal with id', () => {
			const { result } = renderHook(() => useGroupChatHandlers());
			act(() => result.current.handleOpenDeleteGroupChatModal('gc-1'));

			const modal = useModalStore.getState().modals.get('deleteGroupChat');
			expect(modal?.open).toBe(true);
			expect((modal?.data as any)?.groupChatId).toBe('gc-1');
		});
	});

	// -----------------------------------------------------------------------
	// Modal closers
	// -----------------------------------------------------------------------
	describe('modal closers', () => {
		it('handleCloseNewGroupChatModal closes the modal', () => {
			useModalStore.getState().openModal('newGroupChat');
			const { result } = renderHook(() => useGroupChatHandlers());
			act(() => result.current.handleCloseNewGroupChatModal());

			const modal = useModalStore.getState().modals.get('newGroupChat');
			expect(modal?.open ?? false).toBe(false);
		});

		it('handleCloseDeleteGroupChatModal closes the modal', () => {
			useModalStore.getState().openModal('deleteGroupChat', { groupChatId: 'gc-1' });
			const { result } = renderHook(() => useGroupChatHandlers());
			act(() => result.current.handleCloseDeleteGroupChatModal());

			const modal = useModalStore.getState().modals.get('deleteGroupChat');
			expect(modal?.open ?? false).toBe(false);
		});

		it('handleCloseRenameGroupChatModal closes the modal', () => {
			useModalStore.getState().openModal('renameGroupChat', { groupChatId: 'gc-1' });
			const { result } = renderHook(() => useGroupChatHandlers());
			act(() => result.current.handleCloseRenameGroupChatModal());

			const modal = useModalStore.getState().modals.get('renameGroupChat');
			expect(modal?.open ?? false).toBe(false);
		});

		it('handleCloseEditGroupChatModal closes the modal', () => {
			useModalStore.getState().openModal('editGroupChat', { groupChatId: 'gc-1' });
			const { result } = renderHook(() => useGroupChatHandlers());
			act(() => result.current.handleCloseEditGroupChatModal());

			const modal = useModalStore.getState().modals.get('editGroupChat');
			expect(modal?.open ?? false).toBe(false);
		});

		it('handleCloseGroupChatInfo closes the modal', () => {
			useModalStore.getState().openModal('groupChatInfo');
			const { result } = renderHook(() => useGroupChatHandlers());
			act(() => result.current.handleCloseGroupChatInfo());

			const modal = useModalStore.getState().modals.get('groupChatInfo');
			expect(modal?.open ?? false).toBe(false);
		});
	});

	// -----------------------------------------------------------------------
	// handleConfirmDeleteGroupChat
	// -----------------------------------------------------------------------
	describe('handleConfirmDeleteGroupChat', () => {
		it('deletes the group chat from the delete modal data', async () => {
			useGroupChatStore.setState({
				groupChats: [{ id: 'gc-1', name: 'Chat' } as any],
			});
			useModalStore.getState().openModal('deleteGroupChat', { groupChatId: 'gc-1' });

			const { result } = renderHook(() => useGroupChatHandlers());
			await act(async () => {
				result.current.handleConfirmDeleteGroupChat();
			});

			expect(mockGroupChat.delete).toHaveBeenCalledWith('gc-1');
		});

		it('does nothing when no modal data', () => {
			const { result } = renderHook(() => useGroupChatHandlers());
			act(() => result.current.handleConfirmDeleteGroupChat());

			expect(mockGroupChat.delete).not.toHaveBeenCalled();
		});
	});

	// -----------------------------------------------------------------------
	// handleRenameGroupChatFromModal
	// -----------------------------------------------------------------------
	describe('handleRenameGroupChatFromModal', () => {
		it('renames the group chat from the rename modal data', async () => {
			useGroupChatStore.setState({
				groupChats: [{ id: 'gc-1', name: 'Old Name' } as any],
			});
			useModalStore.getState().openModal('renameGroupChat', { groupChatId: 'gc-1' });

			const { result } = renderHook(() => useGroupChatHandlers());
			await act(async () => {
				result.current.handleRenameGroupChatFromModal('New Name');
			});

			expect(mockGroupChat.rename).toHaveBeenCalledWith('gc-1', 'New Name');
			expect(useGroupChatStore.getState().groupChats[0].name).toBe('New Name');
		});

		it('does nothing when no rename modal data', () => {
			const { result } = renderHook(() => useGroupChatHandlers());
			act(() => result.current.handleRenameGroupChatFromModal('New Name'));

			expect(mockGroupChat.rename).not.toHaveBeenCalled();
		});
	});

	// -----------------------------------------------------------------------
	// IPC event listeners
	// -----------------------------------------------------------------------
	describe('IPC event listeners', () => {
		it('registers global listeners on mount (without activeGroupChatId)', () => {
			renderHook(() => useGroupChatHandlers());

			// Global listeners registered unconditionally
			expect(mockGroupChat.onStateChange).toHaveBeenCalled();
			expect(mockGroupChat.onParticipantsChanged).toHaveBeenCalled();
			expect(mockGroupChat.onParticipantState).toHaveBeenCalled();
			expect(mockGroupChat.onModeratorSessionIdChanged).toHaveBeenCalled();

			// Active-chat listeners NOT registered when no activeGroupChatId
			expect(mockGroupChat.onMessage).not.toHaveBeenCalled();
			expect(mockGroupChat.onModeratorUsage).not.toHaveBeenCalled();
		});

		it('registers active-chat listeners when activeGroupChatId is set', () => {
			useGroupChatStore.setState({ activeGroupChatId: 'gc-1' });
			renderHook(() => useGroupChatHandlers());

			expect(mockGroupChat.onMessage).toHaveBeenCalled();
			expect(mockGroupChat.onModeratorUsage).toHaveBeenCalled();
		});

		it('calls all cleanup functions on unmount', () => {
			useGroupChatStore.setState({ activeGroupChatId: 'gc-1' });

			const cleanups = Array.from({ length: 6 }, () => vi.fn());
			mockGroupChat.onStateChange.mockReturnValueOnce(cleanups[0]);
			mockGroupChat.onParticipantsChanged.mockReturnValueOnce(cleanups[1]);
			mockGroupChat.onParticipantState.mockReturnValueOnce(cleanups[2]);
			mockGroupChat.onModeratorSessionIdChanged.mockReturnValueOnce(cleanups[3]);
			mockGroupChat.onMessage.mockReturnValueOnce(cleanups[4]);
			mockGroupChat.onModeratorUsage.mockReturnValueOnce(cleanups[5]);

			const { unmount } = renderHook(() => useGroupChatHandlers());
			unmount();

			cleanups.forEach((fn) => expect(fn).toHaveBeenCalled());
		});

		it('onMessage callback appends message when activeGroupChatId matches', () => {
			useGroupChatStore.setState({
				activeGroupChatId: 'gc-1',
				groupChatMessages: [{ role: 'user', content: 'existing' }] as any,
			});

			let messageCallback: any;
			mockGroupChat.onMessage.mockImplementation((cb: any) => {
				messageCallback = cb;
				return () => {};
			});

			renderHook(() => useGroupChatHandlers());
			act(() => messageCallback('gc-1', { role: 'assistant', content: 'new' }));

			const msgs = useGroupChatStore.getState().groupChatMessages;
			expect(msgs.length).toBe(2);
			expect(msgs[1]).toEqual({ role: 'assistant', content: 'new' });
		});

		it('onMessage callback ignores messages for other group chats', () => {
			useGroupChatStore.setState({
				activeGroupChatId: 'gc-1',
				groupChatMessages: [],
			});

			let messageCallback: any;
			mockGroupChat.onMessage.mockImplementation((cb: any) => {
				messageCallback = cb;
				return () => {};
			});

			renderHook(() => useGroupChatHandlers());
			act(() => messageCallback('gc-other', { role: 'assistant', content: 'nope' }));

			expect(useGroupChatStore.getState().groupChatMessages.length).toBe(0);
		});

		it('onStateChange callback updates active and global state', () => {
			useGroupChatStore.setState({
				activeGroupChatId: 'gc-1',
				groupChatState: 'idle',
				groupChatStates: new Map(),
			});

			let stateCallback: any;
			mockGroupChat.onStateChange.mockImplementationOnce((cb: any) => {
				stateCallback = cb;
				return () => {};
			});

			renderHook(() => useGroupChatHandlers());
			act(() => stateCallback('gc-1', 'agent-working'));

			expect(useGroupChatStore.getState().groupChatState).toBe('agent-working');
			expect(useGroupChatStore.getState().groupChatStates.get('gc-1')).toBe('agent-working');
		});

		it('onStateChange tracks non-active group chat state in global map only', () => {
			useGroupChatStore.setState({
				activeGroupChatId: 'gc-1',
				groupChatState: 'idle',
				groupChatStates: new Map(),
			});

			let stateCallback: any;
			mockGroupChat.onStateChange.mockImplementationOnce((cb: any) => {
				stateCallback = cb;
				return () => {};
			});

			renderHook(() => useGroupChatHandlers());
			act(() => stateCallback('gc-other', 'moderator-thinking'));

			// Active chat state unchanged
			expect(useGroupChatStore.getState().groupChatState).toBe('idle');
			// Global map updated
			expect(useGroupChatStore.getState().groupChatStates.get('gc-other')).toBe(
				'moderator-thinking'
			);
		});

		it('onParticipantsChanged callback updates participants for the chat', () => {
			useGroupChatStore.setState({
				groupChats: [{ id: 'gc-1', name: 'Chat', participants: [] } as any],
			});

			let participantsCallback: any;
			mockGroupChat.onParticipantsChanged.mockImplementationOnce((cb: any) => {
				participantsCallback = cb;
				return () => {};
			});

			renderHook(() => useGroupChatHandlers());
			const newParticipants = [{ name: 'Agent A' }, { name: 'Agent B' }];
			act(() => participantsCallback('gc-1', newParticipants));

			expect(useGroupChatStore.getState().groupChats[0].participants).toEqual(newParticipants);
		});

		it('onModeratorSessionIdChanged callback updates the moderator agent session id', () => {
			useGroupChatStore.setState({
				groupChats: [{ id: 'gc-1', name: 'Chat' } as any],
			});

			let sessionIdCallback: any;
			mockGroupChat.onModeratorSessionIdChanged.mockImplementationOnce((cb: any) => {
				sessionIdCallback = cb;
				return () => {};
			});

			renderHook(() => useGroupChatHandlers());
			act(() => sessionIdCallback('gc-1', 'new-agent-session-42'));

			expect(useGroupChatStore.getState().groupChats[0].moderatorAgentSessionId).toBe(
				'new-agent-session-42'
			);
		});

		it('onParticipantState callback updates active and global participant states', () => {
			useGroupChatStore.setState({
				activeGroupChatId: 'gc-1',
				participantStates: new Map(),
				allGroupChatParticipantStates: new Map(),
			});

			let participantStateCallback: any;
			mockGroupChat.onParticipantState.mockImplementationOnce((cb: any) => {
				participantStateCallback = cb;
				return () => {};
			});

			renderHook(() => useGroupChatHandlers());
			act(() => participantStateCallback('gc-1', 'Agent A', 'working'));

			// Active chat participant states
			expect(useGroupChatStore.getState().participantStates.get('Agent A')).toBe('working');
			// Global map
			const allStates = useGroupChatStore.getState().allGroupChatParticipantStates;
			expect(allStates.get('gc-1')?.get('Agent A')).toBe('working');
		});

		it('onModeratorUsage callback updates moderator usage for active chat', () => {
			useGroupChatStore.setState({ activeGroupChatId: 'gc-1' });

			let usageCallback: any;
			mockGroupChat.onModeratorUsage.mockImplementationOnce((cb: any) => {
				usageCallback = cb;
				return () => {};
			});

			renderHook(() => useGroupChatHandlers());
			act(() => usageCallback('gc-1', { contextUsage: 0.5, totalCost: 0.01, tokenCount: 100 }));

			expect(useGroupChatStore.getState().moderatorUsage).toEqual({
				contextUsage: 0.5,
				totalCost: 0.01,
				tokenCount: 100,
			});
		});

		it('onModeratorUsage preserves previous context when contextUsage is -1', () => {
			useGroupChatStore.setState({
				activeGroupChatId: 'gc-1',
				moderatorUsage: { contextUsage: 0.5, totalCost: 0.01, tokenCount: 100 },
			});

			let usageCallback: any;
			mockGroupChat.onModeratorUsage.mockImplementationOnce((cb: any) => {
				usageCallback = cb;
				return () => {};
			});

			renderHook(() => useGroupChatHandlers());
			act(() => usageCallback('gc-1', { contextUsage: -1, totalCost: 0.05, tokenCount: 200 }));

			const usage = useGroupChatStore.getState().moderatorUsage;
			expect(usage?.contextUsage).toBe(0.5); // Preserved
			expect(usage?.totalCost).toBe(0.05); // Updated
			expect(usage?.tokenCount).toBe(100); // Preserved
		});
	});

	// -----------------------------------------------------------------------
	// Execution queue processor effect
	// -----------------------------------------------------------------------
	describe('execution queue processor', () => {
		it('sends next queued item when state becomes idle', async () => {
			const queuedItem = {
				id: 'q-1',
				text: 'queued msg',
				images: undefined,
				readOnlyMode: false,
				timestamp: Date.now(),
				tabId: 'gc-1',
				tabName: 'Chat',
				type: 'message' as const,
			};

			// Start with idle state and a queued item — the effect should fire
			useGroupChatStore.setState({
				activeGroupChatId: 'gc-1',
				groupChatState: 'idle',
				groupChatExecutionQueue: [queuedItem],
			});

			const { result } = renderHook(() => useGroupChatHandlers());

			// Wait for effect to process
			await act(async () => {
				await new Promise((r) => setTimeout(r, 10));
			});

			expect(mockGroupChat.sendToModerator).toHaveBeenCalledWith(
				'gc-1',
				'queued msg',
				undefined,
				false
			);
			expect(useGroupChatStore.getState().groupChatExecutionQueue.length).toBe(0);
			expect(useGroupChatStore.getState().groupChatState).toBe('moderator-thinking');
		});

		it('does not process queue when state is not idle', () => {
			useGroupChatStore.setState({
				activeGroupChatId: 'gc-1',
				groupChatState: 'moderator-thinking',
				groupChatExecutionQueue: [{ id: 'q-1', text: 'msg' } as any],
			});

			renderHook(() => useGroupChatHandlers());

			expect(mockGroupChat.sendToModerator).not.toHaveBeenCalled();
		});

		it('does not process queue when no active group chat', () => {
			useGroupChatStore.setState({
				activeGroupChatId: null,
				groupChatState: 'idle',
				groupChatExecutionQueue: [{ id: 'q-1', text: 'msg' } as any],
			});

			renderHook(() => useGroupChatHandlers());

			expect(mockGroupChat.sendToModerator).not.toHaveBeenCalled();
		});
	});

	// -----------------------------------------------------------------------
	// handleGroupChatRightTabChange — no active chat
	// -----------------------------------------------------------------------
	describe('handleGroupChatRightTabChange edge cases', () => {
		it('does not persist to settings when no active group chat', () => {
			useGroupChatStore.setState({ activeGroupChatId: null });

			const { result } = renderHook(() => useGroupChatHandlers());
			act(() => result.current.handleGroupChatRightTabChange('history'));

			expect(useGroupChatStore.getState().groupChatRightTab).toBe('history');
			expect(window.maestro.settings.set).not.toHaveBeenCalled();
		});
	});
});
