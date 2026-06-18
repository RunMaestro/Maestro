import { useRef, useCallback, useEffect } from 'react';

/**
 * Undo/Redo state interface representing a snapshot of content and cursor position
 */
export interface UndoState {
	content: string;
	cursorPosition: number;
}

/**
 * Maximum number of undo history entries to retain per document
 */
const MAX_UNDO_HISTORY = 50;

/**
 * Debounce delay in ms for scheduling undo snapshots during typing
 */
const UNDO_SNAPSHOT_DEBOUNCE_MS = 1000;

/**
 * Dependencies required by useAutoRunUndo hook
 */
export interface UseAutoRunUndoDeps {
	/** Currently selected document filename (without extension) */
	selectedFile: string | null;
	/** Current content of the document */
	localContent: string;
	/** Function to update the local content state */
	setLocalContent: (content: string) => void;
	/** Ref to the textarea element for cursor position and focus */
	textareaRef: React.RefObject<HTMLTextAreaElement>;
}

/**
 * Return type of useAutoRunUndo hook
 */
export interface UseAutoRunUndoReturn {
	/** Push current state to undo history (call before making changes) */
	pushUndoState: (contentToSnapshot?: string, cursorPos?: number) => void;
	/** Schedule a debounced undo snapshot (call on each content change) */
	scheduleUndoSnapshot: (previousContent: string, previousCursor: number) => void;
	/** Handle undo action (Cmd+Z) */
	handleUndo: () => void;
	/** Handle redo action (Cmd+Shift+Z) */
	handleRedo: () => void;
	/** Reset undo history for current document (call when content changes externally) */
	resetUndoHistory: (newContent: string) => void;
	/** Ref to last snapshotted content (for external access) */
	lastUndoSnapshotRef: React.MutableRefObject<string>;
}

/**
 * Custom hook for managing undo/redo functionality in the Auto Run editor.
 *
 * This hook provides:
 * - Per-document undo/redo history (keyed by selectedFile)
 * - Debounced snapshot scheduling for typing (captures state after 1s of inactivity)
 * - Manual snapshot pushing for explicit actions (paste, tab insertion, etc.)
 * - Cursor position restoration on undo/redo
 *
 * Usage:
 * ```tsx
 * const { pushUndoState, handleUndo, handleRedo, scheduleUndoSnapshot } = useAutoRunUndo({
 *   selectedFile,
 *   localContent,
 *   setLocalContent,
 *   textareaRef,
 * });
 *
 * // In onChange handler:
 * scheduleUndoSnapshot(previousContent, previousCursor);
 *
 * // Before explicit modifications (paste, list continuation, etc.):
 * pushUndoState();
 *
 * // In keydown handler:
 * if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
 *   e.shiftKey ? handleRedo() : handleUndo();
 * }
 * ```
 */
export function useAutoRunUndo({
	selectedFile,
	localContent,
	setLocalContent,
	textareaRef,
}: UseAutoRunUndoDeps): UseAutoRunUndoReturn {
	// Undo/Redo history maps - keyed by document filename (selectedFile)
	// Using refs so history persists across re-renders without triggering re-renders
	const undoHistoryRef = useRef<Map<string, UndoState[]>>(new Map());
	const redoHistoryRef = useRef<Map<string, UndoState[]>>(new Map());

	// Track last content that was snapshotted for undo
	const lastUndoSnapshotRef = useRef<string>(localContent);

	// Timer ref for debounced undo snapshots
	const undoSnapshotTimeoutRef = useRef<NodeJS.Timeout | null>(null);

	/**
	 * Push current state to undo history.
	 * Call this BEFORE making changes to capture the previous state.
	 */
	const pushUndoState = useCallback(
		(contentToSnapshot?: string, cursorPos?: number) => {
			if (!selectedFile) return;

			const snapshotContent = contentToSnapshot ?? localContent;
			const snapshotCursor = cursorPos ?? textareaRef.current?.selectionStart ?? 0;

			const currentState: UndoState = {
				content: snapshotContent,
				cursorPosition: snapshotCursor,
			};

			// Get or create history array for this document
			const history = undoHistoryRef.current.get(selectedFile) || [];
			const lastHistoryEntry = history[history.length - 1];

			// Only skip if the last entry already matches this snapshot
			if (
				snapshotContent === lastUndoSnapshotRef.current &&
				lastHistoryEntry?.content === snapshotContent
			) {
				return;
			}

			history.push(currentState);

			// Limit to MAX_UNDO_HISTORY entries
			if (history.length > MAX_UNDO_HISTORY) {
				history.shift();
			}

			undoHistoryRef.current.set(selectedFile, history);

			// Update last snapshot reference
			lastUndoSnapshotRef.current = snapshotContent;

			// Clear redo stack on new edit action
			redoHistoryRef.current.set(selectedFile, []);
		},
		[selectedFile, localContent, textareaRef]
	);

	/**
	 * Schedule a debounced undo snapshot.
	 * Call this on each content change to capture typing sequences.
	 */
	const scheduleUndoSnapshot = useCallback(
		(previousContent: string, previousCursor: number) => {
			// Clear any pending snapshot
			if (undoSnapshotTimeoutRef.current) {
				clearTimeout(undoSnapshotTimeoutRef.current);
			}

			// Schedule snapshot after debounce delay of inactivity
			undoSnapshotTimeoutRef.current = setTimeout(() => {
				pushUndoState(previousContent, previousCursor);
			}, UNDO_SNAPSHOT_DEBOUNCE_MS);
		},
		[pushUndoState]
	);

	/**
	 * Handle undo action (Cmd+Z).
	 * Pops the last state from undo stack and applies it.
	 */
	const handleUndo = useCallback(() => {
		if (!selectedFile) return;

		const undoStack = undoHistoryRef.current.get(selectedFile) || [];
		if (undoStack.length === 0) return;

		// Save current state to redo stack before undoing
		const redoStack = redoHistoryRef.current.get(selectedFile) || [];
		redoStack.push({
			content: localContent,
			cursorPosition: textareaRef.current?.selectionStart || 0,
		});
		redoHistoryRef.current.set(selectedFile, redoStack);

		// Pop and apply the undo state
		const prevState = undoStack.pop()!;
		undoHistoryRef.current.set(selectedFile, undoStack);

		// Update content without pushing to undo stack
		setLocalContent(prevState.content);
		lastUndoSnapshotRef.current = prevState.content;

		// Restore cursor position after React re-renders
		requestAnimationFrame(() => {
			if (textareaRef.current) {
				textareaRef.current.setSelectionRange(prevState.cursorPosition, prevState.cursorPosition);
				textareaRef.current.focus();
			}
		});
	}, [selectedFile, localContent, setLocalContent, textareaRef]);

	/**
	 * Handle redo action (Cmd+Shift+Z).
	 * Pops the last state from redo stack and applies it.
	 */
	const handleRedo = useCallback(() => {
		if (!selectedFile) return;

		const redoStack = redoHistoryRef.current.get(selectedFile) || [];
		if (redoStack.length === 0) return;

		// Save current state to undo stack before redoing
		const undoStack = undoHistoryRef.current.get(selectedFile) || [];
		undoStack.push({
			content: localContent,
			cursorPosition: textareaRef.current?.selectionStart || 0,
		});
		undoHistoryRef.current.set(selectedFile, undoStack);

		// Pop and apply the redo state
		const nextState = redoStack.pop()!;
		redoHistoryRef.current.set(selectedFile, redoStack);

		// Update content without pushing to undo stack
		setLocalContent(nextState.content);
		lastUndoSnapshotRef.current = nextState.content;

		// Restore cursor position after React re-renders
		requestAnimationFrame(() => {
			if (textareaRef.current) {
				textareaRef.current.setSelectionRange(nextState.cursorPosition, nextState.cursorPosition);
				textareaRef.current.focus();
			}
		});
	}, [selectedFile, localContent, setLocalContent, textareaRef]);

	/**
	 * Reset undo history for current document.
	 * Call when content changes externally (document switch, file watcher, etc.)
	 */
	const resetUndoHistory = useCallback((newContent: string) => {
		lastUndoSnapshotRef.current = newContent;
	}, []);

	// Cleanup pending timeout on unmount or when document changes
	useEffect(() => {
		return () => {
			if (undoSnapshotTimeoutRef.current) {
				clearTimeout(undoSnapshotTimeoutRef.current);
				undoSnapshotTimeoutRef.current = null;
			}
		};
	}, [selectedFile]);

	return {
		pushUndoState,
		scheduleUndoSnapshot,
		handleUndo,
		handleRedo,
		resetUndoHistory,
		lastUndoSnapshotRef,
	};
}
