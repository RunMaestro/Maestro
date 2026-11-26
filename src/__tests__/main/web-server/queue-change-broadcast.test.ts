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

describe('broadcastDesktopQueueChanges (M23)', () => {
	const broadcastToAll = vi.fn();
	const server = (clients: number) => ({ broadcastToAll, getWebClientCount: () => clients });

	beforeEach(() => {
		broadcastToAll.mockReset();
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
		expect(broadcastToAll.mock.calls.map(([frame]) => frame)).toEqual([
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
				items,
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
		expect(broadcastToAll).toHaveBeenCalledWith({
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
		expect(broadcastToAll).toHaveBeenCalledWith({
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
		expect(broadcastToAll.mock.calls.map(([frame]) => frame)).toEqual([
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
		expect(broadcastToAll).not.toHaveBeenCalled();
	});
});
