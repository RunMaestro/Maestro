/**
 * GroupChatContext - Centralized group chat state management
 *
 * This context extracts all group chat states from App.tsx to reduce
 * its complexity and provide a single source of truth for group chat state.
 *
 * Phase 4 of App.tsx decomposition - see refactor-details-2.md for full plan.
 *
 * States managed:
 * - Group chats list and active group chat ID
 * - Group chat messages for the active chat
 * - Group chat state (idle/moderator-thinking/agent-working)
 * - Per-chat and per-participant state tracking
 * - Staged images for group chat input
 * - Read-only mode and execution queue
 * - Right panel tab selection
 * - Group chat errors
 */

import React, {
	createContext,
	useContext,
	useState,
	useCallback,
	useMemo,
	ReactNode,
	useRef,
} from 'react';
import type { GroupChat, GroupChatMessage, GroupChatState, AgentError } from '../types';
import type { QueuedItem } from '../types';
import type { GroupChatMessagesHandle } from '../components/GroupChatMessages';

// Re-export GroupChatRightTab type for convenience
export type GroupChatRightTab = 'participants' | 'history';

/**
 * Group chat error state - tracks which chat has an error and from which participant
 */
export interface GroupChatErrorState {
	groupChatId: string;
	error: AgentError;
	participantName?: string;
}

/**
 * Group chat context value - all group chat states and their setters
 */
export interface GroupChatContextValue {
	// Group Chats List
	groupChats: GroupChat[];
	setGroupChats: React.Dispatch<React.SetStateAction<GroupChat[]>>;

	// Active Group Chat
	activeGroupChatId: string | null;
	setActiveGroupChatId: React.Dispatch<React.SetStateAction<string | null>>;

	// Messages for active group chat
	groupChatMessages: GroupChatMessage[];
	setGroupChatMessages: React.Dispatch<React.SetStateAction<GroupChatMessage[]>>;

	// Current group chat state
	groupChatState: GroupChatState;
	setGroupChatState: React.Dispatch<React.SetStateAction<GroupChatState>>;

	// Per-group-chat state tracking (for showing busy indicator when not active)
	groupChatStates: Map<string, GroupChatState>;
	setGroupChatStates: React.Dispatch<React.SetStateAction<Map<string, GroupChatState>>>;

	// Per-participant working state for active chat
	participantStates: Map<string, 'idle' | 'working'>;
	setParticipantStates: React.Dispatch<React.SetStateAction<Map<string, 'idle' | 'working'>>>;

	// Per-group-chat participant states (groupChatId -> Map<participantName, state>)
	allGroupChatParticipantStates: Map<string, Map<string, 'idle' | 'working'>>;
	setAllGroupChatParticipantStates: React.Dispatch<
		React.SetStateAction<Map<string, Map<string, 'idle' | 'working'>>>
	>;

	// Moderator usage stats
	moderatorUsage: { contextUsage: number; totalCost: number; tokenCount: number } | null;
	setModeratorUsage: React.Dispatch<
		React.SetStateAction<{ contextUsage: number; totalCost: number; tokenCount: number } | null>
	>;

	// Staged images for group chat input
	groupChatStagedImages: string[];
	setGroupChatStagedImages: React.Dispatch<React.SetStateAction<string[]>>;

	// Read-only mode for group chat
	groupChatReadOnlyMode: boolean;
	setGroupChatReadOnlyMode: React.Dispatch<React.SetStateAction<boolean>>;

	// Execution queue for group chat
	groupChatExecutionQueue: QueuedItem[];
	setGroupChatExecutionQueue: React.Dispatch<React.SetStateAction<QueuedItem[]>>;

	// Right panel tab
	groupChatRightTab: GroupChatRightTab;
	setGroupChatRightTab: React.Dispatch<React.SetStateAction<GroupChatRightTab>>;

	// Participant colors (computed and shared across components)
	groupChatParticipantColors: Record<string, string>;
	setGroupChatParticipantColors: React.Dispatch<React.SetStateAction<Record<string, string>>>;

	// Group chat error state
	groupChatError: GroupChatErrorState | null;
	setGroupChatError: React.Dispatch<React.SetStateAction<GroupChatErrorState | null>>;

	// Refs for focus management
	groupChatInputRef: React.RefObject<HTMLTextAreaElement>;
	groupChatMessagesRef: React.RefObject<GroupChatMessagesHandle>;

	// Convenience methods
	clearGroupChatError: () => void;
	resetGroupChatState: () => void;
}

// Create context with null as default (will throw if used outside provider)
const GroupChatContext = createContext<GroupChatContextValue | null>(null);

interface GroupChatProviderProps {
	children: ReactNode;
}

/**
 * GroupChatProvider - Provides centralized group chat state management
 *
 * This provider manages all group chat states that were previously
 * scattered throughout App.tsx. It reduces App.tsx complexity and provides
 * a single location for group chat state management.
 *
 * Usage:
 * Wrap App with this provider (after other context providers):
 * <GroupChatProvider>
 *   <App />
 * </GroupChatProvider>
 */
export function GroupChatProvider({ children }: GroupChatProviderProps) {
	// Group Chats List
	const [groupChats, setGroupChats] = useState<GroupChat[]>([]);

	// Active Group Chat
	const [activeGroupChatId, setActiveGroupChatId] = useState<string | null>(null);

	// Messages for active group chat
	const [groupChatMessages, setGroupChatMessages] = useState<GroupChatMessage[]>([]);

	// Current group chat state
	const [groupChatState, setGroupChatState] = useState<GroupChatState>('idle');

	// Per-group-chat state tracking
	const [groupChatStates, setGroupChatStates] = useState<Map<string, GroupChatState>>(new Map());

	// Per-participant working state for active chat
	const [participantStates, setParticipantStates] = useState<Map<string, 'idle' | 'working'>>(
		new Map()
	);

	// Per-group-chat participant states
	const [allGroupChatParticipantStates, setAllGroupChatParticipantStates] = useState<
		Map<string, Map<string, 'idle' | 'working'>>
	>(new Map());

	// Moderator usage stats
	const [moderatorUsage, setModeratorUsage] = useState<{
		contextUsage: number;
		totalCost: number;
		tokenCount: number;
	} | null>(null);

	// Staged images for group chat input
	const [groupChatStagedImages, setGroupChatStagedImages] = useState<string[]>([]);

	// Read-only mode for group chat
	const [groupChatReadOnlyMode, setGroupChatReadOnlyMode] = useState(false);

	// Execution queue for group chat
	const [groupChatExecutionQueue, setGroupChatExecutionQueue] = useState<QueuedItem[]>([]);

	// Right panel tab
	const [groupChatRightTab, setGroupChatRightTab] = useState<GroupChatRightTab>('participants');

	// Participant colors
	const [groupChatParticipantColors, setGroupChatParticipantColors] = useState<
		Record<string, string>
	>({});

	// Group chat error state
	const [groupChatError, setGroupChatError] = useState<GroupChatErrorState | null>(null);

	// Refs for focus management
	const groupChatInputRef = useRef<HTMLTextAreaElement>(null);
	const groupChatMessagesRef = useRef<GroupChatMessagesHandle>(null);

	// Convenience method to clear group chat error and refocus input
	const clearGroupChatError = useCallback(() => {
		setGroupChatError(null);
		setTimeout(() => groupChatInputRef.current?.focus(), 0);
	}, []);

	// Convenience method to reset all group chat state (e.g., when closing)
	const resetGroupChatState = useCallback(() => {
		setActiveGroupChatId(null);
		setGroupChatMessages([]);
		setGroupChatState('idle');
		setParticipantStates(new Map());
		setGroupChatError(null);
	}, []);

	// Memoize the context value to prevent unnecessary re-renders
	const value = useMemo<GroupChatContextValue>(
		() => ({
			// Group Chats List
			groupChats,
			setGroupChats,

			// Active Group Chat
			activeGroupChatId,
			setActiveGroupChatId,

			// Messages
			groupChatMessages,
			setGroupChatMessages,

			// State
			groupChatState,
			setGroupChatState,
			groupChatStates,
			setGroupChatStates,

			// Participant states
			participantStates,
			setParticipantStates,
			allGroupChatParticipantStates,
			setAllGroupChatParticipantStates,

			// Moderator usage
			moderatorUsage,
			setModeratorUsage,

			// Staged images
			groupChatStagedImages,
			setGroupChatStagedImages,

			// Read-only mode
			groupChatReadOnlyMode,
			setGroupChatReadOnlyMode,

			// Execution queue
			groupChatExecutionQueue,
			setGroupChatExecutionQueue,

			// Right panel tab
			groupChatRightTab,
			setGroupChatRightTab,

			// Participant colors
			groupChatParticipantColors,
			setGroupChatParticipantColors,

			// Error state
			groupChatError,
			setGroupChatError,

			// Refs
			groupChatInputRef,
			groupChatMessagesRef,

			// Convenience methods
			clearGroupChatError,
			resetGroupChatState,
		}),
		[
			// Group Chats List
			groupChats,
			// Active Group Chat
			activeGroupChatId,
			// Messages
			groupChatMessages,
			// State
			groupChatState,
			groupChatStates,
			// Participant states
			participantStates,
			allGroupChatParticipantStates,
			// Moderator usage
			moderatorUsage,
			// Staged images
			groupChatStagedImages,
			// Read-only mode
			groupChatReadOnlyMode,
			// Execution queue
			groupChatExecutionQueue,
			// Right panel tab
			groupChatRightTab,
			// Participant colors
			groupChatParticipantColors,
			// Error state
			groupChatError,
			// Convenience methods
			clearGroupChatError,
			resetGroupChatState,
		]
	);

	return <GroupChatContext.Provider value={value}>{children}</GroupChatContext.Provider>;
}

/**
 * useGroupChat - Hook to access group chat state management
 *
 * Must be used within a GroupChatProvider. Throws an error if used outside.
 *
 * @returns GroupChatContextValue - All group chat states and their setters
 *
 * @example
 * const { groupChats, activeGroupChatId, setActiveGroupChatId } = useGroupChat();
 *
 * // Open a group chat
 * setActiveGroupChatId('chat-123');
 *
 * // Check if a group chat is active
 * if (activeGroupChatId) { ... }
 *
 * @example
 * const { groupChatError, clearGroupChatError } = useGroupChat();
 *
 * // Clear error and refocus
 * clearGroupChatError();
 */
export function useGroupChat(): GroupChatContextValue {
	const context = useContext(GroupChatContext);

	if (!context) {
		throw new Error('useGroupChat must be used within a GroupChatProvider');
	}

	return context;
}
