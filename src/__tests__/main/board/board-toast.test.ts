/**
 * @file board-toast.test.ts
 * @description Tests for the Board card done/blocked toast payload (Board I1).
 * The builder is the pure half of `notifyCard` in `src/main/index.ts`: given the
 * dispatcher's terminal {@link CardNotification}, it must turn a pooled run's
 * `workerAgentId` into a click-to-jump toast (mirroring the Cue precedent) while
 * leaving a legacy profile-based run's toast non-clickable.
 */

import { describe, it, expect } from 'vitest';
import { buildBoardCardToastPayload } from '../../../main/board/board-toast';
import type { CardNotification } from '../../../main/board/board-dispatcher';

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
	});

	it('names the worktree branch in the message when the card ran isolated', () => {
		const payload = buildBoardCardToastPayload(
			doneEvent({ detail: 'isolated work', worktreeBranch: 'board/b1/c1' })
		);
		expect(payload.message).toBe('isolated work (branch board/b1/c1)');
	});
});
