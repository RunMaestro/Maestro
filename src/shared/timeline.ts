/**
 * Timeline: one time-ordered list of what happened around an agent, merged
 * from the records Maestro already keeps, so an agent reads one view first and
 * opens a single source only when it needs the detail.
 *
 * Sources, each owned elsewhere and only read here:
 * - `history`: the agent's finished turns (`src/main/history-manager.ts`).
 * - `journey`: what the user did inside Maestro (`src/shared/userJourney.ts`).
 * - `git`: commits on the working directory's current branch (first parent).
 * - `computer`: Computer History, an Encore Feature. Read only while the
 *   feature is on, and only when asked for: it is high-volume and holds text
 *   the user merely looked at.
 *
 * The timeline is the tip of the iceberg: a line carries a summary and a `ref`
 * to drill into (a history entry id, a commit sha), never the full record, and
 * `timelineFollowUps()` names the commands that read more. Nothing here goes
 * into a system prompt: it changes every turn, which would defeat the
 * provider's prompt cache. This module is pure: the readers live in
 * `src/shared/maestro-lib/store/read-timeline.ts`.
 */

import type { StoredEvent } from './computer-history/types';
import { truncateAtWordBoundary } from './formatters';
import type { HistoryEntry } from './types';
import {
	describeJourneyEntry,
	formatDigestTime,
	type FormatJourneyLineOptions,
	type UserJourneyEntry,
} from './userJourney';

export type TimelineSource = 'history' | 'journey' | 'git' | 'computer';

export const TIMELINE_SOURCES: readonly TimelineSource[] = [
	'history',
	'journey',
	'git',
	'computer',
];

/** What `maestro-cli timeline` reads when `--sources` is not given. */
export const DEFAULT_TIMELINE_SOURCES: readonly TimelineSource[] = ['history', 'journey', 'git'];

export function isTimelineSource(value: unknown): value is TimelineSource {
	return typeof value === 'string' && (TIMELINE_SOURCES as readonly string[]).includes(value);
}

export interface TimelineEvent {
	/** Epoch ms. */
	ts: number;
	source: TimelineSource;
	/** The agent the event belongs to. Absent for `computer`, which is machine-wide. */
	agentId?: string;
	/** One line, no clock: `USER (Fix tooltip): fixed clipping in FilePreview`. */
	text: string;
	/** The handle to read more: a history entry id or a commit sha. */
	ref?: string;
}

/** Longest summary a history or commit line keeps, in characters. */
const TEXT_MAX_CHARS = 160;

/** Longest captured text a Computer History line keeps, in characters. */
const CAPTURED_TEXT_MAX_CHARS = 80;

/** Characters of a history entry id or commit sha a text line shows. */
const REF_DISPLAY_CHARS = 8;

function oneLine(text: string, max: number): string {
	return truncateAtWordBoundary(text.replace(/\s+/g, ' ').trim(), max);
}

/**
 * A history entry as a timeline event:
 * `USER (Fix tooltip): fixed clipping in FilePreview`, with `[failed]` on a
 * turn that did not complete and the consulting agent or Cue trigger named.
 */
export function historyEntryToTimelineEvent(entry: HistoryEntry, agentId: string): TimelineEvent {
	const origin =
		entry.type === 'AGENT' && entry.sourceAgentName
			? ` from ${entry.sourceAgentName}`
			: entry.type === 'CUE' && entry.cueTriggerName
				? ` ${entry.cueTriggerName}`
				: '';
	const tab = entry.sessionName ? ` (${oneLine(entry.sessionName, 40)})` : '';
	const failed = entry.success === false ? ' [failed]' : '';
	const summary = oneLine(entry.summary || '', TEXT_MAX_CHARS) || '(no summary)';
	return {
		ts: entry.timestamp,
		source: 'history',
		agentId,
		text: `${entry.type}${origin}${tab}: ${summary}${failed}`,
		ref: entry.id,
	};
}

/** A journey entry as a timeline event: `saved src/foo.ts (+12/-3)`. */
export function journeyEntryToTimelineEvent(
	entry: UserJourneyEntry,
	options: FormatJourneyLineOptions = {}
): TimelineEvent {
	return {
		ts: entry.ts,
		source: 'journey',
		agentId: entry.agentId,
		text: `user ${describeJourneyEntry(entry, options)}`,
	};
}

/** Field separator in the `git log` format below (ASCII unit separator). */
const GIT_FIELD_SEP = '\x1f';

/**
 * `git log` arguments for the commits on the current branch committed inside
 * the window, newest first. First parent only: a merge reads as one commit
 * rather than as every commit it brought in, which would flood the timeline
 * with work done elsewhere.
 */
export function gitTimelineArgs(
	sinceMs: number,
	untilMs: number | undefined,
	limit: number
): string[] {
	const args = [
		'log',
		'--first-parent',
		`--since=${new Date(sinceMs).toISOString()}`,
		`-n${Math.max(1, Math.floor(limit))}`,
		`--format=%H${GIT_FIELD_SEP}%ct${GIT_FIELD_SEP}%an${GIT_FIELD_SEP}%s`,
	];
	if (untilMs !== undefined) args.splice(2, 0, `--until=${new Date(untilMs).toISOString()}`);
	return args;
}

/** Parse the output of `gitTimelineArgs` into events. Malformed lines are skipped. */
export function parseGitTimeline(stdout: string, agentId: string): TimelineEvent[] {
	const events: TimelineEvent[] = [];
	for (const line of stdout.split('\n')) {
		const [sha, committed, author, ...subject] = line.split(GIT_FIELD_SEP);
		const seconds = Number(committed);
		if (!sha || !/^[0-9a-f]{7,64}$/i.test(sha) || !Number.isFinite(seconds)) continue;
		events.push({
			ts: seconds * 1000,
			source: 'git',
			agentId,
			text: `commit by ${author || 'unknown'}: ${oneLine(subject.join(GIT_FIELD_SEP), TEXT_MAX_CHARS)}`,
			ref: sha,
		});
	}
	return events;
}

/**
 * A Computer History event as a timeline event, or null for a kind the
 * timeline does not show. Captured text is quoted and cut short: it is
 * untrusted, and the full event is one `computer-history query` away.
 */
export function computerEventToTimelineEvent(event: StoredEvent): TimelineEvent | null {
	const ts = Date.parse(event.ts);
	if (!Number.isFinite(ts)) return null;
	const app = event.app?.name || event.app?.id || 'an app';
	const quoted = (text: string | undefined) => {
		const cut = text ? oneLine(text, CAPTURED_TEXT_MAX_CHARS) : '';
		return cut ? ` "${cut}"` : '';
	};
	let text: string;
	switch (event.kind) {
		case 'app.activated':
			text = `switched to ${app}`;
			break;
		case 'window.changed':
			text = `${app} window${quoted(event.window?.title || event.window?.url)}`;
			break;
		case 'text.committed':
			text = `typed in ${app}:${quoted(event.text)}`;
			break;
		case 'selection.changed':
			text = `selected in ${app}:${quoted(event.text)}`;
			break;
		case 'content.snapshot':
			text = `viewed ${app}${quoted(event.window?.title || event.window?.url)}`;
			break;
		default:
			return null;
	}
	return { ts, source: 'computer', text: `user ${text}` };
}

/**
 * Drop an `app.activated` event that repeats the app of the event before it:
 * the helper reports a re-activation after every window or focus change.
 */
export function collapseRepeatedAppSwitches(events: readonly TimelineEvent[]): TimelineEvent[] {
	const out: TimelineEvent[] = [];
	for (const event of events) {
		const prev = out[out.length - 1];
		if (prev && prev.source === 'computer' && prev.text === event.text) continue;
		out.push(event);
	}
	return out;
}

/** True when `grep` matches the event's text or its ref. */
export function timelineEventMatches(event: TimelineEvent, grep: RegExp): boolean {
	return grep.test(event.text) || (!!event.ref && grep.test(event.ref));
}

export interface SelectTimelineOptions {
	/** Only events at or after this time (epoch ms). */
	sinceMs?: number;
	/** Only events at or before this time (epoch ms). */
	untilMs?: number;
	/** Only events whose text (or ref) matches, case-insensitive. */
	grep?: RegExp;
	/** Keep at most this many of each source's newest events. */
	perSourceTail?: number;
	/** Keep at most this many of the newest events overall (after `perSourceTail`). */
	tail?: number;
}

/**
 * Merge events from every source into one list, oldest first, with the window,
 * grep, and caps applied. Ties keep source order. A commit seen from two agents
 * that share a repository is kept once.
 */
export function selectTimelineEvents(
	events: readonly TimelineEvent[],
	options: SelectTimelineOptions = {}
): TimelineEvent[] {
	const { sinceMs, untilMs, grep, perSourceTail, tail } = options;
	const seenCommits = new Set<string>();
	let out = events
		.map((event, index) => ({ event, index }))
		.filter(({ event }) => {
			if (sinceMs !== undefined && event.ts < sinceMs) return false;
			if (untilMs !== undefined && event.ts > untilMs) return false;
			if (grep && !timelineEventMatches(event, grep)) return false;
			if (event.source === 'git' && event.ref) {
				if (seenCommits.has(event.ref)) return false;
				seenCommits.add(event.ref);
			}
			return true;
		})
		.sort((a, b) => a.event.ts - b.event.ts || a.index - b.index)
		.map(({ event }) => event);

	if (perSourceTail !== undefined) {
		const kept = new Set<TimelineEvent>();
		for (const source of TIMELINE_SOURCES) {
			const ofSource = out.filter((e) => e.source === source);
			for (const e of perSourceTail > 0 ? ofSource.slice(-perSourceTail) : []) kept.add(e);
		}
		out = out.filter((e) => kept.has(e));
	}
	if (tail !== undefined) out = tail > 0 ? out.slice(-tail) : [];
	return out;
}

/** The drill-down handle a line shows: `[entry 1a2b3c4d]`, `[commit 5e621726]`. */
function refLabel(event: TimelineEvent): string {
	if (!event.ref) return '';
	const short = event.ref.slice(0, REF_DISPLAY_CHARS);
	if (event.source === 'history') return ` [entry ${short}]`;
	if (event.source === 'git') return ` [commit ${short}]`;
	return ` [${short}]`;
}

export interface FormatTimelineLineOptions {
	/** Prefix the line with this agent name (a timeline that spans agents). */
	agentName?: string;
}

/**
 * One line per event for an agent-facing digest:
 * `2:02 PM history USER (Fix tooltip): fixed clipping [entry 1a2b3c4d]`.
 */
export function formatTimelineLine(
	event: TimelineEvent,
	now: number,
	options: FormatTimelineLineOptions = {}
): string {
	const agent = options.agentName ? `${options.agentName}: ` : '';
	return `${formatDigestTime(event.ts, now)} ${event.source} ${agent}${event.text}${refLabel(event)}`;
}

/** How wide a window `timelineFollowUp()` gives a Computer History event. */
const COMPUTER_FOLLOW_UP_MS = 5 * 60 * 1000;

/**
 * The command that reads more about one event, or undefined when its line is
 * the whole record (a journey action). Bare verbs: the caller knows how it
 * invokes `maestro-cli`.
 */
export function timelineFollowUp(event: TimelineEvent): string | undefined {
	if (event.source === 'history' && event.ref) return `timeline show ${event.ref}`;
	if (event.source === 'git' && event.ref) return `git show ${event.ref}`;
	if (event.source === 'computer') {
		const since = new Date(event.ts).toISOString();
		const until = new Date(event.ts + COMPUTER_FOLLOW_UP_MS).toISOString();
		return `computer-history query --since ${since} --until ${until}`;
	}
	return undefined;
}

/**
 * The "read more" lines printed under a timeline: one per source that has
 * events, then how to widen or narrow the view.
 */
export function timelineFollowUps(events: readonly TimelineEvent[]): string[] {
	const present = new Set(events.map((e) => e.source));
	const lines: string[] = [];
	if (present.has('history')) {
		lines.push('timeline show <entry>    a turn in full: reply, tab, transcript command');
	}
	if (present.has('git')) lines.push('git show <commit>        a commit and its diff');
	if (present.has('journey')) {
		lines.push("journey --agent <id>     the user's actions alone, filter with --kind");
	}
	if (present.has('computer')) {
		lines.push('computer-history query   captured text and windows, with --since and --grep');
	}
	lines.push('--since 1w | --grep <text> | --sources <list> | no --agent for every agent');
	return lines;
}
