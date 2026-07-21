/**
 * Board - shared contracts.
 *
 * A Board is a persistent task DAG stored per-project in `.maestro/board.yaml`
 * (human-diffable, git-trackable, mirroring the Cue `.maestro/cue.yaml`
 * convention). Each **card** is a unit of work assigned to an Agent Profile
 * (Phase 1) and gated on its parent cards: a card becomes eligible to run only
 * once every parent it lists is `done`. Phase 2 (this module) is the data
 * foundation only - no dispatcher (Phase 3) and no rich UI (Phase 4).
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
 *               resting state for a real task.
 * - `ready`   - derived/promoted: a `todo` card whose parents are all `done`,
 *               eligible for dispatch. Phase 3 computes this; authors do NOT
 *               hand-write it (see {@link getEligibleCards}).
 * - `running` - a dispatcher has spawned an agent for this card and it is in
 *               flight.
 * - `blocked` - a run finished without completing (agent reported a blocker) or
 *               a parent regressed; needs attention before it can retry.
 * - `done`    - completed successfully; unblocks children that depend on it.
 */
export type CardStatus = 'triage' | 'todo' | 'ready' | 'running' | 'blocked' | 'done';

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
 * likewise excluded from the breaker, and the card returns to `todo`.
 */
export type CardRunOutcome = 'done' | 'blocked' | 'error' | 'reclaimed' | 'canceled';

/** Every outcome a persisted run may carry (the runtime mirror of {@link CardRunOutcome}). */
export const CARD_RUN_OUTCOMES: readonly CardRunOutcome[] = [
	'done',
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
	/** Free-form dispatcher metadata (session id, tokens, etc.). */
	metadata?: Record<string, unknown>;
}

/**
 * A single task on the board.
 *
 * `parents` are card ids this card depends on; the card is eligible only when
 * every parent is `done` (see {@link getEligibleCards}).
 *
 * ── Assignee model (Board Phase 6: worker pool) ──────────────────────────────
 * A card resolves to a worker via two optional fields; at least one is required:
 *   - `assigneeProfileId` names an {@link AgentProfile} (a *role*: model/effort/
 *     role-prompt overrides). A role-only card (profile has no `baseAgentId`)
 *     floats to any FREE opt-in worker in the board's project directory.
 *   - `assigneeAgentId` pins the card to one specific Left Bar agent (its own
 *     native settings). Combined with a profile, that agent wears the role.
 * Resolution: `assigneeAgentId` (or a legacy profile's `baseAgentId`) pins a
 * single worker; otherwise the free project pool is used.
 */
export interface BoardCard {
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
	 * Dispatch priority. Absent means `normal`; the dispatcher claims `ready`
	 * cards by priority descending, then oldest-first within a priority.
	 */
	priority?: CardPriority;
	/** Worktree the card runs in, once dispatched. */
	worktree?: WorktreeRef;
	/** Per-attempt run history, most-recent last. */
	runs?: CardRun[];
	/** ISO timestamp the card was created. */
	createdAt: string;
	/** ISO timestamp the card was last modified. */
	updatedAt: string;
}

/**
 * A named board: an ordered collection of cards plus optional concurrency cap.
 */
export interface Board {
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
	const ref: WorktreeRef = { path: p };
	const branch = optionalString(r.branch);
	if (branch !== undefined) ref.branch = branch;
	return ref;
}

/** Validate a single run entry, dropping malformed fields. Returns null if unusable. */
function validateCardRun(raw: unknown): CardRun | null {
	if (!raw || typeof raw !== 'object') return null;
	const r = raw as Record<string, unknown>;
	const attempt = typeof r.attempt === 'number' && Number.isFinite(r.attempt) ? r.attempt : null;
	const startedAt = optionalString(r.startedAt);
	if (attempt === null || !startedAt) return null;
	const run: CardRun = { attempt, startedAt };
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
	if (r.metadata && typeof r.metadata === 'object' && !Array.isArray(r.metadata)) {
		run.metadata = r.metadata as Record<string, unknown>;
	}
	return run;
}

/**
 * Validate an untrusted object as a {@link BoardCard}. Returns a normalized card
 * on success, or `null` when the shape is malformed. Used by the YAML storage
 * layer to skip bad entries without throwing, and by IPC handlers before
 * persisting caller input.
 *
 * Rules: `id` and `title` must be non-empty strings, and the card must name an
 * assignee - at least one of `assigneeProfileId` (role) or `assigneeAgentId`
 * (pinned agent) must be a non-empty string. `status` must be a known
 * {@link CardStatus}. `parents` defaults to `[]` and keeps only non-empty string
 * ids. Missing `createdAt`/`updatedAt` fall back to {@link nowIso} when supplied.
 * Optional `worktree`/`runs` are validated structurally and dropped when malformed.
 */
export function validateBoardCard(raw: unknown, nowIso?: string): BoardCard | null {
	if (!raw || typeof raw !== 'object') return null;
	const r = raw as Record<string, unknown>;

	const id = typeof r.id === 'string' ? r.id.trim() : '';
	const title = typeof r.title === 'string' ? r.title.trim() : '';
	const assigneeProfileId =
		typeof r.assigneeProfileId === 'string' ? r.assigneeProfileId.trim() : '';
	const assigneeAgentId = typeof r.assigneeAgentId === 'string' ? r.assigneeAgentId.trim() : '';
	// A card must resolve to *someone*: a role (profile) or a pinned agent.
	if (!id || !title || (!assigneeProfileId && !assigneeAgentId)) return null;
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
		id,
		title,
		body,
		parents,
		status: r.status,
		createdAt,
		updatedAt,
	};
	if (assigneeProfileId) card.assigneeProfileId = assigneeProfileId;
	if (assigneeAgentId) card.assigneeAgentId = assigneeAgentId;

	// `normal` is the default and is deliberately dropped rather than stored, so
	// a card is only ever serialized with a priority when it is not the default.
	if (r.priority === 'high' || r.priority === 'low') card.priority = r.priority;

	const worktree = validateWorktreeRef(r.worktree);
	if (worktree) card.worktree = worktree;

	if (Array.isArray(r.runs)) {
		const runs = r.runs
			.map((run) => validateCardRun(run))
			.filter((run): run is CardRun => run !== null);
		if (runs.length > 0) card.runs = runs;
	}

	return card;
}

/**
 * Validate an untrusted object as a {@link Board}. Malformed cards are skipped
 * (defense in depth mirrors the profile storage layer). Returns `null` only
 * when the board envelope itself (`id`/`name`) is unusable.
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
			if (!card) continue;
			if (seenIds.has(card.id)) continue;
			seenIds.add(card.id);
			cards.push(card);
		}
	}

	const board: Board = { id, name, cards };
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
