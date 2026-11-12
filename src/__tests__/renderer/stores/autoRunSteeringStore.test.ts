import { describe, it, expect, beforeEach } from 'vitest';
import {
	useAutoRunSteeringStore,
	groupSteeringDeliveries,
	selectDeliveredSteeringNotes,
	selectPendingSteeringNotes,
	MAX_DELIVERED_STEERING_NOTES,
	MAX_STEERING_RESPONSE_LENGTH,
} from '../../../renderer/stores/autoRunSteeringStore';
import { MAX_PENDING_STEERING_NOTES } from '../../../shared/autorunSteering';

const SESSION = 'session-1';

describe('autoRunSteeringStore', () => {
	beforeEach(() => {
		useAutoRunSteeringStore.setState({ notes: {}, delivered: {} });
	});

	it('parks a note against its session', () => {
		const note = useAutoRunSteeringStore.getState().addNote(SESSION, '  steer left  ');
		expect(note).not.toBeNull();
		expect(note!.text).toBe('steer left');
		expect(useAutoRunSteeringStore.getState().notes[SESSION]).toHaveLength(1);
	});

	it('rejects an empty note so the caller can report the refusal', () => {
		expect(useAutoRunSteeringStore.getState().addNote(SESSION, '   ')).toBeNull();
		expect(useAutoRunSteeringStore.getState().notes[SESSION]).toBeUndefined();
	});

	it('rejects a note past the pending cap', () => {
		for (let i = 0; i < MAX_PENDING_STEERING_NOTES; i++) {
			expect(useAutoRunSteeringStore.getState().addNote(SESSION, `note ${i}`)).not.toBeNull();
		}
		expect(useAutoRunSteeringStore.getState().addNote(SESSION, 'one too many')).toBeNull();
		expect(useAutoRunSteeringStore.getState().notes[SESSION]).toHaveLength(
			MAX_PENDING_STEERING_NOTES
		);
	});

	it('takeNotes reads and clears in one step so a note is never delivered twice', () => {
		useAutoRunSteeringStore.getState().addNote(SESSION, 'first');
		useAutoRunSteeringStore.getState().addNote(SESSION, 'second');

		const taken = useAutoRunSteeringStore.getState().takeNotes(SESSION);
		expect(taken.map((n) => n.text)).toEqual(['first', 'second']);
		expect(useAutoRunSteeringStore.getState().notes[SESSION]).toBeUndefined();
		expect(useAutoRunSteeringStore.getState().takeNotes(SESSION)).toEqual([]);
	});

	it('takeNotes moves the notes onto the delivered list so the panel keeps the record', () => {
		useAutoRunSteeringStore.getState().addNote(SESSION, 'first');
		useAutoRunSteeringStore.getState().takeNotes(SESSION);
		useAutoRunSteeringStore.getState().addNote(SESSION, 'second');
		useAutoRunSteeringStore.getState().takeNotes(SESSION);

		expect(useAutoRunSteeringStore.getState().delivered[SESSION].map((n) => n.text)).toEqual([
			'first',
			'second',
		]);
	});

	it('caps the delivered list, keeping the newest notes', () => {
		for (let i = 0; i < MAX_DELIVERED_STEERING_NOTES + 5; i++) {
			useAutoRunSteeringStore.getState().addNote(SESSION, `note ${i}`);
			useAutoRunSteeringStore.getState().takeNotes(SESSION);
		}
		const history = useAutoRunSteeringStore.getState().delivered[SESSION];
		expect(history).toHaveLength(MAX_DELIVERED_STEERING_NOTES);
		expect(history[history.length - 1].text).toBe(`note ${MAX_DELIVERED_STEERING_NOTES + 4}`);
	});

	it('keeps sessions independent', () => {
		useAutoRunSteeringStore.getState().addNote(SESSION, 'mine');
		useAutoRunSteeringStore.getState().addNote('session-2', 'theirs');

		useAutoRunSteeringStore.getState().takeNotes(SESSION);
		expect(useAutoRunSteeringStore.getState().notes['session-2']).toHaveLength(1);
		expect(useAutoRunSteeringStore.getState().delivered['session-2']).toBeUndefined();
	});

	it('removes one pending note and leaves the rest', () => {
		const first = useAutoRunSteeringStore.getState().addNote(SESSION, 'first')!;
		useAutoRunSteeringStore.getState().addNote(SESSION, 'second');

		useAutoRunSteeringStore.getState().removeNote(SESSION, first.id);
		expect(useAutoRunSteeringStore.getState().notes[SESSION]).toHaveLength(1);
		expect(useAutoRunSteeringStore.getState().notes[SESSION][0].text).toBe('second');
	});

	it('removeNote cannot un-send a note a task already took', () => {
		const note = useAutoRunSteeringStore.getState().addNote(SESSION, 'gone')!;
		useAutoRunSteeringStore.getState().takeNotes(SESSION);

		useAutoRunSteeringStore.getState().removeNote(SESSION, note.id);
		expect(useAutoRunSteeringStore.getState().delivered[SESSION]).toHaveLength(1);
	});

	it('clearNotes drops both lists for a session', () => {
		useAutoRunSteeringStore.getState().addNote(SESSION, 'first');
		useAutoRunSteeringStore.getState().takeNotes(SESSION);
		useAutoRunSteeringStore.getState().addNote(SESSION, 'second');

		useAutoRunSteeringStore.getState().clearNotes(SESSION);
		expect(useAutoRunSteeringStore.getState().notes[SESSION]).toBeUndefined();
		expect(useAutoRunSteeringStore.getState().delivered[SESSION]).toBeUndefined();
	});

	it('clearPendingNotes keeps the delivered record, since a reply lands as the run ends', () => {
		const taken = useAutoRunSteeringStore.getState().addNote(SESSION, 'stop after this doc')!;
		useAutoRunSteeringStore.getState().takeNotes(SESSION);
		useAutoRunSteeringStore.getState().recordResponse(SESSION, [taken.id], {
			summary: '[steered] Halting after this document.',
			text: '[steered] Halting after this document.',
			success: true,
		});
		useAutoRunSteeringStore.getState().addNote(SESSION, 'never taken');

		useAutoRunSteeringStore.getState().clearPendingNotes(SESSION);

		expect(useAutoRunSteeringStore.getState().notes[SESSION]).toBeUndefined();
		const [kept] = useAutoRunSteeringStore.getState().delivered[SESSION];
		expect(kept.response?.summary).toBe('[steered] Halting after this document.');
	});

	describe('replies', () => {
		const reply = (text: string, success = true) => ({ summary: text, text, success });

		it('stamps every note one task took with the same delivery', () => {
			useAutoRunSteeringStore.getState().addNote(SESSION, 'first');
			useAutoRunSteeringStore.getState().addNote(SESSION, 'second');
			useAutoRunSteeringStore.getState().takeNotes(SESSION);
			useAutoRunSteeringStore.getState().addNote(SESSION, 'third');
			useAutoRunSteeringStore.getState().takeNotes(SESSION);

			const [a, b, c] = useAutoRunSteeringStore.getState().delivered[SESSION];
			expect(a.deliveryId).toBe(b.deliveryId);
			expect(c.deliveryId).not.toBe(a.deliveryId);
		});

		it('attaches a reply only to the notes that task took', () => {
			useAutoRunSteeringStore.getState().addNote(SESSION, 'first');
			const first = useAutoRunSteeringStore.getState().takeNotes(SESSION);
			useAutoRunSteeringStore.getState().addNote(SESSION, 'second');
			useAutoRunSteeringStore.getState().takeNotes(SESSION);

			useAutoRunSteeringStore.getState().recordResponse(
				SESSION,
				first.map((n) => n.id),
				reply('  [steered] switched endpoints  ')
			);

			const [a, b] = useAutoRunSteeringStore.getState().delivered[SESSION];
			expect(a.response).toMatchObject({
				summary: '[steered] switched endpoints',
				text: '[steered] switched endpoints',
				success: true,
			});
			expect(a.response!.timestamp).toBeGreaterThan(0);
			expect(b.response).toBeUndefined();
		});

		it('keeps a failed task as a reply rather than leaving the note waiting', () => {
			const note = useAutoRunSteeringStore.getState().addNote(SESSION, 'first')!;
			useAutoRunSteeringStore.getState().takeNotes(SESSION);

			useAutoRunSteeringStore
				.getState()
				.recordResponse(SESSION, [note.id], reply('context limit reached', false));

			expect(useAutoRunSteeringStore.getState().delivered[SESSION][0].response?.success).toBe(
				false
			);
		});

		it('does not resurrect a note a new run already cleared', () => {
			const note = useAutoRunSteeringStore.getState().addNote(SESSION, 'first')!;
			useAutoRunSteeringStore.getState().takeNotes(SESSION);
			useAutoRunSteeringStore.getState().clearNotes(SESSION);

			useAutoRunSteeringStore.getState().recordResponse(SESSION, [note.id], reply('late'));

			expect(useAutoRunSteeringStore.getState().delivered[SESSION]).toBeUndefined();
		});

		it('caps a runaway reply', () => {
			const note = useAutoRunSteeringStore.getState().addNote(SESSION, 'first')!;
			useAutoRunSteeringStore.getState().takeNotes(SESSION);

			useAutoRunSteeringStore.getState().recordResponse(SESSION, [note.id], {
				summary: 'short',
				text: 'x'.repeat(MAX_STEERING_RESPONSE_LENGTH + 500),
				success: true,
			});

			expect(useAutoRunSteeringStore.getState().delivered[SESSION][0].response!.text).toHaveLength(
				MAX_STEERING_RESPONSE_LENGTH
			);
		});

		it("groups notes by the task that took them, with that task's one reply", () => {
			useAutoRunSteeringStore.getState().addNote(SESSION, 'first');
			useAutoRunSteeringStore.getState().addNote(SESSION, 'second');
			const batch = useAutoRunSteeringStore.getState().takeNotes(SESSION);
			useAutoRunSteeringStore.getState().recordResponse(
				SESSION,
				batch.map((n) => n.id),
				reply('[steered] did both')
			);
			useAutoRunSteeringStore.getState().addNote(SESSION, 'third');
			useAutoRunSteeringStore.getState().takeNotes(SESSION);

			const deliveries = groupSteeringDeliveries(
				useAutoRunSteeringStore.getState().delivered[SESSION]
			);

			expect(deliveries.map((d) => d.notes.map((n) => n.text))).toEqual([
				['first', 'second'],
				['third'],
			]);
			expect(deliveries[0].response?.summary).toBe('[steered] did both');
			// The second task is still running: delivered, not yet answered.
			expect(deliveries[1].response).toBeUndefined();
		});

		it('groups nothing into nothing', () => {
			expect(groupSteeringDeliveries([])).toEqual([]);
		});
	});

	it('hands back a stable empty array so the selectors never churn subscribers', () => {
		const state = useAutoRunSteeringStore.getState();
		expect(selectPendingSteeringNotes(SESSION)(state)).toBe(
			selectPendingSteeringNotes('other')(state)
		);
		expect(selectDeliveredSteeringNotes(SESSION)(state)).toBe(
			selectDeliveredSteeringNotes('other')(state)
		);
	});
});
