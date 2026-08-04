/**
 * Board per-card "open PR when done" (Board F3).
 *
 * A card that opted into worktree isolation ({@link BoardCard.worktree}) runs on
 * its own branch, and nothing merges that branch automatically. `prOnDone` turns
 * the last step into a pull request: when the card lands in `done` with a branch
 * recorded on its latest run, this module pushes the branch and opens the PR
 * through the shared {@link createPullRequest} helper - the same gh-CLI plumbing
 * the `git:createPR` IPC handler uses.
 *
 * There are exactly TWO transitions into `done` and both route through
 * {@link maybeCreateCardPr}: the dispatcher's `finalize` (the run completed on
 * its own) and the manual `board:setCardStatus` approval move (a human moved a
 * `review` card to Done). The gate is re-evaluated here against a freshly loaded
 * board, so a caller that fires it speculatively costs nothing.
 *
 * A PR failure NEVER changes the card's status - the work is done either way,
 * only the pull request is missing. The failure is warn-logged and red-toasted so
 * the user can open the PR by hand.
 */

import type { Board, BoardCard, CardRun } from '../../shared/board/types';
import { createPullRequest } from '../utils/pr-creator';
import { listBoards, saveBoard, enqueueBoardWrite } from './board-storage';
import { buildCardPrToastPayload, type BoardCardToastPayload } from './board-toast';

/** Everything needed to open one card's pull request. */
export interface CardPrRequest {
	boardId: string;
	cardId: string;
	cardTitle: string;
	/** Worktree checkout the branch is pushed from. */
	worktreePath: string;
	/** Branch the PR is opened for. */
	worktreeBranch: string;
	/** Explicit base branch from the card. Absent => the repo default branch. */
	targetBranch?: string;
	/** PR title. */
	title: string;
	/** PR body. */
	body: string;
}

/** Outcome of one PR attempt. Mirrors the {@link createPullRequest} result. */
export interface CardPrResult {
	success: boolean;
	prUrl?: string;
	/** Branch the PR was opened against, once resolved. */
	targetBranch?: string;
	error?: string;
}

/** Injected side effects, so the flow is unit-testable without git or gh. */
export interface CardPrFlowDeps {
	/** Load the current board snapshot (fresh, like the dispatcher's dep). */
	loadBoard: () => Board | null;
	/**
	 * Record a created PR's url on the card's latest run. Given as one closure
	 * rather than a load/save pair so the host can do the read-modify-write inside
	 * its own write queue: the PR call takes seconds, and a tick may well have
	 * written the board in the meantime. {@link stampCardPrUrl} is the mutation to
	 * apply inside it.
	 */
	stampPrUrl?: (cardId: string, prUrl: string) => void | Promise<void>;
	/**
	 * Main repository checkout, used only to resolve the default branch when the
	 * card names no `targetBranch`. Absent => the worktree itself is used.
	 */
	mainRepoCwd?: string;
	/** PR creation. Defaults to the gh-CLI helper; stubbed in tests. */
	createPr?: (request: CardPrRequest) => Promise<CardPrResult>;
	/** Toast sink (the host relays it over `remote:notifyToast`). */
	notify?: (payload: BoardCardToastPayload) => void;
	/** Structured log sink. */
	onLog?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

/** Latest run of a card, or `undefined` when it never ran. */
function latestRun(card: BoardCard): CardRun | undefined {
	return card.runs?.[card.runs.length - 1];
}

/**
 * Build the PR body from the card's own task text plus the run summary, which is
 * where the four handoff questions (what changed, how it was verified, what it
 * unblocks, residual risk) land via the `card-complete | summary` marker.
 */
function buildCardPrBody(card: BoardCard, run: CardRun): string {
	const lines: string[] = [];
	const body = card.body.trim();
	if (body.length > 0) {
		lines.push('## Task', body, '');
	}
	lines.push('## Handoff', run.summary?.trim() || '_The run reported no summary._', '');
	lines.push(
		`Board card \`${card.id}\`, attempt ${run.attempt}, branch \`${run.worktreeBranch}\`.`,
		'',
		'Opened automatically by Maestro Board ("open PR when done").'
	);
	return lines.join('\n');
}

/**
 * Decide whether a card should get a pull request right now, and build the
 * request when it should. Returns `null` (no PR) when any of these hold:
 *   - the card is missing, or is not `done`;
 *   - it never opted in (`prOnDone` absent);
 *   - its latest run recorded no worktree branch (the card ran in the shared
 *     project root, so there is no isolated branch to open a PR for);
 *   - a PR was already opened for that run (`run.prUrl` set) - this is what
 *     makes a re-fire, or a done -> todo -> done round trip, idempotent.
 */
export function resolveCardPrRequest(board: Board, cardId: string): CardPrRequest | null {
	const card = board.cards.find((c) => c.id === cardId);
	if (!card || card.status !== 'done' || !card.prOnDone) return null;

	const run = latestRun(card);
	if (!run || !run.worktreeBranch || run.prUrl) return null;

	// The push has to happen from a real checkout of that branch. The run records
	// it for isolated cards; the card's own `worktree` ref is the fallback for a
	// board written by hand.
	const worktreePath = run.worktreePath || card.worktree?.path;
	if (!worktreePath) return null;

	return {
		boardId: board.id,
		cardId: card.id,
		cardTitle: card.title,
		worktreePath,
		worktreeBranch: run.worktreeBranch,
		...(card.prOnDone.targetBranch ? { targetBranch: card.prOnDone.targetBranch } : {}),
		title: card.title,
		body: buildCardPrBody(card, run),
	};
}

/**
 * Stamp a created PR's url onto the card's latest run, in place. Returns `false`
 * when the card or run vanished between the request and the result (the board is
 * reloaded in between, so this is a real case, not a paranoid one).
 */
export function stampCardPrUrl(
	board: Board,
	cardId: string,
	prUrl: string,
	nowIso: string
): boolean {
	const card = board.cards.find((c) => c.id === cardId);
	const run = card ? latestRun(card) : undefined;
	if (!card || !run) return false;
	run.prUrl = prUrl;
	card.updatedAt = nowIso;
	return true;
}

/** The default creator: the shared gh-CLI helper. */
function defaultCreatePr(
	request: CardPrRequest,
	mainRepoCwd: string | undefined,
	onLog: CardPrFlowDeps['onLog']
): Promise<CardPrResult> {
	return createPullRequest({
		worktreePath: request.worktreePath,
		...(mainRepoCwd ? { mainRepoCwd } : {}),
		...(request.targetBranch ? { targetBranch: request.targetBranch } : {}),
		title: request.title,
		body: request.body,
		// X1: board worktrees carry no `node_modules`, so the repo's pre-push hook
		// fails every card's push. This is unattended plumbing, not a human push.
		skipHooks: true,
		log: (message) => onLog?.('info', message),
		warn: (message) => onLog?.('warn', message),
	});
}

/**
 * Open the pull request for a card that just landed in `done`, when it asked for
 * one. Safe to call on EVERY transition into `done`: the gate above decides.
 *
 * Never throws and never changes the card's status - the worst case is a red
 * sticky toast telling the user the PR could not be opened. Returns the result
 * when a PR was attempted, `null` when the gate declined.
 */
export async function maybeCreateCardPr(
	cardId: string,
	deps: CardPrFlowDeps
): Promise<CardPrResult | null> {
	let request: CardPrRequest | null = null;
	try {
		const board = deps.loadBoard();
		if (!board) return null;
		request = resolveCardPrRequest(board, cardId);
	} catch (err) {
		deps.onLog?.('warn', `card "${cardId}" PR: cannot read board - ${(err as Error).message}`);
		return null;
	}
	if (!request) return null;

	let result: CardPrResult;
	try {
		result = deps.createPr
			? await deps.createPr(request)
			: await defaultCreatePr(request, deps.mainRepoCwd, deps.onLog);
	} catch (err) {
		result = { success: false, error: err instanceof Error ? err.message : String(err) };
	}

	if (result.success && result.prUrl) {
		try {
			await deps.stampPrUrl?.(cardId, result.prUrl);
		} catch (err) {
			deps.onLog?.(
				'warn',
				`card "${cardId}" PR opened at ${result.prUrl} but could not be recorded on the board - ${(err as Error).message}`
			);
		}
		deps.onLog?.('info', `card "${cardId}" -> PR ${result.prUrl}`);
	} else {
		deps.onLog?.('warn', `card "${cardId}" PR failed: ${result.error ?? 'unknown error'}`);
	}

	notifySafely(deps, buildCardPrToastPayload(request, result));
	return result;
}

/**
 * Cards with a PR attempt in flight. `run.prUrl` makes a SEQUENCE of attempts
 * idempotent, but it is only written once gh answers - so two overlapping
 * transitions into `done` (the dispatcher finalizing while a human drags the card)
 * would both pass the gate and open two PRs. This closes that window.
 */
const cardPrInFlight = new Set<string>();

/** Host wiring for {@link startCardPr}. */
export interface StartCardPrOptions {
	/** Toast sink (the host relays it over `remote:notifyToast`). */
	notify?: (payload: BoardCardToastPayload) => void;
	/** Structured log sink. */
	onLog?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

/**
 * Fire-and-forget entry point used by BOTH transitions into `done` (the
 * dispatcher's `finalize` and the manual `board:setCardStatus` approval move).
 * Binds the flow to the project's board storage - reads are direct, the PR-url
 * stamp goes through the same write queue every other board mutation uses - and
 * returns immediately. Any failure is contained inside {@link maybeCreateCardPr}.
 */
export function startCardPr(
	projectRoot: string,
	boardId: string,
	cardId: string,
	options: StartCardPrOptions = {}
): void {
	const key = `${projectRoot}::${boardId}::${cardId}`;
	if (cardPrInFlight.has(key)) return;
	cardPrInFlight.add(key);
	void maybeCreateCardPr(cardId, {
		loadBoard: () => listBoards(projectRoot).find((b) => b.id === boardId) ?? null,
		stampPrUrl: (id, prUrl) =>
			enqueueBoardWrite(projectRoot, () => {
				const board = listBoards(projectRoot).find((b) => b.id === boardId);
				if (board && stampCardPrUrl(board, id, prUrl, new Date().toISOString())) {
					saveBoard(projectRoot, board);
				}
			}),
		mainRepoCwd: projectRoot,
		...options,
	}).finally(() => cardPrInFlight.delete(key));
}

/** A toast sink that throws must never break the flow that already succeeded. */
function notifySafely(deps: CardPrFlowDeps, payload: BoardCardToastPayload): void {
	try {
		deps.notify?.(payload);
	} catch (err) {
		deps.onLog?.('warn', `PR toast failed: ${(err as Error).message}`);
	}
}
