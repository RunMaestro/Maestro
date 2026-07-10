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

import type { Board, BoardCard, CardRun, CardRunOutcome } from '../../shared/board/types';
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
}

/** A claimed card plus the resolved profile overrides used to spawn it. */
export interface CardSpawnRequest {
	card: BoardCard;
	overrides: ProfileSpawnOverrides;
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
	 */
	resolveOverrides: (card: BoardCard) => ProfileSpawnOverrides | null;
	/** Run the card's assignee to completion. Rejects on spawn failure. */
	spawn: (request: CardSpawnRequest) => Promise<CardSpawnResult>;
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
 * Claim the oldest `ready` cards up to the WIP cap, marking each `running` and
 * opening a fresh {@link CardRun}. Mutates the board in place and returns the
 * claimed cards. The cap is enforced across the whole board (already-`running`
 * cards count against it), so a board at capacity claims nothing.
 *
 * "Oldest" is by `createdAt` ascending, tie-broken by board order, so dispatch
 * is deterministic and stable across ticks.
 */
export function claimReadyCards(board: Board, maxInProgress: number, nowIso: string): BoardCard[] {
	const cap = maxInProgress > 0 ? maxInProgress : DEFAULT_MAX_IN_PROGRESS;
	const ready = board.cards
		.map((card, index) => ({ card, index }))
		.filter((entry) => entry.card.status === 'ready')
		.sort((a, b) => a.card.createdAt.localeCompare(b.card.createdAt) || a.index - b.index)
		.map((entry) => entry.card);

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
			run.outcome = 'error';
			run.summary = 'Reclaimed: running with no live process (engine restart).';
		}
		card.status = 'ready';
		card.updatedAt = nowIso;
		reclaimed.push(card);
	}
	return reclaimed;
}

/** Count trailing (most-recent-first) runs that did not succeed. */
function trailingFailureCount(card: BoardCard): number {
	const runs = card.runs ?? [];
	let count = 0;
	for (let i = runs.length - 1; i >= 0; i--) {
		if (runs[i].outcome === 'done') break;
		count++;
	}
	return count;
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

	/** True while a spawn for `cardId` is in flight (used by tests + reclaim). */
	isInFlight(cardId: string): boolean {
		return this.inFlight.has(cardId);
	}

	/**
	 * Resolve a completed (or failed) card run: reload the board fresh, apply the
	 * result, and persist. Reloading avoids clobbering concurrent card mutations
	 * that landed between the claim and this completion.
	 */
	private finalize(cardId: string, result: CardSpawnResult): void {
		this.inFlight.delete(cardId);
		const board = this.deps.loadBoard();
		if (!board) return;
		const status = applyCardResult(board, cardId, result, this.now(), this.maxFailures);
		if (status === null) return;
		this.deps.saveBoard(board);
		this.log('info', `card "${cardId}" -> ${status}`);
	}

	/**
	 * Force a claimed card straight to `blocked` (bypassing the retry breaker),
	 * closing its open run as an error. Used when the card can never run as-is -
	 * e.g. its assignee profile can't be resolved - so retrying is pointless.
	 */
	private blockCardImmediately(cardId: string, reason: string): void {
		this.inFlight.delete(cardId);
		const board = this.deps.loadBoard();
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
	}

	private log(level: 'info' | 'warn' | 'error', message: string): void {
		this.deps.onLog?.(level, `[Board] ${message}`);
	}
}
