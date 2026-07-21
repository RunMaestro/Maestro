import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
	X,
	KanbanSquare,
	Plus,
	Trash2,
	RefreshCw,
	ChevronLeft,
	Square,
	Pencil,
	Check,
} from 'lucide-react';
import type { Theme } from '../types';
import type { AgentProfile } from '../../shared/profiles/types';
import type { Board, BoardCard, CardPriority, CardStatus } from '../../shared/board/types';
import { CARD_PRIORITIES, CARD_STATUSES } from '../../shared/board/types';
import { getBlockers, hasCycle } from '../../shared/board/graph';
import { isPathWithin } from '../../shared/board/pool';
import { buildCardWorktreeRef } from '../../shared/board/worktree';
import { useModalLayer } from '../hooks/ui/useModalLayer';
import { useFocusAfterRender } from '../hooks/utils/useFocusAfterRender';
import { ConfirmModal } from './ConfirmModal';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { useSessionStore, selectActiveSession } from '../stores/sessionStore';
import { getModalActions } from '../stores/modalStore';
import { notifyToast } from '../stores/notificationStore';
import { generateUUID } from '../../shared/uuid';
import { formatElapsedTime } from '../../shared/formatters';
import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';
import { triggerHaptic, HAPTIC_PATTERNS, isCoarsePointer } from '../utils/touch';

export interface BoardModalProps {
	theme: Theme;
	onClose: () => void;
}

/** How long (ms) a tile's delete button stays armed before it disarms itself. */
const DELETE_DISARM_MS = 4000;

/** Id of the modal title, referenced by `aria-labelledby` on the dialog. */
const TITLE_ID = 'board-modal-title';

/**
 * Per-project "last board I had open" memory. A pure UI preference, so it lives
 * in localStorage next to the other view-state keys (Git diff view mode, History
 * filters) rather than becoming a real synced setting.
 */
const LAST_BOARD_KEY_PREFIX = 'maestro.board.lastBoardId:';

function readLastBoardId(projectRoot: string): string | null {
	try {
		return window.localStorage.getItem(LAST_BOARD_KEY_PREFIX + projectRoot);
	} catch {
		// localStorage can throw in private mode or when full - non-fatal here.
		return null;
	}
}

function writeLastBoardId(projectRoot: string, boardId: string): void {
	try {
		window.localStorage.setItem(LAST_BOARD_KEY_PREFIX + projectRoot, boardId);
	} catch {
		// Losing the preference is acceptable; failing the render is not.
	}
}

/** Column presentation: label + which theme color keys the status. The columns
 * are a *view* of `card.status`; the DAG + dispatcher are the engine. */
const STATUS_META: Record<CardStatus, { label: string; colorKey: keyof Theme['colors'] }> = {
	triage: { label: 'Triage', colorKey: 'textDim' },
	todo: { label: 'To Do', colorKey: 'textMain' },
	ready: { label: 'Ready', colorKey: 'success' },
	running: { label: 'Running', colorKey: 'warning' },
	blocked: { label: 'Blocked', colorKey: 'error' },
	done: { label: 'Done', colorKey: 'success' },
};

/** Priority presentation. `normal` carries no badge - only the exceptions are
 * worth pixels on a tile. */
const PRIORITY_META: Record<
	CardPriority,
	{ label: string; badge: string | null; hint: string; colorKey: keyof Theme['colors'] }
> = {
	high: { label: 'High', badge: 'high', hint: 'claimed before normal cards', colorKey: 'error' },
	normal: { label: 'Normal', badge: null, hint: 'default dispatch order', colorKey: 'textDim' },
	low: { label: 'Low', badge: 'low', hint: 'claimed after normal cards', colorKey: 'textDim' },
};

/** Draft shape for the card editor (before it becomes a persisted BoardCard). */
interface CardDraft {
	id: string | null; // null = new card
	title: string;
	body: string;
	assigneeProfileId: string; // '' = no role (float to pool, or pin an agent below)
	assigneeAgentId: string; // '' = not pinned; else a specific agent runs this card
	parents: string[];
	priority: CardPriority;
	/** "Run in isolated worktree" (Phase 4). The two fields below are optional
	 * overrides of the conventional branch/path derived from the board + card id. */
	worktreeEnabled: boolean;
	worktreePath: string;
	worktreeBranch: string;
	status: CardStatus;
	createdAt?: string;
}

/**
 * Board modal: a visual kanban surface over the persistent task DAG stored in
 * `.maestro/board.yaml` (Phase 2 IPC). Six columns render the card `status`;
 * the dispatcher (Phase 3) moves cards automatically, and manual drag-to-move
 * overrides its status via `setCardStatus`.
 *
 * Keyboard parity with the mouse (Phase 6): tiles are focusable, arrows walk the
 * grid, Enter opens a card, `m` jumps to the editor's "Move to" picker, and
 * Delete (twice) removes one. Native HTML5 drag-and-drop stays for pointer users
 * rather than being reimplemented as an ARIA drag surface.
 *
 * Click-driven, so the root is `select-none`; the card-body detail view opts
 * back into text selection with `select-text` (per the CLAUDE.md modal rule).
 */
export function BoardModal({ theme, onClose }: BoardModalProps) {
	const activeSession = useSessionStore(selectActiveSession);
	const projectRoot = activeSession?.projectRoot ?? '';
	const allSessions = useSessionStore((s) => s.sessions);

	// Board Phase 6: agents living in this board's project dir (or a sub-folder)
	// are pin candidates. A card may pin any of them; role-only cards float to
	// the opt-in worker subset (the `boardWorker` toggle, enforced at dispatch).
	const projectAgents = useMemo(
		() =>
			allSessions
				.filter((s) => isPathWithin(projectRoot, s.projectRoot || s.cwd))
				.map((s) => ({ id: s.id, name: s.name, isWorker: s.boardWorker === true })),
		[allSessions, projectRoot]
	);
	// Worker agents are Left Bar agents (session ids), so the name comes from the
	// session store - NOT from getAgentDisplayName(), which maps agent *type* ids
	// ('claude-code' -> 'Claude Code'). Falls back to the raw id for an agent that
	// has since been deleted.
	const agentName = useCallback(
		(id: string) => projectAgents.find((a) => a.id === id)?.name ?? id,
		[projectAgents]
	);

	const [boards, setBoards] = useState<Board[]>([]);
	const [selectedBoardId, setSelectedBoardId] = useState<string | null>(null);
	const [profiles, setProfiles] = useState<AgentProfile[]>([]);
	const [loading, setLoading] = useState(true);
	const [creatingBoard, setCreatingBoard] = useState(false);
	const [dragCardId, setDragCardId] = useState<string | null>(null);
	const [dragOverStatus, setDragOverStatus] = useState<CardStatus | null>(null);

	// Board lifecycle UI (Phase 6): inline rename + delete confirmation.
	const [renaming, setRenaming] = useState(false);
	const [renameValue, setRenameValue] = useState('');
	const [pendingBoardDelete, setPendingBoardDelete] = useState(false);

	// Editor state: null = board view, otherwise the card editor is showing.
	const [draft, setDraft] = useState<CardDraft | null>(null);
	const [cycleError, setCycleError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	/** Set when the editor was opened with `m`, so it lands on the Move to picker. */
	const [focusMovePicker, setFocusMovePicker] = useState(false);
	/** The draft exactly as the editor opened it, for the unsaved-changes check. */
	const draftBaselineRef = useRef<CardDraft | null>(null);
	/** Which close the user asked for while the editor was dirty, pending confirm. */
	const [pendingDiscard, setPendingDiscard] = useState<null | 'editor' | 'modal'>(null);

	const board = useMemo(
		() => boards.find((b) => b.id === selectedBoardId) ?? boards[0] ?? null,
		[boards, selectedBoardId]
	);

	// Cheap structural compare: the draft is a flat object of primitives plus a
	// string array, so serializing both sides is simpler (and less bug-prone) than
	// a hand-written field-by-field diff.
	const isDraftDirty = useMemo(
		() => !!draft && JSON.stringify(draft) !== JSON.stringify(draftBaselineRef.current),
		[draft]
	);

	const selectedBoardIdRef = useRef<string | null>(null);
	selectedBoardIdRef.current = selectedBoardId;

	const profileName = useCallback(
		(id: string) => profiles.find((p) => p.id === id)?.name ?? id,
		[profiles]
	);

	// Load every board for the project plus the profiles that back card
	// assignees. Reused by the push listener and by explicit refresh.
	const load = useCallback(
		async (showSpinner = true) => {
			if (!projectRoot) {
				setBoards([]);
				setProfiles([]);
				setLoading(false);
				return;
			}
			if (showSpinner) setLoading(true);
			try {
				const [boardList, profileList] = await Promise.all([
					window.maestro.board.list(projectRoot),
					window.maestro.profiles.list(projectRoot),
				]);
				setProfiles(profileList);
				setBoards(boardList);
				// Keep the currently-open board if it still exists, else the one this
				// project was last left on, else the first.
				const current = selectedBoardIdRef.current;
				const remembered = readLastBoardId(projectRoot);
				const next =
					boardList.find((b) => b.id === current) ??
					boardList.find((b) => b.id === remembered) ??
					boardList[0] ??
					null;
				setSelectedBoardId(next?.id ?? null);
			} catch (err) {
				logger.error(`Failed to load board: ${String(err)}`);
				if (showSpinner) {
					// A corrupt board.yaml / profiles.yaml now fails closed in the main
					// process instead of loading as empty, so surface the real reason -
					// the user has to repair the file by hand. Only reported on an
					// explicit load: a push-driven refresh would otherwise re-report the
					// same user-data problem on every write.
					captureException(err, { tags: { operation: 'board:list' } });
					notifyToast({
						color: 'red',
						title: 'Board',
						message: `Failed to load board: ${err instanceof Error ? err.message : String(err)}`,
						dismissible: true,
					});
				}
			} finally {
				if (showSpinner) setLoading(false);
			}
		},
		[projectRoot]
	);

	useEffect(() => {
		void load(true);
	}, [load]);

	// Remember the selection so reopening the Board lands on the same one.
	useEffect(() => {
		if (projectRoot && selectedBoardId) writeLastBoardId(projectRoot, selectedBoardId);
	}, [projectRoot, selectedBoardId]);

	// Live updates: the main process pushes `board:changed` after every
	// `.maestro/board.yaml` write (dispatcher tick, IPC mutation, auto-decompose),
	// so dispatcher-driven status changes surface without a timer. The refresh runs
	// while the card editor is open too - the draft is separate state, so only the
	// board behind the editor is reconciled and in-progress edits survive.
	useEffect(() => {
		if (!projectRoot) return;
		return window.maestro.board.onBoardChanged?.((payload) => {
			if (payload?.projectRoot !== projectRoot) return;
			void load(false);
		});
	}, [projectRoot, load]);

	const handleCreateBoard = useCallback(async () => {
		if (!projectRoot || creatingBoard) return;
		setCreatingBoard(true);
		try {
			// First board takes the agent's name; later ones are numbered and the
			// rename field opens straight away so the user can say what it is.
			const name =
				boards.length > 0
					? `Board ${boards.length + 1}`
					: activeSession?.name
						? `${activeSession.name} Board`
						: 'Board';
			const created = await window.maestro.board.create(projectRoot, name);
			setBoards((prev) => [...prev.filter((b) => b.id !== created.id), created]);
			setSelectedBoardId(created.id);
			if (boards.length > 0) {
				setRenameValue(created.name);
				setRenaming(true);
			}
		} catch (err) {
			logger.error(`Failed to create board: ${String(err)}`);
			captureException(err, { tags: { operation: 'board:create' } });
			notifyToast({ color: 'red', title: 'Board', message: 'Failed to create board.' });
		} finally {
			setCreatingBoard(false);
		}
	}, [projectRoot, creatingBoard, activeSession?.name, boards.length]);

	const startRename = useCallback(() => {
		if (!board) return;
		setRenameValue(board.name);
		setRenaming(true);
	}, [board]);

	const commitRename = useCallback(async () => {
		const name = renameValue.trim();
		setRenaming(false);
		if (!board || !projectRoot || !name || name === board.name) return;
		try {
			const updated = await window.maestro.board.rename(projectRoot, board.id, name);
			setBoards((prev) => prev.map((b) => (b.id === updated.id ? updated : b)));
		} catch (err) {
			logger.error(`Failed to rename board: ${String(err)}`);
			captureException(err, { tags: { operation: 'board:rename' } });
			notifyToast({ color: 'red', title: 'Board', message: 'Failed to rename the board.' });
		}
	}, [renameValue, board, projectRoot]);

	/** Cards that would be destroyed by deleting the board (the CLI's warning). */
	const openBoardCards = useMemo(
		() => (board ? board.cards.filter((c) => c.status !== 'done').length : 0),
		[board]
	);

	const handleDeleteBoard = useCallback(async () => {
		if (!board || !projectRoot) return;
		try {
			// The confirm dialog IS the acknowledgment the CLI asks for with --force.
			const remaining = await window.maestro.board.delete(projectRoot, board.id, true);
			setBoards(remaining);
			setSelectedBoardId(remaining[0]?.id ?? null);
			notifyToast({ color: 'green', title: 'Board', message: `Deleted "${board.name}".` });
		} catch (err) {
			logger.error(`Failed to delete board: ${String(err)}`);
			captureException(err, { tags: { operation: 'board:delete' } });
			notifyToast({ color: 'red', title: 'Board', message: 'Failed to delete the board.' });
		}
	}, [board, projectRoot]);

	// --- Card editor -------------------------------------------------------

	const openNewCard = useCallback(() => {
		setCycleError(null);
		setFocusMovePicker(false);
		const fresh: CardDraft = {
			id: null,
			title: '',
			body: '',
			assigneeProfileId: profiles[0]?.id ?? '',
			assigneeAgentId: '',
			parents: [],
			priority: 'normal',
			worktreeEnabled: false,
			worktreePath: '',
			worktreeBranch: '',
			status: 'todo',
		};
		draftBaselineRef.current = fresh;
		setDraft(fresh);
	}, [profiles]);

	const openEditCard = useCallback((card: BoardCard, focusMove = false) => {
		setCycleError(null);
		setFocusMovePicker(focusMove);
		const existing: CardDraft = {
			id: card.id,
			title: card.title,
			body: card.body,
			assigneeProfileId: card.assigneeProfileId ?? '',
			assigneeAgentId: card.assigneeAgentId ?? '',
			parents: [...card.parents],
			priority: card.priority ?? 'normal',
			worktreeEnabled: !!card.worktree,
			worktreePath: card.worktree?.path ?? '',
			worktreeBranch: card.worktree?.branch ?? '',
			status: card.status,
			createdAt: card.createdAt,
		};
		draftBaselineRef.current = existing;
		setDraft(existing);
	}, []);

	const closeEditor = useCallback(() => {
		setDraft(null);
		setCycleError(null);
		setFocusMovePicker(false);
		draftBaselineRef.current = null;
		setPendingDiscard(null);
	}, []);

	/** "Back to board" / Cancel: keep unsaved edits until the user confirms. */
	const requestCloseEditor = useCallback(() => {
		if (isDraftDirty) {
			setPendingDiscard('editor');
			return;
		}
		closeEditor();
	}, [isDraftDirty, closeEditor]);

	/**
	 * Escape. An open rename field takes it first (the layer stack listens on
	 * window in the capture phase, so the input cannot swallow it locally).
	 * Otherwise it closes the whole modal, asking first when the editor holds
	 * unsaved edits.
	 */
	const handleEscape = useCallback(() => {
		if (renaming) {
			setRenaming(false);
			return;
		}
		if (isDraftDirty) {
			setPendingDiscard('modal');
			return;
		}
		onClose();
	}, [renaming, isDraftDirty, onClose]);

	useModalLayer(MODAL_PRIORITIES.BOARD_MODAL, 'Board', handleEscape);

	// Initial focus lands on the dialog itself so Tab starts inside the modal and
	// screen readers announce it. One-shot: the ref flips after mount, so a later
	// render never yanks focus back off a tile the user arrowed to.
	const dialogRef = useRef<HTMLDivElement>(null);
	const initialFocusDone = useRef(false);
	useFocusAfterRender(dialogRef, !initialFocusDone.current);
	useEffect(() => {
		initialFocusDone.current = true;
	}, []);

	const handleConfirmDiscard = useCallback(() => {
		const target = pendingDiscard;
		closeEditor();
		if (target === 'modal') onClose();
	}, [pendingDiscard, closeEditor, onClose]);

	const toggleParent = useCallback((parentId: string) => {
		setCycleError(null);
		setDraft((prev) => {
			if (!prev) return prev;
			const has = prev.parents.includes(parentId);
			return {
				...prev,
				parents: has ? prev.parents.filter((p) => p !== parentId) : [...prev.parents, parentId],
			};
		});
	}, []);

	const canSaveDraft = useMemo(
		() =>
			!!draft &&
			!!projectRoot &&
			!!board &&
			draft.title.trim().length > 0 &&
			// Phase 6: a card needs an assignee - a role (profile) and/or a pinned agent.
			(draft.assigneeProfileId.length > 0 || draft.assigneeAgentId.length > 0) &&
			!saving,
		[draft, projectRoot, board, saving]
	);

	/** Replace one board in the list (every card mutation returns the whole board). */
	const applyBoard = useCallback((updated: Board) => {
		setBoards((prev) =>
			prev.some((b) => b.id === updated.id)
				? prev.map((b) => (b.id === updated.id ? updated : b))
				: [...prev, updated]
		);
	}, []);

	const handleSaveCard = useCallback(async () => {
		if (!draft || !board || !projectRoot || !canSaveDraft) return;

		const now = new Date().toISOString();
		const cardId = draft.id ?? generateUUID();
		// Phase 4: the toggle expresses intent; blank path/branch fields fall back
		// to the conventional `board/<board>/<card>` naming the CLI and dispatcher
		// derive from the same helper, so an isolated card is predictable.
		const autoWorktree = buildCardWorktreeRef(projectRoot, board.id, cardId);
		const card: BoardCard = {
			id: cardId,
			title: draft.title.trim(),
			body: draft.body,
			parents: draft.parents,
			status: draft.status,
			createdAt: draft.createdAt ?? now,
			updatedAt: now,
			// Assignee: a role (profile) and/or a pinned agent. Omit blank fields so
			// a role-only card floats to the worker pool and a pinned card carries
			// no stale profile id.
			...(draft.assigneeProfileId ? { assigneeProfileId: draft.assigneeProfileId } : {}),
			...(draft.assigneeAgentId ? { assigneeAgentId: draft.assigneeAgentId } : {}),
			// `normal` is the default and is never serialized.
			...(draft.priority !== 'normal' ? { priority: draft.priority } : {}),
			...(draft.worktreeEnabled
				? {
						worktree: {
							path: draft.worktreePath.trim() || autoWorktree.path,
							branch: draft.worktreeBranch.trim() || autoWorktree.branch,
						},
					}
				: {}),
		};

		// Client-side cycle guard: build the prospective board and reject before
		// the IPC round-trip so the user gets an immediate inline error (the
		// storage layer also rejects cycles as a backstop).
		const otherCards = board.cards.filter((c) => c.id !== card.id);
		const prospective: Board = { ...board, cards: [...otherCards, card] };
		if (hasCycle(prospective)) {
			setCycleError(
				'This parent selection would create a dependency cycle. Remove a parent and try again.'
			);
			return;
		}

		setSaving(true);
		try {
			const isNew = draft.id === null;
			const updated = isNew
				? await window.maestro.board.addCard(projectRoot, board.id, card)
				: await window.maestro.board.updateCard(projectRoot, board.id, card);
			applyBoard(updated);
			closeEditor();
			notifyToast({
				color: 'green',
				title: 'Board',
				message: isNew ? `Created "${card.title}".` : `Updated "${card.title}".`,
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			logger.error(`Failed to save card: ${message}`);
			captureException(err, { tags: { operation: 'board:saveCard' } });
			// The storage layer rejects cycles too - surface that inline rather than
			// as a generic toast.
			if (/cycl/i.test(message)) {
				setCycleError('This parent selection would create a dependency cycle.');
			} else {
				notifyToast({ color: 'red', title: 'Board', message: 'Failed to save card.' });
			}
		} finally {
			setSaving(false);
		}
	}, [draft, board, projectRoot, canSaveDraft, closeEditor, applyBoard]);

	const handleDeleteCard = useCallback(
		async (cardId: string) => {
			if (!board || !projectRoot) return;
			try {
				const updated = await window.maestro.board.deleteCard(projectRoot, board.id, cardId);
				applyBoard(updated);
				if (draft?.id === cardId) closeEditor();
			} catch (err) {
				logger.error(`Failed to delete card: ${String(err)}`);
				captureException(err, { tags: { operation: 'board:deleteCard' } });
				notifyToast({ color: 'red', title: 'Board', message: 'Failed to delete card.' });
			}
		},
		[board, projectRoot, draft?.id, closeEditor, applyBoard]
	);

	const handleCancelCard = useCallback(
		async (cardId: string) => {
			if (!board || !projectRoot) return;
			try {
				const updated = await window.maestro.board.cancelCard(projectRoot, board.id, cardId);
				applyBoard(updated);
				notifyToast({
					color: 'orange',
					title: 'Board',
					message: 'Stopped the run. The card is back in To Do.',
				});
			} catch (err) {
				logger.error(`Failed to cancel card: ${String(err)}`);
				captureException(err, { tags: { operation: 'board:cancelCard' } });
				notifyToast({ color: 'red', title: 'Board', message: 'Failed to stop the card.' });
			}
		},
		[board, projectRoot, applyBoard]
	);

	// --- Moving cards (drag for pointers, "Move to" picker for keyboards) ----

	/**
	 * Persist a manual status override, with the same guards the drop target
	 * used to carry. Returns true when the card actually moved.
	 */
	const moveCard = useCallback(
		async (cardId: string, status: CardStatus): Promise<boolean> => {
			if (!board || !projectRoot) return false;
			const card = board.cards.find((c) => c.id === cardId);
			// No-op when it is already there.
			if (!card || card.status === status) return false;
			// Moving a running card used to rewrite the status in YAML while the agent
			// process kept running - the card looked stopped and wasn't. Stopping a run
			// is an explicit action now (the stop button), so refuse and say why.
			if (card.status === 'running') {
				notifyToast({
					color: 'orange',
					title: 'Board',
					message:
						'This card is running. Use the stop button on the card to end the run before moving it.',
				});
				return false;
			}
			// `ready` and `running` are derived by the dispatcher, so the main
			// process rejects them. Catch it here too, before the optimistic move,
			// so the card doesn't visibly jump columns and snap back.
			if (status === 'ready' || status === 'running') {
				notifyToast({
					color: 'orange',
					title: 'Board',
					message: `"${STATUS_META[status].label}" is set by the dispatcher. Move the card to "To Do" - it is promoted once its parents are done.`,
				});
				return false;
			}
			if (isCoarsePointer()) triggerHaptic(HAPTIC_PATTERNS.tap);
			// Optimistic move so the card jumps immediately; the reload below
			// corrects it if the write fails.
			applyBoard({
				...board,
				cards: board.cards.map((c) => (c.id === cardId ? { ...c, status } : c)),
			});
			try {
				const updated = await window.maestro.board.setCardStatus(
					projectRoot,
					board.id,
					cardId,
					status
				);
				applyBoard(updated);
				return true;
			} catch (err) {
				logger.error(`Failed to move card: ${String(err)}`);
				captureException(err, { tags: { operation: 'board:setCardStatus' } });
				notifyToast({ color: 'red', title: 'Board', message: 'Failed to move card.' });
				void load(false);
				return false;
			}
		},
		[board, projectRoot, load, applyBoard]
	);

	const handleDrop = useCallback(
		async (status: CardStatus) => {
			const cardId = dragCardId;
			setDragCardId(null);
			setDragOverStatus(null);
			if (!cardId) return;
			await moveCard(cardId, status);
		},
		[dragCardId, moveCard]
	);

	/** Editor "Move to" picker: persists immediately, like a drop would. */
	const handleMoveDraft = useCallback(
		async (status: CardStatus) => {
			if (!draft?.id) return;
			const moved = await moveCard(draft.id, status);
			if (!moved) return;
			// Keep the draft (and its dirty baseline) in step so the picker shows the
			// new column and the move does not read as an unsaved edit.
			setDraft((prev) => (prev ? { ...prev, status } : prev));
			if (draftBaselineRef.current) {
				draftBaselineRef.current = { ...draftBaselineRef.current, status };
			}
		},
		[draft?.id, moveCard]
	);

	const inputStyle = {
		backgroundColor: theme.colors.bgActivity,
		border: `1px solid ${theme.colors.border}`,
		color: theme.colors.textMain,
	} as const;

	const cardsByStatus = useMemo(() => {
		const map = new Map<CardStatus, BoardCard[]>();
		for (const status of CARD_STATUSES) map.set(status, []);
		for (const card of board?.cards ?? []) {
			map.get(card.status)?.push(card);
		}
		return map;
	}, [board]);

	// --- Keyboard grid navigation -------------------------------------------

	/** Live tile elements, keyed by card id, so navigation can move DOM focus. */
	const tileRefs = useRef(new Map<string, HTMLDivElement>());
	const registerTile = useCallback((cardId: string, el: HTMLDivElement | null) => {
		if (el) tileRefs.current.set(cardId, el);
		else tileRefs.current.delete(cardId);
	}, []);

	/**
	 * Arrow-key movement across the kanban grid: up/down within a column, left/
	 * right to the nearest non-empty neighbouring column (clamping the row).
	 */
	const navigateTiles = useCallback(
		(fromStatus: CardStatus, fromIndex: number, key: string) => {
			if (key === 'ArrowUp' || key === 'ArrowDown') {
				const cards = cardsByStatus.get(fromStatus) ?? [];
				const nextIndex = key === 'ArrowDown' ? fromIndex + 1 : fromIndex - 1;
				const target = cards[nextIndex];
				if (target) tileRefs.current.get(target.id)?.focus();
				return;
			}
			const step = key === 'ArrowRight' ? 1 : -1;
			const from = CARD_STATUSES.indexOf(fromStatus);
			for (let i = from + step; i >= 0 && i < CARD_STATUSES.length; i += step) {
				const cards = cardsByStatus.get(CARD_STATUSES[i]) ?? [];
				if (cards.length === 0) continue;
				const target = cards[Math.min(fromIndex, cards.length - 1)];
				tileRefs.current.get(target.id)?.focus();
				return;
			}
		},
		[cardsByStatus]
	);

	return createPortal(
		<div
			className="fixed inset-0 flex items-center justify-center select-none"
			style={{ zIndex: MODAL_PRIORITIES.BOARD_MODAL }}
			onClick={(e) => {
				// Same guard as Escape: a backdrop click must not silently drop edits.
				if (e.target === e.currentTarget) handleEscape();
			}}
		>
			<div className="absolute inset-0 bg-black/50" />

			<div
				ref={dialogRef}
				role="dialog"
				aria-modal="true"
				aria-labelledby={TITLE_ID}
				tabIndex={-1}
				className="relative rounded-xl shadow-2xl flex flex-col outline-none"
				style={{
					width: '94vw',
					maxWidth: 1200,
					height: '88vh',
					maxHeight: 860,
					backgroundColor: theme.colors.bgMain,
					border: `1px solid ${theme.colors.border}`,
				}}
			>
				{/* Header */}
				<div
					className="shrink-0 flex items-center justify-between px-5 py-4 border-b gap-3"
					style={{ borderColor: theme.colors.border }}
				>
					<div className="flex items-center gap-2 min-w-0">
						<KanbanSquare className="w-5 h-5 shrink-0" style={{ color: theme.colors.accent }} />
						<h2
							id={TITLE_ID}
							className="text-base font-bold truncate"
							style={{ color: theme.colors.textMain }}
						>
							{board ? board.name : 'Board'}
						</h2>
						{/* Board switcher (Phase 6). Hidden while renaming, which swaps in
						    the name field in its place. */}
						{board && !renaming && (
							<select
								value={board.id}
								onChange={(e) => setSelectedBoardId(e.target.value)}
								aria-label="Select board"
								title="Switch board"
								className="rounded-md px-2 py-1 text-xs outline-none max-w-[180px]"
								style={inputStyle}
							>
								{boards.map((b) => (
									<option key={b.id} value={b.id}>
										{b.name}
									</option>
								))}
							</select>
						)}
						{board && renaming && (
							<input
								value={renameValue}
								autoFocus
								onChange={(e) => setRenameValue(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === 'Enter') void commitRename();
								}}
								aria-label="Board name"
								className="rounded-md px-2 py-1 text-xs outline-none max-w-[220px]"
								style={inputStyle}
							/>
						)}
						<span className="text-xs shrink-0" style={{ color: theme.colors.textDim }}>
							task DAG · dispatched on the Cue tick
						</span>
					</div>
					<div className="flex items-center gap-1 shrink-0">
						{board &&
							!draft &&
							(renaming ? (
								<button
									onClick={() => void commitRename()}
									className="p-1.5 rounded-md hover:bg-white/10 transition-colors"
									style={{ color: theme.colors.success }}
									aria-label="Save board name"
									title="Save board name"
								>
									<Check className="w-4 h-4" />
								</button>
							) : (
								<button
									onClick={startRename}
									className="p-1.5 rounded-md hover:bg-white/10 transition-colors"
									style={{ color: theme.colors.textDim }}
									aria-label="Rename board"
									title="Rename this board"
								>
									<Pencil className="w-4 h-4" />
								</button>
							))}
						{board && !draft && (
							<button
								onClick={() => setPendingBoardDelete(true)}
								className="p-1.5 rounded-md hover:bg-white/10 transition-colors"
								style={{ color: theme.colors.textDim }}
								aria-label="Delete board"
								title="Delete this board"
							>
								<Trash2 className="w-4 h-4" />
							</button>
						)}
						{board && !draft && (
							<button
								onClick={() => void handleCreateBoard()}
								disabled={creatingBoard}
								className="rounded-md px-2.5 py-1.5 text-xs transition-colors hover:bg-white/5 disabled:opacity-40"
								style={{ border: `1px solid ${theme.colors.border}`, color: theme.colors.textMain }}
								title="Create another board for this project"
							>
								New board
							</button>
						)}
						{board && !draft && profiles.length > 0 && (
							<button
								onClick={openNewCard}
								className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-opacity"
								style={{ backgroundColor: theme.colors.accent, color: theme.colors.bgMain }}
								title="Add a card"
							>
								<Plus className="w-4 h-4" /> New card
							</button>
						)}
						{/* No profiles yet: the hint is the action. Opens the Profiles modal
						    (which layers above this one) instead of dead-ending the user. */}
						{board && !draft && profiles.length === 0 && !loading && (
							<button
								onClick={() => getModalActions().setProfilesModalOpen(true)}
								className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-opacity"
								style={{ backgroundColor: theme.colors.accent, color: theme.colors.bgMain }}
								title="Cards need a role to run. Opens Agent Profiles."
							>
								<Plus className="w-4 h-4" /> Create an Agent Profile first
							</button>
						)}
						<button
							onClick={() => void load(true)}
							className="p-1.5 rounded-md hover:bg-white/10 transition-colors"
							style={{ color: theme.colors.textDim }}
							aria-label="Refresh"
							title="Refresh"
						>
							<RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
						</button>
						<button
							onClick={handleEscape}
							className="p-1.5 rounded-md hover:bg-white/10 transition-colors"
							style={{ color: theme.colors.textDim }}
							aria-label="Close"
							title="Close"
						>
							<X className="w-4 h-4" />
						</button>
					</div>
				</div>

				{/* Body */}
				<div className="flex-1 overflow-hidden flex flex-col">
					{!projectRoot && (
						<div className="p-5 text-sm" style={{ color: theme.colors.textDim }}>
							Select an agent first so the board can be stored for its project.
						</div>
					)}

					{projectRoot && !board && !loading && (
						<div className="flex flex-col items-center justify-center gap-3 h-full">
							<div className="text-sm" style={{ color: theme.colors.textDim }}>
								No board yet for this project.
							</div>
							<button
								onClick={() => void handleCreateBoard()}
								disabled={creatingBoard}
								className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-opacity disabled:opacity-40"
								style={{ backgroundColor: theme.colors.accent, color: theme.colors.bgMain }}
							>
								<Plus className="w-4 h-4" /> Create board
							</button>
						</div>
					)}

					{/* Card editor (create/edit) */}
					{board && draft && (
						<CardEditor
							theme={theme}
							draft={draft}
							setDraft={setDraft}
							profiles={profiles}
							board={board}
							cycleError={cycleError}
							saving={saving}
							canSave={canSaveDraft}
							inputStyle={inputStyle}
							onToggleParent={toggleParent}
							onSave={() => void handleSaveCard()}
							onCancel={requestCloseEditor}
							onMove={(status) => void handleMoveDraft(status)}
							autoFocusMove={focusMovePicker}
							profileName={profileName}
							projectAgents={projectAgents}
						/>
					)}

					{/* Kanban columns */}
					{board && !draft && (
						<div className="flex-1 overflow-x-auto overflow-y-hidden p-4">
							<div className="flex gap-3 h-full" style={{ minWidth: 'min-content' }}>
								{CARD_STATUSES.map((status) => {
									const meta = STATUS_META[status];
									const cards = cardsByStatus.get(status) ?? [];
									const isDropTarget = dragOverStatus === status;
									return (
										<div
											key={status}
											role="group"
											aria-label={`${meta.label}, ${cards.length} card${
												cards.length === 1 ? '' : 's'
											}`}
											className="flex flex-col rounded-lg shrink-0"
											style={{
												width: 220,
												backgroundColor: theme.colors.bgActivity,
												border: `1px solid ${
													isDropTarget ? theme.colors.accent : theme.colors.border
												}`,
											}}
											onDragOver={(e) => {
												e.preventDefault();
												if (dragOverStatus !== status) setDragOverStatus(status);
											}}
											onDragLeave={(e) => {
												// Only clear when leaving the column entirely.
												if (!e.currentTarget.contains(e.relatedTarget as Node)) {
													setDragOverStatus((s) => (s === status ? null : s));
												}
											}}
											onDrop={() => void handleDrop(status)}
										>
											<div
												className="flex items-center justify-between px-3 py-2 border-b"
												style={{ borderColor: theme.colors.border }}
											>
												<span
													className="text-xs font-semibold uppercase tracking-wide"
													style={{ color: theme.colors[meta.colorKey] }}
												>
													{meta.label}
												</span>
												<span
													className="text-[10px] font-bold rounded-full px-1.5 py-0.5"
													style={{
														backgroundColor: theme.colors.bgMain,
														color: theme.colors.textDim,
													}}
												>
													{cards.length}
												</span>
											</div>
											<div className="flex-1 overflow-y-auto p-2 space-y-2">
												{cards.map((card, index) => (
													<BoardCardTile
														key={card.id}
														theme={theme}
														card={card}
														board={board}
														profileName={profileName}
														agentName={agentName}
														dragging={dragCardId === card.id}
														registerTile={registerTile}
														onDragStart={() => setDragCardId(card.id)}
														onDragEnd={() => {
															setDragCardId(null);
															setDragOverStatus(null);
														}}
														onClick={() => openEditCard(card)}
														onMoveRequest={() => openEditCard(card, true)}
														onNavigate={(key) => navigateTiles(status, index, key)}
														onDelete={() => void handleDeleteCard(card.id)}
														onCancelRun={() => void handleCancelCard(card.id)}
													/>
												))}
												{cards.length === 0 && (
													<div
														className="text-[11px] text-center py-4"
														style={{ color: theme.colors.textDim }}
													>
														Drop here
													</div>
												)}
											</div>
										</div>
									);
								})}
							</div>
						</div>
					)}
				</div>

				{/* Keyboard hint footer: the mouse affordances (drag, hover trash) are
				    invisible to keyboard users otherwise. */}
				{board && !draft && (
					<div
						className="shrink-0 px-4 py-2 border-t text-[11px]"
						style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
					>
						Arrow keys move between cards · Enter opens the card · M opens its &quot;Move to&quot;
						picker · Delete twice removes it
					</div>
				)}
			</div>

			{/* Unsaved-changes gate for Escape / backdrop / "Back to board". One
			    confirm step, no draft persistence. */}
			{pendingDiscard && (
				<ConfirmModal
					theme={theme}
					title="Discard changes?"
					message={`"${draft?.title.trim() || 'This card'}" has unsaved changes. Discard them?`}
					confirmLabel="Discard"
					onConfirm={handleConfirmDiscard}
					onClose={() => setPendingDiscard(null)}
				/>
			)}

			{/* Board deletion: same warning the CLI prints before --force. */}
			{pendingBoardDelete && board && (
				<ConfirmModal
					theme={theme}
					title="Delete board?"
					message={
						openBoardCards > 0
							? `"${board.name}" has ${openBoardCards} card${
									openBoardCards === 1 ? '' : 's'
								} that ${openBoardCards === 1 ? 'is' : 'are'} not done. Deleting the board deletes ${
									openBoardCards === 1 ? 'it' : 'them'
								} too. This cannot be undone.`
							: `Delete "${board.name}" and all of its cards? This cannot be undone.`
					}
					confirmLabel="Delete board"
					onConfirm={() => void handleDeleteBoard()}
					onClose={() => setPendingBoardDelete(false)}
				/>
			)}
		</div>,
		document.body
	);
}

// ---------------------------------------------------------------------------

interface RunElapsedProps {
	/** ISO timestamp the run started. */
	startedAt: string;
	className?: string;
	style?: React.CSSProperties;
}

/**
 * Ticking elapsed-time label for an in-flight run. Isolated in its own component
 * so the 1-second interval re-renders one label, never the whole board, and it
 * only exists while a `running` tile is on screen.
 */
function RunElapsed({ startedAt, className, style }: RunElapsedProps) {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const id = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(id);
	}, []);
	const started = Date.parse(startedAt);
	if (!Number.isFinite(started)) return null;
	return (
		<span className={className} style={style}>
			{formatElapsedTime(Math.max(0, now - started))}
		</span>
	);
}

// ---------------------------------------------------------------------------

interface BoardCardTileProps {
	theme: Theme;
	card: BoardCard;
	board: Board;
	profileName: (id: string) => string;
	agentName: (id: string) => string;
	dragging: boolean;
	/** Publishes the tile element so the grid can move focus onto it. */
	registerTile: (cardId: string, el: HTMLDivElement | null) => void;
	onDragStart: () => void;
	onDragEnd: () => void;
	onClick: () => void;
	/** Open the editor focused on its "Move to" picker (the `m` shortcut). */
	onMoveRequest: () => void;
	/** Arrow-key navigation request; the board decides which tile gets focus. */
	onNavigate: (key: string) => void;
	onDelete: () => void;
	/** Stop the in-flight run. Only rendered on `running` cards. */
	onCancelRun: () => void;
}

/** A single draggable, focusable card. Shows its title, assignee, parent count,
 * and a "waiting on N" blocker badge (Phase 2 getBlockers); running cards also
 * show attempt, elapsed time, and which worker claimed them. */
function BoardCardTile({
	theme,
	card,
	board,
	profileName,
	agentName,
	dragging,
	registerTile,
	onDragStart,
	onDragEnd,
	onClick,
	onMoveRequest,
	onNavigate,
	onDelete,
	onCancelRun,
}: BoardCardTileProps) {
	// Delete is armed by the first click and fires on the second, mirroring the
	// "click again to confirm" idiom the browser tab's clear-data button uses.
	// It disarms itself so a stray click never leaves a live trigger sitting there.
	const [deleteArmed, setDeleteArmed] = useState(false);
	const [focused, setFocused] = useState(false);
	const disarmTimerRef = useRef<number | null>(null);
	useEffect(
		() => () => {
			if (disarmTimerRef.current !== null) window.clearTimeout(disarmTimerRef.current);
		},
		[]
	);
	/** First call arms, second deletes. Shared by the trash button and Delete key. */
	const armOrDelete = useCallback(() => {
		if (disarmTimerRef.current !== null) window.clearTimeout(disarmTimerRef.current);
		if (!deleteArmed) {
			setDeleteArmed(true);
			disarmTimerRef.current = window.setTimeout(
				() => setDeleteArmed(false),
				DELETE_DISARM_MS
			) as unknown as number;
			return;
		}
		disarmTimerRef.current = null;
		setDeleteArmed(false);
		onDelete();
	}, [deleteArmed, onDelete]);

	const handleDeleteClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			armOrDelete();
		},
		[armOrDelete]
	);

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLDivElement>) => {
			// Never hijack typing inside a nested control (the summary disclosure).
			if (e.target !== e.currentTarget) return;
			switch (e.key) {
				case 'Enter':
				case ' ':
					e.preventDefault();
					onClick();
					return;
				case 'm':
				case 'M':
					e.preventDefault();
					onMoveRequest();
					return;
				case 'Delete':
				case 'Backspace':
					e.preventDefault();
					armOrDelete();
					return;
				case 'ArrowUp':
				case 'ArrowDown':
				case 'ArrowLeft':
				case 'ArrowRight':
					e.preventDefault();
					onNavigate(e.key);
					return;
				default:
			}
		},
		[onClick, onMoveRequest, onNavigate, armOrDelete]
	);

	const priorityMeta = PRIORITY_META[card.priority ?? 'normal'];
	const blockers = getBlockers(card, board);
	// Cards that list this one as a parent: deleting re-parents them onto this
	// card's own parents, which the confirm copy has to say out loud.
	const dependents = board.cards.filter((c) => c.parents.includes(card.id)).length;
	const deleteTitle = deleteArmed
		? dependents > 0
			? `Click again to delete "${card.title}". Its ${dependents} dependent card${
					dependents === 1 ? '' : 's'
				} will be re-parented to this card's parents.`
			: `Click again to delete "${card.title}".`
		: 'Delete card';
	// Hover-only affordances are invisible to keyboard and touch users: reveal on
	// focus-within, and keep it permanently visible on a touch device (where there
	// is no hover at all).
	const coarsePointer = useMemo(() => isCoarsePointer(), []);
	const deleteVisibility =
		coarsePointer || deleteArmed
			? 'opacity-100'
			: 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100';
	// The most recent run's handoff summary (from a `card-complete | summary`
	// marker), surfaced as optional expandable metadata.
	const latestRun = card.runs?.[card.runs.length - 1];
	const latestSummary = latestRun?.summary;
	// Phase 4: when the last attempt ran in an isolated worktree, say which branch
	// holds its output - nothing merges or removes it automatically.
	const runBranch = latestRun?.worktreeBranch;
	const runWorktreePath = latestRun?.worktreePath;
	// Phase 6: a running card says how long it has been going, which attempt this
	// is, and which pooled worker claimed it.
	const isRunning = card.status === 'running';
	const workerText = latestRun?.workerAgentId ? agentName(latestRun.workerAgentId) : null;
	// Assignee label: role (profile) and/or a 📌 pinned agent; "pool" when the
	// card floats to any free worker.
	const roleText = card.assigneeProfileId ? profileName(card.assigneeProfileId) : null;
	const pinText = card.assigneeAgentId ? `📌 ${agentName(card.assigneeAgentId)}` : null;
	const assigneeText =
		roleText && pinText ? `${roleText} · ${pinText}` : (roleText ?? pinText ?? 'pool');
	// The run details disclosure is available WHILE running too, not just after.
	const showRunDetails = !!latestSummary || !!runBranch || (isRunning && !!latestRun);
	return (
		<div
			ref={(el) => registerTile(card.id, el)}
			draggable
			role="button"
			tabIndex={0}
			aria-label={`${card.title}, ${STATUS_META[card.status].label}`}
			onDragStart={onDragStart}
			onDragEnd={onDragEnd}
			onClick={onClick}
			onKeyDown={handleKeyDown}
			onFocus={(e) => {
				if (e.target === e.currentTarget) setFocused(true);
			}}
			onBlur={(e) => {
				if (e.target === e.currentTarget) setFocused(false);
			}}
			className="group rounded-md px-2.5 py-2 cursor-grab active:cursor-grabbing transition-opacity outline-none"
			style={{
				backgroundColor: theme.colors.bgMain,
				border: `1px solid ${focused ? theme.colors.accent : theme.colors.border}`,
				// Themed focus ring: inline styles cannot express focus-visible, and the
				// tile is the keyboard grid's cursor, so the ring has to be explicit.
				boxShadow: focused ? `0 0 0 2px ${theme.colors.accent}66` : undefined,
				opacity: dragging ? 0.4 : 1,
			}}
		>
			<div className="flex items-start justify-between gap-1.5">
				<div
					className="text-xs font-medium truncate select-text"
					style={{ color: theme.colors.textMain }}
				>
					{card.title}
				</div>
				<div className="flex items-center gap-0.5 shrink-0">
					{isRunning && (
						<button
							onClick={(e) => {
								e.stopPropagation();
								onCancelRun();
							}}
							className="p-0.5 rounded hover:bg-white/10 transition-colors"
							style={{ color: theme.colors.warning }}
							aria-label={`Stop ${card.title}`}
							title="Stop this run"
						>
							<Square className="w-3.5 h-3.5" />
						</button>
					)}
					<button
						onClick={handleDeleteClick}
						className={`p-0.5 rounded hover:bg-white/10 transition-opacity ${deleteVisibility}`}
						style={{ color: deleteArmed ? theme.colors.error : theme.colors.textDim }}
						aria-label={deleteArmed ? `Confirm delete ${card.title}` : `Delete ${card.title}`}
						aria-pressed={deleteArmed}
						title={deleteTitle}
					>
						<Trash2 className="w-3.5 h-3.5" />
					</button>
				</div>
			</div>
			<div className="mt-1 flex items-center gap-1.5 flex-wrap">
				{priorityMeta.badge && (
					<span
						className="text-[10px] font-semibold rounded px-1.5 py-0.5 uppercase tracking-wide"
						style={{
							backgroundColor: theme.colors[priorityMeta.colorKey] + '22',
							color: theme.colors[priorityMeta.colorKey],
						}}
						title={`${priorityMeta.label} priority - ${priorityMeta.hint}`}
					>
						{priorityMeta.badge}
					</span>
				)}
				<span
					className="text-[10px] rounded px-1.5 py-0.5 truncate max-w-full"
					style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}
					title={assigneeText}
				>
					{assigneeText}
				</span>
				{isRunning && latestRun && (
					<span
						className="text-[10px] rounded px-1.5 py-0.5"
						style={{
							backgroundColor: theme.colors.warning + '22',
							color: theme.colors.warning,
						}}
						title={`Attempt ${latestRun.attempt}, started ${latestRun.startedAt}`}
					>
						attempt {latestRun.attempt} ·{' '}
						<RunElapsed startedAt={latestRun.startedAt} style={{ color: theme.colors.warning }} />
					</span>
				)}
				{isRunning && workerText && (
					<span
						className="text-[10px] rounded px-1.5 py-0.5 truncate max-w-full"
						style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}
						title={`Running on worker "${workerText}"`}
					>
						⚙ {workerText}
					</span>
				)}
				{card.parents.length > 0 && (
					<span
						className="text-[10px] rounded px-1.5 py-0.5"
						style={{
							backgroundColor:
								blockers.length > 0 ? theme.colors.warning + '22' : theme.colors.bgActivity,
							color: blockers.length > 0 ? theme.colors.warning : theme.colors.textDim,
						}}
						title={
							blockers.length > 0
								? `Waiting on ${blockers.length} of ${card.parents.length} parent(s)`
								: `${card.parents.length} parent(s), all done`
						}
					>
						{blockers.length > 0
							? `waiting on ${blockers.length}`
							: `${card.parents.length} parent${card.parents.length === 1 ? '' : 's'}`}
					</span>
				)}
				{runBranch && (
					<span
						className="text-[10px] rounded px-1.5 py-0.5 truncate max-w-full select-text"
						style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}
						title={`Last run used the worktree at ${runWorktreePath ?? 'an isolated checkout'} on branch ${runBranch}`}
					>
						🌳 {runBranch}
					</span>
				)}
			</div>
			{showRunDetails && latestRun && (
				<details
					className="mt-1.5 select-text"
					// Stop the click bubbling to the tile so toggling the summary doesn't
					// open the card editor.
					onClick={(e) => e.stopPropagation()}
				>
					<summary
						className="text-[10px] cursor-pointer list-none opacity-70 hover:opacity-100"
						style={{ color: theme.colors.textDim }}
					>
						{isRunning ? 'Run details' : 'Last run summary'}
					</summary>
					{/* Board runs are headless `executeCuePrompt` spawns with no visible
					    tab, so this is the live view: status, elapsed, worker, branch. */}
					<div className="mt-1 text-[10px] leading-snug" style={{ color: theme.colors.textDim }}>
						{isRunning ? 'Running' : (latestRun.outcome ?? 'finished')} · attempt{' '}
						{latestRun.attempt}
						{isRunning && (
							<>
								{' · '}
								<RunElapsed startedAt={latestRun.startedAt} />
							</>
						)}
						{workerText ? ` · worker ${workerText}` : ''}
					</div>
					{latestSummary && (
						<div
							className="mt-1 text-[10px] leading-snug whitespace-pre-wrap"
							style={{ color: theme.colors.textDim }}
						>
							{latestSummary}
						</div>
					)}
					{runBranch && (
						<div
							className="mt-1 text-[10px] leading-snug break-all"
							style={{ color: theme.colors.textDim }}
						>
							Worktree branch <span style={{ color: theme.colors.textMain }}>{runBranch}</span>
							{runWorktreePath ? ` at ${runWorktreePath}` : ''}. Review and merge it yourself -
							Maestro never merges or removes a card branch.
						</div>
					)}
				</details>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------------

interface CardEditorProps {
	theme: Theme;
	draft: CardDraft;
	setDraft: React.Dispatch<React.SetStateAction<CardDraft | null>>;
	profiles: AgentProfile[];
	board: Board;
	cycleError: string | null;
	saving: boolean;
	canSave: boolean;
	inputStyle: React.CSSProperties;
	onToggleParent: (parentId: string) => void;
	onSave: () => void;
	onCancel: () => void;
	/** Persist a column change immediately (existing cards only). */
	onMove: (status: CardStatus) => void;
	/** Land focus on the "Move to" picker (the tile's `m` shortcut). */
	autoFocusMove: boolean;
	profileName: (id: string) => string;
	projectAgents: { id: string; name: string; isWorker: boolean }[];
}

/** Inline create/edit form for a card. Replaces the board view while open, the
 * same grid-vs-details pattern the Extensions pane uses. Content-driven, so its
 * root opts back into text selection. */
function CardEditor({
	theme,
	draft,
	setDraft,
	profiles,
	board,
	cycleError,
	saving,
	canSave,
	inputStyle,
	onToggleParent,
	onSave,
	onCancel,
	onMove,
	autoFocusMove,
	profileName,
	projectAgents,
}: CardEditorProps) {
	// Candidate parents are every other card (a card cannot depend on itself).
	const candidateParents = board.cards.filter((c) => c.id !== draft.id);
	const isExisting = draft.id !== null;
	const moveRef = useRef<HTMLSelectElement>(null);
	// One-shot, like the dialog's initial focus: without it every later render
	// (a `board:changed` push, a keystroke) would yank focus back to the picker.
	const moveFocusDone = useRef(false);
	useFocusAfterRender(moveRef, autoFocusMove && isExisting && !moveFocusDone.current);
	useEffect(() => {
		moveFocusDone.current = true;
	}, []);

	return (
		<div className="flex-1 overflow-y-auto p-5 space-y-4 select-text">
			<button
				type="button"
				onClick={onCancel}
				className="flex items-center gap-1 text-sm opacity-70 hover:opacity-100"
				style={{ color: theme.colors.textMain }}
			>
				<ChevronLeft className="w-4 h-4" /> Back to board
			</button>

			<div className="text-sm font-bold" style={{ color: theme.colors.textMain }}>
				{draft.id === null ? 'New card' : 'Edit card'}
			</div>

			<label className="block space-y-1">
				<span className="text-xs" style={{ color: theme.colors.textDim }}>
					Title
				</span>
				<input
					value={draft.title}
					onChange={(e) => setDraft((p) => (p ? { ...p, title: e.target.value } : p))}
					placeholder="e.g. Design the schema"
					className="w-full rounded-md px-2 py-1.5 text-sm outline-none"
					style={inputStyle}
				/>
			</label>

			<label className="block space-y-1">
				<span className="text-xs" style={{ color: theme.colors.textDim }}>
					Body / instructions
				</span>
				<textarea
					value={draft.body}
					onChange={(e) => setDraft((p) => (p ? { ...p, body: e.target.value } : p))}
					placeholder="Task instructions handed to the assignee agent."
					rows={4}
					className="w-full rounded-md px-2 py-1.5 text-sm outline-none resize-y"
					style={inputStyle}
				/>
			</label>

			<div className="flex gap-3 flex-wrap">
				<label className="block space-y-1 flex-1 min-w-[180px]">
					<span className="text-xs" style={{ color: theme.colors.textDim }}>
						Role (profile)
					</span>
					<select
						value={draft.assigneeProfileId}
						onChange={(e) => setDraft((p) => (p ? { ...p, assigneeProfileId: e.target.value } : p))}
						className="w-full rounded-md px-2 py-1.5 text-sm outline-none"
						style={inputStyle}
					>
						{/* Empty = no role: the card floats to the free worker pool (or runs
						    on the pinned agent below with its own settings). */}
						<option value="">No role (free worker pool)</option>
						{profiles.map((p) => (
							<option key={p.id} value={p.id}>
								{p.name}
							</option>
						))}
					</select>
				</label>
				<label className="block space-y-1 flex-1 min-w-[180px]">
					<span className="text-xs" style={{ color: theme.colors.textDim }}>
						Pin to agent (optional)
					</span>
					<select
						value={draft.assigneeAgentId}
						onChange={(e) => setDraft((p) => (p ? { ...p, assigneeAgentId: e.target.value } : p))}
						className="w-full rounded-md px-2 py-1.5 text-sm outline-none"
						style={inputStyle}
					>
						{/* Empty = not pinned: a role-only card is auto-assigned to any free
						    opt-in worker. Pinning runs the card on exactly this agent. */}
						<option value="">Any free worker</option>
						{projectAgents.map((a) => (
							<option key={a.id} value={a.id}>
								{a.name}
								{a.isWorker ? '' : ' (not a board worker)'}
							</option>
						))}
					</select>
				</label>
				<label className="block space-y-1 w-40">
					<span className="text-xs" style={{ color: theme.colors.textDim }}>
						Priority
					</span>
					<select
						value={draft.priority}
						onChange={(e) =>
							setDraft((p) => (p ? { ...p, priority: e.target.value as CardPriority } : p))
						}
						className="w-full rounded-md px-2 py-1.5 text-sm outline-none"
						style={inputStyle}
					>
						{/* Dispatch order: high before normal before low, oldest first within
						    each. `normal` is the default and is not persisted. */}
						{CARD_PRIORITIES.map((p) => (
							<option key={p} value={p}>
								{PRIORITY_META[p].label}
							</option>
						))}
					</select>
				</label>
				<label className="block space-y-1 w-40">
					<span className="text-xs" style={{ color: theme.colors.textDim }}>
						{isExisting ? 'Move to' : 'Status'}
					</span>
					{/* On an existing card this is the keyboard route for what drag-and-drop
					    does with a mouse: it persists immediately (setCardStatus), with the
					    same dispatcher guards. On a NEW card there is nothing to move yet,
					    so it just seeds the draft's starting column. */}
					<select
						ref={moveRef}
						value={draft.status}
						onChange={(e) => {
							const status = e.target.value as CardStatus;
							if (isExisting) onMove(status);
							else setDraft((p) => (p ? { ...p, status } : p));
						}}
						aria-label={isExisting ? 'Move to' : 'Status'}
						className="w-full rounded-md px-2 py-1.5 text-sm outline-none"
						style={inputStyle}
					>
						{CARD_STATUSES.map((s) => (
							<option key={s} value={s}>
								{STATUS_META[s].label}
							</option>
						))}
					</select>
				</label>
			</div>

			{/* Worktree isolation (Phase 4). Opt-in: the card runs in its own git
			    checkout so parallel cards never share a working tree. The path and
			    branch fields are optional overrides of the conventional naming. */}
			<div className="space-y-2">
				<label className="flex items-center gap-2 cursor-pointer">
					<input
						type="checkbox"
						checked={draft.worktreeEnabled}
						onChange={(e) => setDraft((p) => (p ? { ...p, worktreeEnabled: e.target.checked } : p))}
						className="cursor-pointer"
					/>
					<span className="text-xs" style={{ color: theme.colors.textMain }}>
						Run in isolated worktree
					</span>
					<span className="text-[11px]" style={{ color: theme.colors.textDim }}>
						(branch is created on first run and never auto-merged)
					</span>
				</label>
				{draft.worktreeEnabled && (
					<div className="flex gap-3 flex-wrap">
						<label className="block space-y-1 flex-1 min-w-[180px]">
							<span className="text-xs" style={{ color: theme.colors.textDim }}>
								Worktree path (optional)
							</span>
							<input
								value={draft.worktreePath}
								onChange={(e) => setDraft((p) => (p ? { ...p, worktreePath: e.target.value } : p))}
								placeholder="auto: sibling worktrees/ folder"
								className="w-full rounded-md px-2 py-1.5 text-sm outline-none"
								style={inputStyle}
							/>
						</label>
						<label className="block space-y-1 w-48">
							<span className="text-xs" style={{ color: theme.colors.textDim }}>
								Worktree branch (optional)
							</span>
							<input
								value={draft.worktreeBranch}
								onChange={(e) =>
									setDraft((p) => (p ? { ...p, worktreeBranch: e.target.value } : p))
								}
								placeholder="auto: board/<board>/<card>"
								className="w-full rounded-md px-2 py-1.5 text-sm outline-none"
								style={inputStyle}
							/>
						</label>
					</div>
				)}
			</div>

			{/* Parent cards (multi-select). Selecting a set that would create a
			    dependency cycle is rejected on save with an inline error. */}
			<div className="space-y-1">
				<span className="text-xs" style={{ color: theme.colors.textDim }}>
					Parent cards (must be done before this card is eligible)
				</span>
				{candidateParents.length === 0 ? (
					<div className="text-xs" style={{ color: theme.colors.textDim }}>
						No other cards to depend on yet.
					</div>
				) : (
					<div
						className="rounded-md p-2 space-y-1 max-h-48 overflow-y-auto"
						style={{ border: `1px solid ${theme.colors.border}` }}
					>
						{candidateParents.map((c) => {
							const checked = draft.parents.includes(c.id);
							return (
								<label
									key={c.id}
									className="flex items-center gap-2 text-xs cursor-pointer rounded px-1.5 py-1 hover:bg-white/5"
									style={{ color: theme.colors.textMain }}
								>
									<input type="checkbox" checked={checked} onChange={() => onToggleParent(c.id)} />
									<span className="truncate">{c.title}</span>
									<span className="ml-auto shrink-0" style={{ color: theme.colors.textDim }}>
										{c.assigneeProfileId ? profileName(c.assigneeProfileId) : 'pool'}
									</span>
								</label>
							);
						})}
					</div>
				)}
			</div>

			{cycleError && (
				<div
					className="text-xs rounded-md px-3 py-2"
					style={{ backgroundColor: theme.colors.error + '22', color: theme.colors.error }}
				>
					{cycleError}
				</div>
			)}

			<div className="flex items-center gap-2">
				<button
					onClick={onSave}
					disabled={!canSave}
					className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-opacity disabled:opacity-40"
					style={{ backgroundColor: theme.colors.accent, color: theme.colors.bgMain }}
				>
					<Plus className="w-4 h-4" />
					{draft.id === null ? 'Create card' : 'Save changes'}
				</button>
				<button
					onClick={onCancel}
					disabled={saving}
					className="rounded-md px-3 py-1.5 text-sm transition-colors hover:bg-white/5"
					style={{ border: `1px solid ${theme.colors.border}`, color: theme.colors.textMain }}
				>
					Cancel
				</button>
			</div>
		</div>
	);
}
