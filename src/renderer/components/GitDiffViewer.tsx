import { useState, useMemo, useEffect, useRef, useCallback, memo } from 'react';
import type { ReactNode } from 'react';
import { Diff, Hunk, getChangeKey } from 'react-diff-view';
import type { EventMap, RenderGutter } from 'react-diff-view';
import { Plus, Minus, ImageIcon, Columns2, AlignJustify, MessageSquarePlus } from 'lucide-react';
import type { Theme } from '../types';
import { parseGitDiff, getFileName, getDiffStats } from '../utils/gitDiffParser';
import { getBasename } from '../../shared/formatters';
import { useModalLayer } from '../hooks/ui/useModalLayer';
import { useResizableModal } from '../hooks/ui/useResizableModal';
import { revealActiveProps, useRevealActiveItem } from '../hooks/ui/useRevealActiveItem';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { ImageDiffViewer } from './ImageDiffViewer';
import { GitFilePathHeader } from './GitFilePathHeader';
import { generateDiffViewStyles } from '../utils/markdownConfig';
import { useSettingsStore } from '../stores/settingsStore';
import { safeStorageGet, safeStorageSet } from '../utils/safeLocalStorage';
import { ResizeHandles } from './ui/ResizeHandles';
import { Keycap } from './ui/Keycap';
import { useEventListener } from '../hooks/utils/useEventListener';
import { ModalSubtitle } from './ui/Modal';
import { useSessionStore } from '../stores/sessionStore';
import { ReviewCommentCard, ReviewCommentEditor, ReviewTray } from './ReviewComments';
import {
	anchorForSelection,
	buildReviewRows,
	clampToAnchorHunk,
	diffFileHunks,
	diffFileKey,
	findOutdatedComments,
	formatCommentLocation,
	type DiffComment,
	type DiffCommentAnchor,
	type DiffSide,
} from '../utils/diffReviewComments';
import { diffReviewKey, useDiffReviewStore } from '../stores/diffReviewStore';
import { selectReviewComments } from '../stores/reviewCommentStore';
import { deliverDiffReview, type DiffReviewDeliveryMode } from '../services/diffReview';
import { resolveGitSshRemoteId } from '../hooks/git/useGitAgentActions';
import { generateId } from '../utils/ids';
import { isEditingTextTarget } from '../utils/editableTarget';
import { trackShortcutUsage } from '../utils/shortcutTracking';
import { FIXED_SHORTCUTS } from '../constants/shortcuts';
import { notifyCenterFlash } from '../stores/centerFlashStore';
import 'react-diff-view/style/index.css';

export type GitDiffViewType = 'unified' | 'split';

const VIEW_TYPE_STORAGE_KEY = 'maestro.gitDiffViewer.viewType';

const NO_OUTDATED: ReadonlySet<string> = new Set();

function readStoredViewType(): GitDiffViewType | null {
	const raw = safeStorageGet(VIEW_TYPE_STORAGE_KEY);
	return raw === 'unified' || raw === 'split' ? raw : null;
}

function writeStoredViewType(value: GitDiffViewType): void {
	safeStorageSet(VIEW_TYPE_STORAGE_KEY, value);
}

function isFormControl(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	const tag = target.tagName;
	if (
		tag === 'BUTTON' ||
		tag === 'INPUT' ||
		tag === 'TEXTAREA' ||
		tag === 'SELECT' ||
		tag === 'A'
	) {
		return true;
	}
	return target.isContentEditable;
}

/**
 * Review affordances on top of `generateDiffViewStyles`: a pointer over line
 * numbers, widget rows without the library's padding, and the selected-lines
 * highlight in the theme's accent (react-diff-view ships a fixed pale yellow
 * that is unreadable on dark themes).
 */
function generateDiffReviewStyles(theme: Theme): string {
	const accent = theme.colors.accent;
	return `
    .diff-gutter:not(.diff-gutter-omit) { cursor: pointer; user-select: none; }
    .diff-widget-content { padding: 0; }
    .diff-gutter.diff-gutter-selected {
      background-color: color-mix(in srgb, ${accent} 35%, transparent) !important;
      color: ${theme.colors.textMain} !important;
    }
    .diff-code.diff-code-selected {
      background-color: color-mix(in srgb, ${accent} 18%, transparent) !important;
      color: ${theme.colors.textMain} !important;
    }
  `;
}

interface GitDiffViewerProps {
	diffText: string;
	cwd: string;
	theme: Theme;
	onClose: () => void;
	/**
	 * Agent whose diff is shown, named in the header. See GitLogViewer: the cwd
	 * pill alone does not identify the agent. With `enableReview`, it is also
	 * the agent a review left in the viewer is sent to.
	 */
	sessionId?: string;
	/**
	 * Let the user pin comments to diff lines and send them to `sessionId` as
	 * one review. Off for viewers that show a diff no agent produced (Cue
	 * backups) and for terminal-only agents.
	 */
	enableReview?: boolean;
	/**
	 * Default view type when the user has no persisted preference yet. Once the
	 * user toggles the header button, the chosen value is saved to localStorage
	 * and applied to all future GitDiffViewer instances regardless of this prop.
	 */
	initialViewType?: GitDiffViewType;
	/** Optional title shown in the header instead of the default "Git Diff". */
	title?: string;
	/**
	 * Open a file as a preview tab. Given an absolute path and the display name.
	 * When provided, file-path headers become clickable; the viewer dismisses
	 * itself via `onClose` first, then calls this to open the file.
	 */
	onOpenFile?: (absolutePath: string, fileName: string) => void;
	/**
	 * Optional modal-layer priority override. Defaults to GIT_DIFF (200).
	 * Use a higher priority when opening this viewer from inside another
	 * modal so it captures Escape and focus correctly.
	 */
	priority?: number;
}

/** The comment box currently open, if any. `id` is set when editing a saved comment. */
interface CommentEditState {
	anchor: DiffCommentAnchor;
	id?: string;
	initialBody: string;
}

/**
 * Lines picked in the active file, as indexes into its review rows. `anchor`
 * is where the selection started, `focus` where it ends now (the keyboard
 * cursor). `side` is the split-view column it was picked in.
 */
interface LineSelection {
	anchor: number;
	focus: number;
	side?: DiffSide;
}

export const GitDiffViewer = memo(function GitDiffViewer({
	diffText,
	cwd,
	theme,
	onClose,
	initialViewType = 'unified',
	title = 'Git Diff',
	priority,
	sessionId,
	enableReview = false,
	onOpenFile,
}: GitDiffViewerProps) {
	// Name the agent whose repo this is. Subscribe to the name alone, never the
	// Session: these viewers stay open over a streaming agent and a whole-session
	// subscription would re-render the diff list on every unrelated token update.
	const agentName = useSessionStore((s) => s.sessions.find((x) => x.id === sessionId)?.name);

	const [activeTab, setActiveTab] = useState(0);
	const [viewType, setViewType] = useState<GitDiffViewType>(
		() => readStoredViewType() ?? initialViewType
	);
	// The file tab strip scrolls; center the active file in it.
	const tabStripRef = useRevealActiveItem<HTMLDivElement>(activeTab, { align: 'center' });
	const dialogRef = useRef<HTMLDivElement>(null);
	const colorBlindMode = useSettingsStore((s) => s.colorBlindMode);

	// Persist the user's chosen view type so it sticks across all diff views and app restarts.
	useEffect(() => {
		writeStoredViewType(viewType);
	}, [viewType]);

	// Store onClose in ref to avoid re-registering layer on every parent re-render
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	// Parse the diff into separate files
	const parsedFiles = useMemo(() => parseGitDiff(diffText), [diffText]);
	const parsedFilesRef = useRef(parsedFiles);
	parsedFilesRef.current = parsedFiles;

	// Review comments (issue #1475). Pending comments live in diffReviewStore,
	// keyed by repo, so they survive switching file tabs here and even closing
	// the viewer, until the review is sent or discarded.
	const canReview = enableReview && !!sessionId;
	// The same path on two SSH hosts is two repositories, so the remote is part
	// of the key. Subscribe to the id string alone, not the Session.
	const sshRemoteId = useSessionStore((s) => {
		const session = s.sessions.find((x) => x.id === sessionId);
		return session ? resolveGitSshRemoteId(session) : undefined;
	});
	const reviewKey = diffReviewKey(cwd, sshRemoteId);
	const comments = useDiffReviewStore(selectReviewComments(reviewKey));
	// Comments whose lines changed since they were written: kept in the tray,
	// never drawn on a line or sent.
	const outdatedIds = useMemo(
		() => (canReview ? findOutdatedComments(comments, parsedFiles) : NO_OUTDATED),
		[canReview, comments, parsedFiles]
	);
	const sendableCount = comments.length - outdatedIds.size;
	const [selection, setSelection] = useState<LineSelection | null>(null);
	const [editing, setEditing] = useState<CommentEditState | null>(null);
	const editingRef = useRef(editing);
	editingRef.current = editing;
	const selectionRef = useRef(selection);
	selectionRef.current = selection;
	// Text typed into the open comment box. Kept outside React state so a
	// keystroke does not re-render every hunk; read back when the box remounts
	// (switching file tabs and back) so a draft is not lost.
	const draftBodyRef = useRef('');
	const draggingRef = useRef(false);
	const contentRef = useRef<HTMLDivElement>(null);

	const activeFilePath = parsedFiles[activeTab] ? diffFileKey(parsedFiles[activeTab]) : '';
	const activeOldPath = parsedFiles[activeTab]?.oldPath ?? activeFilePath;
	const activeHunks = useMemo(
		() => (parsedFiles[activeTab] ? diffFileHunks(parsedFiles[activeTab]) : []),
		[parsedFiles, activeTab]
	);
	// Rows exist only for a reviewable diff: a read-only viewer (Cue backups)
	// never pays for them.
	const rows = useMemo(
		() => (canReview ? buildReviewRows(activeHunks) : []),
		[canReview, activeHunks]
	);
	const rowIndexByKey = useMemo(() => new Map(rows.map((r, i) => [r.key, i])), [rows]);
	const rowsRef = useRef(rows);
	rowsRef.current = rows;
	const activeFilePathRef = useRef(activeFilePath);
	activeFilePathRef.current = activeFilePath;

	// A line selection belongs to the file it was made in.
	useEffect(() => {
		setSelection(null);
	}, [activeTab]);

	/**
	 * Close the comment box. The ref is cleared at once, not on the next render,
	 * so an unmount in the same tick (Send closes the viewer) does not park a
	 * box that is already gone.
	 */
	const dropEditor = useCallback(() => {
		editingRef.current = null;
		draftBodyRef.current = '';
		setEditing(null);
	}, []);

	// An open comment box belongs to its repository. Closing the viewer (Close,
	// backdrop, Escape with no box open) or pointing it at another repo parks a
	// box with text in it under its repo key; opening that repo's diff again
	// puts it back on its lines. A box whose lines have since changed cannot go
	// back on them, so its text is kept as a comment instead (shown Outdated in
	// the tray) rather than lost.
	useEffect(() => {
		setSelection(null);
		const store = useDiffReviewStore.getState();
		const draft = canReview ? store.takeDraft(reviewKey) : undefined;
		if (!draft) {
			dropEditor();
		} else {
			const probe = { ...draft.anchor, id: '__draft__', body: draft.body };
			const stillFits = !findOutdatedComments([probe], parsedFilesRef.current).size;
			if (stillFits) {
				draftBodyRef.current = draft.body;
				setEditing({ anchor: draft.anchor, id: draft.id, initialBody: draft.initialBody });
				// The viewer opens on its first file; show the one the box is on.
				const fileIndex = parsedFilesRef.current.findIndex(
					(f) => diffFileKey(f) === draft.anchor.file
				);
				if (fileIndex >= 0) setActiveTab(fileIndex);
			} else {
				dropEditor();
				const body = draft.body.trim();
				const exists = (store.commentsByKey[reviewKey] ?? []).some((c) => c.id === draft.id);
				if (body && draft.id && exists) store.updateComment(reviewKey, draft.id, body);
				else if (body) store.addComment(reviewKey, { ...draft.anchor, id: generateId(), body });
				if (body) {
					notifyCenterFlash({
						message: 'The lines your unfinished comment was on have changed',
						detail: 'Its text is kept in the Review tray, marked outdated',
						color: 'yellow',
					});
				}
			}
		}
		return () => {
			const open = editingRef.current;
			const body = draftBodyRef.current;
			const worthKeeping =
				open && (open.id ? body.trim() !== open.initialBody.trim() : body.trim());
			if (open && worthKeeping) {
				useDiffReviewStore.getState().parkDraft(reviewKey, {
					anchor: open.anchor,
					id: open.id,
					initialBody: open.initialBody,
					body,
				});
			}
		};
	}, [canReview, reviewKey, dropEditor]);

	// A discard of this repo's review from anywhere (the tray's Discard, or
	// `maestro-cli diff-review clear`) closes the open box too, so closing the
	// viewer cannot park the discarded text again. Keyed on the repo as well,
	// so switching repos (handled above) is not mistaken for a discard.
	const discardCount = useDiffReviewStore((s) => s.discardsByKey[reviewKey] ?? 0);
	const seenDiscardRef = useRef({ key: reviewKey, count: discardCount });
	useEffect(() => {
		const seen = seenDiscardRef.current;
		seenDiscardRef.current = { key: reviewKey, count: discardCount };
		if (seen.key !== reviewKey || seen.count === discardCount) return;
		dropEditor();
		setSelection(null);
	}, [reviewKey, discardCount, dropEditor]);

	// A line selection is made against one diff; a fresh diff starts without one.
	useEffect(() => {
		setSelection(null);
	}, [diffText]);

	const openEditor = useCallback((next: CommentEditState, draft: string = next.initialBody) => {
		draftBodyRef.current = draft;
		setEditing(next);
	}, []);

	/**
	 * An edit to a SAVED comment that has not been saved yet. Opening another
	 * comment box would throw it away, so that waits until the user saves or
	 * cancels. (Text typed into a NEW comment box is never at risk: picking
	 * other lines moves the box, text and all.)
	 */
	const blockedByUnsavedEdit = useCallback((): boolean => {
		const current = editingRef.current;
		if (!current?.id || draftBodyRef.current.trim() === current.initialBody.trim()) return false;
		notifyCenterFlash({
			message: 'Save or cancel the comment you are editing first',
			color: 'yellow',
		});
		return true;
	}, []);

	/**
	 * Open a new comment box on the current line selection. A new comment box
	 * already open moves to the new lines and keeps what was typed in it.
	 */
	const commentOnSelection = useCallback(() => {
		const sel = selectionRef.current;
		if (!sel || !activeFilePath) return;
		const anchor = anchorForSelection({
			file: activeFilePath,
			oldFile: activeOldPath,
			hunks: activeHunks,
			rows: rowsRef.current,
			anchor: sel.anchor,
			focus: sel.focus,
			clickedSide: sel.side,
		});
		if (!anchor || blockedByUnsavedEdit()) return;
		const carried = editingRef.current && !editingRef.current.id ? draftBodyRef.current : '';
		setSelection(null);
		openEditor({ anchor, initialBody: '' }, carried);
	}, [activeFilePath, activeOldPath, activeHunks, openEditor, blockedByUnsavedEdit]);

	const closeEditor = useCallback(() => {
		dropEditor();
		// Hand the keyboard back to the viewer so the line cursor keeps working.
		dialogRef.current?.focus();
	}, [dropEditor]);

	const saveComment = useCallback(
		(body: string) => {
			const current = editingRef.current;
			const trimmed = body.trim();
			if (!current || !trimmed) return;
			const store = useDiffReviewStore.getState();
			// An edited comment can vanish under the open box (`maestro-cli
			// diff-review remove`); saving it then puts it back rather than
			// dropping what the user typed.
			const stillThere = (store.commentsByKey[reviewKey] ?? []).some((c) => c.id === current.id);
			if (current.id && stillThere) {
				store.updateComment(reviewKey, current.id, trimmed);
			} else {
				store.addComment(reviewKey, { ...current.anchor, id: generateId(), body: trimmed });
			}
			closeEditor();
		},
		[reviewKey, closeEditor]
	);

	const removeComment = useCallback(
		(id: string) => {
			useDiffReviewStore.getState().removeComment(reviewKey, id);
			setEditing((prev) => (prev?.id === id ? null : prev));
		},
		[reviewKey]
	);

	const editComment = useCallback(
		(comment: DiffComment) => {
			if (editingRef.current?.id === comment.id) return;
			// Its lines are gone from the diff, so there is no line to edit it under.
			if (outdatedIds.has(comment.id)) return;
			if (blockedByUnsavedEdit()) return;
			if (editingRef.current && !editingRef.current.id && draftBodyRef.current.trim()) {
				notifyCenterFlash({
					message: 'Add or cancel the new comment first',
					color: 'yellow',
				});
				return;
			}
			const fileIndex = parsedFiles.findIndex((f) => diffFileKey(f) === comment.file);
			if (fileIndex >= 0) setActiveTab(fileIndex);
			openEditor({ anchor: comment, id: comment.id, initialBody: comment.body });
		},
		[parsedFiles, openEditor, blockedByUnsavedEdit, outdatedIds]
	);

	const discardReview = useCallback(() => {
		useDiffReviewStore.getState().clearComments(reviewKey);
		dropEditor();
		setSelection(null);
		dialogRef.current?.focus();
	}, [reviewKey, dropEditor]);

	// Both ways out go through `deliverDiffReview`, which the CLI's `send` also
	// calls: it leaves outdated comments behind, and forgets only what it
	// delivered, so a failed delivery (agent gone, no AI tab) keeps every
	// comment. A comment still open in its box is saved first, so sending never
	// drops what the user just typed.
	const deliverReview = useCallback(
		(mode: DiffReviewDeliveryMode) => {
			if (!canReview || !sessionId) return;
			if (editingRef.current && draftBodyRef.current.trim()) saveComment(draftBodyRef.current);
			const result = deliverDiffReview({
				sessionId,
				key: reviewKey,
				cwd,
				files: parsedFiles,
				mode,
			});
			if (!result.ok) return;
			dropEditor();
			onCloseRef.current();
		},
		[canReview, sessionId, reviewKey, cwd, parsedFiles, saveComment, dropEditor]
	);
	const sendReview = useCallback(() => deliverReview('send'), [deliverReview]);
	const editReviewInComposer = useCallback(() => deliverReview('compose'), [deliverReview]);

	// Mouse: press on a line number to start a selection, drag over more line
	// numbers (or Shift+click one) to extend it within the hunk, release to
	// open the comment box on the lines picked.
	const gutterEvents = useMemo<EventMap>(() => {
		if (!canReview) return {};
		return {
			onMouseDown: ({ change, side }, event) => {
				if (!change || event.button !== 0) return;
				const index = rowIndexByKey.get(getChangeKey(change));
				if (index === undefined) return;
				// Keep the drag from selecting the code text as it goes.
				event.preventDefault();
				draggingRef.current = true;
				// Shift+click extends the selection, or the lines a new comment box
				// is already open on (a plain click opens the box at once).
				const open = editingRef.current;
				const openStart =
					event.shiftKey && open && !open.id && open.anchor.file === activeFilePathRef.current
						? rowIndexByKey.get(open.anchor.changeKeys[0])
						: undefined;
				setSelection((prev) => {
					const start = prev?.anchor ?? openStart;
					if (!event.shiftKey || start === undefined) return { anchor: index, focus: index, side };
					return {
						anchor: start,
						focus: clampToAnchorHunk(rowsRef.current, start, index),
						side: prev?.side ?? open?.anchor.side,
					};
				});
			},
			onMouseEnter: ({ change }) => {
				if (!draggingRef.current || !change) return;
				const index = rowIndexByKey.get(getChangeKey(change));
				if (index === undefined) return;
				setSelection((prev) =>
					prev ? { ...prev, focus: clampToAnchorHunk(rowsRef.current, prev.anchor, index) } : prev
				);
			},
		};
	}, [canReview, rowIndexByKey]);

	// The drag can end anywhere, so the release is heard on the window.
	useEventListener(
		'mouseup',
		() => {
			if (!draggingRef.current) return;
			draggingRef.current = false;
			commentOnSelection();
		},
		{ enabled: canReview }
	);

	// Keep the keyboard cursor on screen as it moves.
	const cursorKey = selection ? rows[selection.focus]?.key : undefined;
	useEffect(() => {
		if (!cursorKey) return;
		const cell = contentRef.current?.querySelector(`[data-change-key="${cursorKey}"]`);
		cell?.scrollIntoView?.({ block: 'nearest' });
	}, [cursorKey]);

	const renderGutter = useCallback<RenderGutter>(
		({ inHoverState, renderDefault }) =>
			inHoverState ? (
				<span className="inline-flex justify-end w-full" title="Comment on this line">
					<MessageSquarePlus className="w-3.5 h-3.5" style={{ color: theme.colors.accent }} />
				</span>
			) : (
				renderDefault()
			),
		[theme.colors.accent]
	);

	// Lines the selection or the open comment box covers, highlighted.
	const selectedChanges = useMemo(() => {
		if (selection) {
			const first = Math.min(selection.anchor, selection.focus);
			const last = Math.max(selection.anchor, selection.focus);
			return rows.slice(first, last + 1).map((r) => r.key);
		}
		if (editing && editing.anchor.file === activeFilePath) return editing.anchor.changeKeys;
		return [];
	}, [selection, editing, rows, activeFilePath]);

	// Saved comments and the open comment box render as widget rows under the
	// last line they cover.
	const widgets = useMemo(() => {
		const result: Record<string, ReactNode> = {};
		if (!canReview || !activeFilePath) return result;
		const lastKey = (anchor: DiffCommentAnchor) => anchor.changeKeys[anchor.changeKeys.length - 1];
		const byKey = new Map<string, DiffComment[]>();
		for (const comment of comments) {
			if (comment.file !== activeFilePath || outdatedIds.has(comment.id)) continue;
			const key = lastKey(comment);
			byKey.set(key, [...(byKey.get(key) ?? []), comment]);
		}
		// A box with no saved comment to draw it in: a new comment, or an edit
		// whose comment was removed under it (`maestro-cli diff-review remove`).
		// Either way it stays on its lines, so the text typed in it survives.
		const editingOrphan = !!editing?.id && !comments.some((c) => c.id === editing.id);
		const newDraftKey =
			editing && (!editing.id || editingOrphan) && editing.anchor.file === activeFilePath
				? lastKey(editing.anchor)
				: null;
		if (newDraftKey && !byKey.has(newDraftKey)) byKey.set(newDraftKey, []);
		const onDraftChange = (body: string) => {
			draftBodyRef.current = body;
		};

		for (const [key, list] of byKey) {
			result[key] = (
				<div className="flex flex-col">
					{list.map((comment) =>
						editing?.id === comment.id ? (
							<ReviewCommentEditor
								key={comment.id}
								theme={theme}
								location={formatCommentLocation(comment)}
								initialBody={draftBodyRef.current}
								isNew={false}
								onDraftChange={onDraftChange}
								onSave={saveComment}
								onCancel={closeEditor}
							/>
						) : (
							<ReviewCommentCard
								key={comment.id}
								theme={theme}
								location={formatCommentLocation(comment)}
								body={comment.body}
								onEdit={() => editComment(comment)}
								onRemove={() => removeComment(comment.id)}
							/>
						)
					)}
					{key === newDraftKey && editing && (
						<ReviewCommentEditor
							key={`new-${editing.anchor.changeKeys.join(',')}`}
							theme={theme}
							location={formatCommentLocation(editing.anchor)}
							initialBody={draftBodyRef.current}
							isNew={!editing.id}
							onDraftChange={onDraftChange}
							onSave={saveComment}
							onCancel={closeEditor}
						/>
					)}
				</div>
			);
		}
		return result;
	}, [
		canReview,
		activeFilePath,
		comments,
		outdatedIds,
		editing,
		theme,
		saveComment,
		closeEditor,
		editComment,
		removeComment,
	]);

	// Dismiss the viewer and open the given repo-relative file as a preview tab.
	const openFileInPreview = (relPath: string) => {
		if (!onOpenFile) return;
		onClose();
		onOpenFile(`${cwd}/${relPath}`, getBasename(relPath));
	};

	// Register layer on mount
	// Note: Using 'modal' type so App.tsx blocks all shortcuts and lets this component
	// handle its own Cmd+Shift+[] for tab navigation
	// Escape peels one review layer at a time: an open comment box first, then
	// a line selection, then the viewer itself.
	useModalLayer(
		priority ?? MODAL_PRIORITIES.GIT_DIFF,
		'Git Diff Preview',
		() => {
			if (editingRef.current) {
				closeEditor();
				return;
			}
			if (selectionRef.current) {
				setSelection(null);
				return;
			}
			onCloseRef.current();
		},
		{
			focusTrap: 'lenient',
		}
	);

	// Review keys. Returns true when the key was handled. Arrows move a line
	// cursor through the active file (Shift extends it into a range within the
	// hunk), C opens a comment box on it, Shift+Cmd+Enter sends the review.
	// Typing in the comment box is never intercepted.
	const handleReviewKey = useCallback(
		(e: KeyboardEvent): boolean => {
			const mod = e.metaKey || e.ctrlKey;
			if (e.key === 'Enter' && mod && e.shiftKey && !e.altKey) {
				const hasDraft = !!editingRef.current && draftBodyRef.current.trim() !== '';
				if (!hasDraft && sendableCount === 0) return false;
				e.preventDefault();
				sendReview();
				trackShortcutUsage('gitDiffSendReview');
				return true;
			}
			if (isEditingTextTarget(e.target) || mod || e.altKey) return false;

			if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
				const count = rowsRef.current.length;
				if (count === 0) return false;
				e.preventDefault();
				const step = e.key === 'ArrowDown' ? 1 : -1;
				const extend = e.shiftKey;
				setSelection((prev) => {
					if (!prev) {
						// First press: land on the first changed line, not hunk context.
						const first = rowsRef.current.findIndex((r) => r.change.type !== 'normal');
						const start = step === 1 ? Math.max(0, first) : count - 1;
						return { anchor: start, focus: start };
					}
					const next = Math.max(0, Math.min(count - 1, prev.focus + step));
					return e.shiftKey
						? { ...prev, focus: clampToAnchorHunk(rowsRef.current, prev.anchor, next) }
						: { anchor: next, focus: next };
				});
				trackShortcutUsage(extend ? 'gitDiffExtendLineSelection' : 'gitDiffMoveLineCursor');
				return true;
			}
			if ((e.key === 'c' || e.key === 'C') && !e.shiftKey && selectionRef.current) {
				e.preventDefault();
				commentOnSelection();
				trackShortcutUsage('gitDiffCommentOnLines');
				return true;
			}
			return false;
		},
		[sendableCount, sendReview, commentOnSelection]
	);

	// Handle keyboard shortcuts (tab navigation + view toggle + review keys)
	useEventListener('keydown', (event) => {
		const e = event as KeyboardEvent;
		if (canReview && handleReviewKey(e)) return;
		// Cmd+[ or Cmd+Shift+[ - Previous tab
		if ((e.metaKey || e.ctrlKey) && e.key === '[') {
			e.preventDefault();
			setActiveTab((prev) => (prev === 0 ? parsedFiles.length - 1 : prev - 1));
		}
		// Cmd+] or Cmd+Shift+] - Next tab
		else if ((e.metaKey || e.ctrlKey) && e.key === ']') {
			e.preventDefault();
			setActiveTab((prev) => (prev + 1) % parsedFiles.length);
		}
		// Enter - Toggle unified / side-by-side. Skip when a focused control
		// (button, link, input, etc.) would otherwise consume Enter, so the
		// toggle button and tab buttons keep their native activation behavior.
		else if (
			e.key === 'Enter' &&
			!e.metaKey &&
			!e.ctrlKey &&
			!e.altKey &&
			!e.shiftKey &&
			!isFormControl(e.target)
		) {
			e.preventDefault();
			setViewType((v) => (v === 'unified' ? 'split' : 'unified'));
		}
	});
	const resizableModal = useResizableModal({
		resizeKey: 'git-diff',
		defaultSize: { width: 1200, height: 760 },
		minSize: { width: 720, height: 480 },
		externalRef: dialogRef,
	});

	useEffect(() => {
		dialogRef.current?.focus();
	}, []);

	if (parsedFiles.length === 0) {
		return (
			<div
				className="fixed inset-0 z-[9999] flex items-center justify-center modal-overlay"
				onClick={onClose}
			>
				<div
					ref={dialogRef}
					className="relative rounded-lg shadow-2xl flex flex-col overflow-hidden outline-none"
					style={{
						...resizableModal.style,
						backgroundColor: theme.colors.bgMain,
						border: `1px solid ${theme.colors.border}`,
					}}
					data-modal-resize-key="git-diff"
					onClick={(e) => e.stopPropagation()}
					role="dialog"
					aria-modal="true"
					aria-label="Git Diff Preview"
					tabIndex={-1}
				>
					<ResizeHandles
						onResizeStart={resizableModal.onResizeStart}
						accentColor={theme.colors.accent}
						onResetSize={resizableModal.onResetSize}
						canReset={resizableModal.canReset}
					/>

					<div
						className="flex items-center justify-between px-6 py-4 border-b"
						style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgSidebar }}
					>
						<div className="flex items-center gap-3 min-w-0">
							<span
								className="text-lg font-semibold shrink-0"
								style={{ color: theme.colors.textMain }}
							>
								{title}
							</span>
							<ModalSubtitle theme={theme} subtitle={agentName} />
						</div>
						<button
							onClick={onClose}
							className="px-3 py-1 rounded text-sm hover:bg-white/10 transition-colors"
							style={{ color: theme.colors.textDim }}
							aria-label="Close diff viewer"
						>
							<span className="hidden md:inline">Close (Esc)</span>
							<span className="md:hidden text-base leading-none">×</span>
						</button>
					</div>
					<div className="flex-1 flex items-center justify-center">
						<p className="text-sm" style={{ color: theme.colors.textDim }}>
							No changes to display
						</p>
					</div>
				</div>
			</div>
		);
	}

	const activeFile = parsedFiles[activeTab];
	const stats = activeFile ? getDiffStats(activeFile.parsedDiff) : { additions: 0, deletions: 0 };

	return (
		<div
			className="fixed inset-0 z-[9999] flex items-center justify-center modal-overlay"
			onClick={onClose}
		>
			<div
				ref={dialogRef}
				className="relative rounded-lg shadow-2xl flex flex-col overflow-hidden outline-none"
				style={{
					...resizableModal.style,
					backgroundColor: theme.colors.bgMain,
					border: `1px solid ${theme.colors.border}`,
				}}
				data-modal-resize-key="git-diff"
				onClick={(e) => e.stopPropagation()}
				role="dialog"
				aria-modal="true"
				aria-label="Git Diff Preview"
				tabIndex={-1}
			>
				<ResizeHandles
					onResizeStart={resizableModal.onResizeStart}
					accentColor={theme.colors.accent}
					onResetSize={resizableModal.onResetSize}
					canReset={resizableModal.canReset}
				/>

				{/* Header */}
				<div
					className="flex items-center justify-between gap-2 px-3 sm:px-6 py-3 sm:py-4 border-b"
					style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgSidebar }}
				>
					<div className="flex items-center gap-3 min-w-0">
						<span
							className="text-lg font-semibold shrink-0"
							style={{ color: theme.colors.textMain }}
						>
							{title}
						</span>
						<ModalSubtitle theme={theme} subtitle={agentName} />
						<span
							className="text-xs px-2 py-1 rounded truncate min-w-0"
							style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}
						>
							{cwd}
						</span>
						{/* File counter hidden on narrow viewports - the per-file tab bar
						    below already shows which file is active and the total count. */}
						<span
							className="hidden md:inline text-xs shrink-0"
							style={{ color: theme.colors.textDim }}
						>
							File {activeTab + 1} of {parsedFiles.length}
						</span>
					</div>
					<div className="flex items-center gap-2 shrink-0">
						{/* Layout toggle hidden on narrow viewports - unified is the only
						    practical view at small widths. */}
						<button
							onClick={() => setViewType((v) => (v === 'unified' ? 'split' : 'unified'))}
							className="hidden md:flex items-center gap-1.5 px-2.5 py-1 rounded text-xs hover:bg-white/10 transition-colors"
							style={{
								color: theme.colors.textDim,
								border: `1px solid ${theme.colors.border}`,
							}}
							aria-label={viewType === 'unified' ? 'Switch to side-by-side' : 'Switch to unified'}
							title={viewType === 'unified' ? 'Switch to side-by-side' : 'Switch to unified'}
						>
							{viewType === 'unified' ? (
								<>
									<Columns2 className="w-3.5 h-3.5" />
									Side-by-side
								</>
							) : (
								<>
									<AlignJustify className="w-3.5 h-3.5" />
									Unified
								</>
							)}
						</button>
						<button
							onClick={onClose}
							className="px-3 py-1 rounded text-sm hover:bg-white/10 transition-colors"
							style={{ color: theme.colors.textDim }}
							aria-label="Close diff viewer"
						>
							<span className="hidden md:inline">Close (Esc)</span>
							<span className="md:hidden text-base leading-none">×</span>
						</button>
					</div>
				</div>

				{/* Tabs */}
				<div
					ref={tabStripRef}
					className="flex gap-0 border-b overflow-x-auto scrollbar-thin"
					style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgSidebar }}
				>
					{parsedFiles.map((file, index) => {
						const fileStats = getDiffStats(file.parsedDiff);
						return (
							<button
								key={file.newPath || file.oldPath || `file-${index}`}
								{...revealActiveProps(activeTab === index)}
								onClick={() => setActiveTab(index)}
								className={`px-4 py-3 text-sm whitespace-nowrap transition-colors ${
									activeTab === index ? 'border-b-2' : 'hover:bg-white/5'
								}`}
								style={{
									color: activeTab === index ? theme.colors.accent : theme.colors.textDim,
									borderColor: activeTab === index ? theme.colors.accent : 'transparent',
									backgroundColor: activeTab === index ? theme.colors.bgMain : 'transparent',
								}}
							>
								<div className="flex items-center gap-2">
									{file.isImage && (
										<ImageIcon className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
									)}
									<span className="font-mono">{getFileName(file.newPath)}</span>
									<div className="flex items-center gap-1 text-xs">
										{file.isBinary ? (
											<span style={{ color: theme.colors.textDim }}>binary</span>
										) : (
											<>
												{fileStats.additions > 0 && (
													<span
														className="flex items-center gap-0.5"
														style={{ color: colorBlindMode ? '#009988' : '#22c55e' }}
													>
														<Plus className="w-3 h-3" />
														{fileStats.additions}
													</span>
												)}
												{fileStats.deletions > 0 && (
													<span
														className="flex items-center gap-0.5"
														style={{ color: colorBlindMode ? '#CC3311' : '#ef4444' }}
													>
														<Minus className="w-3 h-3" />
														{fileStats.deletions}
													</span>
												)}
											</>
										)}
									</div>
								</div>
							</button>
						);
					})}
				</div>

				{/* Diff Content */}
				<div ref={contentRef} className="flex-1 overflow-auto p-6">
					{activeFile && activeFile.isImage ? (
						// Image diff view - side-by-side comparison
						<ImageDiffViewer
							oldPath={activeFile.oldPath}
							newPath={activeFile.newPath}
							cwd={cwd}
							theme={theme}
							isNewFile={activeFile.isNewFile}
							isDeletedFile={activeFile.isDeletedFile}
						/>
					) : activeFile && activeFile.isBinary ? (
						// Non-image binary file
						<div className="flex flex-col items-center justify-center h-full gap-2">
							<p className="text-sm" style={{ color: theme.colors.textDim }}>
								Binary file changed
							</p>
							<p className="text-xs" style={{ color: theme.colors.textDim }}>
								{activeFile.newPath}
							</p>
						</div>
					) : activeFile && activeFile.parsedDiff.length > 0 ? (
						<div className="font-mono text-sm">
							<style>{generateDiffViewStyles(theme, colorBlindMode)}</style>
							{canReview && <style>{generateDiffReviewStyles(theme)}</style>}
							{activeFile.parsedDiff.map((file, fileIndex) => (
								<div key={fileIndex}>
									{/* File header (click to open the file as a preview tab) */}
									<GitFilePathHeader
										theme={theme}
										className="mb-4"
										onOpen={
											onOpenFile && !activeFile.isDeletedFile
												? () => openFileInPreview(activeFile.newPath)
												: undefined
										}
										title={
											activeFile.isDeletedFile
												? undefined
												: `Open ${activeFile.newPath} in a preview tab`
										}
									>
										{file.oldPath} → {file.newPath}
									</GitFilePathHeader>

									{/* Render each hunk */}
									<Diff
										viewType={viewType}
										diffType={file.type}
										hunks={file.hunks}
										widgets={widgets}
										selectedChanges={selectedChanges}
										gutterEvents={gutterEvents}
										renderGutter={canReview ? renderGutter : undefined}
									>
										{(hunks) => hunks.map((hunk) => <Hunk key={hunk.content} hunk={hunk} />)}
									</Diff>
								</div>
							))}
						</div>
					) : (
						<div className="flex items-center justify-center h-full">
							<p className="text-sm" style={{ color: theme.colors.textDim }}>
								Unable to parse diff for this file
							</p>
						</div>
					)}
				</div>

				{canReview && comments.length > 0 && (
					<ReviewTray
						theme={theme}
						comments={comments}
						formatLocation={formatCommentLocation}
						sendKeys={FIXED_SHORTCUTS.gitDiffSendReview.keys}
						outdatedIds={outdatedIds}
						targetName={agentName}
						onEdit={editComment}
						onRemove={removeComment}
						onDiscard={discardReview}
						onSend={sendReview}
						onEditInComposer={editReviewInComposer}
					/>
				)}

				{/* Footer with stats */}
				<div
					className="flex items-center justify-between gap-4 px-6 py-3 border-t text-xs"
					style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgSidebar }}
				>
					<div className="flex items-center gap-4 shrink-0">
						<span className="whitespace-nowrap" style={{ color: theme.colors.textDim }}>
							Current file:{' '}
							<span className="font-mono" style={{ color: theme.colors.textMain }}>
								{getFileName(activeFile.newPath)}
							</span>
						</span>
						{activeFile.isBinary ? (
							<span style={{ color: theme.colors.textDim }}>
								{activeFile.isImage ? 'Image file' : 'Binary file'}
							</span>
						) : (
							<div className="flex items-center gap-2">
								<span
									className="flex items-center gap-1 whitespace-nowrap"
									style={{ color: colorBlindMode ? '#009988' : '#22c55e' }}
								>
									<Plus className="w-3 h-3" />
									{stats.additions} additions
								</span>
								<span
									className="flex items-center gap-1 whitespace-nowrap"
									style={{ color: colorBlindMode ? '#CC3311' : '#ef4444' }}
								>
									<Minus className="w-3 h-3" />
									{stats.deletions} deletions
								</span>
							</div>
						)}
					</div>
					<span className="text-right" style={{ color: theme.colors.textDim }}>
						Press{' '}
						<Keycap theme={theme} className="mx-0.5">
							Enter
						</Keycap>{' '}
						to toggle {viewType === 'unified' ? 'side-by-side' : 'unified'} view
						{canReview && (
							<>
								{' · '}
								<Keycap theme={theme} className="mx-0.5">
									↑↓ C
								</Keycap>{' '}
								or drag line numbers to comment
							</>
						)}
					</span>
				</div>
			</div>
		</div>
	);
});
