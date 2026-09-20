import { describe, it, expect, beforeEach } from 'vitest';
import {
	useAutoRunSteeringStore,
	selectDeliveredSteeringNotes,
	selectPendingSteeringNotes,
	MAX_DELIVERED_STEERING_NOTES,
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

	it('hands back a stable empty array so the selectors never churn subscribers', () => {
		const state = useAutoRunSteeringStore.getState();
		expect(selectPendingSteeringNotes(SESSION)(state)).toBe(
			selectPendingSteeringNotes('other')(state)
		);
		expect(selectDeliveredSteeringNotes(SESSION)(state)).toBe(
			selectPendingSteeringNotes('other')(state)
		);
	});
});
