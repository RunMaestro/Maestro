import { describe, expect, it } from 'vitest';
import { MAX_PENDING_STEERING_NOTES } from '../../../autorunSteering';
import { createSteeringLedger } from '../autorun-steering';

function ledger() {
	let id = 0;
	let clock = 100;
	return createSteeringLedger({ now: () => clock++, newId: () => `id-${++id}` });
}

describe('createSteeringLedger', () => {
	it('parks a note, hands it to the next task once, and keeps the reply beside it', () => {
		const steering = ledger();
		const sent = steering.command('a1', { action: 'send', text: '  use the fixtures  ' }, null);
		expect(sent).toEqual({
			success: true,
			note: { id: 'id-1', text: 'use the fixtures', timestamp: 100 },
		});

		const taken = steering.take('a1');
		expect(taken?.notes.map((note) => note.text)).toEqual(['use the fixtures']);
		expect(steering.take('a1')).toBeUndefined();

		steering.reply('a1', taken!.deliveryId, { text: 'Switched to the fixtures.', success: true });
		expect(steering.command('a1', { action: 'list' }, null)).toEqual({
			success: true,
			steerable: true,
			pending: [],
			deliveries: [
				{
					deliveryId: taken!.deliveryId,
					notes: [{ id: 'id-1', text: 'use the fixtures', timestamp: 100 }],
					reply: {
						summary: 'Switched to the fixtures.',
						text: 'Switched to the fixtures.',
						success: true,
						timestamp: 101,
					},
				},
			],
		});
	});

	it('refuses a send with no run, no text, or a full queue, as the desktop does', () => {
		const steering = ledger();
		expect(steering.command('a1', { action: 'send', text: 'x' }, 'No Auto Run is active')).toEqual({
			success: false,
			error: 'No Auto Run is active',
		});
		expect(steering.command('a1', { action: 'send', text: '   ' }, null)).toMatchObject({
			success: false,
			error: 'A steering note needs some text',
		});
		for (let i = 0; i < MAX_PENDING_STEERING_NOTES; i++) {
			steering.command('a1', { action: 'send', text: `note ${i}` }, null);
		}
		expect(steering.command('a1', { action: 'send', text: 'one more' }, null)).toMatchObject({
			success: false,
		});
		expect(steering.command('a1', { action: 'cancel', noteId: 'id-1' }, null).success).toBe(true);
		expect(steering.command('a1', { action: 'send', text: 'x'.repeat(4001) }, null)).toEqual({
			success: false,
			error: 'Steering note is 4001 characters; the limit is 4000',
		});
		expect(steering.command('a1', { action: 'list' }, 'No run')).toMatchObject({
			steerable: false,
		});
	});

	it('takes back a waiting note, never a delivered one, and dismisses a delivery', () => {
		const steering = ledger();
		steering.command('a1', { action: 'send', text: 'first' }, null);
		const taken = steering.take('a1')!;
		steering.command('a1', { action: 'send', text: 'second' }, null);

		expect(steering.command('a1', { action: 'cancel', noteId: 'id-1' }, null)).toMatchObject({
			success: false,
			error: 'That steering note was already delivered to a task and cannot be taken back',
		});
		expect(steering.command('a1', { action: 'cancel', noteId: 'id-3' }, null)).toMatchObject({
			success: true,
			note: { text: 'second' },
		});
		expect(
			steering.command('a1', { action: 'dismiss', deliveryId: taken.deliveryId }, null)
		).toMatchObject({ success: true, delivery: { deliveryId: taken.deliveryId } });
		expect(steering.command('a1', { action: 'list' }, null)).toMatchObject({
			pending: [],
			deliveries: [],
		});
	});

	it('starts each run clean and ends one keeping only what was delivered', () => {
		const steering = ledger();
		steering.command('a1', { action: 'send', text: 'taken' }, null);
		steering.take('a1');
		steering.command('a1', { action: 'send', text: 'never taken' }, null);
		steering.endRun('a1');
		const listed = steering.command('a1', { action: 'list' }, null);
		expect(listed.pending).toEqual([]);
		expect(listed.deliveries).toHaveLength(1);
		steering.startRun('a1');
		expect(steering.command('a1', { action: 'list' }, null).deliveries).toEqual([]);
	});
});
