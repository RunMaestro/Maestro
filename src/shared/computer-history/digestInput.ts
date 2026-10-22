/**
 * Computer History - what a LOCAL MODEL is shown to write a digest (pure).
 *
 * The digest agent is handed file paths and reads them with its own tools. A
 * local model has no tools and a small context, so its input is built here: a
 * segment becomes one compact line per event, and a 6-hour block becomes the
 * text of its 15-minute digests. Both are bounded by a character budget the
 * caller derives from the model's context.
 *
 * Everything rendered here is captured from the screen and UNTRUSTED. The
 * caller fences it (`fenceUntrusted`) before it reaches a model.
 */

import { ROLLUP_HOURS, SEGMENT_MINUTES } from './paths';
import type { StoredEvent } from './types';

/** The most text one event contributes, when the budget allows it. */
export const MAX_DIGEST_EVENT_TEXT_CHARS = 600;
/** The least text one event keeps, however many events share the budget. */
export const MIN_DIGEST_EVENT_TEXT_CHARS = 80;
/** The most one 15-minute digest contributes to a roll-up. */
export const MAX_ROLLUP_DIGEST_CHARS = 2400;
/** Room a line needs besides its text: time, app name, and the verb. */
const LINE_OVERHEAD_CHARS = 48;

export interface SegmentDigestInput {
	/** One line per event kept, in time order. Empty when nothing was kept. */
	text: string;
	/** Events the text shows. */
	shown: number;
	/** Events the segment holds. */
	total: number;
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}

function clip(text: string, maxChars: number): string {
	return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
}

/** `HH:MM:SS` of a stored UTC timestamp. */
function clock(ts: string): string {
	return ts.slice(11, 19);
}

function windowKey(event: StoredEvent): string {
	return [event.app?.id ?? '', event.window?.title ?? '', event.window?.url ?? ''].join('\u0000');
}

function describeWindow(event: StoredEvent): string {
	const title = event.window?.title ? oneLine(event.window.title) : '';
	const url = event.window?.url ?? '';
	if (title && url) return `window "${title}" (${url})`;
	if (title) return `window "${title}"`;
	if (url) return `window ${url}`;
	return 'in front';
}

function describeText(event: StoredEvent, text: string): string {
	const field = event.element?.label ? ` in "${oneLine(event.element.label)}"` : '';
	switch (event.kind) {
		case 'text.committed':
			return event.reason === 'cleared' && !text
				? `cleared the field${field}`
				: `typed${field}: ${text}`;
		case 'selection.changed':
			return `selected: ${text}`;
		default:
			return `on screen: ${text}`;
	}
}

/**
 * Render a segment's events as lines a small model can read, within
 * `maxChars`.
 *
 * - A line names the window whenever the app, title, or URL changes, so the
 *   other lines do not repeat it.
 * - A snapshot identical to the last one of the same window is skipped: a
 *   window that sits still is recorded many times.
 * - Every event's text is cut to a share of the budget (never under
 *   {@link MIN_DIGEST_EVENT_TEXT_CHARS}). When the lines still do not fit,
 *   evenly spaced lines are kept, so the whole window is covered rather than
 *   its first minutes.
 */
export function renderSegmentForDigest(
	events: readonly StoredEvent[],
	options: { maxChars: number }
): SegmentDigestInput {
	const maxChars = Math.max(1, Math.floor(options.maxChars));
	interface Entry {
		prefix: string;
		event: StoredEvent | null;
		text: string;
	}
	const entries: Entry[] = [];
	let lastWindow: string | null = null;
	const lastSnapshot = new Map<string, string>();

	for (const event of events) {
		const app = oneLine(event.app?.name || event.app?.id || 'Unknown app');
		const prefix = `${clock(event.ts)} ${app}: `;
		const key = windowKey(event);
		const text = event.text ? oneLine(event.text) : '';

		if (event.kind === 'content.snapshot') {
			if (!text || lastSnapshot.get(key) === text) continue;
			lastSnapshot.set(key, text);
		}
		if (key !== lastWindow) {
			lastWindow = key;
			entries.push({ prefix, event: null, text: describeWindow(event) });
		}
		if (event.kind === 'app.activated' || event.kind === 'window.changed') continue;
		if (!text && !(event.kind === 'text.committed' && event.reason === 'cleared')) continue;
		entries.push({ prefix, event, text });
	}

	const textCap = Math.min(
		MAX_DIGEST_EVENT_TEXT_CHARS,
		Math.max(
			MIN_DIGEST_EVENT_TEXT_CHARS,
			Math.floor(maxChars / Math.max(1, entries.length)) - LINE_OVERHEAD_CHARS
		)
	);
	const lines = entries.map(
		(entry) =>
			entry.prefix +
			(entry.event ? describeText(entry.event, clip(entry.text, textCap)) : entry.text)
	);

	const size = lines.reduce((sum, line) => sum + line.length + 1, 0);
	const stride = Math.max(1, Math.ceil(size / maxChars));
	const kept: string[] = [];
	let used = 0;
	for (let i = 0; i < lines.length; i += stride) {
		// Sampling fits on average; a run of long lines can still overshoot.
		if (used + lines[i].length + 1 > maxChars && kept.length > 0) break;
		kept.push(lines[i]);
		used += lines[i].length + 1;
	}
	return { text: kept.join('\n'), shown: kept.length, total: events.length };
}

/**
 * Join a block's 15-minute digests, in time order, as the input of a roll-up.
 * Each digest keeps its own heading (it names the window) and is cut to
 * {@link MAX_ROLLUP_DIGEST_CHARS}; an empty one is dropped.
 */
export function renderDigestsForRollup(bodies: readonly string[]): string {
	return bodies
		.map((body) => body.trim())
		.filter((body) => body !== '')
		.map((body) => clip(body, MAX_ROLLUP_DIGEST_CHARS))
		.join('\n\n');
}

export type LocalDigestInstruction =
	| {
			kind: '15m';
			windowStartIso: string;
			windowEndIso: string;
			/** Events shown and held, so the model is told when it sees a sample. */
			shown: number;
			total: number;
	  }
	| { kind: '6h'; blockStartIso: string; blockEndIso: string; digests: number };

/** Where one call stands when the input does not fit in one. */
export type LocalDigestStage =
	/** The whole input, answered with the digest itself. */
	| { stage: 'whole' }
	/** One part of the input, answered with notes. */
	| { stage: 'part'; part: number; parts: number }
	/** The notes of every part, answered with the digest. */
	| { stage: 'notes'; parts: number };

const DIGEST_ASK =
	'Say what the person worked on: apps used, documents and pages looked at, messages sent, and decisions or tasks that appear.';
const ROLLUP_ASK =
	'Give the main threads of work, notable documents, conversations and decisions, and open tasks. Group related windows; do not repeat every bullet.';

/**
 * The instruction that goes above the fenced input of one local digest call.
 * The rules that never change (bullets only, untrusted input, no secrets) are
 * the system prompt, `computer-history-digest-local`.
 */
export function buildLocalDigestInstruction(
	job: LocalDigestInstruction,
	at: LocalDigestStage
): string {
	const window =
		job.kind === '15m'
			? `the ${SEGMENT_MINUTES} minutes from ${job.windowStartIso} to ${job.windowEndIso} (UTC)`
			: `the ${ROLLUP_HOURS} hours from ${job.blockStartIso} to ${job.blockEndIso} (UTC)`;
	const record =
		job.kind === '15m'
			? job.shown < job.total
				? `a sample of the activity record (${job.total} events were recorded)`
				: 'the activity record'
			: `${job.digests} ${SEGMENT_MINUTES}-minute digest(s), in time order`;
	const ask = job.kind === '15m' ? DIGEST_ASK : ROLLUP_ASK;
	const name = job.kind === '15m' ? 'digest' : 'roll-up';
	const bullets = job.kind === '15m' ? 12 : 15;

	switch (at.stage) {
		case 'whole':
			return `Write the ${name} of ${window}. Below is ${record}. ${ask} Use at most ${bullets} bullets.`;
		case 'part':
			return `Take notes for the ${name} of ${window}. Below is part ${at.part} of ${at.parts} of ${record}. ${ask} Use at most 8 bullets, and keep the times.`;
		case 'notes':
			return `Write the ${name} of ${window}. Below are notes taken on ${at.parts} parts of ${record}, in time order. Merge them into one ${name}. ${ask} Use at most ${bullets} bullets.`;
	}
}
