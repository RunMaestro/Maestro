/**
 * useCommandHistory hook for Maestro mobile web interface
 *
 * Manages command history storage and retrieval with localStorage persistence.
 * Provides methods to add, remove, and navigate through command history.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { webLogger } from '../utils/logger';

/** Maximum number of commands to store in history */
const MAX_HISTORY_SIZE = 50;

/** LocalStorage key for persisting command history */
const STORAGE_KEY = 'maestro_command_history';

export interface CommandHistoryEntry {
	/** Unique identifier for the entry */
	id: string;
	/** The command text */
	command: string;
	/** Timestamp when the command was sent */
	timestamp: number;
	/** Session ID the command was sent to (optional) */
	sessionId?: string;
	/** Input mode when command was sent (ai or terminal) */
	mode: 'ai' | 'terminal';
}

export interface UseCommandHistoryOptions {
	/** Maximum number of commands to store (default: 50) */
	maxSize?: number;
	/** Whether to persist to localStorage (default: true) */
	persist?: boolean;
	/** Custom storage key (default: 'maestro_command_history') */
	storageKey?: string;
}

export interface UseCommandHistoryReturn {
	/** Array of command history entries (newest first) */
	history: CommandHistoryEntry[];
	/** Add a new command to history */
	addCommand: (command: string, sessionId?: string, mode?: 'ai' | 'terminal') => void;
	/** Remove a specific command from history by ID */
	removeCommand: (id: string) => void;
	/** Clear all command history */
	clearHistory: () => void;
	/** Get the most recent N commands (for quick-tap chips) */
	getRecentCommands: (count?: number) => CommandHistoryEntry[];
	/** Get unique commands (deduplicated, most recent first) */
	getUniqueCommands: (count?: number) => CommandHistoryEntry[];
	/** Search commands by text */
	searchCommands: (query: string) => CommandHistoryEntry[];
	/** Current history navigation index (-1 = not navigating) */
	navigationIndex: number;
	/** Navigate up in history (older commands) */
	navigateUp: () => string | null;
	/** Navigate down in history (newer commands) */
	navigateDown: () => string | null;
	/** Reset navigation position */
	resetNavigation: () => void;
}

/**
 * Generate a unique ID for a history entry
 */
function generateId(): string {
	return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Custom hook for managing command history
 *
 * @example
 * ```tsx
 * function CommandInput() {
 *   const { history, addCommand, getRecentCommands } = useCommandHistory();
 *
 *   const handleSubmit = (command: string) => {
 *     addCommand(command, sessionId, 'ai');
 *     // ... send command
 *   };
 *
 *   const recentCommands = getRecentCommands(5);
 *
 *   return (
 *     <div>
 *       {recentCommands.map(entry => (
 *         <button key={entry.id} onClick={() => useCommand(entry.command)}>
 *           {entry.command}
 *         </button>
 *       ))}
 *     </div>
 *   );
 * }
 * ```
 */
export function useCommandHistory(options: UseCommandHistoryOptions = {}): UseCommandHistoryReturn {
	const { maxSize = MAX_HISTORY_SIZE, persist = true, storageKey = STORAGE_KEY } = options;

	const [history, setHistory] = useState<CommandHistoryEntry[]>([]);
	const [navigationIndex, setNavigationIndex] = useState(-1);

	// Track if initial load from storage has completed
	const initialLoadDone = useRef(false);

	// Load history from localStorage on mount
	useEffect(() => {
		if (!persist || typeof window === 'undefined') {
			initialLoadDone.current = true;
			return;
		}

		try {
			const stored = localStorage.getItem(storageKey);
			if (stored) {
				const parsed = JSON.parse(stored) as CommandHistoryEntry[];
				// Validate and clean up the data
				const validEntries = parsed
					.filter(
						(entry) =>
							entry &&
							typeof entry.id === 'string' &&
							typeof entry.command === 'string' &&
							typeof entry.timestamp === 'number'
					)
					.slice(0, maxSize);
				setHistory(validEntries);
			}
		} catch (error) {
			webLogger.error('Failed to load from localStorage', 'CommandHistory', error);
		}
		initialLoadDone.current = true;
	}, [persist, storageKey, maxSize]);

	// Persist history to localStorage when it changes
	useEffect(() => {
		if (!persist || typeof window === 'undefined' || !initialLoadDone.current) {
			return;
		}

		try {
			localStorage.setItem(storageKey, JSON.stringify(history));
		} catch (error) {
			webLogger.error('Failed to save to localStorage', 'CommandHistory', error);
		}
	}, [history, persist, storageKey]);

	/**
	 * Add a new command to history
	 */
	const addCommand = useCallback(
		(command: string, sessionId?: string, mode: 'ai' | 'terminal' = 'ai') => {
			const trimmedCommand = command.trim();
			if (!trimmedCommand) return;

			const newEntry: CommandHistoryEntry = {
				id: generateId(),
				command: trimmedCommand,
				timestamp: Date.now(),
				sessionId,
				mode,
			};

			setHistory((prev) => {
				// Add new entry at the beginning
				const updated = [newEntry, ...prev];
				// Limit to max size
				return updated.slice(0, maxSize);
			});

			// Reset navigation when adding new command
			setNavigationIndex(-1);
		},
		[maxSize]
	);

	/**
	 * Remove a specific command from history
	 */
	const removeCommand = useCallback((id: string) => {
		setHistory((prev) => prev.filter((entry) => entry.id !== id));
		// Reset navigation when modifying history
		setNavigationIndex(-1);
	}, []);

	/**
	 * Clear all command history
	 */
	const clearHistory = useCallback(() => {
		setHistory([]);
		setNavigationIndex(-1);
	}, []);

	/**
	 * Get the most recent N commands
	 */
	const getRecentCommands = useCallback(
		(count = 5): CommandHistoryEntry[] => {
			return history.slice(0, count);
		},
		[history]
	);

	/**
	 * Normalize command for deduplication comparison
	 * - Lowercase
	 * - Trim whitespace
	 * - Remove trailing punctuation (?, !, .)
	 */
	const normalizeForDedup = useCallback((command: string): string => {
		return command
			.toLowerCase()
			.trim()
			.replace(/[?!.]+$/, '');
	}, []);

	/**
	 * Get unique commands (deduplicated by normalized text, most recent first)
	 * Deduplication ignores case and trailing punctuation
	 */
	const getUniqueCommands = useCallback(
		(count = 5): CommandHistoryEntry[] => {
			const seen = new Set<string>();
			const unique: CommandHistoryEntry[] = [];

			for (const entry of history) {
				const normalized = normalizeForDedup(entry.command);
				if (!seen.has(normalized)) {
					seen.add(normalized);
					unique.push(entry);
					if (unique.length >= count) break;
				}
			}

			return unique;
		},
		[history, normalizeForDedup]
	);

	/**
	 * Search commands by text (case-insensitive)
	 */
	const searchCommands = useCallback(
		(query: string): CommandHistoryEntry[] => {
			const lowerQuery = query.toLowerCase();
			return history.filter((entry) => entry.command.toLowerCase().includes(lowerQuery));
		},
		[history]
	);

	/**
	 * Navigate up in history (older commands)
	 */
	const navigateUp = useCallback((): string | null => {
		if (history.length === 0) return null;

		const newIndex = Math.min(navigationIndex + 1, history.length - 1);
		setNavigationIndex(newIndex);
		return history[newIndex]?.command ?? null;
	}, [history, navigationIndex]);

	/**
	 * Navigate down in history (newer commands)
	 */
	const navigateDown = useCallback((): string | null => {
		if (navigationIndex <= 0) {
			setNavigationIndex(-1);
			return null;
		}

		const newIndex = navigationIndex - 1;
		setNavigationIndex(newIndex);
		return history[newIndex]?.command ?? null;
	}, [history, navigationIndex]);

	/**
	 * Reset navigation position
	 */
	const resetNavigation = useCallback(() => {
		setNavigationIndex(-1);
	}, []);

	return {
		history,
		addCommand,
		removeCommand,
		clearHistory,
		getRecentCommands,
		getUniqueCommands,
		searchCommands,
		navigationIndex,
		navigateUp,
		navigateDown,
		resetNavigation,
	};
}

export default useCommandHistory;
