/**
 * M23: a desktop host names how each item leaves its queue, as a headless host does, so a hosted
 * agent's queued consult starts on the named start and a removed message is let go at once.
 */

import { describe, expect, it } from 'vitest';

import { AGENT_MODES, agentModeFields } from '../helpers/mockSession';
import {
	desktopQueueChanges,
	toQueuedItemSnapshot,
	type QueueDiffAgent,
} from '../../shared/queueSnapshot';

const message = (id: string, text: string, extra: Record<string, unknown> = {}) => ({
	id,
	timestamp: 1,
	tabId: 't1',
	type: 'message' as const,
	text,
	...extra,
});

const agent = (
	queue: ReturnType<typeof message>[],
	logs: Array<{ source: string; queuedItemId?: string }> = [],
	extra: Record<string, unknown> = {}
): QueueDiffAgent => ({ id: 'a1', executionQueue: queue, aiTabs: [{ logs }], ...extra });

describe('toQueuedItemSnapshot', () => {
	it('keeps only the fields an item has, and its images as held', () => {
		expect(toQueuedItemSnapshot(message('q1', 'hi', { images: ['ref'], paused: false }))).toEqual({
			id: 'q1',
			timestamp: 1,
			tabId: 't1',
			type: 'message',
			text: 'hi',
			paused: false,
			handOver: false,
			images: ['ref'],
		});
		expect(toQueuedItemSnapshot(message('q2', 'hi', { images: [] }))).not.toHaveProperty('images');
	});

	it('says every desktop item waits for more than its tab alone: no hand-over (U6)', () => {
		// A desktop starts a tab's next message in the moment the turn before ends, so a client never
		// draws a tab busy from a desktop host's queue, where its Stop would do nothing.
		expect(toQueuedItemSnapshot(message('q1', 'hi')).handOver).toBe(false);
	});
});

describe('desktopQueueChanges (M23)', () => {
	it.each(AGENT_MODES)(
		'a %s agent on a desktop host: a start, a removal, and a wait are named the same',
		(mode) => {
			const fields = agentModeFields(mode);
			const before = agent(
				[message('ran', 'a'), message('gone', 'b'), message('waits', 'c')],
				[],
				fields
			);
			// `ran` left with its card (the user entry stamped with its id); `gone` left with none.
			const after = agent(
				[message('waits', 'c')],
				[{ source: 'user', queuedItemId: 'ran' }],
				fields
			);
			expect(desktopQueueChanges([before], [after])).toEqual([
				{
					agentId: 'a1',
					items: [toQueuedItemSnapshot(message('waits', 'c'))],
					exits: [
						{ itemId: 'ran', exit: 'started' },
						{ itemId: 'gone', exit: 'removed' },
					],
					unnamedExit: false,
				},
			]);
		}
	);

	it('a message added, held, or edited is a change with no exit', () => {
		const before = agent([message('q1', 'a')]);
		expect(
			desktopQueueChanges([before], [agent([message('q1', 'a'), message('q2', 'b')])])
		).toEqual([
			{
				agentId: 'a1',
				items: [message('q1', 'a'), message('q2', 'b')].map(toQueuedItemSnapshot),
				exits: [],
				unnamedExit: false,
			},
		]);
		expect(
			desktopQueueChanges([before], [agent([message('q1', 'a', { paused: true })])])
		).toHaveLength(1);
	});

	it('an unchanged queue, and an agent that is gone, send nothing', () => {
		const same = agent([message('q1', 'a')]);
		expect(desktopQueueChanges([same], [agent([message('q1', 'a')])])).toEqual([]);
		expect(desktopQueueChanges([same], [])).toEqual([]);
	});

	it("a start is read from a background tab's card too", () => {
		const before = agent([message('q1', 'a')]);
		const after: QueueDiffAgent = {
			id: 'a1',
			executionQueue: [],
			aiTabs: [{ logs: [] }],
			orphanedThinkingTabs: [{ logs: [{ source: 'user', queuedItemId: 'q1' }] }],
		};
		expect(desktopQueueChanges([before], [after])[0].exits).toEqual([
			{ itemId: 'q1', exit: 'started' },
		]);
	});

	it('names no exit where the card proves nothing (a command, a mention a Pianola dispatch runs), and says so (CodeRabbit on #2154)', () => {
		const before = agent([
			{ ...message('cmd', ''), type: 'command' as never },
			message('mention', 'ask @Backend', { crossAgentMention: true }),
		]);
		expect(desktopQueueChanges([before], [agent([])])[0]).toMatchObject({
			exits: [],
			unnamedExit: true,
		});
	});
});
