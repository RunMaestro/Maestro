/**
 * useFileReview - the File Preview's line review: "Comment on line" from the
 * right-click menu, the comment box and saved comments drawn under their lines
 * in the editor, and the Review tray that sends them all to the agent as one
 * prompt.
 *
 * It is the Git Diff viewer's review on a plain file, built from the same
 * parts: the comment components (`ReviewComments.tsx`), the store shape
 * (`reviewCommentStore.ts`), the prompt shape (`reviewPrompt.ts`) and the
 * delivery (`reviewDelivery.ts`). What is file-specific lives in
 * `utils/fileReviewComments.ts` and `services/fileReview.ts`.
 *
 * Comments are drawn inline in the CodeMirror editor (`commentSlots.ts`).
 * Commenting from a read view switches to the editor with the box open on the
 * chosen lines, the way a GitHub review comments on source lines.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Theme } from '../../types';
import { useSessionStore } from '../../stores/sessionStore';
import { fileReviewKey, useFileReviewStore } from '../../stores/fileReviewStore';
import { selectReviewComments } from '../../stores/reviewCommentStore';
import { canReceiveReview, type ReviewDeliveryMode } from '../../services/reviewDelivery';
import { deliverFileReview, fileReviewPath } from '../../services/fileReview';
import {
	anchorForFileLines,
	findOutdatedFileComments,
	formatFileCommentLocation,
	type FileComment,
	type FileCommentAnchor,
} from '../../utils/fileReviewComments';
import { generateId } from '../../utils/ids';
import { notifyCenterFlash } from '../../stores/centerFlashStore';
import { ReviewCommentCard, ReviewCommentEditor, ReviewTray } from '../ReviewComments';
import type { CommentSlotsPayload } from './markdownEditor/commentSlots';
import type { MarkdownEditorHandle } from './markdownEditor';

/** Slot id of the box for a comment that does not exist yet. */
const NEW_COMMENT_SLOT = '__new-comment__';

interface CommentEditState {
	anchor: FileCommentAnchor;
	/** Set when editing a saved comment. */
	id?: string;
	initialBody: string;
}

export interface UseFileReviewOptions {
	theme: Theme;
	/** Agent the review goes to: the one whose file tab this is. */
	sessionId?: string;
	filePath?: string;
	sshRemoteId?: string;
	/** The text the reviewer is looking at (the editor's, while editing). */
	content: string;
	language: string;
	/** Whether the file can be shown in the editor at all. */
	canEdit: boolean;
	editMode: boolean;
	setEditMode?: (editMode: boolean) => void;
	editorRef: React.RefObject<MarkdownEditorHandle | null>;
}

export interface FileReview {
	/** False for terminal agents, files that cannot be edited, or no owning agent. */
	enabled: boolean;
	/** Open a comment box on these lines (switching to the editor if needed). */
	commentOnLines: (startLine: number, endLine?: number) => void;
	/** Close the open comment box. Returns false when none was open. */
	closeEditor: () => boolean;
	/** True while a comment box is open (the editor should not take focus). */
	isEditingRef: React.MutableRefObject<boolean>;
	/** Slots for `MarkdownEditor.commentSlots`. */
	commentSlots: CommentSlotsPayload | undefined;
	onCommentSlotElement: (id: string, el: HTMLElement | null, previous?: HTMLElement) => void;
	/** Portals into the editor's slots. Render anywhere inside the preview. */
	portals: ReactNode;
	/** The Review tray, or null when there is nothing pending. */
	tray: ReactNode;
}

export function useFileReview({
	theme,
	sessionId,
	filePath,
	sshRemoteId,
	content,
	language,
	canEdit,
	editMode,
	setEditMode,
	editorRef,
}: UseFileReviewOptions): FileReview {
	const session = useSessionStore((s) =>
		sessionId ? s.sessions.find((x) => x.id === sessionId) : undefined
	);
	const agentName = session?.name;
	const agentCwd = session?.cwd;
	const enabled = !!filePath && !!sessionId && canEdit && canReceiveReview(session);
	const key = enabled ? fileReviewKey(sessionId!, filePath!, sshRemoteId) : '';
	const comments = useFileReviewStore(selectReviewComments(key));
	const outdatedIds = useMemo(
		() => findOutdatedFileComments(comments, content),
		[comments, content]
	);

	const [editing, setEditing] = useState<CommentEditState | null>(null);
	const editingRef = useRef(editing);
	editingRef.current = editing;
	const isEditingRef = useRef(false);
	isEditingRef.current = editing !== null;
	// What the open box holds. A slot scrolled out of the editor's viewport is
	// unmounted by CodeMirror, so the typed text has to outlive the component.
	const draftBodyRef = useRef('');
	const contentRef = useRef(content);
	contentRef.current = content;
	const pathForAgent = filePath ? fileReviewPath(filePath, agentCwd) : '';

	const openEditor = useCallback((next: CommentEditState, draft = next.initialBody) => {
		draftBodyRef.current = draft;
		setEditing(next);
	}, []);

	const closeEditor = useCallback((): boolean => {
		if (!editingRef.current) return false;
		draftBodyRef.current = '';
		setEditing(null);
		editorRef.current?.focus();
		return true;
	}, [editorRef]);

	const saveComment = useCallback(
		(body: string) => {
			const current = editingRef.current;
			const text = body.trim();
			if (!current || !text || !key) return;
			const store = useFileReviewStore.getState();
			if (current.id) store.updateComment(key, current.id, text);
			else store.addComment(key, { ...current.anchor, id: generateId(), body: text });
			closeEditor();
		},
		[key, closeEditor]
	);

	/** Keep a box with text in it as a comment before something replaces it. */
	const keepOpenDraft = useCallback(() => {
		const current = editingRef.current;
		if (!current) return;
		const text = draftBodyRef.current.trim();
		if (text && text !== current.initialBody.trim()) saveComment(text);
	}, [saveComment]);

	// Reveal a line once the editor is showing: entering edit mode scrolls the
	// editor to the preview's top line on the next frame, so this waits one more.
	const revealLineRef = useRef<number | null>(null);
	const revealPendingLine = useCallback(() => {
		const line = revealLineRef.current;
		if (line === null || !editorRef.current) return;
		revealLineRef.current = null;
		requestAnimationFrame(() =>
			requestAnimationFrame(() =>
				editorRef.current?.scrollToLine(Math.max(1, line - 3), { select: false })
			)
		);
	}, [editorRef]);
	useEffect(() => {
		if (editMode) revealPendingLine();
	}, [editMode, editing, revealPendingLine]);

	const showInEditor = useCallback(
		(line: number) => {
			revealLineRef.current = line;
			if (editMode) revealPendingLine();
			else setEditMode?.(true);
		},
		[editMode, setEditMode, revealPendingLine]
	);

	const commentOnLines = useCallback(
		(startLine: number, endLine: number = startLine) => {
			if (!enabled) return;
			const anchor = anchorForFileLines({
				content,
				path: pathForAgent,
				startLine,
				endLine,
				language,
			});
			if (!anchor) return;
			keepOpenDraft();
			openEditor({ anchor, initialBody: '' });
			showInEditor(anchor.endLine);
		},
		[enabled, content, pathForAgent, language, keepOpenDraft, openEditor, showInEditor]
	);

	const editComment = useCallback(
		(comment: FileComment) => {
			if (editingRef.current?.id === comment.id) return;
			keepOpenDraft();
			openEditor({ anchor: comment, id: comment.id, initialBody: comment.body });
			showInEditor(comment.endLine);
		},
		[keepOpenDraft, openEditor, showInEditor]
	);

	const removeComment = useCallback(
		(id: string) => {
			if (editingRef.current?.id === id) closeEditor();
			useFileReviewStore.getState().removeComment(key, id);
		},
		[key, closeEditor]
	);

	const discardReview = useCallback(() => {
		useFileReviewStore.getState().clearComments(key);
		closeEditor();
	}, [key, closeEditor]);

	const deliver = useCallback(
		(mode: ReviewDeliveryMode) => {
			if (!enabled) return;
			// A box with text in it is part of the review the user is sending.
			if (editingRef.current && draftBodyRef.current.trim()) saveComment(draftBodyRef.current);
			const result = deliverFileReview({ sessionId: sessionId!, key, content, mode });
			if (!result.ok) {
				notifyCenterFlash({ message: result.error, color: 'orange' });
				return;
			}
			closeEditor();
		},
		[enabled, sessionId, key, content, saveComment, closeEditor]
	);

	// A discard from elsewhere (`maestro-cli file-review clear`) closes the box.
	const discards = useFileReviewStore((s) => (key ? (s.discardsByKey[key] ?? 0) : 0));
	// Remembered per review, so showing another file (a different count) is not
	// mistaken for a discard.
	const discardsSeenRef = useRef({ key, discards });
	useEffect(() => {
		const seen = discardsSeenRef.current;
		discardsSeenRef.current = { key, discards };
		if (seen.key !== key || seen.discards === discards) return;
		draftBodyRef.current = '';
		setEditing(null);
	}, [key, discards]);

	// Park an open box when the tab closes or shows another file, and take it
	// back when this file's review is shown again. A parked box whose lines have
	// changed since is kept as a comment instead (the tray marks it outdated).
	useEffect(() => {
		if (!key) return;
		const store = useFileReviewStore.getState();
		const draft = store.takeDraft(key);
		if (draft) {
			const probe: FileComment = { ...draft.anchor, id: '__draft__', body: draft.body };
			if (findOutdatedFileComments([probe], contentRef.current).size === 0) {
				openEditor(
					{ anchor: draft.anchor, id: draft.id, initialBody: draft.initialBody },
					draft.body
				);
			} else if (draft.body.trim()) {
				const exists = (store.commentsByKey[key] ?? []).some((c) => c.id === draft.id);
				if (draft.id && exists) store.updateComment(key, draft.id, draft.body.trim());
				else store.addComment(key, { ...draft.anchor, id: generateId(), body: draft.body.trim() });
			}
		}
		return () => {
			const current = editingRef.current;
			const body = draftBodyRef.current;
			if (current && body.trim()) {
				useFileReviewStore.getState().parkDraft(key, {
					anchor: current.anchor,
					id: current.id,
					initialBody: current.initialBody,
					body,
				});
			}
			draftBodyRef.current = '';
			setEditing(null);
		};
	}, [key, openEditor]);

	// ---- Inline slots in the editor -----------------------------------------

	const commentSlots = useMemo<CommentSlotsPayload | undefined>(() => {
		if (!enabled) return undefined;
		const slots = comments
			.filter((c) => !outdatedIds.has(c.id))
			.map((c) => ({ id: c.id, startLine: c.startLine, endLine: c.endLine }));
		if (editing && !editing.id) {
			slots.push({
				id: NEW_COMMENT_SLOT,
				startLine: editing.anchor.startLine,
				endLine: editing.anchor.endLine,
			});
		}
		// Translucent, not blended: CodeMirror draws the selection in a layer
		// BEHIND the lines, so an opaque tint would hide a selection on them.
		return { slots, lineColor: `${theme.colors.accent}1f` };
	}, [enabled, comments, outdatedIds, editing, theme.colors.accent]);

	const [slotElements, setSlotElements] = useState<Record<string, HTMLElement>>({});
	const onCommentSlotElement = useCallback(
		(id: string, el: HTMLElement | null, previous?: HTMLElement) => {
			setSlotElements((prev) => {
				if (el) return prev[id] === el ? prev : { ...prev, [id]: el };
				// A slot rebuilt in place hands over its new element before the old
				// one is destroyed; only forget the element that is going away.
				if (!(id in prev) || (previous && prev[id] !== previous)) return prev;
				const { [id]: _gone, ...rest } = prev;
				return rest;
			});
		},
		[]
	);

	const onDraftChange = useCallback((body: string) => {
		draftBodyRef.current = body;
	}, []);

	const portals = useMemo(() => {
		if (!enabled) return null;
		const out: ReactNode[] = [];
		const editorFor = (anchor: FileCommentAnchor, isNew: boolean, slotKey: string) => (
			<ReviewCommentEditor
				key={slotKey}
				theme={theme}
				location={formatFileCommentLocation(anchor)}
				initialBody={draftBodyRef.current}
				isNew={isNew}
				onDraftChange={onDraftChange}
				onSave={saveComment}
				onCancel={closeEditor}
				cancelOnEscape
			/>
		);
		for (const comment of comments) {
			const el = slotElements[comment.id];
			if (!el || outdatedIds.has(comment.id)) continue;
			const node =
				editing?.id === comment.id ? (
					editorFor(comment, false, `edit-${comment.id}`)
				) : (
					<ReviewCommentCard
						theme={theme}
						location={formatFileCommentLocation(comment)}
						body={comment.body}
						onEdit={() => editComment(comment)}
						onRemove={() => removeComment(comment.id)}
					/>
				);
			out.push(createPortal(node, el, comment.id));
		}
		const newEl = slotElements[NEW_COMMENT_SLOT];
		if (editing && !editing.id && newEl) {
			out.push(
				createPortal(
					editorFor(
						editing.anchor,
						true,
						`new-${editing.anchor.startLine}-${editing.anchor.endLine}`
					),
					newEl,
					NEW_COMMENT_SLOT
				)
			);
		}
		return out;
	}, [
		enabled,
		comments,
		outdatedIds,
		slotElements,
		editing,
		theme,
		onDraftChange,
		saveComment,
		closeEditor,
		editComment,
		removeComment,
	]);

	const tray =
		enabled && comments.length > 0 ? (
			<ReviewTray
				theme={theme}
				comments={comments}
				formatLocation={formatFileCommentLocation}
				outdatedIds={outdatedIds}
				targetName={agentName}
				onEdit={editComment}
				onRemove={removeComment}
				onDiscard={discardReview}
				onSend={() => deliver('send')}
				onEditInComposer={() => deliver('compose')}
			/>
		) : null;

	return {
		enabled,
		commentOnLines,
		closeEditor,
		isEditingRef,
		commentSlots,
		onCommentSlotElement,
		portals,
		tray,
	};
}
