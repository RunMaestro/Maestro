import { useRef, useCallback, useEffect } from 'react';
import type { MarkdownEditorHandle } from '../../components/FilePreview/markdownEditor';

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
	/** Ref to the CodeMirror editor, for cursor position and focus */
	editorRef: React.RefObject<MarkdownEditorHandle>;
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
 *   editorRef,
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
	editorRef,
}: UseAutoRunUndoDeps): UseAutoRunUndoReturn {
	// Undo/Redo history maps - keyed by document filename (selectedFile)
	// Using refs so history persists across re-renders without triggering re-renders
	const undoHistoryRef = useRef<Map<string, UndoState[]>>(new Map());
	const redoHistoryRef = useRef<Map<string, UndoState[]>>(new Map());

	// Track last content that was snapshotted for undo
	const lastUndoSnapshotRef = useRef<string>(localContent);

	// Pending while a typing burst is in progress; it expires after
	// UNDO_SNAPSHOT_DEBOUNCE_MS of inactivity, and the next keystroke opens a new
	// burst.
	const undoSnapshotTimeoutRef = useRef<NodeJS.Timeout | null>(null);

	/** Close the current typing burst so the next keystroke snapshots again. */
	const endTypingBurst = useCallback(() => {
		if (undoSnapshotTimeoutRef.current) {
			clearTimeout(undoSnapshotTimeoutRef.current);
			undoSnapshotTimeoutRef.current = null;
		}
	}, []);

	/**
	 * Push current state to undo history.
	 * Call this BEFORE making changes to capture the previous state.
	 */
	const pushUndoState = useCallback(
		(contentToSnapshot?: string, cursorPos?: number) => {
			if (!selectedFile) return;
			// An explicit edit (paste, tab, list continuation) is its own undo
			// step; typing after it must open a fresh burst.
			endTypingBurst();

			const snapshotContent = contentToSnapshot ?? localContent;
			const snapshotCursor = cursorPos ?? editorRef.current?.getCaret() ?? 0;

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
		[selectedFile, localContent, editorRef, endTypingBurst]
	);

	/**
	 * Group typing into undo steps. Call on each content change with the state
	 * from BEFORE that change.
	 *
	 * The snapshot is taken on the FIRST keystroke of a burst, so one Cmd+Z
	 * removes the whole burst. Snapshotting on the trailing edge instead would
	 * capture the text before the burst's LAST keystroke: the first Cmd+Z then
	 * drops one character, the second drops the rest of the burst plus the last
	 * character of the one before it, and the text before the first burst can
	 * never be reached at all.
	 */
	const scheduleUndoSnapshot = useCallback(
		(previousContent: string, previousCursor: number) => {
			const burstInProgress = undoSnapshotTimeoutRef.current !== null;
			if (!burstInProgress) {
				pushUndoState(previousContent, previousCursor);
			} else {
				clearTimeout(undoSnapshotTimeoutRef.current!);
			}
			undoSnapshotTimeoutRef.current = setTimeout(() => {
				undoSnapshotTimeoutRef.current = null;
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
		endTypingBurst();

		// Save current state to redo stack before undoing
		const redoStack = redoHistoryRef.current.get(selectedFile) || [];
		redoStack.push({
			content: localContent,
			cursorPosition: editorRef.current?.getCaret() || 0,
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
			editorRef.current?.setSelection(prevState.cursorPosition, prevState.cursorPosition);
			editorRef.current?.focus();
		});
	}, [selectedFile, localContent, setLocalContent, editorRef, endTypingBurst]);

	/**
	 * Handle redo action (Cmd+Shift+Z).
	 * Pops the last state from redo stack and applies it.
	 */
	const handleRedo = useCallback(() => {
		if (!selectedFile) return;

		const redoStack = redoHistoryRef.current.get(selectedFile) || [];
		if (redoStack.length === 0) return;
		endTypingBurst();

		// Save current state to undo stack before redoing
		const undoStack = undoHistoryRef.current.get(selectedFile) || [];
		undoStack.push({
			content: localContent,
			cursorPosition: editorRef.current?.getCaret() || 0,
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
			editorRef.current?.setSelection(nextState.cursorPosition, nextState.cursorPosition);
			editorRef.current?.focus();
		});
	}, [selectedFile, localContent, setLocalContent, editorRef, endTypingBurst]);

	/**
	 * Reset undo history for current document.
	 * Call when content changes externally (document switch, file watcher, etc.)
	 */
	const resetUndoHistory = useCallback(
		(newContent: string) => {
			endTypingBurst();
			lastUndoSnapshotRef.current = newContent;
		},
		[endTypingBurst]
	);

	// Close any open burst on unmount or when the document changes
	useEffect(() => endTypingBurst, [selectedFile, endTypingBurst]);

	return {
		pushUndoState,
		scheduleUndoSnapshot,
		handleUndo,
		handleRedo,
		resetUndoHistory,
		lastUndoSnapshotRef,
	};
}
