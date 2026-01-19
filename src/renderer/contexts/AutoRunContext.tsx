/**
 * AutoRunContext - Centralized Auto Run and batch processing state management
 *
 * This context extracts all Auto Run document states and integrates the
 * useBatchProcessor hook to provide a single source of truth for batch processing.
 *
 * Phase 5 of App.tsx decomposition - see refactor-details-2.md for full plan.
 *
 * States managed:
 * - Document list and tree for the current session
 * - Document loading state
 * - Task counts per document
 * - Batch processing state (via useBatchProcessor integration)
 *
 * Note: This context provides the raw state and setters. The useAutoRunHandlers
 * hook continues to provide the higher-level handler functions that consume
 * these states along with session context.
 */

import React, { createContext, useContext, useState, useCallback, useMemo, ReactNode } from 'react';
import type { AutoRunTreeNode } from '../hooks';

/**
 * Task count entry - tracks completed vs total tasks for a document
 */
export interface TaskCountEntry {
	completed: number;
	total: number;
}

/**
 * Auto Run context value - all Auto Run states and their setters
 */
export interface AutoRunContextValue {
	// Document List State
	documentList: string[];
	setDocumentList: React.Dispatch<React.SetStateAction<string[]>>;

	// Document Tree State (hierarchical view)
	documentTree: AutoRunTreeNode[];
	setDocumentTree: React.Dispatch<React.SetStateAction<AutoRunTreeNode[]>>;

	// Loading State
	isLoadingDocuments: boolean;
	setIsLoadingDocuments: React.Dispatch<React.SetStateAction<boolean>>;

	// Task Counts (per-document)
	documentTaskCounts: Map<string, TaskCountEntry>;
	setDocumentTaskCounts: React.Dispatch<React.SetStateAction<Map<string, TaskCountEntry>>>;

	// Convenience methods
	clearDocumentList: () => void;
	updateTaskCount: (filename: string, completed: number, total: number) => void;
}

// Create context with null as default (will throw if used outside provider)
const AutoRunContext = createContext<AutoRunContextValue | null>(null);

interface AutoRunProviderProps {
	children: ReactNode;
}

/**
 * AutoRunProvider - Provides centralized Auto Run state management
 *
 * This provider manages all Auto Run document states that were previously
 * scattered throughout App.tsx. It reduces App.tsx complexity and provides
 * a single location for Auto Run state management.
 *
 * Note: Batch processing logic remains in useBatchProcessor hook, which is
 * consumed by App.tsx. The batch state is passed through props to components.
 * This context focuses specifically on the document list/tree states.
 *
 * Usage:
 * Wrap App with this provider (after other context providers):
 * <AutoRunProvider>
 *   <App />
 * </AutoRunProvider>
 */
export function AutoRunProvider({ children }: AutoRunProviderProps) {
	// Document List State
	const [documentList, setDocumentList] = useState<string[]>([]);

	// Document Tree State (hierarchical view)
	const [documentTree, setDocumentTree] = useState<AutoRunTreeNode[]>([]);

	// Loading State
	const [isLoadingDocuments, setIsLoadingDocuments] = useState(false);

	// Task Counts (per-document)
	const [documentTaskCounts, setDocumentTaskCounts] = useState<Map<string, TaskCountEntry>>(
		new Map()
	);

	// Convenience method to clear document list
	const clearDocumentList = useCallback(() => {
		setDocumentList([]);
		setDocumentTree([]);
		setDocumentTaskCounts(new Map());
	}, []);

	// Convenience method to update task count for a document
	const updateTaskCount = useCallback((filename: string, completed: number, total: number) => {
		setDocumentTaskCounts((prev) => {
			const newMap = new Map(prev);
			newMap.set(filename, { completed, total });
			return newMap;
		});
	}, []);

	// Memoize the context value to prevent unnecessary re-renders
	const value = useMemo<AutoRunContextValue>(
		() => ({
			// Document List State
			documentList,
			setDocumentList,

			// Document Tree State
			documentTree,
			setDocumentTree,

			// Loading State
			isLoadingDocuments,
			setIsLoadingDocuments,

			// Task Counts
			documentTaskCounts,
			setDocumentTaskCounts,

			// Convenience methods
			clearDocumentList,
			updateTaskCount,
		}),
		[
			// Document List State
			documentList,
			// Document Tree State
			documentTree,
			// Loading State
			isLoadingDocuments,
			// Task Counts
			documentTaskCounts,
			// Convenience methods
			clearDocumentList,
			updateTaskCount,
		]
	);

	return <AutoRunContext.Provider value={value}>{children}</AutoRunContext.Provider>;
}

/**
 * useAutoRun - Hook to access Auto Run state management
 *
 * Must be used within an AutoRunProvider. Throws an error if used outside.
 *
 * @returns AutoRunContextValue - All Auto Run states and their setters
 *
 * @example
 * const { documentList, isLoadingDocuments, setDocumentList } = useAutoRun();
 *
 * // Load documents
 * setIsLoadingDocuments(true);
 * const result = await window.maestro.autorun.listDocs(folderPath);
 * setDocumentList(result.files || []);
 * setIsLoadingDocuments(false);
 *
 * @example
 * const { documentTaskCounts, updateTaskCount } = useAutoRun();
 *
 * // Update task count for a document
 * updateTaskCount('my-doc', 3, 10); // 3 of 10 tasks completed
 */
export function useAutoRun(): AutoRunContextValue {
	const context = useContext(AutoRunContext);

	if (!context) {
		throw new Error('useAutoRun must be used within an AutoRunProvider');
	}

	return context;
}
