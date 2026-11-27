/**
 * Parity R17: every durable sessions write tells the hosted agents check, after the Pianola
 * consumer, so a Move Back while the host is down (`unlift --offline`) drops its outage at once.
 */

import { describe, expect, it, vi } from 'vitest';
import { withHostedAgentsNote } from '../../../../main/ipc/bootstrap/sessions-persisted';

describe('withHostedAgentsNote (R17)', () => {
	it('runs the consumer with the write, then the hosted agents note', async () => {
		const order: string[] = [];
		const consumer = vi.fn(async () => {
			order.push('consumer');
		});
		const note = vi.fn(() => order.push('note'));
		const added = [{ id: 'a1' }] as never[];
		const current = [{ id: 'a1' }, { id: 'a2' }] as never[];

		await withHostedAgentsNote(consumer, note)(added, current, ['gone']);

		expect(consumer).toHaveBeenCalledWith(added, current, ['gone']);
		expect(order).toEqual(['consumer', 'note']);
	});

	it('still notes when the consumer throws, and lets the error through', async () => {
		const note = vi.fn();
		const consumer = vi.fn(async () => {
			throw new Error('watch failed');
		});
		await expect(withHostedAgentsNote(consumer, note)([], [], [])).rejects.toThrow('watch failed');
		expect(note).toHaveBeenCalledTimes(1);
	});
});
