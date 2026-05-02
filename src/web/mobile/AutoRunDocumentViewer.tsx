/**
 * AutoRunDocumentViewer component for Maestro mobile web interface
 *
 * Full-screen document viewer/editor for Auto Run markdown files.
 * Supports preview mode (rendered markdown) and edit mode (textarea),
 * undo/redo history, in-document search, and a lock state that disables
 * edits while the desktop is running an Auto Run on this document.
 * Loads content via WebSocket and saves explicitly on user action.
 */

import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useThemeColors } from '../components/ThemeProvider';
import { MobileMarkdownRenderer } from './MobileMarkdownRenderer';
import { triggerHaptic, HAPTIC_PATTERNS } from './constants';
import type { UseWebSocketReturn } from '../hooks/useWebSocket';

/**
 * Props for AutoRunDocumentViewer component
 */
export interface AutoRunDocumentViewerProps {
	sessionId: string;
	filename: string;
	onBack: () => void;
	sendRequest: UseWebSocketReturn['sendRequest'];
	/** When true, the editor is forced read-only (e.g. during an active Auto Run). */
	isLocked?: boolean;
}

/** Maximum entries kept in the undo history. Older states are dropped. */
const MAX_UNDO_HISTORY = 100;
/** How often (ms) to push a new history snapshot when typing rapidly. */
const HISTORY_SNAPSHOT_INTERVAL_MS = 350;

/**
 * AutoRunDocumentViewer component
 *
 * Full-screen viewer/editor for Auto Run markdown documents.
 * Default mode is preview (rendered markdown); toggle to edit mode for a textarea.
 */
export function AutoRunDocumentViewer({
	sessionId,
	filename,
	onBack,
	sendRequest,
	isLocked = false,
}: AutoRunDocumentViewerProps) {
	const colors = useThemeColors();
	const [content, setContent] = useState<string>('');
	const [editContent, setEditContent] = useState<string>('');
	const [isLoading, setIsLoading] = useState(true);
	const [isEditing, setIsEditing] = useState(false);
	const [isDirty, setIsDirty] = useState(false);
	const [isSaving, setIsSaving] = useState(false);
	const [saveMessage, setSaveMessage] = useState<{
		text: string;
		type: 'success' | 'error';
	} | null>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const saveMessageTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Undo/redo history. We snapshot at most every HISTORY_SNAPSHOT_INTERVAL_MS
	// while typing so a single Cmd+Z reverts to a sensible chunk, not one keystroke.
	const undoStackRef = useRef<string[]>([]);
	const redoStackRef = useRef<string[]>([]);
	const lastSnapshotAtRef = useRef<number>(0);
	const [historyTick, setHistoryTick] = useState(0);
	const canUndo = undoStackRef.current.length > 0;
	const canRedo = redoStackRef.current.length > 0;

	// Search state. Matches are computed against displayContent and the
	// current match is highlighted by selecting that range in the textarea.
	const [searchOpen, setSearchOpen] = useState(false);
	const [searchQuery, setSearchQuery] = useState('');
	const [searchIndex, setSearchIndex] = useState(0);

	// Load document content on mount
	useEffect(() => {
		let cancelled = false;

		async function loadContent() {
			setIsLoading(true);
			try {
				const response = await sendRequest<{ content?: string }>('get_auto_run_document', {
					sessionId,
					filename,
				});
				if (!cancelled) {
					const loaded = response.content ?? '';
					// Clear history *before* swapping content so Cmd+Z can't rewind
					// into the previously-viewed document's text.
					undoStackRef.current = [];
					redoStackRef.current = [];
					setContent(loaded);
					setEditContent(loaded);
					setHistoryTick((t) => t + 1);
				}
			} catch (err) {
				if (!cancelled) {
					// Same reasoning as the success path — if the request fails after
					// switching documents, a stray Cmd+Z could otherwise resurrect the
					// previous file's buffer and let it be saved into this filename.
					undoStackRef.current = [];
					redoStackRef.current = [];
					setContent('');
					setEditContent('');
					setHistoryTick((t) => t + 1);
					// Web bundle has no Sentry — log to console so the failure is at
					// least visible in browser devtools instead of silently swallowed.
					console.error('[AutoRunDocumentViewer] get_auto_run_document failed', {
						sessionId,
						filename,
						err,
					});
				}
			} finally {
				if (!cancelled) {
					setIsLoading(false);
				}
			}
		}

		loadContent();
		return () => {
			cancelled = true;
		};
	}, [sessionId, filename, sendRequest]);

	// If the Auto Run starts while the user is editing, drop them back to preview
	// AND discard any unsaved local edits so the locked view reflects the live
	// file the run will be mutating — keeping a dirty buffer would let the
	// preview render stale text on top of the file the agent is editing.
	useEffect(() => {
		if (isLocked && isEditing) {
			setIsEditing(false);
			setEditContent(content);
			setIsDirty(false);
		}
	}, [isLocked, isEditing, content]);

	// Clear save message timer on unmount
	useEffect(() => {
		return () => {
			if (saveMessageTimerRef.current) {
				clearTimeout(saveMessageTimerRef.current);
			}
		};
	}, []);

	// Focus textarea when entering edit mode — but skip when search is open,
	// otherwise the search-toggle path that flips isEditing to true would steal
	// focus from the search input and start typing into the document.
	useEffect(() => {
		if (isEditing && !searchOpen && textareaRef.current) {
			textareaRef.current.focus();
		}
	}, [isEditing, searchOpen]);

	const showSaveMessage = useCallback((text: string, type: 'success' | 'error') => {
		setSaveMessage({ text, type });
		if (saveMessageTimerRef.current) {
			clearTimeout(saveMessageTimerRef.current);
		}
		saveMessageTimerRef.current = setTimeout(() => {
			setSaveMessage(null);
		}, 2500);
	}, []);

	const handleBack = useCallback(() => {
		if (isDirty) {
			const confirmed = window.confirm('You have unsaved changes. Discard and go back?');
			if (!confirmed) return;
		}
		triggerHaptic(HAPTIC_PATTERNS.tap);
		onBack();
	}, [isDirty, onBack]);

	const handleToggleEdit = useCallback(() => {
		if (isLocked) return;
		triggerHaptic(HAPTIC_PATTERNS.tap);
		if (isEditing) {
			// Switching to preview — if dirty, keep editContent but show preview of editContent
			setIsEditing(false);
		} else {
			// Switching to edit — sync editContent with latest
			setEditContent(isDirty ? editContent : content);
			setIsEditing(true);
		}
	}, [isLocked, isEditing, isDirty, editContent, content]);

	const pushHistorySnapshot = useCallback((value: string) => {
		undoStackRef.current.push(value);
		if (undoStackRef.current.length > MAX_UNDO_HISTORY) {
			undoStackRef.current.shift();
		}
		// Any new edit invalidates the redo stack — same behavior as native editors.
		redoStackRef.current = [];
		setHistoryTick((t) => t + 1);
	}, []);

	const handleContentChange = useCallback(
		(e: React.ChangeEvent<HTMLTextAreaElement>) => {
			const newContent = e.target.value;
			const now = Date.now();
			// Throttle history snapshots so a long burst of typing collapses into one
			// undo step. Always snapshot the *previous* value before mutating state.
			if (now - lastSnapshotAtRef.current >= HISTORY_SNAPSHOT_INTERVAL_MS) {
				pushHistorySnapshot(editContent);
				lastSnapshotAtRef.current = now;
			}
			setEditContent(newContent);
			setIsDirty(newContent !== content);
		},
		[content, editContent, pushHistorySnapshot]
	);

	const handleUndo = useCallback(() => {
		if (undoStackRef.current.length === 0) return;
		const previous = undoStackRef.current.pop();
		if (previous === undefined) return;
		redoStackRef.current.push(editContent);
		if (redoStackRef.current.length > MAX_UNDO_HISTORY) {
			redoStackRef.current.shift();
		}
		setEditContent(previous);
		setIsDirty(previous !== content);
		setHistoryTick((t) => t + 1);
		// Reset throttle so the *next* keystroke produces a fresh snapshot
		// instead of being absorbed into the post-undo edit.
		lastSnapshotAtRef.current = 0;
	}, [content, editContent]);

	const handleRedo = useCallback(() => {
		if (redoStackRef.current.length === 0) return;
		const next = redoStackRef.current.pop();
		if (next === undefined) return;
		undoStackRef.current.push(editContent);
		if (undoStackRef.current.length > MAX_UNDO_HISTORY) {
			undoStackRef.current.shift();
		}
		setEditContent(next);
		setIsDirty(next !== content);
		setHistoryTick((t) => t + 1);
		lastSnapshotAtRef.current = 0;
	}, [content, editContent]);

	const handleSave = useCallback(async () => {
		if (isLocked) return;
		triggerHaptic(HAPTIC_PATTERNS.tap);
		setIsSaving(true);
		try {
			const response = await sendRequest<{ success?: boolean }>('save_auto_run_document', {
				sessionId,
				filename,
				content: editContent,
			});
			if (response.success) {
				setContent(editContent);
				setIsDirty(false);
				triggerHaptic(HAPTIC_PATTERNS.success);
				showSaveMessage('Saved', 'success');
			} else {
				triggerHaptic(HAPTIC_PATTERNS.error);
				showSaveMessage('Save failed', 'error');
			}
		} catch {
			triggerHaptic(HAPTIC_PATTERNS.error);
			showSaveMessage('Save failed', 'error');
		} finally {
			setIsSaving(false);
		}
	}, [isLocked, sessionId, filename, editContent, sendRequest, showSaveMessage]);

	// Display content: when dirty, show editContent in preview; otherwise show saved content.
	const displayContent = isDirty ? editContent : content;

	// Compute search matches in the currently-displayed content. Matching is
	// case-insensitive and uses literal (non-regex) substrings.
	const searchMatches = useMemo<number[]>(() => {
		if (!searchQuery) return [];
		const out: number[] = [];
		const haystack = displayContent.toLowerCase();
		const needle = searchQuery.toLowerCase();
		if (!needle) return out;
		let from = 0;
		while (from <= haystack.length) {
			const idx = haystack.indexOf(needle, from);
			if (idx === -1) break;
			out.push(idx);
			from = idx + Math.max(1, needle.length);
		}
		return out;
	}, [displayContent, searchQuery]);

	// Reset the active match when the result set changes.
	useEffect(() => {
		setSearchIndex(0);
	}, [searchMatches]);

	const focusActiveMatch = useCallback(
		(matchIdx: number) => {
			if (searchMatches.length === 0) return;
			const wrappedIdx =
				((matchIdx % searchMatches.length) + searchMatches.length) % searchMatches.length;
			const start = searchMatches[wrappedIdx];
			const end = start + searchQuery.length;
			setSearchIndex(wrappedIdx);
			if (isEditing && textareaRef.current) {
				const ta = textareaRef.current;
				ta.focus();
				ta.setSelectionRange(start, end);
				// Try to scroll the match into view by adjusting scrollTop.
				// Approximation: we use line height × line number of the match.
				const before = displayContent.slice(0, start);
				const lineNumber = before.split('\n').length - 1;
				const lineHeight = 22; // matches our textarea fontSize × line-height
				ta.scrollTop = Math.max(0, lineNumber * lineHeight - ta.clientHeight / 2);
			}
		},
		[displayContent, isEditing, searchMatches, searchQuery.length]
	);

	const handleSearchToggle = useCallback(() => {
		setSearchOpen((open) => {
			const next = !open;
			if (!next) setSearchQuery('');
			// Switch to edit mode when opening search so the textarea can
			// highlight and scroll to the active match. We skip this when the
			// viewer is locked (an Auto Run is in progress) since editing is
			// disabled there — in that case the match counter still updates but
			// Next/Prev won't move a selection.
			if (next && !isEditing && !isLocked) {
				setEditContent(isDirty ? editContent : content);
				setIsEditing(true);
			}
			return next;
		});
	}, [content, editContent, isDirty, isEditing, isLocked]);

	const handleSearchNext = useCallback(() => {
		if (searchMatches.length === 0) return;
		focusActiveMatch(searchIndex + 1);
	}, [searchMatches, searchIndex, focusActiveMatch]);

	const handleSearchPrev = useCallback(() => {
		if (searchMatches.length === 0) return;
		focusActiveMatch(searchIndex - 1);
	}, [searchMatches, searchIndex, focusActiveMatch]);

	// Keyboard shortcuts: Esc, Cmd+S to save, Cmd+F to search, Cmd+Z / Shift+Cmd+Z for history.
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				if (searchOpen) {
					setSearchOpen(false);
					setSearchQuery('');
					return;
				}
				handleBack();
				return;
			}
			const meta = e.metaKey || e.ctrlKey;
			if (!meta) return;
			if (e.key === 's' && isEditing && isDirty && !isLocked) {
				e.preventDefault();
				handleSave();
				return;
			}
			if (e.key === 'f') {
				e.preventDefault();
				setSearchOpen(true);
				return;
			}
			if (e.key === 'z' && isEditing) {
				e.preventDefault();
				if (e.shiftKey) {
					handleRedo();
				} else {
					handleUndo();
				}
				return;
			}
			// Some keyboards send Cmd+Y for redo (Windows/Linux convention)
			if (e.key === 'y' && isEditing) {
				e.preventDefault();
				handleRedo();
			}
		};
		document.addEventListener('keydown', handleKeyDown);
		return () => document.removeEventListener('keydown', handleKeyDown);
	}, [handleBack, handleSave, handleRedo, handleUndo, isEditing, isDirty, isLocked, searchOpen]);

	// Reference historyTick so React re-renders the toolbar when undo/redo
	// availability changes (refs alone wouldn't trigger a render).
	void historyTick;

	return (
		<div
			style={{
				position: 'fixed',
				top: 0,
				left: 0,
				right: 0,
				bottom: 0,
				backgroundColor: colors.bgMain,
				zIndex: 210,
				display: 'flex',
				flexDirection: 'column',
				animation: 'docViewerSlideIn 0.25s ease-out',
			}}
		>
			{/* Header */}
			<header
				style={{
					display: 'flex',
					alignItems: 'center',
					gap: '8px',
					padding: '12px 16px',
					paddingTop: 'max(12px, env(safe-area-inset-top))',
					borderBottom: `1px solid ${colors.border}`,
					backgroundColor: colors.bgSidebar,
					minHeight: '56px',
					flexShrink: 0,
				}}
			>
				{/* Back button */}
				<button
					onClick={handleBack}
					style={{
						width: '44px',
						height: '44px',
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'center',
						borderRadius: '8px',
						backgroundColor: colors.bgMain,
						border: `1px solid ${colors.border}`,
						color: colors.textMain,
						cursor: 'pointer',
						touchAction: 'manipulation',
						WebkitTapHighlightColor: 'transparent',
						flexShrink: 0,
					}}
					aria-label="Go back"
				>
					<svg
						width="18"
						height="18"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
					>
						<line x1="19" y1="12" x2="5" y2="12" />
						<polyline points="12 19 5 12 12 5" />
					</svg>
				</button>

				{/* Filename title */}
				<div
					style={{
						flex: 1,
						minWidth: 0,
						overflow: 'hidden',
						textOverflow: 'ellipsis',
						whiteSpace: 'nowrap',
						fontSize: '16px',
						fontWeight: 600,
						color: colors.textMain,
					}}
				>
					{filename}
					{isLocked && (
						<span
							style={{
								fontSize: '11px',
								fontWeight: 500,
								color: colors.warning,
								marginLeft: '6px',
							}}
						>
							(locked — Auto Run in progress)
						</span>
					)}
					{isDirty && !isLocked && (
						<span
							style={{
								fontSize: '12px',
								fontWeight: 400,
								color: colors.warning,
								marginLeft: '6px',
							}}
						>
							(unsaved)
						</span>
					)}
				</div>

				{/* Search toggle button */}
				<button
					onClick={handleSearchToggle}
					style={{
						width: '44px',
						height: '44px',
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'center',
						borderRadius: '8px',
						backgroundColor: searchOpen ? `${colors.accent}20` : colors.bgMain,
						border: `1px solid ${searchOpen ? colors.accent : colors.border}`,
						color: searchOpen ? colors.accent : colors.textMain,
						cursor: 'pointer',
						touchAction: 'manipulation',
						WebkitTapHighlightColor: 'transparent',
						flexShrink: 0,
					}}
					aria-label={searchOpen ? 'Close search' : 'Search document'}
					title="Search (Cmd+F)"
				>
					<svg
						width="16"
						height="16"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
					>
						<circle cx="11" cy="11" r="8" />
						<line x1="21" y1="21" x2="16.65" y2="16.65" />
					</svg>
				</button>

				{/* Edit/Preview toggle */}
				<button
					onClick={handleToggleEdit}
					disabled={isLocked}
					style={{
						width: '44px',
						height: '44px',
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'center',
						borderRadius: '8px',
						backgroundColor: isEditing ? `${colors.accent}20` : colors.bgMain,
						border: `1px solid ${isEditing ? colors.accent : colors.border}`,
						color: isEditing ? colors.accent : colors.textMain,
						cursor: isLocked ? 'not-allowed' : 'pointer',
						opacity: isLocked ? 0.5 : 1,
						touchAction: 'manipulation',
						WebkitTapHighlightColor: 'transparent',
						flexShrink: 0,
					}}
					aria-label={isEditing ? 'Switch to preview' : 'Switch to edit'}
				>
					{isEditing ? (
						// Eye icon (preview)
						<svg
							width="18"
							height="18"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
							<circle cx="12" cy="12" r="3" />
						</svg>
					) : (
						// Pencil icon (edit)
						<svg
							width="18"
							height="18"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
							<path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
						</svg>
					)}
				</button>

				{/* Save button (when editing and dirty) */}
				{isEditing && isDirty && !isLocked && (
					<button
						onClick={handleSave}
						disabled={isSaving}
						style={{
							height: '44px',
							padding: '0 16px',
							display: 'flex',
							alignItems: 'center',
							justifyContent: 'center',
							borderRadius: '8px',
							backgroundColor: isSaving ? `${colors.accent}60` : colors.accent,
							border: 'none',
							color: 'white',
							fontSize: '14px',
							fontWeight: 600,
							cursor: isSaving ? 'not-allowed' : 'pointer',
							touchAction: 'manipulation',
							WebkitTapHighlightColor: 'transparent',
							flexShrink: 0,
						}}
						aria-label="Save document"
					>
						{isSaving ? 'Saving...' : 'Save'}
					</button>
				)}
			</header>

			{/* Search bar (when open) */}
			{searchOpen && (
				<div
					style={{
						display: 'flex',
						alignItems: 'center',
						gap: '6px',
						padding: '8px 16px',
						borderBottom: `1px solid ${colors.border}`,
						backgroundColor: colors.bgSidebar,
						flexShrink: 0,
					}}
				>
					<input
						type="text"
						autoFocus
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === 'Enter') {
								e.preventDefault();
								if (e.shiftKey) handleSearchPrev();
								else handleSearchNext();
							}
						}}
						placeholder="Find in document..."
						style={{
							flex: 1,
							padding: '8px 10px',
							borderRadius: '8px',
							border: `1px solid ${colors.border}`,
							backgroundColor: colors.bgMain,
							color: colors.textMain,
							fontSize: '14px',
							outline: 'none',
							WebkitAppearance: 'none',
						}}
						aria-label="Search query"
					/>
					<span
						style={{
							fontSize: '12px',
							color: colors.textDim,
							minWidth: '60px',
							textAlign: 'right',
						}}
					>
						{searchMatches.length === 0
							? searchQuery
								? '0 / 0'
								: '—'
							: `${searchIndex + 1} / ${searchMatches.length}`}
					</span>
					<button
						onClick={handleSearchPrev}
						disabled={searchMatches.length === 0}
						style={{
							width: '36px',
							height: '36px',
							display: 'flex',
							alignItems: 'center',
							justifyContent: 'center',
							borderRadius: '8px',
							backgroundColor: colors.bgMain,
							border: `1px solid ${colors.border}`,
							color: colors.textMain,
							cursor: searchMatches.length === 0 ? 'not-allowed' : 'pointer',
							opacity: searchMatches.length === 0 ? 0.4 : 1,
							flexShrink: 0,
						}}
						aria-label="Previous match"
					>
						<svg
							width="14"
							height="14"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<polyline points="18 15 12 9 6 15" />
						</svg>
					</button>
					<button
						onClick={handleSearchNext}
						disabled={searchMatches.length === 0}
						style={{
							width: '36px',
							height: '36px',
							display: 'flex',
							alignItems: 'center',
							justifyContent: 'center',
							borderRadius: '8px',
							backgroundColor: colors.bgMain,
							border: `1px solid ${colors.border}`,
							color: colors.textMain,
							cursor: searchMatches.length === 0 ? 'not-allowed' : 'pointer',
							opacity: searchMatches.length === 0 ? 0.4 : 1,
							flexShrink: 0,
						}}
						aria-label="Next match"
					>
						<svg
							width="14"
							height="14"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<polyline points="6 9 12 15 18 9" />
						</svg>
					</button>
					<button
						onClick={handleSearchToggle}
						style={{
							width: '36px',
							height: '36px',
							display: 'flex',
							alignItems: 'center',
							justifyContent: 'center',
							borderRadius: '8px',
							backgroundColor: 'transparent',
							border: `1px solid ${colors.border}`,
							color: colors.textDim,
							cursor: 'pointer',
							flexShrink: 0,
						}}
						aria-label="Close search"
					>
						<svg
							width="14"
							height="14"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<line x1="18" y1="6" x2="6" y2="18" />
							<line x1="6" y1="6" x2="18" y2="18" />
						</svg>
					</button>
				</div>
			)}

			{/* Save message toast */}
			{saveMessage && (
				<div
					style={{
						padding: '8px 16px',
						backgroundColor:
							saveMessage.type === 'success' ? `${colors.success}20` : `${colors.error}20`,
						color: saveMessage.type === 'success' ? colors.success : colors.error,
						fontSize: '13px',
						fontWeight: 500,
						textAlign: 'center',
						flexShrink: 0,
						transition: 'opacity 0.2s ease',
					}}
				>
					{saveMessage.text}
				</div>
			)}

			{/* Content area */}
			<div
				style={{
					flex: 1,
					overflowY: 'auto',
					overflowX: 'hidden',
				}}
			>
				{isLoading ? (
					// Loading spinner
					<div
						style={{
							display: 'flex',
							alignItems: 'center',
							justifyContent: 'center',
							padding: '60px 20px',
							color: colors.textDim,
							fontSize: '14px',
						}}
					>
						<svg
							width="24"
							height="24"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
							style={{
								animation: 'docViewerSpin 1s linear infinite',
								marginRight: '10px',
							}}
						>
							<line x1="12" y1="2" x2="12" y2="6" />
							<line x1="12" y1="18" x2="12" y2="22" />
							<line x1="4.93" y1="4.93" x2="7.76" y2="7.76" />
							<line x1="16.24" y1="16.24" x2="19.07" y2="19.07" />
							<line x1="2" y1="12" x2="6" y2="12" />
							<line x1="18" y1="12" x2="22" y2="12" />
							<line x1="4.93" y1="19.07" x2="7.76" y2="16.24" />
							<line x1="16.24" y1="7.76" x2="19.07" y2="4.93" />
						</svg>
						Loading document...
					</div>
				) : isEditing ? (
					// Edit mode: textarea
					<div
						style={{
							display: 'flex',
							flexDirection: 'column',
							height: '100%',
						}}
					>
						<textarea
							ref={textareaRef}
							value={editContent}
							onChange={handleContentChange}
							readOnly={isLocked}
							style={{
								flex: 1,
								width: '100%',
								padding: '16px',
								paddingBottom: 'max(16px, env(safe-area-inset-bottom))',
								border: 'none',
								outline: 'none',
								resize: 'none',
								backgroundColor: colors.bgMain,
								color: colors.textMain,
								fontSize: '14px',
								lineHeight: 1.6,
								fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
								WebkitAppearance: 'none',
							}}
							spellCheck={false}
						/>
						{/* Footer: undo/redo buttons + character count */}
						<div
							style={{
								display: 'flex',
								alignItems: 'center',
								gap: '8px',
								padding: '6px 16px',
								paddingBottom: 'max(6px, env(safe-area-inset-bottom))',
								borderTop: `1px solid ${colors.border}`,
								backgroundColor: colors.bgSidebar,
								flexShrink: 0,
							}}
						>
							<button
								onClick={handleUndo}
								disabled={!canUndo}
								style={{
									width: '32px',
									height: '32px',
									display: 'flex',
									alignItems: 'center',
									justifyContent: 'center',
									borderRadius: '6px',
									backgroundColor: 'transparent',
									border: `1px solid ${colors.border}`,
									color: canUndo ? colors.textMain : colors.textDim,
									cursor: canUndo ? 'pointer' : 'not-allowed',
									opacity: canUndo ? 1 : 0.4,
									flexShrink: 0,
									touchAction: 'manipulation',
									WebkitTapHighlightColor: 'transparent',
								}}
								aria-label="Undo"
								title="Undo (Cmd+Z)"
							>
								<svg
									width="14"
									height="14"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth="2"
									strokeLinecap="round"
									strokeLinejoin="round"
								>
									<path d="M3 7v6h6" />
									<path d="M21 17a9 9 0 0 0-15-6.7L3 13" />
								</svg>
							</button>
							<button
								onClick={handleRedo}
								disabled={!canRedo}
								style={{
									width: '32px',
									height: '32px',
									display: 'flex',
									alignItems: 'center',
									justifyContent: 'center',
									borderRadius: '6px',
									backgroundColor: 'transparent',
									border: `1px solid ${colors.border}`,
									color: canRedo ? colors.textMain : colors.textDim,
									cursor: canRedo ? 'pointer' : 'not-allowed',
									opacity: canRedo ? 1 : 0.4,
									flexShrink: 0,
									touchAction: 'manipulation',
									WebkitTapHighlightColor: 'transparent',
								}}
								aria-label="Redo"
								title="Redo (Shift+Cmd+Z)"
							>
								<svg
									width="14"
									height="14"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth="2"
									strokeLinecap="round"
									strokeLinejoin="round"
								>
									<path d="M21 7v6h-6" />
									<path d="M3 17a9 9 0 0 1 15-6.7L21 13" />
								</svg>
							</button>
							<div
								style={{
									flex: 1,
									textAlign: 'right',
									fontSize: '11px',
									color: colors.textDim,
								}}
							>
								{editContent.length.toLocaleString()} characters
							</div>
						</div>
					</div>
				) : (
					// Preview mode: rendered markdown
					<div
						style={{
							padding: '16px',
							paddingBottom: 'max(16px, env(safe-area-inset-bottom))',
						}}
					>
						{displayContent ? (
							<MobileMarkdownRenderer content={displayContent} fontSize={14} />
						) : (
							<div
								style={{
									color: colors.textDim,
									fontSize: '14px',
									textAlign: 'center',
									padding: '40px 20px',
								}}
							>
								This document is empty.
							</div>
						)}
					</div>
				)}
			</div>

			{/* Animation keyframes */}
			<style>{`
				@keyframes docViewerSlideIn {
					from {
						opacity: 0;
						transform: translateX(20px);
					}
					to {
						opacity: 1;
						transform: translateX(0);
					}
				}
				@keyframes docViewerSpin {
					from { transform: rotate(0deg); }
					to { transform: rotate(360deg); }
				}
			`}</style>
		</div>
	);
}

export default AutoRunDocumentViewer;
