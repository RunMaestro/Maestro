/**
 * Auto Run steering notes - mid-run course correction without stopping the run.
 *
 * An Auto Run dispatches one fresh agent process per task. Between tasks there
 * is no conversation to interrupt, so the only way a human could previously
 * change course was to stop the run, edit the document, and start again - or to
 * queue a message, which spends a whole extra turn in a SEPARATE context that
 * the next task never sees.
 *
 * A steering note is the cheap path: the operator types while the run is going,
 * the note parks, and the next task's prompt opens with it. The note is not a
 * conversation turn and costs no extra spawn - it rides along with work that
 * was going to happen anyway.
 *
 * `formatSteeringNotesBlock` is the single definition of what the agent sees.
 * The matching "notes may arrive" briefing lives in `src/prompts/autorun-default.md`
 * so an agent that has never seen a note still knows the channel exists.
 */

/**
 * One note the operator sent while a run was in flight.
 *
 * `id` doubles as the id of the transcript entry that shows the note, so the
 * badge on that entry can be flipped from pending to delivered when the note is
 * consumed. See `src/renderer/services/autoRunSteering.ts`.
 */
export interface AutoRunSteeringNote {
	id: string;
	text: string;
	/** When the operator sent it (ms epoch). Rendered into the prompt block. */
	timestamp: number;
}

/**
 * Longest single note. A note rides in front of every remaining task's prompt
 * until it is consumed, so an unbounded paste would quietly dominate the turn
 * it was meant to nudge.
 */
export const MAX_STEERING_NOTE_LENGTH = 4000;

/**
 * How many notes may be pending at once. Notes are consumed by the next task,
 * so the cap only bites when the operator types faster than the run dispatches
 * (or while it is paused at a gate).
 */
export const MAX_PENDING_STEERING_NOTES = 20;

/** Opening marker of the injected block. Also used by tests to assert presence. */
export const STEERING_BLOCK_START = '<!-- MAESTRO:CONDUCTOR-NOTES -->';
/** Closing marker of the injected block. */
export const STEERING_BLOCK_END = '<!-- /MAESTRO:CONDUCTOR-NOTES -->';

/**
 * Trim and cap a note the operator typed. Returns `''` for anything that would
 * be an empty note, which callers treat as "nothing to send".
 */
export function normalizeSteeringNoteText(text: string): string {
	return text.trim().slice(0, MAX_STEERING_NOTE_LENGTH);
}

function formatNoteTime(timestamp: number): string {
	return new Date(timestamp).toLocaleTimeString([], {
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
	});
}

/**
 * Build the block that rides in front of the next task's prompt.
 *
 * Returns `''` when there are no notes, so callers can prepend unconditionally.
 *
 * The block is prepended AFTER template substitution on purpose: a `{{...}}`
 * the operator typed is their literal text, not a variable to expand.
 */
export function formatSteeringNotesBlock(notes: readonly AutoRunSteeringNote[]): string {
	if (notes.length === 0) return '';

	const lines = notes.map((note, index) => {
		// Indent continuation lines so a multi-line note stays inside its own
		// numbered item instead of breaking out of the list.
		const body = note.text.split('\n').join('\n   ');
		return `${index + 1}. (${formatNoteTime(note.timestamp)}) ${body}`;
	});

	const plural = notes.length === 1 ? 'note' : 'notes';

	return [
		STEERING_BLOCK_START,
		'',
		`## Conductor steering ${plural} - read this first`,
		'',
		'The human supervising this Auto Run sent the following WHILE the run was in',
		'progress. It arrived after everything below was written, so it is newer and it',
		'wins.',
		'',
		...lines,
		'',
		'How to act on the above:',
		'',
		'- Apply it to the task you are about to do, and keep applying it for the rest',
		'  of the run where it still makes sense.',
		'- If it contradicts the task, the document, or the instructions below, follow',
		'  the note and say in your synopsis which instruction you set aside.',
		'- If it asks you to stop the whole run, use the halt marker described below',
		'  rather than just exiting.',
		'- Begin your synopsis with `[steered]` so the operator can see it landed.',
		'',
		STEERING_BLOCK_END,
	].join('\n');
}
