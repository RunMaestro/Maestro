/**
 * InputContext - Centralized completion and command history state management
 *
 * This context extracts completion and command history states from App.tsx
 * to reduce its complexity and provide a single source of truth for completion state.
 *
 * Phase 3 of App.tsx decomposition - see refactor-details-2.md for full plan.
 *
 * States managed:
 * - Slash command completion (open/index)
 * - Tab completion for terminal (open/index/filter)
 * - @ mention completion for AI mode (open/filter/index/startIndex)
 * - Command history browser (open/filter/index)
 *
 * PERFORMANCE NOTE: Input values (terminalInputValue, aiInputValue) are intentionally
 * NOT managed in context. They remain in App.tsx as local state to avoid triggering
 * context re-renders on every keystroke. The completion states here change infrequently
 * (only when dropdowns open/close) so they're safe to put in context.
 */

import React, { createContext, useContext, useState, useCallback, useMemo, ReactNode } from 'react';
import type { TabCompletionFilter } from '../hooks';

/**
 * Input context value - completion and command history states and their setters
 *
 * Note: Setters use React.Dispatch<React.SetStateAction<T>> to support both
 * direct value assignment and callback patterns (e.g., setIndex(prev => prev + 1))
 */
export interface InputContextValue {
	// Slash Command Completion (both AI and terminal mode)
	slashCommandOpen: boolean;
	setSlashCommandOpen: React.Dispatch<React.SetStateAction<boolean>>;
	selectedSlashCommandIndex: number;
	setSelectedSlashCommandIndex: React.Dispatch<React.SetStateAction<number>>;
	resetSlashCommand: () => void;

	// Tab Completion (terminal mode only)
	tabCompletionOpen: boolean;
	setTabCompletionOpen: React.Dispatch<React.SetStateAction<boolean>>;
	selectedTabCompletionIndex: number;
	setSelectedTabCompletionIndex: React.Dispatch<React.SetStateAction<number>>;
	tabCompletionFilter: TabCompletionFilter;
	setTabCompletionFilter: React.Dispatch<React.SetStateAction<TabCompletionFilter>>;
	resetTabCompletion: () => void;

	// @ Mention Completion (AI mode only)
	atMentionOpen: boolean;
	setAtMentionOpen: React.Dispatch<React.SetStateAction<boolean>>;
	atMentionFilter: string;
	setAtMentionFilter: React.Dispatch<React.SetStateAction<string>>;
	atMentionStartIndex: number;
	setAtMentionStartIndex: React.Dispatch<React.SetStateAction<number>>;
	selectedAtMentionIndex: number;
	setSelectedAtMentionIndex: React.Dispatch<React.SetStateAction<number>>;
	resetAtMention: () => void;

	// Command History Browser
	commandHistoryOpen: boolean;
	setCommandHistoryOpen: React.Dispatch<React.SetStateAction<boolean>>;
	commandHistoryFilter: string;
	setCommandHistoryFilter: React.Dispatch<React.SetStateAction<string>>;
	commandHistorySelectedIndex: number;
	setCommandHistorySelectedIndex: React.Dispatch<React.SetStateAction<number>>;
	resetCommandHistory: () => void;

	// Convenience method to close all completion popups
	closeAllCompletions: () => void;
}

// Create context with null as default (will throw if used outside provider)
const InputContext = createContext<InputContextValue | null>(null);

interface InputProviderProps {
	children: ReactNode;
}

/**
 * InputProvider - Provides centralized completion state management
 *
 * This provider manages completion and command history states that were previously
 * scattered throughout App.tsx. It reduces App.tsx complexity and provides
 * a single location for completion state management.
 *
 * PERFORMANCE NOTE: Input values (terminal/AI input text) are NOT in this context.
 * They remain in App.tsx as local state to avoid context re-renders on every keystroke.
 * Only completion states (which change infrequently) are managed here.
 *
 * Usage:
 * Wrap App with this provider (after ModalProvider and UILayoutProvider):
 * <InputProvider>
 *   <App />
 * </InputProvider>
 */
export function InputProvider({ children }: InputProviderProps) {
	// Slash Command Completion
	const [slashCommandOpen, setSlashCommandOpen] = useState(false);
	const [selectedSlashCommandIndex, setSelectedSlashCommandIndex] = useState(0);

	// Tab Completion (terminal mode only)
	const [tabCompletionOpen, setTabCompletionOpen] = useState(false);
	const [selectedTabCompletionIndex, setSelectedTabCompletionIndex] = useState(0);
	const [tabCompletionFilter, setTabCompletionFilter] = useState<TabCompletionFilter>('all');

	// @ Mention Completion (AI mode only)
	const [atMentionOpen, setAtMentionOpen] = useState(false);
	const [atMentionFilter, setAtMentionFilter] = useState('');
	const [atMentionStartIndex, setAtMentionStartIndex] = useState(-1);
	const [selectedAtMentionIndex, setSelectedAtMentionIndex] = useState(0);

	// Command History Browser
	const [commandHistoryOpen, setCommandHistoryOpen] = useState(false);
	const [commandHistoryFilter, setCommandHistoryFilter] = useState('');
	const [commandHistorySelectedIndex, setCommandHistorySelectedIndex] = useState(0);

	// Reset methods for each completion type - memoized for stable references
	const resetSlashCommand = useCallback(() => {
		setSlashCommandOpen(false);
		setSelectedSlashCommandIndex(0);
	}, []);

	const resetTabCompletion = useCallback(() => {
		setTabCompletionOpen(false);
		setSelectedTabCompletionIndex(0);
		setTabCompletionFilter('all');
	}, []);

	const resetAtMention = useCallback(() => {
		setAtMentionOpen(false);
		setAtMentionFilter('');
		setAtMentionStartIndex(-1);
		setSelectedAtMentionIndex(0);
	}, []);

	const resetCommandHistory = useCallback(() => {
		setCommandHistoryOpen(false);
		setCommandHistoryFilter('');
		setCommandHistorySelectedIndex(0);
	}, []);

	// Convenience method to close all completion popups at once
	const closeAllCompletions = useCallback(() => {
		resetSlashCommand();
		resetTabCompletion();
		resetAtMention();
		resetCommandHistory();
	}, [resetSlashCommand, resetTabCompletion, resetAtMention, resetCommandHistory]);

	// PERFORMANCE: Memoize context value to prevent unnecessary re-renders
	// Only re-creates when completion states actually change
	const value = useMemo<InputContextValue>(
		() => ({
			// Slash Command Completion
			slashCommandOpen,
			setSlashCommandOpen,
			selectedSlashCommandIndex,
			setSelectedSlashCommandIndex,
			resetSlashCommand,

			// Tab Completion
			tabCompletionOpen,
			setTabCompletionOpen,
			selectedTabCompletionIndex,
			setSelectedTabCompletionIndex,
			tabCompletionFilter,
			setTabCompletionFilter,
			resetTabCompletion,

			// @ Mention Completion
			atMentionOpen,
			setAtMentionOpen,
			atMentionFilter,
			setAtMentionFilter,
			atMentionStartIndex,
			setAtMentionStartIndex,
			selectedAtMentionIndex,
			setSelectedAtMentionIndex,
			resetAtMention,

			// Command History Browser
			commandHistoryOpen,
			setCommandHistoryOpen,
			commandHistoryFilter,
			setCommandHistoryFilter,
			commandHistorySelectedIndex,
			setCommandHistorySelectedIndex,
			resetCommandHistory,

			// Convenience method
			closeAllCompletions,
		}),
		[
			// Slash Command Completion - only boolean/number, changes infrequently
			slashCommandOpen,
			selectedSlashCommandIndex,
			resetSlashCommand,
			// Tab Completion - only changes when dropdown opens/navigates
			tabCompletionOpen,
			selectedTabCompletionIndex,
			tabCompletionFilter,
			resetTabCompletion,
			// @ Mention Completion - only changes when dropdown opens/navigates
			atMentionOpen,
			atMentionFilter,
			atMentionStartIndex,
			selectedAtMentionIndex,
			resetAtMention,
			// Command History Browser - only changes when modal opens/navigates
			commandHistoryOpen,
			commandHistoryFilter,
			commandHistorySelectedIndex,
			resetCommandHistory,
			// Convenience method
			closeAllCompletions,
		]
	);

	return <InputContext.Provider value={value}>{children}</InputContext.Provider>;
}

/**
 * useInputContext - Hook to access completion state management
 *
 * Must be used within an InputProvider. Throws an error if used outside.
 *
 * @returns InputContextValue - All completion states and their setters
 *
 * @example
 * const { slashCommandOpen, setSlashCommandOpen, resetSlashCommand } = useInputContext();
 *
 * // Open slash command completion
 * setSlashCommandOpen(true);
 *
 * // Reset slash command state
 * resetSlashCommand();
 *
 * @example
 * const { closeAllCompletions } = useInputContext();
 *
 * // Close all completion popups (e.g., on blur or submit)
 * closeAllCompletions();
 */
export function useInputContext(): InputContextValue {
	const context = useContext(InputContext);

	if (!context) {
		throw new Error('useInputContext must be used within an InputProvider');
	}

	return context;
}
