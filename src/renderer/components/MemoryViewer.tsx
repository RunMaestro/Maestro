/**
 * MemoryViewer - full-panel overlay for browsing/editing Claude Code per-project memory.
 *
 * Mirrors the Claude Sessions browser shell (same header pattern, close button) and reuses the
 * shared DualPaneFileEditor for the list + markdown editor layout. Gated by the
 * `supportsProjectMemory` capability on the active agent; today only Claude Code qualifies.
 *
 * Chrome layout, top to bottom: a title header, a TOOLBAR that carries every
 * control (filter, unlinked chip, Graph, the Edit/Preview switch), the split
 * view, and a STATS FOOTER. The corpus figures are reference material rather
 * than controls, so they sit at the bottom out of the way of the row the user
 * actually reaches for - the toolbar is one non-wrapping line, and the stats
 * used to be what forced it to wrap.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Brain, Plus, X, Database, FileText, Clock, Zap, Unlink, Network } from 'lucide-react';
import type { Session, Theme } from '../types';
import { formatSize, formatRelativeTime, formatNumber } from '../utils/formatters';
import { estimateTokenCount } from '../../shared/formatters';
import { getAgentDisplayName } from '../../shared/agentMetadata';
import { useLayerStack } from '../contexts/LayerStackContext';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { DualPaneFileEditor, type DualPaneFileEditorItem } from './shared/DualPaneFileEditor';
import { Modal, ModalFooter } from './ui/Modal';
import { FormInput } from './ui/FormInput';
import { FilterInput } from './ui/FilterInput';
import { HeaderActionButton } from './ui/HeaderActionButton';
import { SegmentedControl } from './ui/SegmentedControl';
import { Markdown } from './Markdown';
import { MarkdownEditor, type MarkdownEditorHandle } from './FilePreview/markdownEditor';
import { generateProseStyles } from '../utils/markdownConfig';
import { searchMatchRanges } from '../utils/highlightMatches';
import { useFileExplorerStore } from '../stores/fileExplorerStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useDebouncedValue } from '../hooks/utils/useThrottle';
import { useEventListener } from '../hooks/utils/useEventListener';
import { useCommandKeyShortcut } from '../hooks/keyboard/useCommandKeyShortcut';
import { eventMatchesShortcutKeys } from '../utils/shortcutMatch';
import { formatMetaKey } from '../utils/shortcutFormatter';
import { isTextInputTarget } from '../utils/messageScrollNavigation';
import { useModalStore } from '../stores/modalStore';

/** Which half of the Edit/Preview switch is showing. */
type MemoryViewMode = 'preview' | 'edit';

const VIEW_MODE_OPTIONS = [
	{ value: 'preview' as const, label: 'Preview', title: 'Rendered markdown' },
	{ value: 'edit' as const, label: 'Edit', title: 'Syntax-highlighted source' },
];

interface MemoryViewerProps {
	theme: Theme;
	activeSession: Session | undefined;
	onClose: () => void;
}

interface MemoryEntry {
	name: string;
	size: number;
	createdAt: string;
	modifiedAt: string;
}

interface MemoryStats {
	fileCount: number;
	firstCreatedAt: string | null;
	lastModifiedAt: string | null;
	totalBytes: number;
}

const INDEX_STARTER_CONTENT = `# Memory index

Pointers to individual memory files. One line per entry, under ~150 chars:

- [Title](filename.md) - one-line hook
`;

const ENTRY_STARTER_CONTENT = `---
name: new memory
description: one-line description
type: user
---

Write the memory body here.
`;

function starterContentFor(filename: string): string {
	return filename === 'MEMORY.md' ? INDEX_STARTER_CONTENT : ENTRY_STARTER_CONTENT;
}

/**
 * The entry to land on after `deleted` disappears: the one below it, else the
 * one above. Keeps a Backspace-through cleanup pass moving in one direction
 * instead of bouncing back to the MEMORY.md index after every delete.
 */
function nextSelectionAfterDelete(visibleNames: string[], deleted: string): string | null {
	const index = visibleNames.indexOf(deleted);
	if (index === -1) return null;
	return visibleNames[index + 1] ?? visibleNames[index - 1] ?? null;
}

function suggestNewFilename(existing: Set<string>): string {
	// First file should always be MEMORY.md (the index that points at every other entry).
	if (existing.size === 0) return 'MEMORY.md';
	const base = 'new-memory';
	let candidate = `${base}.md`;
	let n = 2;
	while (existing.has(candidate)) {
		candidate = `${base}-${n}.md`;
		n += 1;
	}
	return candidate;
}

export function MemoryViewer({ theme, activeSession, onClose }: MemoryViewerProps): JSX.Element {
	const projectPath = activeSession?.projectRoot || activeSession?.cwd || '';
	const agentId = activeSession?.toolType || 'claude-code';

	const [entries, setEntries] = useState<MemoryEntry[]>([]);
	const [stats, setStats] = useState<MemoryStats>({
		fileCount: 0,
		firstCreatedAt: null,
		lastModifiedAt: null,
		totalBytes: 0,
	});
	const [directoryPath, setDirectoryPath] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [loadError, setLoadError] = useState<string | null>(null);

	const [selectedName, setSelectedName] = useState<string | null>(null);
	const [originalContent, setOriginalContent] = useState<string>('');
	const [editedContent, setEditedContent] = useState<string>('');
	const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

	const [isSaving, setIsSaving] = useState(false);
	const [isDeleting, setIsDeleting] = useState(false);
	const [actionError, setActionError] = useState<string | null>(null);
	const [successMessage, setSuccessMessage] = useState<string | null>(null);

	// Keyword filter. `matches` is null while no filter is applied; a Map (name
	// -> first matching body line) once one is, so an empty Map means "filter
	// active, nothing matched" rather than "no filter".
	const [filterQuery, setFilterQuery] = useState('');
	const debouncedFilter = useDebouncedValue(filterQuery, 150);
	const [matches, setMatches] = useState<Map<string, string | undefined> | null>(null);

	// Memories nothing points at. Claude reads MEMORY.md to decide what to load,
	// so an unreferenced entry is written but never recalled - the filter exists
	// to make that visible, since nothing else in the app shows it.
	const [orphans, setOrphans] = useState<string[]>([]);
	const [showOnlyOrphans, setShowOnlyOrphans] = useState(false);

	// Bumped after a delete so focus returns to the list and the next Backspace
	// keeps working (the row that had focus was just unmounted).
	const [listFocusToken, setListFocusToken] = useState(0);

	const [createModalOpen, setCreateModalOpen] = useState(false);
	const [createName, setCreateName] = useState('');
	const [createError, setCreateError] = useState<string | null>(null);
	const [isCreating, setIsCreating] = useState(false);
	const createInputRef = useRef<HTMLInputElement>(null);
	const filterInputRef = useRef<HTMLInputElement>(null);
	const editorRef = useRef<MarkdownEditorHandle>(null);
	const previewScrollRef = useRef<HTMLDivElement>(null);

	/**
	 * Reading or writing. Memory files are read far more often than they are
	 * edited - the usual reason to open this pane is "what do I already know
	 * about X?" - so the default is the rendered document, and editing is one
	 * keystroke away rather than the state you have to leave.
	 */
	const [viewMode, setViewMode] = useState<MemoryViewMode>('preview');

	/** Move keyboard focus back to the file list (see `listFocusToken`). */
	const focusList = useCallback(() => setListFocusToken((t) => t + 1), []);

	const layerIdRef = useRef<string>();
	/**
	 * Escape is a LADDER, climbed one rung per press, never skipping to close.
	 *
	 *   1. caret in the filter box -> hand focus back to the list, query intact
	 *   2. filter still has text    -> clear it
	 *   3. otherwise                -> close the viewer
	 *
	 * Rung 1 is what makes "filter, then arrow through the hits" work: the
	 * query has to survive the key that gets you out of the text box, or the
	 * results you were about to walk vanish as you reach for them.
	 *
	 * It all lives here because the layer stack handles Escape at CAPTURE on
	 * `window`, so `FilterInput`'s own Escape handler never sees the key inside
	 * a registered surface - and without this ladder the whole pane would close
	 * while the user was only trying to leave the filter box.
	 */
	const onEscapeRef = useRef<() => void>(() => {});
	onEscapeRef.current = () => {
		// `visibleNamesRef` guards the hand-off: a filter that matched nothing has
		// no row to focus, so blurring would drop focus on <body> and the arrows
		// the user just reached for would do nothing. In that case fall through
		// to clearing the filter, which is the useful move anyway.
		if (document.activeElement === filterInputRef.current && visibleNamesRef.current.length > 0) {
			filterInputRef.current?.blur();
			focusList();
			return;
		}
		if (filterQuery) {
			setFilterQuery('');
			return;
		}
		onClose();
	};

	/**
	 * Jump to the filter box: Cmd/Ctrl+F, or bare `/`.
	 *
	 * The two guards differ on purpose. `/` is a legal character, so it only
	 * takes effect when the caret is NOT in a text field - otherwise typing a
	 * path into the memory editor would fling focus into the filter mid-word.
	 * Cmd+F carries a modifier and means nothing else here, so it works from
	 * anywhere including the editor.
	 *
	 * Skipped entirely while the New Memory dialog is up: it sits on top, and a
	 * surface the user cannot see should not be stealing their keystrokes.
	 */
	useEventListener(
		'keydown',
		(event) => {
			const e = event as KeyboardEvent;
			const isFindChord = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f';
			const isSlash = e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey;
			if (!isFindChord && !isSlash) return;
			if (isSlash && isTextInputTarget(e.target)) return;

			e.preventDefault();
			e.stopPropagation();
			filterInputRef.current?.focus();
			filterInputRef.current?.select();
		},
		{ enabled: !createModalOpen }
	);

	/**
	 * Cmd/Ctrl+E flips between the rendered document and the source editor.
	 *
	 * It reads the user's LIVE binding for `toggleMarkdownMode` rather than
	 * testing for a literal `e`, so the chord that flips a file preview and the
	 * chord that flips a memory stay the same key after a remap - two spellings
	 * of one idea is exactly how a keyboard stops being predictable.
	 *
	 * Bound here rather than left to the global handler because this pane
	 * registers as a modal layer that blocks lower layers, so the app-level
	 * shortcut never reaches its own handler while the pane is up.
	 */
	const toggleModeKeys = useSettingsStore((s) => s.shortcuts.toggleMarkdownMode?.keys);
	useEventListener(
		'keydown',
		(event) => {
			const e = event as KeyboardEvent;
			if (!eventMatchesShortcutKeys(e, toggleModeKeys)) return;
			e.preventDefault();
			e.stopPropagation();
			setViewMode((mode) => (mode === 'preview' ? 'edit' : 'preview'));
		},
		{ enabled: !createModalOpen }
	);

	/**
	 * Land the caret in the editor when the user switches to Edit, and hand it
	 * back to the list when they leave. Without the first half, Cmd+E puts a
	 * writable surface on screen that silently swallows nothing - every
	 * keystroke still goes to whatever had focus before, which reads as the
	 * editor being broken.
	 *
	 * Skipped on the initial render (`preview` is the default, and there is
	 * nothing to hand focus back from) and while the New Memory dialog is up.
	 */
	const previousViewModeRef = useRef(viewMode);
	useEffect(() => {
		const previous = previousViewModeRef.current;
		previousViewModeRef.current = viewMode;
		if (previous === viewMode || createModalOpen) return;
		if (viewMode === 'edit') {
			requestAnimationFrame(() => editorRef.current?.focus());
		} else {
			focusList();
		}
	}, [viewMode, createModalOpen, focusList]);

	const { registerLayer, unregisterLayer } = useLayerStack();

	// Register as a modal layer so Escape closes us at the right priority.
	useEffect(() => {
		layerIdRef.current = registerLayer({
			type: 'modal',
			priority: MODAL_PRIORITIES.AGENT_SESSIONS,
			blocksLowerLayers: true,
			capturesFocus: false,
			focusTrap: 'lenient',
			ariaLabel: 'Project Memory Viewer',
			onEscape: () => onEscapeRef.current(),
		});
		return () => {
			if (layerIdRef.current) unregisterLayer(layerIdRef.current);
		};
	}, [registerLayer, unregisterLayer]);

	// Auto-dismiss success message
	useEffect(() => {
		if (!successMessage) return;
		const t = setTimeout(() => setSuccessMessage(null), 3000);
		return () => clearTimeout(t);
	}, [successMessage]);

	const loadEntry = useCallback(
		async (name: string) => {
			if (!projectPath) return;
			try {
				const result = await window.maestro.memory.read(projectPath, name, agentId);
				if (!result.success) {
					setActionError(result.error || `Failed to read ${name}`);
					return;
				}
				setSelectedName(name);
				setOriginalContent(result.content ?? '');
				setEditedContent(result.content ?? '');
				setHasUnsavedChanges(false);
				setActionError(null);
			} catch (err) {
				setActionError(String(err));
			}
		},
		[projectPath, agentId]
	);

	const reloadList = useCallback(
		async (preferName?: string | null) => {
			if (!projectPath) {
				setLoading(false);
				setLoadError('No active agent session');
				return;
			}
			setLoading(true);
			try {
				const result = await window.maestro.memory.list(projectPath, agentId);
				if (!result.success) {
					setLoadError(result.error || 'Failed to load memory');
					return;
				}
				setDirectoryPath(result.directoryPath || null);
				setEntries(result.entries || []);
				setStats(
					result.stats || {
						fileCount: 0,
						firstCreatedAt: null,
						lastModifiedAt: null,
						totalBytes: 0,
					}
				);
				setLoadError(null);

				// Pick a selection: prefer the passed name, fall back to MEMORY.md, then first entry.
				const list = result.entries || [];
				const target =
					(preferName && list.find((e) => e.name === preferName)) ||
					list.find((e) => e.name === 'MEMORY.md') ||
					list[0] ||
					null;
				if (target) {
					await loadEntry(target.name);
				} else {
					setSelectedName(null);
					setOriginalContent('');
					setEditedContent('');
					setHasUnsavedChanges(false);
				}
			} catch (err) {
				setLoadError(String(err));
			} finally {
				setLoading(false);
			}
		},
		[projectPath, agentId, loadEntry]
	);

	useEffect(() => {
		void reloadList();
	}, [reloadList]);

	// Content search runs in the main process (it has to read every file), so it
	// is debounced and re-runs whenever the file set changes under it.
	useEffect(() => {
		const query = debouncedFilter.trim();
		if (!query || !projectPath) {
			setMatches(null);
			return;
		}
		let cancelled = false;
		void (async () => {
			try {
				const result = await window.maestro.memory.search(projectPath, query, agentId);
				if (cancelled) return;
				if (!result.success) {
					setActionError(result.error || 'Failed to search memory');
					return;
				}
				setMatches(new Map((result.matches || []).map((m) => [m.name, m.snippet])));
			} catch (err) {
				// Report it rather than leaving the list silently unfiltered - the
				// user typed a query and is owed an answer either way.
				if (!cancelled) setActionError(String(err));
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [debouncedFilter, projectPath, agentId, entries]);

	const orphanSet = useMemo(() => new Set(orphans), [orphans]);

	// The two filters compose rather than override: "unlinked entries mentioning
	// worktrees" is a real question, and making the chip clear the search box
	// would answer a different one.
	const filteredEntries = useMemo(() => {
		const byQuery = matches ? entries.filter((e) => matches.has(e.name)) : entries;
		return showOnlyOrphans ? byQuery.filter((e) => orphanSet.has(e.name)) : byQuery;
	}, [entries, matches, showOnlyOrphans, orphanSet]);

	// Read at delete time to pick the next selection; a ref keeps the delete
	// callbacks off the filtered list's identity.
	const visibleNamesRef = useRef<string[]>([]);
	visibleNamesRef.current = filteredEntries.map((e) => e.name);

	// A filter that hides the current selection moves to the top hit, so typing
	// shows the match instead of an empty editor. Unsaved edits win: never yank
	// the user off a file they have changed.
	useEffect(() => {
		if (!matches || hasUnsavedChanges) return;
		if (selectedName && matches.has(selectedName)) return;
		const first = filteredEntries[0];
		if (first) void loadEntry(first.name);
	}, [matches, filteredEntries, selectedName, hasUnsavedChanges, loadEntry]);

	// Recomputed whenever the file set changes: every create, delete, and save
	// goes through reloadList, and each of those can make or break a reference.
	useEffect(() => {
		if (!projectPath || entries.length === 0) {
			setOrphans([]);
			return;
		}
		let cancelled = false;
		void (async () => {
			try {
				const result = await window.maestro.memory.orphans(projectPath, agentId);
				if (cancelled || !result.success) return;
				setOrphans(result.orphans ?? []);
			} catch {
				// The chip is purely additive, so losing it is a safe degradation -
				// and an unguarded await here surfaces as an unhandled rejection
				// rather than anything the user could act on.
				if (!cancelled) setOrphans([]);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [projectPath, agentId, entries]);

	const handleSelect = useCallback(
		async (name: string) => {
			if (name === selectedName) return;
			if (hasUnsavedChanges) {
				const discard = window.confirm('You have unsaved changes. Discard them?');
				if (!discard) return;
			}
			await loadEntry(name);
		},
		[selectedName, hasUnsavedChanges, loadEntry]
	);

	const handleSave = useCallback(async () => {
		if (!selectedName || !hasUnsavedChanges) return;
		setIsSaving(true);
		setActionError(null);
		try {
			const result = await window.maestro.memory.write(
				projectPath,
				selectedName,
				editedContent,
				agentId
			);
			if (!result.success) {
				setActionError(result.error || 'Failed to save memory');
				return;
			}
			setOriginalContent(editedContent);
			setHasUnsavedChanges(false);
			setSuccessMessage('Changes saved');
			// Refresh stats and list (size/modified changed)
			await reloadList(selectedName);
		} finally {
			setIsSaving(false);
		}
	}, [selectedName, hasUnsavedChanges, editedContent, projectPath, agentId, reloadList]);

	const performDelete = useCallback(
		async (name: string) => {
			const nextName = nextSelectionAfterDelete(visibleNamesRef.current, name);
			setIsDeleting(true);
			setActionError(null);
			try {
				const result = await window.maestro.memory.delete(projectPath, name, agentId);
				if (!result.success) {
					setActionError(result.error || `Failed to delete ${name}`);
					return;
				}
				setSuccessMessage(`Deleted ${name}`);
				await reloadList(nextName);
			} finally {
				setIsDeleting(false);
				setListFocusToken((t) => t + 1);
			}
		},
		[projectPath, agentId, reloadList]
	);

	/**
	 * Raised by the Delete button and by Backspace/Delete on a focused list row.
	 * Both go through the shared destructive confirm modal so the two paths
	 * cannot drift on what they warn about.
	 */
	const requestDelete = useCallback(
		(name: string) => {
			if (!name) return;
			if (name === 'MEMORY.md') {
				setActionError('MEMORY.md is the index and cannot be deleted from the viewer');
				return;
			}
			useModalStore.getState().openModal('confirm', {
				title: 'Delete Memory',
				message: `Delete memory file "${name}"? This cannot be undone.`,
				destructive: true,
				onConfirm: () => {
					void performDelete(name);
				},
			});
		},
		[performDelete]
	);

	/**
	 * Graph how the memories link to each other.
	 *
	 * Scoped to the memory directory and rooted there explicitly: memory lives
	 * under `~/.claude/projects/<encoded>/memory/`, outside the project, so the
	 * graph's usual project root would resolve every path to nothing.
	 *
	 * The viewer closes on the way out. Both are full-window views on the same
	 * agent, so leaving this one mounted underneath would strand it behind a
	 * surface the user cannot see past.
	 */
	const handleOpenGraph = useCallback(() => {
		if (!directoryPath) return;
		useFileExplorerStore.getState().openGraphScope({
			directory: '',
			rootPath: directoryPath,
			// Center on MEMORY.md when it exists - it is the index every other
			// entry hangs off, so it is the hub a reader expects in the middle.
			focusPath: entries.some((e) => e.name === 'MEMORY.md') ? 'MEMORY.md' : undefined,
			// Escape out of that graph comes back HERE rather than to an empty
			// workspace. The viewer closes on the way out (both are full-window
			// views), so without this the trip is one-way.
			returnTo: 'memoryViewer',
		});
		onClose();
	}, [directoryPath, entries, onClose]);

	const toggleOrphanFilter = useCallback(() => {
		// Nothing to narrow to, and the chip that explains the state is not on
		// screen either - a filter the user cannot see or undo is worse than a
		// key that does nothing.
		if (orphans.length === 0) return;
		setShowOnlyOrphans((v) => !v);
	}, [orphans.length]);

	/**
	 * Surface-local chords, claimed for as long as the viewer is up: Cmd/Ctrl+G
	 * graphs the corpus, Cmd/Ctrl+U toggles the unlinked filter.
	 *
	 * These are literal chords rather than lookups in `shortcuts`, because
	 * neither action exists as a global binding to inherit - unlike Cmd+E, which
	 * IS the app's toggleMarkdownMode and so reads the user's live key for it.
	 *
	 * They shadow the global Fuzzy File Search and Filter Unread Tabs only in
	 * the sense that both are already unreachable here: this pane registers a
	 * layer that blocks lower ones, and `useMainKeyboardHandler` bails out
	 * entirely while any layer is open.
	 */
	useCommandKeyShortcut('g', handleOpenGraph, !createModalOpen);
	useCommandKeyShortcut('u', toggleOrphanFilter, !createModalOpen);

	const handleCreate = useCallback(() => {
		if (!projectPath) return;
		if (hasUnsavedChanges) {
			const discard = window.confirm('You have unsaved changes on the current file. Discard them?');
			if (!discard) return;
		}
		const existing = new Set(entries.map((e) => e.name));
		setCreateName(suggestNewFilename(existing));
		setCreateError(null);
		setCreateModalOpen(true);
	}, [projectPath, entries, hasUnsavedChanges]);

	const closeCreateModal = useCallback(() => {
		setCreateModalOpen(false);
		setCreateName('');
		setCreateError(null);
		setIsCreating(false);
	}, []);

	const handleConfirmCreate = useCallback(async () => {
		if (!projectPath) return;
		let filename = createName.trim();
		if (!filename) {
			setCreateError('Filename is required');
			return;
		}
		if (!filename.toLowerCase().endsWith('.md')) filename += '.md';
		const existing = new Set(entries.map((e) => e.name));
		if (existing.has(filename)) {
			setCreateError(`A memory file named "${filename}" already exists`);
			return;
		}
		setIsCreating(true);
		setCreateError(null);
		try {
			const result = await window.maestro.memory.create(
				projectPath,
				filename,
				starterContentFor(filename),
				agentId
			);
			if (!result.success) {
				setCreateError(result.error || `Failed to create ${filename}`);
				return;
			}
			setSuccessMessage(`Created ${filename}`);
			closeCreateModal();
			await reloadList(filename);
		} finally {
			setIsCreating(false);
		}
	}, [projectPath, createName, entries, agentId, reloadList, closeCreateModal]);

	const items = useMemo<DualPaneFileEditorItem[]>(
		() =>
			filteredEntries.map((e) => {
				const isCurrent = e.name === selectedName;
				const snippet = matches?.get(e.name);
				const meta = `${formatSize(e.size)} • modified ${formatRelativeTime(e.modifiedAt)}`;
				const orphaned = orphanSet.has(e.name);
				const description = orphaned ? `${meta}\nunlinked - nothing points at this` : meta;
				return {
					id: e.name,
					label: e.name,
					description: snippet ? `${description}\nmatch: ${snippet}` : description,
					isModified: isCurrent && hasUnsavedChanges,
				};
			}),
		[filteredEntries, matches, selectedName, hasUnsavedChanges, orphanSet]
	);

	const editorTokenCount = useMemo(
		() => (selectedName ? estimateTokenCount(editedContent) : undefined),
		[selectedName, editedContent]
	);

	/**
	 * Repaint the editor's filter highlights whenever the query or the document
	 * changes. Pushed imperatively rather than passed as a prop because CM6 owns
	 * its own document: re-rendering the component would not move a decoration,
	 * and rebuilding the view would throw away the undo history and the caret.
	 *
	 * `-1` for the active index means "wash every hit equally" - this is a
	 * filter, not a find bar, so there is no cursor into the results to paint
	 * one of them differently from the rest.
	 */
	const filterQueryTrimmed = debouncedFilter.trim();
	useEffect(() => {
		if (viewMode !== 'edit') return;
		editorRef.current?.setSearchMatches(searchMatchRanges(editedContent, filterQueryTrimmed), -1);
	}, [viewMode, editedContent, filterQueryTrimmed]);

	const renderEditorBody = useCallback(() => {
		if (viewMode === 'preview') {
			return (
				<div
					ref={previewScrollRef}
					className="memory-preview flex-1 min-h-0 overflow-y-auto rounded px-4 py-3 border outline-none"
					// Focusable so the pane can be scrolled with the keyboard the
					// moment it is shown; a reading surface you have to click first
					// is a reading surface the arrow keys appear broken on.
					tabIndex={0}
					style={{
						borderColor: theme.colors.border,
						backgroundColor: theme.colors.bgMain,
						color: theme.colors.textMain,
					}}
					data-testid="memory-preview"
				>
					<Markdown
						preset="document"
						content={editedContent}
						theme={theme}
						containerRef={previewScrollRef}
						searchHighlight={
							filterQueryTrimmed ? { query: filterQueryTrimmed, currentMatchIndex: -1 } : undefined
						}
					/>
				</div>
			);
		}

		// Same CodeMirror editor the File Preview edits with, so a memory file is
		// syntax-coloured exactly like any other markdown document in the app and
		// the line-number gutter stays aligned through soft wraps.
		//
		// Keyed on the filename so switching memories remounts the view: undo
		// history belongs to one document, and carrying it across files lets an
		// undo paste the previous file's text into this one.
		return (
			// The border lives on a wrapper rather than on the editor's own host:
			// CM6 measures its viewport against that host, and a border on it is
			// counted twice once the content scrolls.
			<div
				className="flex-1 min-h-0 flex rounded border overflow-hidden"
				style={{ borderColor: theme.colors.border }}
			>
				<MarkdownEditor
					key={selectedName ?? 'memory'}
					ref={editorRef}
					value={editedContent}
					onChange={(next) => {
						setEditedContent(next);
						setHasUnsavedChanges(next !== originalContent);
					}}
					language="markdown"
					theme={theme}
				/>
			</div>
		);
	}, [viewMode, editedContent, originalContent, theme, filterQueryTrimmed, selectedName]);

	// Cheap estimate: ~4 bytes/token for English text (matches estimateTokenCount from shared/formatters).
	const estimatedTokens = useMemo(() => Math.ceil(stats.totalBytes / 4), [stats.totalBytes]);

	const agentDisplayName = getAgentDisplayName(agentId);
	// Never hard-code the glyph: the same tooltip has to read "Ctrl+G" on
	// Windows and Linux.
	const metaKey = formatMetaKey();

	return (
		<div className="flex-1 flex flex-col h-full" style={{ backgroundColor: theme.colors.bgMain }}>
			{/* Scoped so the rendered memory picks up the app's document typography
			    without leaking heading and table rules onto the chrome around it. */}
			<style>{generateProseStyles({ theme, scopeSelector: '.memory-preview' })}</style>

			{/* Header */}
			<div
				className="h-16 border-b flex items-center justify-between px-6 shrink-0"
				style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgSidebar }}
			>
				<div className="flex items-center gap-3 min-w-0">
					<Brain className="w-5 h-5 shrink-0" style={{ color: theme.colors.textDim }} />
					<span className="text-sm font-medium truncate" style={{ color: theme.colors.textMain }}>
						{agentDisplayName} Memories for {activeSession?.name || 'Agent'}
					</span>
				</div>
				<div className="flex items-center gap-2">
					<HeaderActionButton
						theme={theme}
						onClick={handleCreate}
						icon={<Plus />}
						title="Create a new memory file"
					>
						New Memory
					</HeaderActionButton>
					<button
						onClick={onClose}
						className="p-2 rounded hover:bg-white/5 transition-colors"
						style={{ color: theme.colors.textDim }}
						title="Close memory viewer"
					>
						<X className="w-4 h-4" />
					</button>
				</div>
			</div>

			{/* Toolbar: everything the user can act on, in one non-wrapping row.
			    Filter first because it is what gets reached for most, then the
			    two things that narrow or re-shape the same list, then the view
			    switch pushed right - it acts on the pane rather than the list. */}
			<div
				className="px-6 py-3 border-b shrink-0 flex items-center gap-3 text-xs"
				style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
			>
				<FilterInput
					ref={filterInputRef}
					theme={theme}
					value={filterQuery}
					onChange={setFilterQuery}
					placeholder="Filter by name or content..."
					ariaLabel="Filter memories by name or content"
					width={280}
					resultLabel={matches ? `${filteredEntries.length}/${entries.length}` : undefined}
				/>
				{orphans.length > 0 && (
					<button
						onClick={toggleOrphanFilter}
						className="flex items-center gap-1.5 px-2 py-1 rounded text-xs whitespace-nowrap shrink-0 transition-colors"
						style={{
							backgroundColor: showOnlyOrphans
								? `${theme.colors.warning}25`
								: `${theme.colors.warning}10`,
							color: showOnlyOrphans ? theme.colors.warning : theme.colors.textDim,
						}}
						title={
							showOnlyOrphans
								? `Show all memories (${metaKey}+U)`
								: `Show only the ${orphans.length} ${orphans.length === 1 ? 'memory' : 'memories'} nothing links to - Claude never loads these (${metaKey}+U)`
						}
						data-testid="memory-orphan-filter"
					>
						<Unlink className="w-3.5 h-3.5" />
						{orphans.length} unlinked
					</button>
				)}
				{entries.length > 0 && (
					<HeaderActionButton
						theme={theme}
						onClick={handleOpenGraph}
						variant="ghost"
						icon={<Network />}
						title={`Graph how these memories link to each other (${metaKey}+G)`}
						testId="memory-open-graph"
					>
						Graph
					</HeaderActionButton>
				)}
				<div className="flex-1" />
				<SegmentedControl
					value={viewMode}
					onChange={setViewMode}
					options={VIEW_MODE_OPTIONS}
					theme={theme}
					ariaLabel="Show the memory as a rendered document or as editable source"
					testId="memory-view-mode"
				/>
			</div>

			{/* Body */}
			<div className="flex-1 flex flex-col min-h-0 p-4">
				{loadError ? (
					<div
						className="flex-1 flex items-center justify-center text-sm"
						style={{ color: theme.colors.error }}
					>
						{loadError}
					</div>
				) : loading ? (
					<div
						className="flex-1 flex items-center justify-center text-sm"
						style={{ color: theme.colors.textDim }}
					>
						Loading memory…
					</div>
				) : entries.length === 0 ? (
					<div
						className="flex-1 flex flex-col items-center justify-center text-sm gap-3"
						style={{ color: theme.colors.textDim }}
					>
						<Brain className="w-10 h-10 opacity-30" />
						<div>No memory files yet for this project.</div>
						<HeaderActionButton theme={theme} onClick={handleCreate} icon={<Plus />}>
							Create first memory
						</HeaderActionButton>
					</div>
				) : (
					<DualPaneFileEditor
						theme={theme}
						items={items}
						selectedId={selectedName}
						onSelect={handleSelect}
						emptyStateMessage={
							filteredEntries.length === 0 && showOnlyOrphans
								? 'No unlinked memories match'
								: matches && filteredEntries.length === 0
									? `No memory matches "${debouncedFilter.trim()}"`
									: 'Select a memory file to view'
						}
						editorTitle={selectedName ?? undefined}
						editorTokenCount={editorTokenCount}
						showModifiedBadge={hasUnsavedChanges}
						renderEditorBody={renderEditorBody}
						successMessage={successMessage}
						errorMessage={actionError}
						highlightQuery={debouncedFilter.trim()}
						listWidthStorageKey="maestro.memoryViewer.listWidth"
						onDeleteItem={requestDelete}
						listFocusToken={listFocusToken}
						autoFocusList
						primaryAction={{
							label: isSaving ? 'Saving…' : 'Save',
							loading: isSaving,
							disabled: !hasUnsavedChanges,
							onClick: handleSave,
						}}
						secondaryAction={
							selectedName && selectedName !== 'MEMORY.md'
								? {
										label: isDeleting ? 'Deleting…' : 'Delete',
										loading: isDeleting,
										disabled: isDeleting,
										variant: 'danger',
										onClick: () => requestDelete(selectedName),
									}
								: undefined
						}
						openInFinderPath={directoryPath}
					/>
				)}
			</div>

			{/* Stats footer: what the corpus IS, rather than anything to do with
			    it. Reference figures belong out of the way of the controls, and
			    a footer is where the eye already goes for a total. */}
			<div
				className="px-6 py-2 border-t shrink-0 flex text-xs overflow-x-auto"
				style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
				data-testid="memory-stats-footer"
			>
				{/* Centered by AUTO MARGINS on the inner row rather than
				    `justify-center` on the scroller: once the figures are wider than
				    the pane, centered justification pushes the first one off the left
				    edge with no way to scroll back to it, while auto margins collapse
				    to zero and leave the row scrollable from its start. */}
				<div className="flex items-center gap-6 mx-auto">
					<span className="flex items-center gap-1.5 whitespace-nowrap shrink-0">
						<FileText className="w-3.5 h-3.5" />
						{stats.fileCount} {stats.fileCount === 1 ? 'file' : 'files'}
					</span>
					<span className="flex items-center gap-1.5 whitespace-nowrap shrink-0">
						<Database className="w-3.5 h-3.5" />
						{formatSize(stats.totalBytes)}
					</span>
					<span className="flex items-center gap-1.5 whitespace-nowrap shrink-0">
						<Zap className="w-3.5 h-3.5" />~{formatNumber(estimatedTokens)} tokens
					</span>
					{stats.firstCreatedAt && (
						<span
							className="flex items-center gap-1.5 whitespace-nowrap shrink-0"
							title={new Date(stats.firstCreatedAt).toLocaleString()}
						>
							<Clock className="w-3.5 h-3.5" />
							first created {formatRelativeTime(stats.firstCreatedAt)}
						</span>
					)}
					{stats.lastModifiedAt && (
						<span
							className="flex items-center gap-1.5 whitespace-nowrap shrink-0"
							title={new Date(stats.lastModifiedAt).toLocaleString()}
						>
							<Clock className="w-3.5 h-3.5" />
							last edited {formatRelativeTime(stats.lastModifiedAt)}
						</span>
					)}
				</div>
			</div>

			{createModalOpen && (
				<Modal
					theme={theme}
					title="New Memory"
					priority={MODAL_PRIORITIES.MEMORY_CREATE}
					onClose={closeCreateModal}
					width={420}
					initialFocusRef={createInputRef as React.RefObject<HTMLElement>}
					footer={
						<ModalFooter
							theme={theme}
							onCancel={closeCreateModal}
							onConfirm={handleConfirmCreate}
							confirmLabel={isCreating ? 'Creating…' : 'Create'}
							confirmDisabled={isCreating || !createName.trim()}
						/>
					}
				>
					<FormInput
						ref={createInputRef}
						theme={theme}
						value={createName}
						onChange={(v) => {
							setCreateName(v);
							if (createError) setCreateError(null);
						}}
						onSubmit={handleConfirmCreate}
						placeholder="memory-name.md"
						label="Filename"
						helperText="The .md extension is added automatically if omitted."
						error={createError ?? undefined}
						monospace
					/>
				</Modal>
			)}
		</div>
	);
}
