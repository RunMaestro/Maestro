import { observeElementOffsetWhileMounted } from '../utils/virtualizer';
import { useResizableTextarea } from '../hooks/ui/useResizableTextarea';
import { isSessionRemote } from '../utils/sessionHelpers';
import { BOARD_SOURCE_PROJECT_PREFIX } from '../../shared/board/types';
import {
	memo,
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from 'react';
import { defaultRangeExtractor, measureElement, useVirtualizer } from '@tanstack/react-virtual';
import { createPortal } from 'react-dom';
import { X, KanbanSquare, Plus, Trash2, RefreshCw, ChevronLeft, Square, Play } from 'lucide-react';
import type { Theme } from '../types';
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
	CardPriority,
	CardStatus,
} from '../../shared/board/types';
import type { StoredBoardWorker } from '../../main/board/board-workspace-storage';
import { CARD_PRIORITIES, CARD_STATUSES } from '../../shared/board/types';
import { getBlockers, hasCycle } from '../../shared/board/graph';
import { buildCardWorktreeRef } from '../../shared/board/worktree';
import { useResizableModal } from '../hooks/ui/useResizableModal';
import { ResizeHandles } from './ui/ResizeHandles';
import { ModalTabStrip, tabPanelProps } from './ui/ModalTabStrip';
import { useModalLayer } from '../hooks/ui/useModalLayer';
import { useFocusAfterRender } from '../hooks/utils/useFocusAfterRender';
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
import type { BoardReadinessReason } from '../../shared/board/domain';
import { BOARD_DELETE_CARDS_LIMIT, type BoardDeleteCardsResult } from '../../shared/board/commands';
import { ipcErrorMessage } from '../utils/ipcErrorMessage';
import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';
import { triggerHaptic, HAPTIC_PATTERNS, isCoarsePointer } from '../utils/touch';
import { openUrl } from '../utils/openUrl';
import { observedWorkerRuns } from '../utils/boardWorkerStatus';
import { BoardWorkerOptions } from './BoardWorkerOptions';
import { ThemedSelect } from './shared/ThemedSelect';

export interface BoardModalProps {
	theme: Theme;
	onClose: () => void;
}

/** How long (ms) a tile's delete button stays armed before it disarms itself. */
const DELETE_DISARM_MS = 4000;

/** Id of the modal title, referenced by `aria-labelledby` on the dialog. */
const TITLE_ID = 'board-modal-title';

/** Column presentation: label + which theme color keys the status. The columns
 * are a *view* of `card.status`; the DAG + dispatcher are the engine. */
const STATUS_META: Record<CardStatus, { label: string; colorKey: keyof Theme['colors'] }> = {
	triage: { label: 'Triage', colorKey: 'textDim' },
	todo: { label: 'To Do', colorKey: 'textMain' },
	ready: { label: 'Ready', colorKey: 'success' },
	running: { label: 'In Progress', colorKey: 'warning' },
	review: { label: 'Review', colorKey: 'warning' },
	'ready-for-human': { label: 'Ready for Human', colorKey: 'success' },
	blocked: { label: 'Blocked', colorKey: 'error' },
	done: { label: 'Done', colorKey: 'success' },
};

// Host readiness codes are stable diagnostics; translate them for the card surface.
const READINESS_LABELS: Record<BoardReadinessReason, string> = {
	'review-artifact-unresolved': 'Review evidence is incomplete',
	'scope-conflict': 'Assignment conflicts with the selected scope',
	'missing-scope': 'Assign an agent or group',
	'target-missing': 'Assigned agent is unavailable',
	'group-missing': 'Assigned group is unavailable',
	'role-missing': 'Required role is unavailable',
	'repository-unresolved': 'Select a validated project',
	'repository-unknown': 'Project availability is unknown',
	'worker-outside-scope': 'Worker is outside the assigned scope',
	'worker-unregistered': 'Assigned worker is not registered',
	'worker-disabled': 'Assigned worker is disabled',
	'worker-paused': 'Assigned worker is paused',
	'worker-role-mismatch': 'Worker lacks the required role',
	'worker-repository-mismatch': 'Worker cannot access the project',
	'reviewer-missing': 'Assign an available reviewer',
	'review-pending': 'Review is pending',
	'correction-limit': 'Correction limit reached',
	emptyEligibleWorkers: 'No eligible workers',
	'approval-required': 'Approval is required',
	held: 'Held until resumed',
	'worker-busy': 'Assigned worker is busy',
	'worker-dormant': 'Assigned worker is dormant',
	'worker-location-mismatch': 'Worker is in a different location',
	'worker-location-invalid':
		'Worker SSH identities conflict or are missing; check agent SSH settings',
	'occupancy-unknown': 'Worker availability is unknown',
	'runtime-unknown': 'Runtime status is unknown',
	'runtime-unavailable': 'Runtime is unavailable',
	'awaiting-cue': 'Scheduler has not run yet',
};

// Internal intake and blocked states remain visible on their cards in To Do.
const WORKFLOW_COLUMNS: readonly CardStatus[] = [
	'todo',
	'running',
	'review',
	'ready-for-human',
	'done',
];

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
	reviewerAgentId?: string;
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
 * `.maestro/board.yaml` (Phase 2 IPC). Five columns render the card `status`;
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
	const [collections, setCollections] = useState<BoardWorkspaceCollection[]>([]);
	const [sourceRoots, setSourceRoots] = useState<Record<string, string>>({});
	const [sourceLabels, setSourceLabels] = useState<Record<string, string>>({});
	const [groupFilter, setGroupFilter] = useState('all');
	const [agentFilter, setAgentFilter] = useState('all');
	const groups = useSessionStore((s) => s.groups);

	const allSessions = useSessionStore((s) => s.sessions);
	// Only source membership changes require a new shared snapshot. Drafts,
	// usage and process updates replace the sessions array on the typing path.
	const projectRootsKey = useMemo(
		() =>
			canonicalJson(
				[
					...new Set(
						allSessions
							.filter((s) => !isSessionRemote(s))
							.map((s) => s.projectRoot)
							.filter(Boolean)
					),
				].sort()
			),
		[allSessions]
	);
	const catalogScopeKey = useMemo(
		() =>
			canonicalJson({
				agents: allSessions.map(({ id, groupId }) => ({ id, groupId })),
				groups: groups.map(({ id }) => id),
			}),
		[allSessions, groups]
	);
	// Card edits replace collections but do not change catalog membership.
	const catalogSourcesKey = canonicalJson(
		collections.map(({ sourceKey, collectionKey }) => [sourceKey, collectionKey]).sort()
	);
	const liveSessions = useLiveSessions();

	const [globalCollectionKey, setGlobalCollectionKey] = useState<string | null>(null);
	const globalCollectionKeyRef = useRef<string | null>(null);
	const [draft, setDraft] = useState<CardDraft | null>(null);
	const [pendingNewCard, setPendingNewCard] = useState(false);
	const globalCollection =
		collections.find((entry) => entry.collectionKey === globalCollectionKey) ?? null;
	const editorCollection = draft?.collection ?? globalCollection;
	const board = editorCollection?.board ?? null;
	const projectRoot =
		draft?.projectRoot ??
		(globalCollection ? `${BOARD_SOURCE_PROJECT_PREFIX}${globalCollection.sourceKey}` : '');
	const boards = useMemo(() => collections.map((entry) => entry.board), [collections]);

	// Worker names resolve across the shared view, independent of the creator’s project.
	const projectAgents = useMemo(
		() => allSessions.map((s) => ({ id: s.id, name: s.name, isWorker: s.boardWorker === true })),
		[allSessions]
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

	const [view, setView] = useState<'cards' | 'workers'>('cards');
	const [selectedWorkerId, setSelectedWorkerId] = useState<string | null>(null);
	const [workerSearch, setWorkerSearch] = useState('');
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
	const editorAgents = useMemo(
		() =>
			allSessions.map((session) => ({
				id: session.id,
				name: session.name,
				isWorker: workers.some((worker) => worker.agentId === session.id && worker.enabled),
			})),
		[allSessions, workers]
	);
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
			presetWorkingDir:
				activeSession && !isSessionRemote(activeSession) ? activeSession.projectRoot : undefined,
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
	}, [activeSession, registerCreatedWorker]);
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
			return true;
		} catch (err) {
			notifyToast({ color: 'red', title: 'Board workers', message: ipcErrorMessage(err) });
			return false;
		} finally {
			setWorkerBusy(false);
		}
	}, []);

	const [catalog, setCatalog] = useState<BoardCaptureCatalog | null>(null);
	const [newRoleName, setNewRoleName] = useState('');
	const [roleError, setRoleError] = useState<string | null>(null);
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
	const createRole = async () => {
		setWorkerBusy(true);
		setRoleError(null);
		try {
			const result = await window.maestro.board.roleCommand({
				action: 'create-role',
				name: newRoleName,
			});
			if (!result.ok) throw new Error(result.error.message);
			setNewRoleName('');
			await refreshWorkers();
			await refreshCaptureCatalog();
		} catch (error) {
			setRoleError(ipcErrorMessage(error));
		} finally {
			setWorkerBusy(false);
		}
	};
	const [saveError, setSaveError] = useState<
		Extract<BoardCaptureResponse, { ok: false }>['error'] | null
	>(null);
	const [captureResult, setCaptureResult] = useState<{
		collectionKey: string;
		cardId: string;
		response: Extract<BoardCaptureResponse, { ok: true }>;
	} | null>(null);
	const [loading, setLoading] = useState(true);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [dragCard, setDragCard] = useState<{
		cardId: string;
		collection: BoardWorkspaceCollection;
	} | null>(null);
	const [dragOverStatus, setDragOverStatus] = useState<CardStatus | null>(null);
	const [projectFilter, setProjectFilter] = useState('all');
	const [kindFilter, setKindFilter] = useState<BoardCardKind | 'all' | 'unspecified'>('all');
	const [statusFilter, setStatusFilter] = useState<CardStatus | 'all'>('all');
	const [bulkSelection, setBulkSelection] = useState<
		Record<string, { card: BoardCard; collection: BoardWorkspaceCollection }>
	>({});
	// Index the selected read snapshots once, rather than scanning the selection
	// for every unselected tile on every render. The updater below still checks
	// current state so batched clicks cannot bypass the limit or revision fence.
	const bulkSelectionByCollection = useMemo(() => {
		const sources = new Map<string, Map<string, { count: number; revisions: Set<number> }>>();
		for (const { collection } of Object.values(bulkSelection)) {
			let collections = sources.get(collection.sourceKey);
			if (!collections) {
				collections = new Map();
				sources.set(collection.sourceKey, collections);
			}
			let selected = collections.get(collection.collectionKey);
			if (!selected) {
				selected = { count: 0, revisions: new Set() };
				collections.set(collection.collectionKey, selected);
			}
			selected.count++;
			selected.revisions.add(collection.revision);
		}
		return sources;
	}, [bulkSelection]);
	const [bulkPreview, setBulkPreview] = useState(false);
	const [bulkPending, setBulkPending] = useState(false);
	const bulkPendingRef = useRef(false);
	const [bulkResults, setBulkResults] = useState<
		{ message: string; collection: BoardWorkspaceCollection; cards: BoardCard[] }[]
	>([]);

	// Editor state: null = board view, otherwise the card editor is showing.
	const [cycleError, setCycleError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	/** Set when the editor was opened with `m`, so it lands on the Move to picker. */
	const [focusMovePicker, setFocusMovePicker] = useState(false);
	/** The draft exactly as the editor opened it, for the unsaved-changes check. */
	const draftBaselineRef = useRef<CardDraft | null>(null);
	/** Which close the user asked for while the editor was dirty, pending confirm. */
	const [pendingAcceptance, setPendingAcceptance] = useState<CardDraft | null>(null);
	const [pendingRecovery, setPendingRecovery] = useState<Pick<
		BoardCardEntry,
		'card' | 'collection'
	> | null>(null);
	const [pendingDiscard, setPendingDiscard] = useState<null | 'editor' | 'modal'>(null);

	// The collection includes a board snapshot. Compare the editable fields first
	// so typing does not serialize that snapshot on every keystroke. Still compare
	// it when the other fields match, including after a successful Move response.
	const isDraftDirty = useMemo(() => {
		if (!draft) return false;
		const baseline = draftBaselineRef.current;
		if (!baseline) return true;
		const { collection, ...fields } = draft;
		const { collection: baselineCollection, ...baselineFields } = baseline;
		return (
			canonicalJson(fields) !== canonicalJson(baselineFields) ||
			canonicalJson(collection) !== canonicalJson(baselineCollection)
		);
	}, [draft]);

	const loadGenerationRef = useRef(0);
	const loadPromiseRef = useRef<Promise<void> | null>(null);
	const loadAgainRef = useRef(false);
	const loadSpinnerRef = useRef(false);

	const profileName = useCallback(
		(id: string) => {
			const matches = catalog?.profiles.filter((entry) => entry.profile.id === id) ?? [];
			return matches.length === 1 ? matches[0].profile.name : id;
		},
		[catalog]
	);

	// One global snapshot already carries source locations. Concurrent pushes
	// share this read and request one trailing read, so the latest revision wins
	// without launching a full workspace read for every project or event.
	const load = useCallback((showSpinner = true): Promise<void> => {
		loadAgainRef.current = true;
		loadSpinnerRef.current ||= showSpinner;
		loadGenerationRef.current++;
		if (loadPromiseRef.current) return loadPromiseRef.current;
		const promise = (async () => {
			while (loadAgainRef.current) {
				loadAgainRef.current = false;
				const showSpinner = loadSpinnerRef.current;
				loadSpinnerRef.current = false;
				const generation = loadGenerationRef.current;

				if (showSpinner) setLoading(true);
				try {
					if (!globalCollectionKeyRef.current) {
						const initialized = await window.maestro.board.initialize();
						if (!initialized.ok)
							throw new Error(`${initialized.error.code}: ${initialized.error.message}`);
						const key = initialized.value.storage?.collectionKey;
						if (!key) throw new Error('Global Board has no storage identity');
						globalCollectionKeyRef.current = key;
						setGlobalCollectionKey(key);
					}
					const response = await window.maestro.board.queryWorkspace();
					if (generation !== loadGenerationRef.current) continue;
					if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
					const roots: Record<string, string> = {};
					const labels: Record<string, string> = {};
					for (const source of response.value.sources) {
						if (source.location) {
							labels[source.sourceKey] = source.location.path;
							roots[source.sourceKey] =
								source.location.location.kind === 'local'
									? source.location.path
									: `${BOARD_SOURCE_PROJECT_PREFIX}${source.sourceKey}`;
						}
					}

					setSourceRoots(roots);
					setSourceLabels(labels);
					setCollections(response.value.collections);
					setLoadError(null);
					setCaptureResult(null);
				} catch (err) {
					if (generation !== loadGenerationRef.current) continue;
					setLoadError(ipcErrorMessage(err));
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
			}
		})();
		loadPromiseRef.current = promise;
		void promise.finally(() => {
			loadPromiseRef.current = null;
		});
		return promise;
	}, []);

	useEffect(() => {
		void load(true);
		return () => {
			loadGenerationRef.current++;
			loadAgainRef.current = false;
		};
	}, [load, projectRootsKey]);

	useEffect(() => {
		if (loading) return;
		void refreshCaptureCatalog().catch(() => {}); // The editor displays the failure and offers retry.
		return () => {
			catalogGeneration.current++;
		};
	}, [catalogSourcesKey, catalogScopeKey, loading, refreshCaptureCatalog]);

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

	// --- Card editor -------------------------------------------------------

	const openNewCard = useCallback(() => {
		setCycleError(null);
		setSaveError(null);
		setFocusMovePicker(false);
		if (!globalCollection) {
			setPendingNewCard(true);
			void load(true);
			return;
		}
		setPendingNewCard(false);
		const fresh: CardDraft = {
			collection: structuredClone(globalCollection),
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
	}, [globalCollection, projectRoot, load]);

	useEffect(() => {
		if (pendingNewCard && globalCollection && !loading && !loadError) openNewCard();
	}, [pendingNewCard, globalCollection, loading, loadError, openNewCard]);

	const openEditCard = useCallback(
		(card: BoardCard, focusMove = false, collection: BoardWorkspaceCollection) => {
			setCycleError(null);
			setSaveError(null);
			setFocusMovePicker(focusMove);
			if (!collection) return;
			const existing: CardDraft = {
				collection: structuredClone(collection),
				projectRoot:
					sourceRoots[collection.sourceKey] ??
					`${BOARD_SOURCE_PROJECT_PREFIX}${collection.sourceKey}`,
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
				reviewerAgentId: card.reviewerAgentId,
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
		[sourceRoots]
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
	 * Escape closes the modal, asking first when the editor holds unsaved edits.
	 */
	const handleEscape = useCallback(() => {
		if (isDraftDirty) {
			setPendingDiscard('modal');
			return;
		}
		onClose();
	}, [isDraftDirty, onClose]);

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
		(
			updated: Board,
			collection: BoardWorkspaceCollection,
			readiness?: Extract<BoardCaptureResponse, { ok: true }>['readiness']
		) => {
			const key = collection.collectionKey;
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
		[]
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
			assigneeAgentId: draft.assigneeAgentId || undefined,
			reviewerAgentId: draft.reviewerAgentId || undefined,
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
		// Only an explicit role edit replaces legacy references. Unrelated edits
		// retain unresolved IDs, namespace aliases and unknown role metadata verbatim.
		const baseline = draftBaselineRef.current;
		const replaceRole =
			canonicalJson({
				namespace: draft.role?.namespace,
				id: draft.role?.profileId ?? draft.assigneeProfileId,
			}) !==
			canonicalJson({
				namespace: baseline?.role?.namespace,
				id: baseline?.role?.profileId ?? baseline?.assigneeProfileId,
			});
		if (replaceRole) {
			delete (card as BoardCard & { profileNamespace?: string }).profileNamespace;
			delete card.assigneeProfileId;
			delete card.role;
			if (draft.role) {
				card.role = draft.role;
				card.assigneeProfileId = draft.role.profileId;
			}
		}
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
				...(replaceRole ? { replaceRole: true as const } : {}),
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
			applyBoard(response.value, draft.collection, response.readiness);
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

	const handleApproveStart = useCallback(
		async (operation: 'approve' | 'accept' = 'approve', selected = draft) => {
			if (!selected?.id || isDraftDirty || saving || !selected.projectRoot) return;
			const card = selected.collection.board.cards.find((entry) => entry.id === selected.id);
			if (
				!card ||
				card.storageRevision === undefined ||
				(operation === 'approve'
					? card.capturePolicy?.dispatchApproval !== 'required'
					: card.status !== 'ready-for-human')
			)
				return;
			setSaving(true);
			setSaveError(null);
			try {
				const result = await window.maestro.board.runtimeCommand({
					action: 'control',
					operation,
					target: {
						projectRoot: selected.projectRoot,
						sourceKey: selected.collection.sourceKey,
						collectionKey: selected.collection.collectionKey,
						expectedRevision: selected.collection.revision,
					},
					cardId: selected.id,
					cardRevision: card.storageRevision,
				});
				if (!result.ok) {
					setSaveError(result.error);
					return;
				}
				// Read the host state after its grant. Never manufacture a granted policy
				// or replace the read tokens on a rejected approval.
				const refreshed = await window.maestro.board.queryWorkspace({
					sourceKey: selected.collection.sourceKey,
				});
				if (!refreshed.ok) {
					setSaveError(refreshed.error);
					return;
				}
				const collection = refreshed.value.collections.find(
					(entry) => entry.collectionKey === selected.collection.collectionKey
				);
				const saved = collection?.board.cards.find((entry) => entry.id === selected.id);
				if (!collection || !saved) {
					setSaveError({
						code: 'not-found',
						message: 'Updated card is no longer available. Reload the board.',
					});
					return;
				}
				if (
					draftBaselineRef.current?.collection === selected.collection &&
					draftBaselineRef.current.id === selected.id
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
		},
		[draft, isDraftDirty, saving, load, openEditCard]
	);

	const handleDeleteCard = useCallback(
		async (cardId: string, collection: BoardWorkspaceCollection) => {
			const board = collection.board;
			const projectRoot =
				sourceRoots[collection.sourceKey] ??
				`${BOARD_SOURCE_PROJECT_PREFIX}${collection.sourceKey}`;
			try {
				const card = board.cards.find((item) => item.id === cardId);
				if (card?.storageRevision === undefined) throw new Error('Card revision unavailable');
				const updated = await window.maestro.board.deleteCard(projectRoot, board.id, cardId, {
					sourceKey: collection.sourceKey,
					collectionKey: collection.collectionKey,
					revision: collection.revision,
					cardRevision: card.storageRevision,
				});
				applyBoard(updated, collection);
				if (draft?.id === cardId && draft.collection.collectionKey === collection.collectionKey)
					closeEditor();
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
		[sourceRoots, draft, closeEditor, applyBoard]
	);

	const deleteSelectedCards = useCallback(async () => {
		if (bulkPendingRef.current) return;
		bulkPendingRef.current = true;
		setBulkPending(true);
		const groups = new Map<
			string,
			{ collection: BoardWorkspaceCollection; entries: [string, BoardCard][] }
		>();
		for (const [key, { card, collection }] of Object.entries(bulkSelection)) {
			const groupKey = JSON.stringify([collection.sourceKey, collection.collectionKey]);
			const group = groups.get(groupKey) ?? { collection, entries: [] };
			group.entries.push([key, card]);
			groups.set(groupKey, group);
		}
		const results: { message: string; collection: BoardWorkspaceCollection; cards: BoardCard[] }[] =
			[];
		try {
			for (const { collection, entries } of groups.values()) {
				try {
					const response = await window.maestro.board.deleteCards({
						action: 'delete-cards',
						target: {
							projectRoot: `${BOARD_SOURCE_PROJECT_PREFIX}${collection.sourceKey}`,
							sourceKey: collection.sourceKey,
							collectionKey: collection.collectionKey,
							expectedRevision: collection.revision,
						},
						cards: entries.map(([, card]) => ({
							cardId: card.id,
							cardRevision: card.storageRevision!,
						})),
					});
					if (!response.ok) {
						results.push({
							collection,
							cards: entries.map(([, card]) => card),
							message: `${collection.board.name}: no cards deleted. ${response.error.code === 'stale-revision' ? 'The board changed; refresh and select the cards again.' : 'Check the cards and try again.'}`,
						});
						continue;
					}
					const receipt = response.value as BoardDeleteCardsResult;
					setCollections((prev) =>
						prev.map((entry) =>
							entry.sourceKey === collection.sourceKey &&
							entry.collectionKey === collection.collectionKey &&
							entry.revision === collection.revision
								? {
										...entry,
										board: receipt.board,
										revision: receipt.revision,
										readiness: undefined,
									}
								: entry
						)
					);
					setBulkSelection((prev) => {
						const next = { ...prev };
						for (const [key] of entries) delete next[key];
						return next;
					});
					results.push({
						collection,
						cards: entries.map(([, card]) => card),
						message: `${collection.board.name}: deleted ${entries.length} ${entries.length === 1 ? 'card' : 'cards'}: ${entries.map(([, card]) => card.title).join(', ')}.`,
					});
				} catch (error) {
					captureException(error, {
						extra: {
							operation: 'board:deleteCards',
							source: collection.sourceKey,
							collection: collection.collectionKey,
						},
					});
					results.push({
						collection,
						cards: entries.map(([, card]) => card),
						message: `${collection.board.name}: no cards deleted. Check the connection and try again.`,
					});
				}
			}
		} finally {
			setBulkResults(results);
			setBulkPending(false);
			bulkPendingRef.current = false;
		}
	}, [bulkSelection]);

	const handleCancelCard = useCallback(
		async (cardId: string, collection: BoardWorkspaceCollection) => {
			const board = collection.board;
			const projectRoot =
				sourceRoots[collection.sourceKey] ??
				`${BOARD_SOURCE_PROJECT_PREFIX}${collection.sourceKey}`;
			try {
				const card = board.cards.find((item) => item.id === cardId);
				if (card?.storageRevision === undefined) throw new Error('Card revision unavailable');
				const updated = await window.maestro.board.cancelCard(projectRoot, board.id, cardId, {
					sourceKey: collection.sourceKey,
					collectionKey: collection.collectionKey,
					revision: collection.revision,
					cardRevision: card.storageRevision,
				});
				applyBoard(updated, collection);
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
		[sourceRoots, applyBoard]
	);

	/** Release only through the owning runtime, after termination is confirmed. */
	const handleResumeCard = useCallback(
		async (cardId: string, collection: BoardWorkspaceCollection) => {
			const board = collection.board;
			const projectRoot =
				sourceRoots[collection.sourceKey] ??
				`${BOARD_SOURCE_PROJECT_PREFIX}${collection.sourceKey}`;
			const card = board.cards.find((c) => c.id === cardId);
			if (!card?.heldByUser) return;
			try {
				if (card.storageRevision === undefined) throw new Error('Card revision unavailable');
				const updated = await window.maestro.board.resumeCard(projectRoot, board.id, cardId, {
					sourceKey: collection.sourceKey,
					collectionKey: collection.collectionKey,
					revision: collection.revision,
					cardRevision: card.storageRevision,
				});
				applyBoard(updated, collection);
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
		[sourceRoots, applyBoard]
	);

	const requestRecovery = useCallback((cardId: string, collection: BoardWorkspaceCollection) => {
		const card = collection.board.cards.find((entry) => entry.id === cardId);
		if (card?.heldByUser && card.status === 'running') setPendingRecovery({ card, collection });
	}, []);
	const recoverCard = async (selected: Pick<BoardCardEntry, 'card' | 'collection'>) => {
		if (saving || selected.card.storageRevision === undefined) return;
		setSaving(true);
		try {
			const { card, collection } = selected;
			const result = await window.maestro.board.runtimeCommand({
				action: 'control',
				operation: 'recover',
				target: {
					projectRoot:
						sourceRoots[collection.sourceKey] ??
						`${BOARD_SOURCE_PROJECT_PREFIX}${collection.sourceKey}`,
					sourceKey: collection.sourceKey,
					collectionKey: collection.collectionKey,
					expectedRevision: collection.revision,
				},
				cardId: card.id,
				cardRevision: card.storageRevision!,
			});
			if (!result.ok) throw new Error(result.error.message);
			await load(false);
			notifyToast({
				color: 'green',
				title: 'Board',
				message:
					'Result retained. The attempt is released and the card remains held for reassignment.',
			});
		} catch (error) {
			notifyToast({ color: 'red', title: 'Board recovery', message: ipcErrorMessage(error) });
		} finally {
			setSaving(false);
		}
	};

	// --- Moving cards (drag for pointers, "Move to" picker for keyboards) ----

	/**
	 * Persist a manual status override, with the same guards the drop target
	 * used to carry. Returns true when the card actually moved.
	 */
	const moveCard = useCallback(
		async (
			cardId: string,
			status: CardStatus,
			collection: BoardWorkspaceCollection
		): Promise<Board | false> => {
			const board = collection.board;
			const projectRoot =
				sourceRoots[collection.sourceKey] ??
				`${BOARD_SOURCE_PROJECT_PREFIX}${collection.sourceKey}`;
			const card = board.cards.find((c) => c.id === cardId);
			// No-op when it is already there.
			if (!card || card.status === status) return false;
			if (card.storageRevision === undefined) {
				notifyToast({
					color: 'red',
					title: 'Board',
					message: 'Card revision unavailable. Reload the board.',
				});
				return false;
			}
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
			if (['ready', 'running', 'review', 'ready-for-human', 'done'].includes(status)) {
				notifyToast({
					color: 'orange',
					title: 'Board',
					message:
						status === 'done'
							? 'Use Approve final result on a card in Ready for Human. Status moves cannot approve work.'
							: `"${STATUS_META[status].label}" is controlled by the host workflow.`,
				});
				return false;
			}
			if (isCoarsePointer()) triggerHaptic(HAPTIC_PATTERNS.tap);
			// Optimistic move so the card jumps immediately; the reload below
			// corrects it if the write fails.
			applyBoard(
				{
					...board,
					cards: board.cards.map((c) => (c.id === cardId ? { ...c, status } : c)),
				},
				collection
			);
			try {
				const updated = await window.maestro.board.setCardStatus(
					projectRoot,
					board.id,
					cardId,
					status,
					{
						sourceKey: collection.sourceKey,
						collectionKey: collection.collectionKey,
						revision: collection.revision,
						cardRevision: card.storageRevision,
					}
				);
				applyBoard(updated, collection);
				return updated;
			} catch (err) {
				logger.error(`Failed to move card: ${String(err)}`);
				captureException(err, { tags: { operation: 'board:setCardStatus' } });
				notifyToast({ color: 'red', title: 'Board', message: 'Failed to move card.' });
				void load(false);
				return false;
			}
		},
		[sourceRoots, load, applyBoard]
	);

	const handleDrop = useCallback(
		async (status: CardStatus) => {
			const dragged = dragCard;
			setDragCard(null);
			setDragOverStatus(null);
			if (!dragged) return;
			await moveCard(dragged.cardId, status, dragged.collection);
		},
		[dragCard, moveCard]
	);

	/** Editor "Move to" picker: persists immediately, like a drop would. */
	const handleMoveDraft = useCallback(
		async (status: CardStatus) => {
			if (!draft?.id) return;
			const moved = await moveCard(draft.id, status, draft.collection);
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
		[draft, moveCard]
	);

	const inputStyle = useMemo(
		() => ({
			backgroundColor: theme.colors.bgActivity,
			border: `1px solid ${theme.colors.border}`,
			color: theme.colors.textMain,
		}),
		[theme.colors.bgActivity, theme.colors.border, theme.colors.textMain]
	);

	const projectFilterOptions = useMemo(() => {
		const repositories = new Map((catalog?.repositories ?? []).map((repo) => [repo.id, repo]));
		const ids = new Set(repositories.keys());
		for (const collection of collections)
			for (const card of collection.board.cards) if (card.repositoryId) ids.add(card.repositoryId);
		if (projectFilter.startsWith('repository:')) ids.add(projectFilter.slice('repository:'.length));
		return [
			{ value: 'all', label: 'All projects' },
			{ value: 'unassigned', label: 'No project assignment' },
			...Array.from(ids, (id) => {
				const repo = repositories.get(id);
				return {
					value: `repository:${id}`,
					label: repo
						? `${repo.id}: ${repo.workingDirectory}${repo.location?.kind === 'ssh' ? ` [SSH: ${repo.location.remoteId || 'unresolved'}]` : ''}${repo.validated ? '' : ` (unresolved: ${repo.diagnostic ?? 'revalidate source'})`}`
						: `Missing repository: ${id}`,
				};
			}),
		];
	}, [catalog, collections, projectFilter]);

	const cardsByStatus = useMemo(() => {
		const map = new Map<CardStatus, BoardCardEntry[]>();
		for (const status of WORKFLOW_COLUMNS) map.set(status, []);
		for (const collection of collections)
			for (const card of collection.board.cards) {
				if (
					projectFilter !== 'all' &&
					projectFilter !== (card.repositoryId ? `repository:${card.repositoryId}` : 'unassigned')
				)
					continue;
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
				const column = ['triage', 'ready', 'blocked'].includes(card.status) ? 'todo' : card.status;
				map.get(column)?.push({
					card,
					collection,
					key: JSON.stringify([collection.sourceKey, collection.collectionKey, card.id]),
				});
			}
		return map;
	}, [collections, projectFilter, kindFilter, statusFilter, groupFilter, agentFilter]);

	// --- Keyboard grid navigation -------------------------------------------

	const columnNavigators = useRef(new Map<CardStatus, (index: number) => void>());
	const registerColumn = useCallback(
		(status: CardStatus, focus: ((index: number) => void) | null) => {
			if (focus) columnNavigators.current.set(status, focus);
			else columnNavigators.current.delete(status);
		},
		[]
	);
	const handleDragStart = useCallback((cardId: string, collection: BoardWorkspaceCollection) => {
		setDragCard({ cardId, collection });
	}, []);
	const handleDragEnd = useCallback(() => {
		setDragCard(null);
		setDragOverStatus(null);
	}, []);
	const filterKey = canonicalJson([
		projectFilter,
		groupFilter,
		agentFilter,
		kindFilter,
		statusFilter,
	]);

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
				if (target) columnNavigators.current.get(fromStatus)?.(nextIndex);
				return;
			}
			const step = key === 'ArrowRight' ? 1 : -1;
			const from = WORKFLOW_COLUMNS.indexOf(fromStatus);
			for (let i = from + step; i >= 0 && i < WORKFLOW_COLUMNS.length; i += step) {
				const cards = cardsByStatus.get(WORKFLOW_COLUMNS[i]) ?? [];
				if (cards.length === 0) continue;
				columnNavigators.current.get(WORKFLOW_COLUMNS[i])?.(Math.min(fromIndex, cards.length - 1));
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
					color: theme.colors.textMain,
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
					className="shrink-0 flex flex-wrap items-center justify-between px-5 py-4 border-b gap-3"
					style={{ borderColor: theme.colors.border }}
				>
					<div className="flex items-center gap-2 min-w-0">
						<KanbanSquare className="w-5 h-5 shrink-0" style={{ color: theme.colors.accent }} />
						<h2
							id={TITLE_ID}
							className="text-base font-bold truncate"
							style={{ color: theme.colors.textMain }}
						>
							Board
						</h2>
						<span className="text-xs shrink-0" style={{ color: theme.colors.textDim }}>
							card DAG · dispatched on the Cue tick
						</span>
						{board && !draft && (
							<ThemedSelect
								aria-label="Board start policy"
								theme={theme}
								value={board.defaultStartMode ?? 'approval'}
								disabled={!projectRoot}
								options={[
									{ value: 'approval', label: 'New cards: require approval' },
									{ value: 'direct', label: 'New cards: schedule directly' },
								]}
								onChange={async (value) => {
									try {
										const response = await window.maestro.board.setStartPolicy(
											projectRoot,
											board.id,
											board.storage!.expectedRevision!,
											value as 'approval' | 'direct'
										);
										if (!response.ok) throw new Error(response.error.message);
										await load();
									} catch (error) {
										captureException(error, { tags: { operation: 'board:setStartPolicy' } });
										notifyToast({ color: 'red', title: 'Board', message: String(error) });
									}
								}}
							/>
						)}
					</div>
					<div className="flex items-center gap-1 shrink-0">
						{view === 'cards' && !draft && (!loading || board) && (
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

				<ModalTabStrip
					theme={theme}
					tabs={[
						{ id: 'cards', label: 'Cards' },
						{ id: 'workers', label: 'Workers' },
					]}
					activeTab={view}
					onChange={(next) => {
						setView(next);
						if (next === 'workers') void refreshWorkers();
					}}
					label="Board views"
					idPrefix="board-view"
					className="px-4 pt-2"
				/>
				<div
					{...tabPanelProps('board-view', 'workers')}
					hidden={view !== 'workers'}
					className="board-worker-controls flex-1 min-h-0 overflow-auto p-4 text-sm"
					style={{ color: theme.colors.textMain, display: view === 'workers' ? undefined : 'none' }}
				>
					<style>{`
						.board-worker-controls button:not([role="combobox"]) { color: ${theme.colors.textMain}; }
						.board-worker-controls button:focus-visible, .board-worker-controls input:focus-visible, .board-worker-controls summary:focus-visible { outline: 2px solid ${theme.colors.accent}; outline-offset: 2px; }
						.board-worker-controls button:disabled, .board-worker-controls input:disabled { opacity: .5; cursor: not-allowed; }
						.board-worker-controls input[type="checkbox"] { accent-color: ${theme.colors.accent}; }
						.board-worker-controls .worker-action { border: 1px solid ${theme.colors.border}; background: ${theme.colors.bgActivity}; border-radius: 0.375rem; padding: 0.375rem 0.75rem; }
						.board-worker-controls .worker-action:not(:disabled):hover { filter: brightness(1.1); }
					`}</style>
					<p style={{ color: theme.colors.warning }}>
						Intake pause prevents new Board starts. Work already running continues.
					</p>
					<details className="my-2">
						<summary className="cursor-pointer">Manage roles</summary>
						<form
							className="flex flex-wrap items-center gap-2 py-2"
							onSubmit={(event) => {
								event.preventDefault();
								if (newRoleName.trim() && !workerBusy) void createRole();
							}}
						>
							<label htmlFor="board-new-role-name">New role</label>
							<input
								id="board-new-role-name"
								value={newRoleName}
								disabled={workerBusy}
								onChange={(event) => setNewRoleName(event.target.value)}
								placeholder="e.g. Reviewer"
								className="rounded px-2 py-1"
								style={{
									backgroundColor: theme.colors.bgMain,
									color: theme.colors.textMain,
									border: `1px solid ${theme.colors.border}`,
								}}
							/>
							<button
								type="submit"
								className="worker-action"
								disabled={workerBusy || !newRoleName.trim()}
							>
								Create role
							</button>
						</form>
						<p className="text-xs" style={{ color: theme.colors.textDim }}>
							Create a role here, assign it to workers below, then choose it on a card. Execution
							options stay with each worker.
						</p>
						{roleError && (
							<p role="alert" style={{ color: theme.colors.error }}>
								{roleError}
							</p>
						)}
					</details>
					<button
						className="inline-flex items-center gap-2 rounded-md border px-3 py-2 my-2 hover:brightness-110 focus-visible:outline focus-visible:outline-2 disabled:opacity-70"
						style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgActivity }}
						disabled={workerBusy || creatorOpen || pendingWorkerId !== null}
						onClick={createWorker}
					>
						<Plus className="h-4 w-4" aria-hidden="true" />
						Create agent and add worker
					</button>
					{workerBusy && (
						<span role="status" className="ml-2">
							Updating workers…
						</span>
					)}
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
								className="worker-action"
								disabled={workerBusy}
								onClick={() => void registerCreatedWorker(pendingWorkerId)}
							>
								Retry worker registration
							</button>
						</div>
					)}
					{selectedWorkerId && (
						<button className="my-2 underline" onClick={() => setSelectedWorkerId(null)}>
							← Back to workers
						</button>
					)}
					{!selectedWorkerId && (
						<label className="block">
							Search workers and agents
							<input
								aria-label="Search workers and agents"
								value={workerSearch}
								onChange={(event) => setWorkerSearch(event.target.value)}
								className="block w-full rounded border px-2 py-1"
								style={{
									borderColor: theme.colors.border,
									backgroundColor: theme.colors.bgMain,
									color: theme.colors.textMain,
								}}
							/>
						</label>
					)}
					{!selectedWorkerId && <h3 className="font-semibold mt-3">Registered workers</h3>}
					{workers
						.filter((worker) => !selectedWorkerId && !sessionById.has(worker.agentId))
						.map((worker) => (
							<div key={worker.agentId} className="py-2">
								{worker.agentId} — agent missing; {worker.enabled ? 'enabled' : 'disabled'}
								{worker.paused ? ', intake paused' : ''}; occupancy unknown
							</div>
						))}
					{[true, false].map((registered) => (
						<section key={String(registered)}>
							{!registered && !selectedWorkerId && (
								<h3 className="font-semibold mt-4">Available agents</h3>
							)}
							{(registered ? allSessions : liveSessions)
								.filter(
									(session) =>
										workersByAgent.has(session.id) === registered &&
										(selectedWorkerId
											? session.id === selectedWorkerId
											: `${session.name} ${session.toolType}`
													.toLowerCase()
													.includes(workerSearch.toLowerCase().trim()))
								)
								.map((session) => {
									const worker = workersByAgent.get(session.id);
									const observedRun = observedRuns.get(session.id);
									const roles = worker?.payload.roleRefs;
									const repos = worker?.payload.allowedRepositoryIds;
									const validAccess =
										Array.isArray(roles) &&
										roles.every(
											(role) =>
												role &&
												typeof role.namespace === 'string' &&
												typeof role.profileId === 'string'
										) &&
										Array.isArray(repos) &&
										repos.every((id) => typeof id === 'string');
									if (!selectedWorkerId)
										return (
											<button
												key={session.id}
												type="button"
												onClick={() => setSelectedWorkerId(session.id)}
												className="block w-full text-left rounded-lg border p-3 my-2 focus-visible:outline focus-visible:outline-2"
												style={{
													borderColor: theme.colors.border,
													backgroundColor: theme.colors.bgActivity,
												}}
											>
												<span className="font-semibold">{session.name}</span>
												<span className="block text-xs" style={{ color: theme.colors.textDim }}>
													{worker
														? `${worker.enabled ? 'Enabled' : 'Disabled'}${worker.paused ? ' · intake paused' : ''}`
														: 'Available agent'}{' '}
													· {session.toolType}
												</span>
											</button>
										);
									return (
										<div key={session.id} className="flex flex-col gap-2 py-2">
											<div className="flex flex-wrap items-center justify-between gap-2">
												<span>
													{session.name}
													{worker
														? ` — ${worker.enabled ? 'enabled' : 'disabled'}${worker.paused ? ', intake paused' : ''}`
														: ''}
												</span>
												{worker ? (
													<div className="flex flex-wrap gap-2">
														<button
															className="worker-action"
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
															className="worker-action"
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
														className="worker-action"
														disabled={workerBusy}
														onClick={() =>
															void changeWorker(() =>
																window.maestro.board.registerWorker(session.id)
															)
														}
													>
														Add worker
													</button>
												)}
											</div>
											{worker && (
												<div>
													Provider: {session.toolType}
													<br />
													Agent state: {session.state}; global occupancy unknown
													{observedRun &&
														`; observed running card in loaded boards: ${observedRun}`}
												</div>
											)}
											{worker && (
												<BoardWorkerOptions
													key={canonicalJson(worker.payload)}
													worker={worker}
													session={session}
													theme={theme}
													roles={workerAccessOptions.roles}
													workers={workers}
													disabled={workerBusy}
													onSave={(patch) =>
														changeWorker(() =>
															window.maestro.board.setWorkerOptions({
																agentId: session.id,
																expectedPayload: canonicalJson(worker.payload),
																patch,
															})
														)
													}
												/>
											)}
											{worker && validAccess && (
												<details>
													<summary>Roles and repositories</summary>
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
																			void changeWorker(async () => {
																				const result = await window.maestro.board.roleCommand({
																					action: 'set-worker-role',
																					agentId: session.id,
																					role: {
																						namespace: role.namespace,
																						profileId: role.profileId,
																					},
																					enabled: !selected,
																				});
																				if (!result.ok) throw new Error(result.error.message);
																				return window.maestro.board.listWorkers();
																			})
																		}
																	/>{' '}
																	{role.name} ({role.namespace} / {role.profileId})
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
												</details>
											)}
											{worker && !validAccess && (
												<span role="alert" style={{ color: theme.colors.error }}>
													Access data needs repair; existing values are preserved.
												</span>
											)}
										</div>
									);
								})}
						</section>
					))}
				</div>
				{/* Keep the card panel mounted to preserve scroll and unsaved editor state. */}
				<div
					{...tabPanelProps('board-view', 'cards')}
					hidden={view !== 'cards'}
					className="flex-1 overflow-hidden flex flex-col"
					style={{ display: view === 'cards' ? undefined : 'none' }}
				>
					{loading && !draft && (
						<div role="status" className="px-5 py-2">
							Loading board…
						</div>
					)}
					{loadError && !draft && (
						<div
							role="alert"
							className="px-5 py-2 select-text"
							style={{ color: theme.colors.error }}
						>
							Board could not be loaded: {loadError}.{' '}
							<button onClick={() => void load(true)} className="underline">
								Retry
							</button>
						</div>
					)}
					{!loading &&
						!loadError &&
						!draft &&
						collections.every((entry) => entry.board.cards.length === 0) && (
							<div role="status" className="px-5 py-2" style={{ color: theme.colors.textDim }}>
								No cards yet. Create a card to get started.
							</div>
						)}
					{captureResult && (
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
							onRevalidateSource={async () => {
								const result = await window.maestro.board.sourceCommand({
									action: 'revalidate',
									sourceKey: draft.collection.sourceKey,
								});
								await refreshCaptureCatalog();
								if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
							}}
							theme={theme}
							draft={draft}
							setDraft={setDraft}
							catalog={catalog}
							catalogError={catalogError}
							saveError={saveError}
							onRefreshCatalog={() => void refreshCaptureCatalog().catch(() => {})}
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
							onAccept={() => setPendingAcceptance(draft)}
							onSave={() => void handleSaveCard()}
							onCancel={requestCloseEditor}
							onMove={(status) => void handleMoveDraft(status)}
							autoFocusMove={focusMovePicker}
							profileName={profileName}
							projectAgents={editorAgents}
						/>
					)}

					{/* Kanban columns */}
					{board && !draft && (
						<div className="flex flex-wrap gap-3 px-4 pt-3">
							<div className="flex items-center gap-1">
								<span>Project</span>
								<ThemedSelect
									aria-label="Filter by project"
									theme={theme}
									value={projectFilter}
									onChange={setProjectFilter}
									filterable
									options={projectFilterOptions}
								/>
							</div>
							<div className="flex items-center gap-1">
								<span>Group</span>
								<ThemedSelect
									aria-label="Filter by group"
									theme={theme}
									value={groupFilter}
									onChange={setGroupFilter}
									filterable
									options={[
										{ value: 'all', label: 'All groups' },
										...(groupFilter !== 'all' && !groups.some((group) => group.id === groupFilter)
											? [{ value: groupFilter, label: `Missing group: ${groupFilter}` }]
											: []),
										...groups.map((group) => ({ value: group.id, label: group.name })),
									]}
								/>
							</div>
							<div className="flex items-center gap-1">
								<span>Agent</span>
								<ThemedSelect
									aria-label="Filter by agent"
									theme={theme}
									value={agentFilter}
									onChange={setAgentFilter}
									filterable
									options={[
										{ value: 'all', label: 'All agents' },
										...(agentFilter !== 'all' &&
										!allSessions.some((session) => session.id === agentFilter)
											? [{ value: agentFilter, label: `Missing agent: ${agentFilter}` }]
											: []),
										...allSessions.map((session) => ({ value: session.id, label: session.name })),
									]}
								/>
							</div>
							<div className="flex items-center gap-1">
								<span>Type</span>
								<ThemedSelect
									aria-label="Filter by type"
									theme={theme}
									value={kindFilter}
									onChange={(value) => setKindFilter(value as typeof kindFilter)}
									options={[
										{ value: 'all', label: 'All types' },
										{ value: 'unspecified', label: 'Unspecified' },
										{ value: 'work', label: 'Work' },
										{ value: 'review', label: 'Review' },
										{ value: 'test', label: 'Test' },
										{ value: 'documentation', label: 'Documentation' },
									]}
								/>
							</div>
							<div className="flex items-center gap-1">
								<span>Status</span>
								<ThemedSelect
									aria-label="Filter by status"
									theme={theme}
									value={statusFilter}
									onChange={(value) => setStatusFilter(value as typeof statusFilter)}
									options={[
										{ value: 'all', label: 'All statuses' },
										...CARD_STATUSES.map((status) => ({
											value: status,
											label: STATUS_META[status].label,
										})),
									]}
								/>
							</div>
							<button
								type="button"
								className="rounded border px-2 py-1"
								style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
								disabled={!Object.keys(bulkSelection).length || bulkPending}
								onClick={() => {
									setBulkPreview(true);
									setBulkResults([]);
								}}
							>
								Review {Object.keys(bulkSelection).length} selected
							</button>
						</div>
					)}
					{board && !draft && bulkPreview && (
						<section
							className="mx-4 mt-3 rounded border p-3 text-sm"
							style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgActivity }}
							aria-label="Delete selected cards preview"
						>
							<p>
								Selection includes cards hidden by filters. Each collection commits separately; a
								conflict leaves that collection unchanged. Reservations are checked by the host when
								deletion is submitted. Select at most {BOARD_DELETE_CARDS_LIMIT} cards per
								collection.
							</p>
							<ul>
								{Object.entries(bulkSelection).map(([key, { card, collection }]) => (
									<li key={key}>
										{card.title} ({collection.board.name}
										{card.workingDirectory ? ` · ${truncatePath(card.workingDirectory, 40)}` : ''});
										Source: {sourceLabels[collection.sourceKey] ?? 'Unknown source'}.{' '}
										<details>
											<summary>Card identity details</summary>
											Source: {collection.sourceKey}; collection: {collection.collectionKey}; card:{' '}
											{card.id}; revision: {card.storageRevision}
										</details>
										{
											collection.board.cards.filter((other) => other.parents.includes(card.id))
												.length
										}{' '}
										direct dependents inherit its parents.{' '}
										<button
											type="button"
											style={{ color: theme.colors.textMain }}
											disabled={bulkPending}
											onClick={() =>
												setBulkSelection((prev) => {
													const next = { ...prev };
													delete next[key];
													return next;
												})
											}
										>
											Remove from selection
										</button>
									</li>
								))}
							</ul>
							<button
								type="button"
								className="rounded border px-2 py-1 mr-2"
								style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
								disabled={bulkPending || !Object.keys(bulkSelection).length}
								onClick={() => void deleteSelectedCards()}
							>
								Delete selected
							</button>
							<button
								type="button"
								className="rounded border px-2 py-1"
								style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
								disabled={bulkPending}
								onClick={() => setBulkPreview(false)}
							>
								Close preview
							</button>
							{bulkResults.map((result) => (
								<div
									key={JSON.stringify([
										result.collection.sourceKey,
										result.collection.collectionKey,
									])}
									role="status"
								>
									<p>
										{result.message} Source:{' '}
										{sourceLabels[result.collection.sourceKey] ?? 'Unknown source'}.
									</p>
									<ul>
										{result.cards.map((card) => (
											<li key={card.id}>
												{card.title}
												<details>
													<summary>Card identity details</summary>Source:{' '}
													{result.collection.sourceKey}; collection:{' '}
													{result.collection.collectionKey}; card: {card.id}; revision:{' '}
													{card.storageRevision}
												</details>
											</li>
										))}
									</ul>
								</div>
							))}
						</section>
					)}
					{board && (
						<div
							hidden={!!draft}
							className="flex-1 min-h-0 overflow-x-auto overflow-y-hidden p-4"
							style={{ display: draft ? 'none' : undefined }}
						>
							<div className="flex gap-3 h-full" style={{ minWidth: 'min-content' }}>
								{WORKFLOW_COLUMNS.map((status) => {
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
											<BoardCardList
												status={status}
												cards={cards}
												filterKey={filterKey}
												visible={view === 'cards' && !draft}
												dragCard={dragCard}
												registerColumn={registerColumn}
												renderCard={({ card, collection, key }, index) => {
													const selection = bulkSelectionByCollection
														.get(collection.sourceKey)
														?.get(collection.collectionKey);
													return (
														<div key={key}>
															<label className="text-xs" style={{ color: theme.colors.textDim }}>
																<input
																	type="checkbox"
																	style={{ accentColor: theme.colors.accent }}
																	checked={!!bulkSelection[key]}
																	disabled={
																		bulkPending ||
																		(!bulkSelection[key] &&
																			(card.status === 'running' ||
																				card.storageRevision === undefined ||
																				(selection !== undefined &&
																					(selection.count >= BOARD_DELETE_CARDS_LIMIT ||
																						selection.revisions.size !== 1 ||
																						!selection.revisions.has(collection.revision)))))
																	}
																	onChange={(event) => {
																		const checked = event.target.checked;
																		setBulkSelection((prev) => {
																			const next = { ...prev };
																			if (checked) {
																				const sameCollection = Object.values(prev).filter(
																					(selected) =>
																						selected.collection.sourceKey ===
																							collection.sourceKey &&
																						selected.collection.collectionKey ===
																							collection.collectionKey
																				);
																				if (
																					!prev[key] &&
																					(sameCollection.length >= BOARD_DELETE_CARDS_LIMIT ||
																						sameCollection.some(
																							(selected) =>
																								selected.collection.revision !== collection.revision
																						))
																				)
																					return prev;
																				next[key] = { card, collection };
																			} else delete next[key];
																			return next;
																		});
																	}}
																/>{' '}
																{card.status === 'running'
																	? 'Running: excluded'
																	: card.storageRevision === undefined
																		? 'Revision unavailable'
																		: 'Select for deletion'}
															</label>
															<BoardCardTile
																key={key}
																theme={theme}
																card={card}
																readiness={collection.readiness?.[card.id]}
																board={collection.board}
																profileName={profileName}
																agentName={agentName}
																projectAgents={projectAgents}
																onJumpToAgent={handleJumpToAgent}
																dragging={
																	dragCard?.cardId === card.id &&
																	dragCard.collection.sourceKey === collection.sourceKey &&
																	dragCard.collection.collectionKey === collection.collectionKey
																}
																collection={collection}
																column={status}
																index={index}
																onDragStart={handleDragStart}
																onDragEnd={handleDragEnd}
																onClick={openEditCard}
																onNavigate={navigateTiles}
																onDelete={handleDeleteCard}
																onCancelRun={handleCancelCard}
																onResume={handleResumeCard}
																onRecover={requestRecovery}
															/>
														</div>
													);
												}}
											/>
											{cards.length === 0 && (
												<div
													className="text-xs-plus text-center py-4"
													style={{ color: theme.colors.textDim }}
												>
													Drop here
												</div>
											)}
										</div>
									);
								})}
							</div>
						</div>
					)}
				</div>

				{/* Keyboard hint footer: the mouse affordances (drag, hover trash) are
				    invisible to keyboard users otherwise. */}
				{view === 'cards' && board && !draft && (
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
			{pendingAcceptance && (
				<ConfirmModal
					theme={theme}
					title="Approve final result?"
					message={`Mark "${pendingAcceptance.title}" and its bound review Done? This records your final decision for the reviewed work and does not merge or deploy it.`}
					confirmLabel="Approve final result"
					onConfirm={() => {
						const selected = pendingAcceptance;
						setPendingAcceptance(null);
						void handleApproveStart('accept', selected);
					}}
					onClose={() => setPendingAcceptance(null)}
				/>
			)}

			{pendingRecovery && (
				<ConfirmModal
					theme={theme}
					title="Retain result and release attempt?"
					message={`Keep the completed output for "${pendingRecovery.card.title}" and release its held attempt for reassignment? The result stays unaccepted, and the card remains held until you resume it.`}
					confirmLabel="Retain result and release"
					onConfirm={() => {
						const selected = pendingRecovery;
						setPendingRecovery(null);
						void recoverCard(selected);
					}}
					onClose={() => setPendingRecovery(null)}
				/>
			)}

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

interface BoardCardEntry {
	card: BoardCard;
	collection: BoardWorkspaceCollection;
	key: string;
}

interface BoardCardScrollPosition {
	offset: number;
	key?: string;
	within: number;
}

interface BoardCardListProps {
	status: CardStatus;
	cards: BoardCardEntry[];
	filterKey: string;
	visible: boolean;
	dragCard: { cardId: string; collection: BoardWorkspaceCollection } | null;
	registerColumn: (status: CardStatus, focus: ((index: number) => void) | null) => void;
	renderCard: (entry: BoardCardEntry, index: number) => React.ReactNode;
}

/** Keep column drop surfaces mounted; only card contents leave the scroll window.
 * Dynamic measurement includes selection controls and expanded run disclosures. */
function BoardCardList({
	status,
	cards,
	filterKey,
	visible,
	dragCard,
	registerColumn,
	renderCard,
}: BoardCardListProps) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const offsets = useRef(new Map<string, BoardCardScrollPosition>());
	const restoring = useRef<BoardCardScrollPosition | null>(null);
	const currentFilter = useRef(filterKey);
	const pendingFocus = useRef<string | null>(null);
	const [focusedKey, setFocusedKey] = useState<string | null>(null);
	const windowed = cards.length >= 100;
	const focusedIndex = cards.findIndex((entry) => entry.key === focusedKey);
	const draggedIndex = cards.findIndex(
		({ card, collection }) =>
			card.id === dragCard?.cardId &&
			collection.sourceKey === dragCard.collection.sourceKey &&
			collection.collectionKey === dragCard.collection.collectionKey
	);
	const virtualizer = useVirtualizer({
		count: cards.length,
		observeElementOffset: observeElementOffsetWhileMounted,
		getScrollElement: () => scrollRef.current,
		estimateSize: useCallback(() => 168, []),
		getItemKey: useCallback((index: number) => cards[index].key, [cards]),
		overscan: 3,
		gap: 8,
		initialRect: { width: 202, height: 600 },
		// Keep measurements through empty/small filters. Disabling the virtualizer
		// clears its size cache and moves the restored viewport to a different card.
		measureElement: (element, entry, instance) => {
			const size = measureElement(element, entry, instance);
			// Hidden Workers/editor panels report zero; that is not a new card height.
			return size || instance.measurementsCache[instance.indexFromElement(element)]?.size || 168;
		},
		rangeExtractor: useCallback(
			(range) => {
				const indices = new Set(defaultRangeExtractor(range));
				// Unmounting the native drag source cancels HTML5 dragging. Likewise,
				// a focused control must survive wheel scrolling outside its window.
				if (focusedIndex >= 0) indices.add(focusedIndex);
				if (draggedIndex >= 0) indices.add(draggedIndex);
				return [...indices].sort((a, b) => a - b);
			},
			[focusedIndex, draggedIndex]
		),
	});
	const focusCard = useCallback(
		(index: number) => {
			const entry = cards[index];
			if (!entry) return;
			restoring.current = null;
			// Reveal the column horizontally without asking an offscreen row to scroll.
			scrollRef.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
			pendingFocus.current = entry.key;
			setFocusedKey(entry.key);
			if (windowed) virtualizer.scrollToIndex(index, { align: 'auto' });
			else
				scrollRef.current
					?.querySelector<HTMLElement>(`[data-index="${index}"] [data-board-card]`)
					?.focus();
		},
		[cards, virtualizer, windowed]
	);
	useLayoutEffect(() => {
		registerColumn(status, focusCard);
		return () => registerColumn(status, null);
	}, [status, registerColumn, focusCard]);
	useLayoutEffect(() => {
		if (!pendingFocus.current) return;
		const index = cards.findIndex((entry) => entry.key === pendingFocus.current);
		const tile = scrollRef.current?.querySelector<HTMLElement>(
			`[data-index="${index}"] [data-board-card]`
		);
		if (tile) {
			tile.focus({ preventScroll: true });
			pendingFocus.current = null;
		}
	});
	useLayoutEffect(() => {
		currentFilter.current = filterKey;
		if (visible) restoring.current = offsets.current.get(filterKey) ?? { offset: 0, within: 0 };
	}, [filterKey, visible]);
	const rememberPosition = useCallback(() => {
		if (!visible || restoring.current || !scrollRef.current) return;
		const offset = scrollRef.current.scrollTop;
		const item = virtualizer.getVirtualItemForOffset(offset);
		offsets.current.set(currentFilter.current, {
			offset,
			key: item ? cards[item.index].key : undefined,
			within: offset - (item?.start ?? offset),
		});
	}, [virtualizer, visible, cards]);
	useLayoutEffect(() => {
		const element = scrollRef.current;
		if (!visible || !element) return;
		const position = restoring.current;
		if (position) {
			const index = cards.findIndex((entry) => entry.key === position.key);
			const item = index >= 0 ? virtualizer.measurementsCache[index] : undefined;
			const targetOffset = item ? item.start + position.within : position.offset;
			const offset = Math.max(
				0,
				Math.min(targetOffset, element.scrollHeight - element.clientHeight)
			);
			if (Math.abs(element.scrollTop - offset) > 0.5) {
				if (windowed) virtualizer.scrollToOffset(offset);
				else element.scrollTop = offset;
			}
			// A returning filter may initially use estimated heights. Keep the
			// anchor until its measured row has mounted, then correct before paint.
			const mounted = index < 0 || element.querySelector(`[data-index="${index}"]`);
			if (mounted && Math.abs(element.scrollTop - offset) <= 0.5) restoring.current = null;
		}
		rememberPosition();
	});
	const virtualRows = virtualizer.getVirtualItems();
	const rows = windowed
		? virtualRows
		: cards.map((entry, index) => ({ key: entry.key, index, start: 0 }));
	return (
		<div
			ref={scrollRef}
			className="flex-1 min-h-0 overflow-y-auto p-2"
			role="list"
			aria-label={`${STATUS_META[status].label} cards`}
			onScroll={rememberPosition}
			onWheel={() => {
				restoring.current = null;
			}}
			onTouchStart={() => {
				restoring.current = null;
			}}
			onPointerDown={() => {
				restoring.current = null;
			}}
		>
			<div
				className={windowed ? 'relative' : 'space-y-2'}
				style={windowed ? { height: virtualizer.getTotalSize() } : undefined}
			>
				{rows.map((row) => (
					<div
						key={row.key}
						data-index={row.index}
						role="listitem"
						aria-posinset={row.index + 1}
						aria-setsize={cards.length}
						ref={virtualizer.measureElement}
						onFocusCapture={() => setFocusedKey(cards[row.index].key)}
						style={
							windowed
								? {
										position: 'absolute',
										top: 0,
										left: 0,
										width: '100%',
										transform: `translateY(${row.start}px)`,
									}
								: undefined
						}
					>
						{renderCard(cards[row.index], row.index)}
					</div>
				))}
			</div>
		</div>
	);
}

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
	collection: BoardWorkspaceCollection;
	column: CardStatus;
	index: number;
	onDragStart: (cardId: string, collection: BoardWorkspaceCollection) => void;
	onDragEnd: () => void;
	onClick: (card: BoardCard, focusMove: boolean, collection: BoardWorkspaceCollection) => void;
	/** Arrow-key navigation request; the board decides which tile gets focus. */
	onNavigate: (column: CardStatus, index: number, key: string) => void;
	onDelete: (cardId: string, collection: BoardWorkspaceCollection) => Promise<void>;
	/** Stop the in-flight run. Only rendered on `running` cards. */
	onCancelRun: (cardId: string, collection: BoardWorkspaceCollection) => Promise<void>;
	/** Release an AB1 user hold. Only rendered on cards with `heldByUser`. */
	onResume: (cardId: string, collection: BoardWorkspaceCollection) => Promise<void>;
	onRecover: (cardId: string, collection: BoardWorkspaceCollection) => void;
}

/** A single draggable, focusable card. Shows its title, assignee, parent count,
 * and a "waiting on N" blocker badge (Phase 2 getBlockers); running cards also
 * show attempt, elapsed time, and which worker claimed them. */
const BoardCardTile = memo(function BoardCardTile({
	theme,
	card,
	board,
	profileName,
	agentName,
	projectAgents,
	onJumpToAgent,
	dragging,
	collection,
	column,
	index,
	onDragStart,
	onDragEnd,
	onClick,
	onNavigate,
	onDelete,
	onCancelRun,
	onResume,
	onRecover,
	readiness,
}: BoardCardTileProps) {
	// Delete is armed by the first click and fires on the second, mirroring the
	// "click again to confirm" idiom the browser tab's clear-data button uses.
	// It disarms itself so a stray click never leaves a live trigger sitting there.
	const projectDescriptionId = useId();
	const [deleteArmed, setDeleteArmed] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const deletingRef = useRef(false);
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
		if (deletingRef.current) return;
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
		deletingRef.current = true;
		setDeleting(true);
		void onDelete(card.id, collection).finally(() => {
			deletingRef.current = false;
			setDeleting(false);
		});
	}, [deleteArmed, onDelete, card.id, collection]);

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
					onClick(card, false, collection);
					return;
				case 'm':
				case 'M':
					e.preventDefault();
					onClick(card, true, collection);
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
					onNavigate(column, index, e.key);
					return;
				default:
			}
		},
		[onClick, onNavigate, armOrDelete, card, collection, column, index]
	);

	const priorityMeta = PRIORITY_META[card.priority ?? 'normal'];
	const blockers = getBlockers(card, board);
	// Cards that list this one as a parent: deleting re-parents them onto this
	// card's own parents, which the confirm copy has to say out loud.
	const dependents = board.cards.filter((c) => c.parents.includes(card.id)).length;
	const deleteTitle = deleting
		? 'Deleting card…'
		: deleteArmed
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
		coarsePointer || deleteArmed || deleting
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
	const showWaitReason = !['running', 'ready-for-human', 'done'].includes(card.status);
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
			data-board-card={card.id}
			draggable
			role="button"
			tabIndex={0}
			aria-label={`${card.title}, ${STATUS_META[card.status].label}`}
			aria-describedby={projectDescriptionId}
			onDragStart={() => onDragStart(card.id, collection)}
			onDragEnd={onDragEnd}
			onClick={() => onClick(card, false, collection)}
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
								void onCancelRun(card.id, collection);
							}}
							className="p-0.5 rounded hover:bg-white/10 transition-colors"
							style={{ color: theme.colors.warning }}
							aria-label={`Stop ${card.title}`}
							title="Stop this run"
						>
							<Square className="w-3.5 h-3.5" />
						</button>
					)}
					{isHeld && isRunning && latestRun?.endedAt && (
						<button
							type="button"
							aria-label={`Recover ${card.title}`}
							title="Retain the completed result and release this held attempt for reassignment"
							className="p-0.5 rounded hover:bg-white/10 transition-colors"
							style={{ color: theme.colors.warning }}
							onClick={(event) => {
								event.stopPropagation();
								onRecover(card.id, collection);
							}}
						>
							<RefreshCw className="w-3.5 h-3.5" />
						</button>
					)}
					{isHeld && (
						<button
							onClick={(e) => {
								e.stopPropagation();
								void onResume(card.id, collection);
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
						disabled={deleting}
						className={`p-0.5 rounded hover:bg-white/10 transition-opacity ${deleteVisibility}`}
						style={{ color: deleteArmed ? theme.colors.error : theme.colors.textDim }}
						aria-label={
							deleting
								? `Deleting ${card.title}`
								: deleteArmed
									? `Confirm delete ${card.title}`
									: `Delete ${card.title}`
						}
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
					className="text-2xs rounded px-1.5 py-0.5 break-words min-w-0 max-w-full"
					style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}
					title={assigneeText}
				>
					{assigneeText}
				</span>
				<div className="text-2xs min-w-0 w-full" style={{ color: theme.colors.textDim }}>
					<div>{STATUS_META[card.status].label}</div>
					<div className="truncate" title={card.workingDirectory || card.repositoryId || 'not set'}>
						<span id={projectDescriptionId} className="sr-only">
							Project: {card.workingDirectory || card.repositoryId || 'not set'}
						</span>
						<span aria-hidden="true">
							Project: {truncatePath(card.workingDirectory || card.repositoryId || 'not set', 30)}
						</span>
					</div>
					<div className="break-words">
						Reviewer: {card.reviewerAgentId ? agentName(card.reviewerAgentId) : 'not assigned'}
					</div>
				</div>
				{((showWaitReason && readiness?.length) ||
					!workerText ||
					['triage', 'todo', 'ready', 'blocked'].includes(card.status)) && (
					<div className="text-2xs" style={{ color: theme.colors.textDim }}>
						{showWaitReason && readiness?.length
							? `Waiting: ${readiness.map((reason) => READINESS_LABELS[reason as BoardReadinessReason] ?? reason).join(', ')}`
							: ['triage', 'todo', 'ready', 'blocked'].includes(card.status)
								? 'Waiting: host diagnosis unknown'
								: 'Worker: not recorded'}
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
});

// ---------------------------------------------------------------------------

interface CardEditorProps {
	onRevalidateSource: () => Promise<void>;
	theme: Theme;
	draft: CardDraft;
	setDraft: React.Dispatch<React.SetStateAction<CardDraft | null>>;
	catalog: BoardCaptureCatalog | null;
	catalogError: string | null;
	saveError: Extract<BoardCaptureResponse, { ok: false }>['error'] | null;
	onRefreshCatalog: () => void;
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
	onAccept: () => void;
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
	onRevalidateSource,
	theme,
	draft,
	setDraft,
	catalog,
	catalogError,
	saveError,
	onRefreshCatalog,
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
	onAccept,
	onSave,
	onCancel,
	onMove,
	autoFocusMove,
	profileName,
	projectAgents,
}: CardEditorProps) {
	const [repairMessage, setRepairMessage] = useState<string | null>(null);
	const bodyResize = useResizableTextarea({ sizeKey: 'board-card-body' });
	// Candidate parents are every other card (a card cannot depend on itself).
	const candidateParents = board.cards.filter((c) => c.id !== draft.id);
	const isExisting = draft.id !== null;
	const scope = draft.executionScope;
	const agents = catalog?.agents ?? [];
	const agentLabel = (id: string) => projectAgents.find((entry) => entry.id === id)?.name ?? id;
	const agentOptions = agents.map((agent) => ({ value: agent.id, label: agentLabel(agent.id) }));
	const assigneeAgentId = draft.assigneeAgentId;
	const reviewerAgentId = draft.reviewerAgentId;
	const pinnedAgentSelect = (
		<ThemedSelect
			aria-label="Pin to agent (optional)"
			theme={theme}
			disabled={saving}
			value={assigneeAgentId}
			onChange={(value) => setDraft((p) => (p ? { ...p, assigneeAgentId: value } : p))}
			filterable
			options={[
				{ value: '', label: 'Any worker within scope' },
				...(assigneeAgentId && !agents.some((agent) => agent.id === assigneeAgentId)
					? [{ value: assigneeAgentId, label: `Missing agent: ${assigneeAgentId}` }]
					: []),
				...agentOptions,
			]}
		/>
	);
	const reviewerAgentSelect = (
		<ThemedSelect
			aria-label="Reviewer within task scope"
			theme={theme}
			disabled={saving}
			value={reviewerAgentId ?? ''}
			onChange={(value) => setDraft((p) => (p ? { ...p, reviewerAgentId: value } : p))}
			filterable
			options={[
				{ value: '', label: 'Wait for an assigned reviewer' },
				...(reviewerAgentId && !agents.some((agent) => agent.id === reviewerAgentId)
					? [{ value: reviewerAgentId, label: `Missing agent: ${reviewerAgentId}` }]
					: []),
				...agentOptions,
			]}
		/>
	);
	const scopeValue = scope ? canonicalJson(scope) : '';
	const roleValue = draft.role
		? canonicalJson({ namespace: draft.role.namespace, profileId: draft.role.profileId })
		: draft.assigneeProfileId
			? 'unresolved-legacy-role'
			: '';
	const roleChoices = (catalog?.profiles ?? []).map(({ namespace, profile }) => ({
		ref: { namespace, profileId: profile.id },
		profile,
	}));
	const moveRef = useRef<HTMLButtonElement>(null);
	// One-shot, like the dialog's initial focus: without it every later render
	// (a `board:changed` push, a keystroke) would yank focus back to the picker.
	const moveFocusDone = useRef(false);
	useFocusAfterRender(moveRef, autoFocusMove && isExisting && !moveFocusDone.current);
	useEffect(() => {
		moveFocusDone.current = true;
	}, []);

	return (
		<div
			className="flex-1 min-h-0 min-w-0 overflow-y-auto p-3 sm:p-5 space-y-4 select-text"
			style={{ color: theme.colors.textMain }}
		>
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
				<div role="alert" className="break-words" style={{ color: theme.colors.error }}>
					{saveError.code}: {saveError.message}
					{saveError.captureErrors?.length ? ` (${saveError.captureErrors.join(', ')})` : ''}
				</div>
			)}
			{catalogError ? (
				<div role="alert" className="break-words" style={{ color: theme.colors.error }}>
					Capture catalog unavailable: {catalogError}{' '}
					<button
						type="button"
						onClick={onRefreshCatalog}
						className="underline focus-visible:ring-2 focus-visible:ring-blue-400"
						style={{ color: theme.colors.accent }}
					>
						Retry catalog
					</button>
				</div>
			) : (
				!catalog && <div role="status">Loading capture choices...</div>
			)}
			{isExisting && (draft.kind === 'work' || draft.kind === undefined) && (
				<button
					type="button"
					disabled={!canAddReview || saving}
					onClick={onAddReview}
					className="rounded-md px-3 py-1.5 text-sm focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-50"
					style={{ border: `1px solid ${theme.colors.border}`, color: theme.colors.textMain }}
				>
					Add review
				</button>
			)}
			{draft.status === 'ready-for-human' && draft.kind !== 'review' && (
				<button
					type="button"
					disabled={!canApproveStart || saving}
					onClick={onAccept}
					className="rounded-md px-3 py-2 text-sm"
					style={{ backgroundColor: theme.colors.accent, color: theme.colors.accentForeground }}
				>
					Approve final result
				</button>
			)}
			<fieldset disabled={saving} className="space-y-4">
				<div className="space-y-1">
					<span className="text-xs" style={{ color: theme.colors.textDim }}>
						Task type
					</span>
					<ThemedSelect
						aria-label="Task type"
						theme={theme}
						disabled={saving || !!draft.reviewContext}
						value={draft.kind ?? ''}
						onChange={(value) =>
							setDraft((p) =>
								p ? { ...p, kind: (value || undefined) as BoardCardKind | undefined } : p
							)
						}
						options={[
							{ value: '', label: 'Unspecified' },
							...['work', 'review', 'test', 'documentation'].map((value) => ({
								value,
								label: value[0].toUpperCase() + value.slice(1),
							})),
						]}
					/>
				</div>
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
									className="w-full rounded-md px-2 py-1.5 text-sm focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-50"
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
					<div
						className="block space-y-1 flex-1 min-w-0 basis-[180px]"
						style={{ color: theme.colors.textDim }}
					>
						<span className="text-xs">Execution scope</span>
						<ThemedSelect
							aria-label="Execution scope"
							theme={theme}
							disabled={saving}
							filterable
							value={scopeValue}
							onChange={(value) => {
								if (value === scopeValue) return;
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
												executionScope: choices.find((choice) => canonicalJson(choice) === value),
											}
										: p
								);
							}}
							options={[
								{ value: '', label: 'Unassigned (waits for scope)' },
								...(scope &&
								((scope.kind === 'agent' && !agents.some((agent) => agent.id === scope.agentId)) ||
									(scope.kind === 'group' &&
										!catalog?.groups.some((group) => group.id === scope.groupId)))
									? [
											{
												value: scopeValue,
												label: `Missing ${scope.kind}: ${scope.kind === 'agent' ? scope.agentId : scope.groupId}`,
											},
										]
									: []),
								...agents.map((agent) => ({
									value: canonicalJson({ kind: 'agent', agentId: agent.id }),
									label: `Agent: ${agentLabel(agent.id)}`,
								})),
								...(catalog?.groups ?? []).map((group) => ({
									value: canonicalJson({ kind: 'group', groupId: group.id }),
									label: `Group: ${useSessionStore.getState().groups.find((entry) => entry.id === group.id)?.name ?? group.id}`,
								})),
							]}
						/>
					</div>
					<div
						className="block space-y-1 flex-1 min-w-0 basis-[180px]"
						style={{ color: theme.colors.textDim }}
					>
						<span className="text-xs">Repository</span>
						<ThemedSelect
							aria-label="Repository"
							value={draft.repositoryId}
							theme={theme}
							disabled={saving}
							filterable
							filterPlaceholder="Filter repositories"
							onChange={(value) => setDraft((p) => (p ? { ...p, repositoryId: value } : p))}
							options={[
								{ value: '', label: 'Unresolved repository' },
								...(draft.repositoryId &&
								!catalog?.repositories.some((repo) => repo.id === draft.repositoryId)
									? [
											{
												value: draft.repositoryId,
												label: `Missing repository: ${draft.repositoryId}`,
											},
										]
									: []),
								...(catalog?.repositories ?? []).map((repo) => ({
									value: repo.id,
									label: `${repo.id}: ${repo.workingDirectory}${repo.location?.kind === 'ssh' ? ` [SSH: ${repo.location.remoteId || 'unresolved'}]` : ''}${repo.validated ? '' : ` (unresolved: ${repo.diagnostic ?? 'revalidate source'})`}`,
								})),
							]}
						/>
					</div>
					<label
						className="block space-y-1 flex-1 min-w-0 basis-[180px]"
						style={{ color: theme.colors.textDim }}
					>
						<span className="text-xs">Working directory</span>
						<input
							aria-label="Working directory"
							value={draft.workingDirectory}
							placeholder="Explicit absolute execution directory"
							style={inputStyle}
							className="w-full rounded-md px-2 py-1.5 text-sm focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-50"
							onChange={(e) =>
								setDraft((p) => (p ? { ...p, workingDirectory: e.target.value } : p))
							}
						/>
					</label>
					<div
						className="block space-y-1 flex-1 min-w-0 basis-[180px]"
						style={{ color: theme.colors.textDim }}
					>
						<span className="text-xs">Start mode</span>
						<ThemedSelect
							aria-label="Start mode"
							theme={theme}
							disabled={saving}
							value={draft.startModeOverride ?? ''}
							onChange={(value) =>
								setDraft((p) =>
									p
										? {
												...p,
												startModeOverride:
													value === 'direct'
														? 'direct'
														: value === 'approval'
															? 'approval'
															: undefined,
											}
										: p
								)
							}
							options={[
								{
									value: '',
									label: isExisting
										? `Keep saved policy (${board.cards.find((card) => card.id === draft.id)?.capturePolicy?.effectiveStartMode ?? 'host decides'})`
										: `Board default (${board.defaultStartMode ?? catalog?.defaultStartMode ?? 'approval'})`,
								},
								{ value: 'approval', label: 'Require approval' },
								{ value: 'direct', label: 'Direct scheduling' },
							]}
						/>
					</div>
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
					className="rounded-md px-3 py-1.5 text-sm focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-50"
					style={{ border: `1px solid ${theme.colors.border}`, color: theme.colors.textMain }}
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
						className="w-full rounded-md px-2 py-1.5 text-sm focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-50"
						style={inputStyle}
					/>
				</label>

				<label className="block space-y-1">
					<span className="text-xs" style={{ color: theme.colors.textDim }}>
						Body / instructions
					</span>
					<textarea
						ref={bodyResize.textareaRef}
						value={draft.body}
						onChange={(e) => setDraft((p) => (p ? { ...p, body: e.target.value } : p))}
						placeholder="Instructions handed to the assignee agent."
						rows={4}
						className="w-full rounded-md px-2 py-1.5 text-sm resize-y focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-50"
						style={{ ...inputStyle, ...bodyResize.style }}
					/>
				</label>

				<div className="flex gap-3 flex-wrap">
					<div className="block space-y-1 flex-1 min-w-0 basis-[180px]">
						<span className="text-xs" style={{ color: theme.colors.textDim }}>
							Required role (optional)
						</span>
						<ThemedSelect
							aria-label="Required role (optional)"
							theme={theme}
							disabled={saving}
							filterable
							value={roleValue}
							onChange={(value) => {
								if (value === roleValue) return;
								const role = roleChoices.find((choice) => canonicalJson(choice.ref) === value)?.ref;
								setDraft((p) => (p ? { ...p, role, assigneeProfileId: role?.profileId ?? '' } : p));
							}}
							options={[
								{ value: '', label: 'Any role within scope' },
								...(roleValue &&
								!roleChoices.some((choice) => canonicalJson(choice.ref) === roleValue)
									? [
											{
												value: roleValue,
												label: `Unresolved role: ${draft.role ? `${draft.role.namespace} / ${draft.role.profileId}` : draft.assigneeProfileId}`,
											},
										]
									: []),
								...roleChoices.map(({ ref, profile }) => ({
									value: canonicalJson(ref),
									label: `${profile.name} (${ref.namespace} / ${ref.profileId})${profile.baseAgentId ? ` [agent: ${agentLabel(profile.baseAgentId)}]` : ''}`,
								})),
							]}
						/>
						<p className="text-xs" style={{ color: theme.colors.textDim }}>
							Uses existing worker role access. Only a worker in scope with this exact role can run;
							unavailable or conflicting assignments wait for repair.
						</p>
					</div>
					<div className="block space-y-1 flex-1 min-w-0 basis-[180px]">
						<span className="text-xs" style={{ color: theme.colors.textDim }}>
							Pin to agent (optional)
						</span>
						{pinnedAgentSelect}
					</div>
					<div className="block space-y-1 flex-1 min-w-0 basis-[180px]">
						<span className="text-xs" style={{ color: theme.colors.textDim }}>
							Reviewer within task scope
						</span>
						{reviewerAgentSelect}
					</div>
					<div className="block space-y-1 flex-1 min-w-0 basis-[160px]">
						<span className="text-xs" style={{ color: theme.colors.textDim }}>
							Priority
						</span>
						<ThemedSelect
							aria-label="Priority"
							theme={theme}
							disabled={saving}
							value={draft.priority}
							onChange={(value) =>
								setDraft((p) => (p ? { ...p, priority: value as CardPriority } : p))
							}
							options={CARD_PRIORITIES.map((value) => ({
								value,
								label: PRIORITY_META[value].label,
							}))}
						/>
					</div>
					<div className="block space-y-1 flex-1 min-w-0 basis-[160px]">
						<span className="text-xs" style={{ color: theme.colors.textDim }}>
							{isExisting ? 'Move to' : 'Status'}
						</span>
						{/* On an existing card this is the keyboard route for what drag-and-drop
					    does with a mouse: it persists immediately (setCardStatus), with the
					    same dispatcher guards. On a NEW card there is nothing to move yet,
					    so it just seeds the draft's starting column. */}
						<ThemedSelect
							triggerRef={moveRef}
							aria-label={isExisting ? 'Move to' : 'Status'}
							theme={theme}
							disabled={saving}
							value={draft.status}
							onChange={(value) => {
								const status = value as CardStatus;
								if (status === draft.status) return;
								if (isExisting) onMove(status);
								else setDraft((p) => (p ? { ...p, status } : p));
							}}
							options={CARD_STATUSES.filter(
								(status) => isExisting || (status !== 'ready' && status !== 'running')
							).map((value) => ({ value, label: STATUS_META[value].label }))}
						/>
					</div>
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
							className="cursor-pointer focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-50"
							style={{ accentColor: theme.colors.accent }}
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
							<label className="block space-y-1 flex-1 min-w-0 basis-[180px]">
								<span className="text-xs" style={{ color: theme.colors.textDim }}>
									Worktree path (optional)
								</span>
								<input
									value={draft.worktreePath}
									onChange={(e) =>
										setDraft((p) => (p ? { ...p, worktreePath: e.target.value } : p))
									}
									placeholder="auto: sibling worktrees/ folder"
									className="w-full rounded-md px-2 py-1.5 text-sm focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-50"
									style={inputStyle}
								/>
							</label>
							<label className="block space-y-1 flex-1 min-w-0 basis-[180px]">
								<span className="text-xs" style={{ color: theme.colors.textDim }}>
									Worktree branch (optional)
								</span>
								<input
									value={draft.worktreeBranch}
									onChange={(e) =>
										setDraft((p) => (p ? { ...p, worktreeBranch: e.target.value } : p))
									}
									placeholder="auto: board/<board>/<card>"
									className="w-full rounded-md px-2 py-1.5 text-sm focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-50"
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
									className="cursor-pointer focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-50"
									style={{ accentColor: theme.colors.accent }}
								/>
								<span className="text-xs" style={{ color: theme.colors.textMain }}>
									Open PR when done
								</span>
								<span className="text-xs-plus" style={{ color: theme.colors.textDim }}>
									(the branch is still not merged - a pull request is opened for review)
								</span>
							</label>
							{draft.prOnDoneEnabled && (
								<label className="block space-y-1 w-full max-w-64">
									<span className="text-xs" style={{ color: theme.colors.textDim }}>
										PR target branch (optional)
									</span>
									<input
										value={draft.prTargetBranch}
										onChange={(e) =>
											setDraft((p) => (p ? { ...p, prTargetBranch: e.target.value } : p))
										}
										placeholder="repo default branch"
										className="w-full rounded-md px-2 py-1.5 text-sm focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-50"
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
											style={{ accentColor: theme.colors.accent }}
											className="focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-50"
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
						role="alert"
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
						style={{ backgroundColor: theme.colors.accent, color: theme.colors.accentForeground }}
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
