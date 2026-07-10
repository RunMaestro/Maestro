import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, KanbanSquare, Plus, Trash2, RefreshCw, ChevronLeft } from 'lucide-react';
import type { Theme } from '../types';
import type { AgentProfile } from '../../shared/profiles/types';
import type { Board, BoardCard, CardStatus } from '../../shared/board/types';
import { CARD_STATUSES } from '../../shared/board/types';
import { getBlockers, hasCycle } from '../../shared/board/graph';
import { useModalLayer } from '../hooks/ui/useModalLayer';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { useSessionStore, selectActiveSession } from '../stores/sessionStore';
import { notifyToast } from '../stores/notificationStore';
import { generateUUID } from '../../shared/uuid';
import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';
import { triggerHaptic, HAPTIC_PATTERNS, isCoarsePointer } from '../utils/touch';

export interface BoardModalProps {
	theme: Theme;
	onClose: () => void;
}

/** How often (ms) the board re-polls so cards move columns as the dispatcher
 * runs. There is no board:changed push event yet, so a light poll keeps the
 * kanban live without a new IPC surface. */
const POLL_INTERVAL_MS = 2500;

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

/** Draft shape for the card editor (before it becomes a persisted BoardCard). */
interface CardDraft {
	id: string | null; // null = new card
	title: string;
	body: string;
	assigneeProfileId: string;
	parents: string[];
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
 * Click-driven, so the root is `select-none`; the card-body detail view opts
 * back into text selection with `select-text` (per the CLAUDE.md modal rule).
 */
export function BoardModal({ theme, onClose }: BoardModalProps) {
	useModalLayer(MODAL_PRIORITIES.BOARD_MODAL, 'Board', onClose);

	const activeSession = useSessionStore(selectActiveSession);
	const projectRoot = activeSession?.projectRoot ?? '';

	const [board, setBoard] = useState<Board | null>(null);
	const [profiles, setProfiles] = useState<AgentProfile[]>([]);
	const [loading, setLoading] = useState(true);
	const [creatingBoard, setCreatingBoard] = useState(false);
	const [dragCardId, setDragCardId] = useState<string | null>(null);
	const [dragOverStatus, setDragOverStatus] = useState<CardStatus | null>(null);

	// Editor state: null = board view, otherwise the card editor is showing.
	const [draft, setDraft] = useState<CardDraft | null>(null);
	const [cycleError, setCycleError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);

	const boardIdRef = useRef<string | null>(null);
	boardIdRef.current = board?.id ?? null;

	const profileName = useCallback(
		(id: string) => profiles.find((p) => p.id === id)?.name ?? id,
		[profiles]
	);

	// Load the first board (MVP is single-board per project) plus the profiles
	// that back card assignees. Reused by the poll and by explicit refresh.
	const load = useCallback(
		async (showSpinner = true) => {
			if (!projectRoot) {
				setBoard(null);
				setProfiles([]);
				setLoading(false);
				return;
			}
			if (showSpinner) setLoading(true);
			try {
				const [boards, profileList] = await Promise.all([
					window.maestro.board.list(projectRoot),
					window.maestro.profiles.list(projectRoot),
				]);
				setProfiles(profileList);
				// Keep the currently-open board if it still exists, else first board.
				const current = boardIdRef.current;
				const next = boards.find((b) => b.id === current) ?? boards[0] ?? null;
				setBoard(next);
			} catch (err) {
				logger.error(`Failed to load board: ${String(err)}`);
				captureException(err, { tags: { operation: 'board:list' } });
				if (showSpinner) {
					notifyToast({ color: 'red', title: 'Board', message: 'Failed to load board.' });
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

	// Live poll: refresh the board (no spinner) so dispatcher-driven status
	// changes surface without a manual reload. Paused while the editor is open so
	// a poll can't clobber an in-progress edit.
	useEffect(() => {
		if (!projectRoot || draft) return;
		const timer = setInterval(() => void load(false), POLL_INTERVAL_MS);
		return () => clearInterval(timer);
	}, [projectRoot, draft, load]);

	const handleCreateBoard = useCallback(async () => {
		if (!projectRoot || creatingBoard) return;
		setCreatingBoard(true);
		try {
			const name = activeSession?.name ? `${activeSession.name} Board` : 'Board';
			const created = await window.maestro.board.create(projectRoot, name);
			setBoard(created);
		} catch (err) {
			logger.error(`Failed to create board: ${String(err)}`);
			captureException(err, { tags: { operation: 'board:create' } });
			notifyToast({ color: 'red', title: 'Board', message: 'Failed to create board.' });
		} finally {
			setCreatingBoard(false);
		}
	}, [projectRoot, creatingBoard, activeSession?.name]);

	// --- Card editor -------------------------------------------------------

	const openNewCard = useCallback(() => {
		setCycleError(null);
		setDraft({
			id: null,
			title: '',
			body: '',
			assigneeProfileId: profiles[0]?.id ?? '',
			parents: [],
			worktreePath: '',
			worktreeBranch: '',
			status: 'todo',
		});
	}, [profiles]);

	const openEditCard = useCallback((card: BoardCard) => {
		setCycleError(null);
		setDraft({
			id: card.id,
			title: card.title,
			body: card.body,
			assigneeProfileId: card.assigneeProfileId,
			parents: [...card.parents],
			worktreePath: card.worktree?.path ?? '',
			worktreeBranch: card.worktree?.branch ?? '',
			status: card.status,
			createdAt: card.createdAt,
		});
	}, []);

	const closeEditor = useCallback(() => {
		setDraft(null);
		setCycleError(null);
	}, []);

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
			draft.assigneeProfileId.length > 0 &&
			!saving,
		[draft, projectRoot, board, saving]
	);

	const handleSaveCard = useCallback(async () => {
		if (!draft || !board || !projectRoot || !canSaveDraft) return;

		const now = new Date().toISOString();
		const card: BoardCard = {
			id: draft.id ?? generateUUID(),
			title: draft.title.trim(),
			body: draft.body,
			assigneeProfileId: draft.assigneeProfileId,
			parents: draft.parents,
			status: draft.status,
			createdAt: draft.createdAt ?? now,
			updatedAt: now,
			...(draft.worktreePath.trim()
				? {
						worktree: {
							path: draft.worktreePath.trim(),
							...(draft.worktreeBranch.trim() ? { branch: draft.worktreeBranch.trim() } : {}),
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
			setBoard(updated);
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
			// The storage layer rejects cycles too — surface that inline rather than
			// as a generic toast.
			if (/cycl/i.test(message)) {
				setCycleError('This parent selection would create a dependency cycle.');
			} else {
				notifyToast({ color: 'red', title: 'Board', message: 'Failed to save card.' });
			}
		} finally {
			setSaving(false);
		}
	}, [draft, board, projectRoot, canSaveDraft, closeEditor]);

	const handleDeleteCard = useCallback(
		async (cardId: string) => {
			if (!board || !projectRoot) return;
			try {
				const updated = await window.maestro.board.deleteCard(projectRoot, board.id, cardId);
				setBoard(updated);
				if (draft?.id === cardId) closeEditor();
			} catch (err) {
				logger.error(`Failed to delete card: ${String(err)}`);
				captureException(err, { tags: { operation: 'board:deleteCard' } });
				notifyToast({ color: 'red', title: 'Board', message: 'Failed to delete card.' });
			}
		},
		[board, projectRoot, draft?.id, closeEditor]
	);

	// --- Drag-to-move (manual status override) -----------------------------

	const handleDrop = useCallback(
		async (status: CardStatus) => {
			const cardId = dragCardId;
			setDragCardId(null);
			setDragOverStatus(null);
			if (!cardId || !board || !projectRoot) return;
			const card = board.cards.find((c) => c.id === cardId);
			// No-op when dropped back on the same column.
			if (!card || card.status === status) return;
			if (isCoarsePointer()) triggerHaptic(HAPTIC_PATTERNS.tap);
			// Optimistic move so the card jumps immediately; the poll/reconcile
			// corrects it if the write fails.
			setBoard((prev) =>
				prev
					? { ...prev, cards: prev.cards.map((c) => (c.id === cardId ? { ...c, status } : c)) }
					: prev
			);
			try {
				const updated = await window.maestro.board.setCardStatus(
					projectRoot,
					board.id,
					cardId,
					status
				);
				setBoard(updated);
			} catch (err) {
				logger.error(`Failed to move card: ${String(err)}`);
				captureException(err, { tags: { operation: 'board:setCardStatus' } });
				notifyToast({ color: 'red', title: 'Board', message: 'Failed to move card.' });
				void load(false);
			}
		},
		[dragCardId, board, projectRoot, load]
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

	return createPortal(
		<div
			className="fixed inset-0 flex items-center justify-center select-none"
			style={{ zIndex: MODAL_PRIORITIES.BOARD_MODAL }}
			onClick={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
		>
			<div className="absolute inset-0 bg-black/50" />

			<div
				className="relative rounded-xl shadow-2xl flex flex-col"
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
					className="shrink-0 flex items-center justify-between px-5 py-4 border-b"
					style={{ borderColor: theme.colors.border }}
				>
					<div className="flex items-center gap-2 min-w-0">
						<KanbanSquare className="w-5 h-5 shrink-0" style={{ color: theme.colors.accent }} />
						<h2 className="text-base font-bold truncate" style={{ color: theme.colors.textMain }}>
							{board ? board.name : 'Board'}
						</h2>
						<span className="text-xs shrink-0" style={{ color: theme.colors.textDim }}>
							task DAG · dispatched on the Cue tick
						</span>
					</div>
					<div className="flex items-center gap-1">
						{board && !draft && (
							<button
								onClick={openNewCard}
								disabled={profiles.length === 0}
								className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-opacity disabled:opacity-40"
								style={{ backgroundColor: theme.colors.accent, color: theme.colors.bgMain }}
								title={profiles.length === 0 ? 'Create an Agent Profile first' : 'Add a card'}
							>
								<Plus className="w-4 h-4" /> New card
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
							onClick={onClose}
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
							onCancel={closeEditor}
							profileName={profileName}
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
												{cards.map((card) => (
													<BoardCardTile
														key={card.id}
														theme={theme}
														card={card}
														board={board}
														profileName={profileName}
														dragging={dragCardId === card.id}
														onDragStart={() => setDragCardId(card.id)}
														onDragEnd={() => {
															setDragCardId(null);
															setDragOverStatus(null);
														}}
														onClick={() => openEditCard(card)}
														onDelete={() => void handleDeleteCard(card.id)}
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
			</div>
		</div>,
		document.body
	);
}

// ---------------------------------------------------------------------------

interface BoardCardTileProps {
	theme: Theme;
	card: BoardCard;
	board: Board;
	profileName: (id: string) => string;
	dragging: boolean;
	onDragStart: () => void;
	onDragEnd: () => void;
	onClick: () => void;
	onDelete: () => void;
}

/** A single draggable card. Shows its title, assignee, parent count, and a
 * "waiting on N" blocker badge (Phase 2 getBlockers). */
function BoardCardTile({
	theme,
	card,
	board,
	profileName,
	dragging,
	onDragStart,
	onDragEnd,
	onClick,
	onDelete,
}: BoardCardTileProps) {
	const blockers = getBlockers(card, board);
	return (
		<div
			draggable
			onDragStart={onDragStart}
			onDragEnd={onDragEnd}
			onClick={onClick}
			className="group rounded-md px-2.5 py-2 cursor-grab active:cursor-grabbing transition-opacity"
			style={{
				backgroundColor: theme.colors.bgMain,
				border: `1px solid ${theme.colors.border}`,
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
				<button
					onClick={(e) => {
						e.stopPropagation();
						onDelete();
					}}
					className="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-white/10 transition-opacity shrink-0"
					style={{ color: theme.colors.textDim }}
					aria-label={`Delete ${card.title}`}
					title="Delete card"
				>
					<Trash2 className="w-3.5 h-3.5" />
				</button>
			</div>
			<div className="mt-1 flex items-center gap-1.5 flex-wrap">
				<span
					className="text-[10px] rounded px-1.5 py-0.5 truncate max-w-full"
					style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}
					title={profileName(card.assigneeProfileId)}
				>
					{profileName(card.assigneeProfileId)}
				</span>
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
			</div>
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
	profileName: (id: string) => string;
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
	profileName,
}: CardEditorProps) {
	// Candidate parents are every other card (a card cannot depend on itself).
	const candidateParents = board.cards.filter((c) => c.id !== draft.id);

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
						Assignee profile
					</span>
					<select
						value={draft.assigneeProfileId}
						onChange={(e) => setDraft((p) => (p ? { ...p, assigneeProfileId: e.target.value } : p))}
						className="w-full rounded-md px-2 py-1.5 text-sm outline-none"
						style={inputStyle}
					>
						{profiles.length === 0 && <option value="">No profiles available</option>}
						{profiles.map((p) => (
							<option key={p.id} value={p.id}>
								{p.name}
							</option>
						))}
					</select>
				</label>
				<label className="block space-y-1 w-40">
					<span className="text-xs" style={{ color: theme.colors.textDim }}>
						Status
					</span>
					<select
						value={draft.status}
						onChange={(e) =>
							setDraft((p) => (p ? { ...p, status: e.target.value as CardStatus } : p))
						}
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

			{/* Worktree (optional): the dispatcher fills this when it runs a card,
			    but a user can pin an explicit worktree path/branch up front. */}
			<div className="flex gap-3 flex-wrap">
				<label className="block space-y-1 flex-1 min-w-[180px]">
					<span className="text-xs" style={{ color: theme.colors.textDim }}>
						Worktree path (optional)
					</span>
					<input
						value={draft.worktreePath}
						onChange={(e) => setDraft((p) => (p ? { ...p, worktreePath: e.target.value } : p))}
						placeholder="dispatcher decides if left blank"
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
						onChange={(e) => setDraft((p) => (p ? { ...p, worktreeBranch: e.target.value } : p))}
						placeholder="branch"
						className="w-full rounded-md px-2 py-1.5 text-sm outline-none"
						style={inputStyle}
					/>
				</label>
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
										{profileName(c.assigneeProfileId)}
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
