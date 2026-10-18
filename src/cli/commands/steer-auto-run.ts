// Steering commands - course-correct an Auto Run without stopping it, mirroring
// the Thought Stream panel's Steer Auto Run bar. A note parks until the run
// dispatches its next task and then opens that task's prompt; `list` reads back
// what was sent and what each task said in reply.
//
// Every verb rides the one `auto_run_steering_command` message. The notes are
// held by the desktop renderer whose run loop reads them, so these fail with the
// usual "not running" error when the app is down.

import {
	sendSimpleCommand,
	failCommand,
	resolveAgentOrFail,
	type SimpleResult,
} from '../services/session-command';
import { formatSuccess } from '../output/formatter';
import { isQuiet } from '../output/verbosity';
import { resolveBackgroundFlag } from '../../shared/focusPlacement';
import { MAX_STEERING_NOTE_LENGTH } from '../../shared/autorunSteering';
import type {
	SteeringCommandRequest,
	SteeringDeliverySummary,
	SteeringNoteSummary,
} from '../../shared/autoRunSteeringCommands';

export interface SteerAutoRunOptions {
	agent: string;
	background?: boolean;
	focus?: boolean;
	json?: boolean;
}

interface SteeringResponse extends SimpleResult {
	note?: SteeringNoteSummary;
	steerable?: boolean;
	pending?: SteeringNoteSummary[];
	deliveries?: SteeringDeliverySummary[];
}

/** Send one steering verb and hand back the desktop's answer. */
async function sendSteering(
	request: SteeringCommandRequest,
	json?: boolean
): Promise<SteeringResponse> {
	try {
		const result = (await sendSimpleCommand(
			{ type: 'auto_run_steering_command', ...request },
			'auto_run_steering_command_result'
		)) as SteeringResponse;
		if (!result.success) failCommand(result.error || 'Steering command failed', json);
		return result;
	} catch (error) {
		return failCommand(error instanceof Error ? error.message : String(error), json);
	}
}

function formatTime(timestamp: number): string {
	return new Date(timestamp).toLocaleTimeString([], {
		hour: 'numeric',
		minute: '2-digit',
		second: '2-digit',
	});
}

/** A note on one line, however many the operator typed. */
function oneLine(text: string): string {
	return text.replace(/\s*\n\s*/g, ' / ');
}

/** What a delivery's task said back, for a human. */
function describeReply(delivery: SteeringDeliverySummary, steerable: boolean): string {
	const { reply } = delivery;
	if (!reply) {
		// No run in flight means no task is left to answer.
		return steerable ? 'still working' : 'the run ended before this task replied';
	}
	const line = oneLine(reply.summary || reply.text);
	return reply.success ? line : `FAILED: ${line}`;
}

/**
 * `maestro-cli steer-auto-run send <note> -a <agent>` - park a note for the
 * next task of a running Auto Run.
 *
 * The length is checked HERE as well as on the far side: the panel caps a note
 * as it is typed, where the operator watches the box stop accepting text, but a
 * note cut off in transit would be an instruction nobody wrote.
 */
export async function steerAutoRunSend(note: string, options: SteerAutoRunOptions): Promise<void> {
	const text = (note ?? '').trim();
	if (!text) failCommand('A steering note needs some text', options.json);
	if (text.length > MAX_STEERING_NOTE_LENGTH) {
		failCommand(
			`Steering note is ${text.length} characters; the limit is ${MAX_STEERING_NOTE_LENGTH}`,
			options.json
		);
	}
	const sessionId = resolveAgentOrFail(options.agent, options.json);

	const result = await sendSteering(
		{
			action: 'send',
			sessionId,
			text,
			background: resolveBackgroundFlag(options, 'steer-auto-run'),
		},
		options.json
	);

	if (options.json) {
		console.log(JSON.stringify({ success: true, sessionId, note: result.note ?? null }, null, 2));
		return;
	}
	if (isQuiet()) return;
	console.log(
		formatSuccess(`Steering note queued for ${sessionId}; it opens the next Auto Run task`)
	);
	if (result.note) console.log(`  Note: ${result.note.id}`);
}

/**
 * `maestro-cli steer-auto-run list -a <agent>` - the notes still waiting, and
 * the ones a task took together with that task's reply.
 *
 * Works after the run has ended: the reply to a run's last note lands as the
 * run finishes, so this is the read a caller comes back for.
 */
export async function steerAutoRunList(options: SteerAutoRunOptions): Promise<void> {
	const sessionId = resolveAgentOrFail(options.agent, options.json);
	const result = await sendSteering({ action: 'list', sessionId }, options.json);
	const steerable = result.steerable === true;
	const pending = result.pending ?? [];
	const deliveries = result.deliveries ?? [];

	if (options.json) {
		console.log(
			JSON.stringify({ success: true, sessionId, steerable, pending, deliveries }, null, 2)
		);
		return;
	}

	console.log(
		steerable
			? `An Auto Run on ${sessionId} is running and can be steered.`
			: `No steerable Auto Run on ${sessionId}.`
	);
	if (pending.length === 0 && deliveries.length === 0) {
		console.log('No steering notes.');
		return;
	}
	if (pending.length > 0) {
		console.log(`Waiting for the next task (${pending.length}):`);
		for (const note of pending) {
			console.log(`  ${note.id}  ${formatTime(note.timestamp)}  ${oneLine(note.text)}`);
		}
	}
	if (deliveries.length > 0) {
		console.log(`Delivered (${deliveries.length}):`);
		for (const delivery of deliveries) {
			for (const note of delivery.notes) {
				console.log(`  ${formatTime(note.timestamp)}  ${oneLine(note.text)}`);
			}
			console.log(`    reply: ${describeReply(delivery, steerable)}`);
		}
		console.log('Pass --json for each full reply.');
	}
}

/**
 * `maestro-cli steer-auto-run cancel <note-id> -a <agent>` - take back a note
 * no task has read yet. Accepts a unique id prefix, resolved against the
 * pending list so the far side is always handed a whole id.
 */
export async function steerAutoRunCancel(
	noteId: string,
	options: SteerAutoRunOptions
): Promise<void> {
	const wanted = (noteId ?? '').trim();
	if (!wanted) failCommand('A note id is required', options.json);
	const sessionId = resolveAgentOrFail(options.agent, options.json);

	const listed = await sendSteering({ action: 'list', sessionId }, options.json);
	const pending = listed.pending ?? [];
	let target = pending.find((note) => note.id === wanted);
	if (!target) {
		const matches = pending.filter((note) => note.id.startsWith(wanted));
		if (matches.length > 1) {
			failCommand(`Ambiguous note id '${wanted}' (${matches.length} matches)`, options.json);
		}
		target = matches[0];
	}
	// An id that matches nothing pending is still sent: the desktop knows whether
	// a task already took that note, and says so, which this side cannot.
	const result = await sendSteering(
		{ action: 'cancel', sessionId, noteId: target?.id ?? wanted },
		options.json
	);

	if (options.json) {
		console.log(JSON.stringify({ success: true, sessionId, note: result.note ?? null }, null, 2));
		return;
	}
	if (isQuiet()) return;
	console.log(
		formatSuccess(
			`Cancelled steering note: ${oneLine(result.note?.text ?? target?.text ?? wanted)}`
		)
	);
}
