/**
 * Board - shared contracts.
 *
 * A Board is a persistent task DAG in the machine-local SQLite workspace.
 * Legacy project YAML is migration input only. Collections and cards carry
 * explicit source identities and read revisions across desktop/CLI boundaries.
 * Captured drafts may be incomplete; execution is separately gated by scope,
 * repository, approval and the fenced runtime.
 *
 * This module is pure and framework-free (no Electron/React imports) so it can
 * run in main, renderer, and CLI alike.
 */

/**
 * Lifecycle status of a card.
 *
 * - `triage`  - captured but not yet groomed; needs a human decision before it
 *               can move to `todo`. Never auto-run.
 * - `todo`    - accepted work, waiting on its parents. The author's default
 *               resting state for a real task. Two populations live here: cards
 *               that have never run, and cards a user stopped mid-run, which
 *               stay `todo` but carry {@link BoardCard.heldByUser} and are never
 *               auto-promoted until a person resumes them.
 * - `ready`   - derived/promoted: a `todo` card whose parents are all `done`,
 *               eligible for dispatch. Phase 3 computes this; authors do NOT
 *               hand-write it (see {@link getEligibleCards}).
 * - `running` - a dispatcher has spawned an agent for this card and it is in
 *               flight.
 * - `review`  - the run reached a deliberate conclusion but needs a HUMAN to
 *               approve or verify it before it counts. Not a failure: nothing
 *               went wrong, the work simply requires human judgment. Like
 *               `blocked` it does NOT unblock children (only `done` does), and
 *               it is never auto-retried. A person approves by moving the card
 *               `review` -> `done`, which is the only approval path.
 * - `blocked` - a run finished without completing (agent reported a blocker) or
 *               a parent regressed; needs attention before it can retry.
 * - `done`    - completed successfully; unblocks children that depend on it.
 */
export type CardStatus = 'triage' | 'todo' | 'ready' | 'running' | 'review' | 'blocked' | 'done';

/** Host-observed clean Git artifact at native completion. */
export interface BoardRunArtifact {
	worktreePath: string;
	branch: string;
	commit: string;
}
/** Immutable reference to a completed source attempt, with reported check evidence. */
export interface BoardReviewHandoff {
	repositoryId: string;
	sourceKey: string;
	collectionKey: string;
	cardId: string;
	runId: string;
	attempt: number;
	artifact: BoardRunArtifact;
	checks: string;
}

/**
 * Reference to the git worktree a card's run happens in. Minimal by design:
 * Phase 3 fills this when it dispatches a card. Kept structural and local to
 * the board module so this shared file stays framework-free.
 */
export interface WorktreeRef {
	/** Absolute path to the worktree checkout. */
	path: string;
	/** Branch checked out in the worktree, if known. */
	branch?: string;
}

/**
 * Per-card opt-in: open a pull request when the card lands in `done`.
 *
 * Only meaningful on a card that also opted into worktree isolation
 * ({@link BoardCard.worktree}) - the PR is opened for the branch that worktree
 * holds. An ABSENT field means the feature is off, and it is never serialized
 * in that case, so existing board.yaml files stay byte-identical until someone
 * actually turns it on (same convention as {@link CardPriority}).
 *
 * The branch is still never auto-merged; a PR is simply opened for it.
 */
export interface CardPrOnDone {
	/**
	 * Branch the PR targets. Absent means "the repo's default branch", resolved
	 * at PR time rather than baked into the board file.
	 */
	targetBranch?: string;
}

/**
 * The terminal outcome a dispatcher records for one attempt at a card.
 *
 * `reclaimed` is deliberately distinct from `error`: it means the attempt was
 * abandoned by the HOST (the engine restarted mid-run and the process is gone),
 * not that the work failed. It is excluded from the retry circuit breaker's
 * trailing-failure count, because two app restarts during a long-running card
 * would otherwise force-block a perfectly healthy card.
 *
 * `canceled` is the same idea for a USER-initiated stop: the person hit the stop
 * button, so the attempt says nothing about whether the card can succeed. It is
 * likewise excluded from the breaker. The card keeps its `todo` status but is
 * HELD ({@link BoardCard.heldByUser}), so the promote pass leaves it alone until
 * a person resumes it - a stop really stops, it does not re-queue the card.
 *
 * `review` records that the attempt finished deliberately but handed the card to
 * a human for approval or verification (see the `review` {@link CardStatus}). It
 * is not a failure, so it resets the trailing-failure count the way `done` does,
 * and the run is never auto-retried.
 */
export type CardRunOutcome = 'done' | 'review' | 'blocked' | 'error' | 'reclaimed' | 'canceled';

/** Every outcome a persisted run may carry (the runtime mirror of {@link CardRunOutcome}). */
export const CARD_RUN_OUTCOMES: readonly CardRunOutcome[] = [
	'done',
	'review',
	'blocked',
	'error',
	'reclaimed',
	'canceled',
];

/**
 * Dispatch priority of a card. `normal` is the default and is NEVER serialized
 * (an absent `priority` and an explicit `normal` mean the same thing), so
 * existing board.yaml files stay byte-identical until someone actually
 * prioritizes something.
 */
export type CardPriority = 'high' | 'normal' | 'low';

/** All priorities, highest first - also the dispatch order. */
export const CARD_PRIORITIES: readonly CardPriority[] = ['high', 'normal', 'low'];

/** Sort weight for {@link CardPriority}; higher dispatches first. */
const PRIORITY_RANK: Record<CardPriority, number> = { high: 2, normal: 1, low: 0 };

/** Dispatch rank of a card, defaulting an absent priority to `normal`. */
export function cardPriorityRank(card: Pick<BoardCard, 'priority'>): number {
	return PRIORITY_RANK[card.priority ?? 'normal'];
}

/**
 * Bookkeeping for a single dispatch attempt of a card. A card accumulates one
 * {@link CardRun} per attempt so retries after a `blocked`/`error` are auditable.
 */
export interface CardRun {
	artifact?: BoardRunArtifact;
	/** 1-based attempt counter for this card. */
	attempt: number;
	/** ISO timestamp when the agent was spawned. */
	startedAt: string;
	/** ISO timestamp when the run finished, if it has. */
	endedAt?: string;
	/** Terminal outcome, once known. */
	outcome?: CardRunOutcome;
	/** Short human-facing summary of what the run did. */
	summary?: string;
	/**
	 * Id of the pool worker (Left Bar agent) this attempt ran on (Board Phase 6).
	 * Set when the card was claimed by the worker-pool dispatcher so the "one card
	 * per worker" busy-set survives across ticks and engine restarts. Absent for
	 * legacy single-agent runs.
	 */
	workerAgentId?: string;
	/**
	 * Absolute path of the isolated git worktree this attempt ran in (Board
	 * Phase 4). Set only when the card opted into worktree isolation; absent
	 * means the attempt ran in the shared project root.
	 */
	worktreePath?: string;
	/**
	 * Branch checked out in {@link worktreePath}. Recorded so a finished card
	 * tells the user exactly which branch holds its output (the branch is never
	 * auto-merged or auto-deleted).
	 */
	worktreeBranch?: string;
	/**
	 * URL of the pull request opened for {@link worktreeBranch} when the card
	 * carried {@link BoardCard.prOnDone} and reached `done`. Absent when the card
	 * did not opt in, had no worktree branch, or PR creation failed (a failure
	 * never changes the card's status).
	 */
	prUrl?: string;
	/**
	 * Why the most recent PR-on-done attempt failed (push rejected, gh missing, no
	 * commits ahead of the base). Persisted so the failure survives the toast and
	 * stays visible on the card; cleared when a later attempt succeeds and stamps
	 * {@link prUrl}. A failed attempt never changes the card's status.
	 */
	prError?: string;
	/** Free-form dispatcher metadata (session id, tokens, etc.). */
	metadata?: Record<string, unknown>;
}

/**
 * A single task on the board.
 *
 * `parents` are card ids this card depends on; the card is eligible only when
 * every parent is `done` (see {@link getEligibleCards}).
 *
 * ── Legacy assignee fields ─────────────────────────────────────────────────
 * These preserved assignment fields do not grant execution authority:
 *   - `assigneeProfileId` names an {@link AgentProfile} (a *role*: model/effort/
 *     role-prompt overrides). A role-only card (profile has no `baseAgentId`)
 *     floats to any FREE opt-in worker in the board's project directory.
 *   - `assigneeAgentId` pins the card to one specific Left Bar agent (its own
 *     native settings). Combined with a profile, that agent wears the role.
 * Resolution: `assigneeAgentId` (or a legacy profile's `baseAgentId`) pins a
 * single worker; otherwise the free project pool is used.
 */
export interface BoardCard extends BoardCaptureOptions {
	/** Host-owned. CRUD may retain this snapshot but never replace it. */
	reviewHandoff?: BoardReviewHandoff;
	/** Host-owned snapshot; CRUD cannot create or change grants. */
	capturePolicy?: BoardCapturePolicy;
	/** Central read token; transport metadata only, never persisted in card payload. */
	storageRevision?: number;
	/** Stable unique id (UUID). */
	id: string;
	/** Human-facing title shown on the card. */
	title: string;
	/** Task body / instructions handed to the assignee agent. */
	body: string;
	/**
	 * Id of the Agent Profile (role) that runs this card. Optional since Phase 6:
	 * a card may pin an agent directly via {@link assigneeAgentId} instead. At
	 * least one of the two must be set.
	 */
	assigneeProfileId?: string;
	/**
	 * Id of a specific Left Bar agent this card is pinned to (Board Phase 6). When
	 * absent and the profile is agent-less, the card floats to the free worker
	 * pool. When set, the card runs on exactly this agent (waiting if it is busy).
	 */
	assigneeAgentId?: string;
	/** Ids of cards that must be `done` before this one is eligible. */
	parents: string[];
	/** Lifecycle status. */
	status: CardStatus;
	/**
	 * The user stopped this card and it is held until they resume it. Set by
	 * `applyCardCancel`, honoured by `getEligibleCards` (a held card is never
	 * promoted to `ready`), and cleared when the user resumes the card. The card
	 * keeps its `todo` status while held - the work is genuinely not done and still
	 * waiting - so the hold is a separate axis rather than a seventh
	 * {@link CardStatus}. Absent means not held and is never serialized.
	 */
	heldByUser?: boolean;
	/**
	 * Dispatch priority. Absent means `normal`; the dispatcher claims `ready`
	 * cards by priority descending, then oldest-first within a priority.
	 */
	priority?: CardPriority;
	/** Worktree the card runs in, once dispatched. */
	worktree?: WorktreeRef;
	/**
	 * Open a pull request when this card reaches `done`. Absent means off (and is
	 * never serialized); only meaningful alongside {@link worktree}.
	 */
	prOnDone?: CardPrOnDone;
	/** Per-attempt run history, most-recent last. */
	runs?: CardRun[];
	/** ISO timestamp the card was created. */
	createdAt: string;
	/** ISO timestamp the card was last modified. */
	updatedAt: string;
}

/** A project is addressed by its registered canonical source, never a display name. */
export interface BoardProjectRef {
	sourceKey: string;
}

export interface BoardSourceCatalogEntry {
	location?: { location: { kind: 'local' } | { kind: 'ssh'; remoteId: string }; path: string };
	sourceKey: string;
	projectRef: BoardProjectRef;
}

export interface BoardWorkspaceQuery {
	/** Omitted filters include every registered/imported source in this workspace. */
	sourceKey?: string;
	projectRef?: BoardProjectRef;
	/** Compatibility lookup; must resolve to exactly one registered source. */
	projectRoot?: string;
}

export interface BoardWorkspaceCollection {
	sourceKey: string;
	collectionKey: string;
	revision: number;
	projectRef: BoardProjectRef;
	board: Board;
	/** Current read-only host diagnosis, keyed within this exact source/collection. */
	readiness?: Record<string, import('./domain').BoardReadinessReason[]>;
}

export interface BoardWorkspaceQueryResult {
	revision: number;
	sources: BoardSourceCatalogEntry[];
	collections: BoardWorkspaceCollection[];
}

/** Explicit envelope preserves expected error codes across Electron serialization. */
export type BoardWorkspaceQueryResponse =
	| { ok: true; value: BoardWorkspaceQueryResult }
	| { ok: false; error: { code: string; message: string } };

/** Explicit central identity and optimistic concurrency token, carried across transports. */
export interface BoardStorageRef {
	sourceKey: string;
	collectionKey: string;
	expectedRevision: number | null;
	cardRevisions: Record<string, number>;
}

/** A named collection of cards plus optional concurrency cap. */
export interface Board {
	/** Host-owned default; absent legacy boards resolve conservatively. */
	defaultStartMode?: BoardStartMode;
	storage?: BoardStorageRef;
	/** Stable unique id (UUID). */
	id: string;
	/** Human-facing board name. */
	name: string;
	/** All cards on the board. */
	cards: BoardCard[];
	/** Optional cap on how many cards may be `running` at once (Phase 3). */
	maxInProgress?: number;
	/**
	 * OPTIONAL auto-decompose (Phase 5), OFF by default. When `true`, the
	 * dispatcher may take a `triage` card and run one LLM pass to fan it into
	 * child cards (capped per tick). When absent/false, `triage` cards are never
	 * auto-expanded and simply wait for manual promotion. The manual Board
	 * (Phases 1-4) is fully useful without this.
	 */
	autoDecompose?: boolean;
}

/** All statuses that are valid on a persisted/author-created card. */
export const CARD_STATUSES: readonly CardStatus[] = [
	'triage',
	'todo',
	'ready',
	'running',
	'review',
	'blocked',
	'done',
];

function isCardStatus(value: unknown): value is CardStatus {
	return typeof value === 'string' && (CARD_STATUSES as readonly string[]).includes(value);
}

function optionalString(value: unknown): string | undefined {
	if (typeof value !== 'string') return undefined;
	return value.trim().length > 0 ? value : undefined;
}

/**
 * Validate an untrusted object as a {@link WorktreeRef}. Returns a normalized
 * ref or `null` when the shape is unusable (missing/blank path).
 */
function validateWorktreeRef(raw: unknown): WorktreeRef | null {
	if (!raw || typeof raw !== 'object') return null;
	const r = raw as Record<string, unknown>;
	const p = optionalString(r.path);
	if (!p) return null;
	const ref: WorktreeRef = { ...r, path: p };
	const branch = optionalString(r.branch);
	if (branch !== undefined) ref.branch = branch;
	return ref;
}

/**
 * Validate an untrusted object as a {@link CardPrOnDone}. Returns `null` when the
 * value is not an object, so a malformed entry drops the opt-in entirely rather
 * than silently arming a PR. An empty object is valid and means "default branch".
 */
function validateCardPrOnDone(raw: unknown): CardPrOnDone | null {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
	const r = raw as Record<string, unknown>;
	const prOnDone: CardPrOnDone = { ...r };
	delete prOnDone.targetBranch;
	const targetBranch = optionalString(r.targetBranch);
	if (targetBranch !== undefined) prOnDone.targetBranch = targetBranch.trim();
	return prOnDone;
}

/** Validate a single run entry, dropping malformed fields. Returns null if unusable. */
function validateCardRun(raw: unknown): CardRun | null {
	if (!raw || typeof raw !== 'object') return null;
	const r = raw as Record<string, unknown>;
	const attempt = typeof r.attempt === 'number' && Number.isFinite(r.attempt) ? r.attempt : null;
	const startedAt = optionalString(r.startedAt);
	if (attempt === null || !startedAt) return null;
	const run: CardRun = { ...r, attempt, startedAt };
	for (const field of [
		'endedAt',
		'outcome',
		'summary',
		'workerAgentId',
		'worktreePath',
		'worktreeBranch',
		'prUrl',
		'prError',
		'metadata',
	]) {
		delete (run as unknown as Record<string, unknown>)[field];
	}
	const endedAt = optionalString(r.endedAt);
	if (endedAt !== undefined) run.endedAt = endedAt;
	if (
		typeof r.outcome === 'string' &&
		(CARD_RUN_OUTCOMES as readonly string[]).includes(r.outcome)
	) {
		run.outcome = r.outcome as CardRunOutcome;
	}
	const summary = optionalString(r.summary);
	if (summary !== undefined) run.summary = summary;
	const workerAgentId = optionalString(r.workerAgentId);
	if (workerAgentId !== undefined) run.workerAgentId = workerAgentId;
	const worktreePath = optionalString(r.worktreePath);
	if (worktreePath !== undefined) run.worktreePath = worktreePath;
	const worktreeBranch = optionalString(r.worktreeBranch);
	if (worktreeBranch !== undefined) run.worktreeBranch = worktreeBranch;
	const prUrl = optionalString(r.prUrl);
	if (prUrl !== undefined) run.prUrl = prUrl;
	const prError = optionalString(r.prError);
	if (prError !== undefined) run.prError = prError;
	if (r.metadata && typeof r.metadata === 'object' && !Array.isArray(r.metadata)) {
		run.metadata = r.metadata as Record<string, unknown>;
	}
	return run;
}

/**
 * Validate an untrusted object as a {@link BoardCard}. Returns a normalized card
 * on success, or `null` when the shape is malformed. Used by migration,
 * the central storage facade and IPC handlers before
 * persisting caller input.
 *
 * Rules: `id` and `title` must be non-empty strings. Draft cards may omit
 * assignees and scope; capture readiness explains why they cannot run.
 * Unknown execution/migration fields are retained. `status` must be a known
 * {@link CardStatus}. `parents` defaults to `[]` and keeps only non-empty string
 * ids. Missing `createdAt`/`updatedAt` fall back to {@link nowIso} when supplied.
 * Optional `worktree`/`prOnDone`/`runs` are validated structurally and dropped
 * when malformed. `heldByUser` is carried through only when it is exactly `true`.
 */
export function validateBoardCard(raw: unknown, nowIso?: string): BoardCard | null {
	if (!raw || typeof raw !== 'object') return null;
	const r = raw as Record<string, unknown>;

	const id = typeof r.id === 'string' ? r.id.trim() : '';
	const title = typeof r.title === 'string' ? r.title.trim() : '';
	const assigneeProfileId =
		typeof r.assigneeProfileId === 'string' ? r.assigneeProfileId.trim() : '';
	const assigneeAgentId = typeof r.assigneeAgentId === 'string' ? r.assigneeAgentId.trim() : '';
	// Missing assignment is a capturable draft, not permission to select a fallback worker.
	if (!id || !title) return null;
	if (!isCardStatus(r.status)) return null;

	const parents = Array.isArray(r.parents)
		? r.parents
				.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
				.map((p) => p.trim())
		: [];

	const body = typeof r.body === 'string' ? r.body : '';
	const createdAt = optionalString(r.createdAt) ?? nowIso ?? '';
	const updatedAt = optionalString(r.updatedAt) ?? createdAt;

	const card: BoardCard = {
		...r,
		id,
		title,
		body,
		parents,
		status: r.status,
		createdAt,
		updatedAt,
	};
	// Normalize known presentation fields while keeping unknown execution/migration metadata.
	delete card.priority;
	delete card.heldByUser;
	delete card.prOnDone;
	if (assigneeProfileId) card.assigneeProfileId = assigneeProfileId;
	if (assigneeAgentId) card.assigneeAgentId = assigneeAgentId;

	// `normal` is the default and is deliberately dropped rather than stored, so
	// a card is only ever serialized with a priority when it is not the default.
	if (r.priority === 'high' || r.priority === 'low') card.priority = r.priority;

	// Same "only the non-default" rule as `priority`: not-held is the default, so
	// only a genuine hold is carried through. This copy is what makes a user's
	// stop survive a save/load round trip - the card literal above is a whitelist
	// rebuild, so a field missing here is silently dropped on the next save.
	if (r.heldByUser === true) card.heldByUser = true;

	const worktree = validateWorktreeRef(r.worktree);
	if (worktree) card.worktree = worktree;

	// Absent/malformed means the opt-in is off, so nothing is written back out.
	if (r.prOnDone !== undefined) {
		const prOnDone = validateCardPrOnDone(r.prOnDone);
		if (prOnDone) card.prOnDone = prOnDone;
	}

	if (Array.isArray(r.runs)) {
		const runs = r.runs
			.map((run) => validateCardRun(run))
			.filter((run): run is CardRun => run !== null);
		if (runs.length !== r.runs.length) return null;
		card.runs = runs;
	}

	return card;
}

/**
 * Validate an untrusted Board without silently dropping malformed/duplicate cards.
 * Invalid legacy records remain in the migration snapshot and fail legacy projection.
 */
export function validateBoard(raw: unknown, nowIso?: string): Board | null {
	if (!raw || typeof raw !== 'object') return null;
	const r = raw as Record<string, unknown>;

	const id = typeof r.id === 'string' ? r.id.trim() : '';
	const name = typeof r.name === 'string' ? r.name.trim() : '';
	if (!id || !name) return null;

	const cards: BoardCard[] = [];
	const seenIds = new Set<string>();
	if (Array.isArray(r.cards)) {
		for (const entry of r.cards) {
			const card = validateBoardCard(entry, nowIso);
			if (!card || seenIds.has(card.id)) return null;
			seenIds.add(card.id);
			cards.push(card);
		}
	}

	const board: Board = { ...r, id, name, cards };
	if (
		typeof r.maxInProgress === 'number' &&
		Number.isFinite(r.maxInProgress) &&
		r.maxInProgress > 0
	) {
		board.maxInProgress = Math.floor(r.maxInProgress);
	}
	if (r.autoDecompose === true) {
		board.autoDecompose = true;
	}
	return board;
}

/** Explicit execution boundary for a global Board card. */
export type BoardExecutionScope =
	| { kind: 'agent'; agentId: string }
	| { kind: 'group'; groupId: string };

export type BoardStartMode = 'approval' | 'direct';
export type BoardCardKind = 'work' | 'review' | 'test' | 'documentation';

/** Namespaces prevent profiles with the same id in different imports from colliding. */
export interface BoardRoleRef {
	namespace: string;
	profileId: string;
}

/** Capture-time fields for the global Board; missing fields represent an incomplete draft. */
export interface BoardCaptureOptions {
	kind?: BoardCardKind;
	executionScope?: BoardExecutionScope;
	assigneeAgentId?: string;
	role?: BoardRoleRef;
	repositoryId?: string;
	workingDirectory?: string;
	startModeOverride?: BoardStartMode;
}

/** Current host catalog. Never accepts policy authority from transport payloads. */
export interface BoardCaptureCatalog {
	agents: { id: string; groupId?: string | null }[];
	groups: { id: string }[];
	profiles: { namespace: string; profile: import('../profiles/types').AgentProfile }[];
	repositories: {
		id: string;
		workingDirectory: string;
		validated: boolean;
		location?: { kind: 'local' } | { kind: 'ssh'; remoteId: string };
		diagnostic?: string;
	}[];
	defaultStartMode: BoardStartMode;
}
export interface BoardCaptureCommand {
	/** Request a host-resolved handoff; never an artifact supplied by a caller. */
	reviewSource?: { cardId: string; attempt: number };
	projectRoot: string;
	boardId: string;
	expectedRevision: number;
	card: BoardCard;
}
export type BoardCaptureResponse =
	| {
			ok: true;
			value: Board;
			readiness: Record<string, import('./domain').BoardReadinessReason[]>;
	  }
	| {
			ok: false;
			error: {
				code: string;
				message: string;
				captureErrors?: import('./domain').BoardCaptureError[];
				reason?: string;
			};
	  };

export interface BoardCapturePolicy {
	effectiveStartMode: BoardStartMode;
	specificationRevision: number;
	dispatchApproval: 'required' | 'granted' | 'not-required';
	/** Host-owned human grant, bound to the captured specification, never CRUD input. */
	grant?: { specificationRevision: number; principal: string; grantedAt: string };
}

/** Explicit central source management; transport callers never supply validation proof. */
export type BoardSourceCommand =
	| { action: 'revalidate'; sourceKey: string }
	| {
			action: 'save-role';
			sourceKey: string;
			namespace: string;
			profile: import('../profiles/types').AgentProfile;
	  }
	| { action: 'delete-role'; sourceKey: string; namespace: string; profileId: string };
export type BoardSourceResponse =
	| { ok: true }
	| { ok: false; error: { code: string; message: string } };

/** Compatibility command reference for a central source; never a filesystem path. */
export const BOARD_SOURCE_PROJECT_PREFIX = 'maestro-board-source:';
