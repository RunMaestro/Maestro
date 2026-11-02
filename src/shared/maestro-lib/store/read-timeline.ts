/**
 * Read an agent's timeline (`src/shared/timeline.ts`) from the records on this
 * machine: history and journey files under the data directory, `git log` in
 * the working directory, and the Computer History store.
 *
 * Read-only, behind `maestro-cli timeline`. Nothing here throws: a source that
 * cannot be read adds a note and no events.
 */

import * as fs from 'fs';

import { computerHistoryDir } from '../../computer-history/paths';
import { queryEvents } from '../../computer-history/reader';
import {
	collapseRepeatedAppSwitches,
	computerEventToTimelineEvent,
	gitTimelineArgs,
	historyEntryToTimelineEvent,
	journeyEntryToTimelineEvent,
	parseGitTimeline,
	selectTimelineEvents,
	timelineEventMatches,
	type SelectTimelineOptions,
	type TimelineEvent,
	type TimelineSource,
} from '../../timeline';
import { execFileNoThrow } from '../launch/exec-file';
import type { MaestroPaths } from '../paths/resolve';
import { readRecentHistory } from './read-history';
import { journeyFilePath, readJourneyFile } from './read-journey';

/** One agent whose records the timeline reads. */
export interface TimelineAgent {
	id: string;
	/** Paths under it render relative to it. */
	cwd?: string;
	/**
	 * Where `git log` runs. Leave it unset for an agent on an SSH remote: its
	 * working directory is not on this machine.
	 */
	gitCwd?: string;
}

/**
 * Runs `git` in `cwd` and resolves its stdout, or null when git answered with
 * a failure (not a repository, no commits). Throws when git could not answer
 * at all (missing, timed out): the timeline reports that as a note.
 */
export type TimelineGitRunner = (cwd: string, args: string[]) => Promise<string | null>;

export interface ReadTimelineInput extends SelectTimelineOptions {
	paths: Pick<MaestroPaths, 'userDataDir' | 'historyDir'>;
	agents: readonly TimelineAgent[];
	sources: readonly TimelineSource[];
	/** Start of the window (epoch ms). Required: every source is read from here forward. */
	sinceMs: number;
	/**
	 * Read Computer History. The caller decides: only while the Encore Feature
	 * is on, and never for the system prompt snapshot.
	 */
	computerHistory?: boolean;
	/** Defaults to a local `git` with a short timeout. */
	runGit?: TimelineGitRunner;
	now?: number;
}

export interface ReadTimelineResult {
	/** Oldest first, with the window, grep, and caps applied. */
	events: TimelineEvent[];
	/** Sources that were asked for and could not be read, one line each. */
	notes: string[];
}

/** Git gets this long per repository before its commits are left out. */
const GIT_TIMEOUT_MS = 5_000;

/**
 * Most events kept from one source of one agent before merging, AFTER the
 * window and the search are applied. The merge applies the real caps; this
 * only bounds memory.
 */
const READ_CAP_PER_SOURCE = 500;

/** How many commits `git log` may return while a search narrows them afterwards. */
const GIT_SEARCH_READ_CAP = 5_000;

const defaultRunGit: TimelineGitRunner = async (cwd, args) => {
	// A working directory that is gone (a removed agent's folder) has no
	// commits; without this check its spawn ENOENT would read as git missing.
	if (!fs.existsSync(cwd)) return null;
	const result = await execFileNoThrow('git', args, cwd, { timeout: GIT_TIMEOUT_MS });
	if (result.exitCode === 0) return result.stdout;
	// A string code (ETIMEDOUT, ENOENT) means git never answered; a number is
	// git's own refusal, such as a folder that is not a repository.
	if (typeof result.exitCode === 'string') throw new Error(result.exitCode);
	return null;
};

/** The newest `cap` events that match `grep`, oldest first. */
function newestMatching(
	events: TimelineEvent[],
	grep: RegExp | undefined,
	cap: number
): TimelineEvent[] {
	const matching = grep ? events.filter((event) => timelineEventMatches(event, grep)) : events;
	return matching.length > cap ? matching.slice(-cap) : matching;
}

/** A read cap that still covers the caller's own caps. */
function readCap(input: ReadTimelineInput): number {
	return Math.max(READ_CAP_PER_SOURCE, input.tail ?? 0, input.perSourceTail ?? 0);
}

export async function readTimeline(input: ReadTimelineInput): Promise<ReadTimelineResult> {
	const { paths, agents, sources, sinceMs, untilMs, grep } = input;
	const now = input.now ?? Date.now();
	const wanted = new Set(sources);
	const cap = readCap(input);
	const notes: string[] = [];
	const batches: Promise<TimelineEvent[]>[] = [];

	for (const agent of agents) {
		// The window and the search apply before the cap, so an older match is
		// never cut for the sake of newer lines that do not match.
		if (wanted.has('history')) {
			batches.push(
				readRecentHistory(paths, agent.id, {
					sinceMs,
					untilMs,
					limit: grep ? undefined : cap,
				}).then((entries) =>
					newestMatching(
						entries.map((entry) => historyEntryToTimelineEvent(entry, agent.id)),
						grep,
						cap
					)
				)
			);
		}
		if (wanted.has('journey')) {
			const entries = readJourneyFile(
				journeyFilePath(paths.userDataDir, agent.id),
				{ since: sinceMs },
				now
			);
			const events = entries
				.filter((entry) => untilMs === undefined || entry.ts <= untilMs)
				.map((entry) => journeyEntryToTimelineEvent(entry, { cwd: agent.cwd }));
			batches.push(Promise.resolve(newestMatching(events, grep, cap)));
		}
	}

	if (wanted.has('git')) {
		const runGit = input.runGit ?? defaultRunGit;
		// Agents that share a working directory share its commits: ask git once.
		const byCwd = new Map<string, string>();
		for (const agent of agents) {
			if (agent.gitCwd && !byCwd.has(agent.gitCwd)) byCwd.set(agent.gitCwd, agent.id);
		}
		for (const [cwd, agentId] of byCwd) {
			batches.push(
				runGit(cwd, gitTimelineArgs(sinceMs, untilMs, grep ? GIT_SEARCH_READ_CAP : cap))
					.then((stdout) =>
						stdout === null ? [] : newestMatching(parseGitTimeline(stdout, agentId), grep, cap)
					)
					.catch((error: unknown) => {
						const reason = error instanceof Error ? error.message : String(error);
						notes.push(`git: no commits from ${cwd} (${reason})`);
						return [];
					})
			);
		}
	}

	if (wanted.has('computer') && input.computerHistory) {
		batches.push(
			queryEvents(computerHistoryDir(paths.userDataDir), {
				sinceMs,
				untilMs,
				grep,
				// Without a search, app switches alone: everything else is too
				// dense for a timeline and one `computer-history query` away.
				kinds: grep ? undefined : ['app.activated'],
				limit: cap,
			})
				.then((result) =>
					collapseRepeatedAppSwitches(
						result.events
							.map(computerEventToTimelineEvent)
							.filter((event): event is TimelineEvent => event !== null)
					)
				)
				.catch((error: unknown) => {
					notes.push(
						`computer: unreadable (${error instanceof Error ? error.message : String(error)})`
					);
					return [];
				})
		);
	}

	// Every source searched its own events above. Computer History searched the
	// full captured text, which its lines quote only the start of, so the merge
	// does not search again.
	const events = (await Promise.all(batches)).flat();
	return { events: selectTimelineEvents(events, { ...input, grep: undefined }), notes };
}
