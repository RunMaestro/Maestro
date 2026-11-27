/**
 * U6: a host says which waiting message waits for its own tab alone (`handOver`), so a client
 * draws only that tab busy through the hand-over. The field is optional on the wire: a host value
 * is checked before use, and an older host's item (no field) stays an item that says nothing.
 */
import { describe, expect, it } from 'vitest';

import type { QueuedTurn } from '../../../../shared/maestro-lib/client/types';
import { parseQueuedTurns } from '../../../../shared/maestro-lib/client/ws-client';
import { queuedTurnsToWire } from '../../../../shared/maestro-lib/runtime/server-frames';

const turn = (overrides: Partial<QueuedTurn> = {}): QueuedTurn => ({
	itemId: 'q1',
	tabId: 't1',
	queuedAt: 10,
	kind: 'message',
	text: 'next',
	paused: false,
	...overrides,
});

describe('the hand-over on the queue wire (U6)', () => {
	it('carries the hand-over and its start from a host to a client', () => {
		const sent = [
			turn({ handOver: true, handOverSince: 42 }),
			turn({ itemId: 'q2', handOver: false }),
		];
		expect(parseQueuedTurns(queuedTurnsToWire(sent))).toEqual(sent);
	});

	it("keeps an older host's item, which says nothing, as one that says nothing", () => {
		const [item] = parseQueuedTurns(queuedTurnsToWire([turn()]));
		expect(item).not.toHaveProperty('handOver');
		expect(item).not.toHaveProperty('handOverSince');
	});

	it('drops a value of the wrong type, and a start time without a hand-over', () => {
		const [wrongType, notFinite, noHandOver] = parseQueuedTurns([
			{ id: 'a', tabId: 't1', timestamp: 1, type: 'message', text: 'x', handOver: 'yes' },
			{
				id: 'b',
				tabId: 't1',
				timestamp: 1,
				type: 'message',
				text: 'x',
				handOver: true,
				handOverSince: 'soon',
			},
			{
				id: 'c',
				tabId: 't1',
				timestamp: 1,
				type: 'message',
				text: 'x',
				handOver: false,
				handOverSince: 5,
			},
		]);
		expect(wrongType).not.toHaveProperty('handOver');
		expect(notFinite).toMatchObject({ handOver: true });
		expect(notFinite).not.toHaveProperty('handOverSince');
		expect(noHandOver).toMatchObject({ handOver: false });
		expect(noHandOver).not.toHaveProperty('handOverSince');
	});
});
