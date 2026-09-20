/**
 * useGroupChatHandlers - extracted from App.tsx (Phase 2B)
 *
 * Owns all group chat lifecycle callbacks, IPC event listeners,
 * execution queue processing, error recovery, and refs.
 * Reads from Zustand stores directly - no parameters needed.
 */

import { useCallback, useEffect, useRef } from 'react';
import type { GroupChatMessagesHandle } from '../../components/GroupChatMessages';
import type { GroupChatRightTab } from '../../components/GroupChatRightPanel';
import type { RecoveryAction } from '../../components/AgentErrorModal';
import { useGroupChatStore } from '../../stores/groupChatStore';
import type { GroupChatQueueState } from '../../../shared/group-chat-types';
import { useModalStore } from '../../stores/modalStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useBatchStore } from '../../stores/batchStore';
import { useUIStore } from '../../stores/uiStore';
import { useSettingsStore } from '../../stores/settingsStore';
import type { GroupChat } from '../../../shared/group-chat-types';
import { pickNextGroupChatIdAfterDelete } from '../../utils/groupChatOrdering';
import { applyGroupChatRightTab } from '../../utils/groupChatRightTab';
import { useAgentErrorRecovery } from '../agent/useAgentErrorRecovery';
import type { ToolType } from '../../../shared/types';
import { notifyToast } from '../../stores/notificationStore';
import { generateId } from '../../utils/ids';
import { aiTabFocusFields } from '../../utils/tabHelpers';
import { getAutoRunSessionsForGroupChat } from '../../utils/groupChatAutoRunRegistry';
import { logger } from '../../utils/logger';

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
			enableMaestroP?: boolean;
			maestroPMode?: 'interactive' | 'dynamic';
			maestroPPath?: string;
		}
	) => Promise<void>;
	handleDeleteGroupChat: (id: string) => Promise<void>;
	handleArchiveGroupChat: (id: string, archived: boolean) => Promise<void>;
	handleRenameGroupChat: (id: string, newName: string) => Promise<void>;
	handleUpdateGroupChat: (
		id: string,
		name: string,
		moderatorAgentId: string,
		moderatorConfig?: {
			customPath?: string;
			customArgs?: string;
			customEnvVars?: Record<string, string>;
			enableMaestroP?: boolean;
			maestroPMode?: 'interactive' | 'dynamic';
			maestroPPath?: string;
		}
	) => Promise<void>;
	deleteGroupChatWithConfirmation: (id: string) => void;
	handleDeleteAllArchivedGroupChats: () => void;

	// Navigation
	handleProcessMonitorNavigateToGroupChat: (groupChatId: string) => void;
	handleOpenModeratorSession: (moderatorSessionId: string) => void;
	handleJumpToGroupChatMessage: (timestamp: number) => void;

	// Right panel
	handleGroupChatRightTabChange: (tab: GroupChatRightTab) => void;

	// Stop All
	handleStopAll: () => Promise<void>;

	// Messages & queue
	handleSendGroupChatMessage: (
		content: string,
		images?: string[],
		readOnly?: boolean
	) => Promise<void>;
	handleGroupChatDraftChange: (draft: string, groupChatId?: string) => void;
	handleRemoveGroupChatQueueItem: (itemId: string) => void;
	handleReorderGroupChatQueueItems: (fromIndex: number, toIndex: number) => void;
	handleResumeGroupChatQueue: () => void;

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
	const groupChatError = useGroupChatStore((s) => s.groupChatError);

	// =======================================================================
	// Error recovery
	// =======================================================================

	const handleClearGroupChatError = useCallback(() => {
		useGroupChatStore.getState().clearGroupChatError();
		setTimeout(() => groupChatInputRef.current?.focus(), 0);
	}, []);

	const groupChats = useGroupChatStore((s) => s.groupChats);
	const moderatorAgentId = (groupChats.find((c) => c.id === activeGroupChatId)?.moderatorAgentId ??
		'claude-code') as ToolType;

	const { recoveryActions: groupChatRecoveryActions } = useAgentErrorRecovery({
		error: groupChatError?.error,
		agentId: moderatorAgentId,
		sessionId: groupChatError?.groupChatId || '',
		onRetry: handleClearGroupChatError,
		onClearError: handleClearGroupChatError,
	});

	// =======================================================================
	// IPC Event Listeners - Global (session-agnostic, registered once)
	// =======================================================================

	useEffect(() => {
		const {
			setGroupChatState,
			setGroupChatStates,
			setGroupChats,
			setAllGroupChatParticipantStates,
			setParticipantStates,
			appendParticipantLiveOutput,
			clearParticipantLiveOutput,
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
			const participantNames = new Set(participants.map((participant) => participant.name));
			const previousChat = useGroupChatStore.getState().groupChats.find((chat) => chat.id === id);
			const removedNames =
				previousChat?.participants
					.map((participant) => participant.name)
					.filter((name) => !participantNames.has(name)) ?? [];

			setGroupChats((prev) =>
				prev.map((chat) => (chat.id === id ? { ...chat, participants } : chat))
			);

			if (removedNames.length > 0) {
				setAllGroupChatParticipantStates((prev) => {
					const chatStates = prev.get(id);
					if (!chatStates) return prev;
					const nextChatStates = new Map(chatStates);
					for (const name of removedNames) {
						nextChatStates.delete(name);
					}
					const next = new Map(prev);
					next.set(id, nextChatStates);
					return next;
				});

				if (id === useGroupChatStore.getState().activeGroupChatId) {
					setParticipantStates((prev) => {
						const next = new Map(prev);
						for (const name of removedNames) {
							next.delete(name);
						}
						return next;
					});
				}

				for (const name of removedNames) {
					clearParticipantLiveOutput(`${id}:${name}`);
				}
			}
		});

		// Unread tracking. The active room's own message listener is registered
		// per-chat below and appends to the transcript; this one exists to catch
		// the rooms nobody is looking at, so it deliberately skips the active one.
		// Echoes of what the conductor just sent are not news, hence the
		// 'user' filter - a Cue-driven prompt can land in an inactive room.
		const unsubUnread = window.maestro.groupChat.onMessage((id, message) => {
			if (message.from === 'user') return;
			if (id === useGroupChatStore.getState().activeGroupChatId) return;
			useGroupChatStore.getState().markGroupChatUnread(id);
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
				// Clear live output when participant becomes idle
				if (state === 'idle') {
					clearParticipantLiveOutput(`${id}:${participantName}`);
				}
			}
		);

		const unsubLiveOutput = window.maestro.groupChat.onParticipantLiveOutput?.(
			(id, participantName, chunk) => {
				if (id === useGroupChatStore.getState().activeGroupChatId) {
					appendParticipantLiveOutput(`${id}:${participantName}`, chunk);
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

		// Force-complete the batch run for an autorun participant.
		// Fired by the main process on both normal completion (reportAutoRunComplete) and
		// on the participant timeout, so the AUTO badge and progress bar always clear.
		const unsubBatchComplete = window.maestro.groupChat.onAutoRunBatchComplete?.(
			(groupChatId, participantName) => {
				// Prefer group-chat-scoped autorun registry to avoid name collisions across chats.
				// Only complete the specific participant's session, not all sessions for the chat.
				const autoRunSessionIds = getAutoRunSessionsForGroupChat(groupChatId);
				if (autoRunSessionIds.length > 0) {
					const sessions = useSessionStore.getState().sessions;
					const matchingSessionId = autoRunSessionIds.find((sid) =>
						sessions.some((s) => s.id === sid && s.name === participantName)
					);
					if (matchingSessionId) {
						useBatchStore.getState().dispatchBatch({
							type: 'COMPLETE_BATCH',
							sessionId: matchingSessionId,
						});
						return;
					}
				}
				// Fallback: resolve by participant name if registry entry was already consumed
				const session = useSessionStore.getState().sessions.find((s) => s.name === participantName);
				if (!session) return;
				useBatchStore.getState().dispatchBatch({
					type: 'COMPLETE_BATCH',
					sessionId: session.id,
				});
			}
		);

		return () => {
			unsubState();
			unsubParticipants();
			unsubUnread();
			unsubParticipantState?.();
			unsubLiveOutput?.();
			unsubModeratorSessionId?.();
			unsubBatchComplete?.();
		};
	}, []); // Mount once - global listeners read activeGroupChatId from store at call time

	// =======================================================================
	// IPC Event Listeners - Active chat (re-registered on chat switch)
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
	// Execution queue
	// =======================================================================
	//
	// There is NO drain here any more. Main owns the queue and drains it on the
	// moderator's idle transition, because a renderer-side drain only runs while
	// that client is awake and watching: a phone that slept, reloaded, or simply
	// missed the idle event left its messages queued forever, and two clients
	// that both saw idle each sent the same item. The renderer's whole job now is
	// to render what main broadcasts and to send changes back over IPC.

	useEffect(() => {
		const unsub = window.maestro.groupChat.onQueueState?.((id, state) => {
			useGroupChatStore.getState().setGroupChatQueue(id, state as GroupChatQueueState);
		});
		return () => unsub?.();
	}, []);

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
		// Same rule as handleOpenGroupChat: on a narrow viewport the left drawer
		// covers the room this navigation is meant to show.
		useUIStore.getState().closeLeftSidebarForNavigation();
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
			clearGroupChatUnread,
		} = useGroupChatStore.getState();
		const { setActiveFocus, closeLeftSidebarForNavigation } = useUIStore.getState();

		const chat = await window.maestro.groupChat.load(id);
		if (chat) {
			// Opening the room is reading it. Cleared before the transcript loads
			// so a slow load can't leave the dot up on a room already on screen.
			clearGroupChatUnread(id);
			setActiveGroupChatId(id);
			// Narrow viewports: the left drawer covers the room that just opened.
			// Opening a chat never touches activeSessionId, so the drawer's
			// agent-switch rule never fires for one - it has to be closed here.
			// Deferred until the room actually loads, so a chat that could not be
			// opened does not dismiss the drawer for nothing.
			closeLeftSidebarForNavigation();
			const messages = await window.maestro.groupChat.getMessages(id);
			setGroupChatMessages(messages);

			// Restore the state for this specific chat from the per-chat state map.
			//
			// Re-read the store rather than using the copy destructured at the top of
			// this function: two awaits have happened since (`load` and `getMessages`,
			// which are WebSocket round trips on the web bridge), and a
			// `groupChat:stateChange` that landed during either one has already
			// updated the map. Writing the pre-await snapshot puts a stale
			// `moderator-thinking` back onto the scalar the execution-queue drain
			// reads, and nothing ever re-derives it - no timer, no retry, no
			// reconciliation on reconnect. The room then stays busy forever and every
			// queued message sits behind a QUEUED badge that will never clear.
			const liveStore = useGroupChatStore.getState();
			setGroupChatState(liveStore.groupChatStates.get(id) ?? 'idle');

			// Pull the queue from MAIN rather than trusting anything this client held.
			// A client can have been asleep, reloaded, or never seen the chat before,
			// so the authoritative list is the one main hands back.
			// Optional-chained: a web client can be running an older preload that has
			// no queue verbs yet, and a missing queue must not stop the room opening.
			void window.maestro.groupChat
				.getQueue?.(id)
				?.then((queueState) =>
					useGroupChatStore.getState().setGroupChatQueue(id, queueState as GroupChatQueueState)
				)
				?.catch(() => {});

			// Restore participant states for this chat (same staleness applies).
			setParticipantStates(liveStore.allGroupChatParticipantStates.get(id) ?? new Map());

			// Load saved right tab preference for this group chat
			const savedTab = await window.maestro.settings.get(`groupChatRightTab:${id}`);
			if (savedTab === 'participants' || savedTab === 'history') {
				setGroupChatRightTab(savedTab);
			} else {
				setGroupChatRightTab('participants'); // Default
			}

			// Start moderator if not running
			// Fixes MAESTRO-B2: handle case where group chat was deleted between operations
			try {
				const moderatorSessionId = await window.maestro.groupChat.startModerator(id);
				if (moderatorSessionId) {
					setGroupChats((prev) =>
						prev.map((c) => (c.id === id ? { ...c, moderatorSessionId } : c))
					);
				}
			} catch (error) {
				logger.warn(`Failed to start moderator for group chat ${id}:`, undefined, error);
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

	/**
	 * After the active group chat is deleted, keep focus in the group-chat area
	 * by opening the next chat below it (or the new last chat if it was at the
	 * bottom). Only when no chats remain do we fall back to an agent. `priorChats`
	 * is the chat list captured before removal, so the deleted chat's position is
	 * still known.
	 */
	const focusNextGroupChatAfterDelete = useCallback(
		async (deletedId: string, priorChats: GroupChat[]) => {
			const { groupChatSortAlphabetical } = useSettingsStore.getState();
			const nextId = pickNextGroupChatIdAfterDelete(
				deletedId,
				priorChats,
				groupChatSortAlphabetical
			);
			if (nextId) {
				await handleOpenGroupChat(nextId);
			} else {
				handleCloseGroupChat();
			}
		},
		[handleOpenGroupChat, handleCloseGroupChat]
	);

	const handleGroupChatRightTabChange = useCallback((tab: GroupChatRightTab) => {
		applyGroupChatRightTab(tab);
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
					prev.map((s) => (s.id === session.id ? { ...s, ...aiTabFocusFields(tab.id) } : s))
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
				enableMaestroP?: boolean;
				maestroPMode?: 'interactive' | 'dynamic';
				maestroPPath?: string;
			},
			requireIdleParticipants?: boolean
		) => {
			const { setGroupChats } = useGroupChatStore.getState();
			const { closeModal } = useModalStore.getState();
			try {
				const chat = await window.maestro.groupChat.create(
					name,
					moderatorAgentId,
					moderatorConfig,
					requireIdleParticipants
				);
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
					throw err; // Unexpected - let Sentry capture via unhandledrejection
				}
			}
		},
		[handleOpenGroupChat]
	);

	const handleDeleteGroupChat = useCallback(
		async (id: string) => {
			const { activeGroupChatId, groupChats, setGroupChats, setGroupChatStagedImages } =
				useGroupChatStore.getState();
			const { closeModal } = useModalStore.getState();
			const priorChats = groupChats;
			await window.maestro.groupChat.delete(id);
			setGroupChats((prev) => prev.filter((c) => c.id !== id));
			setGroupChatStagedImages([], id);
			if (activeGroupChatId === id) {
				await focusNextGroupChatAfterDelete(id, priorChats);
			}
			closeModal('deleteGroupChat');
		},
		[focusNextGroupChatAfterDelete]
	);

	const handleArchiveGroupChat = useCallback(
		async (id: string, archived: boolean) => {
			const { activeGroupChatId, setGroupChats } = useGroupChatStore.getState();
			const updated = await window.maestro.groupChat.archive(id, archived);
			setGroupChats((prev) => prev.map((c) => (c.id === id ? updated : c)));
			if (archived && activeGroupChatId === id) {
				handleCloseGroupChat();
			}
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
				enableMaestroP?: boolean;
				maestroPMode?: 'interactive' | 'dynamic';
				maestroPPath?: string;
			},
			requireIdleParticipants?: boolean
		) => {
			const { setGroupChats } = useGroupChatStore.getState();
			const { closeModal } = useModalStore.getState();
			const updated = await window.maestro.groupChat.update(id, {
				name,
				moderatorAgentId,
				moderatorConfig,
				requireIdleParticipants,
			});
			setGroupChats((prev) => prev.map((c) => (c.id === id ? updated : c)));
			closeModal('editGroupChat');
		},
		[]
	);

	// =======================================================================
	// Delete all archived group chats
	// =======================================================================

	const handleDeleteAllArchivedGroupChats = useCallback(() => {
		const { groupChats } = useGroupChatStore.getState();
		const archivedChats = groupChats.filter((c) => c.archived);
		if (archivedChats.length === 0) return;

		useModalStore.getState().openModal('confirm', {
			message: `Are you sure you want to delete all ${archivedChats.length} archived group chat${archivedChats.length !== 1 ? 's' : ''}? This action cannot be undone.`,
			onConfirm: async () => {
				const { activeGroupChatId, setGroupChats } = useGroupChatStore.getState();
				const archivedIds = new Set(archivedChats.map((c) => c.id));
				// Delete all archived chats
				await Promise.all(archivedChats.map((c) => window.maestro.groupChat.delete(c.id)));
				setGroupChats((prev) => prev.filter((c) => !archivedIds.has(c.id)));
				if (activeGroupChatId && archivedIds.has(activeGroupChatId)) {
					handleCloseGroupChat();
				}
			},
		});
	}, [handleCloseGroupChat]);

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
					const { groupChats: priorChats, setGroupChats } = useGroupChatStore.getState();
					await window.maestro.groupChat.delete(id);
					setGroupChats((prev) => prev.filter((c) => c.id !== id));
					if (activeGroupChatId === id) {
						await focusNextGroupChatAfterDelete(id, priorChats);
					}
				},
			});
		},
		[focusNextGroupChatAfterDelete]
	);

	// =======================================================================
	// Message & queue handlers
	// =======================================================================

	const handleSendGroupChatMessage = useCallback(
		async (content: string, images?: string[], readOnly?: boolean) => {
			const { activeGroupChatId, setGroupChatState, setGroupChatStates } =
				useGroupChatStore.getState();
			if (!activeGroupChatId) return;

			// MAIN decides whether this is sent now or queued. The client used to
			// make that call from its own copy of the queue, and a copy that is even
			// slightly stale sends directly while items are already waiting - so the
			// newest message reaches the moderator ahead of older ones, which is the
			// one thing a queue exists to prevent. Main is the only party that knows
			// both the real queue and the moderator's real state.
			try {
				await window.maestro.groupChat.submitMessage(activeGroupChatId, {
					id: generateId(),
					timestamp: Date.now(),
					text: content,
					images: images ? [...images] : undefined,
					readOnlyMode: readOnly,
				});
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				// Reaching here means the IPC call itself failed, so main never saw the
				// message and it is NOT in any queue. (A send that fails INSIDE main
				// is different: there the item is kept, marked and the chat paused.)
				// The user has to send it again, which is what the notice says.
				setGroupChatState('idle');
				setGroupChatStates((prev) => {
					const next = new Map(prev);
					next.set(activeGroupChatId, 'idle');
					return next;
				});
				useGroupChatStore.getState().setGroupChatMessages((prev) => [
					...prev,
					{
						timestamp: new Date().toISOString(),
						from: 'system',
						content: `⚠️ Moderator is not available. Try sending your message again. (${msg})`,
					},
				]);
			}
		},
		[]
	);

	const handleStopAll = useCallback(async () => {
		const { activeGroupChatId } = useGroupChatStore.getState();
		if (!activeGroupChatId) return;
		try {
			// Cancel any in-flight autorun batch runs for this group chat.
			// These run in the agent's own Maestro session (not group-chat-prefixed),
			// so the main process's clearAllParticipantSessions won't reach them.
			const autoRunSessionIds = getAutoRunSessionsForGroupChat(activeGroupChatId);
			for (const sessionId of autoRunSessionIds) {
				useBatchStore.getState().dispatchBatch({
					type: 'COMPLETE_BATCH',
					sessionId,
				});
			}
			await window.maestro.groupChat.stopAll(activeGroupChatId);
		} catch (error) {
			logger.error('[GroupChat] Failed to stop all:', undefined, error);
			notifyToast({
				type: 'error',
				title: 'Stop Failed',
				message: 'Failed to stop all group chat conversations. Please try again.',
			});
		}
	}, []);

	const handleGroupChatDraftChange = useCallback((draft: string, groupChatId?: string) => {
		const { activeGroupChatId, setGroupChats } = useGroupChatStore.getState();
		const targetGroupChatId = groupChatId ?? activeGroupChatId;
		if (!targetGroupChatId) return;
		setGroupChats((prev) =>
			prev.map((c) => (c.id === targetGroupChatId ? { ...c, draftMessage: draft } : c))
		);
	}, []);

	/**
	 * Remove one queued message.
	 *
	 * Main may REFUSE this: an item already handed to the moderator cannot be
	 * un-sent, so the removal comes back untouched with `refused: true` and the
	 * UI says so rather than silently redrawing the row. The broadcast that
	 * follows a successful removal is what updates every client.
	 */
	const handleRemoveGroupChatQueueItem = useCallback(async (itemId: string) => {
		const { activeGroupChatId } = useGroupChatStore.getState();
		if (!activeGroupChatId) return;
		// A refusal needs no separate message: it can only happen while an item is
		// in flight, and the composer already shows "Sending, cannot remove" for
		// exactly that state. The broadcast that follows a successful removal is
		// what updates every client.
		await window.maestro.groupChat.queueRemove(activeGroupChatId, itemId);
	}, []);

	const handleReorderGroupChatQueueItems = useCallback(
		async (fromIndex: number, toIndex: number) => {
			const { activeGroupChatId, groupChatQueues } = useGroupChatStore.getState();
			if (!activeGroupChatId) return;
			// Reorder is addressed by ITEM ID, not by index: main is the authority and
			// its list can have moved since this client rendered the row.
			const moving = groupChatQueues[activeGroupChatId]?.items[fromIndex];
			if (!moving) return;
			await window.maestro.groupChat.queueReorder(activeGroupChatId, moving.id, toIndex);
		},
		[]
	);

	/** Let a paused queue run again. Main clears the failed mark on the head. */
	const handleResumeGroupChatQueue = useCallback(async () => {
		const { activeGroupChatId } = useGroupChatStore.getState();
		if (!activeGroupChatId) return;
		await window.maestro.groupChat.queueResume(activeGroupChatId);
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
		handleArchiveGroupChat,
		handleRenameGroupChat,
		handleUpdateGroupChat,
		deleteGroupChatWithConfirmation,
		handleDeleteAllArchivedGroupChats,

		// Navigation
		handleProcessMonitorNavigateToGroupChat,
		handleOpenModeratorSession,
		handleJumpToGroupChatMessage,

		// Right panel
		handleGroupChatRightTabChange,

		// Stop All
		handleStopAll,

		// Messages & queue
		handleSendGroupChatMessage,
		handleGroupChatDraftChange,
		handleRemoveGroupChatQueueItem,
		handleReorderGroupChatQueueItems,
		handleResumeGroupChatQueue,

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
