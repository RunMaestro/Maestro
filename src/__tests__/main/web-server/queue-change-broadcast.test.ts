/**
 * M23: the desktop sends `queue_changed` with `exit` and `namesExits`, as a headless host does,
 * whenever a write of its agents changes a queue.
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

const message = (id: string, extra: Record<string, unknown> = {}) => ({
	id,
	timestamp: 1,
	tabId: 't1',
	type: 'message' as const,
	text: id,
	...extra,
});

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('broadcastDesktopQueueChanges (M23, M26)', () => {
	const broadcastToCliClients = vi.fn();
	const server = (clients: number) => ({ broadcastToCliClients, getWebClientCount: () => clients });

	beforeEach(() => {
		broadcastToCliClients.mockReset();
		withQueueItemImages.mockClear();
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
				// The frame before it sent the images (M26).
				items: [{ ...message('waits'), imagesKept: true }],
				namesExits: true,
				exit: { itemId: 'gone', exit: 'removed' },
			},
		]);
	});

	it('sends a frame with no exit when an item only joined the queue', async () => {
		broadcastDesktopQueueChanges(
			server(1),
			[{ id: 'a1', executionQueue: [] }],
			[{ id: 'a1', executionQueue: [message('q1')] }]
		);
		await settled();
		expect(broadcastToCliClients).toHaveBeenCalledWith({
			type: 'queue_changed',
			sessionId: 'a1',
			items: [message('q1')],
			namesExits: true,
		});
	});

	it('leaves off namesExits on a change with an exit it cannot prove, so the client counts a gap (CodeRabbit on #2154)', async () => {
		broadcastDesktopQueueChanges(
			server(1),
			[{ id: 'a1', executionQueue: [{ ...message('cmd'), type: 'command' as never }] }],
			[{ id: 'a1', executionQueue: [] }]
		);
		await settled();
		expect(broadcastToCliClients).toHaveBeenCalledWith({
			type: 'queue_changed',
			sessionId: 'a1',
			items: [],
		});
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

	// Parity M26: a queue change went to every web client with every item's images inlined again.
	it("sends an item's images once: a later frame whose item keeps its images says imagesKept (M26)", async () => {
		const waits = message('w1', { images: ['ref-1'] });
		broadcastDesktopQueueChanges(
			server(1),
			[{ id: 'm26', executionQueue: [] }],
			[{ id: 'm26', executionQueue: [waits] }]
		);
		await settled();
		broadcastDesktopQueueChanges(
			server(1),
			[{ id: 'm26', executionQueue: [waits] }],
			[{ id: 'm26', executionQueue: [waits, message('w2')] }]
		);
		await settled();
		expect(broadcastToCliClients.mock.calls.map(([frame]) => frame.items)).toEqual([
			[{ ...message('w1'), images: ['data:image/png;base64,AAAA'] }],
			[{ ...message('w1'), imagesKept: true }, message('w2')],
		]);
		expect(withQueueItemImages).toHaveBeenLastCalledWith([message('w1'), message('w2')], true);
	});

	it('sends the images again when an edit changes them, or the item left and came back (M26)', async () => {
		const before = message('e1', { images: ['ref-1'] });
		const edited = message('e1', { images: ['ref-1', 'ref-2'] });
		broadcastDesktopQueueChanges(
			server(1),
			[{ id: 'm26e', executionQueue: [] }],
			[{ id: 'm26e', executionQueue: [before] }]
		);
		await settled();
		broadcastDesktopQueueChanges(
			server(1),
			[{ id: 'm26e', executionQueue: [before] }],
			[{ id: 'm26e', executionQueue: [edited] }]
		);
		await settled();
		broadcastDesktopQueueChanges(
			server(1),
			[{ id: 'm26e', executionQueue: [edited] }],
			[{ id: 'm26e', executionQueue: [] }]
		);
		await settled();
		broadcastDesktopQueueChanges(
			server(1),
			[{ id: 'm26e', executionQueue: [] }],
			[{ id: 'm26e', executionQueue: [edited] }]
		);
		await settled();
		const inlined = (count: number) => ({
			...message('e1'),
			images: Array.from({ length: count }, () => 'data:image/png;base64,AAAA'),
		});
		expect(broadcastToCliClients.mock.calls.map(([frame]) => frame.items)).toEqual([
			[inlined(1)],
			[inlined(2)],
			[],
			[inlined(2)],
		]);
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
