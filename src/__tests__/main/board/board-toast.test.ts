/**
 * @file board-toast.test.ts
 * @description Tests for the Board card done/review/blocked toast payload (Board
 * I1, extended by F2's review status and F3's PR-on-done toast).
 * The builder is the pure half of `notifyCard` in `src/main/index.ts`: given the
 * dispatcher's terminal {@link CardNotification}, it must turn a pooled run's
 * `workerAgentId` into a click-to-jump toast (mirroring the Cue precedent) while
 * leaving a legacy profile-based run's toast non-clickable.
 */

import { describe, it, expect } from 'vitest';
import {
	buildBoardCardToastPayload,
	buildCardPrToastPayload,
} from '../../../main/board/board-toast';
import type { CardNotification } from '../../../main/board/board-dispatcher';
import type { CardPrRequest } from '../../../main/board/board-pr';

const doneEvent = (overrides: Partial<CardNotification> = {}): CardNotification => ({
	kind: 'done',
	boardId: 'b1',
	cardId: 'c1',
	cardTitle: 'Ship the thing',
	detail: 'shipped it',
	attempt: 1,
	outcome: 'done',
	...overrides,
});

const blockedEvent = (overrides: Partial<CardNotification> = {}): CardNotification => ({
	kind: 'blocked',
	boardId: 'b1',
	cardId: 'c1',
	cardTitle: 'Ship the thing',
	detail: 'needs a schema',
	attempt: 1,
	outcome: 'blocked',
	...overrides,
});

const reviewEvent = (overrides: Partial<CardNotification> = {}): CardNotification => ({
	kind: 'review',
	boardId: 'b1',
	cardId: 'c1',
	cardTitle: 'Ship the thing',
	detail: 'check the migration by hand',
	attempt: 1,
	outcome: 'review',
	...overrides,
});

describe('buildBoardCardToastPayload', () => {
	it('a pooled done run jumps to the worker agent', () => {
		const payload = buildBoardCardToastPayload(doneEvent({ workerAgentId: 'worker-7' }));
		expect(payload).toMatchObject({
			title: 'Card done: Ship the thing',
			message: 'shipped it',
			color: 'green',
			dismissible: false,
			sourceAgent: 'Board',
			sessionId: 'worker-7',
			clickAction: { kind: 'jump-session', sessionId: 'worker-7' },
		});
	});

	it('a pooled blocked run jumps to the worker agent and is sticky', () => {
		const payload = buildBoardCardToastPayload(blockedEvent({ workerAgentId: 'worker-7' }));
		expect(payload).toMatchObject({
			title: 'Card blocked: Ship the thing',
			message: 'needs a schema',
			color: 'red',
			dismissible: true,
			sourceAgent: 'Board',
			sessionId: 'worker-7',
			clickAction: { kind: 'jump-session', sessionId: 'worker-7' },
		});
	});

	it('a review run is yellow and sticky, not red (F2)', () => {
		// The card did not fail, it is waiting for approval - so the toast has to
		// persist until a human acts, without reading as an error.
		const payload = buildBoardCardToastPayload(reviewEvent({ workerAgentId: 'worker-7' }));
		expect(payload).toMatchObject({
			title: 'Card needs review: Ship the thing',
			message: 'check the migration by hand',
			color: 'yellow',
			dismissible: true,
			sourceAgent: 'Board',
			sessionId: 'worker-7',
			clickAction: { kind: 'jump-session', sessionId: 'worker-7' },
		});
	});

	it('a legacy run (no workerAgentId) carries neither sessionId nor clickAction', () => {
		const donePayload = buildBoardCardToastPayload(doneEvent());
		expect(donePayload.sessionId).toBeUndefined();
		expect(donePayload.clickAction).toBeUndefined();

		const blockedPayload = buildBoardCardToastPayload(blockedEvent());
		expect(blockedPayload.sessionId).toBeUndefined();
		expect(blockedPayload.clickAction).toBeUndefined();
	});

	it('falls back to a default message when the run reported no detail', () => {
		expect(buildBoardCardToastPayload(doneEvent({ detail: undefined })).message).toBe(
			'Run completed.'
		);
		expect(buildBoardCardToastPayload(blockedEvent({ detail: undefined })).message).toBe(
			'No reason reported.'
		);
		expect(buildBoardCardToastPayload(reviewEvent({ detail: undefined })).message).toBe(
			'Waiting for human approval.'
		);
	});

	it('names the worktree branch in the message when the card ran isolated', () => {
		const payload = buildBoardCardToastPayload(
			doneEvent({ detail: 'isolated work', worktreeBranch: 'board/b1/c1' })
		);
		expect(payload.message).toBe('isolated work (branch board/b1/c1)');
	});
});

describe('buildCardPrToastPayload', () => {
	const request: CardPrRequest = {
		boardId: 'b1',
		cardId: 'c1',
		cardTitle: 'Ship the thing',
		worktreePath: '/repos/worktrees/board/b1/c1',
		worktreeBranch: 'board/b1/c1',
		title: 'Ship the thing',
		body: 'body',
	};

	it('a created PR is a green auto-dismissing toast that opens the url', () => {
		const payload = buildCardPrToastPayload(request, {
			success: true,
			prUrl: 'https://github.com/o/r/pull/7',
			targetBranch: 'rc',
		});
		expect(payload).toEqual({
			title: 'PR opened: Ship the thing',
			message: 'https://github.com/o/r/pull/7',
			color: 'green',
			dismissible: false,
			sourceAgent: 'Board',
			clickAction: { kind: 'open-url', url: 'https://github.com/o/r/pull/7' },
		});
	});

	it('a failed PR is red and sticky, naming the branch to open by hand', () => {
		// The card is still `done`, so this toast is the ONLY thing telling the
		// user the pull request they asked for is missing.
		const payload = buildCardPrToastPayload(request, {
			success: false,
			error: 'gh: not authenticated',
		});
		expect(payload).toMatchObject({
			title: 'PR failed: Ship the thing',
			message: 'gh: not authenticated (branch board/b1/c1)',
			color: 'red',
			dismissible: true,
			sourceAgent: 'Board',
		});
		expect(payload.clickAction).toBeUndefined();
	});

	it('falls back to a generic reason when the failure carried none', () => {
		expect(buildCardPrToastPayload(request, { success: false }).message).toBe(
			'Could not open the pull request. (branch board/b1/c1)'
		);
	});

	it('treats a success with no url as a failure (nothing to link to)', () => {
		expect(buildCardPrToastPayload(request, { success: true }).color).toBe('red');
	});
});
