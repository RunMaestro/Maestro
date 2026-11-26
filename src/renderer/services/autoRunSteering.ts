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
 * `runRemoteSteeringCommand` is the same four gestures - send, read, take back,
 * dismiss - for a caller that is not looking at the panel (`maestro-cli steer-auto-run`).
 *
 * A hosted agent's run is driven by its Federation host, so the same four
 * gestures also go to the host (`forwardToHost()`), and the host's own list
 * replaces what this window shows once it answers: one panel, one store, the
 * transport alone differs.
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
import { selectSessionById, useSessionStore } from '../stores/sessionStore';
import {
	groupSteeringDeliveries,
	MAX_DELIVERED_STEERING_NOTES,
	MAX_STEERING_RESPONSE_LENGTH,
	useAutoRunSteeringStore,
	type DeliveredSteeringNote,
	type SteeringDelivery,
} from '../stores/autoRunSteeringStore';
import {
	MAX_PENDING_STEERING_NOTES,
	MAX_STEERING_NOTE_LENGTH,
	normalizeSteeringNoteText,
	type AutoRunSteeringNote,
} from '../../shared/autorunSteering';
import type {
	SteeringCommandInput,
	SteeringCommandRequest,
	SteeringCommandResult,
	SteeringDeliverySummary,
	SteeringNoteSummary,
} from '../../shared/autoRunSteeringCommands';
import { createKeyedWriteQueue } from '../../shared/keyedWriteQueue';
import { hostedTargetOf, steerHostedAutoRun } from './hostedTurns';
import { readBackgroundField } from '../../shared/focusPlacement';
import type { BatchRunState } from '../types';

/**
 * Why a run cannot be steered from this client, or `null` when it can.
 *
 * The one statement of the rule, read by the panel's Steer button and by the
 * CLI's `send`. A run THIS client owns can be steered, and so can a hosted
 * agent's run (`sessionId` names the agent): its host takes the note
 * (`steerHostedAutoRun()`), as this client's own loop would. Any other mirrored
 * run's loop is in another client and would never read the notes. A Steer
 * button, or a `send`, that quietly did nothing is worse than a refusal.
 */
export function steeringBlocker(run: BatchRunState | undefined, sessionId?: string): string | null {
	if (!run?.isRunning) return 'No Auto Run is active on this agent';
	if (run.mirrored === true && !hostedSessionOf(sessionId)) {
		return 'This Auto Run is owned by another Maestro client, and only that client can steer it';
	}
	return null;
}

/** The agent record when its run is driven by its Federation host, else undefined. */
function hostedSessionOf(sessionId: string | undefined) {
	if (!sessionId) return undefined;
	const session = selectSessionById(sessionId)(useSessionStore.getState());
	return hostedTargetOf(session) ? session : undefined;
}

// ---------------------------------------------------------------------------
// A hosted agent's run: the host holds the notes
// ---------------------------------------------------------------------------

/**
 * One host conversation at a time per agent, so a list asked after a send reads the send, and
 * answers land in the order they were asked.
 */
const hostedSteeringQueue = createKeyedWriteQueue();

/** A note the host reported, type-checked and bounded; undefined when it is not one. */
function hostNote(raw: unknown): AutoRunSteeringNote | undefined {
	if (!raw || typeof raw !== 'object') return undefined;
	const note = raw as Record<string, unknown>;
	if (typeof note.id !== 'string' || !note.id || typeof note.text !== 'string') return undefined;
	return {
		id: note.id.slice(0, 200),
		text: note.text.slice(0, MAX_STEERING_NOTE_LENGTH),
		timestamp: typeof note.timestamp === 'number' ? note.timestamp : 0,
	};
}

/** The host's delivered notes as this window's store holds them, each with its delivery's reply. */
function hostDelivered(raw: unknown): DeliveredSteeringNote[] {
	if (!Array.isArray(raw)) return [];
	const delivered: DeliveredSteeringNote[] = [];
	for (const item of raw) {
		if (!item || typeof item !== 'object') continue;
		const delivery = item as Record<string, unknown>;
		if (typeof delivery.deliveryId !== 'string' || !Array.isArray(delivery.notes)) continue;
		const reply = delivery.reply as Record<string, unknown> | undefined;
		const response =
			reply && typeof reply === 'object' && typeof reply.text === 'string'
				? {
						summary: typeof reply.summary === 'string' ? reply.summary.slice(0, 500) : '',
						text: reply.text.slice(0, MAX_STEERING_RESPONSE_LENGTH),
						success: reply.success === true,
						timestamp: typeof reply.timestamp === 'number' ? reply.timestamp : 0,
					}
				: undefined;
		for (const rawNote of delivery.notes) {
			const note = hostNote(rawNote);
			if (!note) continue;
			delivered.push({
				...note,
				deliveryId: delivery.deliveryId.slice(0, 200),
				...(response ? { response } : {}),
			});
		}
	}
	return delivered.slice(-MAX_DELIVERED_STEERING_NOTES);
}

/** Replace what this window shows for a hosted agent with the host's own list. */
function applyHostList(sessionId: string, result: SteeringCommandResult): void {
	const pending = (Array.isArray(result.pending) ? result.pending : [])
		.map(hostNote)
		.filter((note): note is AutoRunSteeringNote => note !== undefined)
		.slice(0, MAX_PENDING_STEERING_NOTES);
	const delivered = hostDelivered(result.deliveries);
	useAutoRunSteeringStore.setState((state) => ({
		notes: { ...state.notes, [sessionId]: pending },
		delivered: { ...state.delivered, [sessionId]: delivered },
	}));
}

/** The host's id for a note this window showed first under its own, by that id. */
const hostNoteIds = new Map<string, string>();

interface ForwardOptions {
	/** The note this window shows while the host has not answered (a send). */
	localNoteId?: string;
	/** Say a refusal on screen. A caller that reports it itself (the CLI) passes false. */
	announce?: boolean;
	/** A background read: a host that cannot be reached raises no toast. */
	quiet?: boolean;
}

/**
 * Ask the host one steering command for a hosted agent, then read its list back into this
 * window's store, so the panel shows what the host holds. `input` is built when the command's
 * turn comes, so a cancel queued behind its send names the note by the host's id. Resolves with
 * the host's answer (the list, for a `list`), or null when the host could not be reached.
 */
function forwardToHost(
	sessionId: string,
	input: SteeringCommandInput | (() => SteeringCommandInput),
	options: ForwardOptions = {}
): Promise<SteeringCommandResult | null> {
	return hostedSteeringQueue.enqueue(sessionId, async () => {
		const session = hostedSessionOf(sessionId);
		if (!session) return null;
		const ask = typeof input === 'function' ? input() : input;
		let answer: SteeringCommandResult | null = null;
		if (ask.action !== 'list') {
			answer = (await steerHostedAutoRun(session, ask)) ?? null;
			if (answer?.success && options.localNoteId && answer.note?.id) {
				hostNoteIds.set(options.localNoteId, answer.note.id);
			}
			if (answer && !answer.success) {
				// The host said no: the note it refused is not waiting anywhere.
				if (options.localNoteId) {
					useAutoRunSteeringStore.getState().removeNote(sessionId, options.localNoteId);
				}
				if (options.announce !== false) {
					notifyCenterFlash({
						message: 'Steering note not delivered',
						detail: answer.error ?? 'The host refused it',
						color: 'orange',
					});
				}
			}
		}
		const listed =
			(await steerHostedAutoRun(session, { action: 'list' }, { quiet: options.quiet })) ?? null;
		if (listed?.success) applyHostList(sessionId, listed);
		return ask.action === 'list' ? listed : answer;
	});
}

/**
 * Read a hosted agent's notes and replies from its host again. The hosted sync calls it when it
 * first sees the host's run and as the run moves on (a task took the notes, or replied to them).
 * No-op for any other agent.
 */
export async function refreshHostedSteering(sessionId: string): Promise<void> {
	await forwardToHost(sessionId, { action: 'list' }, { quiet: true });
}

/**
 * Answer one steering verb from outside the panel (`maestro-cli steer-auto-run`). A hosted agent's
 * notes are on its host, so its verbs are the host's to answer, and the caller gets the host's own
 * result (its note ids, its refusals). Any other agent's are answered here
 * (`runRemoteSteeringCommand()`).
 */
export async function answerSteeringCommand(
	request: SteeringCommandRequest
): Promise<SteeringCommandResult> {
	const { sessionId } = request;
	if (!sessionId || !hostedSessionOf(sessionId)) return runRemoteSteeringCommand(request);
	if (request.action === 'send') {
		const blocker = steeringBlocker(useBatchStore.getState().batchRunStates[sessionId], sessionId);
		if (blocker) return { success: false, error: blocker };
	}
	const { sessionId: _agent, background: _notice, ...input } = request;
	const answer = await forwardToHost(sessionId, input, { announce: false });
	return answer ?? { success: false, error: 'The host that runs this agent could not be reached' };
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
			detail: 'Delivered at the start of the next Auto Run task or goal iteration',
			color: 'theme',
		});
	}
	// A hosted agent's run is on its host: the note goes there, and the host's list replaces this
	// one when it answers (the note shows as pending meanwhile, as a local one does).
	if (hostedSessionOf(sessionId)) {
		void forwardToHost(
			sessionId,
			{ action: 'send', text: note.text },
			{ localNoteId: note.id, announce }
		);
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
	if (hostedSessionOf(sessionId)) {
		// Named by the host's id once its send has answered (the queue runs this after it).
		void forwardToHost(sessionId, () => ({
			action: 'cancel',
			noteId: hostNoteIds.get(noteId) ?? noteId,
		}));
	}
}

/**
 * Clear one delivered group - the notes one task took and its reply - after the
 * operator has read it. The panel's X on a delivered note and
 * `steer-auto-run dismiss` both land here. Returns the group that was cleared,
 * or `null` when no delivery has that id (already dismissed, or a new run
 * cleared the record).
 */
export function dismissSteeringDelivery(
	sessionId: string,
	deliveryId: string
): SteeringDelivery | null {
	const store = useAutoRunSteeringStore.getState();
	const target = groupSteeringDeliveries(store.delivered[sessionId] ?? []).find(
		(delivery) => delivery.deliveryId === deliveryId
	);
	if (!target) return null;
	store.dismissDelivery(sessionId, deliveryId);
	if (hostedSessionOf(sessionId)) void forwardToHost(sessionId, { action: 'dismiss', deliveryId });
	return target;
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
	const blocker = steeringBlocker(useBatchStore.getState().batchRunStates[sessionId], sessionId);

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

	if (action === 'dismiss') {
		const deliveryId = request.deliveryId;
		if (!deliveryId) return { success: false, error: 'steering dismiss requires a delivery id' };
		const dismissed = dismissSteeringDelivery(sessionId, deliveryId);
		if (!dismissed) {
			// A pending note is not a delivery: point at the verb that takes it back.
			const pending = (store.notes[sessionId] ?? []).some((note) => note.id === deliveryId);
			return {
				success: false,
				error: pending
					? 'That is a pending note, not a delivery; take it back with steer-auto-run cancel'
					: `No delivered steering notes with delivery id ${deliveryId}`,
			};
		}
		return { success: true, delivery: toDeliverySummary(dismissed) };
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
