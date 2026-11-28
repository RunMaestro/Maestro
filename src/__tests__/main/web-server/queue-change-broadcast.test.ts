/**
 * M23: the desktop sends `queue_changed` with `exit` and `namesExits`, as a headless host does,
 * whenever a write of its agents changes a queue. M28: a client that reads queue changes gets the
 * change only (ids in order, what is new or changed, with images); any other gets the whole list.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { withQueueItemImages } = vi.hoisted(() => ({
	withQueueItemImages: vi.fn(async (items: Array<{ images?: string[] }>) =>
		items.map((item) =>
			item.images ? { ...item, images: item.images.map(() => 'data:image/png;base64,AAAA') } : item
		)
	),
}));
vi.mock('../../../main/web-server/handlers/messageHandlers/queue', () => ({ withQueueItemImages }));
vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));

import { broadcastDesktopQueueChanges } from '../../../main/web-server/queue-change-broadcast';
import {
	queueChangesSeq,
	resetQueueChangeFrames,
} from '../../../main/web-server/queue-change-frames';

// `handOver: false` is what every desktop item says on the wire (`toQueuedItemSnapshot()`, U6), so
// an item reads the same going in and coming out.
const message = (id: string, extra: Record<string, unknown> = {}) => ({
	id,
	timestamp: 1,
	tabId: 't1',
	type: 'message' as const,
	text: id,
	handOver: false as const,
	...extra,
});

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('broadcastDesktopQueueChanges (M23, M28)', () => {
	const broadcastToCliClients = vi.fn();
	/** `clients` open clients, of which `changes` read queue changes and the rest whole frames. */
	const server = (clients: number, changes = 0) => ({
		broadcastToCliClients,
		getWebClientCount: () => clients,
		getCliClientCounts: () => ({ 'queue-changes': changes, 'whole-queue': clients - changes }),
	});
	const inlined = (count: number) =>
		Array.from({ length: count }, () => 'data:image/png;base64,AAAA');

	beforeEach(() => {
		broadcastToCliClients.mockReset();
		withQueueItemImages.mockClear();
		resetQueueChangeFrames();
	});

	it('sends one frame per item that left, each with the list after the write and its images inlined', async () => {
		broadcastDesktopQueueChanges(
			server(1),
			[
				{
					id: 'a1',
					executionQueue: [message('ran'), message('gone'), message('waits', { images: ['ref'] })],
				},
			],
			[
				{
					id: 'a1',
					executionQueue: [message('waits', { images: ['ref'] })],
					aiTabs: [{ logs: [{ source: 'user', queuedItemId: 'ran' }] }],
				},
			]
		);
		await settled();
		const items = [{ ...message('waits'), images: ['data:image/png;base64,AAAA'] }];
		expect(broadcastToCliClients.mock.calls.map(([frame]) => frame)).toEqual([
			{
				type: 'queue_changed',
				sessionId: 'a1',
				items,
				namesExits: true,
				exit: { itemId: 'ran', exit: 'started' },
			},
			{
				type: 'queue_changed',
				sessionId: 'a1',
				// A client that does not read changes gets every frame whole, images and all (M28).
				items,
				namesExits: true,
				exit: { itemId: 'gone', exit: 'removed' },
			},
		]);
		expect(broadcastToCliClients.mock.calls.map(([, audience]) => audience)).toEqual([
			'whole-queue',
			'whole-queue',
		]);
	});

	it('sends a frame with no exit when an item only joined the queue', async () => {
		broadcastDesktopQueueChanges(
			server(1),
			[{ id: 'a1', executionQueue: [] }],
			[{ id: 'a1', executionQueue: [message('q1')] }]
		);
		await settled();
		expect(broadcastToCliClients).toHaveBeenCalledWith(
			{ type: 'queue_changed', sessionId: 'a1', items: [message('q1')], namesExits: true },
			'whole-queue'
		);
	});

	it('leaves off namesExits on a change with an exit it cannot prove, so the client counts a gap (CodeRabbit on #2154)', async () => {
		broadcastDesktopQueueChanges(
			server(1),
			[{ id: 'a1', executionQueue: [{ ...message('cmd'), type: 'command' as never }] }],
			[{ id: 'a1', executionQueue: [] }]
		);
		await settled();
		expect(broadcastToCliClients).toHaveBeenCalledWith(
			{ type: 'queue_changed', sessionId: 'a1', items: [] },
			'whole-queue'
		);
	});

	it('keeps a proven start beside an exit it cannot prove: the start is named, then the gap is marked (CodeRabbit on #2154)', async () => {
		broadcastDesktopQueueChanges(
			server(1),
			[
				{
					id: 'a1',
					executionQueue: [message('q1'), { ...message('cmd'), type: 'command' as never }],
				},
			],
			[
				{
					id: 'a1',
					executionQueue: [],
					aiTabs: [{ logs: [{ source: 'user', queuedItemId: 'q1' }] }],
				},
			]
		);
		await settled();
		expect(broadcastToCliClients.mock.calls.map(([frame]) => frame)).toEqual([
			{
				type: 'queue_changed',
				sessionId: 'a1',
				items: [],
				namesExits: true,
				exit: { itemId: 'q1', exit: 'started' },
			},
			{ type: 'queue_changed', sessionId: 'a1', items: [] },
		]);
	});

	// Parity M28: `imagesKept` reached clients that could not read it (an older desktop client drew
	// its queued cards without thumbnails), and was tracked per agent, not per client.
	it('gives a client that does not read changes every frame whole, every image every time, never imagesKept (M28)', async () => {
		const waits = message('w1', { images: ['ref-1'] });
		broadcastDesktopQueueChanges(
			server(1),
			[{ id: 'm28w', executionQueue: [] }],
			[{ id: 'm28w', executionQueue: [waits] }]
		);
		await settled();
		broadcastDesktopQueueChanges(
			server(1),
			[{ id: 'm28w', executionQueue: [waits] }],
			[{ id: 'm28w', executionQueue: [waits, message('w2')] }]
		);
		await settled();
		expect(broadcastToCliClients.mock.calls.map(([frame]) => frame.items)).toEqual([
			[{ ...message('w1'), images: inlined(1) }],
			[{ ...message('w1'), images: inlined(1) }, message('w2')],
		]);
		expect(JSON.stringify(broadcastToCliClients.mock.calls)).not.toContain('imagesKept');
	});

	it('gives a client that reads changes the ids in order and only what is new or changed since the last frame, with its images (M28)', async () => {
		const waits = message('c1', { images: ['ref-1'] });
		broadcastDesktopQueueChanges(
			server(1, 1),
			[{ id: 'm28c', executionQueue: [] }],
			[{ id: 'm28c', executionQueue: [waits] }]
		);
		await settled();
		broadcastDesktopQueueChanges(
			server(1, 1),
			[{ id: 'm28c', executionQueue: [waits] }],
			[{ id: 'm28c', executionQueue: [waits, message('c2')] }]
		);
		await settled();
		expect(broadcastToCliClients.mock.calls).toEqual([
			[
				{
					type: 'queue_changed',
					sessionId: 'm28c',
					namesExits: true,
					changes: {
						seq: 1,
						base: 0,
						order: ['c1'],
						changed: [{ ...message('c1'), images: inlined(1) }],
					},
				},
				'queue-changes',
			],
			[
				{
					type: 'queue_changed',
					sessionId: 'm28c',
					namesExits: true,
					changes: { seq: 2, base: 1, order: ['c1', 'c2'], changed: [message('c2')] },
				},
				'queue-changes',
			],
		]);
		// Only the new item's images are read for it.
		expect(withQueueItemImages).toHaveBeenLastCalledWith([message('c2')], true);
		// A queue read answers the seq the frames are at.
		expect(queueChangesSeq('m28c')).toBe(2);
		expect(queueChangesSeq('never-framed')).toBe(0);
	});

	it('carries an item again when an edit changes its images, or it left and came back (M28)', async () => {
		const before = message('e1', { images: ['ref-1'] });
		const edited = message('e1', { images: ['ref-1', 'ref-2'] });
		const steps: Array<[unknown[], unknown[]]> = [
			[[], [before]],
			[[before], [edited]],
			[[edited], []],
			[[], [edited]],
		];
		for (const [had, has] of steps) {
			broadcastDesktopQueueChanges(
				server(1, 1),
				[{ id: 'm28e', executionQueue: had as never }],
				[{ id: 'm28e', executionQueue: has as never }]
			);
			await settled();
		}
		expect(broadcastToCliClients.mock.calls.map(([frame]) => frame.changes.changed)).toEqual([
			[{ ...message('e1'), images: inlined(1) }],
			[{ ...message('e1'), images: inlined(2) }],
			[],
			[{ ...message('e1'), images: inlined(2) }],
		]);
	});

	it('carries an item whose image could not be read again in the next change (CodeRabbit on #2160)', async () => {
		const waits = message('u1', { images: ['ref-1', 'ref-2'] });
		// The first read finds only one of the two files.
		withQueueItemImages.mockImplementationOnce(async (items: Array<{ images?: string[] }>) =>
			items.map((item) => (item.images ? { ...item, images: inlined(1) } : item))
		);
		broadcastDesktopQueueChanges(
			server(1, 1),
			[{ id: 'm28u', executionQueue: [] }],
			[{ id: 'm28u', executionQueue: [waits] }]
		);
		await settled();
		broadcastDesktopQueueChanges(
			server(1, 1),
			[{ id: 'm28u', executionQueue: [waits] }],
			[{ id: 'm28u', executionQueue: [waits, message('u2')] }]
		);
		await settled();
		expect(broadcastToCliClients.mock.calls.map(([frame]) => frame.changes.changed)).toEqual([
			[{ ...message('u1'), images: inlined(1) }],
			[{ ...message('u1'), images: inlined(2) }, message('u2')],
		]);
	});

	it('numbers each frame of one change, the later ones carrying nothing, and reads images once for both kinds of client (M28)', async () => {
		broadcastDesktopQueueChanges(
			server(2, 1),
			[{ id: 'm28m', executionQueue: [message('ran'), message('gone'), message('waits')] }],
			[
				{
					id: 'm28m',
					executionQueue: [message('waits', { images: ['ref'] })],
					aiTabs: [{ logs: [{ source: 'user', queuedItemId: 'ran' }] }],
				},
			]
		);
		await settled();
		const changes = broadcastToCliClients.mock.calls
			.filter(([, audience]) => audience === 'queue-changes')
			.map(([frame]) => [frame.exit, frame.changes]);
		expect(changes).toEqual([
			[
				{ itemId: 'ran', exit: 'started' },
				{
					seq: 1,
					base: 0,
					order: ['waits'],
					changed: [{ ...message('waits'), images: inlined(1) }],
				},
			],
			[
				{ itemId: 'gone', exit: 'removed' },
				{ seq: 2, base: 1, order: ['waits'], changed: [] },
			],
		]);
		expect(
			broadcastToCliClients.mock.calls.filter(([, audience]) => audience === 'whole-queue')
		).toHaveLength(2);
		expect(withQueueItemImages).toHaveBeenCalledTimes(1);
	});

	it('names the start of a message whose tab was snoozed since it started (M26)', async () => {
		const card = { logs: [{ source: 'user', queuedItemId: 's1' }] };
		broadcastDesktopQueueChanges(
			server(1),
			[{ id: 'm26s', executionQueue: [message('s1'), message('g1')] }],
			[
				{
					id: 'm26s',
					executionQueue: [],
					snoozedTabs: [
						{ type: 'ai', tab: card },
						{
							type: 'group',
							members: [
								{ type: 'file', tab: { logs: [] } },
								{ type: 'ai', tab: { logs: [{ source: 'user', queuedItemId: 'g1' }] } },
							],
						},
					],
				},
			]
		);
		await settled();
		expect(broadcastToCliClients.mock.calls.map(([frame]) => frame.exit)).toEqual([
			{ itemId: 's1', exit: 'started' },
			{ itemId: 'g1', exit: 'started' },
		]);
	});

	// Parity M29: an agent's frame state outlived the agent.
	it('forgets the frames of an agent that is gone from the stored list, also with no client attached (M29)', async () => {
		broadcastDesktopQueueChanges(
			server(1, 1),
			[{ id: 'm29g', executionQueue: [] }],
			[{ id: 'm29g', executionQueue: [message('g1')] }]
		);
		await settled();
		expect(queueChangesSeq('m29g')).toBe(1);
		broadcastDesktopQueueChanges(
			server(0),
			[
				{ id: 'm29g', executionQueue: [message('g1')] },
				{ id: 'kept', executionQueue: [] },
			],
			[{ id: 'kept', executionQueue: [] }]
		);
		await settled();
		expect(queueChangesSeq('m29g')).toBe(0);
	});

	it('sends nothing with no client attached, or no queue changed', async () => {
		broadcastDesktopQueueChanges(
			server(0),
			[{ id: 'a1', executionQueue: [] }],
			[{ id: 'a1', executionQueue: [message('q1')] }]
		);
		broadcastDesktopQueueChanges(
			server(1),
			[{ id: 'a1', executionQueue: [message('q1')] }],
			[{ id: 'a1', executionQueue: [message('q1')] }]
		);
		broadcastDesktopQueueChanges(null, [], [{ id: 'a1', executionQueue: [message('q1')] }]);
		await settled();
		expect(broadcastToCliClients).not.toHaveBeenCalled();
	});
});
