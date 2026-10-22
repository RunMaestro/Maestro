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
 * A delivered note also carries the REPLY of the task that took it. A check mark
 * only says the note reached a prompt; what the operator wants to know is what
 * the agent did about it, and the task's own synopsis is that answer. Every note
 * one task took shares a `deliveryId`, because they were answered together by a
 * single reply - `groupSteeringDeliveries` is what a view renders from, so the
 * reply is drawn once under its notes rather than once per note.
 *
 * Lifetimes differ. PENDING notes die with the run: one that outlived the run it
 * was steering would land in front of an unrelated task days later. DELIVERED
 * notes survive until the NEXT run starts, because the reply to the last note of
 * a run arrives as the run ends - and a note that asks the run to stop ends it.
 * Clearing them at run end erased that reply the instant it landed. Nothing here
 * is persisted.
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

/**
 * Longest reply kept per delivery. A reply is a whole task response, and the
 * delivered list is held in memory for the life of the run, so one runaway
 * response must not be able to pin megabytes behind a two-line row.
 */
export const MAX_STEERING_RESPONSE_LENGTH = 20000;

/** What the task that took a note said back. */
export interface SteeringNoteResponse {
	/** One-line synopsis of the task - the collapsed form. */
	summary: string;
	/** The task's whole reply (or its error, when it failed). */
	text: string;
	/** False when the task that took the note failed. */
	success: boolean;
	/** When the task finished (ms epoch). */
	timestamp: number;
}

/** A note a task has taken, plus that task's reply once it has finished. */
export interface DeliveredSteeringNote extends AutoRunSteeringNote {
	/** Shared by every note one task took together - they have ONE reply. */
	deliveryId: string;
	/** Absent while the task that took the note is still running. */
	response?: SteeringNoteResponse;
}

/** The notes one task took, and its single reply to all of them. */
export interface SteeringDelivery {
	deliveryId: string;
	notes: DeliveredSteeringNote[];
	response?: SteeringNoteResponse;
}

export interface AutoRunSteeringState {
	/** sessionId -> notes waiting for the next task, oldest first. */
	notes: Record<string, AutoRunSteeringNote[]>;
	/** sessionId -> notes a task has already taken, oldest first. */
	delivered: Record<string, DeliveredSteeringNote[]>;
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
	/**
	 * Attach a finished task's reply to the notes it took. Notes that are no
	 * longer on the delivered list (trimmed by the cap, or dropped by a new run)
	 * are skipped rather than resurrected.
	 */
	recordResponse: (
		sessionId: string,
		noteIds: readonly string[],
		response: Pick<SteeringNoteResponse, 'summary' | 'text' | 'success'>
	) => void;
	/** Drop what no task has taken yet, keeping the delivered record (run end). */
	clearPendingNotes: (sessionId: string) => void;
	/** Drop everything for a session, pending and delivered (run start). */
	clearNotes: (sessionId: string) => void;
}

export type AutoRunSteeringStore = AutoRunSteeringState & AutoRunSteeringActions;

const EMPTY_NOTES: AutoRunSteeringNote[] = [];
const EMPTY_DELIVERED: DeliveredSteeringNote[] = [];

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
			const deliveryId = generateId();
			const history = [
				...(s.delivered[sessionId] ?? EMPTY_DELIVERED),
				...taken.map((note) => ({ ...note, deliveryId })),
			];
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

	recordResponse: (sessionId, noteIds, response) =>
		set((s) => {
			const existing = s.delivered[sessionId];
			if (!existing || noteIds.length === 0) return {};
			const ids = new Set(noteIds);
			if (!existing.some((note) => ids.has(note.id))) return {};
			const stamped: SteeringNoteResponse = {
				summary: response.summary.trim(),
				text: response.text.trim().slice(0, MAX_STEERING_RESPONSE_LENGTH),
				success: response.success,
				timestamp: Date.now(),
			};
			return {
				delivered: {
					...s.delivered,
					[sessionId]: existing.map((note) =>
						ids.has(note.id) ? { ...note, response: stamped } : note
					),
				},
			};
		}),

	clearPendingNotes: (sessionId) =>
		set((s) => {
			if (!s.notes[sessionId]) return {};
			const nextNotes = { ...s.notes };
			delete nextNotes[sessionId];
			return { notes: nextNotes };
		}),

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
	(s: AutoRunSteeringState): DeliveredSteeringNote[] =>
		s.delivered[sessionId] ?? EMPTY_DELIVERED;

/**
 * Fold a delivered list into one entry per task that took notes, oldest first.
 *
 * A delivery is a run of ADJACENT notes sharing a `deliveryId`: notes are
 * appended a whole delivery at a time, so adjacency is the grouping and a view
 * never has to sort. The delivered cap can trim the front of the oldest
 * delivery, which leaves a shorter group rather than a broken one.
 */
export function groupSteeringDeliveries(
	delivered: readonly DeliveredSteeringNote[]
): SteeringDelivery[] {
	const deliveries: SteeringDelivery[] = [];
	for (const note of delivered) {
		const last = deliveries[deliveries.length - 1];
		if (last && last.deliveryId === note.deliveryId) {
			last.notes.push(note);
			// One reply per delivery, so any note that has it speaks for the group.
			last.response ??= note.response;
		} else {
			deliveries.push({
				deliveryId: note.deliveryId,
				notes: [note],
				response: note.response,
			});
		}
	}
	return deliveries;
}
