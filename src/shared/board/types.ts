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
export type CardStatus =
	| 'triage'
	| 'todo'
	| 'ready'
	| 'running'
	| 'blocked'
	| 'done';

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

/** The terminal outcome a dispatcher records for one attempt at a card. */
export type CardRunOutcome = 'done' | 'blocked' | 'error';

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
	/** Free-form dispatcher metadata (session id, tokens, etc.). */
	metadata?: Record<string, unknown>;
}

/**
 * A single task on the board.
 *
 * `parents` are card ids this card depends on; the card is eligible only when
 * every parent is `done` (see {@link getEligibleCards}). `assigneeProfileId`
 * references an {@link AgentProfile} from `.maestro/profiles.yaml`.
 */
export interface BoardCard {
	/** Stable unique id (UUID). */
	id: string;
	/** Human-facing title shown on the card. */
	title: string;
	/** Task body / instructions handed to the assignee agent. */
	body: string;
	/** Id of the Agent Profile that runs this card. */
	assigneeProfileId: string;
	/** Ids of cards that must be `done` before this one is eligible. */
	parents: string[];
	/** Lifecycle status. */
	status: CardStatus;
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
	if (r.outcome === 'done' || r.outcome === 'blocked' || r.outcome === 'error') {
		run.outcome = r.outcome;
	}
	const summary = optionalString(r.summary);
	if (summary !== undefined) run.summary = summary;
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
 * Rules: `id`, `title`, `assigneeProfileId` must be non-empty strings; `status`
 * must be a known {@link CardStatus}. `parents` defaults to `[]` and keeps only
 * non-empty string ids. Missing `createdAt`/`updatedAt` fall back to
 * {@link nowIso} when supplied. Optional `worktree`/`runs` are validated
 * structurally and dropped when malformed.
 */
export function validateBoardCard(raw: unknown, nowIso?: string): BoardCard | null {
	if (!raw || typeof raw !== 'object') return null;
	const r = raw as Record<string, unknown>;

	const id = typeof r.id === 'string' ? r.id.trim() : '';
	const title = typeof r.title === 'string' ? r.title.trim() : '';
	const assigneeProfileId = typeof r.assigneeProfileId === 'string' ? r.assigneeProfileId.trim() : '';
	if (!id || !title || !assigneeProfileId) return null;
	if (!isCardStatus(r.status)) return null;

	const parents = Array.isArray(r.parents)
		? r.parents.filter((p): p is string => typeof p === 'string' && p.trim().length > 0).map((p) => p.trim())
		: [];

	const body = typeof r.body === 'string' ? r.body : '';
	const createdAt = optionalString(r.createdAt) ?? nowIso ?? '';
	const updatedAt = optionalString(r.updatedAt) ?? createdAt;

	const card: BoardCard = {
		id,
		title,
		body,
		assigneeProfileId,
		parents,
		status: r.status,
		createdAt,
		updatedAt,
	};

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
	return board;
}
