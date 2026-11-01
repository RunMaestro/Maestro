import { isSessionRemote } from '../utils/sessionHelpers';
import { BOARD_SOURCE_PROJECT_PREFIX } from '../../shared/board/types';
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
	Play,
	Pencil,
	Check,
} from 'lucide-react';
import type { Theme } from '../types';
import type { AgentProfile } from '../../shared/profiles/types';
import type {
	Board,
	BoardCard,
	BoardCardKind,
	BoardCaptureCatalog,
	BoardCaptureResponse,
	BoardExecutionScope,
	BoardRoleRef,
	BoardStartMode,
	BoardWorkspaceCollection,
	BoardSourceCatalogEntry,
	CardPriority,
	CardStatus,
} from '../../shared/board/types';
import type { StoredBoardWorker } from '../../main/board/board-workspace-storage';
import { CARD_PRIORITIES, CARD_STATUSES } from '../../shared/board/types';
import { getBlockers, hasCycle } from '../../shared/board/graph';
import { isPathWithin } from '../../shared/board/pool';
import { buildCardWorktreeRef } from '../../shared/board/worktree';
import { useResizableModal } from '../hooks/ui/useResizableModal';
import { ResizeHandles } from './ui/ResizeHandles';
import { useModalLayer } from '../hooks/ui/useModalLayer';
import { useFocusAfterRender } from '../hooks/utils/useFocusAfterRender';
import { ProfilesModal } from './ProfilesModal/ProfilesModal';
import { ConfirmModal } from './ConfirmModal';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { useSessionStore, selectActiveSession } from '../stores/sessionStore';
import { useLiveSessions } from '../hooks/session/useLiveSessions';
import { jumpToAgent } from '../services/agentNavigation';
import { useModalStore, selectModalOpen } from '../stores/modalStore';
import { notifyToast } from '../stores/notificationStore';
import { canonicalJson } from '../../shared/canonicalJson';
import { generateUUID } from '../../shared/uuid';
import { formatElapsedTime, truncatePath } from '../../shared/formatters';
import { ipcErrorMessage } from '../utils/ipcErrorMessage';
import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';
import { triggerHaptic, HAPTIC_PATTERNS, isCoarsePointer } from '../utils/touch';
import { openUrl } from '../utils/openUrl';
import { observedWorkerRuns } from '../utils/boardWorkerStatus';

export interface BoardModalProps {
	theme: Theme;
	onClose: () => void;
}

/** How long (ms) a tile's delete button stays armed before it disarms itself. */
const DELETE_DISARM_MS = 4000;

/** Id of the modal title, referenced by `aria-labelledby` on the dialog. */
const TITLE_ID = 'board-modal-title';

/**
 * Workspace "last collection I had open" memory. A pure UI preference, so it lives
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
	review: { label: 'Review', colorKey: 'warning' },
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
	kind?: BoardCardKind;
	reviewContext?: {
		sourceCardId: string;
		attempt: number;
		branch: string;
		worktree: string;
		commit: string;
		checks: string;
	};
	id: string | null; // null = new card
	title: string;
	body: string;
	assigneeProfileId: string; // Preserves unresolved legacy role IDs until explicitly replaced.
	role?: BoardRoleRef;
	executionScope?: BoardExecutionScope;
	repositoryId: string;
	workingDirectory: string;
	startModeOverride?: BoardStartMode;
	assigneeAgentId: string; // '' = not pinned; else a specific agent runs this card
	parents: string[];
	priority: CardPriority;
	/** "Run in isolated worktree" (Phase 4). The two fields below are optional
	 * overrides of the conventional branch/path derived from the board + card id. */
	worktreeEnabled: boolean;
	worktreePath: string;
	worktreeBranch: string;
	/** "Open PR when done" (F3). Only meaningful with worktree isolation on; the
	 * branch is the empty-means-repo-default target for `gh pr create`. */
	prOnDoneEnabled: boolean;
	prTargetBranch: string;
	status: CardStatus;
	createdAt?: string;
	storageRevision?: number;
	collection: BoardWorkspaceCollection;
	projectRoot: string;
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
	const activeProjectRoot = isSessionRemote(activeSession)
		? ''
		: (activeSession?.projectRoot ?? '');
	const [collections, setCollections] = useState<BoardWorkspaceCollection[]>([]);
	const [roleSource, setRoleSource] = useState<{ sourceKey: string; namespace: string } | null>(
		null
	);
	const [sources, setSources] = useState<BoardSourceCatalogEntry[]>([]);
	const [sourceRoots, setSourceRoots] = useState<Record<string, string>>({});
	const [projectFilter, setProjectFilter] = useState('all');
	const [groupFilter, setGroupFilter] = useState('all');
	const [agentFilter, setAgentFilter] = useState('all');
	const groups = useSessionStore((s) => s.groups);

	const allSessions = useSessionStore((s) => s.sessions);
	const projectRoots = useMemo(
		() => [
			...new Set(
				allSessions
					.filter((s) => !isSessionRemote(s))
					.map((s) => s.projectRoot)
					.filter((root): root is string => !!root)
			),
		],
		[allSessions]
	);
	const liveSessions = useLiveSessions();

	const [selectedBoardId, setSelectedBoardId] = useState<string | null>(null);
	const [draft, setDraft] = useState<CardDraft | null>(null);
	const visibleCollections = useMemo(
		() =>
			collections.filter(
				(entry) => projectFilter === 'all' || entry.projectRef.sourceKey === projectFilter
			),
		[collections, projectFilter]
	);
	const selectedCollection =
		visibleCollections.find((entry) => entry.collectionKey === selectedBoardId) ??
		visibleCollections[0] ??
		null;
	const editorCollection = draft?.collection ?? selectedCollection;
	const board = editorCollection?.board ?? null;
	const projectRoot =
		draft?.projectRoot ??
		(selectedCollection
			? (sourceRoots[selectedCollection.sourceKey] ?? '')
			: projectFilter === 'all'
				? activeProjectRoot
				: (sourceRoots[projectFilter] ?? ''));
	const sourceLocation = sources.find(
		(source) => source.sourceKey === (editorCollection?.sourceKey ?? projectFilter)
	)?.location;
	const projectLocationLabel =
		sourceLocation?.location.kind === 'ssh'
			? `${sourceLocation.location.remoteId || 'Unresolved SSH'}: ${sourceLocation.path}`
			: projectRoot;
	const boards = useMemo(() => collections.map((entry) => entry.board), [collections]);

	// Legacy cards display the current project worker marker until dispatch is migrated.
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

	// Jump from a card's worker chip to the worker agent's AI tab. Store-direct
	// (per CLAUDE.md canonical helpers) rather than threading the toast handler
	// down a new prop chain. Close the modal afterwards so it does not sit on top
	// of the agent it just jumped to (same reasoning as the Document Graph close
	// in useSessionSwitchCallbacks).
	const handleJumpToAgent = useCallback(
		(agentId: string) => {
			jumpToAgent(agentId);
			onClose();
		},
		[onClose]
	);

	const [showWorkers, setShowWorkers] = useState(false);
	const [workers, setWorkers] = useState<StoredBoardWorker[]>([]);
	const sessionById = useMemo(() => {
		const index = new Map<string, (typeof allSessions)[number]>();
		for (const session of allSessions) if (!index.has(session.id)) index.set(session.id, session);
		return index;
	}, [allSessions]);
	const workersByAgent = useMemo(() => {
		const index = new Map<string, StoredBoardWorker>();
		for (const worker of workers) if (!index.has(worker.agentId)) index.set(worker.agentId, worker);
		return index;
	}, [workers]);
	const observedRuns = useMemo(() => observedWorkerRuns(boards), [boards]);
	const workersRevision = useRef(0);
	const [workerBusy, setWorkerBusy] = useState(false);
	const creatorOpen = useModalStore(selectModalOpen('newInstance'));
	const [pendingWorkerId, setPendingWorkerId] = useState<string | null>(null);
	const [workerCreationError, setWorkerCreationError] = useState<string | null>(null);
	const createdWorkerId = useRef<string | null>(null);
	const registeringCreatedWorker = useRef(false);
	const registerCreatedWorker = useCallback(async (agentId: string) => {
		if (registeringCreatedWorker.current) return;
		registeringCreatedWorker.current = true;
		workersRevision.current++;
		setPendingWorkerId(agentId);
		setWorkerBusy(true);
		setWorkerCreationError(null);
		try {
			setWorkers(await window.maestro.board.registerWorker(agentId));
			setPendingWorkerId(null);
		} catch (error) {
			setWorkerCreationError(
				`Agent created; worker registration failed: ${ipcErrorMessage(error)}`
			);
		} finally {
			registeringCreatedWorker.current = false;
			setWorkerBusy(false);
		}
	}, []);
	const createWorker = useCallback(() => {
		createdWorkerId.current = null;
		setWorkerCreationError(null);
		useModalStore.getState().openModal('newInstance', {
			duplicatingSessionId: null,
			presetWorkingDir: projectRoot || undefined,
			onCreated: (agentId) => {
				if (createdWorkerId.current) return;
				createdWorkerId.current = agentId;
				void registerCreatedWorker(agentId);
			},
			onCreationStarted: () => setWorkerBusy(true),
			onCreationError: (message) => {
				setWorkerCreationError(message);
				setWorkerBusy(false);
			},
		});
	}, [projectRoot, registerCreatedWorker]);
	const [workerAccessOptions, setWorkerAccessOptions] = useState<
		Awaited<ReturnType<typeof window.maestro.board.listWorkerAccessOptions>>
	>({ roles: [], repositories: [] });
	const refreshWorkers = useCallback(async () => {
		const revision = workersRevision.current;
		try {
			const [registered, options] = await Promise.all([
				window.maestro.board.listWorkers(),
				window.maestro.board.listWorkerAccessOptions(),
			]);
			if (revision === workersRevision.current) setWorkers(registered);
			setWorkerAccessOptions(options);
		} catch (err) {
			notifyToast({ color: 'red', title: 'Board workers', message: ipcErrorMessage(err) });
		}
	}, []);
	const changeWorker = useCallback(async (action: () => Promise<StoredBoardWorker[]>) => {
		workersRevision.current++;
		setWorkerBusy(true);
		try {
			setWorkers(await action());
		} catch (err) {
			notifyToast({ color: 'red', title: 'Board workers', message: ipcErrorMessage(err) });
		} finally {
			setWorkerBusy(false);
		}
	}, []);

	const [catalog, setCatalog] = useState<BoardCaptureCatalog | null>(null);
	const [catalogError, setCatalogError] = useState<string | null>(null);
	const catalogGeneration = useRef(0);
	const refreshCaptureCatalog = useCallback(async () => {
		const generation = ++catalogGeneration.current;
		try {
			const value = await window.maestro.board.captureCatalog();
			if (generation === catalogGeneration.current) {
				setCatalog(value);
				setCatalogError(null);
			}
			return value;
		} catch (error) {
			if (generation === catalogGeneration.current) setCatalogError(ipcErrorMessage(error));
			throw error;
		}
	}, []);
	const [saveError, setSaveError] = useState<
		Extract<BoardCaptureResponse, { ok: false }>['error'] | null
	>(null);
	const [captureResult, setCaptureResult] = useState<{
		collectionKey: string;
		cardId: string;
		response: Extract<BoardCaptureResponse, { ok: true }>;
	} | null>(null);
	const [loading, setLoading] = useState(true);
	const [creatingBoard, setCreatingBoard] = useState(false);
	const [dragCardId, setDragCardId] = useState<string | null>(null);
	const [dragOverStatus, setDragOverStatus] = useState<CardStatus | null>(null);
	const [kindFilter, setKindFilter] = useState<BoardCardKind | 'all' | 'unspecified'>('all');
	const [statusFilter, setStatusFilter] = useState<CardStatus | 'all'>('all');

	// Board lifecycle UI (Phase 6): inline rename + delete confirmation.
	const [renaming, setRenaming] = useState(false);
	const createdRoles = useRef(new Map<string, BoardRoleRef>());
	const [renameValue, setRenameValue] = useState('');
	const [pendingBoardDelete, setPendingBoardDelete] = useState(false);

	// Editor state: null = board view, otherwise the card editor is showing.
	const [showNewRole, setShowNewRole] = useState(false);
	const [cycleError, setCycleError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	/** Set when the editor was opened with `m`, so it lands on the Move to picker. */
	const [focusMovePicker, setFocusMovePicker] = useState(false);
	/** The draft exactly as the editor opened it, for the unsaved-changes check. */
	const draftBaselineRef = useRef<CardDraft | null>(null);
	/** Which close the user asked for while the editor was dirty, pending confirm. */
	const [pendingDiscard, setPendingDiscard] = useState<null | 'editor' | 'modal'>(null);

	// Cheap structural compare: the draft is a flat object of primitives plus a
	// string array, so serializing both sides is simpler (and less bug-prone) than
	// a hand-written field-by-field diff.
	const isDraftDirty = useMemo(
		() => !!draft && canonicalJson(draft) !== canonicalJson(draftBaselineRef.current),
		[draft]
	);

	const loadGenerationRef = useRef(0);
	const selectedBoardIdRef = useRef<string | null>(null);
	selectedBoardIdRef.current = selectedBoardId;

	const profileName = useCallback(
		(id: string) => {
			const matches = catalog?.profiles.filter((entry) => entry.profile.id === id) ?? [];
			return matches.length === 1 ? matches[0].profile.name : id;
		},
		[catalog]
	);

	// Read the central workspace; resolve only explicit session project roots through
	// the host for compatibility writers. Unknown sources remain visible and read-only.
	const load = useCallback(
		async (showSpinner = true) => {
			const generation = ++loadGenerationRef.current;

			if (showSpinner) setLoading(true);
			try {
				const [response, mappings] = await Promise.all([
					window.maestro.board.queryWorkspace(),
					Promise.all(
						projectRoots.map(async (root) => {
							const result = await window.maestro.board
								.queryWorkspace({ projectRoot: root })
								.catch(() => null);
							return { root, result };
						})
					),
				]);
				if (generation !== loadGenerationRef.current) return;
				if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
				const roots: Record<string, string> = {};
				for (const source of response.value.sources) {
					if (source.location)
						roots[source.sourceKey] =
							source.location.location.kind === 'local'
								? source.location.path
								: `${BOARD_SOURCE_PROJECT_PREFIX}${source.sourceKey}`;
				}
				for (const { root, result } of mappings) {
					if (result?.ok) {
						const keys = [...new Set(result.value.collections.map((entry) => entry.sourceKey))];
						if (keys.length === 1 && !roots[keys[0]]) roots[keys[0]] = root;
					}
				}
				setSourceRoots(roots);
				setSources(response.value.sources);
				setCollections(response.value.collections);
				setCaptureResult(null);
				const current = selectedBoardIdRef.current;
				const remembered = readLastBoardId('workspace');
				const next =
					response.value.collections.find((entry) => entry.collectionKey === current) ??
					response.value.collections.find((entry) => entry.collectionKey === remembered) ??
					response.value.collections[0];
				setSelectedBoardId(next?.collectionKey ?? null);
			} catch (err) {
				if (generation !== loadGenerationRef.current) return;
				logger.error(`Failed to load board: ${String(err)}`);
				if (showSpinner) {
					// A corrupt board.yaml / profiles.yaml now fails closed in the main
					// process instead of loading as empty, so surface the real reason -
					// the user has to repair the file by hand. Only reported on an
					// explicit load: a push-driven refresh would otherwise re-report the
					// same user-data problem on every write.
					captureException(err, { tags: { operation: 'board:queryWorkspace' } });
					notifyToast({
						color: 'red',
						title: 'Board',
						message: `Failed to load board: ${ipcErrorMessage(err)}`,
						dismissible: true,
					});
				}
			} finally {
				if (generation === loadGenerationRef.current) setLoading(false);
			}
		},
		[projectRoots]
	);

	useEffect(() => {
		void load(true);
		return () => {
			loadGenerationRef.current++;
		};
	}, [load]);

	useEffect(() => {
		if (loading) return;
		void refreshCaptureCatalog().catch(() => {}); // The editor displays the failure and offers retry.
		return () => {
			catalogGeneration.current++;
		};
	}, [collections, allSessions, groups, loading, refreshCaptureCatalog]);

	// Remember the collection key, since legacy board IDs can collide across sources.
	useEffect(() => {
		if (selectedBoardId) writeLastBoardId('workspace', selectedBoardId);
	}, [selectedBoardId]);

	// Live updates: the main process pushes `board:changed` after every
	// `.maestro/board.yaml` write (dispatcher tick, IPC mutation, auto-decompose),
	// so dispatcher-driven status changes surface without a timer. The refresh runs
	// while the card editor is open too - the draft is separate state, so only the
	// board behind the editor is reconciled and in-progress edits survive.
	useEffect(() => {
		return window.maestro.board.onBoardChanged?.(() => {
			void load(false);
		});
	}, [load]);

	// Roles belong to explicit host namespaces across every source. Refresh choices
	// after any profile change, without replacing the open card's read snapshot.
	useEffect(() => {
		return window.maestro.profiles.onProfilesChanged?.(() => {
			void refreshCaptureCatalog().catch(() => {});
		});
	}, [refreshCaptureCatalog]);

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
			selectedBoardIdRef.current = created.storage?.collectionKey ?? null;
			setSelectedBoardId(created.storage?.collectionKey ?? null);
			await load(false);
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
	}, [projectRoot, creatingBoard, activeSession?.name, boards.length, load]);

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
			await window.maestro.board.rename(projectRoot, board.id, name);
			await load(false);
		} catch (err) {
			logger.error(`Failed to rename board: ${String(err)}`);
			captureException(err, { tags: { operation: 'board:rename' } });
			notifyToast({ color: 'red', title: 'Board', message: 'Failed to rename the board.' });
		}
	}, [renameValue, board, projectRoot, load]);

	/** Cards that would be destroyed by deleting the board (the CLI's warning). */
	const openBoardCards = useMemo(
		() => (board ? board.cards.filter((c) => c.status !== 'done').length : 0),
		[board]
	);

	const handleDeleteBoard = useCallback(async () => {
		if (!board || !projectRoot) return;
		try {
			// The confirm dialog IS the acknowledgment the CLI asks for with --force.
			await window.maestro.board.delete(projectRoot, board.id, true);
			await load(false);
			notifyToast({ color: 'green', title: 'Board', message: `Deleted "${board.name}".` });
		} catch (err) {
			logger.error(`Failed to delete board: ${String(err)}`);
			captureException(err, { tags: { operation: 'board:delete' } });
			notifyToast({
				color: 'red',
				title: 'Board',
				message: ipcErrorMessage(err),
			});
		}
	}, [board, projectRoot, load]);

	// --- Card editor -------------------------------------------------------

	const openNewCard = useCallback(() => {
		setCycleError(null);
		setSaveError(null);
		setFocusMovePicker(false);
		if (!selectedCollection) return;
		const fresh: CardDraft = {
			collection: structuredClone(selectedCollection),
			projectRoot,
			id: null,
			title: '',
			body: '',
			assigneeProfileId: '',
			repositoryId: '',
			workingDirectory: '',
			assigneeAgentId: '',
			parents: [],
			priority: 'normal',
			worktreeEnabled: false,
			worktreePath: '',
			worktreeBranch: '',
			prOnDoneEnabled: false,
			prTargetBranch: '',
			status: 'todo',
		};
		draftBaselineRef.current = fresh;
		setDraft(fresh);
	}, [selectedCollection, projectRoot]);

	const openEditCard = useCallback(
		(card: BoardCard, focusMove = false, collection = selectedCollection) => {
			setCycleError(null);
			setSaveError(null);
			setFocusMovePicker(focusMove);
			if (!collection) return;
			const existing: CardDraft = {
				collection: structuredClone(collection),
				projectRoot,
				kind: card.kind,
				id: card.id,
				title: card.title,
				body: card.body,
				assigneeProfileId: card.assigneeProfileId ?? '',
				role:
					card.role ??
					(typeof (card as BoardCard & { profileNamespace?: string }).profileNamespace ===
						'string' && card.assigneeProfileId
						? {
								namespace: (card as BoardCard & { profileNamespace: string }).profileNamespace,
								profileId: card.assigneeProfileId,
							}
						: undefined),
				executionScope: card.executionScope ?? undefined,
				repositoryId: card.repositoryId ?? '',
				workingDirectory: card.workingDirectory ?? '',
				startModeOverride: card.startModeOverride,
				assigneeAgentId: card.assigneeAgentId ?? '',
				parents: [...card.parents],
				priority: card.priority ?? 'normal',
				worktreeEnabled: !!card.worktree,
				worktreePath: card.worktree?.path ?? '',
				worktreeBranch: card.worktree?.branch ?? '',
				prOnDoneEnabled: !!card.prOnDone,
				prTargetBranch: card.prOnDone?.targetBranch ?? '',
				status: card.status,
				createdAt: card.createdAt,
				storageRevision: card.storageRevision,
			};
			draftBaselineRef.current = existing;
			setDraft(existing);
		},
		[selectedCollection, projectRoot]
	);

	const openReview = useCallback(() => {
		if (!draft?.id || !board || isDraftDirty) return;
		const work = board.cards.find((card) => card.id === draft.id);
		if (!work) return;
		const run = work.runs?.[work.runs.length - 1];
		if (!run?.artifact || !run.summary?.trim()) {
			notifyToast({
				color: 'red',
				title: 'Review artifact unavailable',
				message:
					'The source attempt needs a host-observed clean commit and reported checks before a review can be added.',
			});
			return;
		}
		const review: CardDraft = {
			...draft,
			id: null,
			kind: 'review',
			title: `Review: ${work.title}`,
			body: '',
			parents: [work.id],
			status: 'todo',
			createdAt: undefined,
			storageRevision: undefined,
			assigneeProfileId: '',
			role: undefined,
			assigneeAgentId: '',
			executionScope: undefined,
			startModeOverride: undefined,
			worktreeEnabled: false,
			prOnDoneEnabled: false,
			reviewContext: {
				sourceCardId: work.id,
				attempt: run.attempt,
				branch: run.artifact.branch,
				worktree: run.artifact.worktreePath,
				commit: run.artifact.commit,
				checks: run.summary,
			},
		};
		draftBaselineRef.current = review;
		setDraft(review);
		setSaveError(null);
	}, [draft, board, isDraftDirty]);

	const closeEditor = useCallback(() => {
		setShowNewRole(false);
		setDraft(null);
		setSaveError(null);
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
		if (showNewRole) {
			setShowNewRole(false);
			return;
		}
		if (renaming) {
			setRenaming(false);
			return;
		}
		if (isDraftDirty) {
			setPendingDiscard('modal');
			return;
		}
		onClose();
	}, [showNewRole, renaming, isDraftDirty, onClose]);

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
			(!draft.reviewContext ||
				(!!draft.reviewContext.branch.trim() &&
					!!draft.reviewContext.worktree.trim() &&
					/^[a-f0-9]{40}$/i.test(draft.reviewContext.commit.trim()) &&
					!!draft.reviewContext.checks.trim())) &&
			!!catalog &&
			!catalogError &&
			(!draft.worktreeEnabled || !!draft.workingDirectory.trim() || !!draft.worktreePath.trim()) &&
			!saving,
		[draft, projectRoot, board, catalog, catalogError, saving]
	);

	/** Replace one board in the list (every card mutation returns the whole board). */
	const applyBoard = useCallback(
		(updated: Board, readiness?: Extract<BoardCaptureResponse, { ok: true }>['readiness']) => {
			const key = editorCollection?.collectionKey;
			setCollections((prev) =>
				prev.map((entry) =>
					entry.collectionKey === key
						? {
								...entry,
								board: updated,
								readiness,
								revision: updated.storage?.expectedRevision ?? entry.revision,
							}
						: entry
				)
			);
		},
		[editorCollection]
	);

	const handleSaveCard = useCallback(async () => {
		if (!draft || !board || !projectRoot || !canSaveDraft) return;

		const current = collections.find(
			(entry) => entry.collectionKey === draft.collection.collectionKey
		);
		if (!current || current.revision !== draft.collection.revision) {
			const message =
				'This collection changed while you were editing. Reopen the card before saving.';
			setSaveError({ code: 'stale-revision', message });
			notifyToast({ color: 'red', title: 'Board', message });
			return;
		}
		const now = new Date().toISOString();
		const cardId = draft.id ?? generateUUID();
		// Phase 4: the toggle expresses intent; blank path/branch fields fall back
		// to the conventional `board/<board>/<card>` naming the CLI and dispatcher
		// derive from the same helper, so an isolated card is predictable.
		const autoWorktree = draft.workingDirectory.trim()
			? buildCardWorktreeRef(draft.workingDirectory.trim(), board.id, cardId)
			: undefined;
		const original = board.cards.find((entry) => entry.id === draft.id);
		const card: BoardCard = {
			...original, // Retain host policy, hold, runs, migration metadata and unknown fields.
			id: cardId,
			title: draft.title.trim(),
			body: draft.reviewContext
				? `${draft.body}\n\nReview artifact:\nBranch: ${draft.reviewContext.branch.trim()}\nWorktree: ${draft.reviewContext.worktree.trim()}\nCommit: ${draft.reviewContext.commit.trim()}\nChecks: ${draft.reviewContext.checks.trim()}`.trim()
				: draft.body,
			kind: draft.kind,
			parents: draft.parents,
			status: draft.status,
			createdAt: draft.createdAt ?? now,
			updatedAt: now,
			...(draft.storageRevision !== undefined ? { storageRevision: draft.storageRevision } : {}),
			// Assignee: a role (profile) and/or a pinned agent. Omit blank fields so
			// a role-only card retains its explicit scope and a pinned card carries
			// no stale profile id.
			assigneeProfileId: draft.assigneeProfileId || undefined,
			assigneeAgentId: draft.assigneeAgentId || undefined,
			// `normal` is the default and is never serialized.
			priority: draft.priority !== 'normal' ? draft.priority : undefined,
			...(draft.worktreeEnabled
				? {
						worktree: {
							path: draft.worktreePath.trim() || autoWorktree!.path,
							...(draft.worktreeBranch.trim() || autoWorktree?.branch
								? { branch: draft.worktreeBranch.trim() || autoWorktree?.branch }
								: {}),
						},
					}
				: { worktree: undefined }),
			// F3: absent = feature off, so the field is only written when the toggle
			// is on AND the card is worktree-isolated (a PR needs a branch to open
			// from). A blank target branch stays absent, which means "resolve the
			// repo default branch at PR time".
			...(draft.worktreeEnabled && draft.prOnDoneEnabled
				? {
						prOnDone: draft.prTargetBranch.trim()
							? { targetBranch: draft.prTargetBranch.trim() }
							: {},
					}
				: { prOnDone: undefined }),
		};
		// Explicit unsets repair bindings; untouched legacy nulls remain lossless.
		for (const [key, value] of Object.entries({
			executionScope: draft.executionScope,
			repositoryId: draft.repositoryId || undefined,
			workingDirectory: draft.workingDirectory.trim() || undefined,
			startModeOverride: draft.startModeOverride,
		})) {
			if (
				!original ||
				canonicalJson({ value }) !==
					canonicalJson({
						value: (original as unknown as Record<string, unknown>)[key] ?? undefined,
					})
			)
				Object.assign(card, { [key]: value });
		}
		if (
			!original ||
			canonicalJson(draft.role ?? null) !== canonicalJson(draftBaselineRef.current?.role ?? null) ||
			draft.assigneeProfileId !== draftBaselineRef.current?.assigneeProfileId
		) {
			Object.assign(card, { role: draft.role, profileNamespace: draft.role?.namespace });
		}

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
		setSaveError(null);
		try {
			const isNew = draft.id === null;
			const response = await window.maestro.board.captureCard({
				projectRoot: draft.projectRoot,
				boardId: draft.collection.board.id,
				expectedRevision: draft.collection.revision,
				card,
				...(draft.reviewContext
					? {
							reviewSource: {
								cardId: draft.reviewContext.sourceCardId,
								attempt: draft.reviewContext.attempt,
							},
						}
					: {}),
			});
			if (!response.ok) {
				setSaveError(response.error);
				if (response.error.code === 'stale-revision') await load(false);
				return;
			}
			applyBoard(response.value, response.readiness);
			setCaptureResult({
				collectionKey: draft.collection.collectionKey,
				cardId: card.id,
				response,
			});
			closeEditor();
			notifyToast({
				color: 'green',
				title: 'Board',
				message: isNew ? `Created "${card.title}".` : `Updated "${card.title}".`,
			});
		} catch (err) {
			const message = ipcErrorMessage(err);
			setSaveError({ code: 'transport-error', message });
			logger.error(`Failed to save card: ${message}`);
			captureException(err, { tags: { operation: 'board:saveCard' } });
			// The storage layer rejects cycles too - surface that inline rather than
			// as a generic toast.
			if (/cycl/i.test(message)) {
				setCycleError('This parent selection would create a dependency cycle.');
			} else if (/status changed|set by the dispatcher/i.test(message)) {
				await load(false);
				notifyToast({
					color: 'red',
					title: 'Board',
					message:
						'This card changed while you were editing. Reopen the card to see its current status.',
				});
			} else {
				notifyToast({ color: 'red', title: 'Board', message: `Failed to save card: ${message}` });
			}
		} finally {
			setSaving(false);
		}
	}, [draft, board, projectRoot, canSaveDraft, closeEditor, applyBoard, load, collections]);

	const handleApproveStart = useCallback(async () => {
		if (!draft?.id || isDraftDirty || saving || !draft.projectRoot) return;
		const card = draft.collection.board.cards.find((entry) => entry.id === draft.id);
		if (card?.capturePolicy?.dispatchApproval !== 'required' || card.storageRevision === undefined)
			return;
		setSaving(true);
		setSaveError(null);
		try {
			const result = await window.maestro.board.runtimeCommand({
				action: 'control',
				operation: 'approve',
				target: {
					projectRoot: draft.projectRoot,
					sourceKey: draft.collection.sourceKey,
					collectionKey: draft.collection.collectionKey,
					expectedRevision: draft.collection.revision,
				},
				cardId: draft.id,
				cardRevision: card.storageRevision,
			});
			if (!result.ok) {
				setSaveError(result.error);
				return;
			}
			// Read the host state after its grant. Never manufacture a granted policy
			// or replace the read tokens on a rejected approval.
			const refreshed = await window.maestro.board.queryWorkspace({
				sourceKey: draft.collection.sourceKey,
			});
			if (!refreshed.ok) {
				setSaveError(refreshed.error);
				return;
			}
			const collection = refreshed.value.collections.find(
				(entry) => entry.collectionKey === draft.collection.collectionKey
			);
			const saved = collection?.board.cards.find((entry) => entry.id === draft.id);
			if (!collection || !saved) {
				setSaveError({
					code: 'not-found',
					message: 'Approved card is no longer available. Reload the board.',
				});
				return;
			}
			if (
				draftBaselineRef.current?.collection === draft.collection &&
				draftBaselineRef.current.id === draft.id
			) {
				openEditCard(saved, false, collection);
			}
			setCaptureResult(null);
			await load(false);
		} catch (err) {
			setSaveError({ code: 'transport-error', message: ipcErrorMessage(err) });
			captureException(err, { tags: { operation: 'board:approveStart' } });
		} finally {
			setSaving(false);
		}
	}, [draft, isDraftDirty, saving, load, openEditCard]);

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
				notifyToast({
					color: 'red',
					title: 'Board',
					message: ipcErrorMessage(err),
				});
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
					message:
						'Stop requested. The card is held; capacity is released after termination is confirmed.',
				});
			} catch (err) {
				logger.error(`Failed to cancel card: ${String(err)}`);
				captureException(err, { tags: { operation: 'board:cancelCard' } });
				notifyToast({ color: 'red', title: 'Board', message: 'Failed to stop the card.' });
			}
		},
		[board, projectRoot, applyBoard]
	);

	/** Release only through the owning runtime, after termination is confirmed. */
	const handleResumeCard = useCallback(
		async (cardId: string) => {
			if (!board || !projectRoot) return;
			const card = board.cards.find((c) => c.id === cardId);
			if (!card?.heldByUser) return;
			try {
				const updated = await window.maestro.board.resumeCard(projectRoot, board.id, cardId);
				applyBoard(updated);
				notifyToast({
					color: 'green',
					title: 'Board',
					message: 'Released the hold. Dispatch still requires all execution and approval checks.',
				});
			} catch (err) {
				logger.error(`Failed to resume card: ${String(err)}`);
				captureException(err, { tags: { operation: 'board:resumeCard' } });
				notifyToast({ color: 'red', title: 'Board', message: 'Failed to resume the card.' });
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
		async (cardId: string, status: CardStatus): Promise<Board | false> => {
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
				return updated;
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
			// Adopt the host read tokens from our own status command without rebasing
			// unsaved specification edits onto an unrelated background refresh.
			const saved = moved.cards.find((card) => card.id === draft.id);
			setDraft((prev) =>
				prev
					? {
							...prev,
							status,
							storageRevision: saved?.storageRevision,
							collection: {
								...prev.collection,
								board: moved,
								revision: moved.storage?.expectedRevision ?? prev.collection.revision,
							},
						}
					: prev
			);
			if (draftBaselineRef.current) {
				const baseline = draftBaselineRef.current;
				draftBaselineRef.current = {
					...baseline,
					status,
					storageRevision: saved?.storageRevision,
					collection: {
						...baseline.collection,
						board: moved,
						revision: moved.storage?.expectedRevision ?? baseline.collection.revision,
					},
				};
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
			if (
				groupFilter !== 'all' &&
				!(card.executionScope?.kind === 'group' && card.executionScope.groupId === groupFilter)
			)
				continue;
			if (
				agentFilter !== 'all' &&
				card.assigneeAgentId !== agentFilter &&
				!(card.executionScope?.kind === 'agent' && card.executionScope.agentId === agentFilter)
			)
				continue;
			if (statusFilter !== 'all' && card.status !== statusFilter) continue;
			if (kindFilter === 'unspecified' && card.kind !== undefined) continue;
			if (kindFilter !== 'all' && kindFilter !== 'unspecified' && card.kind !== kindFilter)
				continue;
			map.get(card.status)?.push(card);
		}
		return map;
	}, [board, kindFilter, statusFilter, groupFilter, agentFilter]);

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

	const resizing = useResizableModal({
		resizeKey: 'board',
		defaultSize: { width: 1200, height: 860 },
		minSize: { width: 400, height: 320 },
		externalRef: dialogRef,
	});
	return createPortal(
		<div
			className="fixed inset-0 flex items-center justify-center select-none"
			style={{ zIndex: MODAL_PRIORITIES.BOARD_MODAL }}
			onClick={(e) => {
				// Same guard as Escape: a backdrop click must not silently drop edits.
				if (e.target === e.currentTarget) handleEscape();
			}}
		>
			{roleSource && (
				<ProfilesModal
					key={roleSource.sourceKey}
					theme={theme}
					source={roleSource}
					onClose={() => {
						setRoleSource(null);
						void refreshCaptureCatalog().catch(() => {});
					}}
				/>
			)}

			<div className="absolute inset-0 bg-black/50" />

			<div
				ref={dialogRef}
				role="dialog"
				aria-modal="true"
				aria-labelledby={TITLE_ID}
				tabIndex={-1}
				className="relative rounded-xl shadow-2xl flex flex-col outline-none"
				style={{
					...resizing.style,
					backgroundColor: theme.colors.bgMain,
					border: `1px solid ${theme.colors.border}`,
				}}
			>
				<ResizeHandles
					onResizeStart={resizing.onResizeStart}
					onResetSize={resizing.onResetSize}
					canReset={resizing.canReset}
					accentColor={theme.colors.accent}
				/>
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
								value={editorCollection?.collectionKey ?? ''}
								disabled={!!draft}
								onChange={(e) => setSelectedBoardId(e.target.value)}
								aria-label="Select board"
								title="Switch board"
								className="rounded-md px-2 py-1 text-xs outline-none max-w-[180px]"
								style={inputStyle}
							>
								{(draft ? [draft.collection] : visibleCollections).map((entry) => (
									<option key={entry.collectionKey} value={entry.collectionKey}>
										{entry.board.name}
										{visibleCollections.some(
											(other) =>
												other.collectionKey !== entry.collectionKey &&
												other.board.name === entry.board.name
										) && ` · ${sourceRoots[entry.sourceKey] ?? entry.sourceKey}`}
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
							card DAG · dispatched on the Cue tick
						</span>
						{board && !draft && (
							<select
								aria-label="Board start policy"
								value={board.defaultStartMode ?? 'approval'}
								disabled={!projectRoot}
								className="rounded-md px-2 py-1 text-xs outline-none"
								style={inputStyle}
								onChange={async (event) => {
									try {
										const response = await window.maestro.board.setStartPolicy(
											projectRoot,
											board.id,
											board.storage!.expectedRevision!,
											event.target.value as 'approval' | 'direct'
										);
										if (!response.ok) throw new Error(response.error.message);
										await load();
									} catch (error) {
										captureException(error, { tags: { operation: 'board:setStartPolicy' } });
										notifyToast({ color: 'red', title: 'Board', message: String(error) });
									}
								}}
							>
								<option value="approval">New cards: require approval</option>
								<option value="direct">New cards: schedule directly</option>
							</select>
						)}

						{/* Show the host-confirmed writer project for the selected collection. */}
						{projectRoot && (
							<span
								className="text-xs truncate min-w-0"
								style={{ color: theme.colors.textDim }}
								title={projectLocationLabel}
							>
								{truncatePath(projectLocationLabel)}
							</span>
						)}
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
								disabled={creatingBoard || !projectRoot}
								className="rounded-md px-2.5 py-1.5 text-xs transition-colors hover:bg-white/5 disabled:opacity-40"
								style={{ border: `1px solid ${theme.colors.border}`, color: theme.colors.textMain }}
								title="Create another board for this project"
							>
								New board
							</button>
						)}
						{board && !draft && (
							<button
								onClick={openNewCard}
								className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-opacity"
								style={{ backgroundColor: theme.colors.accent, color: theme.colors.bgMain }}
								title="Add a card"
							>
								<Plus className="w-4 h-4" /> New card
							</button>
						)}
						<button
							onClick={() => {
								setShowWorkers((visible) => !visible);
								if (!showWorkers) void refreshWorkers();
							}}
							className="rounded-md px-2.5 py-1.5 text-xs hover:bg-white/5"
							style={{ border: `1px solid ${theme.colors.border}`, color: theme.colors.textMain }}
							aria-expanded={showWorkers}
						>
							Workers
						</button>
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

				{showWorkers && (
					<div
						className="shrink-0 p-4 border-b max-h-64 overflow-auto text-sm"
						style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
					>
						<p style={{ color: theme.colors.warning }}>
							Intake pause prevents new Board starts. Work already running continues.
						</p>
						<button
							disabled={workerBusy || creatorOpen || pendingWorkerId !== null}
							onClick={createWorker}
						>
							Create agent and add worker
						</button>
						{workerCreationError && (
							<p role="alert" className="select-text" style={{ color: theme.colors.error }}>
								{workerCreationError}
							</p>
						)}
						{pendingWorkerId && (
							<div>
								<p>
									Agent awaiting worker registration:{' '}
									{sessionById.get(pendingWorkerId)?.name ?? pendingWorkerId}
								</p>
								<button
									disabled={workerBusy}
									onClick={() => void registerCreatedWorker(pendingWorkerId)}
								>
									Retry worker registration
								</button>
							</div>
						)}
						{workers
							.filter((worker) => !sessionById.has(worker.agentId))
							.map((worker) => (
								<div key={worker.agentId} className="py-2">
									{worker.agentId} — agent missing; {worker.enabled ? 'enabled' : 'disabled'}
									{worker.paused ? ', intake paused' : ''}; occupancy unknown
								</div>
							))}
						{liveSessions.map((session) => {
							const worker = workersByAgent.get(session.id);
							const observedRun = observedRuns.get(session.id);
							const roles = worker?.payload.roleRefs;
							const repos = worker?.payload.allowedRepositoryIds;
							const validAccess =
								Array.isArray(roles) &&
								roles.every(
									(role) =>
										role && typeof role.namespace === 'string' && typeof role.profileId === 'string'
								) &&
								Array.isArray(repos) &&
								repos.every((id) => typeof id === 'string');
							return (
								<div key={session.id} className="flex flex-col gap-2 py-2">
									<div className="flex items-center justify-between gap-2">
										<span>
											{session.name}
											{worker
												? ` — ${worker.enabled ? 'enabled' : 'disabled'}${worker.paused ? ', intake paused' : ''}`
												: ''}
										</span>
										{worker ? (
											<div className="flex gap-2">
												<button
													disabled={workerBusy}
													onClick={() =>
														void changeWorker(() =>
															window.maestro.board.enableWorker(session.id, !worker.enabled)
														)
													}
												>
													{worker.enabled ? 'Disable' : 'Enable'}
												</button>
												<button
													disabled={workerBusy}
													onClick={() =>
														void changeWorker(() =>
															window.maestro.board.pauseWorker(session.id, !worker.paused)
														)
													}
												>
													{worker.paused ? 'Resume intake' : 'Pause intake'}
												</button>
											</div>
										) : (
											<button
												disabled={workerBusy}
												onClick={() =>
													void changeWorker(() => window.maestro.board.registerWorker(session.id))
												}
											>
												Add worker
											</button>
										)}
									</div>
									{worker && (
										<div>
											Agent state: {session.state}; global occupancy unknown
											{observedRun && `; observed running card in loaded boards: ${observedRun}`}
										</div>
									)}
									{worker && validAccess && (
										<div>
											<div>
												Roles:{' '}
												{workerAccessOptions.roles.map((role) => {
													const selected = roles.some(
														(entry) =>
															entry.namespace === role.namespace &&
															entry.profileId === role.profileId
													);
													return (
														<label
															key={JSON.stringify([role.namespace, role.profileId])}
															className="ml-2"
														>
															<input
																type="checkbox"
																disabled={workerBusy}
																checked={selected}
																onChange={() =>
																	void changeWorker(() =>
																		window.maestro.board.setWorkerAccess(
																			session.id,
																			selected
																				? roles.filter(
																						(entry) =>
																							entry.namespace !== role.namespace ||
																							entry.profileId !== role.profileId
																					)
																				: [
																						...roles,
																						{
																							namespace: role.namespace,
																							profileId: role.profileId,
																						},
																					],
																			repos
																		)
																	)
																}
															/>{' '}
															{role.name} ({role.namespace})
														</label>
													);
												})}
											</div>
											<div>
												Repositories:{' '}
												{workerAccessOptions.repositories.map((repo) => (
													<label key={repo.id} className="ml-2">
														<input
															type="checkbox"
															disabled={workerBusy}
															checked={repos.includes(repo.id)}
															onChange={() =>
																void changeWorker(() =>
																	window.maestro.board.setWorkerAccess(
																		session.id,
																		roles,
																		repos.includes(repo.id)
																			? repos.filter((id) => id !== repo.id)
																			: [...repos, repo.id]
																	)
																)
															}
														/>{' '}
														{repo.name}
													</label>
												))}
											</div>
										</div>
									)}
									{worker && !validAccess && (
										<span>Access data needs repair; existing values are preserved.</span>
									)}
								</div>
							);
						})}
					</div>
				)}
				{/* Body */}
				<div className="flex-1 overflow-hidden flex flex-col">
					{!projectRoot && (
						<div className="p-5 text-sm" style={{ color: theme.colors.textDim }}>
							Select an agent with a registered project to edit this source. All central boards
							remain visible.
						</div>
					)}

					{!board && !loading && (
						<div className="flex flex-col items-center justify-center gap-3 h-full">
							<div className="text-sm" style={{ color: theme.colors.textDim }}>
								No board yet for this project.
							</div>
							<button
								onClick={() => void handleCreateBoard()}
								disabled={creatingBoard || !projectRoot}
								className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-opacity disabled:opacity-40"
								style={{ backgroundColor: theme.colors.accent, color: theme.colors.bgMain }}
							>
								<Plus className="w-4 h-4" /> Create board
							</button>
						</div>
					)}

					{!draft && (
						<label className="px-4 pt-3">
							Project{' '}
							<select
								aria-label="Filter by project"
								value={projectFilter}
								style={inputStyle}
								onChange={(e) => setProjectFilter(e.target.value)}
							>
								<option value="all">All projects</option>
								{sources.map((source) => (
									<option key={source.sourceKey} value={source.projectRef.sourceKey}>
										{source.location?.location.kind === 'ssh'
											? `${source.location.location.remoteId || 'Unresolved SSH'}: ${source.location.path}`
											: (sourceRoots[source.sourceKey] ?? source.sourceKey)}
									</option>
								))}
							</select>
						</label>
					)}

					{captureResult && captureResult.collectionKey === editorCollection?.collectionKey && (
						<div
							role="status"
							className="px-5 py-2 text-xs"
							style={{ color: theme.colors.textMain }}
						>
							Saved{' '}
							{
								captureResult.response.value.cards.find((card) => card.id === captureResult.cardId)
									?.title
							}
							.
							{captureResult.response.readiness[captureResult.cardId] === undefined
								? ' Host readiness unavailable.'
								: captureResult.response.readiness[captureResult.cardId].length > 0
									? ` Waiting: ${captureResult.response.readiness[captureResult.cardId].join(', ')}.`
									: ' Dispatch checks pending Cue.'}
							{' Start approval: '}
							{captureResult.response.value.cards.find((card) => card.id === captureResult.cardId)
								?.capturePolicy?.dispatchApproval ?? 'unknown'}
							.
						</div>
					)}

					{/* Card editor (create/edit) */}
					{board && draft && (
						<CardEditor
							onManageRoles={() =>
								setRoleSource({
									sourceKey: draft.collection.sourceKey,
									namespace: `legacy:${draft.collection.sourceKey}`,
								})
							}
							onRevalidateSource={async () => {
								const result = await window.maestro.board.sourceCommand({
									action: 'revalidate',
									sourceKey: draft.collection.sourceKey,
								});
								await refreshCaptureCatalog();
								if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
							}}
							showNewRole={showNewRole}
							setShowNewRole={setShowNewRole}
							theme={theme}
							draft={draft}
							setDraft={setDraft}
							catalog={catalog}
							catalogError={catalogError}
							saveError={saveError}
							onRefreshCatalog={() => void refreshCaptureCatalog().catch(() => {})}
							onCreateRole={async (profile) => {
								let role = createdRoles.current.get(profile.id);
								if (!role) {
									role = await window.maestro.board.upsertRole(projectRoot, profile);
									createdRoles.current.set(profile.id, role);
								}
								const updated = await refreshCaptureCatalog();
								if (
									!updated.profiles.some(
										(entry) =>
											entry.namespace === role!.namespace && entry.profile.id === role!.profileId
									)
								)
									throw new Error(
										'Role created, but its Board namespace is not available in the host catalog.'
									);
								setDraft((p) => (p ? { ...p, role, assigneeProfileId: profile.id } : p));
							}}
							board={board}
							cycleError={cycleError}
							saving={saving}
							canSave={canSaveDraft}
							inputStyle={inputStyle}
							onToggleParent={toggleParent}
							onAddReview={openReview}
							canAddReview={!isDraftDirty}
							canApproveStart={!isDraftDirty && !!draft.projectRoot}
							onApproveStart={() => void handleApproveStart()}
							onSave={() => void handleSaveCard()}
							onCancel={requestCloseEditor}
							onMove={(status) => void handleMoveDraft(status)}
							autoFocusMove={focusMovePicker}
							profileName={profileName}
							projectAgents={allSessions.map((session) => ({
								id: session.id,
								name: session.name,
								isWorker: workers.some((worker) => worker.agentId === session.id && worker.enabled),
							}))}
							activeAgentId={activeSession?.id ?? ''}
						/>
					)}

					{/* Kanban columns */}
					{board && !draft && (
						<div className="flex flex-wrap gap-3 px-4 pt-3">
							<label>
								Group{' '}
								<select
									aria-label="Filter by group"
									style={inputStyle}
									value={groupFilter}
									onChange={(e) => setGroupFilter(e.target.value)}
								>
									<option value="all">All groups</option>
									{groups.map((group) => (
										<option key={group.id} value={group.id}>
											{group.name}
										</option>
									))}
								</select>
							</label>
							<label>
								Agent{' '}
								<select
									aria-label="Filter by agent"
									style={inputStyle}
									value={agentFilter}
									onChange={(e) => setAgentFilter(e.target.value)}
								>
									<option value="all">All agents</option>
									{allSessions.map((session) => (
										<option key={session.id} value={session.id}>
											{session.name}
										</option>
									))}
								</select>
							</label>

							<label>
								Type{' '}
								<select
									aria-label="Filter by type"
									style={inputStyle}
									value={kindFilter}
									onChange={(e) => setKindFilter(e.target.value as typeof kindFilter)}
								>
									<option value="all">All types</option>
									<option value="unspecified">Unspecified</option>
									<option value="work">Work</option>
									<option value="review">Review</option>
									<option value="test">Test</option>
									<option value="documentation">Documentation</option>
								</select>
							</label>
							<label>
								Status{' '}
								<select
									aria-label="Filter by status"
									style={inputStyle}
									value={statusFilter}
									onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
								>
									<option value="all">All statuses</option>
									{CARD_STATUSES.map((status) => (
										<option key={status} value={status}>
											{STATUS_META[status].label}
										</option>
									))}
								</select>
							</label>
						</div>
					)}
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
													className="text-2xs font-bold rounded-full px-1.5 py-0.5"
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
														readiness={selectedCollection?.readiness?.[card.id]}
														board={board}
														profileName={profileName}
														agentName={agentName}
														projectAgents={projectAgents}
														onJumpToAgent={handleJumpToAgent}
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
														onResume={() => void handleResumeCard(card.id)}
													/>
												))}
												{cards.length === 0 && (
													<div
														className="text-xs-plus text-center py-4"
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
						className="shrink-0 px-4 py-2 border-t text-xs-plus"
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
	readiness?: string[];
	theme: Theme;
	card: BoardCard;
	board: Board;
	profileName: (id: string) => string;
	agentName: (id: string) => string;
	/** Project agents, used to check whether a run's worker still exists. */
	projectAgents: { id: string; name: string; isWorker: boolean }[];
	/** Jump to the worker agent that ran this card (worker chip click). */
	onJumpToAgent: (agentId: string) => void;
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
	/** Release an AB1 user hold. Only rendered on cards with `heldByUser`. */
	onResume: () => void;
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
	projectAgents,
	onJumpToAgent,
	dragging,
	registerTile,
	onDragStart,
	onDragEnd,
	onClick,
	onMoveRequest,
	onNavigate,
	onDelete,
	onCancelRun,
	onResume,
	readiness,
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
	// X1: the PR-on-done outcome of the last run. A successful attempt stamps
	// `prUrl`; a failed one stamps `prError` and leaves the card `done`. Display
	// only - there is deliberately no retry button here, because the PR gate
	// keys on `prUrl` alone, so moving the card out of `done` and back re-fires
	// the flow.
	const runPrUrl = latestRun?.prUrl;
	const runPrError = latestRun?.prError;
	// Phase 6: a running card says how long it has been going, which attempt this
	// is, and which pooled worker claimed it.
	const isRunning = card.status === 'running';
	// AB1: a card the user stopped stays in To Do but carries an explicit hold the
	// promote pass honours, so it needs a visible reason and a way back.
	const isHeld = !!card.heldByUser;
	const workerAgentId = latestRun?.workerAgentId ?? null;
	const workerText = workerAgentId ? agentName(workerAgentId) : null;
	// The worker chip is a jump affordance only while the worker agent still
	// exists; a deleted agent renders a non-interactive span instead.
	const workerAgentExists = workerAgentId
		? projectAgents.some((a) => a.id === workerAgentId)
		: false;
	// Keep the execution boundary visible even when a card has no pin or role.
	const roleText = card.assigneeProfileId ? profileName(card.assigneeProfileId) : null;
	const pinText = card.assigneeAgentId ? `📌 ${agentName(card.assigneeAgentId)}` : null;
	const scopeText =
		card.executionScope?.kind === 'agent'
			? `Agent: ${agentName(card.executionScope.agentId)} (${card.executionScope.agentId})`
			: card.executionScope?.kind === 'group'
				? `Group: ${card.executionScope.groupId}`
				: 'Unassigned scope';
	const assigneeText = [scopeText, roleText, pinText].filter(Boolean).join(' · ');
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
					{isHeld && (
						<button
							onClick={(e) => {
								e.stopPropagation();
								onResume();
							}}
							className="p-0.5 rounded hover:bg-white/10 transition-colors"
							style={{ color: theme.colors.success }}
							aria-label={`Resume ${card.title}`}
							title="Resume this card - it was stopped and is held until you say go"
						>
							<Play className="w-3.5 h-3.5" />
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
						className="text-2xs font-semibold rounded px-1.5 py-0.5 uppercase tracking-wide"
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
					className="text-2xs rounded px-1.5 py-0.5 truncate max-w-full"
					style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}
					title={assigneeText}
				>
					{assigneeText}
				</span>
				{(card.status === 'todo' || card.status === 'ready') && (
					<div className="text-2xs" style={{ color: theme.colors.textDim }}>
						Waiting: {readiness?.length ? readiness.join(', ') : 'host diagnosis unknown'}
					</div>
				)}
				{isHeld && (
					<span
						className="text-2xs rounded px-1.5 py-0.5"
						style={{
							backgroundColor: theme.colors.warning + '22',
							color: theme.colors.warning,
						}}
						title="You stopped this card. It stays put until you resume it."
					>
						held
					</span>
				)}
				{isRunning && latestRun && (
					<span
						className="text-2xs rounded px-1.5 py-0.5"
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
				{workerText &&
					workerAgentId &&
					(workerAgentExists ? (
						<button
							onClick={(e) => {
								// Don't also trigger the tile's editor-opening onClick.
								e.stopPropagation();
								onJumpToAgent(workerAgentId);
							}}
							className="text-2xs rounded px-1.5 py-0.5 truncate max-w-full hover:bg-white/10 transition-colors"
							style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}
							title={
								isRunning
									? `Running on worker "${workerText}" - click to open`
									: `Open worker "${workerText}"`
							}
						>
							⚙ {workerText}
						</button>
					) : (
						<span
							className="text-2xs rounded px-1.5 py-0.5 truncate max-w-full"
							style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}
							title="This worker agent has been deleted"
						>
							⚙ {workerText}
						</span>
					))}
				{card.parents.length > 0 && (
					<span
						className="text-2xs rounded px-1.5 py-0.5"
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
						className="text-2xs rounded px-1.5 py-0.5 truncate max-w-full select-text"
						style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}
						title={`Last run used the worktree at ${runWorktreePath ?? 'an isolated checkout'} on branch ${runBranch}`}
					>
						🌳 {runBranch}
					</span>
				)}
				{runPrUrl && (
					<button
						onClick={(e) => {
							// Don't also open the card editor behind the link.
							e.stopPropagation();
							openUrl(runPrUrl, { ctrlKey: e.ctrlKey || e.metaKey });
						}}
						className="text-2xs rounded px-1.5 py-0.5 truncate max-w-full hover:bg-white/10 transition-colors"
						style={{ backgroundColor: theme.colors.success + '22', color: theme.colors.success }}
						title={`Pull request opened for this card: ${runPrUrl}`}
					>
						🔗 PR
					</button>
				)}
				{!runPrUrl && runPrError && (
					<span
						className="text-2xs rounded px-1.5 py-0.5 truncate max-w-full select-text"
						style={{ backgroundColor: theme.colors.error + '22', color: theme.colors.error }}
						title={`PR on done failed: ${runPrError}. Move the card out of Done and back to retry.`}
					>
						⚠ PR failed
					</span>
				)}
			</div>
			{/* Non-running cards surface the last run's handoff summary as a 2-line
			    preview on the tile face - the run's durable payoff, no longer buried
			    in the "Full run details" disclosure below. */}
			{!isRunning && latestSummary && (
				<div
					className="mt-1.5 text-2xs leading-snug line-clamp-2 select-text"
					style={{ color: theme.colors.textDim }}
				>
					{latestSummary}
				</div>
			)}
			{showRunDetails && latestRun && (
				<details
					className="mt-1.5 select-text"
					// Stop the click bubbling to the tile so toggling the summary doesn't
					// open the card editor.
					onClick={(e) => e.stopPropagation()}
				>
					<summary
						className="text-2xs cursor-pointer list-none opacity-70 hover:opacity-100"
						style={{ color: theme.colors.textDim }}
					>
						{isRunning ? 'Run details' : 'Full run details'}
					</summary>
					{/* Board runs are headless `executeCuePrompt` spawns with no visible
					    tab, so this is the live view: status, elapsed, worker, branch. */}
					<div className="mt-1 text-2xs leading-snug" style={{ color: theme.colors.textDim }}>
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
							className="mt-1 text-2xs leading-snug whitespace-pre-wrap"
							style={{ color: theme.colors.textDim }}
						>
							{latestSummary}
						</div>
					)}
					{runBranch && (
						<div
							className="mt-1 text-2xs leading-snug break-all"
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
	onManageRoles: () => void;
	onRevalidateSource: () => Promise<void>;
	showNewRole: boolean;
	setShowNewRole: React.Dispatch<React.SetStateAction<boolean>>;
	theme: Theme;
	draft: CardDraft;
	setDraft: React.Dispatch<React.SetStateAction<CardDraft | null>>;
	catalog: BoardCaptureCatalog | null;
	catalogError: string | null;
	saveError: Extract<BoardCaptureResponse, { ok: false }>['error'] | null;
	onRefreshCatalog: () => void;
	onCreateRole: (profile: AgentProfile) => Promise<void>;
	board: Board;
	cycleError: string | null;
	saving: boolean;
	canSave: boolean;
	inputStyle: React.CSSProperties;
	onToggleParent: (parentId: string) => void;
	onAddReview: () => void;
	canAddReview: boolean;
	canApproveStart: boolean;
	onApproveStart: () => void;
	onSave: () => void;
	onCancel: () => void;
	/** Persist a column change immediately (existing cards only). */
	onMove: (status: CardStatus) => void;
	/** Land focus on the "Move to" picker (the tile's `m` shortcut). */
	autoFocusMove: boolean;
	profileName: (id: string) => string;
	projectAgents: { id: string; name: string; isWorker: boolean }[];
	/** Active Left Bar agent id; seeds the inline "+ New role" base-agent default. */
	activeAgentId: string;
}

/** Inline create/edit form for a card. Replaces the board view while open, the
 * same grid-vs-details pattern the Extensions pane uses. Content-driven, so its
 * root opts back into text selection. */
function CardEditor({
	onManageRoles,
	onRevalidateSource,
	showNewRole,
	setShowNewRole,
	theme,
	draft,
	setDraft,
	catalog,
	catalogError,
	saveError,
	onRefreshCatalog,
	onCreateRole,
	board,
	cycleError,
	saving,
	canSave,
	inputStyle,
	onToggleParent,
	onAddReview,
	canAddReview,
	canApproveStart,
	onApproveStart,
	onSave,
	onCancel,
	onMove,
	autoFocusMove,
	profileName,
	projectAgents,
	activeAgentId,
}: CardEditorProps) {
	const [repairMessage, setRepairMessage] = useState<string | null>(null);
	// Candidate parents are every other card (a card cannot depend on itself).
	const candidateParents = board.cards.filter((c) => c.id !== draft.id);
	const isExisting = draft.id !== null;
	const scope = draft.executionScope;
	const agents = catalog?.agents ?? [];
	const agentLabel = (id: string) => projectAgents.find((entry) => entry.id === id)?.name ?? id;
	const roles = catalog?.profiles ?? [];
	const selectedRole = draft.role
		? canonicalJson(draft.role)
		: draft.assigneeProfileId
			? 'legacy-unresolved'
			: '';
	const scopeValue = scope ? canonicalJson(scope) : '';
	const moveRef = useRef<HTMLSelectElement>(null);
	// One-shot, like the dialog's initial focus: without it every later render
	// (a `board:changed` push, a keystroke) would yank focus back to the picker.
	const moveFocusDone = useRef(false);
	useFocusAfterRender(moveRef, autoFocusMove && isExisting && !moveFocusDone.current);
	useEffect(() => {
		moveFocusDone.current = true;
	}, []);

	// Inline "+ New role" quick-create. The modal owns open state for capture-phase
	// Escape; the editor keeps scratch values local so the mini-form's
	// name/base-agent scratch state and its async saving flag never touch the card
	// `draft` (and so never trip the dirty-check). Only a successful create mutates
	// the draft, via the host catalog selecting its explicit role namespace.
	const [newRoleName, setNewRoleName] = useState('');
	const [newRoleBaseAgent, setNewRoleBaseAgent] = useState('');
	const [creatingRole, setCreatingRole] = useState(false);
	const pendingRole = useRef<AgentProfile | null>(null);
	const [roleError, setRoleError] = useState<string | null>(null);
	const newRoleNameRef = useRef<HTMLInputElement>(null);
	useFocusAfterRender(newRoleNameRef, showNewRole);

	const openNewRole = useCallback(() => {
		// Default the base agent to the active agent (mirrors ProfilesModal's one-shot
		// default), but only when it is a known agent in the host catalog.
		setNewRoleBaseAgent(agents.some((a) => a.id === activeAgentId) ? activeAgentId : '');
		setNewRoleName('');
		setRoleError(null);
		pendingRole.current = null;
		setShowNewRole(true);
	}, [catalog, activeAgentId]);

	const handleCreateRole = useCallback(async () => {
		const name = newRoleName.trim();
		if (!name || creatingRole) return;
		const profile: AgentProfile = pendingRole.current ?? {
			id: generateUUID(),
			name,
			// Omit baseAgentId entirely for a pool role ("None") so it floats to any
			// free opt-in worker at spawn time.
			...(newRoleBaseAgent ? { baseAgentId: newRoleBaseAgent } : {}),
		};
		pendingRole.current = profile;
		setCreatingRole(true);
		setRoleError(null);
		try {
			await onCreateRole(profile);
			setShowNewRole(false);
			setNewRoleName('');
		} catch (err) {
			// Keep the mini-form open and leave the draft's assigneeProfileId untouched
			// so the user can retry without losing their typed name.
			logger.error(`Failed to create role inline: ${String(err)}`);
			captureException(err, { tags: { operation: 'profiles:upsert' } });
			setRoleError(ipcErrorMessage(err));
			notifyToast({ color: 'red', title: 'Roles', message: ipcErrorMessage(err) });
		} finally {
			setCreatingRole(false);
		}
	}, [newRoleName, newRoleBaseAgent, creatingRole, onCreateRole]);

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

			{isExisting && (
				<div className="text-sm" style={{ color: theme.colors.textMain }}>
					Start approval:{' '}
					{board.cards.find((card) => card.id === draft.id)?.capturePolicy?.dispatchApproval ??
						'unknown'}
					{board.cards.find((card) => card.id === draft.id)?.capturePolicy?.dispatchApproval ===
						'required' && (
						<>
							<button
								type="button"
								className="ml-3"
								disabled={!canApproveStart || saving || draft.storageRevision === undefined}
								onClick={onApproveStart}
							>
								Approve start
							</button>
							{!canApproveStart && (
								<span>
									{' '}
									Save changes and reopen the card before approving its saved specification.
								</span>
							)}
						</>
					)}
				</div>
			)}

			{saveError && (
				<div role="alert" style={{ color: theme.colors.error }}>
					{saveError.code}: {saveError.message}
					{saveError.captureErrors?.length ? ` (${saveError.captureErrors.join(', ')})` : ''}
				</div>
			)}
			{catalogError ? (
				<div role="alert" style={{ color: theme.colors.error }}>
					Capture catalog unavailable: {catalogError}{' '}
					<button type="button" onClick={onRefreshCatalog}>
						Retry catalog
					</button>
				</div>
			) : (
				!catalog && <div role="status">Loading capture choices...</div>
			)}
			{isExisting && (draft.kind === 'work' || draft.kind === undefined) && (
				<button type="button" disabled={!canAddReview || saving} onClick={onAddReview}>
					Add review
				</button>
			)}
			<fieldset disabled={saving} className="space-y-4">
				<label>
					Task type{' '}
					<select
						aria-label="Task type"
						disabled={!!draft.reviewContext}
						value={draft.kind ?? ''}
						onChange={(e) =>
							setDraft((p) =>
								p ? { ...p, kind: (e.target.value || undefined) as BoardCardKind | undefined } : p
							)
						}
						style={inputStyle}
					>
						<option value="">Unspecified</option>
						<option value="work">Work</option>
						<option value="review">Review</option>
						<option value="test">Test</option>
						<option value="documentation">Documentation</option>
					</select>
				</label>
				{draft.reviewContext && (
					<div>
						<p>
							Review depends on the work card. The host verifies the source artifact and reported
							checks; human approval remains separate.
						</p>
						{(['branch', 'worktree', 'commit', 'checks'] as const).map((field) => (
							<label key={field} className="block">
								Review {field}
								<input
									readOnly
									aria-label={`Review ${field}`}
									value={draft.reviewContext![field]}
									onChange={(e) =>
										setDraft((p) =>
											p?.reviewContext
												? { ...p, reviewContext: { ...p.reviewContext, [field]: e.target.value } }
												: p
										)
									}
									style={inputStyle}
								/>
							</label>
						))}
						<p>Commit must be the full 40-character SHA.</p>
					</div>
				)}
				<div className="flex gap-3 flex-wrap">
					<label
						className="block space-y-1 flex-1 min-w-[180px]"
						style={{ color: theme.colors.textDim }}
					>
						<span className="text-xs">Execution scope</span>
						<select
							aria-label="Execution scope"
							value={scopeValue}
							style={inputStyle}
							className="w-full rounded-md px-2 py-1.5 text-sm"
							onChange={(e) => {
								const choices: BoardExecutionScope[] = [
									...agents.map(
										(agent): BoardExecutionScope => ({ kind: 'agent', agentId: agent.id })
									),
									...(catalog?.groups ?? []).map(
										(group): BoardExecutionScope => ({ kind: 'group', groupId: group.id })
									),
								];
								setDraft((p) =>
									p
										? {
												...p,
												executionScope: choices.find(
													(choice) => canonicalJson(choice) === e.target.value
												),
											}
										: p
								);
							}}
						>
							<option value="">Unassigned (waits for scope)</option>
							{scope &&
								((scope.kind === 'agent' && !agents.some((agent) => agent.id === scope.agentId)) ||
									(scope.kind === 'group' &&
										!catalog?.groups.some((group) => group.id === scope.groupId))) && (
									<option value={scopeValue}>
										Missing {scope.kind}: {scope.kind === 'agent' ? scope.agentId : scope.groupId}
									</option>
								)}
							<optgroup label="Agents">
								{agents.map((agent) => (
									<option
										key={agent.id}
										value={canonicalJson({ kind: 'agent', agentId: agent.id })}
									>
										Agent: {agentLabel(agent.id)}
									</option>
								))}
							</optgroup>
							<optgroup label="Groups">
								{catalog?.groups.map((group) => (
									<option
										key={group.id}
										value={canonicalJson({ kind: 'group', groupId: group.id })}
									>
										Group:{' '}
										{useSessionStore.getState().groups.find((entry) => entry.id === group.id)
											?.name ?? group.id}
									</option>
								))}
							</optgroup>
						</select>
					</label>
					<label
						className="block space-y-1 flex-1 min-w-[180px]"
						style={{ color: theme.colors.textDim }}
					>
						<span className="text-xs">Repository</span>
						<select
							aria-label="Repository"
							value={draft.repositoryId}
							style={inputStyle}
							className="w-full rounded-md px-2 py-1.5 text-sm"
							onChange={(e) => setDraft((p) => (p ? { ...p, repositoryId: e.target.value } : p))}
						>
							<option value="">Unresolved repository</option>
							{draft.repositoryId &&
								!catalog?.repositories.some((repo) => repo.id === draft.repositoryId) && (
									<option value={draft.repositoryId}>
										Missing repository: {draft.repositoryId}
									</option>
								)}
							{catalog?.repositories.map((repo) => (
								<option key={repo.id} value={repo.id}>
									{repo.id}: {repo.workingDirectory}
									{repo.location?.kind === 'ssh'
										? ` [SSH: ${repo.location.remoteId || 'unresolved'}]`
										: ''}
									{repo.validated ? '' : ` (unresolved: ${repo.diagnostic ?? 'revalidate source'})`}
								</option>
							))}
						</select>
					</label>
					<label
						className="block space-y-1 flex-1 min-w-[180px]"
						style={{ color: theme.colors.textDim }}
					>
						<span className="text-xs">Working directory</span>
						<input
							aria-label="Working directory"
							value={draft.workingDirectory}
							placeholder="Explicit absolute execution directory"
							style={inputStyle}
							className="w-full rounded-md px-2 py-1.5 text-sm"
							onChange={(e) =>
								setDraft((p) => (p ? { ...p, workingDirectory: e.target.value } : p))
							}
						/>
					</label>
					<label
						className="block space-y-1 flex-1 min-w-[180px]"
						style={{ color: theme.colors.textDim }}
					>
						<span className="text-xs">Start mode</span>
						<select
							aria-label="Start mode"
							value={draft.startModeOverride ?? ''}
							style={inputStyle}
							className="w-full rounded-md px-2 py-1.5 text-sm"
							onChange={(e) =>
								setDraft((p) =>
									p
										? {
												...p,
												startModeOverride:
													e.target.value === 'direct'
														? 'direct'
														: e.target.value === 'approval'
															? 'approval'
															: undefined,
											}
										: p
								)
							}
						>
							<option value="">
								{isExisting
									? `Keep saved policy (${board.cards.find((card) => card.id === draft.id)?.capturePolicy?.effectiveStartMode ?? 'host decides'})`
									: `Board default (${board.defaultStartMode ?? catalog?.defaultStartMode ?? 'approval'})`}
							</option>
							<option value="approval">Require approval</option>
							<option value="direct">Direct scheduling</option>
						</select>
					</label>
				</div>
				<p className="text-xs" style={{ color: theme.colors.textDim }}>
					Incomplete assignments can be saved. The host reports missing references; scope and
					working directory are never inferred.
				</p>
				{draft.worktreeEnabled && !draft.workingDirectory.trim() && !draft.worktreePath.trim() && (
					<div role="alert" style={{ color: theme.colors.error }}>
						Choose a working directory before enabling worktree isolation.
					</div>
				)}

				<button
					type="button"
					onClick={() => {
						void onRevalidateSource()
							.then(() =>
								setRepairMessage(
									'Source revalidated. Select the repository and save explicit card bindings.'
								)
							)
							.catch((error) => setRepairMessage(String(error)));
					}}
				>
					Revalidate selected source
				</button>
				{repairMessage && <div role="status">{repairMessage}</div>}

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
						placeholder="Instructions handed to the assignee agent."
						rows={4}
						className="w-full rounded-md px-2 py-1.5 text-sm outline-none resize-y"
						style={inputStyle}
					/>
				</label>

				<div className="flex gap-3 flex-wrap">
					<div className="block space-y-1 flex-1 min-w-[180px]">
						<div className="flex items-center justify-between gap-2">
							<span className="text-xs" style={{ color: theme.colors.textDim }}>
								Role (profile)
							</span>
							{!showNewRole && (
								<div className="flex items-center gap-2">
									{/* Advanced editing (model / effort / role prompt) stays in the
								    ProfilesModal; the inline mini-form is name + base agent only. */}
									<button
										type="button"
										onClick={onManageRoles}
										className="text-xs opacity-60 hover:opacity-100 underline"
										style={{ color: theme.colors.textDim }}
									>
										Manage roles
									</button>
									<button
										type="button"
										onClick={openNewRole}
										className="flex items-center gap-0.5 text-xs opacity-70 hover:opacity-100"
										style={{ color: theme.colors.accent }}
									>
										<Plus className="w-3 h-3" /> New role
									</button>
								</div>
							)}
						</div>
						{showNewRole ? (
							// Inline quick-create: name + base agent only. Advanced fields
							// (model / effort / role prompt) live in the ProfilesModal.
							<div
								className="space-y-1.5 rounded-md p-2"
								style={{ border: `1px solid ${theme.colors.border}` }}
							>
								{roleError && (
									<div role="alert" style={{ color: theme.colors.error }}>
										{roleError}
									</div>
								)}
								<input
									ref={newRoleNameRef}
									value={newRoleName}
									onChange={(e) => setNewRoleName(e.target.value)}
									onKeyDown={(e) => {
										if (e.key === 'Enter') {
											e.preventDefault();
											void handleCreateRole();
										} else if (e.key === 'Escape') {
											e.preventDefault();
											setShowNewRole(false);
										}
									}}
									placeholder="Role name, e.g. Reviewer"
									className="w-full rounded-md px-2 py-1.5 text-sm outline-none"
									style={inputStyle}
								/>
								<select
									value={newRoleBaseAgent}
									onChange={(e) => setNewRoleBaseAgent(e.target.value)}
									className="w-full rounded-md px-2 py-1.5 text-sm outline-none"
									style={inputStyle}
								>
									{/* Empty = a pool role that floats to any free opt-in worker. */}
									<option value="">None (pool role - any free worker)</option>
									{agents.map((a) => (
										<option key={a.id} value={a.id}>
											{agentLabel(a.id)}
										</option>
									))}
								</select>
								<div className="flex items-center gap-2">
									<button
										type="button"
										onClick={() => void handleCreateRole()}
										disabled={!newRoleName.trim() || creatingRole}
										className="rounded-md px-2 py-1 text-xs font-medium transition-opacity disabled:opacity-40"
										style={{ backgroundColor: theme.colors.accent, color: theme.colors.bgMain }}
									>
										{creatingRole ? 'Creating...' : 'Create'}
									</button>
									<button
										type="button"
										onClick={() => setShowNewRole(false)}
										disabled={creatingRole}
										className="rounded-md px-2 py-1 text-xs opacity-70 hover:opacity-100 disabled:opacity-40"
										style={{ color: theme.colors.textMain }}
									>
										Cancel
									</button>
								</div>
							</div>
						) : (
							<select
								aria-label="Role (profile)"
								value={selectedRole}
								onChange={(e) => {
									const role = roles.find(
										(entry) =>
											canonicalJson({ namespace: entry.namespace, profileId: entry.profile.id }) ===
											e.target.value
									);
									setDraft((p) =>
										p
											? {
													...p,
													role: role
														? { namespace: role.namespace, profileId: role.profile.id }
														: undefined,
													assigneeProfileId: role?.profile.id ?? '',
												}
											: p
									);
								}}
								className="w-full rounded-md px-2 py-1.5 text-sm outline-none"
								style={inputStyle}
							>
								<option value="">No role</option>
								{draft.assigneeProfileId && !draft.role && (
									<option value="legacy-unresolved">
										Unresolved legacy role: {draft.assigneeProfileId}
									</option>
								)}
								{draft.role &&
									!roles.some(
										(entry) =>
											entry.namespace === draft.role!.namespace &&
											entry.profile.id === draft.role!.profileId
									) && (
										<option value={selectedRole}>
											Missing role: {draft.role.namespace} / {draft.role.profileId}
										</option>
									)}
								{roles.map(({ namespace, profile }) => (
									<option
										key={canonicalJson({ namespace, profileId: profile.id })}
										value={canonicalJson({ namespace, profileId: profile.id })}
									>
										{profile.name} ({namespace})
									</option>
								))}
							</select>
						)}
						{!showNewRole && roles.length === 0 && (
							// First-run helper: both valid paths (inline role, or pin to an
							// existing agent) satisfy the assignee model, so spell them out.
							<span className="block text-xs" style={{ color: theme.colors.textDim }}>
								No roles yet. Scope and repository can be saved independently; missing references
								wait for repair.
							</span>
						)}
					</div>
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
							<option value="">Any worker within scope</option>
							{draft.assigneeAgentId &&
								!agents.some((agent) => agent.id === draft.assigneeAgentId) && (
									<option value={draft.assigneeAgentId}>
										Missing agent: {draft.assigneeAgentId}
									</option>
								)}
							{agents.map((a) => (
								<option key={a.id} value={a.id}>
									{agentLabel(a.id)}
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
							{CARD_STATUSES.filter((s) => isExisting || (s !== 'ready' && s !== 'running')).map(
								(s) => (
									<option key={s} value={s}>
										{STATUS_META[s].label}
									</option>
								)
							)}
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
							onChange={(e) =>
								setDraft((p) => (p ? { ...p, worktreeEnabled: e.target.checked } : p))
							}
							className="cursor-pointer"
						/>
						<span className="text-xs" style={{ color: theme.colors.textMain }}>
							Run in isolated worktree
						</span>
						<span className="text-xs-plus" style={{ color: theme.colors.textDim }}>
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
									onChange={(e) =>
										setDraft((p) => (p ? { ...p, worktreePath: e.target.value } : p))
									}
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
					{/* F3: open a PR when the card lands in Done. Only offered for isolated
				    cards - a PR needs a branch of its own to open from. The branch is
				    still never auto-merged; the PR is where a human reviews it. */}
					{draft.worktreeEnabled && (
						<div className="space-y-2">
							<label className="flex items-center gap-2 cursor-pointer">
								<input
									type="checkbox"
									checked={draft.prOnDoneEnabled}
									onChange={(e) =>
										setDraft((p) => (p ? { ...p, prOnDoneEnabled: e.target.checked } : p))
									}
									className="cursor-pointer"
								/>
								<span className="text-xs" style={{ color: theme.colors.textMain }}>
									Open PR when done
								</span>
								<span className="text-xs-plus" style={{ color: theme.colors.textDim }}>
									(the branch is still not merged - a pull request is opened for review)
								</span>
							</label>
							{draft.prOnDoneEnabled && (
								<label className="block space-y-1 w-64">
									<span className="text-xs" style={{ color: theme.colors.textDim }}>
										PR target branch (optional)
									</span>
									<input
										value={draft.prTargetBranch}
										onChange={(e) =>
											setDraft((p) => (p ? { ...p, prTargetBranch: e.target.value } : p))
										}
										placeholder="repo default branch"
										className="w-full rounded-md px-2 py-1.5 text-sm outline-none"
										style={inputStyle}
									/>
								</label>
							)}
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
										<input
											type="checkbox"
											checked={checked}
											disabled={!!draft.reviewContext && draft.parents[0] === c.id}
											onChange={() => onToggleParent(c.id)}
										/>
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
			</fieldset>
		</div>
	);
}
