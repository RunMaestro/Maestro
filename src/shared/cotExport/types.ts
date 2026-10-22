/**
 * Chain of thought export: the record format.
 *
 * WHAT THIS IS
 * A person can turn on, for one agent, a log of every turn that agent takes:
 * the prompt, the reasoning, each tool call and its result, the replies, the
 * token usage, and how the turn ended. Maestro writes the log from the agent's
 * output stream into a folder that person picked for that agent. The agent
 * does not write it. That is the point: it is an audit record, and it can be
 * trusted because it did not come from the thing it records.
 *
 * THIS FEATURE IS HIDDEN FROM AGENTS ON PURPOSE
 * An agent that knows it is being recorded can change how it behaves, and then
 * the record no longer shows what the agent would have done unobserved. So
 * nothing an agent can reach while it runs may reveal that this exists. If you
 * are editing this feature, do NOT:
 *   - document it: no user docs, no agent guides, no CLAUDE*.md, no release
 *     notes, no tips, no tour step, no settings search entry
 *   - put it in a prompt, or in anything on the spawn path (arguments,
 *     environment, working directory, prompt, system prompt). A turn must
 *     spawn byte for byte the same with export on or off.
 *   - expose it through the CLI: no verb, and no field in any listing
 *   - expose it through the web server, or send it to the renderer with an
 *     event that also fans out to web clients
 *   - store any of it anywhere but its own encrypted store: not on the agent
 *     (`Session`) object, not in the agent configs, not in settings
 *   - give it a hotkey, a command palette entry, a menu item, or a UI surface
 *     entry. Its only control is the Audit Log tab of the Edit Agent dialog,
 *     a tab the CLI's `--tab` list must never name.
 * These rules override the project's usual "every UI action has a CLI path"
 * and "three ways in" rules. This feature is the deliberate exception to both.
 *
 * WHAT IT PROTECTS AND WHAT IT DOES NOT
 * Source code is not a secret, so name things plainly here. The goal is
 * narrower: a running agent gets no signal, and a log that was changed after
 * the fact can be detected, because every record carries the hash of the one
 * before it (see `CotRecordBase`). Maestro and its agents run as the same OS
 * user, so an agent that goes looking can find whatever Maestro can read. This
 * is not OS-level secrecy, and no comment may claim that it is.
 *
 * CHANGING THE FORMAT
 * A log file is never rewritten and never deleted by Maestro, so every shape
 * this file has ever described stays on someone's disk. Adding an optional
 * field is safe. Anything that would make a reader of the current version
 * misread a record (a renamed field, a changed meaning, a field made required)
 * needs a new `COT_EXPORT_FORMAT_VERSION`, and readers must keep handling the
 * old one.
 *
 * THIS FILE
 * Types and constants only: no logic, and no imports beyond the two shared
 * types below, so the main process and the renderer read one contract.
 */

import type { ToolType, UsageStats } from '../types';

// ============================================================================
// Constants
// ============================================================================

/** Version stamped on every record as `v`. See "Changing the format" above. */
export const COT_EXPORT_FORMAT_VERSION = 1;

/**
 * `prevHash` of the first record in a chain: 64 zeros, the width of a SHA-256
 * hex digest. It stands for "no record came before this one".
 */
export const COT_GENESIS_HASH = '0'.repeat(64);

/**
 * `chainSeq` of a chain that holds no records yet. The first record takes the
 * next position, 0. Together with `COT_GENESIS_HASH` it is the starting
 * `CotChainState` of every new chain, so the writer, the store, and the
 * verifier agree on where a chain begins.
 */
export const COT_GENESIS_CHAIN_SEQ = -1;

/**
 * Largest tool output kept in one `tool-result` record, in bytes of UTF-8.
 * Output past the cap is cut, and `truncatedBytes` says how much was cut.
 * `outputSha256` always hashes the FULL output, before any cut, so a truncated
 * record still proves what the output was: anyone holding a copy can check it
 * against the hash.
 */
export const COT_TOOL_OUTPUT_CAP_BYTES = 256 * 1024;

// ============================================================================
// Record model
// ============================================================================

/**
 * What started the turn.
 *
 * - `interactive`: a message sent to one of the agent's AI tabs
 * - `auto-run`: an Auto Run task
 * - `group-chat`: the agent answering as a Group Chat participant
 * - `cue`: a Cue subscription firing
 * - `consult`: the agent answering another agent's question (an @mention, or
 *   an ask from that agent's shell). `consultedBy` names the agent that asked.
 * - `cli`: a turn the command line ran outside the app. Maestro did not see
 *   that turn. The record is built from the run ledger the command line
 *   writes, so it holds the prompt and how the run ended and never the
 *   output, and a `capture-gap` right after `turn-start` says so. Read it as
 *   a report, not as an observation: the ledger is a file the command line
 *   wrote.
 */
export type CotTurnOrigin = 'interactive' | 'auto-run' | 'group-chat' | 'cue' | 'consult' | 'cli';

/** Discriminant of a record. Each kind has its own payload shape below. */
export type CotRecordKind =
	| 'turn-start'
	| 'thinking'
	| 'redacted-thinking'
	| 'text'
	| 'tool-call'
	| 'tool-result'
	| 'usage'
	| 'turn-end'
	| 'capture-gap';

/**
 * Fields on every record, whatever its kind.
 *
 * Every hash in this format is SHA-256 written as 64 lowercase hex characters.
 */
export interface CotRecordBase {
	/** Format version the record was written in. */
	v: typeof COT_EXPORT_FORMAT_VERSION;
	kind: CotRecordKind;
	/** Maestro's id for the agent the record belongs to. */
	agentId: string;
	/**
	 * Id Maestro gives the turn. Every record of one turn carries it, and one
	 * turn is one file. A `capture-gap` carries the id of the turn whose file
	 * it was written into.
	 */
	turnId: string;
	/**
	 * Position within the turn, from 0. Unique within a turn: a `capture-gap`
	 * written into a turn's file takes a position like any other record.
	 */
	seq: number;
	/**
	 * Position in the agent's chain: 0 for the first record, then one more for
	 * each record after it, across turns and files, with no holes. A hole or a
	 * repeat means a record was removed or inserted after the fact.
	 */
	chainSeq: number;
	/**
	 * When Maestro recorded the event, as ISO 8601 in UTC. This is Maestro's
	 * clock, not a time reported by the provider.
	 */
	ts: string;
	/**
	 * `hash` of the record before this one in the chain, or `COT_GENESIS_HASH`
	 * for the first.
	 */
	prevHash: string;
	/**
	 * Hash of `prevHash`, a newline, and the canonical JSON of this record
	 * without its `hash` field. It covers every other field, `prevHash`
	 * included, which is what links the chain.
	 */
	hash: string;
}

/** Opens a turn. Holds what was asked and where the turn ran. */
export interface CotTurnStartPayload {
	kind: 'turn-start';
	/** The provider that ran the turn. */
	toolType: ToolType;
	origin: CotTurnOrigin;
	/** The AI tab the turn ran in, when it ran in one. */
	tabId?: string;
	/**
	 * Maestro's id for the agent whose question this turn answers. Present
	 * only when `origin` is `consult`.
	 */
	consultedBy?: string;
	/**
	 * The id of the run in the command line's run ledger that this turn was
	 * built from. Present only when `origin` is `cli`. The turn's `turnId` is
	 * derived from it, so one run always gives the same turn file.
	 */
	cliRunId?: string;
	/**
	 * The provider conversation the turn continues, when one was known at
	 * spawn. A turn that opens a new provider conversation has none yet.
	 */
	providerSessionId?: string;
	/**
	 * Working directory of the agent process. For a turn on an SSH remote this
	 * is a path on that host.
	 */
	cwd: string;
	/** The SSH remote the turn ran on. Absent for a local turn. */
	sshRemoteId?: string;
	/**
	 * Who asked for the turn, as the spawn site claimed it (the same value the
	 * process gets in `MAESTRO_QUERY_SOURCE`). A plain string, not the live
	 * union: an old record keeps whatever was written even if the vocabulary
	 * changes later.
	 */
	querySource?: string;
	/**
	 * The prompt the turn was started with. For a provider that takes its
	 * system prompt inside the first user message, that system prompt is
	 * removed here and only its hash is kept.
	 */
	prompt: string;
	/**
	 * Hash of the system prompt that was removed from `prompt`. Present only
	 * when one was removed.
	 */
	systemPromptSha256?: string;
	/** How many images came with the prompt. The images are not recorded. */
	imageCount: number;
}

/**
 * Reasoning text, as far as the provider shows it. Some providers show a
 * summary and some show nothing, so no `thinking` record does not mean no
 * reasoning took place.
 *
 * A long block is written in pieces. Records of this kind that share
 * `providerMessageId` and `blockIndex` are pieces of one block: join their
 * `text` in `seq` order. The pieces need not lie next to each other.
 */
export interface CotThinkingPayload {
	kind: 'thinking';
	text: string;
	/** The provider's id for the message the block came from. */
	providerMessageId?: string;
	/**
	 * Which block this is. With a `providerMessageId` it is the block's place
	 * in that message, from 0. Without one, Maestro numbers the turn's
	 * reasoning and reply blocks itself, from 0. Either way the pair names one
	 * block within its turn.
	 */
	blockIndex?: number;
	/**
	 * Set when a subagent produced the block: the `toolCallId` of the tool call
	 * that started that subagent. Absent for the agent's own blocks.
	 */
	parentToolCallId?: string;
}

/**
 * Reasoning the provider returned encrypted. Maestro cannot read it and never
 * stores the ciphertext. The record proves that the block existed, and what it
 * was, without keeping it.
 */
export interface CotRedactedThinkingPayload {
	kind: 'redacted-thinking';
	/** Size of the opaque payload in bytes, exactly as the provider sent it. */
	byteLength: number;
	/** Hash of that same payload. */
	sha256: string;
	providerMessageId?: string;
	/** As on `thinking`: the tool call that started the subagent, if any. */
	parentToolCallId?: string;
}

/**
 * Reply text from the agent. Long blocks are written in pieces, joined the
 * same way as `thinking`.
 */
export interface CotTextPayload {
	kind: 'text';
	text: string;
	providerMessageId?: string;
	/** As on `thinking`. */
	blockIndex?: number;
	/** As on `thinking`: the tool call that started the subagent, if any. */
	parentToolCallId?: string;
}

/** The agent asked to run a tool. */
export interface CotToolCallPayload {
	kind: 'tool-call';
	/** Pairs the call with its `tool-result`, when the provider gives an id. */
	toolCallId?: string;
	/** The tool's name. Empty when the provider gave none. */
	toolName: string;
	/**
	 * The arguments as the provider sent them. Any JSON value, and `null` when
	 * the provider sent none, so the field is always present on disk.
	 */
	input: unknown;
	/** As on `thinking`: the tool call that started the subagent, if any. */
	parentToolCallId?: string;
}

/** What a tool call came back with. */
export interface CotToolResultPayload {
	kind: 'tool-result';
	toolCallId?: string;
	status: 'completed' | 'failed';
	/**
	 * The output as text, cut at `COT_TOOL_OUTPUT_CAP_BYTES`. Output the
	 * provider sent as text is kept as it came. Output it sent as structured
	 * data is written as canonical JSON (keys sorted, no spaces).
	 */
	output: string;
	/** Hash of the FULL output text, as UTF-8, before any cut. */
	outputSha256: string;
	/** Bytes cut from `output`. Absent when the output fit under the cap. */
	truncatedBytes?: number;
	/** As on `thinking`: the tool call that started the subagent, if any. */
	parentToolCallId?: string;
}

/** Token and cost figures the provider reported for the turn. */
export interface CotUsagePayload {
	kind: 'usage';
	usage: UsageStats;
}

/**
 * Closes a turn. A turn file with no `turn-end` is a turn that did not finish
 * in front of Maestro: the app quit, or the record was removed.
 */
export interface CotTurnEndPayload {
	kind: 'turn-end';
	/**
	 * Exit code of the agent process. `null` when Maestro saw none: the process
	 * could not be started, or it was replaced before its exit was reported.
	 */
	exitCode: number | null;
	/**
	 * How Maestro judged the end of the turn, when it did: `completed`,
	 * `completed-with-warning`, `interrupted` (someone stopped it), or
	 * `crashed`. Read it together with `exitCode`: a turn that was stopped is
	 * reported with exit code 0. A plain string, not the live union, for the
	 * same reason as `querySource`.
	 */
	outcome?: string;
	/** Milliseconds from the start of the turn to its end. */
	durationMs: number;
	/**
	 * Records Maestro produced for the turn, counting `turn-start` and this
	 * record, and not counting any `capture-gap`. If the file holds fewer and
	 * no `capture-gap` accounts for the difference, records were removed.
	 */
	recordCount: number;
}

/**
 * Maestro's own statement that the log is incomplete at this point. It is a
 * sealed record like any other, so a gap is part of the chain and does not
 * break it. A chain break with no `capture-gap` is the one that needs
 * explaining.
 *
 * It can appear anywhere in a file, including before `turn-start` and after
 * `turn-end`, so a reader must not assume that `seq` 0 is the `turn-start`.
 */
export interface CotCaptureGapPayload {
	kind: 'capture-gap';
	/**
	 * Why records are missing. Known values: `write-failed:<error code>` (for
	 * example `write-failed:ENOSPC`), `head-mismatch-on-start` (the newest record
	 * on disk was not the one Maestro last sealed), `head-unchecked-on-start`
	 * (that could not be checked, because the folder could not be read),
	 * `unrecognized-block:<block type>` (the provider sent a kind of content
	 * this version of Maestro cannot record), `output-not-captured:no-parser`
	 * (the provider has no output parser, so its stream could not be read),
	 * `output-not-captured:outside-app` (the turn ran outside the app, so
	 * Maestro never had its output), `unparsed-lines:<count>` (a Cue run whose
	 * parser threw on that many lines), and
	 * `prompt-not-captured` or `prompt-not-captured:ssh-remote` (written right
	 * after a `turn-start` whose `prompt` is empty because the prompt did not
	 * reach Maestro's recorder, as on an SSH remote, where it travels inside
	 * the SSH command). Left open so a new cause does not need a format change.
	 */
	reason: string;
	/** How many records were lost, when Maestro knows the count. */
	droppedRecords?: number;
}

/**
 * The per-kind half of a record: `kind` plus the fields that kind carries. It
 * is what a producer builds before any position or hash is known.
 */
export type CotRecordPayload =
	| CotTurnStartPayload
	| CotThinkingPayload
	| CotRedactedThinkingPayload
	| CotTextPayload
	| CotToolCallPayload
	| CotToolResultPayload
	| CotUsagePayload
	| CotTurnEndPayload
	| CotCaptureGapPayload;

/**
 * A record with everything but its two hash fields: the input to sealing.
 *
 * Build record shapes this way, as base fields intersected with the payload
 * union. `Omit` on `CotRecord` does not distribute over the union, so it
 * returns only the fields all kinds share and drops every payload field.
 */
export type CotUnsealedRecord = Omit<CotRecordBase, 'prevHash' | 'hash'> & CotRecordPayload;

/** One complete record: one line of a turn file. Narrow it by `kind`. */
export type CotRecord = CotRecordBase & CotRecordPayload;

// ============================================================================
// Per-agent state
// ============================================================================

/**
 * What the person chose for one agent. A change applies from the agent's next
 * turn and never to a turn that is already running.
 */
export interface CotAgentConfig {
	enabled: boolean;
	/** Absolute path of the agent's log folder. `null` until one is chosen. */
	folder: string | null;
	/** When this config last changed, in epoch milliseconds. */
	updatedAt: number;
}

/**
 * Where an agent's chain stands: the newest record Maestro sealed into it.
 * Maestro keeps this outside the log folder, which is what makes removing the
 * newest records detectable. A file cannot vouch for records that were deleted
 * after it.
 *
 * A chain with no records yet is `head: COT_GENESIS_HASH` and
 * `chainSeq: COT_GENESIS_CHAIN_SEQ`.
 */
export interface CotChainState {
	/** The folder this chain was written into. One chain per folder. */
	folder: string;
	/** `hash` of the newest record. */
	head: string;
	/** `chainSeq` of that same record. The next record takes this plus one. */
	chainSeq: number;
}

/**
 * A chain that stopped growing because the person picked another folder. It is
 * kept so the old folder can still be verified.
 */
export interface CotPastChain extends CotChainState {
	/** When the chain was closed, in epoch milliseconds. */
	closedAt: number;
}

/** A failure Maestro wants the person to see. */
export interface CotLastError {
	message: string;
	/** When it happened, in epoch milliseconds. */
	at: number;
}

/** What the Edit Agent dialog shows about one agent's export. */
export interface CotAgentStatus {
	enabled: boolean;
	folder: string | null;
	/** When a record was last written, in epoch milliseconds. */
	lastWriteAt?: number;
	/** Turns filed under today's date, on the local clock. */
	turnsToday: number;
	/**
	 * True when the OS offers no encryption for the store that holds this
	 * state, so it sits on disk as plain text. The person is told.
	 */
	unencrypted: boolean;
	lastError?: CotLastError;
}

// ============================================================================
// Results
// ============================================================================

/** The outcome of walking one chain's folder and checking every link. */
export interface CotVerifyResult {
	/**
	 * The whole verdict: true only when no break was found AND `headMatches`.
	 * A caller that reads nothing but `ok` is never told that a log with its
	 * newest records removed is intact.
	 */
	ok: boolean;
	filesChecked: number;
	recordsChecked: number;
	/**
	 * Whether the newest record on disk is the one Maestro last sealed. False
	 * means the tail of the log was removed, which no record left in the
	 * folder can show.
	 */
	headMatches: boolean;
	/**
	 * The earliest problem in chain order. Later ones are not reported: past
	 * the first break nothing downstream can be trusted anyway.
	 */
	firstBreak?: {
		/** The file the break was found in. */
		file: string;
		/** The chain position the break was found at. */
		chainSeq: number;
		/** One sentence a person can act on. */
		reason: string;
	};
}

/**
 * One chain's verdict, with the folder the chain lies in. An agent has one
 * chain per folder it has used, so a verify of the agent gives one of these
 * per folder, the current folder first.
 */
export interface CotChainVerifyResult extends CotVerifyResult {
	folder: string;
	/**
	 * Set when the chain could not be checked at all, with the reason in one
	 * sentence. `ok` is then false and nothing was counted. It is not a verdict
	 * on the log: nothing was read.
	 */
	error?: string;
}

/**
 * Whether a folder may hold an agent's log. `resolved` is the real path, with
 * symlinks followed, and is the path to store. `reason` is one sentence for
 * the person who picked the folder.
 */
export type CotFolderValidation = { ok: true; resolved: string } | { ok: false; reason: string };

/**
 * The answer to a change of what the person chose. `status` is the agent's
 * status after the change. On a refusal nothing was changed, and `reason` is
 * one sentence for the person who asked.
 */
export type CotSetResult = { ok: true; status: CotAgentStatus } | { ok: false; reason: string };
