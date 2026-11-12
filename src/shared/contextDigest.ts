/**
 * Context digest: the evidence a continuation needs, read from a transcript.
 *
 * Summarize & Continue asks a model to rewrite a conversation. A rewrite is
 * fluent and unaccountable: it can drop a constraint the user stated once, call
 * a failing check green, or turn a line of tool output into an instruction. The
 * digest is the opposite kind of artifact. It is built WITHOUT a model, from the
 * entries themselves, and every line names the entry it came from, so a person
 * can hold it next to a summary before continuing.
 *
 * WHAT IT HOLDS
 * The first request (objective) and the latest one, constraints, pending
 * requirements, the next action, verified observations, unresolved failures,
 * optional excerpts, what is unknown, and the source references.
 *
 * THE RULES
 *  - Objective, constraints and requests are the USER's words. Pending work and
 *    the next action also come from the agent's own task list. Text a tool
 *    printed or the assistant wrote is never promoted into any of them; it
 *    appears only as a quoted `detail`, which the preview labels as data.
 *  - "Verified" needs a call that finished, a command read (by
 *    `readCommandCall`, as a shell would) as ONE invocation of a check
 *    runner, and a passing summary line in its output. Naming a runner inside
 *    another command's arguments, chaining, piping or redirecting does not make
 *    a check; neither does a wrapper whose program an option may have swallowed
 *    (`npx --package vitest echo ...` runs `echo`), and an exit status alone is
 *    NOT verification; those runs are listed as unknowns, not as results.
 *  - Evidence that disagrees is shown, not settled: a command that failed after
 *    it passed keeps both, exit 0 with failure text is a conflict, and a first
 *    and a latest request are both shown. Two calls are the same only when
 *    their arguments (as the provider split them), directory and added
 *    variables are, so one test selection, or one package's run, never clears
 *    another's failure.
 *  - The user's words are kept as written: case and spacing are not folded, and
 *    a line break shows as ⏎. Only a secret is replaced, by its placeholder.
 *  - What cannot be established is listed under `unknowns` with its reason.
 *  - Bounded and deterministic: the same entries give the same digest.
 *
 * Pure: no Electron, React, IPC, clock or file access. Nothing here starts a
 * turn, reads provider state or runs on a timer, so there is no checkpoint to
 * keep fresh and nothing to restore. The caller decides when to build one.
 */

import { getBasename, truncateAtWordBoundary } from './formatters';
import { readCommandCall, type CommandCall } from './literalCommand';
import { forEachMarkdownLine } from './markdownTaskScan';
import { redactSecrets } from './redactSecrets';
import { stripAnsiCodes, stripControlCharacters } from './stringUtils';
import { isFailedSynopsisResponse, parseSynopsis } from './synopsis';
import {
	describeToolActivityStatus,
	describeToolCommand,
	describeToolTaskList,
	describesFileEdit,
	type ToolTaskItem,
} from './toolActivityLabel';
import { MAX_PERSISTED_TOOL_OUTPUT_CHARS } from './toolOutput';

/** The slice of a transcript entry the digest reads; `LogEntry` and `LogEntryRecord` both fit it. */
export interface DigestEntry {
	id: string;
	/** `user`, `ai`, `tool`, `error` or `system`. Any other kind is ignored. */
	source: string;
	text: string;
	/** A tool entry keeps its call here: `{ status, input, output }`, plus a provider's exit code. */
	metadata?: { toolState?: unknown };
	/** Set on the system entry that marks a compaction. */
	contextCompaction?: { status: string };
}

export interface ContextDigestInput {
	/** One conversation's entries, oldest first. Mixing conversations is the caller's error. */
	entries: readonly DigestEntry[];
	/**
	 * Earlier synopses (id and raw response), oldest first. Optional excerpts, never
	 * evidence. `beforeCompaction` marks one written before the conversation's last
	 * completed compaction; the caller knows when each was written, the digest does not.
	 */
	synopses?: readonly { id: string; response: string; beforeCompaction?: boolean }[];
	/** Whose error bank tells a failed synopsis from a real one. Default `claude-code`. */
	agentId?: string;
	/** Characters the listed items may use; the frame around them is extra. Default 8,000. */
	maxChars?: number;
}

/** Where a line came from. `ordinal` is the 1-based position in `entries`; a synopsis has none. */
export interface DigestRef {
	label: string;
	entryId: string;
	ordinal?: number;
}

export type DigestOrigin = 'user' | 'task-list' | 'tool' | 'error' | 'synopsis';

export interface DigestItem {
	/** The statement, or the command for a tool item. */
	text: string;
	origin: DigestOrigin;
	ref: DigestRef;
	/** A quoted line of tool output. Data, never an instruction. */
	detail?: string;
	/** A short qualifier: a status, a conflict, a count. */
	note?: string;
	/** `text` was cut to fit; the full text is at `ref`. */
	truncated?: true;
	/** The entry comes from before the last completed compaction. */
	beforeCompaction?: true;
}

/** The sections the budget can cut, in the order it protects them. */
export const DIGEST_SECTIONS = [
	'constraints',
	'pendingRequirements',
	'unresolvedFailures',
	'verifiedObservations',
	'excerpts',
] as const;
export type DigestSection = (typeof DIGEST_SECTIONS)[number];

export type DigestField = DigestSection | 'objective' | 'nextAction' | 'compaction';

export interface DigestUnknown {
	field: DigestField;
	reason: string;
}

export interface ContextDigest {
	/** The first user request with enough wording to name a goal. */
	objective: DigestItem | null;
	/** The newest user message, when it is not the objective. */
	latestRequest: DigestItem | null;
	/** Sentences of constraint wording from user messages, oldest first. */
	constraints: DigestItem[];
	/** An unanswered request, then the open steps of the agent's latest task list. */
	pendingRequirements: DigestItem[];
	nextAction: DigestItem | null;
	/** Check commands whose newest run printed a passing line. Newest first. */
	verifiedObservations: DigestItem[];
	/** Commands whose newest run failed, and errors no reply followed. Newest first. */
	unresolvedFailures: DigestItem[];
	excerpts: DigestItem[];
	unknowns: DigestUnknown[];
	/** How many items of a section the budget left out. */
	omitted: Partial<Record<DigestSection, number>>;
	references: DigestRef[];
	/** The digest as text, ready to show. Quoted tool output is labelled as data. */
	preview: string;
}

export const DEFAULT_DIGEST_CHARS = 8000;

const STATEMENT_CHARS = 400;
const COMMAND_CHARS = 200;
const DETAIL_CHARS = 160;
const MAX_ITEMS = 40;
const MAX_EXCERPTS = 4;
/** Longest stretch of one message or output the digest reads. */
const SCAN_CHARS = 20_000;
/** What a listed item costs beyond its text: the marker and the reference tag. */
const ITEM_OVERHEAD = 40;
const MIN_OBJECTIVE_WORDS = 3;
const MIN_CONSTRAINT_CHARS = 8;

/** Wording that limits how work is done. A cue finds a sentence to show, it decides nothing. */
const CONSTRAINT_CUE =
	/\b(?:must|mustn't|do\s+not|don't|dont|never|always|only|without|avoid|ensure|make\s+sure|should\s+not|shouldn't|cannot|can't|not\s+allowed|forbidden|required|exactly|at\s+most|at\s+least|unless|instead\s+of|rather\s+than|keep|preserve|no\s+more\s+than|no\s+new|no\s+extra)\b/i;
/** Wording that may take back an earlier instruction. */
const RETRACTION_CUE =
	/\b(?:ignore\s+(?:that|what\s+i\s+(?:said|wrote)|my\s+(?:earlier|previous|last)|the\s+(?:earlier|previous|above))|disregard|forget\s+(?:that|what\s+i|about\s+(?:that|it))|scratch\s+that|never\s?mind|change\s+of\s+plan|new\s+plan)\b/i;
const SENTENCE_BREAK = /(?<=[.!?;])\s+/;
const LIST_MARKER = /^(?:[-*+]|\d+[.)])\s+/;

/**
 * Does this text MENTION a way to check the work? Only used to flag a command
 * that cannot be read as one invocation. A mention never verifies anything:
 * `rg 'npm test' log` and `cat 'npm test results.log'` mention one too.
 */
const MENTIONS_CHECK =
	/\b(?:vitest|jest|mocha|pytest|rspec|phpunit|tsc|eslint|prettier|ruff|mypy|pyright|golangci-lint|clippy)\b|\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|lint|build|typecheck|check|validate)\b|\b(?:go|cargo|dotnet|swift|mvn|gradle|make)\s+(?:test|check|build|vet|verify)\b/i;
const CHECK_PROGRAMS = new Set(
	'vitest jest mocha pytest rspec phpunit tsc eslint prettier ruff mypy pyright golangci-lint tox nox'.split(
		' '
	)
);
const PACKAGE_RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
/** Programs that run another program: the first word after their switches is that program. */
const PACKAGE_EXECUTORS = new Set(['npx', 'bunx', 'pnpx']);
/**
 * The switches of those executors that take no value. Any other option may take
 * the next word as its value (`--package vitest`, `-c 'echo ok'`), so the word
 * after it is not known to be the program.
 */
const PLAIN_SWITCHES = new Set([
	'-y',
	'--yes',
	'--no',
	'--no-install',
	'-q',
	'--quiet',
	'--silent',
	'--ignore-scripts',
	'--offline',
	'--prefer-offline',
	'--prefer-online',
]);
const CHECK_SCRIPT = /^(?:test|lint|build|typecheck|check|validate)(?::[\w-]+)?$/;
const CHECK_SUBCOMMANDS = new Map<string, readonly string[]>([
	['go', ['test', 'vet', 'build']],
	['cargo', ['test', 'check', 'build', 'clippy']],
	['dotnet', ['test', 'build']],
	['swift', ['test', 'build']],
	['mvn', ['test', 'verify']],
	['gradle', ['test', 'check', 'build']],
	['make', ['test', 'check', 'build', 'lint', 'verify']],
]);
/** A summary line a test, lint or type runner prints when it passed. */
const PASS_LINE =
	/\b[1-9]\d*\s+(?:tests?\s+)?passed\b|\ball\s+(?:checks|tests)\s+passed\b|\bfound\s+0\s+errors\b|\bno\s+issues\s+found\b|\ball\s+matched\s+files\s+use\s+prettier\b|^ok\s+\S+\s+[\d.]+m?s\b/i;
/** A count of failures; a zero count is not one. */
const FAILURE_COUNT = /\b[1-9]\d*\s+(?:tests?\s+)?(?:failed|failing|errors?|problems?)\b/i;
/** A marker runners print in capitals, so this one is case sensitive. */
const FAILURE_MARK =
	/^(?:FAIL|FAILED|ERROR)\b|\berror TS\d+\b|\bnpm ERR!|^Traceback \(most recent call last\)|^[✗✖×]/;

const isFailureLine = (line: string): boolean =>
	FAILURE_COUNT.test(line) || FAILURE_MARK.test(line);

/**
 * One finished shell call, read as a check. `unparsed` is a command that
 * mentions a check but is not one literal invocation (it chains, pipes,
 * redirects or expands, or runs behind a wrapper whose program cannot be
 * named), so its output cannot be tied to a single check.
 */
interface Run {
	index: number;
	/** The command as shown. For an argv array, elements that hold a space are quoted. */
	command: string;
	/** Same key, same invocation (see `readCommandCall`); built from the exact text when unreadable. */
	key: string;
	/** The directory the call asked to run in, when it named one. Shown beside the command. */
	cwd?: string;
	/** Names of the variables the call asked to add. Never their values. */
	envNames?: string[];
	kind: 'verified' | 'failed' | 'conflict' | 'exit-only' | 'unparsed';
	/** The line of output the kind rests on. */
	detail?: string;
	/** The stored output reached its size cap, so a summary at its end may be missing. */
	cutOff: boolean;
}

/** Every outcome of one command, newest and the newest of each kind that matters. */
interface RunHistory {
	latest: Run;
	lastVerified?: Run;
	lastFailure?: Run;
}

const lastIndexWhere = <T>(items: readonly T[], test: (item: T) => boolean): number =>
	items.map(test).lastIndexOf(true);

/**
 * Text safe to show on one line: control characters removed (an escape or a
 * bidirectional override in a pasted line or a model's reply must not act on a
 * terminal or reorder what a reader sees), secret-shaped spans redacted, each
 * line break shown as ⏎, cut at a word. Spacing inside a line is NOT touched: a
 * path with two spaces or a quoted argument is the user's or the command's own.
 * Tool and agent text (`data`) also loses backticks, so nothing it holds can
 * close the code span the preview wraps it in.
 */
function safeText(text: string, limit: number, data: boolean): { text: string; truncated?: true } {
	let shown = redactSecrets(stripControlCharacters(text.slice(0, SCAN_CHARS)).trim())
		.text.replace(/[ \t]*\n+\s*/g, ' ⏎ ')
		.trim();
	if (data) shown = shown.replace(/`/g, "'");
	return shown.length > limit
		? { text: truncateAtWordBoundary(shown, limit), truncated: true }
		: { text: shown };
}

const wordCount = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length;

/** A request with enough wording to name a goal; a bare `/command` or "ok go on" is not one. */
const isSubstantive = (text: string): boolean =>
	wordCount(text.replace(/^\/\S+\s*/, '')) >= MIN_OBJECTIVE_WORDS;

/**
 * A line's sentences, never split inside an inline code span (`a. b` stays one)
 * or after an abbreviation that is not the end of a sentence ("e.g. vitest").
 */
function sentencesOf(line: string): string[] {
	const spans: string[] = [];
	const masked = line
		.replace(/\0/g, '')
		.replace(/`[^`]*`|\b(?:e\.g|i\.e|vs|cf)\./gi, (span) => `\0${spans.push(span) - 1}\0`);
	return masked
		.split(SENTENCE_BREAK)
		.map((part) => part.replace(/\0(\d+)\0/g, (_, n) => spans[Number(n)]));
}

/**
 * Sentences of constraint wording in one user message, exactly as written.
 * Fenced code and quoted (`>`) lines are skipped, so pasted output cannot pose
 * as the user's rule, and a question is never a constraint.
 */
function constraintSentences(text: string): string[] {
	const found: string[] = [];
	forEachMarkdownLine(text.slice(0, SCAN_CHARS), (line) => {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('>')) return;
		for (const part of sentencesOf(trimmed.replace(LIST_MARKER, ''))) {
			const sentence = part.trim();
			if (
				sentence.length >= MIN_CONSTRAINT_CHARS &&
				!sentence.endsWith('?') &&
				CONSTRAINT_CUE.test(sentence)
			) {
				found.push(sentence);
			}
		}
	});
	return found;
}

function findLine(text: string, test: (line: string) => boolean): string | undefined {
	for (const line of text.split('\n')) {
		const trimmed = line.trim();
		if (trimmed && test(trimmed)) return trimmed;
	}
	return undefined;
}

/**
 * What a literal command (program first) is. `check` is ONE invocation of a
 * check runner; `other` is a program that is not one; `unknown` is a wrapper
 * whose program cannot be named, because an option in front of it may have
 * taken the next word as its value (`npx --package vitest echo ok` runs `echo`).
 */
function readInvocation(words: readonly string[]): 'check' | 'other' | 'unknown' {
	const program = getBasename(words[0]);
	const args = words.slice(1);
	if (CHECK_PROGRAMS.has(program)) return 'check';
	if (PACKAGE_EXECUTORS.has(program)) {
		const wrapped = args.find((arg) => !PLAIN_SWITCHES.has(arg));
		if (wrapped === undefined || wrapped.startsWith('-')) return 'unknown';
		return CHECK_PROGRAMS.has(wrapped) ? 'check' : 'other';
	}
	if (PACKAGE_RUNNERS.has(program)) {
		return CHECK_SCRIPT.test((args[0] === 'run' ? args[1] : args[0]) ?? '') ? 'check' : 'other';
	}
	if (/^python3?$/.test(program) && args[0] === '-m') {
		return CHECK_PROGRAMS.has(args[1] ?? '') || args[1] === 'unittest' ? 'check' : 'other';
	}
	return CHECK_SUBCOMMANDS.get(program)?.includes(args[0]) ? 'check' : 'other';
}

/**
 * Read one finished shell call as a check. A failed call of any command is a
 * failure. A call that finished is judged only when it is a check: one literal
 * invocation of a runner (`readInvocation`), or a command that merely mentions
 * one and cannot be read as such (`unparsed`). Failure text beside a clean exit
 * is a conflict, a passing summary line from a read invocation is verified, and
 * a clean exit with nothing stated is exit-only. Other commands that finished
 * say nothing worth keeping: `grep FAIL log.txt` is not a failed check, and
 * `cat 'npm test results.log'` is not a passing one.
 */
function classifyRun(
	index: number,
	call: CommandCall,
	state: unknown,
	failed: boolean
): Run | undefined {
	const { key, words } = readCommandCall(call);
	const stored = (state as { output?: unknown } | null | undefined)?.output;
	const output = typeof stored === 'string' ? stored : '';
	const text = stripAnsiCodes(output.slice(0, SCAN_CHARS));
	const envNames = call.env ? Object.keys(call.env) : [];
	const run = {
		index,
		command: call.text,
		key,
		...(call.cwd ? { cwd: call.cwd } : {}),
		...(envNames.length ? { envNames } : {}),
		cutOff: output.length >= MAX_PERSISTED_TOOL_OUTPUT_CHARS,
	};
	const failure = findLine(text, isFailureLine);
	if (failed) {
		const last = text.trimEnd().split('\n').pop()?.trim();
		return { ...run, kind: 'failed', detail: failure ?? last };
	}
	const invocation = words ? readInvocation(words) : 'unknown';
	if (invocation === 'other') return undefined;
	if (invocation === 'unknown' && !MENTIONS_CHECK.test(call.text)) return undefined;
	if (failure) return { ...run, kind: 'conflict', detail: failure };
	if (invocation === 'unknown') return { ...run, kind: 'unparsed' };
	const pass = findLine(text, (line) => PASS_LINE.test(line));
	return pass ? { ...run, kind: 'verified', detail: pass } : { ...run, kind: 'exit-only' };
}

/**
 * What the call said about where it ran: its directory and the NAMES of the
 * variables it added, never their values. Two runs of one command that differ
 * only here would otherwise read alike in the preview.
 */
function runContext(run: Run): string[] {
	return [
		...(run.cwd ? [`in ${safeText(run.cwd, 80, true).text}`] : []),
		...(run.envNames ? [`with env ${safeText(run.envNames.join(' '), 60, true).text}`] : []),
	];
}

function recordRun(histories: Map<string, RunHistory>, run: Run): void {
	const previous = histories.get(run.key);
	histories.set(run.key, {
		latest: run,
		lastVerified: run.kind === 'verified' ? run : previous?.lastVerified,
		lastFailure: run.kind === 'failed' || run.kind === 'conflict' ? run : previous?.lastFailure,
	});
}

/**
 * What every reader below shares: the entries, the compaction boundaries
 * (index of the last completed one and of the last pending one, or -1), how to
 * cite an entry, and how to turn its text into a listed item.
 */
function openEvidence(entries: readonly DigestEntry[]) {
	const compactedAt = lastIndexWhere(entries, (e) => e.contextCompaction?.status === 'done');
	const pendingCompactionAt = lastIndexWhere(
		entries,
		(e) => e.contextCompaction?.status === 'pending'
	);
	const refOf = (index: number): DigestRef => ({
		label: `${entries[index].source} #${index + 1}`,
		entryId: entries[index].id,
		ordinal: index + 1,
	});
	const make = (
		index: number,
		text: string,
		origin: DigestOrigin,
		extra: Pick<DigestItem, 'detail' | 'note'> = {},
		limit = STATEMENT_CHARS
	): DigestItem => {
		const clipped = safeText(text, limit, origin !== 'user');
		return {
			text: clipped.text,
			origin,
			ref: refOf(index),
			...extra,
			...(clipped.truncated ? { truncated: true as const } : {}),
			...(index < compactedAt ? { beforeCompaction: true as const } : {}),
		};
	};
	return { entries, compactedAt, pendingCompactionAt, refOf, make };
}
type Evidence = ReturnType<typeof openEvidence>;

/** The user's words: objective, newest request, constraints. */
function readUserWords(ev: Evidence) {
	const { entries, make } = ev;
	const users = entries.flatMap((entry, i) =>
		entry.source === 'user' && entry.text.trim() ? [i] : []
	);
	const objectiveAt = users.find((i) => isSubstantive(entries[i].text));
	const latestAt: number | undefined = users[users.length - 1];
	const constraints: DigestItem[] = [];
	const seen = new Set<string>();
	let hasConstraint = false;
	/** The first message, after one that held a constraint, worded to take it back. */
	let retractedAt: number | undefined;
	for (const i of users) {
		if (
			hasConstraint &&
			retractedAt === undefined &&
			RETRACTION_CUE.test(entries[i].text.slice(0, SCAN_CHARS))
		) {
			retractedAt = i;
		}
		for (const sentence of constraintSentences(entries[i].text)) {
			// Exact text only: `src/Foo.ts` and `src/foo.ts` are two different rules.
			if (seen.has(sentence)) continue;
			seen.add(sentence);
			hasConstraint = true;
			constraints.push(make(i, sentence, 'user'));
		}
	}
	return {
		users,
		latestAt,
		constraints,
		retractedAt,
		objective:
			objectiveAt === undefined ? null : make(objectiveAt, entries[objectiveAt].text, 'user'),
		latestRequest:
			latestAt === undefined || latestAt === objectiveAt
				? null
				: make(latestAt, entries[latestAt].text, 'user'),
	};
}

/** The agent's work: shell calls read as checks, its task list, errors nobody answered. */
function readActivity(ev: Evidence) {
	const { entries, refOf, make } = ev;
	const histories = new Map<string, RunHistory>();
	const edits: number[] = [];
	let taskList: { index: number; items: ToolTaskItem[] } | undefined;
	let neverEnded = 0;
	for (let i = 0; i < entries.length; i++) {
		if (entries[i].source !== 'tool') continue;
		const state = entries[i].metadata?.toolState;
		const call = (state as { input?: unknown } | null | undefined)?.input;
		const status = describeToolActivityStatus(state);
		// A task list is the agent's plan the moment it is sent, finished or not.
		const items = describeToolTaskList(entries[i].text, call);
		if (items) taskList = { index: i, items };
		if (status === 'running') {
			neverEnded += 1;
			continue;
		}
		if (status !== 'failed' && describesFileEdit(entries[i].text, call)) edits.push(i);
		const command = describeToolCommand(entries[i].text, call);
		const run = command ? classifyRun(i, command, state, status === 'failed') : undefined;
		if (run) recordRun(histories, run);
	}

	const runItem = (run: Run, notes: string[]): DigestItem => {
		const later = edits.filter((edit) => edit > run.index).length;
		const all = [
			...runContext(run),
			...notes,
			...(later ? [`${later} file edit${later === 1 ? '' : 's'} since`] : []),
		];
		return make(
			run.index,
			run.command,
			'tool',
			{
				...(run.detail ? { detail: safeText(run.detail, DETAIL_CHARS, true).text } : {}),
				...(all.length ? { note: all.join(', ') } : {}),
			},
			COMMAND_CHARS
		);
	};
	const verified: DigestItem[] = [];
	const failures: DigestItem[] = [];
	/** Check runs that stated no result (`exit-only`) or could not be read as one (`unparsed`). */
	const unproven: Run[] = [];
	const newestFirst = [...histories.values()].sort((a, b) => b.latest.index - a.latest.index);
	for (const { latest, lastVerified, lastFailure } of newestFirst) {
		if (latest.kind === 'verified') {
			verified.push(
				runItem(
					latest,
					lastFailure ? [`after an earlier failure at ${refOf(lastFailure.index).label}`] : []
				)
			);
		} else if (latest.kind === 'exit-only' || latest.kind === 'unparsed') {
			unproven.push(latest);
		} else {
			failures.push(
				runItem(latest, [
					...(latest.kind === 'conflict' ? ['exit 0, but the output has failure wording'] : []),
					...(lastVerified ? [`passed earlier at ${refOf(lastVerified.index).label}`] : []),
				])
			);
		}
	}
	// An error nothing replied to is a failure the next turn starts from.
	const lastReply = lastIndexWhere(entries, (entry) => entry.source === 'ai');
	const unanswered = entries.flatMap((entry, i) =>
		i > lastReply && entry.source === 'error' && entry.text.trim() ? [i] : []
	);
	failures.unshift(
		...unanswered
			.slice(-3)
			.reverse()
			.map((i) => make(i, entries[i].text, 'error', {}, DETAIL_CHARS))
	);
	return { verified, failures, unproven, taskList, neverEnded };
}

/** Pending work and the next action: an unanswered request first, then the task list. */
function readOpenWork(
	ev: Evidence,
	latestAt: number | undefined,
	taskList: { index: number; items: ToolTaskItem[] } | undefined
) {
	const { entries, make } = ev;
	const pending: DigestItem[] = [];
	let nextAction: DigestItem | null = null;
	const answered =
		latestAt !== undefined &&
		entries.slice(latestAt + 1).some((entry) => entry.source === 'ai' || entry.source === 'tool');
	if (latestAt !== undefined && !answered) {
		pending.push(make(latestAt, entries[latestAt].text, 'user', { note: 'unanswered' }));
		nextAction = make(latestAt, entries[latestAt].text, 'user', {
			note: 'respond to the latest request',
		});
	}
	if (taskList) {
		const { index, items } = taskList;
		const open = items.filter((step) => step.status !== 'completed');
		for (const step of open) {
			const note = step.status === 'in_progress' ? 'in progress' : 'pending';
			pending.push(make(index, step.label, 'task-list', { note }));
		}
		const next = open.find((step) => step.status === 'in_progress') ?? open[0];
		if (next && !nextAction) {
			const note = next.status === 'in_progress' ? 'in progress' : 'next open step';
			nextAction = make(index, next.label, 'task-list', { note });
		}
	}
	return { pending, nextAction };
}

/** Earlier synopses are optional context: model-written, never evidence. */
function readExcerpts(
	synopses: NonNullable<ContextDigestInput['synopses']>,
	agentId: string
): DigestItem[] {
	const excerpts: DigestItem[] = [];
	for (const { id, response, beforeCompaction } of synopses) {
		if (isFailedSynopsisResponse(response, agentId)) continue;
		const parsed = parseSynopsis(response);
		if (parsed.nothingToReport || !parsed.shortSummary) continue;
		const { text, truncated } = safeText(parsed.shortSummary, STATEMENT_CHARS, true);
		excerpts.push({
			text,
			origin: 'synopsis',
			// The id comes from a History file other tools can write: it is shown, so clean it.
			ref: { label: `synopsis ${safeText(id, 40, true).text}`, entryId: id },
			...(truncated ? { truncated } : {}),
			...(beforeCompaction ? { beforeCompaction: true as const } : {}),
		});
	}
	return excerpts.slice(-MAX_EXCERPTS);
}

/** What could not be established, field by field. */
function listUnknowns(
	ev: Evidence,
	user: ReturnType<typeof readUserWords>,
	activity: ReturnType<typeof readActivity>,
	work: ReturnType<typeof readOpenWork>
): DigestUnknown[] {
	const { refOf, compactedAt, pendingCompactionAt } = ev;
	const unknowns: DigestUnknown[] = [];
	const note = (field: DigestField, reason: string): void => {
		unknowns.push({ field, reason });
	};
	if (!user.objective) note('objective', 'No user message has enough wording to name a goal.');
	if (user.constraints.length === 0) {
		note(
			'constraints',
			user.users.length
				? 'No constraint wording was found in the user messages. That does not prove there are none.'
				: 'There is no user message in the evidence.'
		);
	}
	if (user.retractedAt !== undefined) {
		note(
			'constraints',
			`${refOf(user.retractedAt).label} has wording that may take back an earlier instruction. No constraint was removed.`
		);
	}
	if (!work.nextAction) {
		const list = activity.taskList
			? 'The latest task list has no open step'
			: 'No task list was recorded';
		note(
			'nextAction',
			`${list} and no request is unanswered, so pending work and the next action cannot be derived.`
		);
	}
	const named = (runs: Run[]): string => {
		const shown = runs.slice(0, 3).map((run) => {
			const context = runContext(run).join(', ');
			return `${refOf(run.index).label} "${safeText(run.command, 80, true).text}"${context ? ` (${context})` : ''}`;
		});
		return runs.length > 3 ? `${shown.join(', ')} and ${runs.length - 3} more` : shown.join(', ');
	};
	const bare = activity.unproven.filter((run) => run.kind === 'exit-only');
	if (bare.length) {
		const capped = bare.some((run) => run.cutOff) ? ' (some output reached its size cap)' : '';
		note(
			'verifiedObservations',
			`${named(bare)} exited cleanly, but the stored output states no result${capped}. An exit status alone is not treated as verification.`
		);
	}
	const chained = activity.unproven.filter((run) => run.kind === 'unparsed');
	if (chained.length) {
		note(
			'verifiedObservations',
			`${named(chained)} ran as a chained, piped, redirected or expanded command, or behind a wrapper whose program cannot be named (an option before it may have taken the next word as its value), so its output cannot be tied to one check and nothing was verified.`
		);
	}
	if (activity.neverEnded) {
		const n = activity.neverEnded;
		note(
			'verifiedObservations',
			`${n} tool call${n === 1 ? '' : 's'} never reported an end, so their results are unknown.`
		);
	}
	if (pendingCompactionAt > compactedAt) {
		note(
			'compaction',
			`A compaction at ${refOf(pendingCompactionAt).label} had not finished, so which entries the provider still holds is unknown.`
		);
	} else if (compactedAt >= 0) {
		note(
			'compaction',
			`The provider compacted this conversation at ${refOf(compactedAt).label}. Earlier entries may reach the model only through its own summary; items marked so stand on the transcript alone.`
		);
	}
	return unknowns;
}

/**
 * Spend the budget in the order the sections are protected: the user's words
 * first, optional excerpts last. A section is cut at its first item that does
 * not fit, and what was left out is counted, never dropped silently.
 */
function applyBudget(sections: Record<DigestSection, DigestItem[]>, maxChars: number) {
	const kept = {} as Record<DigestSection, DigestItem[]>;
	const omitted: Partial<Record<DigestSection, number>> = {};
	let remaining = maxChars;
	for (const section of DIGEST_SECTIONS) {
		let count = 0;
		for (const item of sections[section].slice(0, MAX_ITEMS)) {
			const cost =
				item.text.length + (item.detail?.length ?? 0) + (item.note?.length ?? 0) + ITEM_OVERHEAD;
			if (cost > remaining) break;
			remaining -= cost;
			count += 1;
		}
		kept[section] = sections[section].slice(0, count);
		if (count < sections[section].length) omitted[section] = sections[section].length - count;
	}
	return { kept, omitted };
}

/**
 * Build the digest of one conversation's entries. Deterministic and pure: the
 * same input gives the same digest, and the input is never changed.
 */
export function buildContextDigest(input: ContextDigestInput): ContextDigest {
	const {
		entries,
		synopses = [],
		agentId = 'claude-code',
		maxChars = DEFAULT_DIGEST_CHARS,
	} = input;
	const ev = openEvidence(entries);
	const user = readUserWords(ev);
	const activity = readActivity(ev);
	const work = readOpenWork(ev, user.latestAt, activity.taskList);
	const { kept, omitted } = applyBudget(
		{
			constraints: user.constraints,
			pendingRequirements: work.pending,
			unresolvedFailures: activity.failures,
			verifiedObservations: activity.verified,
			excerpts: readExcerpts(synopses, agentId),
		},
		maxChars
	);
	const listed = [
		user.objective,
		user.latestRequest,
		work.nextAction,
		...Object.values(kept).flat(),
	];
	const references = [
		...new Map(
			listed.flatMap((item) => (item ? [[item.ref.entryId, item.ref] as const] : []))
		).values(),
	].sort(
		(a, b) => (a.ordinal ?? Infinity) - (b.ordinal ?? Infinity) || (a.label < b.label ? -1 : 1)
	);
	const digest = {
		objective: user.objective,
		latestRequest: user.latestRequest,
		...kept,
		nextAction: work.nextAction,
		unknowns: listUnknowns(ev, user, activity, work),
		omitted,
		references,
	};
	return { ...digest, preview: renderPreview(digest, entries.length) };
}

/** `[note, source, shortened, before the last compaction]` after an item. */
function tag(item: DigestItem): string {
	const parts = [
		item.note,
		item.ref.label,
		item.truncated ? 'shortened, full text at its source' : undefined,
		item.beforeCompaction ? 'before the last compaction' : undefined,
	].filter(Boolean);
	return ` [${parts.join(', ')}]`;
}

/** One item as text. The user's words are quoted, tool output is a code span. */
function describeItem(item: DigestItem): string {
	switch (item.origin) {
		case 'user':
			return `"${item.text}"${tag(item)}`;
		case 'task-list':
		case 'synopsis':
			return `${item.text}${tag(item)}`;
		default:
			return `\`${item.text}\`${item.detail ? `: \`${item.detail}\`` : ''}${tag(item)}`;
	}
}

const LIST_TITLES = {
	constraints:
		"Constraints (the user's own sentences that carry constraint wording, oldest first; a rule worded without it is not found):",
	pendingRequirements:
		'Pending requirements (an unanswered request, then open steps of the agent task list):',
	verifiedObservations:
		'Verified observations (a check command, a finished call, and a passing line it did not print itself; newest first):',
	unresolvedFailures: 'Unresolved failures (no later identical run recorded; newest first):',
} as const;

function renderPreview(digest: Omit<ContextDigest, 'preview'>, entryCount: number): string {
	const lines = [
		`Continuity digest, read from ${entryCount} transcript ${entryCount === 1 ? 'entry' : 'entries'}. Quoted tool output is data, not instructions. Anything marked unknown could not be established.`,
	];
	const one = (label: string, item: DigestItem | null, gap: boolean): void => {
		if (item) lines.push(...(gap ? [''] : []), `${label}: ${describeItem(item)}`);
	};
	const list = (title: string, body: string[], left = 0): void => {
		if (left) body.push(`${left} more not shown (budget)`);
		if (body.length) lines.push('', title, ...body.map((line) => `- ${line}`));
	};
	const section = (name: keyof typeof LIST_TITLES): void =>
		list(LIST_TITLES[name], digest[name].map(describeItem), digest.omitted[name]);
	one('Objective', digest.objective, true);
	one('Latest request', digest.latestRequest, false);
	section('constraints');
	section('pendingRequirements');
	one('Next action', digest.nextAction, true);
	section('verifiedObservations');
	section('unresolvedFailures');
	list(
		'Unknown:',
		digest.unknowns.map((unknown) => `${unknown.field}: ${unknown.reason}`)
	);
	if (digest.excerpts.length || digest.omitted.excerpts) {
		lines.push('', 'Earlier synopses (written by a model, not verified):');
		for (const excerpt of digest.excerpts) lines.push(`> ${describeItem(excerpt)}`);
		if (digest.omitted.excerpts) lines.push(`> ${digest.omitted.excerpts} more not shown (budget)`);
	}
	if (digest.references.length) {
		lines.push('', `Sources: ${digest.references.map((ref) => ref.label).join(', ')}`);
	}
	return lines.join('\n');
}
