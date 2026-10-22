/**
 * @file board-pr.test.ts
 * @description Tests for the Board's per-card "open PR when done" flow (F3).
 * `board-storage` and the gh-CLI helper are mocked, so these are about the GATE
 * and the flow's failure containment, not about git:
 *   - `resolveCardPrRequest` opens a PR only for a `done` card that opted in and
 *     has a branch on its latest run, and never twice for the same run;
 *   - a PR failure is toasted but never touches the card;
 *   - `startCardPr` collapses two overlapping transitions into one PR.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const listBoards = vi.fn();
const saveBoard = vi.fn();
const enqueueBoardWrite = vi.fn(async (_root: string, fn: () => void) => fn());
const createPullRequest = vi.fn();

vi.mock('../../../main/board/board-storage', () => ({
	listBoards: (...args: unknown[]) => listBoards(...args),
	saveBoard: (...args: unknown[]) => saveBoard(...args),
	enqueueBoardWrite: (...args: unknown[]) => enqueueBoardWrite(...(args as [string, () => void])),
}));
vi.mock('../../../main/utils/pr-creator', () => ({
	createPullRequest: (...args: unknown[]) => createPullRequest(...args),
}));

import {
	resolveCardPrRequest,
	stampCardPrUrl,
	stampCardPrError,
	maybeCreateCardPr,
	startCardPr,
	type CardPrResult,
} from '../../../main/board/board-pr';
import type { Board, BoardCard, CardRun } from '../../../shared/board/types';

const NOW = '2026-07-28T00:00:00.000Z';
const PROJECT_ROOT = '/repos/project';
const WORKTREE_PATH = '/repos/worktrees/board/b1/c1';
const BRANCH = 'board/b1/c1';

function run(overrides: Partial<CardRun> = {}): CardRun {
	return {
		attempt: 1,
		startedAt: NOW,
		endedAt: NOW,
		outcome: 'done',
		summary: 'shipped it',
		worktreePath: WORKTREE_PATH,
		worktreeBranch: BRANCH,
		...overrides,
	};
}

function card(overrides: Partial<BoardCard> = {}): BoardCard {
	return {
		id: 'c1',
		title: 'Ship the thing',
		body: 'do the thing',
		assigneeProfileId: 'p1',
		parents: [],
		status: 'done',
		createdAt: NOW,
		updatedAt: NOW,
		prOnDone: {},
		runs: [run()],
		...overrides,
	};
}

function board(cards: BoardCard[] = [card()]): Board {
	return { id: 'b1', name: 'Test board', cards };
}

beforeEach(() => {
	vi.clearAllMocks();
	enqueueBoardWrite.mockImplementation(async (_root: string, fn: () => void) => fn());
});

describe('resolveCardPrRequest', () => {
	it('builds the request for a done, opted-in card with a branch', () => {
		const request = resolveCardPrRequest(board([card({ prOnDone: { targetBranch: 'rc' } })]), 'c1');
		expect(request).toMatchObject({
			boardId: 'b1',
			cardId: 'c1',
			cardTitle: 'Ship the thing',
			worktreePath: WORKTREE_PATH,
			worktreeBranch: BRANCH,
			targetBranch: 'rc',
			title: 'Ship the thing',
		});
		// The body carries the task text and the run summary (where the handoff
		// answers land), so a reviewer reads the PR instead of the board.
		expect(request?.body).toContain('do the thing');
		expect(request?.body).toContain('shipped it');
		expect(request?.body).toContain(BRANCH);
	});

	it('omits targetBranch when the card named none (resolve the repo default)', () => {
		expect(resolveCardPrRequest(board(), 'c1')?.targetBranch).toBeUndefined();
	});

	it('declines a card that never opted in', () => {
		expect(resolveCardPrRequest(board([card({ prOnDone: undefined })]), 'c1')).toBeNull();
	});

	it('declines a card that is not done', () => {
		for (const status of ['review', 'running', 'blocked', 'todo'] as const) {
			expect(resolveCardPrRequest(board([card({ status })]), 'c1')).toBeNull();
		}
	});

	it('declines a card whose latest run recorded no branch', () => {
		const noBranch = card({ runs: [run({ worktreeBranch: undefined })] });
		expect(resolveCardPrRequest(board([noBranch]), 'c1')).toBeNull();
	});

	it('declines a card that never ran', () => {
		expect(resolveCardPrRequest(board([card({ runs: undefined })]), 'c1')).toBeNull();
	});

	it('declines a run that already has a PR (idempotent across re-fires)', () => {
		const already = card({ runs: [run({ prUrl: 'https://github.com/o/r/pull/1' })] });
		expect(resolveCardPrRequest(board([already]), 'c1')).toBeNull();
	});

	it('still opens a PR for a run whose earlier attempt only recorded an error', () => {
		// A failed attempt must stay retryable: only a real `prUrl` closes the gate.
		const failed = card({ runs: [run({ prError: 'Failed to push branch: boom' })] });
		expect(resolveCardPrRequest(board([failed]), 'c1')).toMatchObject({ cardId: 'c1' });
	});

	it('falls back to the card worktree path when the run recorded none', () => {
		const handWritten = card({
			runs: [run({ worktreePath: undefined })],
			worktree: { enabled: true, path: '/elsewhere/checkout' },
		});
		expect(resolveCardPrRequest(board([handWritten]), 'c1')?.worktreePath).toBe(
			'/elsewhere/checkout'
		);
	});

	it('declines when no checkout path is known at all', () => {
		expect(
			resolveCardPrRequest(board([card({ runs: [run({ worktreePath: undefined })] })]), 'c1')
		).toBeNull();
	});

	it('declines a card that is not on the board', () => {
		expect(resolveCardPrRequest(board(), 'nope')).toBeNull();
	});

	it('only considers the LATEST run', () => {
		// An earlier isolated attempt does not entitle a later shared-root run to
		// a pull request.
		const b = board([card({ runs: [run(), run({ attempt: 2, worktreeBranch: undefined })] })]);
		expect(resolveCardPrRequest(b, 'c1')).toBeNull();
	});
});

describe('stampCardPrUrl', () => {
	it('records the url on the latest run and touches updatedAt', () => {
		const b = board();
		expect(
			stampCardPrUrl(b, 'c1', 'https://github.com/o/r/pull/7', '2026-07-29T00:00:00.000Z')
		).toBe(true);
		expect(b.cards[0].runs?.[0].prUrl).toBe('https://github.com/o/r/pull/7');
		expect(b.cards[0].updatedAt).toBe('2026-07-29T00:00:00.000Z');
	});

	it('reports false when the card or run vanished in the meantime', () => {
		expect(stampCardPrUrl(board(), 'gone', 'url', NOW)).toBe(false);
		expect(stampCardPrUrl(board([card({ runs: [] })]), 'c1', 'url', NOW)).toBe(false);
	});

	it('clears a stale error from an earlier failed attempt', () => {
		const b = board([card({ runs: [run({ prError: 'Failed to push branch: boom' })] })]);
		expect(stampCardPrUrl(b, 'c1', 'https://github.com/o/r/pull/7', NOW)).toBe(true);
		expect(b.cards[0].runs?.[0].prError).toBeUndefined();
	});
});

describe('stampCardPrError', () => {
	it('records the reason on the latest run and touches updatedAt', () => {
		const b = board();
		expect(stampCardPrError(b, 'c1', 'gh: not authenticated', '2026-07-29T00:00:00.000Z')).toBe(
			true
		);
		expect(b.cards[0].runs?.[0].prError).toBe('gh: not authenticated');
		expect(b.cards[0].runs?.[0].prUrl).toBeUndefined();
		expect(b.cards[0].updatedAt).toBe('2026-07-29T00:00:00.000Z');
	});

	it('truncates a pages-long git error', () => {
		const b = board();
		stampCardPrError(b, 'c1', 'x'.repeat(2000), NOW);
		expect(b.cards[0].runs?.[0].prError).toHaveLength(500);
	});

	it('reports false when the card or run vanished in the meantime', () => {
		expect(stampCardPrError(board(), 'gone', 'boom', NOW)).toBe(false);
		expect(stampCardPrError(board([card({ runs: [] })]), 'c1', 'boom', NOW)).toBe(false);
	});
});

describe('maybeCreateCardPr', () => {
	const success: CardPrResult = {
		success: true,
		prUrl: 'https://github.com/o/r/pull/7',
		targetBranch: 'main',
	};

	it('creates the PR, stamps the url, and toasts green', async () => {
		const stampPrUrl = vi.fn();
		const notify = vi.fn();
		const createPr = vi.fn().mockResolvedValue(success);

		const result = await maybeCreateCardPr('c1', {
			loadBoard: () => board(),
			stampPrUrl,
			createPr,
			notify,
		});

		expect(result).toEqual(success);
		expect(createPr).toHaveBeenCalledTimes(1);
		expect(stampPrUrl).toHaveBeenCalledWith('c1', success.prUrl);
		expect(notify).toHaveBeenCalledWith(
			expect.objectContaining({ color: 'green', message: success.prUrl })
		);
	});

	it('does nothing at all when the gate declines', async () => {
		const createPr = vi.fn();
		const notify = vi.fn();
		const result = await maybeCreateCardPr('c1', {
			loadBoard: () => board([card({ prOnDone: undefined })]),
			createPr,
			notify,
		});
		expect(result).toBeNull();
		expect(createPr).not.toHaveBeenCalled();
		expect(notify).not.toHaveBeenCalled();
	});

	it('does nothing when the board cannot be loaded', async () => {
		const createPr = vi.fn();
		expect(await maybeCreateCardPr('c1', { loadBoard: () => null, createPr })).toBeNull();
		expect(createPr).not.toHaveBeenCalled();
	});

	it('survives a loadBoard that throws', async () => {
		const onLog = vi.fn();
		const result = await maybeCreateCardPr('c1', {
			loadBoard: () => {
				throw new Error('yaml is broken');
			},
			onLog,
		});
		expect(result).toBeNull();
		expect(onLog).toHaveBeenCalledWith('warn', expect.stringContaining('yaml is broken'));
	});

	it('toasts red, records the error, and skips the url stamp when the PR fails', async () => {
		const stampPrUrl = vi.fn();
		const stampPrError = vi.fn();
		const notify = vi.fn();
		const cards = [card()];
		const result = await maybeCreateCardPr('c1', {
			loadBoard: () => board(cards),
			stampPrUrl,
			stampPrError,
			createPr: async () => ({ success: false, error: 'gh: not authenticated' }),
			notify,
		});

		expect(result).toMatchObject({ success: false });
		expect(stampPrUrl).not.toHaveBeenCalled();
		expect(stampPrError).toHaveBeenCalledWith('c1', 'gh: not authenticated');
		// Decision 3: a PR failure never moves the card off `done`.
		expect(cards[0].status).toBe('done');
		expect(notify).toHaveBeenCalledWith(
			expect.objectContaining({ color: 'red', dismissible: true })
		);
	});

	it('records a placeholder reason when the creator failed without one', async () => {
		const stampPrError = vi.fn();
		await maybeCreateCardPr('c1', {
			loadBoard: () => board(),
			stampPrError,
			createPr: async () => ({ success: false }),
		});
		expect(stampPrError).toHaveBeenCalledWith('c1', 'unknown error');
	});

	it('still reports the failure when the error stamp itself fails', async () => {
		const onLog = vi.fn();
		const result = await maybeCreateCardPr('c1', {
			loadBoard: () => board(),
			stampPrError: () => {
				throw new Error('disk full');
			},
			createPr: async () => ({ success: false, error: 'gh: not authenticated' }),
			onLog,
		});
		expect(result).toMatchObject({ success: false });
		expect(onLog).toHaveBeenCalledWith('warn', expect.stringContaining('disk full'));
	});

	it('turns a thrown creator into a red toast rather than an unhandled rejection', async () => {
		const notify = vi.fn();
		const result = await maybeCreateCardPr('c1', {
			loadBoard: () => board(),
			createPr: async () => {
				throw new Error('spawn ENOENT');
			},
			notify,
		});
		expect(result).toMatchObject({ success: false, error: 'spawn ENOENT' });
		expect(notify).toHaveBeenCalledWith(expect.objectContaining({ color: 'red' }));
	});

	it('still reports success when the stamp fails (the PR exists either way)', async () => {
		const onLog = vi.fn();
		const notify = vi.fn();
		const result = await maybeCreateCardPr('c1', {
			loadBoard: () => board(),
			stampPrUrl: () => {
				throw new Error('disk full');
			},
			createPr: async () => success,
			notify,
			onLog,
		});
		expect(result).toEqual(success);
		expect(onLog).toHaveBeenCalledWith('warn', expect.stringContaining('disk full'));
		expect(notify).toHaveBeenCalledWith(expect.objectContaining({ color: 'green' }));
	});

	it('survives a toast sink that throws', async () => {
		const onLog = vi.fn();
		const result = await maybeCreateCardPr('c1', {
			loadBoard: () => board(),
			createPr: async () => success,
			notify: () => {
				throw new Error('toast exploded');
			},
			onLog,
		});
		expect(result).toEqual(success);
		expect(onLog).toHaveBeenCalledWith('warn', expect.stringContaining('toast exploded'));
	});

	it('passes the card request through to the default gh helper', async () => {
		createPullRequest.mockResolvedValue(success);
		await maybeCreateCardPr('c1', {
			loadBoard: () => board([card({ prOnDone: { targetBranch: 'rc' } })]),
			mainRepoCwd: PROJECT_ROOT,
		});
		expect(createPullRequest).toHaveBeenCalledWith(
			expect.objectContaining({
				worktreePath: WORKTREE_PATH,
				mainRepoCwd: PROJECT_ROOT,
				targetBranch: 'rc',
				title: 'Ship the thing',
			})
		);
	});

	it('asks the gh helper to skip the pre-push hooks (X1)', async () => {
		// Board worktrees have no `node_modules`, so the repo's pre-push hook fails
		// every card. The Board is the only caller allowed to opt out.
		createPullRequest.mockResolvedValue(success);
		await maybeCreateCardPr('c1', {
			loadBoard: () => board(),
			mainRepoCwd: PROJECT_ROOT,
		});
		expect(createPullRequest).toHaveBeenCalledWith(expect.objectContaining({ skipHooks: true }));
	});
});

describe('startCardPr', () => {
	/** Resolve the pending gh call on demand, so overlap is observable. */
	function deferredCreate() {
		let release!: (result: CardPrResult) => void;
		const pending = new Promise<CardPrResult>((resolve) => {
			release = resolve;
		});
		createPullRequest.mockReturnValue(pending);
		return { release: () => release({ success: true, prUrl: 'https://github.com/o/r/pull/7' }) };
	}

	it('opens exactly one PR when two transitions into done overlap', async () => {
		listBoards.mockReturnValue([board()]);
		const deferred = deferredCreate();

		// The dispatcher finalizing while a human drags the card to Done: both
		// pass the gate, because `run.prUrl` is only written once gh answers.
		startCardPr(PROJECT_ROOT, 'b1', 'c1');
		startCardPr(PROJECT_ROOT, 'b1', 'c1');
		await Promise.resolve();
		expect(createPullRequest).toHaveBeenCalledTimes(1);

		deferred.release();
		await vi.waitFor(() => expect(saveBoard).toHaveBeenCalledTimes(1));
	});

	it('stamps the url through the board write queue', async () => {
		listBoards.mockReturnValue([board()]);
		createPullRequest.mockResolvedValue({ success: true, prUrl: 'https://github.com/o/r/pull/7' });

		startCardPr(PROJECT_ROOT, 'b1', 'c2-unrelated');
		startCardPr(PROJECT_ROOT, 'b1', 'c1');

		await vi.waitFor(() => expect(saveBoard).toHaveBeenCalledTimes(1));
		expect(enqueueBoardWrite).toHaveBeenCalledWith(PROJECT_ROOT, expect.any(Function));
		const saved = saveBoard.mock.calls[0][1] as Board;
		expect(saved.cards[0].runs?.[0].prUrl).toBe('https://github.com/o/r/pull/7');
	});

	it('persists the failure reason through the board write queue and keeps the card done', async () => {
		const cards = [card()];
		listBoards.mockReturnValue([board(cards)]);
		createPullRequest.mockResolvedValue({ success: false, error: 'Failed to push branch: boom' });

		startCardPr(PROJECT_ROOT, 'b1', 'c1');

		await vi.waitFor(() => expect(saveBoard).toHaveBeenCalledTimes(1));
		expect(enqueueBoardWrite).toHaveBeenCalledWith(PROJECT_ROOT, expect.any(Function));
		const saved = saveBoard.mock.calls[0][1] as Board;
		expect(saved.cards[0].runs?.[0].prError).toBe('Failed to push branch: boom');
		expect(saved.cards[0].runs?.[0].prUrl).toBeUndefined();
		expect(saved.cards[0].status).toBe('done');
	});

	it('clears the recorded error once a later attempt succeeds', async () => {
		const cards = [card({ runs: [run({ prError: 'Failed to push branch: boom' })] })];
		listBoards.mockReturnValue([board(cards)]);
		createPullRequest.mockResolvedValue({ success: true, prUrl: 'https://github.com/o/r/pull/7' });

		startCardPr(PROJECT_ROOT, 'b1', 'c1');

		await vi.waitFor(() => expect(saveBoard).toHaveBeenCalledTimes(1));
		const saved = saveBoard.mock.calls[0][1] as Board;
		expect(saved.cards[0].runs?.[0].prUrl).toBe('https://github.com/o/r/pull/7');
		expect(saved.cards[0].runs?.[0].prError).toBeUndefined();
	});

	it('releases the in-flight slot so a later attempt can run', async () => {
		listBoards.mockReturnValue([board()]);
		createPullRequest.mockResolvedValue({ success: false, error: 'gh: not authenticated' });

		const notified = new Promise<void>((resolve) => {
			// The toast is the last step of the flow; the in-flight slot is released
			// one turn later, so wait past it before retrying.
			startCardPr(PROJECT_ROOT, 'b1', 'c1', { notify: () => resolve() });
		});
		await notified;
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(createPullRequest).toHaveBeenCalledTimes(1);

		// The first attempt failed, so nothing was stamped and the user retrying
		// (re-approving the card) must be able to try again.
		startCardPr(PROJECT_ROOT, 'b1', 'c1');
		await vi.waitFor(() => expect(createPullRequest).toHaveBeenCalledTimes(2));
	});

	it('does not fire for an unknown board', async () => {
		listBoards.mockReturnValue([]);
		startCardPr(PROJECT_ROOT, 'other-board', 'c1');
		await Promise.resolve();
		expect(createPullRequest).not.toHaveBeenCalled();
	});
});
