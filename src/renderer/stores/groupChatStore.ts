/**
 * groupChatStore - Zustand store for group chat state management
 *
 * Replaces GroupChatContext. All group chat states (chats list, messages,
 * moderator state, participant states, execution queue, etc.) live here.
 * Components subscribe to individual slices via selectors to avoid
 * unnecessary re-renders.
 *
 * Refs (groupChatInputRef, groupChatMessagesRef) stay outside the store
 * since they are React-specific and don't trigger re-renders.
 *
 * Can be used outside React via useGroupChatStore.getState().
 */

import { create } from 'zustand';
import type { GroupChat, GroupChatMessage, GroupChatState, AgentError } from '../types';
import type { QueuedItem } from '../types';

// ============================================================================
// Types
// ============================================================================

/** Right panel tab within the group chat view */
export type GroupChatRightTab = 'participants' | 'history';

/** Group chat error state - tracks which chat has an error and from which participant */
export interface GroupChatErrorState {
	groupChatId: string;
	error: AgentError;
	participantName?: string;
}

export interface GroupChatStoreState {
	// Entity data
	groupChats: GroupChat[];
	activeGroupChatId: string | null;

	// Active chat state
	groupChatMessages: GroupChatMessage[];
	groupChatState: GroupChatState;
	participantStates: Map<string, 'idle' | 'working'>;
	moderatorUsage: { contextUsage: number; totalCost: number; tokenCount: number } | null;

	// All-chats tracking (for sidebar busy indicators when chat is not active)
	groupChatStates: Map<string, GroupChatState>;
	allGroupChatParticipantStates: Map<string, Map<string, 'idle' | 'working'>>;

	/**
	 * Rooms that produced output the user has not looked at. Populated only for
	 * NON-active rooms: the active room is on screen, so its messages are read
	 * by definition. Per-boot, like tab unread state - a restart is a clean
	 * slate rather than a pile of stale red dots.
	 */
	unreadGroupChatIds: Set<string>;

	// Execution
	groupChatExecutionQueue: QueuedItem[];
	groupChatReadOnlyMode: boolean;

	// UI
	groupChatRightTab: GroupChatRightTab;
	groupChatParticipantColors: Record<string, string>;
	groupChatStagedImages: string[];

	// Live output peek
	participantLiveOutput: Map<string, string>;

	// Error
	groupChatError: GroupChatErrorState | null;

	// Multi-window: the window that opened the active group chat. The Group Chat
	// panel renders only in this window so a chat shows once even when its
	// participant agents are spread across windows. null = no window scoping
	// (single-window app, web, or pre-hydrate); stamped on open, cleared on close.
	initiatorWindowId: string | null;
}

export interface GroupChatStoreActions {
	// Entity setters
	setGroupChats: (v: GroupChat[] | ((prev: GroupChat[]) => GroupChat[])) => void;
	setActiveGroupChatId: (v: string | null | ((prev: string | null) => string | null)) => void;

	// Active chat setters
	setGroupChatMessages: (
		v: GroupChatMessage[] | ((prev: GroupChatMessage[]) => GroupChatMessage[])
	) => void;
	setGroupChatState: (v: GroupChatState | ((prev: GroupChatState) => GroupChatState)) => void;
	setParticipantStates: (
		v:
			| Map<string, 'idle' | 'working'>
			| ((prev: Map<string, 'idle' | 'working'>) => Map<string, 'idle' | 'working'>)
	) => void;
	setModeratorUsage: (
		v:
			| { contextUsage: number; totalCost: number; tokenCount: number }
			| null
			| ((
					prev: { contextUsage: number; totalCost: number; tokenCount: number } | null
			  ) => { contextUsage: number; totalCost: number; tokenCount: number } | null)
	) => void;

	// All-chats tracking
	setGroupChatStates: (
		v:
			| Map<string, GroupChatState>
			| ((prev: Map<string, GroupChatState>) => Map<string, GroupChatState>)
	) => void;
	setAllGroupChatParticipantStates: (
		v:
			| Map<string, Map<string, 'idle' | 'working'>>
			| ((
					prev: Map<string, Map<string, 'idle' | 'working'>>
			  ) => Map<string, Map<string, 'idle' | 'working'>>)
	) => void;

	// Unread
	/** Flag a room as having output the user hasn't seen. No-op if already flagged. */
	markGroupChatUnread: (groupChatId: string) => void;
	/** Clear a room's unread flag (opening it), or every room when called bare. */
	clearGroupChatUnread: (groupChatId?: string) => void;

	// Execution
	setGroupChatExecutionQueue: (v: QueuedItem[] | ((prev: QueuedItem[]) => QueuedItem[])) => void;
	setGroupChatReadOnlyMode: (v: boolean | ((prev: boolean) => boolean)) => void;

	// UI
	setGroupChatRightTab: (
		v: GroupChatRightTab | ((prev: GroupChatRightTab) => GroupChatRightTab)
	) => void;
	setGroupChatParticipantColors: (
		v: Record<string, string> | ((prev: Record<string, string>) => Record<string, string>)
	) => void;
	setGroupChatStagedImages: (v: string[] | ((prev: string[]) => string[])) => void;

	// Live output peek
	appendParticipantLiveOutput: (participantName: string, chunk: string) => void;
	clearParticipantLiveOutput: (participantName?: string) => void;

	// Error
	setGroupChatError: (
		v:
			| GroupChatErrorState
			| null
			| ((prev: GroupChatErrorState | null) => GroupChatErrorState | null)
	) => void;

	// Multi-window
	setInitiatorWindowId: (v: string | null | ((prev: string | null) => string | null)) => void;

	// Convenience methods
	/** Clear the current error. Focus side-effect (ref.focus) must be handled by caller. */
	clearGroupChatError: () => void;
	/** Reset active chat state (close chat). Clears activeGroupChatId, messages, state, participants, error. */
	resetGroupChatState: () => void;
}

export type GroupChatStore = GroupChatStoreState & GroupChatStoreActions;

// ============================================================================
// Helpers
// ============================================================================

/**
 * Resolve a value-or-updater argument, matching React's setState signature.
 */
function resolve<T>(valOrFn: T | ((prev: T) => T), prev: T): T {
	return typeof valOrFn === 'function' ? (valOrFn as (prev: T) => T)(prev) : valOrFn;
}

/**
 * Whether the Group Chat panel should render in the window identified by
 * `windowId`. Multi-window: a chat is shown only in the window that initiated it
 * (`initiatorWindowId`, stamped on open). A null `initiatorWindowId` (single-
 * window app, web, or pre-hydrate) or a null `windowId` (no `WindowProvider`,
 * e.g. isolation tests) means "show here", preserving single-window behaviour.
 */
export function isGroupChatVisibleInWindow(
	initiatorWindowId: string | null,
	windowId: string | null
): boolean {
	if (initiatorWindowId == null || windowId == null) return true;
	return initiatorWindowId === windowId;
}

// ============================================================================
// Store
// ============================================================================

export const useGroupChatStore = create<GroupChatStore>()((set) => ({
	// --- State ---
	groupChats: [],
	activeGroupChatId: null,
	groupChatMessages: [],
	groupChatState: 'idle' as GroupChatState,
	participantStates: new Map(),
	moderatorUsage: null,
	groupChatStates: new Map(),
	allGroupChatParticipantStates: new Map(),
	unreadGroupChatIds: new Set(),
	groupChatExecutionQueue: [],
	groupChatReadOnlyMode: false,
	groupChatRightTab: 'participants' as GroupChatRightTab,
	groupChatParticipantColors: {},
	groupChatStagedImages: [],
	participantLiveOutput: new Map(),
	groupChatError: null,
	initiatorWindowId: null,

	// --- Actions ---
	setGroupChats: (v) => set((s) => ({ groupChats: resolve(v, s.groupChats) })),
	setActiveGroupChatId: (v) => set((s) => ({ activeGroupChatId: resolve(v, s.activeGroupChatId) })),
	setGroupChatMessages: (v) => set((s) => ({ groupChatMessages: resolve(v, s.groupChatMessages) })),
	setGroupChatState: (v) => set((s) => ({ groupChatState: resolve(v, s.groupChatState) })),
	setParticipantStates: (v) => set((s) => ({ participantStates: resolve(v, s.participantStates) })),
	setModeratorUsage: (v) => set((s) => ({ moderatorUsage: resolve(v, s.moderatorUsage) })),
	setGroupChatStates: (v) => set((s) => ({ groupChatStates: resolve(v, s.groupChatStates) })),
	setAllGroupChatParticipantStates: (v) =>
		set((s) => ({
			allGroupChatParticipantStates: resolve(v, s.allGroupChatParticipantStates),
		})),
	// Both guard on membership before allocating a new Set: these fire on every
	// inbound message and on every chat open, and an unconditional copy would
	// re-render every unread subscriber for a no-op change.
	markGroupChatUnread: (groupChatId) =>
		set((s) => {
			if (s.unreadGroupChatIds.has(groupChatId)) return {};
			const next = new Set(s.unreadGroupChatIds);
			next.add(groupChatId);
			return { unreadGroupChatIds: next };
		}),

	clearGroupChatUnread: (groupChatId) =>
		set((s) => {
			if (groupChatId === undefined) {
				return s.unreadGroupChatIds.size === 0 ? {} : { unreadGroupChatIds: new Set<string>() };
			}
			if (!s.unreadGroupChatIds.has(groupChatId)) return {};
			const next = new Set(s.unreadGroupChatIds);
			next.delete(groupChatId);
			return { unreadGroupChatIds: next };
		}),

	setGroupChatExecutionQueue: (v) =>
		set((s) => ({ groupChatExecutionQueue: resolve(v, s.groupChatExecutionQueue) })),
	setGroupChatReadOnlyMode: (v) =>
		set((s) => ({ groupChatReadOnlyMode: resolve(v, s.groupChatReadOnlyMode) })),
	setGroupChatRightTab: (v) => set((s) => ({ groupChatRightTab: resolve(v, s.groupChatRightTab) })),
	setGroupChatParticipantColors: (v) =>
		set((s) => ({ groupChatParticipantColors: resolve(v, s.groupChatParticipantColors) })),
	setGroupChatStagedImages: (v) =>
		set((s) => ({ groupChatStagedImages: resolve(v, s.groupChatStagedImages) })),
	setGroupChatError: (v) => set((s) => ({ groupChatError: resolve(v, s.groupChatError) })),
	setInitiatorWindowId: (v) => set((s) => ({ initiatorWindowId: resolve(v, s.initiatorWindowId) })),

	appendParticipantLiveOutput: (participantName, chunk) =>
		set((s) => {
			const next = new Map(s.participantLiveOutput);
			const existing = next.get(participantName) || '';
			// Cap at ~50KB per participant to prevent unbounded growth
			const combined = existing + chunk;
			next.set(participantName, combined.length > 50000 ? combined.slice(-50000) : combined);
			return { participantLiveOutput: next };
		}),

	clearParticipantLiveOutput: (participantName) =>
		set((s) => {
			if (participantName) {
				const next = new Map(s.participantLiveOutput);
				next.delete(participantName);
				return { participantLiveOutput: next };
			}
			return { participantLiveOutput: new Map() };
		}),

	clearGroupChatError: () => set({ groupChatError: null }),

	resetGroupChatState: () =>
		set({
			activeGroupChatId: null,
			groupChatMessages: [],
			groupChatState: 'idle' as GroupChatState,
			participantStates: new Map(),
			participantLiveOutput: new Map(),
			groupChatError: null,
			initiatorWindowId: null,
		}),
}));
