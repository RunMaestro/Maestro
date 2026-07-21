/**
 * Board dispatcher - the orchestration that makes a Board actually run.
 *
 * This is the Phase 3 core. It is deliberately "pure-ish": all side effects
 * (loading/saving the board, resolving a profile, spawning an agent) are
 * injected as callbacks, so the promotion / WIP-cap / completion logic can be
 * unit-tested with a fake board and a fake spawner - no Electron, no
 * filesystem, no real process.
 *
 * One {@link BoardDispatcher} instance owns exactly one board (identified by the
 * `loadBoard`/`saveBoard` closures it is handed). The Cue engine constructs one
 * per board and calls {@link BoardDispatcher.tick} on each engine tick.
 *
 * Per tick the dispatcher:
 *   1. Reclaims stale `running` cards (a run that outlived its process because
 *      the engine restarted mid-flight) back to `ready`.
 *   2. Promotes `todo` cards whose parents are all `done` to `ready`
 *      (via the Phase 2 {@link getEligibleCards}).
 *   3. While running-count < `maxInProgress`, claims the oldest `ready` card,
 *      marks it `running`, opens a {@link CardRun}, and spawns its assignee.
 *   4. On spawn completion, parses the output for card markers and moves the
 *      card to `done` or `blocked` (marker wins; else the process exit status
 *      decides), recording the outcome on the open run. A card that fails
 *      `maxFailures` times in a row is force-blocked (the circuit breaker).
 *
 * The board is persisted synchronously after step 3, BEFORE any spawn resolves,
 * so a crash or the next tick sees the claimed cards as `running` and never
 * double-dispatches them.
 */

import {
	cardPriorityRank,
	type Board,
	type BoardCard,
	type CardRun,
	type CardRunOutcome,
} from '../../shared/board/types';
import { getEligibleCards } from '../../shared/board/graph';
import { parseCardMarkers } from '../../shared/board/cardMarkers';
import type { ProfileSpawnOverrides } from '../../shared/profiles/types';

/** Default WIP cap when a board does not set `maxInProgress`. */
export const DEFAULT_MAX_IN_PROGRESS = 2;

/** Consecutive failed runs before the circuit breaker force-blocks a card.
 * Mirrors Hermes' `failure_limit` default. */
export const DEFAULT_MAX_FAILURES = 2;

/** A `running` card whose open run started longer ago than this, and which has
 * no live process, is reclaimed to `ready` (engine restarted mid-run). */
export const DEFAULT_STALE_RUNNING_MS = 30 * 60 * 1000;

/** The result of running a card's assignee to completion. */
export interface CardSpawnResult {
	/** Combined agent output, scanned for `<!-- maestro:card-* -->` markers. */
	output: string;
	/** Process exit code; `null` when unknown (killed / spawn failure). */
	exitCode: number | null;
	/** Set when the spawn itself failed (never started / threw). Forces failure. */
	error?: string;
	/**
	 * Isolated worktree the run actually happened in (Board Phase 4). Stamped
	 * onto the attempt's {@link CardRun} so a finished card points at the branch
	 * holding its output. Absent when the card ran in the shared project root.
	 */
	worktreePath?: string;
	/** Branch checked out in {@link worktreePath}. */
	worktreeBranch?: string;
}

/** A claimed card plus the resolved profile overrides used to spawn it. */
export interface CardSpawnRequest {
	card: BoardCard;
	overrides: ProfileSpawnOverrides;
	/**
	 * Id of the pool worker chosen for this card (Board Phase 6). Set on the
	 * worker-pool path so the spawner runs the card on exactly this agent; absent
	 * on the legacy single-agent path (the spawner then resolves the pinned agent
	 * itself).
	 */
	agentId?: string;
}

/**
 * How a ready card resolves to a worker on the pool path (Board Phase 6). The
 * injected {@link BoardDispatcherDeps.assign} returns one of:
 *   - `assigned`       - claim the card on `agentId` with these `overrides`;
 *   - `no-free-worker` - candidates exist but are all busy (or the opt-in pool
 *                        is empty); leave the card `ready` and retry next tick;
 *   - `unresolvable`   - a config error (named profile/agent missing); block now.
 */
export type CardAssignment =
	| { kind: 'assigned'; agentId: string; overrides: ProfileSpawnOverrides }
	| { kind: 'no-free-worker' }
	| { kind: 'unresolvable'; reason?: string };

/**
 * A terminal card transition worth telling the user about. Deliberately
 * presentation-free (no colors, no toast options): the host decides how to
 * surface it, the dispatcher only says what happened.
 */
export interface CardNotification {
	/** `done` = the card completed; `blocked` = it needs a human. */
	kind: 'done' | 'blocked';
	cardId: string;
	/** Card title, for the notification heading. */
	cardTitle: string;
	/** Run summary (`done`) or block reason (`blocked`), when there is one. */
	detail?: string;
	/**
	 * Branch of the isolated worktree the finished attempt ran in (Board Phase 4),
	 * when the card used one. The host mentions it so the user can find the output:
	 * nothing merges or removes the branch automatically.
	 */
	worktreeBranch?: string;
}

/** Injected side effects. Fakes for these are all a test needs. */
export interface BoardDispatcherDeps {
	/** Load the current board snapshot (fresh each time). `null` => board gone. */
	loadBoard: () => Board | null;
	/** Persist a mutated board snapshot. */
	saveBoard: (board: Board) => void;
	/**
	 * Resolve a card's assignee profile into spawn overrides. Returns `null`
	 * when the profile can't be resolved (missing / deleted) - the dispatcher
	 * then blocks the card rather than spawning a mystery agent.
	 *
	 * Legacy single-agent path. Ignored when {@link assign} is provided.
	 */
	resolveOverrides: (card: BoardCard) => ProfileSpawnOverrides | null;
	/**
	 * Worker-pool assignment (Board Phase 6). When provided, the dispatcher
	 * resolves each ready card to a FREE worker from the project's opt-in pool
	 * instead of the single pinned agent, passing the set of workers already
	 * running a board card this tick. See {@link CardAssignment} for the return
	 * contract. When absent, the legacy {@link resolveOverrides} path is used.
	 */
	assign?: (card: BoardCard, busyAgentIds: ReadonlySet<string>) => CardAssignment;
	/** Run the card's assignee to completion. Rejects on spawn failure. */
	spawn: (request: CardSpawnRequest) => Promise<CardSpawnResult>;
	/**
	 * Abort the in-flight run for a card (kill the agent process). Returns `true`
	 * when a live run was found and stopped. Optional: without it,
	 * {@link BoardDispatcher.cancelCard} still finalizes the card as `canceled`,
	 * it just cannot kill anything - so wire it wherever a real process exists.
	 */
	cancelSpawn?: (cardId: string) => boolean;
	/**
	 * Announce a terminal card transition (`done` / `blocked`, including a
	 * circuit-breaker or unresolvable-assignee force-block). Optional: the CLI's
	 * headless tick wires nothing, the desktop host turns it into a toast.
	 */
	notify?: (event: CardNotification) => void;
	/** ISO clock, injectable so tests get stable timestamps. */
	now?: () => string;
	/** Epoch-ms clock for stale detection, injectable for tests. */
	nowMs?: () => number;
	/** Optional structured log sink. */
	onLog?: (level: 'info' | 'warn' | 'error', message: string) => void;
	/** Consecutive failures before force-block. Defaults to {@link DEFAULT_MAX_FAILURES}. */
	maxFailures?: number;
	/** Stale-running threshold in ms. Defaults to {@link DEFAULT_STALE_RUNNING_MS}. */
	staleRunningMs?: number;
}

// ─── Pure helpers (exported for direct unit testing) ─────────────────────────

/** Count cards currently `running` on a board. */
export function countRunning(board: Board): number {
	return board.cards.reduce((n, c) => (c.status === 'running' ? n + 1 : n), 0);
}

/**
 * Promote every eligible `todo` card (all parents `done`) to `ready`. Mutates
 * the board in place and returns the promoted cards. Uses the Phase 2
 * {@link getEligibleCards} so the eligibility rule lives in exactly one place.
 */
export function promoteEligibleCards(board: Board, nowIso: string): BoardCard[] {
	const promoted = getEligibleCards(board);
	for (const card of promoted) {
		card.status = 'ready';
		card.updatedAt = nowIso;
	}
	return promoted;
}

/**
 * Order `ready` cards for dispatch: priority descending, then oldest `createdAt`
 * first, then board order. Priority outranks age deliberately - a `high` card
 * added today should jump a `normal` backlog - while the age tie-break keeps
 * dispatch deterministic and stable across ticks within one priority.
 */
function readyCardsInDispatchOrder(board: Board): BoardCard[] {
	return board.cards
		.map((card, index) => ({ card, index }))
		.filter((entry) => entry.card.status === 'ready')
		.sort(
			(a, b) =>
				cardPriorityRank(b.card) - cardPriorityRank(a.card) ||
				a.card.createdAt.localeCompare(b.card.createdAt) ||
				a.index - b.index
		)
		.map((entry) => entry.card);
}

/**
 * Claim the highest-priority, oldest `ready` cards up to the WIP cap, marking
 * each `running` and opening a fresh {@link CardRun}. Mutates the board in place
 * and returns the claimed cards. The cap is enforced across the whole board
 * (already-`running` cards count against it), so a board at capacity claims
 * nothing. Order comes from {@link readyCardsInDispatchOrder}.
 */
export function claimReadyCards(board: Board, maxInProgress: number, nowIso: string): BoardCard[] {
	const cap = maxInProgress > 0 ? maxInProgress : DEFAULT_MAX_IN_PROGRESS;
	const ready = readyCardsInDispatchOrder(board);

	const claimed: BoardCard[] = [];
	for (const card of ready) {
		if (countRunning(board) >= cap) break;
		card.status = 'running';
		card.updatedAt = nowIso;
		const attempt = (card.runs?.length ?? 0) + 1;
		const run: CardRun = { attempt, startedAt: nowIso };
		card.runs = [...(card.runs ?? []), run];
		claimed.push(card);
	}
	return claimed;
}

/**
 * Compute the set of pool workers currently busy with a `running` board card,
 * keyed by the `workerAgentId` recorded on each running card's open run. This is
 * the "one card per worker" guard, recomputed from the persisted board each tick
 * so it survives engine restarts (no in-memory state needed).
 */
export function computeBusyAgentIds(board: Board): Set<string> {
	const busy = new Set<string>();
	for (const card of board.cards) {
		if (card.status !== 'running') continue;
		const run = card.runs?.[card.runs.length - 1];
		const workerId = run?.workerAgentId;
		if (workerId) busy.add(workerId);
	}
	return busy;
}

/** A card claimed on the pool path, bound to the worker chosen to run it. */
export interface PooledClaim {
	card: BoardCard;
	agentId: string;
	overrides: ProfileSpawnOverrides;
}

/** The outcome of one pooled claim pass over a board. */
export interface PooledClaimResult {
	/** Cards marked `running` on a free worker this pass, with their assignment. */
	claimed: PooledClaim[];
	/** Cards that named a missing profile/agent - the caller blocks these now. */
	unresolvable: { card: BoardCard; reason?: string }[];
}

/**
 * Worker-pool claim (Board Phase 6). Walks the `ready` cards in dispatch order
 * (priority descending, then oldest first) up to the WIP cap and asks `assign`
 * to bind each to a FREE worker. A card assigned a worker
 * is marked `running` with an open {@link CardRun} stamped with `workerAgentId`,
 * and that worker is taken out of circulation for the rest of this pass (one card
 * per worker). Cards whose workers are all busy (or whose pool is empty) are left
 * `ready` - they are NOT claimed and simply retry on a later tick (the "don't
 * wait for a free agent" rule). Unresolvable cards are collected for the caller
 * to force-block. Mutates the board in place.
 */
export function claimReadyCardsPooled(
	board: Board,
	maxInProgress: number,
	nowIso: string,
	assign: (card: BoardCard, busyAgentIds: ReadonlySet<string>) => CardAssignment
): PooledClaimResult {
	const cap = maxInProgress > 0 ? maxInProgress : DEFAULT_MAX_IN_PROGRESS;
	const ready = readyCardsInDispatchOrder(board);

	const busy = computeBusyAgentIds(board);
	const claimed: PooledClaim[] = [];
	const unresolvable: { card: BoardCard; reason?: string }[] = [];

	for (const card of ready) {
		if (countRunning(board) >= cap) break;
		const result = assign(card, busy);
		if (result.kind === 'unresolvable') {
			unresolvable.push({ card, reason: result.reason });
			continue;
		}
		if (result.kind === 'no-free-worker') {
			// Leave the card `ready`; a later tick retries when a worker frees up.
			continue;
		}
		card.status = 'running';
		card.updatedAt = nowIso;
		const attempt = (card.runs?.length ?? 0) + 1;
		const run: CardRun = { attempt, startedAt: nowIso, workerAgentId: result.agentId };
		card.runs = [...(card.runs ?? []), run];
		busy.add(result.agentId);
		claimed.push({ card, agentId: result.agentId, overrides: result.overrides });
	}

	return { claimed, unresolvable };
}

/**
 * Reclaim `running` cards whose open run started longer ago than `staleMs` and
 * which are not currently live (not in `liveCardIds`) back to `ready`. This
 * covers the engine-restarted-mid-run case: the process is gone but the card is
 * stuck `running` forever. The open run is closed as an `error`. Mutates in
 * place; returns the reclaimed cards.
 */
export function reclaimStaleRunning(
	board: Board,
	liveCardIds: ReadonlySet<string>,
	staleMs: number,
	nowMs: number,
	nowIso: string
): BoardCard[] {
	const reclaimed: BoardCard[] = [];
	for (const card of board.cards) {
		if (card.status !== 'running') continue;
		if (liveCardIds.has(card.id)) continue;
		const run = card.runs?.[card.runs.length - 1];
		const startedMs = run ? Date.parse(run.startedAt) : NaN;
		// Missing/unparseable start time is itself a sign of a stuck card; treat
		// as stale so it can be retried rather than wedged forever.
		if (Number.isFinite(startedMs) && nowMs - startedMs < staleMs) continue;
		if (run && !run.endedAt) {
			run.endedAt = nowIso;
			// `reclaimed`, NOT `error`: the host abandoned the attempt, the card did
			// not fail. Recording an error here made two engine restarts during one
			// long card trip the retry circuit breaker and force-block it.
			run.outcome = 'reclaimed';
			run.summary = 'Reclaimed: running with no live process (engine restart).';
		}
		card.status = 'ready';
		card.updatedAt = nowIso;
		reclaimed.push(card);
	}
	return reclaimed;
}

/**
 * Count trailing (most-recent-first) runs that the card is accountable for
 * failing. A `done` run resets the count. `reclaimed` and `canceled` runs are
 * skipped entirely rather than counted or treated as a reset: nobody ran the
 * work to a conclusion (the host restarted, or a user hit stop), so those
 * attempts say nothing about whether the card can succeed - but they also must
 * not paper over genuine failures on either side of them.
 */
function trailingFailureCount(card: BoardCard): number {
	const runs = card.runs ?? [];
	let count = 0;
	for (let i = runs.length - 1; i >= 0; i--) {
		if (runs[i].outcome === 'reclaimed' || runs[i].outcome === 'canceled') continue;
		if (runs[i].outcome === 'done') break;
		count++;
	}
	return count;
}

/**
 * Finalize a `running` card as user-canceled: close its open run with the
 * `canceled` outcome and send the card back to `todo` (from where the promote
 * pass re-derives `ready` once its parents are still done, so a cancel is a
 * pause, not a demotion). Mutates in place; returns `false` when the card is
 * missing or is not actually running.
 *
 * The `canceled` run is deliberately NOT a failure - see
 * {@link trailingFailureCount} - so stopping a card three times never trips the
 * circuit breaker.
 */
export function applyCardCancel(board: Board, cardId: string, nowIso: string): boolean {
	const card = board.cards.find((c) => c.id === cardId);
	if (!card || card.status !== 'running') return false;
	const run = card.runs?.[card.runs.length - 1];
	if (run && !run.endedAt) {
		run.endedAt = nowIso;
		run.outcome = 'canceled';
		run.summary = 'Canceled by user.';
	}
	card.status = 'todo';
	card.updatedAt = nowIso;
	return true;
}

/**
 * Apply a completed run's result to a card: finalize the open run, then set the
 * card's terminal status. Marker precedence, then exit-status fallback:
 *   - block marker            -> `blocked`
 *   - complete marker         -> `done`
 *   - no marker, exit 0       -> `done`
 *   - no marker, non-zero/err -> failed run; retry (`ready`) until the circuit
 *                                breaker (`maxFailures` in a row) forces `blocked`.
 * Mutates the board in place. Returns the card's new status.
 */
export function applyCardResult(
	board: Board,
	cardId: string,
	result: CardSpawnResult,
	nowIso: string,
	maxFailures: number
): BoardCard['status'] | null {
	const card = board.cards.find((c) => c.id === cardId);
	if (!card) return null;

	const run = card.runs?.[card.runs.length - 1];
	if (run && !run.endedAt) run.endedAt = nowIso;

	const markers = parseCardMarkers(result.output);
	const cleanExit = !result.error && result.exitCode === 0;

	let status: BoardCard['status'];
	let outcome: CardRunOutcome;
	let summary: string | undefined;

	if (markers.blocked) {
		// Explicit block marker: authoritative, never retried by the breaker.
		status = 'blocked';
		outcome = 'blocked';
		summary = markers.blockReason;
	} else if (markers.complete || cleanExit) {
		status = 'done';
		outcome = 'done';
		summary = markers.summary;
	} else {
		// Failed run with no completion signal. Record the outcome first so the
		// breaker below counts THIS failure, then decide retry vs. block.
		outcome = result.error || result.exitCode === null ? 'error' : 'blocked';
		summary = result.error;
		if (run) run.outcome = outcome;
		const failures = trailingFailureCount(card);
		status = failures >= maxFailures ? 'blocked' : 'ready';
	}

	if (run) {
		run.outcome = outcome;
		if (summary !== undefined) run.summary = summary;
		// Where the work landed (Phase 4). Recorded on every outcome, including a
		// failure: the branch still exists and the user may want to inspect it.
		if (result.worktreePath) run.worktreePath = result.worktreePath;
		if (result.worktreeBranch) run.worktreeBranch = result.worktreeBranch;
	}
	card.status = status;
	card.updatedAt = nowIso;
	return status;
}

// ─── Orchestrator ────────────────────────────────────────────────────────────

export class BoardDispatcher {
	private readonly deps: BoardDispatcherDeps;
	/** Card ids this dispatcher has an in-flight spawn for. Guards the stale
	 * reclaim from clobbering a genuinely live run. */
	private readonly inFlight = new Set<string>();
	/** Cards canceled while in flight. Killing the process makes the spawn promise
	 * resolve with a non-zero/`null` exit moments later; without this tombstone
	 * that resolution would re-finalize the card as a FAILED run and undo the
	 * cancel. Consumed by the first `finalize` that follows. */
	private readonly canceled = new Set<string>();
	private readonly now: () => string;
	private readonly nowMs: () => number;
	private readonly maxFailures: number;
	private readonly staleRunningMs: number;

	constructor(deps: BoardDispatcherDeps) {
		this.deps = deps;
		this.now = deps.now ?? (() => new Date().toISOString());
		this.nowMs = deps.nowMs ?? (() => Date.now());
		this.maxFailures = deps.maxFailures ?? DEFAULT_MAX_FAILURES;
		this.staleRunningMs = deps.staleRunningMs ?? DEFAULT_STALE_RUNNING_MS;
	}

	/**
	 * Run one dispatch pass: reclaim → promote → claim → persist → spawn. The
	 * board is persisted synchronously before any spawn resolves so re-entrant
	 * ticks observe the claimed cards as `running` and don't double-dispatch.
	 */
	tick(): void {
		const board = this.deps.loadBoard();
		if (!board) return;

		let dirty = false;
		const nowIso = this.now();

		const reclaimed = reclaimStaleRunning(
			board,
			this.inFlight,
			this.staleRunningMs,
			this.nowMs(),
			nowIso
		);
		if (reclaimed.length > 0) {
			dirty = true;
			this.log('warn', `reclaimed ${reclaimed.length} stale running card(s)`);
		}

		if (promoteEligibleCards(board, nowIso).length > 0) dirty = true;

		const cap = board.maxInProgress ?? DEFAULT_MAX_IN_PROGRESS;

		// Board Phase 6: when the worker-pool `assign` dep is wired, resolve each
		// ready card to a free worker; otherwise fall back to the legacy
		// single-agent claim + resolveOverrides path.
		if (this.deps.assign) {
			this.tickPooled(board, cap, nowIso, dirty);
		} else {
			this.tickLegacy(board, cap, nowIso, dirty);
		}
	}

	/** Legacy single-agent dispatch (pre-Phase-6). One pinned agent per card. */
	private tickLegacy(board: Board, cap: number, nowIso: string, dirtyIn: boolean): void {
		let dirty = dirtyIn;
		const claims = claimReadyCards(board, cap, nowIso);
		if (claims.length > 0) dirty = true;

		// Persist BEFORE spawning so a crash / next tick sees `running`.
		if (dirty) this.deps.saveBoard(board);

		for (const card of claims) {
			const overrides = this.deps.resolveOverrides(card);
			if (!overrides) {
				// A permanently-missing profile is not a transient spawn failure, so
				// it bypasses the retry circuit breaker and blocks immediately.
				this.log('error', `card "${card.id}" has an unresolvable profile - blocking`);
				this.blockCardImmediately(
					card.id,
					`Assignee profile "${card.assigneeProfileId}" could not be resolved.`
				);
				continue;
			}
			this.inFlight.add(card.id);
			this.deps
				.spawn({ card, overrides })
				.then((result) => this.finalize(card.id, result))
				.catch((err) =>
					this.finalize(card.id, {
						output: '',
						exitCode: null,
						error: err instanceof Error ? err.message : String(err),
					})
				);
		}
	}

	/** Worker-pool dispatch (Board Phase 6). Each card runs on a free pool worker. */
	private tickPooled(board: Board, cap: number, nowIso: string, dirtyIn: boolean): void {
		let dirty = dirtyIn;
		const { claimed, unresolvable } = claimReadyCardsPooled(board, cap, nowIso, this.deps.assign!);
		if (claimed.length > 0) dirty = true;

		// Force-block cards that named a missing profile/agent (config error, not a
		// transient failure) in place, so they persist with the rest of this pass.
		for (const { card, reason } of unresolvable) {
			this.forceBlock(
				board,
				card.id,
				reason ?? `Assignee for card "${card.id}" could not be resolved.`,
				nowIso
			);
			dirty = true;
			this.log('error', `card "${card.id}" has an unresolvable assignee - blocking`);
		}

		// Persist BEFORE spawning so a crash / next tick sees `running`.
		if (dirty) this.deps.saveBoard(board);

		// Announce the force-blocks only once they are on disk, so a user acting on
		// the toast never sees a board that disagrees with it.
		for (const { card, reason } of unresolvable) {
			this.emitNotification({
				kind: 'blocked',
				cardId: card.id,
				cardTitle: card.title,
				detail: reason ?? `Assignee for card "${card.id}" could not be resolved.`,
			});
		}

		for (const { card, agentId, overrides } of claimed) {
			this.inFlight.add(card.id);
			this.deps
				.spawn({ card, overrides, agentId })
				.then((result) => this.finalize(card.id, result))
				.catch((err) =>
					this.finalize(card.id, {
						output: '',
						exitCode: null,
						error: err instanceof Error ? err.message : String(err),
					})
				);
		}
	}

	/**
	 * Force a card straight to `blocked` on the given (already-loaded) board,
	 * closing any open run as an error. In-place variant of
	 * {@link blockCardImmediately} used by the pooled pass, which blocks several
	 * cards on one board before a single save.
	 */
	private forceBlock(board: Board, cardId: string, reason: string, nowIso: string): void {
		const card = board.cards.find((c) => c.id === cardId);
		if (!card) return;
		const run = card.runs?.[card.runs.length - 1];
		if (run && !run.endedAt) {
			run.endedAt = nowIso;
			run.outcome = 'error';
			run.summary = reason;
		}
		card.status = 'blocked';
		card.updatedAt = nowIso;
	}

	/** True while a spawn for `cardId` is in flight (used by tests + reclaim). */
	isInFlight(cardId: string): boolean {
		return this.inFlight.has(cardId);
	}

	/**
	 * Cancel a `running` card: kill its agent process (when a `cancelSpawn` dep is
	 * wired) and finalize the card as `canceled`, back in `todo`.
	 *
	 * Order matters. The card is tombstoned BEFORE the kill so the spawn promise -
	 * which resolves within milliseconds of the process dying, with a `null` exit
	 * code that otherwise reads as a failed run - is discarded by `finalize`
	 * instead of overwriting the cancel and counting against the circuit breaker.
	 *
	 * Returns `false` (and writes nothing) when the card is missing, is not
	 * running, or the board cannot be read.
	 */
	cancelCard(cardId: string): boolean {
		const board = this.loadBoardOrSkip('cancelCard');
		if (!board) return false;
		const nowIso = this.now();
		if (!applyCardCancel(board, cardId, nowIso)) return false;

		this.canceled.add(cardId);
		this.inFlight.delete(cardId);
		try {
			this.deps.cancelSpawn?.(cardId);
		} catch (err) {
			// A kill that throws must not leave the card wedged `running` - the board
			// mutation below still lands and the stale-reclaim pass is the backstop.
			this.log('warn', `card "${cardId}" cancel: kill failed - ${(err as Error).message}`);
		}
		this.deps.saveBoard(board);
		this.log('info', `card "${cardId}" -> canceled`);
		return true;
	}

	/**
	 * Resolve a completed (or failed) card run: reload the board fresh, apply the
	 * result, and persist. Reloading avoids clobbering concurrent card mutations
	 * that landed between the claim and this completion.
	 */
	private finalize(cardId: string, result: CardSpawnResult): void {
		this.inFlight.delete(cardId);
		// A canceled card was already finalized by `cancelCard`; this resolution is
		// just the killed process reporting in. Drop it (once).
		if (this.canceled.delete(cardId)) {
			this.log('info', `card "${cardId}" run resolved after cancel - ignoring result`);
			return;
		}
		const board = this.loadBoardOrSkip('finalize');
		if (!board) return;
		const status = applyCardResult(board, cardId, result, this.now(), this.maxFailures);
		if (status === null) return;
		this.deps.saveBoard(board);
		this.log('info', `card "${cardId}" -> ${status}`);
		if (status === 'done' || status === 'blocked') {
			// The run summary the marker/exit path just recorded is the useful half of
			// the message: what got done, or why the card is stuck.
			const card = board.cards.find((c) => c.id === cardId);
			const lastRun = card?.runs?.[card.runs.length - 1];
			this.emitNotification({
				kind: status,
				cardId,
				cardTitle: card?.title ?? cardId,
				detail: lastRun?.summary,
				...(lastRun?.worktreeBranch ? { worktreeBranch: lastRun.worktreeBranch } : {}),
			});
		}
	}

	/**
	 * Force a claimed card straight to `blocked` (bypassing the retry breaker),
	 * closing its open run as an error. Used when the card can never run as-is -
	 * e.g. its assignee profile can't be resolved - so retrying is pointless.
	 */
	private blockCardImmediately(cardId: string, reason: string): void {
		this.inFlight.delete(cardId);
		const board = this.loadBoardOrSkip('blockCardImmediately');
		if (!board) return;
		const card = board.cards.find((c) => c.id === cardId);
		if (!card) return;
		const run = card.runs?.[card.runs.length - 1];
		if (run && !run.endedAt) {
			run.endedAt = this.now();
			run.outcome = 'error';
			run.summary = reason;
		}
		card.status = 'blocked';
		card.updatedAt = this.now();
		this.deps.saveBoard(board);
		this.log('info', `card "${cardId}" -> blocked (${reason})`);
		this.emitNotification({ kind: 'blocked', cardId, cardTitle: card.title, detail: reason });
	}

	/**
	 * Hand a terminal transition to the host. Advisory: a notifier that throws
	 * must never break the dispatch pass that already persisted the change.
	 */
	private emitNotification(event: CardNotification): void {
		try {
			this.deps.notify?.(event);
		} catch (err) {
			this.log('warn', `notify failed for card "${event.cardId}": ${(err as Error).message}`);
		}
	}

	/**
	 * Load the board for a completion callback, swallowing a load failure into a
	 * logged skip. `finalize` and `blockCardImmediately` run from resolved spawn
	 * promises, so letting a `BoardStorageError` escape would surface as an
	 * unhandled rejection instead of anything actionable. Skipping is the
	 * fail-closed outcome we want either way: nothing is written over the damaged
	 * file, and the card is left `running` for the stale-reclaim pass to recover
	 * once the file is fixed. `tick()` still propagates, so the caller (the Cue
	 * engine, or the CLI) can surface the failure to the user.
	 */
	private loadBoardOrSkip(context: string): Board | null {
		try {
			return this.deps.loadBoard();
		} catch (err) {
			this.log('error', `${context}: cannot read board - ${(err as Error).message}`);
			return null;
		}
	}

	private log(level: 'info' | 'warn' | 'error', message: string): void {
		this.deps.onLog?.(level, `[Board] ${message}`);
	}
}
