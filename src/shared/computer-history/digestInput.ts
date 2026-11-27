/**
 * Computer History - what a LOCAL MODEL is shown to write a digest (pure).
 *
 * The digest agent is handed file paths and reads them with its own tools. A
 * local model has no tools, so its input is built here: a segment becomes a
 * line of time per app and one compact line per event, and a 6-hour block
 * becomes the text of its 15-minute digests. Both are bounded by a character
 * budget the caller derives from the model's context.
 *
 * Everything rendered here is captured from the screen and UNTRUSTED. The
 * caller fences it (`fenceUntrusted`) before it reaches a model.
 */

import { formatDurationCompact } from '../duration';
import { addEventToAppStats, createAppStats } from './appStats';
import { splitDigestBody } from './digestBody';
import {
	DIGEST_ACCURACY_RULES,
	PREVIOUS_DIGEST_RULE,
	digestFormatInstructions,
} from './digestFormat';
import { ROLLUP_HOURS, SEGMENT_MINUTES } from './paths';
import { supersededDrafts } from './reader';
import type { StoredEvent } from './types';

/**
 * The most text one event contributes, when the budget allows it. Large enough
 * for a whole sent message or a screen's worth of an email; a busy window
 * shares the budget and every event gets less.
 */
export const MAX_DIGEST_EVENT_TEXT_CHARS = 2000;
/** The least text one event keeps, however many events share the budget. */
export const MIN_DIGEST_EVENT_TEXT_CHARS = 80;
/** The most one 15-minute digest contributes to a roll-up, when the budget allows it. */
export const MAX_ROLLUP_DIGEST_CHARS = 4000;
/**
 * The most of the previous digest a 15-minute digest is shown, unless the
 * caller sets less. It is context for thread names and open items, so its
 * opening (title, lede, threads) is what matters.
 */
export const MAX_PREVIOUS_DIGEST_CHARS = 2000;
/** Apps named in the time-in-front line; the rest are summed as "other". */
const APP_TIME_LINE_MAX_APPS = 6;
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

/**
 * One line saying how long each app was in front, longest first: what the
 * person spent the window on, which the event lines alone do not show (a
 * long read makes one snapshot; a chat makes dozens). Empty for a window with
 * no measurable time.
 */
export function renderAppTimeLine(events: readonly StoredEvent[]): string {
	const stats = createAppStats();
	for (const event of events) addEventToAppStats(stats, event);
	const ranked = Object.entries(stats.activeMs)
		.filter(([, ms]) => ms >= 1000)
		.sort((a, b) => b[1] - a[1]);
	if (ranked.length === 0) return '';
	const named = ranked
		.slice(0, APP_TIME_LINE_MAX_APPS)
		.map(([id, ms]) => `${oneLine(stats.names[id] || id)} ${formatDurationCompact(ms)}`);
	const restMs = ranked.slice(APP_TIME_LINE_MAX_APPS).reduce((sum, [, ms]) => sum + ms, 0);
	if (restMs >= 1000) named.push(`other apps ${formatDurationCompact(restMs)}`);
	return `Time in front: ${named.join(', ')}`;
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
 * - A draft that a later commit in the same field supersedes is skipped (the
 *   same rule `queryEvents` uses): a message typed with pauses is recorded
 *   once per pause, and only the last version says what was written.
 * - The first line says how long each app was in front
 *   ({@link renderAppTimeLine}).
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
	const drafts = supersededDrafts(events);

	for (const event of events) {
		if (drafts.has(event)) continue;
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

	const header = renderAppTimeLine(events);
	const budget = Math.max(1, maxChars - (header ? header.length + 1 : 0));
	const size = lines.reduce((sum, line) => sum + line.length + 1, 0);
	const stride = Math.max(1, Math.ceil(size / budget));
	const kept: string[] = [];
	let used = 0;
	for (let i = 0; i < lines.length; i += stride) {
		// Sampling fits on average; a run of long lines can still overshoot.
		if (used + lines[i].length + 1 > budget && kept.length > 0) break;
		kept.push(lines[i]);
		used += lines[i].length + 1;
	}
	// A window with nothing to show stays empty: the time line alone is no record.
	const text = kept.length > 0 && header ? `${header}\n${kept.join('\n')}` : kept.join('\n');
	return { text, shown: kept.length, total: events.length };
}

/**
 * Join a block's 15-minute digests, in time order, as the input of a roll-up.
 * Each keeps its heading (it names the window) and its summary, without the
 * provenance line (a file and a model name, the same on every digest). Each is
 * cut to an equal share of `maxChars` (at most {@link MAX_ROLLUP_DIGEST_CHARS}),
 * so every window of the block is in the input; an empty one is dropped.
 */
export function renderDigestsForRollup(
	bodies: readonly string[],
	options: { maxChars?: number } = {}
): string {
	const parts = bodies
		.map((body) => {
			const trimmed = body.trim();
			const { summary } = splitDigestBody(trimmed);
			// Without the digest header there is no heading to keep: the summary is the body.
			if (summary === trimmed) return summary;
			return `${trimmed.split('\n', 1)[0]}\n${summary}`;
		})
		.map((part) => part.trim())
		.filter((part) => part !== '');
	const share =
		options.maxChars === undefined
			? MAX_ROLLUP_DIGEST_CHARS
			: Math.min(
					MAX_ROLLUP_DIGEST_CHARS,
					Math.max(200, Math.floor(options.maxChars / Math.max(1, parts.length)) - 2)
				);
	return parts.map((part) => clip(part, share)).join('\n\n');
}

/**
 * The previous digest as a local model is shown it: the writer's summary only
 * (the header names a file and a model, which says nothing about the work),
 * cut to `maxChars`. Empty when there is no summary.
 */
export function renderPreviousDigest(
	body: string,
	maxChars: number = MAX_PREVIOUS_DIGEST_CHARS
): string {
	return clip(splitDigestBody(body).summary, maxChars);
}

export type LocalDigestInstruction =
	| {
			kind: '15m';
			windowStartIso: string;
			windowEndIso: string;
			/** Events shown and held, so the model is told when it sees a sample. */
			shown: number;
			total: number;
			/** The request carries the previous digest, fenced before the record. */
			hasPrevious?: boolean;
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

const NOTES_ASK =
	'Note each piece of work: the documents, pages, projects, and people involved, what the person typed or sent, and whether each step finished.';

/**
 * The instruction that goes above the fenced input of one local digest call.
 * The rules that never change (untrusted input, no introduction) are the
 * system prompt, `computer-history-digest-local`. The shape of the answer and
 * the accuracy rules are the ones the digest agent gets (`./digestFormat`).
 * A notes call asks only for notes, so it carries the accuracy rules but not
 * the shape, and never the previous digest: that is for the call that writes.
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
	const name = job.kind === '15m' ? 'digest' : 'roll-up';
	const previous =
		job.kind === '15m' && job.hasPrevious
			? ` The first fenced block is the digest of the window before this one. ${PREVIOUS_DIGEST_RULE}`
			: '';
	const shape = `${digestFormatInstructions(job.kind)}\n\n${DIGEST_ACCURACY_RULES}`;

	switch (at.stage) {
		case 'whole':
			return `Write the ${name} of ${window}. Below is ${record}.${previous}\n\n${shape}`;
		case 'part':
			return `Take notes for the ${name} of ${window}. Below is part ${at.part} of ${at.parts} of ${record}. ${NOTES_ASK} Use at most 8 bullets, and keep the times.\n\n${DIGEST_ACCURACY_RULES}`;
		case 'notes':
			return `Write the ${name} of ${window}. Below are notes taken on ${at.parts} parts of ${record}, in time order. Merge them into one ${name}.${previous}\n\n${shape}`;
	}
}
