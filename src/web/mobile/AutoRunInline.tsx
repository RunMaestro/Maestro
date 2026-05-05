/**
 * AutoRunInline component for Maestro mobile/web interface
 *
 * Single-document Auto Run editor that mirrors the desktop AutoRun panel
 * (`src/renderer/components/AutoRun/AutoRun.tsx`) for visual + feature parity:
 * top toolbar (Run/Stop/PlayBooks/Help), document selector dropdown with
 * completion-percentage badge + refresh / + new actions, markdown preview /
 * edit textarea with task-checkbox toggling and undo/redo, find-in-document
 * search, expand button, and footer with task counts + token estimate +
 * save/revert/reset controls.
 *
 * Used by `AutoRunPanel` (full-screen overlay launched from the indicator
 * banner / left-bar quick action) and `AutoRunTabContent` in `RightDrawer`
 * (inline tab content alongside Files / History / Git).
 */

import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useThemeColors } from '../components/ThemeProvider';
import { MobileMarkdownRenderer } from './MobileMarkdownRenderer';
import { AutoRunIndicator } from './AutoRunIndicator';
import { triggerHaptic, HAPTIC_PATTERNS } from './constants';
import { useAutoRun } from '../hooks/useAutoRun';
import type { AutoRunDocument } from '../hooks/useAutoRun';
import type { AutoRunState, UseWebSocketReturn } from '../hooks/useWebSocket';
import { estimateTokenCount, formatTokens } from '../../shared/formatters';

/**
 * Doc tree node — derived client-side from the flat doc list with the
 * `folder` field. Mirrors the desktop `DocTreeNode` shape.
 */
interface DocTreeNode {
	name: string;
	type: 'file' | 'folder';
	path: string;
	children?: DocTreeNode[];
}

/** Maximum entries kept in the undo history. */
const MAX_UNDO_HISTORY = 100;
/** How often (ms) a new history snapshot is pushed during rapid typing. */
const HISTORY_SNAPSHOT_INTERVAL_MS = 350;

/**
 * Build a nested folder tree from a flat list of documents. Documents whose
 * `folder` field is empty/undefined live at the root.
 */
function buildDocTree(documents: AutoRunDocument[]): DocTreeNode[] {
	type MutableNode = DocTreeNode & { children?: DocTreeNode[] };
	const root: MutableNode = { name: '', type: 'folder', path: '', children: [] };

	const ensureFolder = (parent: MutableNode, parts: string[]): MutableNode => {
		let current = parent;
		let acc = '';
		for (const part of parts) {
			acc = acc ? `${acc}/${part}` : part;
			current.children = current.children || [];
			let next = current.children.find((c) => c.type === 'folder' && c.name === part) as
				| MutableNode
				| undefined;
			if (!next) {
				next = { name: part, type: 'folder', path: acc, children: [] };
				current.children.push(next);
			}
			current = next;
		}
		return current;
	};

	for (const doc of documents) {
		const folderParts = doc.folder ? doc.folder.split('/').filter(Boolean) : [];
		const parent = folderParts.length ? ensureFolder(root, folderParts) : root;
		parent.children = parent.children || [];
		parent.children.push({
			name: doc.filename, // basename without `.md`
			type: 'file',
			path: doc.path || doc.filename,
		});
	}

	const sortChildren = (node: MutableNode) => {
		if (!node.children) return;
		node.children.sort((a, b) => {
			if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
			return a.name.localeCompare(b.name);
		});
		for (const child of node.children) sortChildren(child as MutableNode);
	};
	sortChildren(root);

	return root.children || [];
}

export interface AutoRunInlineProps {
	sessionId: string;
	autoRunState: AutoRunState | null;
	sendRequest: UseWebSocketReturn['sendRequest'];
	send: UseWebSocketReturn['send'];
	/** Open the AutoRun setup sheet (PlayBooks + Configure & Launch). */
	onOpenSetup: () => void;
	/** Optional: open the full-screen document viewer (Expand button). */
	onExpandDocument?: (filename: string) => void;
	/**
	 * When provided, lets the inline panel surface error-pause recovery actions
	 * via the `AutoRunIndicator`. When omitted, the inline panel relies on the
	 * top-level indicator banner instead.
	 */
	onResumeAfterError?: () => Promise<unknown> | void;
	onSkipAfterError?: () => Promise<unknown> | void;
	onAbortAfterError?: () => Promise<unknown> | void;
	/**
	 * Notifies the parent when the in-panel selection changes so the launch sheet
	 * (and other consumers) can pre-fill the active doc the way desktop's
	 * BatchRunnerModal pre-fills `currentDocument`. Fires with `null` when the
	 * panel clears its selection (e.g. on session change).
	 */
	onSelectedDocumentChange?: (filename: string | null) => void;
	/**
	 * Opens a folder-picker (mirrors desktop's `dialog.selectFolder`). When
	 * omitted, the "Change folder…" affordance falls back to `onOpenSetup` for
	 * backwards compatibility.
	 */
	onOpenFolderPicker?: () => void;
}

type EditorMode = 'preview' | 'edit';

/**
 * AutoRunInline — single-document Auto Run editor with full desktop parity.
 */
export function AutoRunInline({
	sessionId,
	autoRunState,
	sendRequest,
	send,
	onOpenSetup,
	onExpandDocument,
	onResumeAfterError,
	onSkipAfterError,
	onAbortAfterError,
	onSelectedDocumentChange,
	onOpenFolderPicker,
}: AutoRunInlineProps) {
	const colors = useThemeColors();
	const {
		documents,
		isLoadingDocs,
		loadDocuments,
		saveDocumentContent,
		resetDocumentTasks,
		stopAutoRun,
	} = useAutoRun(sendRequest, send, autoRunState);

	const isRunning = autoRunState?.isRunning ?? false;
	const isStopping = autoRunState?.isStopping ?? false;
	const isErrorPaused = autoRunState?.errorPaused ?? false;

	// Persisted-by-session selection so switching tabs doesn't lose the user's spot.
	const [selectedFile, setSelectedFile] = useState<string | null>(null);
	const [savedContent, setSavedContent] = useState<string>('');
	const [localContent, setLocalContent] = useState<string>('');
	const [isLoadingDoc, setIsLoadingDoc] = useState(false);
	const [mode, setMode] = useState<EditorMode>('preview');
	const [searchOpen, setSearchOpen] = useState(false);
	const [searchQuery, setSearchQuery] = useState('');
	const [searchIndex, setSearchIndex] = useState(0);
	const [showHelp, setShowHelp] = useState(false);
	const [selectorOpen, setSelectorOpen] = useState(false);
	const [showCreate, setShowCreate] = useState(false);
	const [newDocName, setNewDocName] = useState('');
	const [isCreating, setIsCreating] = useState(false);
	const [isSaving, setIsSaving] = useState(false);
	const [isResetting, setIsResetting] = useState(false);
	const [saveMessage, setSaveMessage] = useState<{
		text: string;
		type: 'success' | 'error';
	} | null>(null);

	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const previewRef = useRef<HTMLDivElement>(null);
	const containerRef = useRef<HTMLDivElement>(null);
	const saveMessageTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Undo/redo state. Snapshots are throttled so a typing burst collapses
	// into a single undo step rather than one per keystroke.
	const undoStackRef = useRef<string[]>([]);
	const redoStackRef = useRef<string[]>([]);
	const lastSnapshotAtRef = useRef<number>(0);
	const [historyTick, setHistoryTick] = useState(0);
	const canUndo = undoStackRef.current.length > 0;
	const canRedo = redoStackRef.current.length > 0;
	void historyTick; // ensures re-render when ref-backed history changes

	// Lock state — when a run is active the document being processed is read-only.
	// We approximate desktop's `lockedDocuments` semantics by treating any active
	// run as read-only for the *currently selected* document (the desktop checks
	// the run's locked-documents list, but the web doesn't get that detail in
	// AutoRunState today; locking on isRunning is the conservative safe default).
	const isLocked = isRunning;

	const isDirty = localContent !== savedContent;
	const taskCounts = useMemo(() => countTasks(localContent), [localContent]);
	const tokenCount = useMemo(
		() => (localContent ? estimateTokenCount(localContent) : null),
		[localContent]
	);

	const documentTree = useMemo(() => buildDocTree(documents), [documents]);
	const taskCountByPath = useMemo(() => {
		const map = new Map<string, { completed: number; total: number }>();
		for (const doc of documents) {
			map.set(doc.path || doc.filename, {
				completed: doc.completedCount,
				total: doc.taskCount,
			});
		}
		// The currently-selected document's local edits should drive its own
		// completion %; the server-reported counts only update on the next refresh.
		if (selectedFile) {
			map.set(selectedFile, { completed: taskCounts.completed, total: taskCounts.total });
		}
		return map;
	}, [documents, selectedFile, taskCounts.completed, taskCounts.total]);

	// Initial load + reload when session changes.
	useEffect(() => {
		void loadDocuments(sessionId);
		setSelectedFile(null);
		setSavedContent('');
		setLocalContent('');
		setMode('preview');
		undoStackRef.current = [];
		redoStackRef.current = [];
	}, [sessionId, loadDocuments]);

	// Auto-pick the first document when the list loads (matches desktop UX).
	useEffect(() => {
		if (selectedFile || documents.length === 0) return;
		setSelectedFile(documents[0].path || documents[0].filename);
	}, [documents, selectedFile]);

	// Notify the parent on selection changes so the launch sheet can pre-fill
	// the active doc — desktop parity for `BatchRunnerModal`'s `currentDocument`.
	useEffect(() => {
		onSelectedDocumentChange?.(selectedFile);
	}, [selectedFile, onSelectedDocumentChange]);

	// Save toast helper — declared early so the document-load effect below can
	// surface load failures without falling into a TDZ.
	const showSaveMessage = useCallback((text: string, type: 'success' | 'error') => {
		setSaveMessage({ text, type });
		if (saveMessageTimerRef.current) clearTimeout(saveMessageTimerRef.current);
		saveMessageTimerRef.current = setTimeout(() => setSaveMessage(null), 2500);
	}, []);

	// Load content whenever the selected file changes.
	useEffect(() => {
		if (!selectedFile) return;
		let cancelled = false;
		setIsLoadingDoc(true);
		(async () => {
			try {
				const response = await sendRequest<{ content?: string }>('get_auto_run_document', {
					sessionId,
					filename: `${selectedFile}.md`,
				});
				if (cancelled) return;
				const next = response.content ?? '';
				setSavedContent(next);
				setLocalContent(next);
				undoStackRef.current = [];
				redoStackRef.current = [];
				setHistoryTick((t) => t + 1);
			} catch (err) {
				if (cancelled) return;
				// Don't clear the buffers on transient failure — wiping a valid
				// in-memory document on a network hiccup creates an
				// accidental-overwrite path. Surface the error and keep what we have.
				console.error('[AutoRunInline] get_auto_run_document failed', err);
				showSaveMessage('Failed to load document', 'error');
			} finally {
				if (!cancelled) setIsLoadingDoc(false);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [sessionId, selectedFile, sendRequest, showSaveMessage]);

	// Auto-switch to preview when a run starts; remember the previous mode and
	// restore it when the run ends (matches desktop AutoRun.tsx behaviour).
	const modeBeforeRunRef = useRef<EditorMode | null>(null);
	useEffect(() => {
		if (isLocked) {
			if (modeBeforeRunRef.current === null) {
				modeBeforeRunRef.current = mode;
			}
			if (mode !== 'preview') setMode('preview');
		} else if (modeBeforeRunRef.current !== null) {
			setMode(modeBeforeRunRef.current);
			modeBeforeRunRef.current = null;
		}
	}, [isLocked, mode]);

	// Cleanup the save toast timer on unmount.
	useEffect(
		() => () => {
			if (saveMessageTimerRef.current) clearTimeout(saveMessageTimerRef.current);
		},
		[]
	);

	const pushHistory = useCallback((value: string) => {
		undoStackRef.current.push(value);
		if (undoStackRef.current.length > MAX_UNDO_HISTORY) undoStackRef.current.shift();
		redoStackRef.current = [];
		setHistoryTick((t) => t + 1);
	}, []);

	const handleContentChange = useCallback(
		(e: React.ChangeEvent<HTMLTextAreaElement>) => {
			if (isLocked) return;
			const next = e.target.value;
			const now = Date.now();
			if (now - lastSnapshotAtRef.current >= HISTORY_SNAPSHOT_INTERVAL_MS) {
				pushHistory(localContent);
				lastSnapshotAtRef.current = now;
			}
			setLocalContent(next);
		},
		[isLocked, localContent, pushHistory]
	);

	const handleUndo = useCallback(() => {
		if (undoStackRef.current.length === 0) return;
		const previous = undoStackRef.current.pop();
		if (previous === undefined) return;
		redoStackRef.current.push(localContent);
		if (redoStackRef.current.length > MAX_UNDO_HISTORY) redoStackRef.current.shift();
		setLocalContent(previous);
		setHistoryTick((t) => t + 1);
		lastSnapshotAtRef.current = 0;
	}, [localContent]);

	const handleRedo = useCallback(() => {
		if (redoStackRef.current.length === 0) return;
		const next = redoStackRef.current.pop();
		if (next === undefined) return;
		undoStackRef.current.push(localContent);
		if (undoStackRef.current.length > MAX_UNDO_HISTORY) undoStackRef.current.shift();
		setLocalContent(next);
		setHistoryTick((t) => t + 1);
		lastSnapshotAtRef.current = 0;
	}, [localContent]);

	const handleSave = useCallback(async () => {
		if (!selectedFile || isSaving || isLocked) return;
		setIsSaving(true);
		try {
			const success = await saveDocumentContent(sessionId, `${selectedFile}.md`, localContent);
			if (success) {
				setSavedContent(localContent);
				triggerHaptic(HAPTIC_PATTERNS.success);
				showSaveMessage('Saved', 'success');
				// Refresh document list so completion % reflects the new state.
				void loadDocuments(sessionId);
			} else {
				triggerHaptic(HAPTIC_PATTERNS.error);
				showSaveMessage('Save failed', 'error');
			}
		} catch (err) {
			console.error('[AutoRunInline] save failed', err);
			triggerHaptic(HAPTIC_PATTERNS.error);
			showSaveMessage('Save failed', 'error');
		} finally {
			setIsSaving(false);
		}
	}, [
		selectedFile,
		isSaving,
		isLocked,
		saveDocumentContent,
		sessionId,
		localContent,
		showSaveMessage,
		loadDocuments,
	]);

	const handleRevert = useCallback(() => {
		setLocalContent(savedContent);
		undoStackRef.current = [];
		redoStackRef.current = [];
		setHistoryTick((t) => t + 1);
	}, [savedContent]);

	const handleReset = useCallback(async () => {
		if (!selectedFile || taskCounts.completed === 0 || isLocked) return;
		const confirmed = window.confirm(
			`Reset ${taskCounts.completed} completed task${taskCounts.completed !== 1 ? 's' : ''} in "${selectedFile}"?`
		);
		if (!confirmed) return;
		setIsResetting(true);
		try {
			pushHistory(localContent);
			const reset = localContent.replace(/^([\s]*[-*]\s*)\[x\]/gim, '$1[ ]');
			setLocalContent(reset);
			const success = await saveDocumentContent(sessionId, `${selectedFile}.md`, reset);
			if (success) {
				setSavedContent(reset);
				triggerHaptic(HAPTIC_PATTERNS.success);
				showSaveMessage('Tasks reset', 'success');
				void loadDocuments(sessionId);
			} else {
				// Surface failure but keep the local edit so user can retry / revert.
				triggerHaptic(HAPTIC_PATTERNS.error);
				showSaveMessage('Reset failed (server)', 'error');
				// Server-side reset endpoint as fallback.
				const serverReset = await resetDocumentTasks(sessionId, `${selectedFile}.md`);
				if (serverReset) {
					// Server already wrote the reset; keep local + savedContent in sync
					// so isDirty doesn't show stale "unsaved changes" and Revert
					// doesn't restore the old checked-task content.
					setSavedContent(reset);
					await loadDocuments(sessionId);
				}
			}
		} catch (err) {
			console.error('[AutoRunInline] reset failed', err);
			triggerHaptic(HAPTIC_PATTERNS.error);
			showSaveMessage('Reset failed', 'error');
		} finally {
			setIsResetting(false);
		}
	}, [
		selectedFile,
		taskCounts.completed,
		isLocked,
		pushHistory,
		localContent,
		saveDocumentContent,
		sessionId,
		showSaveMessage,
		loadDocuments,
		resetDocumentTasks,
	]);

	const handleSelectDocument = useCallback(
		(filePath: string) => {
			if (isDirty && filePath !== selectedFile) {
				const confirmed = window.confirm('You have unsaved changes. Discard and switch documents?');
				if (!confirmed) return;
			}
			setSelectedFile(filePath);
			setSelectorOpen(false);
			setMode('preview');
		},
		[isDirty, selectedFile]
	);

	const handleRefresh = useCallback(() => {
		triggerHaptic(HAPTIC_PATTERNS.tap);
		void loadDocuments(sessionId);
	}, [sessionId, loadDocuments]);

	const handleStop = useCallback(() => {
		if (!isRunning) return;
		triggerHaptic(HAPTIC_PATTERNS.interrupt);
		void stopAutoRun(sessionId);
	}, [isRunning, sessionId, stopAutoRun]);

	// Toggle a single GFM task checkbox in the saved content (preview clicks).
	// `index` is the zero-based index of the task across the whole document.
	const handleToggleTaskAt = useCallback(
		async (index: number) => {
			if (!selectedFile || isLocked) return;
			let counter = 0;
			let mutated = false;
			const next = localContent.replace(/^([\s]*[-*]\s*)\[( |x)\]/gim, (match, prefix, mark) => {
				const matched = counter === index;
				counter += 1;
				if (!matched) return match;
				mutated = true;
				const flipped = mark.toLowerCase() === 'x' ? ' ' : 'x';
				return `${prefix}[${flipped}]`;
			});
			if (!mutated) return;
			pushHistory(localContent);
			setLocalContent(next);
			// Auto-save checkbox toggles so the file on disk stays in sync.
			try {
				const success = await saveDocumentContent(sessionId, `${selectedFile}.md`, next);
				if (success) {
					setSavedContent(next);
					triggerHaptic(HAPTIC_PATTERNS.tap);
					void loadDocuments(sessionId);
				}
			} catch (err) {
				// Leave the local edit so the user can save manually.
				console.error('[AutoRunInline] auto-save on toggle failed', err);
			}
		},
		[
			selectedFile,
			isLocked,
			localContent,
			pushHistory,
			saveDocumentContent,
			sessionId,
			loadDocuments,
		]
	);

	const handleCreateDocument = useCallback(async () => {
		const trimmed = newDocName.trim();
		if (!trimmed || isCreating) return;
		const normalized = trimmed.toLowerCase().endsWith('.md') ? trimmed : `${trimmed}.md`;
		const docPathNoExt = normalized.replace(/\.md$/i, '');
		if (
			documents.some((d) => (d.path || d.filename).toLowerCase() === docPathNoExt.toLowerCase())
		) {
			return;
		}
		setIsCreating(true);
		try {
			const success = await saveDocumentContent(sessionId, normalized, '');
			if (success) {
				await loadDocuments(sessionId);
				setSelectedFile(docPathNoExt);
				setMode('edit');
				setShowCreate(false);
				setNewDocName('');
				triggerHaptic(HAPTIC_PATTERNS.success);
			} else {
				triggerHaptic(HAPTIC_PATTERNS.error);
				showSaveMessage('Could not create document', 'error');
			}
		} catch (err) {
			console.error('[AutoRunInline] create document failed', err);
			triggerHaptic(HAPTIC_PATTERNS.error);
			showSaveMessage('Could not create document', 'error');
		} finally {
			setIsCreating(false);
		}
	}, [
		newDocName,
		isCreating,
		documents,
		saveDocumentContent,
		sessionId,
		loadDocuments,
		showSaveMessage,
	]);

	// Search match positions (case-insensitive substring) in the live content.
	const displayContent = localContent;
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

	useEffect(() => {
		setSearchIndex(0);
	}, [searchMatches]);

	const focusActiveMatch = useCallback(
		(matchIdx: number) => {
			if (searchMatches.length === 0) return;
			const wrapped =
				((matchIdx % searchMatches.length) + searchMatches.length) % searchMatches.length;
			const start = searchMatches[wrapped];
			const end = start + searchQuery.length;
			setSearchIndex(wrapped);
			if (mode === 'edit' && textareaRef.current) {
				const ta = textareaRef.current;
				ta.focus();
				ta.setSelectionRange(start, end);
				const before = displayContent.slice(0, start);
				const lineNumber = before.split('\n').length - 1;
				const lineHeight = 22;
				ta.scrollTop = Math.max(0, lineNumber * lineHeight - ta.clientHeight / 2);
			}
		},
		[displayContent, mode, searchMatches, searchQuery.length]
	);

	const handleSearchNext = useCallback(() => {
		focusActiveMatch(searchIndex + 1);
	}, [focusActiveMatch, searchIndex]);
	const handleSearchPrev = useCallback(() => {
		focusActiveMatch(searchIndex - 1);
	}, [focusActiveMatch, searchIndex]);

	// Keyboard shortcuts within the inline panel.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const meta = e.metaKey || e.ctrlKey;
			if (e.key === 'Escape') {
				if (showCreate) {
					setShowCreate(false);
					setNewDocName('');
					return;
				}
				if (searchOpen) {
					setSearchOpen(false);
					setSearchQuery('');
					return;
				}
				if (selectorOpen) {
					setSelectorOpen(false);
					return;
				}
				if (showHelp) {
					setShowHelp(false);
					return;
				}
				return;
			}
			// Only intercept Cmd/Ctrl shortcuts when our container is focused or has focus inside.
			if (!meta) return;
			const target = e.target as HTMLElement | null;
			const inOurContainer =
				containerRef.current && target && containerRef.current.contains(target);
			if (!inOurContainer) return;

			if (e.key === 's' && isDirty && !isLocked && mode === 'edit') {
				e.preventDefault();
				void handleSave();
				return;
			}
			if (e.key === 'f' && !e.shiftKey) {
				e.preventDefault();
				setSearchOpen(true);
				return;
			}
			if (e.key === 'e' && !e.shiftKey) {
				e.preventDefault();
				if (!isLocked) {
					setMode((m) => (m === 'edit' ? 'preview' : 'edit'));
				}
				return;
			}
			if (e.key === 'z' && mode === 'edit') {
				e.preventDefault();
				if (e.shiftKey) handleRedo();
				else handleUndo();
				return;
			}
			if (e.key === 'y' && mode === 'edit') {
				e.preventDefault();
				handleRedo();
			}
		};
		document.addEventListener('keydown', onKey);
		return () => document.removeEventListener('keydown', onKey);
	}, [
		searchOpen,
		selectorOpen,
		showCreate,
		showHelp,
		isDirty,
		isLocked,
		mode,
		handleSave,
		handleRedo,
		handleUndo,
	]);

	const selectedTaskPercent = selectedFile
		? getTaskPercent(taskCountByPath.get(selectedFile))
		: null;

	// Empty-state handling for the inline panel.
	if (isLoadingDocs && documents.length === 0) {
		return (
			<div
				ref={containerRef}
				style={{
					height: '100%',
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'center',
					padding: '40px 20px',
					color: colors.textDim,
					fontSize: '14px',
				}}
			>
				Loading documents...
			</div>
		);
	}

	if (!isLoadingDocs && documents.length === 0) {
		return (
			<div
				ref={containerRef}
				style={{
					display: 'flex',
					flexDirection: 'column',
					height: '100%',
					gap: '16px',
					padding: '16px',
				}}
			>
				<Toolbar
					colors={colors}
					isRunning={isRunning}
					isStopping={isStopping}
					onRun={onOpenSetup}
					onStop={handleStop}
					onPlayBooks={onOpenSetup}
					onHelp={() => setShowHelp(true)}
				/>
				<div
					style={{
						flex: 1,
						display: 'flex',
						flexDirection: 'column',
						alignItems: 'center',
						justifyContent: 'center',
						textAlign: 'center',
						gap: '8px',
					}}
				>
					<p style={{ fontSize: '15px', color: colors.textMain, margin: 0 }}>
						No Auto Run documents found
					</p>
					<p style={{ fontSize: '13px', color: colors.textDim, margin: 0 }}>
						Add markdown files to{' '}
						<code
							style={{
								fontSize: '12px',
								backgroundColor: `${colors.textDim}15`,
								padding: '2px 4px',
								borderRadius: '3px',
							}}
						>
							.maestro/playbooks/
						</code>
					</p>
					<button
						onClick={() => setShowCreate(true)}
						style={{
							marginTop: '8px',
							padding: '10px 16px',
							borderRadius: '8px',
							border: `1px solid ${colors.accent}`,
							backgroundColor: `${colors.accent}15`,
							color: colors.accent,
							fontSize: '13px',
							fontWeight: 600,
							cursor: 'pointer',
						}}
					>
						+ Create document
					</button>
				</div>
				{showHelp && <HelpSheet colors={colors} onClose={() => setShowHelp(false)} />}
				{showCreate && (
					<CreateDocSheet
						colors={colors}
						value={newDocName}
						onChange={setNewDocName}
						onCancel={() => {
							setShowCreate(false);
							setNewDocName('');
						}}
						onSubmit={handleCreateDocument}
						isSubmitting={isCreating}
						existingPaths={documents.map((d) => d.path || d.filename)}
					/>
				)}
			</div>
		);
	}

	return (
		<div
			ref={containerRef}
			style={{
				display: 'flex',
				flexDirection: 'column',
				height: '100%',
				minHeight: 0,
				backgroundColor: colors.bgMain,
			}}
		>
			{/* Top toolbar — Run/Stop, PlayBooks, Help */}
			<div style={{ padding: '8px 8px 0 8px', flexShrink: 0 }}>
				<Toolbar
					colors={colors}
					isRunning={isRunning}
					isStopping={isStopping}
					onRun={onOpenSetup}
					onStop={handleStop}
					onPlayBooks={onOpenSetup}
					onHelp={() => setShowHelp(true)}
				/>
			</div>

			{/* Document selector + actions row */}
			<div style={{ padding: '8px', flexShrink: 0 }}>
				<DocumentSelector
					colors={colors}
					tree={documentTree}
					selectedFile={selectedFile}
					selectedPercent={selectedTaskPercent}
					taskCountByPath={taskCountByPath}
					isOpen={selectorOpen}
					onToggleOpen={() => setSelectorOpen((v) => !v)}
					onClose={() => setSelectorOpen(false)}
					onSelect={handleSelectDocument}
					onRefresh={handleRefresh}
					onCreateDocument={() => setShowCreate(true)}
					onChangeFolder={onOpenFolderPicker ?? onOpenSetup}
					isLoading={isLoadingDocs}
				/>
			</div>

			{/* Error pause banner — uses the existing AutoRunIndicator's recovery UI
				when the consumer wires resume / skip / abort handlers. */}
			{isErrorPaused && (onResumeAfterError || onSkipAfterError || onAbortAfterError) && (
				<div style={{ padding: '0 8px 8px 8px', flexShrink: 0 }}>
					<AutoRunIndicator
						state={autoRunState}
						onResume={onResumeAfterError}
						onSkipDocument={onSkipAfterError}
						onAbort={onAbortAfterError}
					/>
				</div>
			)}

			{/* Save toast */}
			{saveMessage && (
				<div
					style={{
						margin: '0 8px 8px 8px',
						padding: '6px 12px',
						borderRadius: '6px',
						backgroundColor:
							saveMessage.type === 'success' ? `${colors.success}20` : `${colors.error}20`,
						color: saveMessage.type === 'success' ? colors.success : colors.error,
						fontSize: '12px',
						textAlign: 'center',
						flexShrink: 0,
					}}
				>
					{saveMessage.text}
				</div>
			)}

			{/* Search bar */}
			{searchOpen && (
				<div style={{ padding: '0 8px 8px 8px', flexShrink: 0 }}>
					<SearchBar
						colors={colors}
						value={searchQuery}
						onChange={setSearchQuery}
						matches={searchMatches.length}
						currentIndex={searchIndex}
						onNext={handleSearchNext}
						onPrev={handleSearchPrev}
						onClose={() => {
							setSearchOpen(false);
							setSearchQuery('');
						}}
					/>
				</div>
			)}

			{/* Content area */}
			<div
				style={{
					flex: 1,
					minHeight: 0,
					overflow: 'auto',
					margin: '0 8px',
					borderRadius: '6px',
					border: `2px solid ${isDirty && !isLocked ? `${colors.warning}40` : 'transparent'}`,
					backgroundColor: isDirty && !isLocked ? `${colors.warning}08` : 'transparent',
				}}
			>
				{isLoadingDoc ? (
					<div
						style={{
							display: 'flex',
							alignItems: 'center',
							justifyContent: 'center',
							padding: '40px',
							color: colors.textDim,
							fontSize: '13px',
						}}
					>
						Loading document...
					</div>
				) : !selectedFile ? (
					<div
						style={{
							display: 'flex',
							alignItems: 'center',
							justifyContent: 'center',
							padding: '40px',
							color: colors.textDim,
							fontSize: '13px',
						}}
					>
						Select a document to begin.
					</div>
				) : mode === 'edit' ? (
					<textarea
						ref={textareaRef}
						value={localContent}
						onChange={handleContentChange}
						readOnly={isLocked}
						placeholder="Capture notes and tasks in Markdown."
						style={{
							width: '100%',
							height: '100%',
							boxSizing: 'border-box',
							padding: '12px',
							border: 'none',
							outline: 'none',
							resize: 'none',
							backgroundColor: 'transparent',
							color: colors.textMain,
							fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
							fontSize: '13px',
							lineHeight: 1.55,
							WebkitAppearance: 'none',
							cursor: isLocked ? 'not-allowed' : 'text',
							opacity: isLocked ? 0.7 : 1,
						}}
						spellCheck={false}
					/>
				) : (
					<div ref={previewRef} style={{ padding: '12px' }}>
						<TaskAwareMarkdown
							content={localContent || '*No content yet. Switch to Edit mode to start writing.*'}
							onToggleTask={handleToggleTaskAt}
							isLocked={isLocked}
						/>
					</div>
				)}
			</div>

			{/* Bottom action bar — Expand / Search / Edit-toggle */}
			{selectedFile && (
				<div
					style={{
						display: 'flex',
						gap: '6px',
						padding: '6px 8px',
						flexShrink: 0,
					}}
				>
					{onExpandDocument && (
						<ActionButton
							colors={colors}
							onClick={() => onExpandDocument(selectedFile)}
							title="Expand to full screen"
						>
							<MaximizeIcon />
							Expand
						</ActionButton>
					)}
					<ActionButton colors={colors} onClick={() => setSearchOpen(true)} title="Search (Cmd+F)">
						<SearchIcon />
						Search
					</ActionButton>
					<ActionButton
						colors={colors}
						onClick={() => {
							if (mode === 'edit') setMode('preview');
							else if (!isLocked) setMode('edit');
						}}
						disabled={mode === 'preview' && isLocked}
						title={
							mode === 'edit'
								? 'Switch to preview'
								: isLocked
									? 'Editing disabled while Auto Run active'
									: 'Switch to edit'
						}
					>
						{mode === 'edit' ? (
							<>
								<EyeIcon />
								Preview
							</>
						) : (
							<>
								<EditIcon />
								Edit
							</>
						)}
					</ActionButton>
				</div>
			)}

			{/* Footer — task count + token estimate + save / revert / reset */}
			{selectedFile && (taskCounts.total > 0 || (isDirty && !isLocked) || tokenCount !== null) && (
				<Footer
					colors={colors}
					taskCounts={taskCounts}
					tokenCount={tokenCount}
					isDirty={isDirty}
					isLocked={isLocked}
					isSaving={isSaving}
					isResetting={isResetting}
					canUndo={canUndo}
					canRedo={canRedo}
					mode={mode}
					onSave={handleSave}
					onRevert={handleRevert}
					onReset={handleReset}
					onUndo={handleUndo}
					onRedo={handleRedo}
				/>
			)}

			{showHelp && <HelpSheet colors={colors} onClose={() => setShowHelp(false)} />}

			{showCreate && (
				<CreateDocSheet
					colors={colors}
					value={newDocName}
					onChange={setNewDocName}
					onCancel={() => {
						setShowCreate(false);
						setNewDocName('');
					}}
					onSubmit={handleCreateDocument}
					isSubmitting={isCreating}
					existingPaths={documents.map((d) => d.path || d.filename)}
				/>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function countTasks(content: string): { completed: number; total: number } {
	const totalRegex = /^[\s]*[-*]\s*\[( |x)\]/gim;
	const completedRegex = /^[\s]*[-*]\s*\[x\]/gim;
	const total = (content.match(totalRegex) || []).length;
	const completed = (content.match(completedRegex) || []).length;
	return { total, completed };
}

function getTaskPercent(counts?: { completed: number; total: number }): number | null {
	if (!counts || counts.total === 0) return null;
	return Math.round((counts.completed / counts.total) * 100);
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface ToolbarProps {
	colors: ReturnType<typeof useThemeColors>;
	isRunning: boolean;
	isStopping: boolean;
	onRun: () => void;
	onStop: () => void;
	onPlayBooks: () => void;
	onHelp: () => void;
}

function Toolbar({
	colors,
	isRunning,
	isStopping,
	onRun,
	onStop,
	onPlayBooks,
	onHelp,
}: ToolbarProps) {
	const ghostStyle: React.CSSProperties = {
		flex: 1,
		minHeight: '40px',
		padding: '8px 6px',
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		gap: '6px',
		borderRadius: '6px',
		fontSize: '12px',
		fontWeight: 600,
		backgroundColor: `${colors.accent}15`,
		color: colors.accent,
		border: `1px solid ${colors.accent}40`,
		cursor: 'pointer',
		touchAction: 'manipulation',
		WebkitTapHighlightColor: 'transparent',
	};

	return (
		<div style={{ display: 'flex', gap: '6px' }}>
			{isRunning ? (
				<button
					onClick={onStop}
					disabled={isStopping}
					style={{
						...ghostStyle,
						backgroundColor: isStopping ? colors.warning : colors.error,
						color: 'white',
						border: `1px solid ${isStopping ? colors.warning : colors.error}`,
						cursor: isStopping ? 'not-allowed' : 'pointer',
						opacity: isStopping ? 0.7 : 1,
					}}
					aria-label="Stop Auto Run"
				>
					<StopIcon />
					{isStopping ? 'Stopping' : 'Stop'}
				</button>
			) : (
				<button onClick={onRun} style={ghostStyle} aria-label="Configure and launch Auto Run">
					<PlayIcon />
					Run
				</button>
			)}
			<button onClick={onPlayBooks} style={ghostStyle} aria-label="Open PlayBooks setup">
				<BooksIcon />
				PlayBooks
			</button>
			<button onClick={onHelp} style={ghostStyle} aria-label="Open Auto Run help">
				<HelpIcon />
				Help
			</button>
		</div>
	);
}

interface DocumentSelectorProps {
	colors: ReturnType<typeof useThemeColors>;
	tree: DocTreeNode[];
	selectedFile: string | null;
	selectedPercent: number | null;
	taskCountByPath: Map<string, { completed: number; total: number }>;
	isOpen: boolean;
	onToggleOpen: () => void;
	onClose: () => void;
	onSelect: (filePath: string) => void;
	onRefresh: () => void;
	onCreateDocument: () => void;
	onChangeFolder: () => void;
	isLoading: boolean;
}

function DocumentSelector({
	colors,
	tree,
	selectedFile,
	selectedPercent,
	taskCountByPath,
	isOpen,
	onToggleOpen,
	onClose,
	onSelect,
	onRefresh,
	onCreateDocument,
	onChangeFolder,
	isLoading,
}: DocumentSelectorProps) {
	const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
	const containerRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!isOpen) return;
		const onDown = (e: MouseEvent | TouchEvent) => {
			if (!containerRef.current) return;
			if (!containerRef.current.contains(e.target as Node)) {
				onClose();
			}
		};
		document.addEventListener('mousedown', onDown);
		document.addEventListener('touchstart', onDown);
		return () => {
			document.removeEventListener('mousedown', onDown);
			document.removeEventListener('touchstart', onDown);
		};
	}, [isOpen, onClose]);

	useEffect(() => {
		if (!isOpen || !selectedFile || !selectedFile.includes('/')) return;
		const parts = selectedFile.split('/');
		setExpandedFolders((prev) => {
			const next = new Set(prev);
			for (let i = 1; i < parts.length; i++) {
				next.add(parts.slice(0, i).join('/'));
			}
			return next;
		});
	}, [isOpen, selectedFile]);

	const toggleFolder = useCallback((path: string) => {
		setExpandedFolders((prev) => {
			const next = new Set(prev);
			if (next.has(path)) next.delete(path);
			else next.add(path);
			return next;
		});
	}, []);

	const renderNode = useCallback(
		(node: DocTreeNode, depth: number): React.ReactNode => {
			const padding = depth * 14 + 10;
			if (node.type === 'folder') {
				const expanded = expandedFolders.has(node.path);
				return (
					<div key={`folder:${node.path}`}>
						<button
							onClick={() => toggleFolder(node.path)}
							style={{
								width: '100%',
								display: 'flex',
								alignItems: 'center',
								gap: '6px',
								padding: `8px 8px 8px ${padding}px`,
								background: 'transparent',
								border: 'none',
								color: colors.textDim,
								fontSize: '13px',
								cursor: 'pointer',
								textAlign: 'left',
							}}
						>
							<span style={{ fontSize: '10px' }}>{expanded ? '▼' : '▶'}</span>
							<span style={{ color: colors.accent }}>📁</span>
							<span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
								{node.name}
							</span>
						</button>
						{expanded &&
							node.children &&
							node.children.map((child) => renderNode(child, depth + 1))}
					</div>
				);
			}
			const isSelected = node.path === selectedFile;
			const counts = taskCountByPath.get(node.path);
			const pct = getTaskPercent(counts);
			return (
				<button
					key={`file:${node.path}`}
					onClick={() => onSelect(node.path)}
					data-selected={isSelected || undefined}
					style={{
						width: '100%',
						display: 'flex',
						alignItems: 'center',
						gap: '8px',
						padding: `8px 8px 8px ${padding}px`,
						backgroundColor: isSelected ? colors.bgActivity : 'transparent',
						border: 'none',
						color: isSelected ? colors.accent : colors.textMain,
						fontSize: '13px',
						cursor: 'pointer',
						textAlign: 'left',
					}}
				>
					<span style={{ width: '10px', flexShrink: 0 }} />
					<span style={{ color: colors.textDim }}>📄</span>
					<span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
						{node.name}.md
					</span>
					{pct !== null && <PercentBadge colors={colors} percent={pct} />}
				</button>
			);
		},
		[colors, expandedFolders, onSelect, selectedFile, taskCountByPath, toggleFolder]
	);

	return (
		<div
			ref={containerRef}
			style={{ position: 'relative', display: 'flex', gap: '6px', alignItems: 'stretch' }}
		>
			<button
				onClick={onToggleOpen}
				style={{
					flex: 1,
					minWidth: 0,
					minHeight: '40px',
					padding: '8px 12px',
					display: 'flex',
					alignItems: 'center',
					gap: '8px',
					borderRadius: '6px',
					backgroundColor: colors.bgActivity,
					color: colors.textMain,
					border: `1px solid ${colors.border}`,
					fontSize: '13px',
					cursor: 'pointer',
					touchAction: 'manipulation',
					WebkitTapHighlightColor: 'transparent',
				}}
				aria-haspopup="listbox"
				aria-expanded={isOpen}
			>
				{selectedPercent !== null && <PercentBadge colors={colors} percent={selectedPercent} />}
				<span
					style={{
						flex: 1,
						minWidth: 0,
						overflow: 'hidden',
						textOverflow: 'ellipsis',
						whiteSpace: 'nowrap',
						textAlign: 'left',
					}}
				>
					{selectedFile ? `${selectedFile}.md` : 'Select a document...'}
				</span>
				<span style={{ color: colors.textDim, fontSize: '10px' }}>{isOpen ? '▲' : '▼'}</span>
			</button>
			<IconButton
				colors={colors}
				onClick={onCreateDocument}
				aria-label="Create new document"
				title="Create new document"
			>
				<PlusIcon />
			</IconButton>
			<IconButton
				colors={colors}
				onClick={onRefresh}
				aria-label="Refresh document list"
				title="Refresh document list"
				disabled={isLoading}
			>
				<RefreshIcon spinning={isLoading} />
			</IconButton>
			<IconButton
				colors={colors}
				onClick={onChangeFolder}
				aria-label="Change Auto Run folder"
				title="Change Auto Run folder"
			>
				<FolderIcon />
			</IconButton>

			{isOpen && (
				<div
					style={{
						position: 'absolute',
						top: 'calc(100% + 4px)',
						left: 0,
						right: 0,
						maxHeight: '320px',
						overflowY: 'auto',
						backgroundColor: colors.bgSidebar,
						border: `1px solid ${colors.border}`,
						borderRadius: '6px',
						boxShadow: '0 6px 16px rgba(0,0,0,0.18)',
						zIndex: 60,
					}}
					role="listbox"
				>
					{tree.length === 0 ? (
						<div style={{ padding: '12px', fontSize: '13px', color: colors.textDim }}>
							No markdown files found
						</div>
					) : (
						tree.map((node) => renderNode(node, 0))
					)}
					<div style={{ borderTop: `1px solid ${colors.border}`, padding: '6px 0' }}>
						<button
							onClick={() => {
								onToggleOpen();
								onChangeFolder();
							}}
							style={{
								width: '100%',
								display: 'flex',
								alignItems: 'center',
								gap: '8px',
								padding: '10px',
								background: 'transparent',
								border: 'none',
								color: colors.textDim,
								fontSize: '13px',
								cursor: 'pointer',
								textAlign: 'left',
							}}
						>
							<FolderIcon />
							Change folder...
						</button>
					</div>
				</div>
			)}
		</div>
	);
}

interface PercentBadgeProps {
	colors: ReturnType<typeof useThemeColors>;
	percent: number;
}

function PercentBadge({ colors, percent }: PercentBadgeProps) {
	const isComplete = percent === 100;
	return (
		<span
			style={{
				flexShrink: 0,
				fontSize: '11px',
				fontWeight: 600,
				padding: '2px 6px',
				borderRadius: '4px',
				backgroundColor: isComplete ? colors.success : colors.accentDim,
				color: isComplete ? '#000' : colors.accent,
			}}
		>
			{percent}%
		</span>
	);
}

interface IconButtonProps {
	colors: ReturnType<typeof useThemeColors>;
	onClick: () => void;
	children: React.ReactNode;
	disabled?: boolean;
	'aria-label'?: string;
	title?: string;
}

function IconButton({
	colors,
	onClick,
	children,
	disabled,
	'aria-label': ariaLabel,
	title,
}: IconButtonProps) {
	return (
		<button
			onClick={onClick}
			disabled={disabled}
			aria-label={ariaLabel}
			title={title}
			style={{
				flexShrink: 0,
				width: '40px',
				minHeight: '40px',
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'center',
				borderRadius: '6px',
				backgroundColor: colors.bgActivity,
				color: colors.textDim,
				border: `1px solid ${colors.border}`,
				cursor: disabled ? 'not-allowed' : 'pointer',
				opacity: disabled ? 0.5 : 1,
				touchAction: 'manipulation',
				WebkitTapHighlightColor: 'transparent',
			}}
		>
			{children}
		</button>
	);
}

interface ActionButtonProps {
	colors: ReturnType<typeof useThemeColors>;
	onClick: () => void;
	children: React.ReactNode;
	disabled?: boolean;
	title?: string;
}

function ActionButton({ colors, onClick, children, disabled, title }: ActionButtonProps) {
	return (
		<button
			onClick={onClick}
			disabled={disabled}
			title={title}
			style={{
				flex: 1,
				minHeight: '36px',
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'center',
				gap: '6px',
				padding: '6px 8px',
				borderRadius: '6px',
				backgroundColor: `${colors.accent}15`,
				color: colors.accent,
				border: `1px solid ${colors.accent}40`,
				fontSize: '12px',
				fontWeight: 600,
				cursor: disabled ? 'not-allowed' : 'pointer',
				opacity: disabled ? 0.5 : 1,
				touchAction: 'manipulation',
				WebkitTapHighlightColor: 'transparent',
			}}
		>
			{children}
		</button>
	);
}

interface SearchBarProps {
	colors: ReturnType<typeof useThemeColors>;
	value: string;
	onChange: (next: string) => void;
	matches: number;
	currentIndex: number;
	onNext: () => void;
	onPrev: () => void;
	onClose: () => void;
}

function SearchBar({
	colors,
	value,
	onChange,
	matches,
	currentIndex,
	onNext,
	onPrev,
	onClose,
}: SearchBarProps) {
	const inputRef = useRef<HTMLInputElement>(null);
	useEffect(() => {
		inputRef.current?.focus();
	}, []);
	return (
		<div
			style={{
				display: 'flex',
				alignItems: 'center',
				gap: '6px',
				padding: '6px 10px',
				borderRadius: '6px',
				backgroundColor: colors.bgActivity,
				border: `1px solid ${colors.accent}`,
			}}
		>
			<SearchIcon />
			<input
				ref={inputRef}
				type="text"
				value={value}
				onChange={(e) => onChange(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === 'Enter') {
						e.preventDefault();
						if (e.shiftKey) onPrev();
						else onNext();
					}
				}}
				placeholder="Find in document..."
				style={{
					flex: 1,
					padding: '6px 8px',
					border: 'none',
					outline: 'none',
					backgroundColor: 'transparent',
					color: colors.textMain,
					fontSize: '13px',
				}}
			/>
			<span
				style={{ fontSize: '11px', color: colors.textDim, minWidth: '50px', textAlign: 'right' }}
			>
				{value.trim() ? (matches > 0 ? `${currentIndex + 1}/${matches}` : 'No matches') : '—'}
			</span>
			<button
				onClick={onPrev}
				disabled={matches === 0}
				aria-label="Previous match"
				style={iconBtnStyle(colors, matches === 0)}
			>
				▲
			</button>
			<button
				onClick={onNext}
				disabled={matches === 0}
				aria-label="Next match"
				style={iconBtnStyle(colors, matches === 0)}
			>
				▼
			</button>
			<button onClick={onClose} aria-label="Close search" style={iconBtnStyle(colors, false)}>
				✕
			</button>
		</div>
	);
}

function iconBtnStyle(
	colors: ReturnType<typeof useThemeColors>,
	disabled: boolean
): React.CSSProperties {
	return {
		width: '28px',
		height: '28px',
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		borderRadius: '4px',
		border: `1px solid ${colors.border}`,
		backgroundColor: 'transparent',
		color: colors.textDim,
		cursor: disabled ? 'not-allowed' : 'pointer',
		opacity: disabled ? 0.4 : 1,
		fontSize: '12px',
	};
}

interface FooterProps {
	colors: ReturnType<typeof useThemeColors>;
	taskCounts: { completed: number; total: number };
	tokenCount: number | null;
	isDirty: boolean;
	isLocked: boolean;
	isSaving: boolean;
	isResetting: boolean;
	canUndo: boolean;
	canRedo: boolean;
	mode: EditorMode;
	onSave: () => void;
	onRevert: () => void;
	onReset: () => void;
	onUndo: () => void;
	onRedo: () => void;
}

function Footer({
	colors,
	taskCounts,
	tokenCount,
	isDirty,
	isLocked,
	isSaving,
	isResetting,
	canUndo,
	canRedo,
	mode,
	onSave,
	onRevert,
	onReset,
	onUndo,
	onRedo,
}: FooterProps) {
	return (
		<div
			style={{
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'space-between',
				gap: '8px',
				padding: '6px 10px',
				borderTop: `1px solid ${colors.border}`,
				backgroundColor: colors.bgActivity,
				fontSize: '11px',
				flexShrink: 0,
			}}
		>
			<div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
				{isDirty && !isLocked ? (
					<button
						onClick={onRevert}
						style={{
							padding: '4px 8px',
							borderRadius: '4px',
							border: `1px solid ${colors.border}`,
							backgroundColor: 'transparent',
							color: colors.textDim,
							fontSize: '11px',
							cursor: 'pointer',
						}}
						title="Discard changes"
					>
						Revert
					</button>
				) : null}
				{mode === 'edit' && (
					<>
						<button
							onClick={onUndo}
							disabled={!canUndo}
							style={{
								padding: '4px 6px',
								borderRadius: '4px',
								border: `1px solid ${colors.border}`,
								backgroundColor: 'transparent',
								color: canUndo ? colors.textDim : `${colors.textDim}80`,
								fontSize: '11px',
								cursor: canUndo ? 'pointer' : 'not-allowed',
								opacity: canUndo ? 1 : 0.5,
							}}
							title="Undo (Cmd+Z)"
						>
							↶
						</button>
						<button
							onClick={onRedo}
							disabled={!canRedo}
							style={{
								padding: '4px 6px',
								borderRadius: '4px',
								border: `1px solid ${colors.border}`,
								backgroundColor: 'transparent',
								color: canRedo ? colors.textDim : `${colors.textDim}80`,
								fontSize: '11px',
								cursor: canRedo ? 'pointer' : 'not-allowed',
								opacity: canRedo ? 1 : 0.5,
							}}
							title="Redo (Shift+Cmd+Z)"
						>
							↷
						</button>
					</>
				)}
			</div>

			<div style={{ display: 'flex', alignItems: 'center', gap: '12px', color: colors.textDim }}>
				{taskCounts.completed > 0 && !isLocked && (
					<button
						onClick={onReset}
						disabled={isResetting}
						style={{
							padding: '2px 4px',
							border: 'none',
							background: 'transparent',
							color: colors.textDim,
							cursor: isResetting ? 'not-allowed' : 'pointer',
							fontSize: '12px',
							opacity: isResetting ? 0.5 : 1,
						}}
						title={`Reset ${taskCounts.completed} completed task${taskCounts.completed !== 1 ? 's' : ''}`}
						aria-label="Reset completed tasks"
					>
						↻
					</button>
				)}
				{taskCounts.total > 0 && (
					<span>
						<span
							style={{
								color: taskCounts.completed === taskCounts.total ? colors.success : colors.accent,
							}}
						>
							{taskCounts.completed}
						</span>{' '}
						of <span style={{ color: colors.accent }}>{taskCounts.total}</span> task
						{taskCounts.total !== 1 ? 's' : ''}
					</span>
				)}
				{tokenCount !== null && (
					<span>
						<span style={{ opacity: 0.6 }}>Tokens:</span>{' '}
						<span style={{ color: colors.accent }}>{formatTokens(tokenCount)}</span>
					</span>
				)}
			</div>

			<div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
				{isDirty && !isLocked && (
					<button
						onClick={onSave}
						disabled={isSaving}
						style={{
							padding: '4px 12px',
							borderRadius: '4px',
							border: `1px solid ${colors.accent}`,
							backgroundColor: colors.accent,
							color: colors.accentForeground,
							fontSize: '11px',
							fontWeight: 600,
							cursor: isSaving ? 'not-allowed' : 'pointer',
							opacity: isSaving ? 0.7 : 1,
						}}
						title="Save (Cmd+S)"
					>
						{isSaving ? 'Saving...' : 'Save'}
					</button>
				)}
			</div>
		</div>
	);
}

interface CreateDocSheetProps {
	colors: ReturnType<typeof useThemeColors>;
	value: string;
	onChange: (next: string) => void;
	onCancel: () => void;
	onSubmit: () => void;
	isSubmitting: boolean;
	existingPaths: string[];
}

function CreateDocSheet({
	colors,
	value,
	onChange,
	onCancel,
	onSubmit,
	isSubmitting,
	existingPaths,
}: CreateDocSheetProps) {
	const inputRef = useRef<HTMLInputElement>(null);
	useEffect(() => {
		inputRef.current?.focus();
	}, []);
	const trimmed = value.trim().replace(/\.md$/i, '');
	const isDuplicate =
		!!trimmed && existingPaths.some((p) => p.toLowerCase() === trimmed.toLowerCase());
	const canSubmit = !!trimmed && !isDuplicate && !isSubmitting;

	return (
		<div
			role="dialog"
			aria-modal="true"
			onClick={(e) => {
				if (e.target === e.currentTarget) onCancel();
			}}
			style={{
				position: 'fixed',
				inset: 0,
				backgroundColor: 'rgba(0,0,0,0.45)',
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'center',
				padding: '16px',
				zIndex: 220,
			}}
		>
			<div
				style={{
					width: '100%',
					maxWidth: '420px',
					backgroundColor: colors.bgSidebar,
					border: `1px solid ${colors.border}`,
					borderRadius: '12px',
					overflow: 'hidden',
				}}
			>
				<div
					style={{
						padding: '14px 16px',
						borderBottom: `1px solid ${colors.border}`,
						fontWeight: 600,
						color: colors.textMain,
						fontSize: '14px',
					}}
				>
					Create new document
				</div>
				<div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
					<label style={{ fontSize: '12px', color: colors.textDim, fontWeight: 500 }}>
						Document name
					</label>
					<input
						ref={inputRef}
						type="text"
						value={value}
						onChange={(e) => onChange(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === 'Enter' && canSubmit) {
								e.preventDefault();
								onSubmit();
							}
						}}
						placeholder="my-tasks"
						style={{
							padding: '10px 12px',
							borderRadius: '6px',
							border: `1px solid ${isDuplicate ? colors.error : colors.border}`,
							backgroundColor: colors.bgActivity,
							color: colors.textMain,
							fontSize: '14px',
							outline: 'none',
						}}
					/>
					{isDuplicate ? (
						<div style={{ fontSize: '11px', color: colors.error }}>
							A document with this name already exists.
						</div>
					) : (
						<div style={{ fontSize: '11px', color: colors.textDim }}>
							The .md extension is added automatically. Use slashes for subfolders (e.g.{' '}
							<code>loop/step-1</code>).
						</div>
					)}
				</div>
				<div
					style={{
						padding: '12px 16px',
						borderTop: `1px solid ${colors.border}`,
						display: 'flex',
						justifyContent: 'flex-end',
						gap: '8px',
					}}
				>
					<button
						onClick={onCancel}
						style={{
							padding: '8px 14px',
							borderRadius: '6px',
							border: `1px solid ${colors.border}`,
							backgroundColor: 'transparent',
							color: colors.textMain,
							fontSize: '13px',
							cursor: 'pointer',
						}}
					>
						Cancel
					</button>
					<button
						onClick={onSubmit}
						disabled={!canSubmit}
						style={{
							padding: '8px 14px',
							borderRadius: '6px',
							border: 'none',
							backgroundColor: colors.accent,
							color: colors.accentForeground,
							fontSize: '13px',
							fontWeight: 600,
							cursor: canSubmit ? 'pointer' : 'not-allowed',
							opacity: canSubmit ? 1 : 0.5,
						}}
					>
						{isSubmitting ? 'Creating...' : 'Create'}
					</button>
				</div>
			</div>
		</div>
	);
}

interface HelpSheetProps {
	colors: ReturnType<typeof useThemeColors>;
	onClose: () => void;
}

function HelpSheet({ colors, onClose }: HelpSheetProps) {
	return (
		<div
			role="dialog"
			aria-modal="true"
			onClick={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
			style={{
				position: 'fixed',
				inset: 0,
				backgroundColor: 'rgba(0,0,0,0.45)',
				display: 'flex',
				alignItems: 'flex-end',
				justifyContent: 'center',
				zIndex: 220,
			}}
		>
			<div
				style={{
					width: '100%',
					maxWidth: '520px',
					maxHeight: '85vh',
					overflowY: 'auto',
					backgroundColor: colors.bgSidebar,
					border: `1px solid ${colors.border}`,
					borderTopLeftRadius: '12px',
					borderTopRightRadius: '12px',
				}}
			>
				<div
					style={{
						padding: '14px 16px',
						borderBottom: `1px solid ${colors.border}`,
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'space-between',
					}}
				>
					<span style={{ fontWeight: 600, color: colors.textMain, fontSize: '14px' }}>
						Auto Run — quick reference
					</span>
					<button
						onClick={onClose}
						aria-label="Close help"
						style={{
							width: '32px',
							height: '32px',
							borderRadius: '6px',
							border: `1px solid ${colors.border}`,
							backgroundColor: 'transparent',
							color: colors.textDim,
							cursor: 'pointer',
						}}
					>
						✕
					</button>
				</div>
				<div
					style={{
						padding: '16px',
						display: 'flex',
						flexDirection: 'column',
						gap: '12px',
						color: colors.textMain,
						fontSize: '13px',
						lineHeight: 1.55,
					}}
				>
					<HelpRow label="Run">
						Configure documents, prompt and loop settings, then launch the run.
					</HelpRow>
					<HelpRow label="PlayBooks">
						Save and reload run configurations as named playbooks.
					</HelpRow>
					<HelpRow label="Document selector">
						Tap the dropdown to switch documents. The badge shows completion %.
					</HelpRow>
					<HelpRow label="Edit / Preview">
						Edit raw Markdown or tap checkboxes in preview to mark tasks done.
					</HelpRow>
					<HelpRow label="Search">Cmd+F to find within the current document.</HelpRow>
					<HelpRow label="Save">Cmd+S to save your edits.</HelpRow>
					<HelpRow label="Undo / Redo">Cmd+Z / Shift+Cmd+Z while editing.</HelpRow>
					<HelpRow label="Reset tasks">
						Footer ↻ button reverts every <code>[x]</code> back to <code>[ ]</code>.
					</HelpRow>
				</div>
			</div>
		</div>
	);
}

function HelpRow({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
			<div style={{ fontSize: '12px', fontWeight: 600 }}>{label}</div>
			<div style={{ opacity: 0.85 }}>{children}</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Markdown preview that supports tappable task checkboxes.
// We index every checkbox by its order in the document and toggle the matching
// `- [ ]` / `- [x]` source line on tap.
// ---------------------------------------------------------------------------

interface TaskAwareMarkdownProps {
	content: string;
	onToggleTask: (index: number) => void;
	isLocked: boolean;
}

function TaskAwareMarkdown({ content, onToggleTask, isLocked }: TaskAwareMarkdownProps) {
	const counterRef = useRef(0);
	counterRef.current = 0;

	// We can't override `input` per-node from MobileMarkdownRenderer's components
	// without forking the renderer, so we wrap the renderer in a div and attach a
	// click handler that intercepts checkbox clicks before the disabled attribute
	// suppresses them. To make checkboxes interactive we re-render via the shared
	// renderer and rely on event delegation.
	const handleClick = useCallback(
		(e: React.MouseEvent<HTMLDivElement>) => {
			if (isLocked) return;
			const target = e.target as HTMLElement | null;
			if (!target) return;
			if (target.tagName === 'INPUT' && (target as HTMLInputElement).type === 'checkbox') {
				const checkboxes = Array.from(
					(e.currentTarget as HTMLDivElement).querySelectorAll('input[type="checkbox"]')
				);
				const idx = checkboxes.indexOf(target);
				if (idx >= 0) {
					e.preventDefault();
					onToggleTask(idx);
				}
			}
		},
		[isLocked, onToggleTask]
	);

	return (
		<div onClickCapture={handleClick} style={{ cursor: isLocked ? 'default' : 'auto' }}>
			<MobileMarkdownRenderer content={content} fontSize={13} />
		</div>
	);
}

// ---------------------------------------------------------------------------
// Inline SVG icons (no extra deps).
// ---------------------------------------------------------------------------

const ICON_PROPS = {
	width: 14,
	height: 14,
	viewBox: '0 0 24 24',
	fill: 'none',
	stroke: 'currentColor',
	strokeWidth: 2,
	strokeLinecap: 'round',
	strokeLinejoin: 'round',
} as const;

function PlayIcon() {
	return (
		<svg {...ICON_PROPS}>
			<polygon points="5 3 19 12 5 21 5 3" />
		</svg>
	);
}
function StopIcon() {
	return (
		<svg {...ICON_PROPS}>
			<rect x="5" y="5" width="14" height="14" rx="1" />
		</svg>
	);
}
function BooksIcon() {
	return (
		<svg {...ICON_PROPS}>
			<rect x="3" y="3" width="7" height="7" />
			<rect x="14" y="3" width="7" height="7" />
			<rect x="3" y="14" width="7" height="7" />
			<rect x="14" y="14" width="7" height="7" />
		</svg>
	);
}
function HelpIcon() {
	return (
		<svg {...ICON_PROPS}>
			<circle cx="12" cy="12" r="10" />
			<path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
			<line x1="12" y1="17" x2="12.01" y2="17" />
		</svg>
	);
}
function PlusIcon() {
	return (
		<svg {...ICON_PROPS}>
			<line x1="12" y1="5" x2="12" y2="19" />
			<line x1="5" y1="12" x2="19" y2="12" />
		</svg>
	);
}
function RefreshIcon({ spinning }: { spinning?: boolean }) {
	return (
		<svg
			{...ICON_PROPS}
			style={spinning ? { animation: 'autorunSpin 1s linear infinite' } : undefined}
		>
			<path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2" />
			<style>{`@keyframes autorunSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
		</svg>
	);
}
function FolderIcon() {
	return (
		<svg {...ICON_PROPS}>
			<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
		</svg>
	);
}
function MaximizeIcon() {
	return (
		<svg {...ICON_PROPS}>
			<polyline points="15 3 21 3 21 9" />
			<polyline points="9 21 3 21 3 15" />
			<line x1="21" y1="3" x2="14" y2="10" />
			<line x1="3" y1="21" x2="10" y2="14" />
		</svg>
	);
}
function SearchIcon() {
	return (
		<svg {...ICON_PROPS}>
			<circle cx="11" cy="11" r="8" />
			<line x1="21" y1="21" x2="16.65" y2="16.65" />
		</svg>
	);
}
function EyeIcon() {
	return (
		<svg {...ICON_PROPS}>
			<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
			<circle cx="12" cy="12" r="3" />
		</svg>
	);
}
function EditIcon() {
	return (
		<svg {...ICON_PROPS}>
			<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
			<path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
		</svg>
	);
}

export default AutoRunInline;
