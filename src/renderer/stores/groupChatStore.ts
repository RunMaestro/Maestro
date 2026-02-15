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
 * Can be used outside React via getGroupChatState() / getGroupChatActions().
 */

import { create } from 'zustand';
import type { GroupChat, GroupChatMessage, GroupChatState, AgentError } from '../types';
import type { QueuedItem } from '../types';

// ============================================================================
// Types
// ============================================================================

/** Right panel tab within the group chat view */
export type GroupChatRightTab = 'participants' | 'history';

/** Group chat error state — tracks which chat has an error and from which participant */
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

	// Execution
	groupChatExecutionQueue: QueuedItem[];
	groupChatReadOnlyMode: boolean;

	// UI
	groupChatRightTab: GroupChatRightTab;
	groupChatParticipantColors: Record<string, string>;
	groupChatStagedImages: string[];

	// Error
	groupChatError: GroupChatErrorState | null;
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

	// Error
	setGroupChatError: (
		v:
			| GroupChatErrorState
			| null
			| ((prev: GroupChatErrorState | null) => GroupChatErrorState | null)
	) => void;

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
	groupChatExecutionQueue: [],
	groupChatReadOnlyMode: false,
	groupChatRightTab: 'participants' as GroupChatRightTab,
	groupChatParticipantColors: {},
	groupChatStagedImages: [],
	groupChatError: null,

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

	clearGroupChatError: () => set({ groupChatError: null }),

	resetGroupChatState: () =>
		set({
			activeGroupChatId: null,
			groupChatMessages: [],
			groupChatState: 'idle' as GroupChatState,
			participantStates: new Map(),
			groupChatError: null,
		}),
}));

// ============================================================================
// Non-React access
// ============================================================================

/**
 * Get current group chat state snapshot.
 * Use outside React (services, orchestrators, IPC handlers).
 */
export function getGroupChatState() {
	return useGroupChatStore.getState();
}

/**
 * Get stable group chat action references outside React.
 */
export function getGroupChatActions() {
	const state = useGroupChatStore.getState();
	return {
		setGroupChats: state.setGroupChats,
		setActiveGroupChatId: state.setActiveGroupChatId,
		setGroupChatMessages: state.setGroupChatMessages,
		setGroupChatState: state.setGroupChatState,
		setParticipantStates: state.setParticipantStates,
		setModeratorUsage: state.setModeratorUsage,
		setGroupChatStates: state.setGroupChatStates,
		setAllGroupChatParticipantStates: state.setAllGroupChatParticipantStates,
		setGroupChatExecutionQueue: state.setGroupChatExecutionQueue,
		setGroupChatReadOnlyMode: state.setGroupChatReadOnlyMode,
		setGroupChatRightTab: state.setGroupChatRightTab,
		setGroupChatParticipantColors: state.setGroupChatParticipantColors,
		setGroupChatStagedImages: state.setGroupChatStagedImages,
		setGroupChatError: state.setGroupChatError,
		clearGroupChatError: state.clearGroupChatError,
		resetGroupChatState: state.resetGroupChatState,
	};
}
