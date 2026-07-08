import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useGroupChatHandlers } from '../../renderer/hooks/groupChat/useGroupChatHandlers';
import { useBatchStore } from '../../renderer/stores/batchStore';
import { useGroupChatStore } from '../../renderer/stores/groupChatStore';
import { useModalStore } from '../../renderer/stores/modalStore';
import { notifyToast } from '../../renderer/stores/notificationStore';
import { useSessionStore } from '../../renderer/stores/sessionStore';
import { useUIStore } from '../../renderer/stores/uiStore';
import {
	consumeGroupChatAutoRun,
	registerGroupChatAutoRun,
} from '../../renderer/utils/groupChatAutoRunRegistry';

vi.mock('../../renderer/stores/notificationStore', async () => {
	const actual = await vi.importActual<typeof import('../../renderer/stores/notificationStore')>(
		'../../renderer/stores/notificationStore'
	);
	return { ...actual, notifyToast: vi.fn() };
});

type Listener = (...args: any[]) => void;

function createInitialGroupChatState() {
	return {
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
		participantLiveOutput: new Map(),
		groupChatError: null,
	};
}

const originalDispatchBatch = useBatchStore.getState().dispatchBatch;
let listeners: Record<string, Listener>;
let unsubscribes: Record<string, ReturnType<typeof vi.fn>>;
let groupChatBridge: ReturnType<typeof createGroupChatBridge>;

function createGroupChatBridge() {
	unsubscribes = {
		state: vi.fn(),
		participants: vi.fn(),
		participantState: vi.fn(),
		liveOutput: vi.fn(),
		moderatorSession: vi.fn(),
		batchComplete: vi.fn(),
		message: vi.fn(),
		usage: vi.fn(),
	};
	listeners = {};

	return {
		load: vi.fn().mockResolvedValue(null),
		getMessages: vi.fn().mockResolvedValue([]),
		create: vi.fn().mockResolvedValue({ id: 'gc-new', name: 'New Chat', participants: [] }),
		delete: vi.fn().mockResolvedValue(undefined),
		rename: vi.fn().mockResolvedValue(undefined),
		update: vi.fn().mockResolvedValue({ id: 'gc-1', name: 'Updated' }),
		startModerator: vi.fn().mockResolvedValue(null),
		sendToModerator: vi.fn().mockResolvedValue(undefined),
		archive: vi.fn().mockResolvedValue({ id: 'gc-1', name: 'Archived', archived: true }),
		stopAll: vi.fn().mockResolvedValue(undefined),
		onStateChange: vi.fn((handler: Listener) => {
			listeners.state = handler;
			return unsubscribes.state;
		}),
		onParticipantsChanged: vi.fn((handler: Listener) => {
			listeners.participants = handler;
			return unsubscribes.participants;
		}),
		onParticipantState: vi.fn((handler: Listener) => {
			listeners.participantState = handler;
			return unsubscribes.participantState;
		}),
		onParticipantLiveOutput: vi.fn((handler: Listener) => {
			listeners.liveOutput = handler;
			return unsubscribes.liveOutput;
		}),
		onModeratorSessionIdChanged: vi.fn((handler: Listener) => {
			listeners.moderatorSession = handler;
			return unsubscribes.moderatorSession;
		}),
		onAutoRunBatchComplete: vi.fn((handler: Listener) => {
			listeners.batchComplete = handler;
			return unsubscribes.batchComplete;
		}),
		onMessage: vi.fn((handler: Listener) => {
			listeners.message = handler;
			return unsubscribes.message;
		}),
		onModeratorUsage: vi.fn((handler: Listener) => {
			listeners.usage = handler;
			return unsubscribes.usage;
		}),
	};
}

function resetStores() {
	useGroupChatStore.setState(createInitialGroupChatState());
	useModalStore.setState({ modals: new Map() });
	useSessionStore.setState({ sessions: [], activeSessionId: null });
	useUIStore.setState({ activeFocus: 'terminal' });
	useBatchStore.setState({ dispatchBatch: originalDispatchBatch });
}

async function flushEffects() {
	await act(async () => {
		await Promise.resolve();
	});
}

describe('useGroupChatHandlers integration', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useRealTimers();
		resetStores();
		groupChatBridge = createGroupChatBridge();
		(window.maestro as any).groupChat = groupChatBridge;
		vi.mocked(window.maestro.settings.get).mockResolvedValue(undefined);
		vi.mocked(window.maestro.settings.set).mockResolvedValue(undefined);
	});

	afterEach(() => {
		cleanup();
		vi.useRealTimers();
		useBatchStore.setState({ dispatchBatch: originalDispatchBatch });
		for (const id of [
			'session-auto',
			'session-fallback',
			'session-stop',
			'session-other',
			'session-mismatch',
		]) {
			consumeGroupChatAutoRun(id);
		}
	});

	it('coordinates IPC listeners with active and background group chat store state', () => {
		const dispatchBatch = vi.fn();
		useBatchStore.setState({ dispatchBatch });
		useGroupChatStore.setState({
			activeGroupChatId: 'gc-1',
			groupChats: [
				{ id: 'gc-1', name: 'Primary', participants: [] } as any,
				{ id: 'gc-2', name: 'Other', participants: [{ name: 'Keep' }] } as any,
			],
			groupChatMessages: [{ role: 'user', content: 'existing' }] as any,
			moderatorUsage: { contextUsage: 0.4, totalCost: 0.01, tokenCount: 120 },
			participantLiveOutput: new Map([['gc-1:Agent A', 'streaming']]),
		});
		useSessionStore.setState({
			sessions: [
				{ id: 'session-auto', name: 'Agent A' } as any,
				{ id: 'session-fallback', name: 'Agent B' } as any,
			],
		});
		registerGroupChatAutoRun('session-auto', 'gc-1', 'Agent A');

		const { unmount } = renderHook(() => useGroupChatHandlers());

		act(() => listeners.state('gc-1', 'agent-working'));
		act(() => listeners.state('gc-2', 'moderator-thinking'));
		act(() => listeners.participants('gc-1', [{ name: 'Agent A' }]));
		act(() => listeners.participantState('gc-1', 'Agent A', 'working'));
		act(() => listeners.liveOutput('gc-1', 'Agent A', ' output'));
		act(() => listeners.liveOutput('gc-2', 'Agent B', ' ignored'));
		act(() => listeners.participantState('gc-1', 'Agent A', 'idle'));
		act(() => listeners.participantState('gc-2', 'Agent B', 'working'));
		act(() => listeners.moderatorSession('gc-1', 'moderator-agent-session'));
		act(() => listeners.batchComplete('gc-1', 'Agent A'));
		act(() => listeners.batchComplete('gc-1', 'Agent B'));
		act(() => listeners.batchComplete('gc-1', 'Missing Agent'));
		act(() => listeners.message('gc-1', { role: 'assistant', content: 'new' }));
		act(() => listeners.message('gc-2', { role: 'assistant', content: 'ignored' }));
		act(() => listeners.usage('gc-1', { contextUsage: -1, totalCost: 0.05, tokenCount: 999 }));
		act(() => listeners.usage('gc-1', { contextUsage: 0.7, totalCost: 0.06, tokenCount: 200 }));
		act(() => listeners.usage('gc-2', { contextUsage: 0.9, totalCost: 1, tokenCount: 1 }));

		const state = useGroupChatStore.getState();
		expect(state.groupChatState).toBe('agent-working');
		expect(state.groupChatStates.get('gc-2')).toBe('moderator-thinking');
		expect(state.groupChats[0]).toEqual(
			expect.objectContaining({
				participants: [{ name: 'Agent A' }],
				moderatorAgentSessionId: 'moderator-agent-session',
			})
		);
		expect(state.participantStates.get('Agent A')).toBe('idle');
		expect(state.allGroupChatParticipantStates.get('gc-2')?.get('Agent B')).toBe('working');
		expect(state.participantLiveOutput.has('gc-1:Agent A')).toBe(false);
		expect(state.groupChatMessages).toHaveLength(2);
		expect(state.moderatorUsage).toEqual({ contextUsage: 0.7, totalCost: 0.06, tokenCount: 200 });
		expect(dispatchBatch).toHaveBeenCalledWith({
			type: 'COMPLETE_BATCH',
			sessionId: 'session-auto',
		});
		expect(dispatchBatch).toHaveBeenCalledWith({
			type: 'COMPLETE_BATCH',
			sessionId: 'session-fallback',
		});

		unmount();
		Object.values(unsubscribes).forEach((unsubscribe) => expect(unsubscribe).toHaveBeenCalled());
	});

	it('opens, creates, updates, archives, renames, and deletes chats through IPC and stores', async () => {
		vi.useFakeTimers();
		const focus = vi.fn();
		useGroupChatStore.setState({
			groupChats: [
				{ id: 'gc-1', name: 'Original', participants: [] } as any,
				{ id: 'gc-2', name: 'Other', participants: [] } as any,
			],
			groupChatStates: new Map([['gc-1', 'agent-working']]),
			allGroupChatParticipantStates: new Map([['gc-1', new Map([['Agent A', 'working']])]]),
		});
		groupChatBridge.load.mockResolvedValue({ id: 'gc-1', name: 'Original', participants: [] });
		groupChatBridge.getMessages.mockResolvedValue([{ role: 'user', content: 'loaded' }]);
		groupChatBridge.startModerator
			.mockResolvedValueOnce('moderator-session')
			.mockRejectedValueOnce(new Error('moderator unavailable'));
		groupChatBridge.update.mockResolvedValueOnce({
			id: 'gc-1',
			name: 'Updated',
			moderatorAgentId: 'claude-code',
		});
		groupChatBridge.archive.mockResolvedValueOnce({ id: 'gc-1', name: 'Updated', archived: true });
		vi.mocked(window.maestro.settings.get)
			.mockResolvedValueOnce('history')
			.mockResolvedValueOnce('unknown');

		const { result } = renderHook(() => useGroupChatHandlers());
		(result.current.groupChatInputRef as any).current = { focus };

		await act(async () => {
			await result.current.handleOpenGroupChat('gc-1');
		});
		act(() => vi.advanceTimersByTime(100));

		expect(useGroupChatStore.getState().activeGroupChatId).toBe('gc-1');
		expect(useGroupChatStore.getState().groupChatMessages).toEqual([
			{ role: 'user', content: 'loaded' },
		]);
		expect(useGroupChatStore.getState().groupChatState).toBe('agent-working');
		expect(useGroupChatStore.getState().participantStates.get('Agent A')).toBe('working');
		expect(useGroupChatStore.getState().groupChatRightTab).toBe('history');
		expect(useGroupChatStore.getState().groupChats[0].moderatorSessionId).toBe('moderator-session');
		expect(useUIStore.getState().activeFocus).toBe('main');
		expect(focus).toHaveBeenCalled();

		await act(async () => {
			await result.current.handleOpenGroupChat('gc-1');
		});
		expect(useGroupChatStore.getState().groupChatRightTab).toBe('participants');
		expect(window.maestro.logger.log).toHaveBeenCalledWith(
			'warn',
			'Failed to start moderator for group chat gc-1:',
			undefined,
			expect.any(Error)
		);

		groupChatBridge.load.mockResolvedValueOnce(null);
		useModalStore.getState().openModal('newGroupChat');
		await act(async () => {
			await result.current.handleCreateGroupChat('Created', 'claude-code', {
				customPath: '/bin/agent',
				customModel: 'opus',
			});
		});
		expect(groupChatBridge.create).toHaveBeenCalledWith('Created', 'claude-code', {
			customPath: '/bin/agent',
			customModel: 'opus',
		});
		expect(useModalStore.getState().modals.get('newGroupChat')?.open ?? false).toBe(false);
		expect(useGroupChatStore.getState().groupChats[0].id).toBe('gc-new');

		useModalStore.getState().openModal('editGroupChat', { groupChatId: 'gc-1' });
		await act(async () => {
			await result.current.handleUpdateGroupChat('gc-1', 'Updated', 'claude-code', {
				customArgs: '--fast',
			});
		});
		expect(groupChatBridge.update).toHaveBeenCalledWith('gc-1', {
			name: 'Updated',
			moderatorAgentId: 'claude-code',
			moderatorConfig: { customArgs: '--fast' },
		});
		expect(useModalStore.getState().modals.get('editGroupChat')?.open ?? false).toBe(false);

		useModalStore.getState().openModal('renameGroupChat', { groupChatId: 'gc-1' });
		await act(async () => {
			result.current.handleRenameGroupChatFromModal('Renamed');
		});
		await flushEffects();
		expect(groupChatBridge.rename).toHaveBeenCalledWith('gc-1', 'Renamed');

		act(() => {
			useGroupChatStore.setState({ activeGroupChatId: 'gc-1' });
		});
		await act(async () => {
			await result.current.handleArchiveGroupChat('gc-1', true);
		});
		expect(useGroupChatStore.getState().activeGroupChatId).toBeNull();

		act(() => {
			useGroupChatStore.setState({
				groupChats: [{ id: 'gc-2', name: 'Delete Me' } as any],
				activeGroupChatId: 'gc-2',
				groupChatMessages: [{ role: 'user', content: 'clear' }] as any,
			});
		});
		useModalStore.getState().openModal('deleteGroupChat', { groupChatId: 'gc-2' });
		await act(async () => {
			result.current.handleConfirmDeleteGroupChat();
		});
		await flushEffects();
		expect(groupChatBridge.delete).toHaveBeenCalledWith('gc-2');
		expect(useGroupChatStore.getState().activeGroupChatId).toBeNull();
		expect(useGroupChatStore.getState().groupChatMessages).toEqual([]);
		expect(useModalStore.getState().modals.get('deleteGroupChat')?.open ?? false).toBe(false);
	});

	it('handles create validation failures, unexpected create failures, and stop-all failures', async () => {
		groupChatBridge.create.mockRejectedValueOnce(
			new Error("Error invoking remote method 'groupChat:create': Invalid moderator agent ID")
		);

		const { result } = renderHook(() => useGroupChatHandlers());
		useModalStore.getState().openModal('newGroupChat');
		await act(async () => {
			await result.current.handleCreateGroupChat('Bad', 'bad-agent');
		});
		expect(notifyToast).toHaveBeenCalledWith({
			type: 'error',
			title: 'Group Chat',
			message: 'Invalid moderator agent ID',
		});

		groupChatBridge.create.mockRejectedValueOnce('transport failed');
		let thrown: unknown;
		await act(async () => {
			try {
				await result.current.handleCreateGroupChat('Bad', 'claude-code');
			} catch (error) {
				thrown = error;
			}
		});
		expect(thrown).toBe('transport failed');
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({ message: 'Failed to create group chat' })
		);

		groupChatBridge.stopAll.mockRejectedValueOnce(new Error('stop failed'));
		useGroupChatStore.setState({ activeGroupChatId: 'gc-1' });
		await act(async () => {
			await result.current.handleStopAll();
		});
		expect(window.maestro.logger.log).toHaveBeenCalledWith(
			'error',
			'[GroupChat] Failed to stop all:',
			undefined,
			expect.any(Error)
		);
		expect(notifyToast).toHaveBeenCalledWith({
			type: 'error',
			title: 'Stop Failed',
			message: 'Failed to stop all group chat conversations. Please try again.',
		});
	});

	it('routes messages, queued work, drafts, navigation, and modal controls across stores', async () => {
		const scrollToMessage = vi.fn();
		const dispatchBatch = vi.fn();
		useBatchStore.setState({ dispatchBatch });
		useGroupChatStore.setState({
			activeGroupChatId: 'gc-1',
			groupChats: [
				{ id: 'gc-1', name: 'Chat', draftMessage: '' } as any,
				{ id: 'gc-2', name: 'Other', draftMessage: 'keep' } as any,
			],
			groupChatStates: new Map([['gc-2', 'moderator-thinking']]),
			allGroupChatParticipantStates: new Map([['gc-2', new Map([['Agent B', 'working']])]]),
		});
		useSessionStore.setState({
			sessions: [
				{
					id: 'session-1',
					activeTabId: 'tab-old',
					aiTabs: [
						{ id: 'tab-old', agentSessionId: 'old' },
						{ id: 'tab-mod', agentSessionId: 'moderator-session' },
					],
				} as any,
			],
		});
		registerGroupChatAutoRun('session-stop', 'gc-1', 'Agent A');
		registerGroupChatAutoRun('session-other', 'gc-2', 'Agent B');

		const { result, unmount } = renderHook(() => useGroupChatHandlers());
		(result.current.groupChatMessagesRef as any).current = { scrollToMessage };

		await act(async () => {
			await result.current.handleSendGroupChatMessage('hello', ['img.png'], true);
		});
		expect(groupChatBridge.sendToModerator).toHaveBeenCalledWith(
			'gc-1',
			'hello',
			['img.png'],
			true
		);
		expect(useGroupChatStore.getState().groupChatState).toBe('moderator-thinking');

		const queuedImagePaths = ['q.png'];
		await act(async () => {
			await result.current.handleSendGroupChatMessage('queued', queuedImagePaths, false);
		});
		let queue = useGroupChatStore.getState().groupChatExecutionQueue;
		expect(queue[0]).toEqual(
			expect.objectContaining({
				text: 'queued',
				images: ['q.png'],
				tabName: 'Chat',
				readOnlyMode: false,
			})
		);
		const queuedImages = queue[0].images;
		expect(queuedImages).not.toBe(queuedImagePaths);

		act(() => result.current.handleGroupChatDraftChange('draft'));
		expect(useGroupChatStore.getState().groupChats[0].draftMessage).toBe('draft');
		expect(useGroupChatStore.getState().groupChats[1].draftMessage).toBe('keep');

		act(() => {
			result.current.handleRemoveGroupChatQueueItem(queue[0].id);
		});
		expect(useGroupChatStore.getState().groupChatExecutionQueue).toEqual([]);

		act(() => {
			useGroupChatStore.setState({
				activeGroupChatId: 'gc-1',
				groupChatExecutionQueue: [
					{ id: 'q-1', text: 'first' } as any,
					{ id: 'q-2', text: 'second' } as any,
					{ id: 'q-3', images: ['only-image'], readOnlyMode: true } as any,
				],
				groupChatState: 'moderator-thinking',
			});
		});
		act(() => result.current.handleReorderGroupChatQueueItems(0, 2));
		expect(useGroupChatStore.getState().groupChatExecutionQueue.map((item) => item.id)).toEqual([
			'q-2',
			'q-3',
			'q-1',
		]);

		act(() => result.current.handleJumpToGroupChatMessage(1234));
		expect(scrollToMessage).toHaveBeenCalledWith(1234);

		groupChatBridge.load.mockResolvedValueOnce({
			id: 'gc-2',
			name: 'Other',
			participants: [{ name: 'Agent B' }],
		});
		useModalStore.getState().openModal('processMonitor');
		act(() => result.current.handleProcessMonitorNavigateToGroupChat('gc-2'));
		await waitFor(() => expect(useGroupChatStore.getState().activeGroupChatId).toBe('gc-2'));
		expect(useGroupChatStore.getState().participantStates.get('Agent B')).toBe('working');
		expect(useModalStore.getState().modals.get('processMonitor')?.open ?? false).toBe(false);

		act(() => result.current.handleGroupChatRightTabChange('history'));
		expect(window.maestro.settings.set).toHaveBeenCalledWith('groupChatRightTab:gc-2', 'history');

		act(() => result.current.handleNewGroupChat());
		act(() => result.current.handleEditGroupChat('gc-2'));
		act(() => result.current.handleOpenRenameGroupChatModal('gc-2'));
		act(() => result.current.handleOpenDeleteGroupChatModal('gc-2'));
		expect(useModalStore.getState().modals.get('newGroupChat')?.open).toBe(true);
		expect(useModalStore.getState().modals.get('editGroupChat')?.data).toEqual({
			groupChatId: 'gc-2',
		});
		expect(useModalStore.getState().modals.get('renameGroupChat')?.data).toEqual({
			groupChatId: 'gc-2',
		});
		expect(useModalStore.getState().modals.get('deleteGroupChat')?.data).toEqual({
			groupChatId: 'gc-2',
		});

		act(() => result.current.handleCloseNewGroupChatModal());
		act(() => result.current.handleCloseRenameGroupChatModal());
		act(() => result.current.handleCloseEditGroupChatModal());
		act(() => result.current.handleCloseDeleteGroupChatModal());
		useModalStore.getState().openModal('groupChatInfo');
		act(() => result.current.handleCloseGroupChatInfo());
		expect(useModalStore.getState().modals.get('groupChatInfo')?.open ?? false).toBe(false);

		act(() => result.current.handleOpenModeratorSession('moderator-session'));
		expect(useSessionStore.getState().activeSessionId).toBe('session-1');
		expect(useSessionStore.getState().sessions[0].activeTabId).toBe('tab-mod');
		expect(useGroupChatStore.getState().activeGroupChatId).toBeNull();
		act(() => result.current.handleGroupChatDraftChange('ignored without active chat'));
		expect(useGroupChatStore.getState().groupChats[0].draftMessage).toBe('draft');

		await act(async () => {
			await result.current.handleStopAll();
		});
		expect(groupChatBridge.stopAll).not.toHaveBeenCalled();

		act(() => {
			useGroupChatStore.setState({ activeGroupChatId: 'gc-1' });
		});
		await act(async () => {
			await result.current.handleStopAll();
		});
		expect(dispatchBatch).toHaveBeenCalledWith({
			type: 'COMPLETE_BATCH',
			sessionId: 'session-stop',
		});
		expect(dispatchBatch).not.toHaveBeenCalledWith({
			type: 'COMPLETE_BATCH',
			sessionId: 'session-other',
		});
		expect(groupChatBridge.stopAll).toHaveBeenCalledWith('gc-1');

		unmount();

		act(() => {
			useGroupChatStore.setState({
				activeGroupChatId: 'gc-1',
				groupChatState: 'idle',
				groupChatExecutionQueue: [
					{
						id: 'q-empty',
						tabId: 'gc-1',
						type: 'message',
						images: ['img-only'],
						readOnlyMode: true,
					} as any,
				],
			});
		});
		renderHook(() => useGroupChatHandlers());
		await flushEffects();
		expect(groupChatBridge.sendToModerator).toHaveBeenCalledWith('gc-1', '', ['img-only'], true);
		expect(useGroupChatStore.getState().groupChatExecutionQueue).toEqual([]);
	});

	it('clears errors, closes chats, and ignores missing modal or chat references', async () => {
		vi.useFakeTimers();
		const focus = vi.fn();
		useGroupChatStore.setState({
			activeGroupChatId: 'gc-1',
			groupChats: [{ id: 'gc-1', name: 'Confirm Me' } as any],
			groupChatMessages: [{ role: 'user', content: 'clear me' }] as any,
			groupChatState: 'agent-working',
			participantStates: new Map([['Agent A', 'working']]),
			groupChatError: {
				groupChatId: 'gc-1',
				error: { type: 'authentication', message: 'auth failed' } as any,
			},
		});
		const { result } = renderHook(() => useGroupChatHandlers());
		(result.current.groupChatInputRef as any).current = { focus };

		act(() => result.current.handleClearGroupChatError());
		act(() => vi.advanceTimersByTime(0));
		expect(useGroupChatStore.getState().groupChatError).toBeNull();
		expect(focus).toHaveBeenCalled();
		expect(Array.isArray(result.current.groupChatRecoveryActions)).toBe(true);

		act(() => result.current.deleteGroupChatWithConfirmation('missing'));
		expect(useModalStore.getState().modals.get('confirm')?.open ?? false).toBe(false);

		act(() => result.current.deleteGroupChatWithConfirmation('gc-1'));
		const confirm = useModalStore.getState().modals.get('confirm');
		expect(confirm?.open).toBe(true);
		expect((confirm?.data as any).message).toContain('Confirm Me');
		await act(async () => {
			await (confirm?.data as any).onConfirm();
		});
		expect(groupChatBridge.delete).toHaveBeenCalledWith('gc-1');
		expect(useGroupChatStore.getState().activeGroupChatId).toBeNull();

		await act(async () => {
			await result.current.handleOpenGroupChat('missing');
		});
		expect(useGroupChatStore.getState().activeGroupChatId).toBeNull();

		act(() => result.current.handleConfirmDeleteGroupChat());
		act(() => result.current.handleRenameGroupChatFromModal('Ignored'));
		act(() => result.current.handleOpenModeratorSession('missing-moderator'));
		act(() => result.current.handleGroupChatRightTabChange('participants'));
		await act(async () => {
			await result.current.handleSendGroupChatMessage('no active');
		});

		expect(useSessionStore.getState().activeSessionId).toBeNull();
		expect(groupChatBridge.rename).not.toHaveBeenCalled();
	});
});
