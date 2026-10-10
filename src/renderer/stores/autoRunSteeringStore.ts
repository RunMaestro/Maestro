/**
 * autoRunSteeringStore - Auto Run steering notes, keyed by session.
 *
 * Deliberately NOT part of `batchRunStates` (batchStore). That record is
 * rewritten wholesale by the runner's debounced flush (`setBatchRunStates`
 * resolving a captured snapshot), so a note added between a flush being
 * scheduled and applied would be silently dropped. Notes live in their own
 * store, which nothing else writes, so the only way one disappears is being
 * consumed by a task or cancelled by the operator.
 *
 * TWO lists, not one. `notes` is what the next task will pick up; `delivered`
 * is what a task already took. They are separate because they answer different
 * questions and only one of them is still cancellable - collapsing them into a
 * single list with a status field would put that filter at every read site, and
 * the first one that forgot it would offer a Cancel button for a note the agent
 * has already acted on. The delivered list is what the Thought Stream renders as
 * the run's record of being steered; before the steering UI moved into that
 * panel, the record was a transcript entry in the AI chat, which is exactly the
 * coupling this replaces.
 *
 * Lifetime is the run for both: cleared when a run starts and when it finishes.
 * Nothing here is persisted - a note that outlived the run it was steering would
 * land in front of an unrelated task days later.
 */

import { create } from 'zustand';
import {
	MAX_PENDING_STEERING_NOTES,
	normalizeSteeringNoteText,
	type AutoRunSteeringNote,
} from '../../shared/autorunSteering';
import { generateId } from '../utils/ids';

/**
 * How many delivered notes are remembered per run. The list is a record for the
 * operator, not an audit log, and a goal-mode run can dispatch hundreds of
 * tasks - keeping every note forever would grow a store that nothing prunes.
 * Oldest are dropped first.
 */
export const MAX_DELIVERED_STEERING_NOTES = 50;

export interface AutoRunSteeringState {
	/** sessionId -> notes waiting for the next task, oldest first. */
	notes: Record<string, AutoRunSteeringNote[]>;
	/** sessionId -> notes a task has already taken, oldest first. */
	delivered: Record<string, AutoRunSteeringNote[]>;
}

export interface AutoRunSteeringActions {
	/**
	 * Park a note for the next task. Returns the stored note, or `null` when the
	 * text was empty or the queue is already at `MAX_PENDING_STEERING_NOTES` -
	 * callers surface the refusal rather than dropping what was typed.
	 */
	addNote: (sessionId: string, text: string) => AutoRunSteeringNote | null;
	/** Cancel a pending note. No-op once a task has taken it. */
	removeNote: (sessionId: string, noteId: string) => void;
	/**
	 * Read and clear atomically - the notes are now the caller's to deliver -
	 * and move them onto the delivered list so the panel keeps showing them.
	 */
	takeNotes: (sessionId: string) => AutoRunSteeringNote[];
	/** Drop everything for a session, pending and delivered (run start / run end). */
	clearNotes: (sessionId: string) => void;
}

export type AutoRunSteeringStore = AutoRunSteeringState & AutoRunSteeringActions;

const EMPTY_NOTES: AutoRunSteeringNote[] = [];

export const useAutoRunSteeringStore = create<AutoRunSteeringStore>()((set, get) => ({
	notes: {},
	delivered: {},

	addNote: (sessionId, text) => {
		const normalized = normalizeSteeringNoteText(text);
		if (!normalized) return null;

		const existing = get().notes[sessionId] ?? EMPTY_NOTES;
		if (existing.length >= MAX_PENDING_STEERING_NOTES) return null;

		const note: AutoRunSteeringNote = {
			id: generateId(),
			text: normalized,
			timestamp: Date.now(),
		};
		set((s) => ({ notes: { ...s.notes, [sessionId]: [...existing, note] } }));
		return note;
	},

	removeNote: (sessionId, noteId) =>
		set((s) => {
			const existing = s.notes[sessionId];
			if (!existing) return {};
			const remaining = existing.filter((note) => note.id !== noteId);
			if (remaining.length === existing.length) return {};
			const next = { ...s.notes };
			if (remaining.length === 0) delete next[sessionId];
			else next[sessionId] = remaining;
			return { notes: next };
		}),

	takeNotes: (sessionId) => {
		const taken = get().notes[sessionId];
		if (!taken || taken.length === 0) return EMPTY_NOTES;
		set((s) => {
			const nextNotes = { ...s.notes };
			delete nextNotes[sessionId];
			const history = [...(s.delivered[sessionId] ?? EMPTY_NOTES), ...taken];
			return {
				notes: nextNotes,
				delivered: {
					...s.delivered,
					[sessionId]: history.slice(-MAX_DELIVERED_STEERING_NOTES),
				},
			};
		});
		return taken;
	},

	clearNotes: (sessionId) =>
		set((s) => {
			if (!s.notes[sessionId] && !s.delivered[sessionId]) return {};
			const nextNotes = { ...s.notes };
			delete nextNotes[sessionId];
			const nextDelivered = { ...s.delivered };
			delete nextDelivered[sessionId];
			return { notes: nextNotes, delivered: nextDelivered };
		}),
}));

/** Pending notes for one session. Stable empty array so it is selector-safe. */
export const selectPendingSteeringNotes =
	(sessionId: string) =>
	(s: AutoRunSteeringState): AutoRunSteeringNote[] =>
		s.notes[sessionId] ?? EMPTY_NOTES;

/** Notes a task already took, for one session. Stable empty array. */
export const selectDeliveredSteeringNotes =
	(sessionId: string) =>
	(s: AutoRunSteeringState): AutoRunSteeringNote[] =>
		s.delivered[sessionId] ?? EMPTY_NOTES;
