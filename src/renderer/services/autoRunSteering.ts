/**
 * Auto Run steering - operator-side helpers.
 *
 * The steering surface is the Thought Stream panel, and nothing here touches an
 * AI tab. That is the whole point of the split: an Auto Run dispatches a fresh
 * agent per task, so a note is a property of the RUN, and routing it through the
 * chat composer made a message typed at an agent silently mean something else.
 * The panel owns both halves of the gesture now - the Steer button that sends a
 * note, and the list that shows what is still pending.
 *
 * `runRemoteSteeringCommand` is the same three gestures - send, read, take back -
 * for a caller that is not looking at the panel (`maestro-cli steer-auto-run`).
 * It runs the functions below rather than a copy of them, and it asks
 * `steeringBlocker` the same question the panel's Steer button asks, so a click
 * and a CLI call cannot disagree about whether a run can be steered.
 *
 * `submitSteeringNote` parks a note; `takeSteeringNotesForDispatch` hands the
 * pending ones to the task about to run; `recordSteeringResponse` brings that
 * task's reply back to them. All three live here rather than in the store
 * so the store stays pure state, and rather than in the panel so the batch
 * runner can consume notes without importing anything from the view layer.
 */

import { notifyCenterFlash } from '../stores/centerFlashStore';
import { useBatchStore } from '../stores/batchStore';
import {
	groupSteeringDeliveries,
	useAutoRunSteeringStore,
	type SteeringDelivery,
} from '../stores/autoRunSteeringStore';
import {
	MAX_PENDING_STEERING_NOTES,
	normalizeSteeringNoteText,
	type AutoRunSteeringNote,
} from '../../shared/autorunSteering';
import type {
	SteeringCommandRequest,
	SteeringCommandResult,
	SteeringDeliverySummary,
	SteeringNoteSummary,
} from '../../shared/autoRunSteeringCommands';
import { readBackgroundField } from '../../shared/focusPlacement';
import type { BatchRunState } from '../types';

/**
 * Why a run cannot be steered from this client, or `null` when it can.
 *
 * The one statement of the rule, read by the panel's Steer button and by the
 * CLI's `send`. Only a run THIS client owns can be steered: the notes are
 * renderer state, so a mirrored run's loop is in another client and would never
 * read them. A Steer button, or a `send`, that quietly did nothing is worse
 * than a refusal.
 */
export function steeringBlocker(run: BatchRunState | undefined): string | null {
	if (!run?.isRunning) return 'No Auto Run is active on this agent';
	if (run.mirrored === true) {
		return 'This Auto Run is owned by another Maestro client, and only that client can steer it';
	}
	return null;
}

export interface SubmitSteeringNoteArgs {
	sessionId: string;
	text: string;
	/**
	 * Show the on-screen acknowledgement. Defaults to true, which is what a
	 * click wants. A caller that reports the outcome itself and is not in front
	 * of the user (`steer-auto-run send --background`) passes false. It is the
	 * NOTICE this suppresses, never the note.
	 */
	announce?: boolean;
}

/**
 * Park a steering note for the next Auto Run task.
 *
 * Returns the stored note, or `null` when it was not accepted (empty text, or
 * the pending cap is reached) and says so on screen. A refusal has to be
 * visible: the only other record of the note is the pending list, so a silent
 * `null` would read as the Send button doing nothing.
 */
export function submitSteeringNote(args: SubmitSteeringNoteArgs): AutoRunSteeringNote | null {
	const { sessionId, text, announce = true } = args;
	const note = useAutoRunSteeringStore.getState().addNote(sessionId, text);
	if (!note) {
		// An empty draft is the caller's to guard; reaching here with text means
		// the cap bit, which is the case worth naming.
		if (announce && normalizeSteeringNoteText(text)) {
			notifyCenterFlash({
				message: 'Too many steering notes',
				detail: `${MAX_PENDING_STEERING_NOTES} are already waiting for the next task`,
				color: 'orange',
			});
		}
		return null;
	}

	if (announce) {
		notifyCenterFlash({
			message: 'Steering note queued',
			detail: 'Delivered at the start of the next Auto Run task',
			color: 'theme',
		});
	}
	return note;
}

/**
 * Cancel a pending note. No-op once a task has taken it - the note has moved to
 * the delivered list, and un-sending something the agent already read is not a
 * thing this can offer.
 */
export function cancelSteeringNote(sessionId: string, noteId: string): void {
	useAutoRunSteeringStore.getState().removeNote(sessionId, noteId);
}

/**
 * Consume every pending note for a session, for the task that is about to be
 * dispatched.
 *
 * Read-and-clear is atomic in the store, so a note the operator sends between
 * this call and the spawn belongs to the NEXT task rather than being lost.
 */
export function takeSteeringNotesForDispatch(sessionId: string): AutoRunSteeringNote[] {
	return useAutoRunSteeringStore.getState().takeNotes(sessionId);
}

/**
 * Attach a finished task's reply to the notes it was dispatched with, so the
 * panel can show what the agent did about them.
 *
 * Called for EVERY settled task, failed ones included: a note whose task blew up
 * must say so rather than sit on "working on it" for the rest of the run. No-op
 * for a task that took no notes, which is nearly all of them.
 */
export function recordSteeringResponse(
	sessionId: string,
	notes: readonly AutoRunSteeringNote[],
	response: { summary: string; text: string; success: boolean }
): void {
	if (notes.length === 0) return;
	useAutoRunSteeringStore.getState().recordResponse(
		sessionId,
		notes.map((note) => note.id),
		response
	);
}

/** Clear anything pending or delivered. Run START owns this: a new run begins clean. */
export function clearSteeringNotes(sessionId: string): void {
	useAutoRunSteeringStore.getState().clearNotes(sessionId);
}

/**
 * Drop the notes no task took, keeping the delivered record and its replies.
 * Run END owns this. The reply to a run's last note lands as the run finishes,
 * so clearing the delivered list here would erase it the moment it arrived.
 */
export function clearPendingSteeringNotes(sessionId: string): void {
	useAutoRunSteeringStore.getState().clearPendingNotes(sessionId);
}

/** Drop the store-only fields: the wire carries what a caller can act on. */
function toNoteSummary(note: AutoRunSteeringNote): SteeringNoteSummary {
	return { id: note.id, text: note.text, timestamp: note.timestamp };
}

function toDeliverySummary(delivery: SteeringDelivery): SteeringDeliverySummary {
	return {
		deliveryId: delivery.deliveryId,
		notes: delivery.notes.map(toNoteSummary),
		...(delivery.response ? { reply: { ...delivery.response } } : {}),
	};
}

/**
 * Answer one steering verb from outside the panel (`maestro-cli steer-auto-run`).
 *
 * Always RESOLVES with a result rather than throwing: the caller is a CLI
 * process reporting to an agent, and "nothing is running" has to arrive as an
 * answer it can read rather than as a broken command.
 *
 * `list` works whether or not a run is in flight. The delivered notes of a run
 * that has finished are exactly what a caller comes back to read, so it reports
 * `steerable` beside them instead of refusing.
 */
export function runRemoteSteeringCommand(request: SteeringCommandRequest): SteeringCommandResult {
	const { action, sessionId } = request;
	// The main process already refuses a request with no agent, but this is also
	// reachable from a client on a different build, and a note parked under
	// `undefined` would wait for a run that does not exist.
	if (!sessionId) return { success: false, error: `steering ${action} requires an agent` };

	const store = useAutoRunSteeringStore.getState();
	const blocker = steeringBlocker(useBatchStore.getState().batchRunStates[sessionId]);

	if (action === 'list') {
		return {
			success: true,
			steerable: blocker === null,
			pending: (store.notes[sessionId] ?? []).map(toNoteSummary),
			deliveries: groupSteeringDeliveries(store.delivered[sessionId] ?? []).map(toDeliverySummary),
		};
	}

	if (action === 'send') {
		if (blocker) return { success: false, error: blocker };
		const text = normalizeSteeringNoteText(request.text ?? '');
		if (!text) return { success: false, error: 'A steering note needs some text' };
		const note = submitSteeringNote({
			sessionId,
			text,
			announce: !readBackgroundField(request),
		});
		if (!note) {
			return {
				success: false,
				error: `${MAX_PENDING_STEERING_NOTES} steering notes are already waiting for the next task`,
			};
		}
		return { success: true, note: toNoteSummary(note) };
	}

	const noteId = request.noteId;
	if (!noteId) return { success: false, error: 'steering cancel requires a note id' };
	const target = (store.notes[sessionId] ?? []).find((note) => note.id === noteId);
	if (!target) {
		// Say WHY when a task got there first: "no such note" for a note the
		// caller just listed reads as a bug rather than as being too late.
		const taken = (store.delivered[sessionId] ?? []).some((note) => note.id === noteId);
		return {
			success: false,
			error: taken
				? 'That steering note was already delivered to a task and cannot be taken back'
				: `No pending steering note with id ${noteId}`,
		};
	}
	cancelSteeringNote(sessionId, noteId);
	return { success: true, note: toNoteSummary(target) };
}
