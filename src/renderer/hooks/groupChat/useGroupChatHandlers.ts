/**
 * useGroupChatHandlers — extracted from App.tsx (Phase 2B)
 *
 * Owns all group chat lifecycle callbacks, IPC event listeners,
 * execution queue processing, error recovery, and refs.
 * Reads from Zustand stores directly — no parameters needed.
 */

import { useCallback, useEffect, useRef } from 'react';
import type { GroupChatMessagesHandle } from '../../components/GroupChatMessages';
import type { GroupChatRightTab } from '../../components/GroupChatRightPanel';
import type { RecoveryAction } from '../../components/AgentErrorModal';
import type { QueuedItem } from '../../types';
import { useGroupChatStore } from '../../stores/groupChatStore';
import { useModalStore } from '../../stores/modalStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useUIStore } from '../../stores/uiStore';
import { useAgentErrorRecovery } from '../agent/useAgentErrorRecovery';
import { notifyToast } from '../../stores/notificationStore';
import { generateId } from '../../utils/ids';

// ---------------------------------------------------------------------------
// Return type
// ---------------------------------------------------------------------------

export interface GroupChatHandlersReturn {
	// Refs
	groupChatInputRef: React.RefObject<HTMLTextAreaElement>;
	groupChatMessagesRef: React.RefObject<GroupChatMessagesHandle>;

	// Error recovery
	handleClearGroupChatError: () => void;
	groupChatRecoveryActions: RecoveryAction[];

	// CRUD
	handleOpenGroupChat: (id: string) => Promise<void>;
	handleCloseGroupChat: () => void;
	handleCreateGroupChat: (
		name: string,
		moderatorAgentId: string,
		moderatorConfig?: {
			customPath?: string;
			customArgs?: string;
			customEnvVars?: Record<string, string>;
			customModel?: string;
		}
	) => Promise<void>;
	handleDeleteGroupChat: (id: string) => Promise<void>;
	handleRenameGroupChat: (id: string, newName: string) => Promise<void>;
	handleUpdateGroupChat: (
		id: string,
		name: string,
		moderatorAgentId: string,
		moderatorConfig?: {
			customPath?: string;
			customArgs?: string;
			customEnvVars?: Record<string, string>;
		}
	) => Promise<void>;
	deleteGroupChatWithConfirmation: (id: string) => void;

	// Navigation
	handleProcessMonitorNavigateToGroupChat: (groupChatId: string) => void;
	handleOpenModeratorSession: (moderatorSessionId: string) => void;
	handleJumpToGroupChatMessage: (timestamp: number) => void;

	// Right panel
	handleGroupChatRightTabChange: (tab: GroupChatRightTab) => void;

	// Messages & queue
	handleSendGroupChatMessage: (
		content: string,
		images?: string[],
		readOnly?: boolean
	) => Promise<void>;
	handleGroupChatDraftChange: (draft: string) => void;
	handleRemoveGroupChatQueueItem: (itemId: string) => void;
	handleReorderGroupChatQueueItems: (fromIndex: number, toIndex: number) => void;

	// Modal openers
	handleNewGroupChat: () => void;
	handleEditGroupChat: (id: string) => void;
	handleOpenRenameGroupChatModal: (id: string) => void;
	handleOpenDeleteGroupChatModal: (id: string) => void;

	// Modal closers (for AppGroupChatModals component)
	handleCloseNewGroupChatModal: () => void;
	handleCloseDeleteGroupChatModal: () => void;
	handleConfirmDeleteGroupChat: () => void;
	handleCloseRenameGroupChatModal: () => void;
	handleRenameGroupChatFromModal: (newName: string) => void;
	handleCloseEditGroupChatModal: () => void;
	handleCloseGroupChatInfo: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resets group chat UI to idle state. Shared by handleCloseGroupChat and handleOpenModeratorSession. */
function resetGroupChatUI(): void {
	const {
		setActiveGroupChatId,
		setGroupChatMessages,
		setGroupChatState,
		setParticipantStates,
		setGroupChatError,
	} = useGroupChatStore.getState();
	setActiveGroupChatId(null);
	setGroupChatMessages([]);
	setGroupChatState('idle');
	setParticipantStates(new Map());
	setGroupChatError(null);
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useGroupChatHandlers(): GroupChatHandlersReturn {
	// --- Refs ---
	const groupChatInputRef = useRef<HTMLTextAreaElement>(null);
	const groupChatMessagesRef = useRef<GroupChatMessagesHandle>(null);

	// --- Reactive reads (for effects only) ---
	const activeGroupChatId = useGroupChatStore((s) => s.activeGroupChatId);
	const groupChatState = useGroupChatStore((s) => s.groupChatState);
	const groupChatExecutionQueue = useGroupChatStore((s) => s.groupChatExecutionQueue);
	const groupChatError = useGroupChatStore((s) => s.groupChatError);

	// =======================================================================
	// Error recovery
	// =======================================================================

	const handleClearGroupChatError = useCallback(() => {
		useGroupChatStore.getState().clearGroupChatError();
		setTimeout(() => groupChatInputRef.current?.focus(), 0);
	}, []);

	const { recoveryActions: groupChatRecoveryActions } = useAgentErrorRecovery({
		error: groupChatError?.error,
		// TODO: Read actual moderator agent type from the active group chat config
		// instead of hardcoding. Error recovery suggestions will be wrong for non-Claude moderators.
		agentId: 'claude-code',
		sessionId: groupChatError?.groupChatId || '',
		onRetry: handleClearGroupChatError,
		onClearError: handleClearGroupChatError,
	});

	// =======================================================================
	// IPC Event Listeners — Global (session-agnostic, registered once)
	// =======================================================================

	useEffect(() => {
		const {
			setGroupChatState,
			setGroupChatStates,
			setGroupChats,
			setAllGroupChatParticipantStates,
			setParticipantStates,
		} = useGroupChatStore.getState();

		const unsubState = window.maestro.groupChat.onStateChange((id, state) => {
			// Track state for ALL group chats (for sidebar indicator when not active)
			setGroupChatStates((prev) => {
				const next = new Map(prev);
				next.set(id, state);
				return next;
			});
			// Also update the active group chat's state for immediate UI
			if (id === useGroupChatStore.getState().activeGroupChatId) {
				setGroupChatState(state);
			}
		});

		const unsubParticipants = window.maestro.groupChat.onParticipantsChanged((id, participants) => {
			setGroupChats((prev) =>
				prev.map((chat) => (chat.id === id ? { ...chat, participants } : chat))
			);
		});

		const unsubParticipantState = window.maestro.groupChat.onParticipantState?.(
			(id, participantName, state) => {
				// Track participant state for ALL group chats (for sidebar indicator)
				setAllGroupChatParticipantStates((prev) => {
					const next = new Map(prev);
					const chatStates = next.get(id) || new Map();
					const updatedChatStates = new Map(chatStates);
					updatedChatStates.set(participantName, state);
					next.set(id, updatedChatStates);
					return next;
				});
				// Also update the active group chat's participant states for immediate UI
				if (id === useGroupChatStore.getState().activeGroupChatId) {
					setParticipantStates((prev) => {
						const next = new Map(prev);
						next.set(participantName, state);
						return next;
					});
				}
			}
		);

		const unsubModeratorSessionId = window.maestro.groupChat.onModeratorSessionIdChanged?.(
			(id, agentSessionId) => {
				setGroupChats((prev) =>
					prev.map((chat) =>
						chat.id === id ? { ...chat, moderatorAgentSessionId: agentSessionId } : chat
					)
				);
			}
		);

		return () => {
			unsubState();
			unsubParticipants();
			unsubParticipantState?.();
			unsubModeratorSessionId?.();
		};
	}, []); // Mount once — global listeners read activeGroupChatId from store at call time

	// =======================================================================
	// IPC Event Listeners — Active chat (re-registered on chat switch)
	// =======================================================================

	useEffect(() => {
		if (!activeGroupChatId) return;

		const { setGroupChatMessages, setModeratorUsage } = useGroupChatStore.getState();

		const unsubMessage = window.maestro.groupChat.onMessage((id, message) => {
			if (id === activeGroupChatId) {
				setGroupChatMessages((prev) => [...prev, message]);
			}
		});

		const unsubModeratorUsage = window.maestro.groupChat.onModeratorUsage?.((id, usage) => {
			if (id === activeGroupChatId) {
				// When contextUsage is -1, tokens were accumulated from multi-tool turns.
				// Preserve previous context/token values; only update cost.
				if (usage.contextUsage < 0) {
					setModeratorUsage((prev) =>
						prev
							? { ...prev, totalCost: usage.totalCost }
							: { contextUsage: 0, totalCost: usage.totalCost, tokenCount: 0 }
					);
				} else {
					setModeratorUsage(usage);
				}
			}
		});

		return () => {
			unsubMessage();
			unsubModeratorUsage?.();
		};
	}, [activeGroupChatId]);

	// =======================================================================
	// Execution queue processor
	// =======================================================================

	useEffect(() => {
		if (groupChatState === 'idle' && groupChatExecutionQueue.length > 0 && activeGroupChatId) {
			const {
				setGroupChatExecutionQueue,
				setGroupChatState: setGCState,
				setGroupChatStates: setGCStates,
			} = useGroupChatStore.getState();

			const [nextItem, ...remainingQueue] = groupChatExecutionQueue;
			setGroupChatExecutionQueue(remainingQueue);

			setGCState('moderator-thinking');
			setGCStates((prev) => {
				const next = new Map(prev);
				next.set(activeGroupChatId, 'moderator-thinking');
				return next;
			});
			window.maestro.groupChat.sendToModerator(
				activeGroupChatId,
				nextItem.text || '',
				nextItem.images,
				nextItem.readOnlyMode
			);
		}
	}, [groupChatState, groupChatExecutionQueue, activeGroupChatId]);

	// =======================================================================
	// Navigate to group chat from ProcessMonitor
	// =======================================================================

	const handleProcessMonitorNavigateToGroupChat = useCallback((groupChatId: string) => {
		const {
			setActiveGroupChatId,
			setGroupChatState,
			setParticipantStates,
			groupChatStates,
			allGroupChatParticipantStates,
		} = useGroupChatStore.getState();
		const { closeModal } = useModalStore.getState();
		setActiveGroupChatId(groupChatId);
		setGroupChatState(groupChatStates.get(groupChatId) ?? 'idle');
		setParticipantStates(allGroupChatParticipantStates.get(groupChatId) ?? new Map());
		closeModal('processMonitor');
	}, []);

	// =======================================================================
	// Core group chat handlers
	// =======================================================================

	const handleOpenGroupChat = useCallback(async (id: string) => {
		const {
			setActiveGroupChatId,
			setGroupChatMessages,
			setGroupChatState,
			setGroupChatRightTab,
			setGroupChats,
			setParticipantStates,
			groupChatStates,
			allGroupChatParticipantStates,
		} = useGroupChatStore.getState();
		const { setActiveFocus } = useUIStore.getState();

		const chat = await window.maestro.groupChat.load(id);
		if (chat) {
			setActiveGroupChatId(id);
			const messages = await window.maestro.groupChat.getMessages(id);
			setGroupChatMessages(messages);

			// Restore the state for this specific chat from the per-chat state map
			setGroupChatState(groupChatStates.get(id) ?? 'idle');

			// Restore participant states for this chat
			setParticipantStates(allGroupChatParticipantStates.get(id) ?? new Map());

			// Load saved right tab preference for this group chat
			const savedTab = await window.maestro.settings.get(`groupChatRightTab:${id}`);
			if (savedTab === 'participants' || savedTab === 'history') {
				setGroupChatRightTab(savedTab);
			} else {
				setGroupChatRightTab('participants'); // Default
			}

			// Start moderator if not running
			const moderatorSessionId = await window.maestro.groupChat.startModerator(id);
			if (moderatorSessionId) {
				setGroupChats((prev) => prev.map((c) => (c.id === id ? { ...c, moderatorSessionId } : c)));
			}

			// Focus the input after the component renders
			setTimeout(() => {
				setActiveFocus('main');
				groupChatInputRef.current?.focus();
			}, 100);
		}
	}, []);

	const handleCloseGroupChat = useCallback(() => {
		resetGroupChatUI();
	}, []);

	const handleGroupChatRightTabChange = useCallback((tab: GroupChatRightTab) => {
		const { setGroupChatRightTab, activeGroupChatId } = useGroupChatStore.getState();
		setGroupChatRightTab(tab);
		if (activeGroupChatId) {
			window.maestro.settings.set(`groupChatRightTab:${activeGroupChatId}`, tab);
		}
	}, []);

	const handleJumpToGroupChatMessage = useCallback((timestamp: number) => {
		groupChatMessagesRef.current?.scrollToMessage(timestamp);
	}, []);

	const handleOpenModeratorSession = useCallback((moderatorSessionId: string) => {
		const sessions = useSessionStore.getState().sessions;
		const session = sessions.find((s) =>
			s.aiTabs?.some((tab) => tab.agentSessionId === moderatorSessionId)
		);

		if (session) {
			resetGroupChatUI();

			// Set the session as active
			const { setActiveSessionId, setSessions } = useSessionStore.getState();
			setActiveSessionId(session.id);

			// Find and activate the tab with this agent session ID
			const tab = session.aiTabs?.find((t) => t.agentSessionId === moderatorSessionId);
			if (tab) {
				setSessions((prev) =>
					prev.map((s) => (s.id === session.id ? { ...s, activeTabId: tab.id } : s))
				);
			}
		}
	}, []);

	const handleCreateGroupChat = useCallback(
		async (
			name: string,
			moderatorAgentId: string,
			moderatorConfig?: {
				customPath?: string;
				customArgs?: string;
				customEnvVars?: Record<string, string>;
				customModel?: string;
			}
		) => {
			const { setGroupChats } = useGroupChatStore.getState();
			const { closeModal } = useModalStore.getState();
			try {
				const chat = await window.maestro.groupChat.create(name, moderatorAgentId, moderatorConfig);
				setGroupChats((prev) => [chat, ...prev]);
				closeModal('newGroupChat');
				handleOpenGroupChat(chat.id);
			} catch (err) {
				closeModal('newGroupChat');
				const message = err instanceof Error ? err.message : '';
				const isValidationError = message.includes('Invalid moderator agent ID');
				notifyToast({
					type: 'error',
					title: 'Group Chat',
					message: isValidationError
						? message.replace(/^Error invoking remote method '[^']+': /, '')
						: 'Failed to create group chat',
				});
				if (!isValidationError) {
					throw err; // Unexpected — let Sentry capture via unhandledrejection
				}
			}
		},
		[handleOpenGroupChat]
	);

	const handleDeleteGroupChat = useCallback(
		async (id: string) => {
			const { activeGroupChatId, setGroupChats } = useGroupChatStore.getState();
			const { closeModal } = useModalStore.getState();
			await window.maestro.groupChat.delete(id);
			setGroupChats((prev) => prev.filter((c) => c.id !== id));
			if (activeGroupChatId === id) {
				handleCloseGroupChat();
			}
			closeModal('deleteGroupChat');
		},
		[handleCloseGroupChat]
	);

	const handleRenameGroupChat = useCallback(async (id: string, newName: string) => {
		const { setGroupChats } = useGroupChatStore.getState();
		const { closeModal } = useModalStore.getState();
		await window.maestro.groupChat.rename(id, newName);
		setGroupChats((prev) => prev.map((c) => (c.id === id ? { ...c, name: newName } : c)));
		closeModal('renameGroupChat');
	}, []);

	const handleUpdateGroupChat = useCallback(
		async (
			id: string,
			name: string,
			moderatorAgentId: string,
			moderatorConfig?: {
				customPath?: string;
				customArgs?: string;
				customEnvVars?: Record<string, string>;
			}
		) => {
			const { setGroupChats } = useGroupChatStore.getState();
			const { closeModal } = useModalStore.getState();
			const updated = await window.maestro.groupChat.update(id, {
				name,
				moderatorAgentId,
				moderatorConfig,
			});
			setGroupChats((prev) => prev.map((c) => (c.id === id ? updated : c)));
			closeModal('editGroupChat');
		},
		[]
	);

	// =======================================================================
	// Delete with confirmation (keyboard shortcut / CMD+K)
	// =======================================================================

	const deleteGroupChatWithConfirmation = useCallback(
		(id: string) => {
			const { groupChats, activeGroupChatId } = useGroupChatStore.getState();
			const chat = groupChats.find((c) => c.id === id);
			if (!chat) return;

			useModalStore.getState().openModal('confirm', {
				message: `Are you sure you want to delete the group chat "${chat.name}"? This action cannot be undone.`,
				onConfirm: async () => {
					const { setGroupChats } = useGroupChatStore.getState();
					await window.maestro.groupChat.delete(id);
					setGroupChats((prev) => prev.filter((c) => c.id !== id));
					if (activeGroupChatId === id) {
						handleCloseGroupChat();
					}
				},
			});
		},
		[handleCloseGroupChat]
	);

	// =======================================================================
	// Message & queue handlers
	// =======================================================================

	const handleSendGroupChatMessage = useCallback(
		async (content: string, images?: string[], readOnly?: boolean) => {
			const {
				activeGroupChatId,
				groupChatState,
				groupChats,
				setGroupChatExecutionQueue,
				setGroupChatState,
				setGroupChatStates,
			} = useGroupChatStore.getState();
			if (!activeGroupChatId) return;

			// If group chat is busy, queue the message instead of sending immediately
			if (groupChatState !== 'idle') {
				const queuedItem: QueuedItem = {
					id: generateId(),
					timestamp: Date.now(),
					tabId: activeGroupChatId,
					type: 'message',
					text: content,
					images: images ? [...images] : undefined,
					tabName: groupChats.find((c) => c.id === activeGroupChatId)?.name || 'Group Chat',
					readOnlyMode: readOnly,
				};
				setGroupChatExecutionQueue((prev) => [...prev, queuedItem]);
				return;
			}

			setGroupChatState('moderator-thinking');
			setGroupChatStates((prev) => {
				const next = new Map(prev);
				next.set(activeGroupChatId, 'moderator-thinking');
				return next;
			});
			await window.maestro.groupChat.sendToModerator(activeGroupChatId, content, images, readOnly);
		},
		[]
	);

	const handleGroupChatDraftChange = useCallback((draft: string) => {
		const { activeGroupChatId, setGroupChats } = useGroupChatStore.getState();
		if (!activeGroupChatId) return;
		setGroupChats((prev) =>
			prev.map((c) => (c.id === activeGroupChatId ? { ...c, draftMessage: draft } : c))
		);
	}, []);

	const handleRemoveGroupChatQueueItem = useCallback((itemId: string) => {
		useGroupChatStore
			.getState()
			.setGroupChatExecutionQueue((prev) => prev.filter((item) => item.id !== itemId));
	}, []);

	const handleReorderGroupChatQueueItems = useCallback((fromIndex: number, toIndex: number) => {
		useGroupChatStore.getState().setGroupChatExecutionQueue((prev) => {
			const queue = [...prev];
			const [removed] = queue.splice(fromIndex, 1);
			queue.splice(toIndex, 0, removed);
			return queue;
		});
	}, []);

	// =======================================================================
	// Modal openers
	// =======================================================================

	const handleNewGroupChat = useCallback(() => {
		useModalStore.getState().openModal('newGroupChat');
	}, []);

	const handleEditGroupChat = useCallback((id: string) => {
		useModalStore.getState().openModal('editGroupChat', { groupChatId: id });
	}, []);

	const handleOpenRenameGroupChatModal = useCallback((id: string) => {
		useModalStore.getState().openModal('renameGroupChat', { groupChatId: id });
	}, []);

	const handleOpenDeleteGroupChatModal = useCallback((id: string) => {
		useModalStore.getState().openModal('deleteGroupChat', { groupChatId: id });
	}, []);

	// =======================================================================
	// Modal closers (stable callbacks for AppGroupChatModals component)
	// =======================================================================

	const handleCloseNewGroupChatModal = useCallback(() => {
		useModalStore.getState().closeModal('newGroupChat');
	}, []);

	const handleCloseDeleteGroupChatModal = useCallback(() => {
		useModalStore.getState().closeModal('deleteGroupChat');
	}, []);

	const handleConfirmDeleteGroupChat = useCallback(() => {
		const modalData = useModalStore.getState().modals.get('deleteGroupChat');
		const groupChatId = (modalData?.data as { groupChatId?: string })?.groupChatId;
		if (groupChatId) {
			handleDeleteGroupChat(groupChatId);
		}
	}, [handleDeleteGroupChat]);

	const handleCloseRenameGroupChatModal = useCallback(() => {
		useModalStore.getState().closeModal('renameGroupChat');
	}, []);

	const handleRenameGroupChatFromModal = useCallback(
		(newName: string) => {
			const modalData = useModalStore.getState().modals.get('renameGroupChat');
			const groupChatId = (modalData?.data as { groupChatId?: string })?.groupChatId;
			if (groupChatId) {
				handleRenameGroupChat(groupChatId, newName);
			}
		},
		[handleRenameGroupChat]
	);

	const handleCloseEditGroupChatModal = useCallback(() => {
		useModalStore.getState().closeModal('editGroupChat');
	}, []);

	const handleCloseGroupChatInfo = useCallback(() => {
		useModalStore.getState().closeModal('groupChatInfo');
	}, []);

	// =======================================================================
	// Return
	// =======================================================================

	return {
		// Refs
		groupChatInputRef,
		groupChatMessagesRef,

		// Error recovery
		handleClearGroupChatError,
		groupChatRecoveryActions,

		// CRUD
		handleOpenGroupChat,
		handleCloseGroupChat,
		handleCreateGroupChat,
		handleDeleteGroupChat,
		handleRenameGroupChat,
		handleUpdateGroupChat,
		deleteGroupChatWithConfirmation,

		// Navigation
		handleProcessMonitorNavigateToGroupChat,
		handleOpenModeratorSession,
		handleJumpToGroupChatMessage,

		// Right panel
		handleGroupChatRightTabChange,

		// Messages & queue
		handleSendGroupChatMessage,
		handleGroupChatDraftChange,
		handleRemoveGroupChatQueueItem,
		handleReorderGroupChatQueueItems,

		// Modal openers
		handleNewGroupChat,
		handleEditGroupChat,
		handleOpenRenameGroupChatModal,
		handleOpenDeleteGroupChatModal,

		// Modal closers
		handleCloseNewGroupChatModal,
		handleCloseDeleteGroupChatModal,
		handleConfirmDeleteGroupChat,
		handleCloseRenameGroupChatModal,
		handleRenameGroupChatFromModal,
		handleCloseEditGroupChatModal,
		handleCloseGroupChatInfo,
	};
}
