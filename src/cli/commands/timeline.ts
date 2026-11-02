// Timeline command: one time-ordered list of what happened around an agent
// (its turns, what the user did in Maestro, commits, and Computer History when
// that Encore Feature is on). It is the tip of the iceberg: each line carries a
// handle, the output ends with the commands that read more, and
// `timeline show <entry>` opens one turn in full.
//
// Read-only, straight off disk through `readTimeline()` and
// `findHistoryEntries()`, so it works with the desktop closed. The merge and the
// line format live in `src/shared/timeline.ts`.

import { readLiveSessions, getTimelinePaths, resolveAgentId } from '../services/storage';
import { formatError, formatWarning } from '../output/formatter';
import { isEncoreEnabled, requireEncore } from '../utils/encore-gate';
import { compileGrep } from '../../shared/computer-history/reader';
import { readTimeline, type TimelineAgent } from '../../shared/maestro-lib/store/read-timeline';
import {
	findHistoryEntries,
	type FoundHistoryEntry,
} from '../../shared/maestro-lib/store/read-history';
import { formatDurationCompact } from '../../shared/duration';
import { formatTimestamp } from '../../shared/formatters';
import { parseTimeInput } from '../../shared/timeInput';
import {
	DEFAULT_TIMELINE_SOURCES,
	TIMELINE_SOURCES,
	formatTimelineLine,
	isTimelineSource,
	timelineFollowUp,
	timelineFollowUps,
	type TimelineSource,
} from '../../shared/timeline';
import type { SessionInfo } from '../../shared/types';

export interface TimelineOptions {
	agent?: string;
	since?: string;
	until?: string;
	sources?: string;
	tail?: string;
	perSource?: string;
	grep?: string;
	json?: boolean;
}

export interface TimelineShowOptions {
	agent?: string;
	json?: boolean;
}

/** `--since` when none is given. */
export const DEFAULT_TIMELINE_SINCE = '1d';

/** `--tail` when none is given: the tip, not the iceberg. */
export const DEFAULT_TIMELINE_TAIL = 30;

/** `--per-source` when none is given, so a burst of saves cannot hide the turns. */
export const DEFAULT_TIMELINE_PER_SOURCE = 15;

/** Shortest id prefix `timeline show` accepts. */
const MIN_REF_CHARS = 4;

function parseTime(flag: string, value: string, now: number): number {
	const parsed = parseTimeInput(value, now);
	if (parsed === null) {
		throw new Error(
			`Invalid ${flag} value: ${value} (expected 30m, 2h, 1d, 1w, ISO-8601, or epoch)`
		);
	}
	return parsed;
}

function parseCount(flag: string, value: string | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	// Strict: `parseInt('5abc', 10)` is 5, which would hide a typo.
	const trimmed = value.trim();
	if (!/^\d+$/.test(trimmed)) {
		throw new Error(`Invalid ${flag} value: ${value} (expected non-negative integer)`);
	}
	return Number(trimmed);
}

function fail(message: string, json: boolean | undefined): void {
	if (json) {
		console.log(JSON.stringify({ success: false, error: message }, null, 2));
	} else {
		console.error(formatError(message));
	}
	process.exit(1);
}

/**
 * The sources to read. `computer` is a source only while Computer History is
 * on; asking for it while the feature is off refuses the way the feature's own
 * verbs do.
 */
function parseSources(value: string | undefined, json: boolean | undefined): TimelineSource[] {
	if (value === undefined) return [...DEFAULT_TIMELINE_SOURCES];
	const names = value
		.split(',')
		.map((name) => name.trim())
		.filter(Boolean);
	const invalid = names.filter((name) => !isTimelineSource(name));
	if (invalid.length > 0) {
		const valid = TIMELINE_SOURCES.filter(
			(source) => source !== 'computer' || isEncoreEnabled('computerHistory')
		);
		throw new Error(
			`Invalid --sources value: ${invalid.join(', ')}. Must be one of: ${valid.join(', ')}`
		);
	}
	if (names.includes('computer')) requireEncore('computerHistory', json);
	return names as TimelineSource[];
}

function toTimelineAgent(session: SessionInfo): TimelineAgent {
	// An SSH agent's working directory is on the remote, not here.
	const isSsh = !!session.sessionSshRemoteConfig?.enabled;
	return { id: session.id, cwd: session.cwd, gitCwd: isSsh ? undefined : session.cwd };
}

export async function timeline(options: TimelineOptions): Promise<void> {
	try {
		const now = Date.now();
		const sinceMs = parseTime('--since', options.since ?? DEFAULT_TIMELINE_SINCE, now);
		const untilMs =
			options.until !== undefined ? parseTime('--until', options.until, now) : undefined;
		const tail = parseCount('--tail', options.tail, DEFAULT_TIMELINE_TAIL);
		const perSourceTail = parseCount(
			'--per-source',
			options.perSource,
			DEFAULT_TIMELINE_PER_SOURCE
		);
		const sources = parseSources(options.sources, options.json);

		const sessions = readLiveSessions();
		const agentId = options.agent ? resolveAgentId(options.agent, sessions) : undefined;
		const agents = agentId ? sessions.filter((s) => s.id === agentId) : sessions;

		const { events, notes } = await readTimeline({
			paths: getTimelinePaths(),
			agents: agents.map(toTimelineAgent),
			sources,
			sinceMs,
			untilMs,
			grep: compileGrep(options.grep),
			perSourceTail,
			tail,
			computerHistory: sources.includes('computer'),
			now,
		});
		if (agentId && sources.includes('git') && agents[0]?.sessionSshRemoteConfig?.enabled) {
			notes.push('git: skipped, the agent works on an SSH remote');
		}

		const names = new Map(sessions.map((s) => [s.id, s.name]));
		if (options.json) {
			console.log(
				JSON.stringify(
					{
						success: true,
						events: events.map((event) => ({
							...event,
							time: new Date(event.ts).toISOString(),
							...(event.agentId ? { agentName: names.get(event.agentId) } : {}),
							...(timelineFollowUp(event) ? { more: timelineFollowUp(event) } : {}),
						})),
						notes,
					},
					null,
					2
				)
			);
			return;
		}

		for (const note of notes) console.error(formatWarning(note));
		if (events.length === 0) {
			console.log('No timeline events.');
			return;
		}
		console.log(
			events
				.map((event) =>
					formatTimelineLine(event, now, {
						agentName: !agentId && event.agentId ? names.get(event.agentId) : undefined,
					})
				)
				.join('\n')
		);
		console.log(['', 'Read more:', ...timelineFollowUps(events).map((l) => `  ${l}`)].join('\n'));
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error), options.json);
	}
}

/** The text form of one history entry, ending with where to read more. */
function formatEntry({ agentId, entry }: FoundHistoryEntry, agentName: string | undefined): string {
	const facts = [
		`${entry.type} turn`,
		formatTimestamp(entry.timestamp, 'datetime'),
		agentName ?? agentId,
		entry.sessionName ? `tab "${entry.sessionName}"` : undefined,
		entry.elapsedTimeMs !== undefined ? formatDurationCompact(entry.elapsedTimeMs) : undefined,
		entry.success === false ? 'failed' : undefined,
		entry.sourceAgentName ? `asked by ${entry.sourceAgentName}` : undefined,
		entry.cueTriggerName ? `Cue ${entry.cueTriggerName}` : undefined,
	].filter(Boolean);
	// The reply usually opens with its own summary; print the summary apart only when it does not.
	const reply = entry.fullResponse?.trim() ?? '';
	const summary = entry.summary.trim();
	const lines = [facts.join(' | '), `entry ${entry.id}`, ''];
	if (!reply.startsWith(summary)) lines.push(`Summary: ${summary}`, '');
	if (reply) lines.push(reply);
	const more: string[] = [];
	if (entry.tabId) {
		more.push(`session show ${entry.tabId}    the whole conversation, while the tab is open`);
	}
	more.push(
		`timeline --agent ${agentId} --until ${new Date(entry.timestamp).toISOString()}    what led up to it`
	);
	lines.push('', 'Read more:', ...more.map((l) => `  ${l}`));
	return lines.join('\n');
}

/**
 * `timeline show <entry>`: one history entry in full, found by an id prefix
 * from a timeline line. Searches every live agent unless `--agent` names one.
 */
export async function timelineShow(ref: string, options: TimelineShowOptions): Promise<void> {
	try {
		const prefix = ref.trim();
		if (prefix.length < MIN_REF_CHARS) {
			throw new Error(`Entry id too short: ${ref} (give at least ${MIN_REF_CHARS} characters)`);
		}
		const sessions = readLiveSessions();
		const agentIds = options.agent
			? [resolveAgentId(options.agent, sessions)]
			: sessions.map((s) => s.id);
		const found = await findHistoryEntries(getTimelinePaths(), agentIds, prefix);
		const names = new Map(sessions.map((s) => [s.id, s.name]));

		if (found.length === 0) {
			const hint = /^[0-9a-f]{7,40}$/i.test(prefix) ? ` If it is a commit: git show ${prefix}` : '';
			throw new Error(`No history entry starts with ${prefix}.${hint}`);
		}
		if (found.length > 1) {
			const list = found
				.map((f) => `${f.entry.id} (${names.get(f.agentId) ?? f.agentId}): ${f.entry.summary}`)
				.join('; ');
			throw new Error(`${prefix} matches ${found.length} entries, give more of the id: ${list}`);
		}

		const [match] = found;
		if (options.json) {
			console.log(
				JSON.stringify(
					{
						success: true,
						agentId: match.agentId,
						agentName: names.get(match.agentId),
						entry: match.entry,
					},
					null,
					2
				)
			);
			return;
		}
		console.log(formatEntry(match, names.get(match.agentId)));
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error), options.json);
	}
}
