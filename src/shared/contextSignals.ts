/**
 * Context signals: what a tab's transcript shows about repetition, and about
 * how ready the conversation is to be continued, as direct observations.
 *
 * Every line is something that can be pointed at in the transcript, with the
 * entries it rests on and what it cannot establish. There is no score, no
 * probability and no saving: a number here is a count or a reading the provider
 * reported, and `accounting.countsAsSavings` is the literal `false`.
 *
 * REPETITION (loops and churn)
 * Two kinds, both exact:
 *  - `repeated-failure`: the SAME call (same tool, same arguments; for a shell
 *    command the same argv, directory and added variables, as `readCommandCall`
 *    keys them) failed `minRepeats` or more times in a row.
 *  - `repeated-result`: the same file read returned the same stored text that
 *    many times in a row.
 * Message length and wording are never compared. The text of a result IS
 * compared, exactly as stored: whitespace, case, line endings and colour codes
 * are part of a file's text and of a failure's, so nothing is tidied up first
 * (what is SHOWN of a call is sanitized separately, and never compared).
 * A run is ENDED, and counted only up to that point, by: a file edit that
 * finished, a new user message, a completed compaction, a success of the same
 * call, or any step whose effect on the files cannot be shown to be none (a
 * shell command not provably read-only, a subagent, an MCP tool), or a
 * deliberate wait (a `sleep` call: whoever waits expects the world to change).
 * So test, edit, retest is never a run, and neither is a retry the agent
 * corrected or a retry after a wait. Reads, searches, a task-list update and
 * shell commands that only print do not end a run.
 * Polling is not repetition. A call that reads live state (a status command, a
 * web fetch, a background command's output) is never counted, and a file read
 * whose text changed starts over. The recognised commands are a short, stated
 * list; other polling can look like a repeat, and the report says so.
 *
 * READINESS (continuity)
 * Six readings, each `clear`, `open`, `info` or `unknown`: activity, repetition,
 * unverified edits, open failures, position since the last compaction, and the
 * context fill the provider reported. A reading with no evidence is `unknown`,
 * never `clear`: a tab with no usage record is not a tab with low use.
 *
 * WHAT THIS IS NOT
 * Nothing here blocks a tool call, rewrites or adds to a prompt, switches a
 * model, sends anything or keeps a cache warm. The advice is sentences in a
 * report. Where a report names routing it is `ContinuationRouting`: the routing
 * the next turn is CONFIGURED with, read through the settings' existing owners.
 * That is not a launch, so it never claims where a turn will actually go.
 *
 * Pure: no Electron, React, IPC, clock or file access. The same input gives the
 * same output, and the input is never changed.
 */

import { canonicalJson } from './canonicalJson';
import { describeRoutingLines, type ContinuationRouting } from './continuationRouting';
import { getBasename } from './formatters';
import { readCommandCall } from './literalCommand';
import { safeExcerpt } from './safeExcerpt';
import {
	describeToolActivity,
	describeToolActivityStatus,
	describeToolCommand,
	describeToolKind,
	normalizeToolName,
	type ToolKind,
} from './toolActivityLabel';
import { MAX_PERSISTED_TOOL_OUTPUT_CHARS } from './toolOutput';
import type { TabContinuitySignals } from './tabContextOps';

/** The slice of a transcript entry the signals read; a digest entry and a log entry both fit it. */
export interface SignalEntry {
	id: string;
	/** `user`, `ai`, `tool`, `error` or `system`. Any other kind is ignored. */
	source: string;
	text: string;
	/** A tool entry keeps its call here: `{ status, input, output }`, plus a provider's exit code. */
	metadata?: { toolState?: unknown };
	/** Set on the system entry that marks a compaction. */
	contextCompaction?: { status: string };
}

/** What the digest found, for the readings that need it. The digest itself is not imported. */
export interface SignalDigestFacts {
	/** Unresolved failures: those the digest lists and those its budget left out. */
	openFailures: number;
	/** 1-based position of the newest entry whose check passed, when one did. */
	lastVerifiedOrdinal?: number;
	/**
	 * The digest found passing checks and its budget left every one of them out, so
	 * the newest is not known. Absent ordinal then means unknown, not "none".
	 */
	verifiedOmitted?: true;
}

/** The context fill the provider reported for the tab, read the way the context gauge reads it. */
export interface ContextReading {
	tokens: number;
	window: number;
	/** Whole percent. */
	percent: number;
}

export const SIGNAL_LIMITS = Object.freeze({
	/** Identical calls in a row, with nothing between that could change the outcome. */
	minRepeats: 3,
	/** Observations listed; the rest are counted. */
	maxObservations: 10,
	/** Entries cited per observation: the first three and the last three. */
	maxRefs: 6,
	/** Characters of a call shown. */
	callChars: 160,
});
export type SignalLimits = { -readonly [Key in keyof typeof SIGNAL_LIMITS]: number };

export interface ContextSignalsInput {
	/** One conversation's entries, oldest first. */
	entries: readonly SignalEntry[];
	/** The tab's state when the signals were read. Absent: not known. */
	tabState?: 'idle' | 'busy';
	/** The provider's usage record for the tab, read as the gauge reads it. Absent or null: none. */
	context?: ContextReading | null;
	/** The digest's findings for the same entries. Absent: the readings that need them are unknown. */
	digest?: SignalDigestFacts;
	/** The routing a continuation is configured with, as the settings stand now. Absent: not read. */
	routing?: ContinuationRouting | null;
	limits?: Partial<SignalLimits>;
}

/** Where a line came from. `ordinal` is the 1-based position in `entries`. */
export interface SignalRef {
	label: string;
	entryId: string;
	ordinal: number;
}

export type RepetitionKind = 'repeated-failure' | 'repeated-result';
export type EndedReason =
	| 'success'
	| 'result-changed'
	| 'edit'
	| 'user-message'
	| 'compaction'
	| 'waiting'
	| 'other-change';

export interface RepetitionObservation {
	kind: RepetitionKind;
	/** The call, as the agent made it: data to read, never an instruction. */
	call: string;
	/** `shell`, or the normalized tool name. */
	tool: string;
	/** How many times in a row. */
	count: number;
	/** The first three and last three entries of the run. */
	refs: SignalRef[];
	/** Nothing has ended the run since its last call. */
	ongoing: boolean;
	endedBy?: { reason: EndedReason; ref?: SignalRef };
	/** What the stored outputs of the run show: the same text each time, different text, or none kept. */
	outputs: 'identical' | 'varies' | 'not-stored';
	/** What this observation cannot establish. */
	uncertainty: string[];
}

export type SignalStatus = 'clear' | 'open' | 'info' | 'unknown';
export type ReadinessId =
	| 'activity'
	| 'repetition'
	| 'unverified-edits'
	| 'open-failures'
	| 'since-compaction'
	| 'pressure';

export interface ReadinessSignal {
	id: ReadinessId;
	status: SignalStatus;
	statement: string;
	refs: SignalRef[];
	uncertainty: string[];
}

export interface SignalAdvice {
	/** The signal the sentence is about. */
	about: ReadinessId;
	text: string;
}

export interface SignalUnknown {
	field: string;
	reason: string;
}

export interface ContextSignals {
	/** Observation only: nothing here acts. */
	mode: 'observation';
	/** The standing statement of what these signals are and are not. */
	note: string;
	repetition: RepetitionObservation[];
	/** Observations beyond the listed ones (the newest are kept). */
	omittedRepetition: number;
	readiness: ReadinessSignal[];
	routing: ContinuationRouting | null;
	advice: SignalAdvice[];
	unknowns: SignalUnknown[];
	counts: {
		entries: number;
		toolCalls: number;
		/** Calls compared: they carry an input to key and finished. */
		compared: number;
		/** Calls that carry no usable input, so they cannot be compared. */
		unidentified: number;
		/** Calls that never reported an end. */
		unfinished: number;
		/** Calls of a kind that reads live state, never counted as a repeat. */
		liveState: number;
	};
	/** A reading is never a saving. */
	accounting: { countsAsSavings: false };
	limits: SignalLimits;
}

export const SIGNALS_NOTE =
	"Direct observations from this tab's transcript, with the entries they rest on. They are not scores or predictions, and nothing here blocks a call, changes a prompt, switches a model or sends anything.";

const STANDING_PROVIDER =
	"Only this tab's transcript is compared. A compaction the provider did on its own is not visible, and repeating a call after one is not a loop.";
const STANDING_LIVE =
	'Repeating a check of live state is normal polling. Only the commands and tools recognised as such are left out, so other polling can look like a repeat.';
const STANDING_CHANGE =
	'A change made outside this transcript (by a person or another tool) is not seen. A file changed by a shell command ends a run only when the command is not provably read-only.';
const STANDING = new Set([STANDING_PROVIDER, STANDING_LIVE, STANDING_CHANGE]);

// ---- What a call is -------------------------------------------------------

/** Programs that only print: a call of one cannot change what a repeated call will see. */
const READ_ONLY_PROGRAMS = new Set(
	'cat head tail ls pwd echo printf grep egrep fgrep rg wc stat file which type printenv whoami id uname date hostname jq tree realpath basename dirname diff cmp true false'.split(
		' '
	)
);
const READ_ONLY_GIT = new Set(
	'status diff log show rev-parse ls-files blame describe shortlog'.split(' ')
);

/**
 * Commands that read live state, whose repetition is how one waits. Matched at
 * the start of a command (or after `;`, `&`, `|`, `(`, `sudo`, `time` or a
 * variable assignment), so a word inside another command's arguments is not one.
 */
const COMMAND_START = String.raw`(?:^|[;&|(]\s*)(?:(?:sudo|time|nohup|command|exec|\w+=\S*)\s+)*`;
/** A deliberate wait. Whoever waits expects the world to change, so the retry after it is not a blind repeat. */
const WAIT_COMMAND = new RegExp(`${COMMAND_START}sleep(?=$|[\\s;&|)])`);
const LIVE_STATE_COMMAND = new RegExp(
	`${COMMAND_START}(?:${[
		'sleep',
		'watch',
		'until',
		'while',
		'curl',
		'wget',
		'http',
		'https',
		'ping',
		'nc',
		'ncat',
		'dig',
		'nslookup',
		'ps',
		'pgrep',
		'lsof',
		'netstat',
		'ss',
		'uptime',
		'free',
		'vmstat',
		'iostat',
		'df',
		'journalctl',
		String.raw`tail\s+-\w*f`,
		String.raw`tmux\s+(?:capture-pane|list-\w+)`,
		String.raw`git\s+(?:status|fetch|ls-remote)`,
		String.raw`docker(?:\s+compose)?\s+(?:ps|logs|inspect|stats|top|events|wait)`,
		String.raw`kubectl\s+(?:get|describe|logs|top|wait|rollout\s+status)`,
		String.raw`systemctl\s+(?:status|is-active|is-enabled|is-failed)`,
		String.raw`pm2\s+(?:status|list|logs|jlist)`,
		String.raw`gh\s+(?:run\s+(?:view|list|watch)|pr\s+(?:view|checks|status|list)|issue\s+(?:view|list)|workflow\s+(?:view|list)|api)`,
	].join('|')})(?=$|[\\s;&|)])`
);

function isReadOnlyShell(words: readonly string[] | null | undefined): boolean {
	if (!words?.length) return false;
	const program = getBasename(words[0]);
	if (program === 'git') {
		return READ_ONLY_GIT.has(words.slice(1).find((word) => !word.startsWith('-')) ?? '');
	}
	return READ_ONLY_PROGRAMS.has(program);
}

type Effect = 'none' | 'edit' | 'wait' | 'change';

interface Identity {
	key: string;
	shown: string;
	tool: string;
}

interface ToolReading {
	kind: ToolKind;
	outcome: 'ok' | 'failed' | 'running';
	live: boolean;
	effect: Effect;
	identity?: Identity;
	text?: string;
	cut: boolean;
}

/**
 * Read one tool entry: what kind of call it is, how it ended, what it does to
 * the files, and which call it is. The identity is absent when the entry
 * carries no input to key.
 */
function readTool(entry: SignalEntry, callChars: number): ToolReading {
	const state = entry.metadata?.toolState;
	const input = (state as { input?: unknown } | null | undefined)?.input;
	const kind = describeToolKind(entry.text, input);
	const status = describeToolActivityStatus(state);
	const outcome = status === 'completed' ? 'ok' : status;
	const shellCall = kind === 'shell' ? describeToolCommand(entry.text, input) : undefined;
	const reading = shellCall ? readCommandCall(shellCall) : undefined;
	const live =
		kind === 'live-read' || (shellCall !== undefined && LIVE_STATE_COMMAND.test(shellCall.text));

	let effect: Effect;
	if (kind === 'file-edit')
		effect = outcome === 'failed' ? 'none' : outcome === 'ok' ? 'edit' : 'change';
	else if (kind === 'shell') {
		effect =
			shellCall && WAIT_COMMAND.test(shellCall.text)
				? 'wait'
				: live || isReadOnlyShell(reading?.words)
					? 'none'
					: 'change';
	} else effect = kind === 'other' ? 'change' : 'none';

	const stored = (state as { output?: unknown } | null | undefined)?.output;
	return {
		kind,
		outcome,
		live,
		effect,
		identity: readIdentity(entry, input, shellCall, reading?.key, callChars),
		// The text exactly as stored: whitespace and colour codes are part of what a result IS.
		...(typeof stored === 'string' ? { text: stored } : {}),
		cut: typeof stored === 'string' && stored.length >= MAX_PERSISTED_TOOL_OUTPUT_CHARS,
	};
}

function readIdentity(
	entry: SignalEntry,
	input: unknown,
	shellCall: ReturnType<typeof describeToolCommand>,
	shellKey: string | undefined,
	callChars: number
): Identity | undefined {
	if (input === undefined || input === null) return undefined;
	if (shellCall && shellKey) {
		return {
			key: `shell:${shellKey}`,
			shown: safeExcerpt(shellCall.text, callChars, true).text,
			tool: 'shell',
		};
	}
	const tool = normalizeToolName(entry.text);
	try {
		const { verb, target } = describeToolActivity(entry.text, input);
		return {
			key: `tool:${tool}:${canonicalJson(input)}`,
			shown: safeExcerpt(`${verb} ${target}`.trim(), callChars, true).text,
			tool,
		};
	} catch (error) {
		// An input that is not JSON (a function, a cycle) has no identity; nothing else is expected here.
		if (error instanceof TypeError) return undefined;
		throw error;
	}
}

// ---- Runs -------------------------------------------------------------------

interface Streak {
	kind: RepetitionKind;
	identity: Identity;
	count: number;
	first: number[];
	last: number[];
	firstText?: string;
	lastText?: string;
	sameText: boolean;
	missingText: boolean;
	cut: boolean;
	unfinished: number;
}

const FIRST_REFS = 3;

/** Why a run ended when the same call finished again: a success, or a read that no longer matches. */
const endedByCompletion = (streak: Streak): EndedReason =>
	streak.kind === 'repeated-failure' ? 'success' : 'result-changed';

function startStreak(
	kind: RepetitionKind,
	identity: Identity,
	index: number,
	reading: ToolReading
): Streak {
	return {
		kind,
		identity,
		count: 1,
		first: [index],
		last: [],
		firstText: reading.text,
		lastText: reading.text,
		sameText: true,
		missingText: reading.text === undefined,
		cut: reading.cut,
		unfinished: 0,
	};
}

function extendStreak(streak: Streak, index: number, reading: ToolReading): void {
	streak.count += 1;
	if (streak.first.length < FIRST_REFS) streak.first.push(index);
	else {
		streak.last.push(index);
		if (streak.last.length > FIRST_REFS) streak.last.shift();
	}
	if (reading.text === undefined) streak.missingText = true;
	else if (reading.text !== streak.firstText) streak.sameText = false;
	streak.lastText = reading.text;
	streak.cut ||= reading.cut;
}

function readTranscript(entries: readonly SignalEntry[], limits: SignalLimits) {
	const refOf = (index: number): SignalRef => ({
		label: `${entries[index].source} #${index + 1}`,
		entryId: entries[index].id,
		ordinal: index + 1,
	});
	const streaks = new Map<string, Streak>();
	const observations: { observation: RepetitionObservation; endIndex: number }[] = [];
	const edits: number[] = [];
	const counts = { toolCalls: 0, compared: 0, unidentified: 0, unfinished: 0, liveState: 0 };
	let compactedAt = -1;
	let pendingCompactionAt = -1;
	let latestUserAt = -1;

	const close = (streak: Streak, ended?: { reason: EndedReason; index: number }): void => {
		if (streak.count < limits.minRepeats) return;
		const indexes = [...streak.first, ...streak.last];
		const unfinished = streak.unfinished;
		const failure = streak.kind === 'repeated-failure';
		const outputs = failure
			? streak.missingText
				? 'not-stored'
				: streak.sameText
					? 'identical'
					: 'varies'
			: 'identical';
		observations.push({
			endIndex: indexes[indexes.length - 1],
			observation: {
				kind: streak.kind,
				call: streak.identity.shown,
				tool: streak.identity.tool,
				count: streak.count,
				refs: indexes.map(refOf),
				ongoing: ended === undefined,
				...(ended ? { endedBy: { reason: ended.reason, ref: refOf(ended.index) } } : {}),
				outputs,
				uncertainty: [
					STANDING_PROVIDER,
					...(failure ? [STANDING_LIVE] : []),
					STANDING_CHANGE,
					...(failure && outputs === 'varies'
						? [
								'The failure text changed between attempts, so the attempts may not be the same failure.',
							]
						: []),
					...(failure && outputs === 'not-stored'
						? [
								'The output of at least one attempt was not stored, so whether the failures matched is unknown.',
							]
						: []),
					...(streak.cut
						? [
								`Stored output is cut at ${MAX_PERSISTED_TOOL_OUTPUT_CHARS.toLocaleString('en-US')} characters, so text past the cut is not compared.`,
							]
						: []),
					...(unfinished
						? [
								`${unfinished} call${unfinished === 1 ? '' : 's'} of the same invocation never reported an end and ${unfinished === 1 ? 'is' : 'are'} not counted.`,
							]
						: []),
				],
			},
		});
	};
	const closeAll = (reason: EndedReason, index: number, except?: string): void => {
		for (const [key, streak] of streaks) {
			if (key === except) continue;
			close(streak, { reason, index });
			streaks.delete(key);
		}
	};

	entries.forEach((entry, index) => {
		if (entry.source === 'user' && entry.text.trim()) {
			latestUserAt = index;
			closeAll('user-message', index);
			return;
		}
		if (entry.contextCompaction?.status === 'done') {
			compactedAt = index;
			closeAll('compaction', index);
		} else if (entry.contextCompaction?.status === 'pending') {
			pendingCompactionAt = index;
		}
		if (entry.source !== 'tool') return;

		counts.toolCalls += 1;
		const reading = readTool(entry, limits.callChars);
		if (reading.outcome === 'running') counts.unfinished += 1;
		if (reading.effect === 'edit') {
			edits.push(index);
			closeAll('edit', index);
		} else if (reading.effect === 'wait') {
			closeAll('waiting', index);
		}
		const { identity } = reading;
		if (!identity) {
			counts.unidentified += 1;
			// A call with no input cannot be matched, but its effect is still unknown.
			if (reading.effect === 'change') closeAll('other-change', index);
			return;
		}
		if (reading.effect === 'change') closeAll('other-change', index, identity.key);
		const own = streaks.get(identity.key);
		if (reading.outcome === 'running') {
			if (own) own.unfinished += 1;
			return;
		}
		// A check of live state is how one waits: it is neither compared nor a run.
		if (reading.live) {
			counts.liveState += 1;
			return;
		}
		counts.compared += 1;

		if (reading.outcome === 'failed') {
			if (own?.kind === 'repeated-failure') {
				extendStreak(own, index, reading);
				return;
			}
			if (own) close(own, { reason: 'result-changed', index });
			streaks.set(identity.key, startStreak('repeated-failure', identity, index, reading));
			return;
		}
		if (reading.kind === 'file-read' && reading.text !== undefined) {
			if (own?.kind === 'repeated-result' && own.lastText === reading.text) {
				extendStreak(own, index, reading);
				return;
			}
			if (own) close(own, { reason: endedByCompletion(own), index });
			streaks.set(identity.key, startStreak('repeated-result', identity, index, reading));
			return;
		}
		if (own) {
			close(own, { reason: endedByCompletion(own), index });
			streaks.delete(identity.key);
		}
	});
	for (const streak of streaks.values()) close(streak);

	return {
		observations,
		edits,
		counts,
		refOf,
		compactedAt,
		pendingCompactionAt,
		latestUserAt,
	};
}

// ---- Readiness --------------------------------------------------------------

type Transcript = ReturnType<typeof readTranscript>;

const plural = (count: number, one: string, many = `${one}s`): string =>
	`${count} ${count === 1 ? one : many}`;
const group = (count: number): string => count.toLocaleString('en-US');
const sentence = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

function readActivity(input: ContextSignalsInput, walk: Transcript): ReadinessSignal {
	const { entries, tabState } = input;
	const { latestUserAt, counts } = walk;
	const answered =
		latestUserAt >= 0 &&
		entries
			.slice(latestUserAt + 1)
			.some((entry) => entry.source === 'ai' || entry.source === 'tool');
	const unanswered = latestUserAt >= 0 && !answered;
	const parts = [
		tabState === 'busy'
			? 'a turn is running in this tab'
			: tabState === 'idle'
				? 'no turn is running in this tab'
				: 'whether a turn is running was not given',
		counts.unfinished
			? `${plural(counts.unfinished, 'tool call')} never reported an end`
			: 'every tool call reported an end',
		latestUserAt < 0
			? 'the transcript holds no user request'
			: answered
				? 'the newest request has a reply'
				: 'the newest request has no reply yet',
	];
	const open = tabState === 'busy' || counts.unfinished > 0 || unanswered;
	return {
		id: 'activity',
		status: open ? 'open' : tabState === 'idle' ? 'clear' : 'unknown',
		statement: `${sentence(parts.join('; '))}.`,
		refs: unanswered ? [walk.refOf(latestUserAt)] : [],
		uncertainty: counts.unfinished
			? [
					'A call can lack an end because the end was never recorded, not because it is still running.',
				]
			: [],
	};
}

function readRepetition(walk: Transcript, limits: SignalLimits): ReadinessSignal {
	const ongoing = walk.observations.filter(({ observation }) => observation.ongoing);
	const { counts } = walk;
	const uncertainty = [STANDING_PROVIDER, STANDING_LIVE, STANDING_CHANGE];
	if (ongoing.length) {
		return {
			id: 'repetition',
			status: 'open',
			statement: `${plural(ongoing.length, 'call')} repeated and not yet ended: ${ongoing
				.map(({ observation }) => `\`${observation.call}\` x${observation.count}`)
				.join(', ')}.`,
			refs: ongoing.map(({ observation }) => observation.refs[observation.refs.length - 1]),
			uncertainty,
		};
	}
	if (counts.toolCalls > 0 && counts.compared === 0) {
		return {
			id: 'repetition',
			status: 'unknown',
			statement: 'No tool call could be compared, so repetition is unknown.',
			refs: [],
			uncertainty,
		};
	}
	return {
		id: 'repetition',
		status: 'clear',
		statement: `No call repeated ${limits.minRepeats} or more times in a row without a change between (${plural(counts.compared, 'call')} compared).`,
		refs: [],
		uncertainty,
	};
}

function readEdits(
	input: ContextSignalsInput,
	walk: Transcript
): { signal: ReadinessSignal; sinceCheck: number } {
	const { digest, entries } = input;
	const uncertainty = [
		'Only edits made with an edit tool are counted; a file changed by a shell command is not.',
		'A passing check is one literal invocation of a known runner whose output shows a passing line; anything else is not counted.',
	];
	if (!digest) {
		return {
			sinceCheck: 0,
			signal: {
				id: 'unverified-edits',
				status: 'unknown',
				statement: 'No digest was given, so passing checks are not known.',
				refs: [],
				uncertainty,
			},
		};
	}
	if (walk.edits.length === 0) {
		return {
			sinceCheck: 0,
			signal: {
				id: 'unverified-edits',
				status: 'clear',
				statement: 'No file edit finished in this transcript.',
				refs: [],
				uncertainty,
			},
		};
	}
	if (digest.verifiedOmitted && digest.lastVerifiedOrdinal === undefined) {
		return {
			sinceCheck: 0,
			signal: {
				id: 'unverified-edits',
				status: 'unknown',
				statement:
					"The digest's size budget left out the passing checks it found, so which edits they cover is not known.",
				refs: [walk.refOf(walk.edits[walk.edits.length - 1])],
				uncertainty,
			},
		};
	}
	const lastEdit = walk.edits[walk.edits.length - 1] + 1;
	const verified =
		digest.lastVerifiedOrdinal !== undefined &&
		digest.lastVerifiedOrdinal >= 1 &&
		digest.lastVerifiedOrdinal <= entries.length
			? digest.lastVerifiedOrdinal
			: undefined;
	const refs = [walk.refOf(lastEdit - 1), ...(verified ? [walk.refOf(verified - 1)] : [])];
	if (verified !== undefined && verified > lastEdit) {
		return {
			sinceCheck: 0,
			signal: {
				id: 'unverified-edits',
				status: 'clear',
				statement: `A check passed at entry #${verified}, after the last file edit (entry #${lastEdit}).`,
				refs,
				uncertainty,
			},
		};
	}
	const sinceCheck =
		verified === undefined
			? walk.edits.length
			: walk.edits.filter((index) => index + 1 > verified).length;
	return {
		sinceCheck,
		signal: {
			id: 'unverified-edits',
			status: 'open',
			statement:
				verified === undefined
					? `${plural(sinceCheck, 'file edit')} and no passing check in this transcript.`
					: `${plural(sinceCheck, 'file edit')} since the last passing check (entry #${verified}).`,
			refs,
			uncertainty,
		},
	};
}

function readFailures(input: ContextSignalsInput): ReadinessSignal {
	const { digest } = input;
	const uncertainty = [
		'Only shell failures and errors no reply followed are read as failures; a failed edit or read is not.',
	];
	if (!digest) {
		return {
			id: 'open-failures',
			status: 'unknown',
			statement: 'No digest was given, so unresolved failures are not known.',
			refs: [],
			uncertainty,
		};
	}
	return {
		id: 'open-failures',
		status: digest.openFailures > 0 ? 'open' : 'clear',
		statement:
			digest.openFailures > 0
				? `${plural(digest.openFailures, 'unresolved failure')} would travel with a continuation (listed under Unresolved failures in the digest).`
				: 'The digest lists no unresolved failure.',
		refs: [],
		uncertainty,
	};
}

function readCompaction(input: ContextSignalsInput, walk: Transcript): ReadinessSignal {
	const { compactedAt, pendingCompactionAt } = walk;
	const uncertainty = [
		'The provider may have compacted this conversation on its own; Maestro does not see that.',
	];
	if (pendingCompactionAt > compactedAt) {
		return {
			id: 'since-compaction',
			status: 'open',
			statement: `A compaction is pending at entry #${pendingCompactionAt + 1}.`,
			refs: [walk.refOf(pendingCompactionAt)],
			uncertainty,
		};
	}
	if (compactedAt >= 0) {
		return {
			id: 'since-compaction',
			status: 'info',
			statement: `The last completed compaction is entry #${compactedAt + 1}; ${plural(input.entries.length - 1 - compactedAt, 'entry', 'entries')} follow it.`,
			refs: [walk.refOf(compactedAt)],
			uncertainty,
		};
	}
	return {
		id: 'since-compaction',
		status: 'info',
		statement: 'No completed compaction is recorded in this transcript.',
		refs: [],
		uncertainty,
	};
}

const isCount = (value: unknown): value is number =>
	typeof value === 'number' && Number.isFinite(value) && value >= 0;

function readPressure(context: ContextReading | null | undefined): ReadinessSignal {
	if (
		!context ||
		!isCount(context.tokens) ||
		!isCount(context.window) ||
		!isCount(context.percent)
	) {
		return {
			id: 'pressure',
			status: 'unknown',
			statement:
				'This tab has no usable usage record, so how full its context is is unknown. That is not the same as low use.',
			refs: [],
			uncertainty: [],
		};
	}
	return {
		id: 'pressure',
		status: 'info',
		statement: `The provider reported about ${context.percent}% of a ${group(context.window)}-token window in use (${group(context.tokens)} tokens) at the end of the latest turn.`,
		refs: [],
		uncertainty: [
			"This is the latest reading; entries added since are not in it, and it is the provider's count, not Maestro's.",
		],
	};
}

function adviceFor(
	repetition: RepetitionObservation[],
	edits: { signal: ReadinessSignal; sinceCheck: number },
	failures: ReadinessSignal,
	openFailures: number
): SignalAdvice[] {
	const advice: SignalAdvice[] = [];
	for (const item of repetition) {
		if (!item.ongoing) continue;
		advice.push({
			about: 'repetition',
			text:
				item.kind === 'repeated-failure'
					? `\`${item.call}\` failed ${item.count} times in a row with no file edit between. Another identical attempt adds no new evidence unless something outside this transcript has changed.`
					: `\`${item.call}\` returned the same text ${item.count} times in a row; the transcript already holds it.`,
		});
	}
	if (edits.signal.status === 'open' && edits.sinceCheck > 0) {
		advice.push({
			about: 'unverified-edits',
			text: 'File edits after the last passing check have not been verified; a continuation would need to run the check again.',
		});
	}
	if (failures.status === 'open') {
		advice.push({
			about: 'open-failures',
			text: `${plural(openFailures, 'unresolved failure')} would carry into a continuation.`,
		});
	}
	return advice;
}

/**
 * Read a tab's transcript for repetition and for readiness to continue. The
 * input is not changed and nothing is kept between calls.
 */
export function buildContextSignals(input: ContextSignalsInput): ContextSignals {
	const limits: SignalLimits = { ...SIGNAL_LIMITS, ...input.limits };
	const walk = readTranscript(input.entries, limits);
	const ordered = [...walk.observations]
		.sort((a, b) => b.endIndex - a.endIndex)
		.map(({ observation }) => observation);
	const repetition = ordered.slice(0, limits.maxObservations);

	const edits = readEdits(input, walk);
	const failures = readFailures(input);
	const readiness = [
		readActivity(input, walk),
		readRepetition(walk, limits),
		edits.signal,
		failures,
		readCompaction(input, walk),
		readPressure(input.context),
	];
	const { counts } = walk;
	const unknowns: SignalUnknown[] = [
		...(input.entries.length === 0
			? [{ field: 'entries', reason: 'The tab has no transcript entries.' }]
			: []),
		...(counts.unidentified
			? [
					{
						field: 'calls',
						reason: `${plural(counts.unidentified, 'tool entry', 'tool entries')} carry no usable input, so they cannot be compared.`,
					},
				]
			: []),
		...(counts.unfinished
			? [
					{
						field: 'outcomes',
						reason: `${plural(counts.unfinished, 'tool call')} never reported an end and are not counted.`,
					},
				]
			: []),
		...readiness
			.filter((signal) => signal.status === 'unknown')
			.map((signal) => ({ field: signal.id, reason: signal.statement })),
	];

	return {
		mode: 'observation',
		note: SIGNALS_NOTE,
		repetition,
		omittedRepetition: ordered.length - repetition.length,
		readiness,
		routing: input.routing ?? null,
		advice: adviceFor(repetition, edits, failures, input.digest?.openFailures ?? 0),
		unknowns,
		counts: { entries: input.entries.length, ...counts },
		accounting: { countsAsSavings: false },
		limits,
	};
}

// ---- Report -----------------------------------------------------------------

const ENDED_BY: Record<EndedReason, string> = {
	success: 'a success of the same call',
	'result-changed': 'a different result',
	edit: 'a file edit',
	'user-message': 'a new user message',
	compaction: 'a completed compaction',
	waiting: 'a wait between attempts',
	'other-change': 'a step that may have changed files',
};

function describeRepetition(item: RepetitionObservation): string {
	const what = item.kind === 'repeated-failure' ? 'repeated failure' : 'repeated read';
	const cited = item.refs.map((ref) => ref.label).join(', ');
	const state = item.ongoing
		? 'not yet ended'
		: `ended by ${ENDED_BY[item.endedBy?.reason ?? 'other-change']}${item.endedBy ? ` at ${item.endedBy.ref?.label}` : ''}`;
	const outputs =
		item.kind === 'repeated-result'
			? 'the same text each time'
			: item.outputs === 'identical'
				? 'the same failure text each time'
				: item.outputs === 'varies'
					? 'the failure text varied'
					: 'failure text not stored';
	const own = item.uncertainty.filter((line) => !STANDING.has(line));
	return `- ${what} x${item.count}, ${state}: \`${item.call}\` (${cited}); ${outputs}.${own.length ? ` ${own.join(' ')}` : ''}`;
}

/**
 * The signals as plain text for a person. Every dynamic string was made safe
 * when it was read; the text is for a `<pre>` or a terminal, never Markdown.
 */
export function formatContextSignals(signals: ContextSignals): string {
	const { repetition, counts } = signals;
	const lines = [
		`Signals: ${signals.note}`,
		'',
		'Repetition (the same call, the same arguments, nothing between that could change the outcome):',
	];
	if (repetition.length) {
		lines.push(...repetition.map(describeRepetition));
		if (signals.omittedRepetition) {
			lines.push(
				`- ${signals.omittedRepetition} older ${signals.omittedRepetition === 1 ? 'run is' : 'runs are'} not listed.`
			);
		}
	} else {
		lines.push(`- None found among ${plural(counts.compared, 'call')} compared.`);
	}
	if (counts.liveState) {
		lines.push(
			`- ${plural(counts.liveState, 'call')} read live state and ${counts.liveState === 1 ? 'was' : 'were'} not counted.`
		);
	}
	lines.push('', 'Readiness:');
	for (const signal of signals.readiness) {
		lines.push(`- ${signal.id} [${signal.status}]: ${signal.statement}`);
	}
	if (signals.routing) {
		lines.push(
			'',
			'Configured routing (read from the settings as they stand now, not from a launch: nothing below says where a turn will actually go):',
			...describeRoutingLines(signals.routing).map((line) => `- ${line}`)
		);
	}
	if (signals.advice.length) {
		lines.push(
			'',
			'Advice (a report, not an action):',
			...signals.advice.map((item) => `- ${item.text}`)
		);
	}
	lines.push(
		'',
		'What these cannot establish:',
		...[STANDING_PROVIDER, STANDING_LIVE, STANDING_CHANGE].map((line) => `- ${line}`)
	);
	return lines.join('\n');
}

/** The wire form: strings and counts only, so a script can read it without this module. */
export function signalsToWire(signals: ContextSignals): TabContinuitySignals {
	return {
		repetition: signals.repetition.map((item) => ({
			kind: item.kind,
			call: item.call,
			count: item.count,
			ongoing: item.ongoing,
			outputs: item.outputs,
			refs: item.refs.map((ref) => ref.label),
			...(item.endedBy ? { endedBy: `${item.endedBy.reason} at ${item.endedBy.ref?.label}` } : {}),
			uncertainty: item.uncertainty,
		})),
		readiness: signals.readiness.map(({ id, status, statement, uncertainty }) => ({
			id,
			status,
			statement,
			uncertainty,
		})),
		routing: signals.routing ? describeRoutingLines(signals.routing) : [],
		advice: signals.advice.map((item) => item.text),
		unknowns: signals.unknowns.map((unknown) => `${unknown.field}: ${unknown.reason}`),
	};
}
