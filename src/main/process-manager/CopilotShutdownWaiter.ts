// src/main/process-manager/CopilotShutdownWaiter.ts

import fs from 'fs/promises';
import type { SshRemoteConfig } from '../../shared/types';
import {
	copilotRemoteEventsPath,
	readCopilotEventsContent,
	resolveCopilotEventsPath,
} from '../utils/copilot-events';
import { readFileTailRemote } from '../utils/remote-fs';

// Re-exported for callers/tests that resolve the local on-disk path directly.
export { resolveCopilotEventsPath };

// Bytes of "type":"session.shutdown". Match with or without a space after the
// colon since JSON serializers differ on whitespace.
const SHUTDOWN_PATTERNS = ['"type":"session.shutdown"', '"type": "session.shutdown"'];

// Markers that begin a fresh turn within Copilot's append-only events.jsonl.
// A resumed session writes exactly one of these at the start of every spawn:
// `session.start` for the first turn, `session.resume` for each subsequent
// turn. Everything after the LAST such marker belongs to the current turn.
const SEGMENT_BOUNDARY_PATTERNS = [
	'"type":"session.resume"',
	'"type": "session.resume"',
	'"type":"session.start"',
	'"type": "session.start"',
];

/**
 * Find the offset just past the LAST turn-boundary line in `content`, or 0 when
 * none is present.
 *
 * Copilot appends every turn of a resumed session to a single `events.jsonl`,
 * so the file accumulates `session.shutdown` markers, final answers, and usage
 * snapshots from PRIOR turns. Scanning the whole file would match a stale
 * shutdown from an earlier turn (defeating the wait entirely) or surface an
 * earlier turn's answer. Scoping every read to the current turn's segment - the
 * bytes after the last `session.resume`/`session.start` - keeps the logic
 * looking only at what the in-flight turn has produced.
 *
 * Returns 0 (whole content) when no boundary is found, e.g. a brand-new
 * first-turn file whose `session.start` hasn't landed yet, or an incremental
 * remote tail that doesn't include the boundary line (it lives before the tail's
 * starting offset, so the entire tail is already inside the current segment).
 */
function currentSegmentOffset(content: string): number {
	let marker = -1;
	for (const pattern of SEGMENT_BOUNDARY_PATTERNS) {
		const idx = content.lastIndexOf(pattern);
		if (idx > marker) marker = idx;
	}
	if (marker < 0) return 0;
	const lineEnd = content.indexOf('\n', marker);
	return lineEnd < 0 ? content.length : lineEnd + 1;
}

/** Slice `content` down to the current turn's segment. See `currentSegmentOffset`. */
function sliceToCurrentSegment(content: string): string {
	return content.slice(currentSegmentOffset(content));
}

/** True when a `session.shutdown` marker exists in `content`'s current turn segment. */
function contentContainsShutdownInCurrentSegment(content: string): boolean {
	return contentContainsShutdown(sliceToCurrentSegment(content));
}

const DEFAULT_POLL_INTERVAL_MS = 500;
// Remote polling has no SSH connection multiplexing, so every poll is a fresh
// ssh handshake. We adapt the cadence to the remote file's activity: poll
// quickly right after new output lands (Copilot is actively writing), then back
// off geometrically toward an idle ceiling when the file goes quiet, so a long
// idle gap doesn't spawn an ssh process every second for no reason.
const DEFAULT_SSH_POLL_ACTIVE_MS = 1000;
const DEFAULT_SSH_POLL_IDLE_MAX_MS = 4000;
const SSH_POLL_BACKOFF_FACTOR = 1.5;
// If events.jsonl hasn't been touched for this long, assume Copilot is truly
// done (or crashed) and stop waiting. Subagent work typically writes within
// seconds, so 30s of total silence is a generous "nothing is happening" floor.
const DEFAULT_INACTIVITY_MS = 30_000;
// Hard cap so a hung session can't pin the renderer in `busy` forever.
const DEFAULT_MAX_WAIT_MS = 10 * 60 * 1000;

export type CopilotShutdownWaitResult = 'observed' | 'inactive' | 'timeout' | 'missing';

export interface CopilotShutdownWaitOptions {
	maxWaitMs?: number;
	inactivityMs?: number;
	pollIntervalMs?: number;
	/** Override for testing - defaults to `~/.copilot` (or $COPILOT_CONFIG_DIR). */
	configDir?: string;
	/** When set, read the events file from this remote host over SSH instead of locally. */
	sshRemote?: SshRemoteConfig | null;
}

export interface CopilotFinalAnswer {
	content: string;
}

/**
 * Token usage snapshot extracted from a Copilot CLI `session.shutdown` event.
 *
 * Field semantics:
 *  - `inputTokens` carries Copilot's `currentTokens` (live context-window
 *    occupancy: system + tools + conversation), not the per-API-call input.
 *    Treating it as the cumulative input under the combined-context formula
 *    yields a gauge that tracks "how full is the window right now".
 *  - `outputTokens`, `cacheReadInputTokens`, `cacheCreationInputTokens`, and
 *    `reasoningTokens` come straight from `modelMetrics.<currentModel>.usage`
 *    and are cumulative across the session. They drive the tooltip lines.
 *
 * Returning a single combined snapshot (rather than streaming per-turn deltas)
 * matches the cadence Copilot itself uses: it writes one shutdown per batch
 * spawn, after the model has finished.
 */
export interface CopilotShutdownUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	reasoningTokens: number;
}

/**
 * Block until Copilot CLI has written its `session.shutdown` event to the
 * `events.jsonl`. Copilot CLI in batch mode does NOT emit `session.shutdown`
 * to stdout - it only writes it to disk, and it can continue writing AFTER
 * the parent process we spawned has already exited (subagent delegation runs
 * work in additional processes that share the same session-state directory).
 * Without this wait, Maestro flips the tab to `idle` while Copilot is still
 * working.
 *
 * When `options.sshRemote` is set the events file lives on the remote host,
 * so each poll reads it over SSH. To keep that cheap the remote path reads
 * only the new tail since the last poll (`tail -c +N`) rather than the whole
 * file, and adapts its poll interval to the file's activity. See
 * `waitForCopilotShutdownRemote`.
 *
 * Return values:
 *  - `observed`  - shutdown marker found; Copilot is truly done
 *  - `inactive`  - file went idle for `inactivityMs` without a shutdown marker
 *                  (likely a crash; safe to stop waiting)
 *  - `timeout`   - `maxWaitMs` elapsed; hard cap to avoid stuck `busy` state
 *  - `missing`   - file never appeared (e.g. Copilot crashed before
 *                  `session.start` could be persisted)
 */
export async function waitForCopilotShutdown(
	agentSessionId: string,
	options: CopilotShutdownWaitOptions = {}
): Promise<CopilotShutdownWaitResult> {
	const maxWait = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
	const inactivityThreshold = options.inactivityMs ?? DEFAULT_INACTIVITY_MS;

	if (options.sshRemote) {
		return waitForCopilotShutdownRemote(
			agentSessionId,
			options.sshRemote,
			maxWait,
			inactivityThreshold,
			options.pollIntervalMs
		);
	}

	return waitForCopilotShutdownLocal(
		agentSessionId,
		options.configDir,
		maxWait,
		inactivityThreshold,
		options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
	);
}

/**
 * Local polling: cheap on local disk, so it stats for an mtime and re-reads
 * the whole file each poll. Activity is keyed off the mtime changing.
 */
async function waitForCopilotShutdownLocal(
	agentSessionId: string,
	configDir: string | undefined,
	maxWait: number,
	inactivityThreshold: number,
	pollInterval: number
): Promise<CopilotShutdownWaitResult> {
	const filePath = resolveCopilotEventsPath(agentSessionId, configDir);

	const start = Date.now();
	let lastMtimeMs: number | null = null;
	let lastActivityAt = start;
	let everSawFile = false;

	while (Date.now() - start < maxWait) {
		let mtimeMs: number | null = null;
		let content: string | null = null;

		try {
			const stat = await fs.stat(filePath);
			mtimeMs = stat.mtimeMs;
			everSawFile = true;
			content = await fs.readFile(filePath, 'utf8');
		} catch {
			// File doesn't exist yet or transiently unreadable - fall through.
		}

		// Only the CURRENT turn's shutdown counts. A resumed session's
		// events.jsonl carries stale shutdown markers from every prior turn;
		// matching one of those would flip the tab to idle the instant this turn
		// starts, while subagents are still working.
		if (content && contentContainsShutdownInCurrentSegment(content)) {
			return 'observed';
		}

		if (mtimeMs !== null) {
			if (lastMtimeMs === null || mtimeMs !== lastMtimeMs) {
				lastMtimeMs = mtimeMs;
				lastActivityAt = Date.now();
			} else if (Date.now() - lastActivityAt > inactivityThreshold) {
				return 'inactive';
			}
		} else if (!everSawFile && Date.now() - start > inactivityThreshold) {
			return 'missing';
		}

		await sleep(pollInterval);
	}

	return 'timeout';
}

/**
 * Remote polling. Two optimizations over the local loop, both aimed at the
 * fact that every poll is a fresh ssh handshake (no connection multiplexing):
 *
 *  1. Incremental tail reads. We track how many bytes we've already consumed
 *     and `tail -c +N` only the new bytes each poll, so a long session over
 *     many minutes transfers the file roughly once total, not once per poll.
 *     The byte offset only advances to the last complete newline, so a poll
 *     that catches Copilot mid-write never splits a line or a multibyte char.
 *
 *  2. Adaptive interval. Poll quickly while new output is landing, then back
 *     off geometrically toward an idle ceiling when the file goes quiet, so
 *     idle gaps don't burn an ssh process every second.
 *
 * When `pollIntervalMs` is provided (tests) it pins a fixed interval and
 * disables the adaptive backoff for determinism.
 */
async function waitForCopilotShutdownRemote(
	agentSessionId: string,
	sshRemote: SshRemoteConfig,
	maxWait: number,
	inactivityThreshold: number,
	fixedPollIntervalMs?: number
): Promise<CopilotShutdownWaitResult> {
	const remotePath = copilotRemoteEventsPath(agentSessionId);
	const adaptive = fixedPollIntervalMs === undefined;

	const start = Date.now();
	let offset = 0;
	let lastActivityAt = start;
	let everSawFile = false;
	let interval = fixedPollIntervalMs ?? DEFAULT_SSH_POLL_ACTIVE_MS;

	while (Date.now() - start < maxWait) {
		const result = await readFileTailRemote(remotePath, sshRemote, offset);
		let sawActivity = false;

		if (result.success) {
			everSawFile = true;
			const tail = result.data ?? '';

			// Scan the current turn's segment of the returned tail (including any
			// not-yet-terminated final line) so an unterminated shutdown line is
			// still detected promptly. The first poll reads from offset 0 and sees
			// the whole accumulated file, so it must skip stale shutdown markers
			// that precede this turn's `session.resume`; later polls only fetch new
			// bytes past that boundary, so their whole tail is already in-segment.
			if (contentContainsShutdownInCurrentSegment(tail)) {
				return 'observed';
			}

			// Advance only through the last complete line; leave any partial
			// trailing line unconsumed so the next poll re-reads it intact.
			const lastNewline = tail.lastIndexOf('\n');
			if (lastNewline >= 0) {
				const consumed = tail.slice(0, lastNewline + 1);
				const consumedBytes = Buffer.byteLength(consumed, 'utf8');
				if (consumedBytes > 0) {
					offset += consumedBytes;
					lastActivityAt = Date.now();
					sawActivity = true;
				}
			}
		}
		// A failed read means the file isn't there yet or a transient SSH error;
		// treat it the same as the local "couldn't read this poll" path.

		if (sawActivity) {
			interval = fixedPollIntervalMs ?? DEFAULT_SSH_POLL_ACTIVE_MS;
		} else if (everSawFile) {
			if (Date.now() - lastActivityAt > inactivityThreshold) {
				return 'inactive';
			}
			if (adaptive) {
				interval = Math.min(interval * SSH_POLL_BACKOFF_FACTOR, DEFAULT_SSH_POLL_IDLE_MAX_MS);
			}
		} else if (Date.now() - start > inactivityThreshold) {
			return 'missing';
		}

		await sleep(interval);
	}

	return 'timeout';
}

/**
 * Scan `events.jsonl` for the authoritative final answer Copilot actually
 * produced. The latest of two signals wins, in file order:
 *
 *  1. The last qualifying `assistant.message` (non-empty `content`, no tool
 *     requests, and either `phase === 'final_answer'` or no `phase` field).
 *  2. The last `session.task_complete` event's `data.summary`.
 *
 * Copilot CLI in autopilot mode (which batch mode auto-enters) commonly ends
 * a turn by calling the `task_complete` tool with an empty assistant.message
 * and the full conclusion in `task_complete.arguments.summary` (mirrored to
 * `session.task_complete.data.summary`). Without #2, Maestro would fall back
 * to a stale assistant.message from an earlier turn and show the user
 * unrelated text.
 *
 * This is the on-disk equivalent of the parser's final-answer recognition
 * in `CopilotOutputParser.parseAssistantMessage`. We re-derive it from
 * disk because the parent process's `streamedText` can be stale when
 * subagents continue working post-exit.
 */
export async function readCopilotFinalAnswer(
	agentSessionId: string,
	configDir?: string,
	sshRemote: SshRemoteConfig | null = null
): Promise<CopilotFinalAnswer | null> {
	const content = await readCopilotEventsContent(agentSessionId, sshRemote, configDir);
	if (content === null) return null;

	// Scope to the current turn so a resumed session's earlier-turn answers
	// can't be returned as this turn's conclusion. See `currentSegmentOffset`.
	let latest: string | null = null;
	for (const line of sliceToCurrentSegment(content).split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		// Cheap pre-filter: skip lines that can't be either event type.
		const hasAssistantMessage = trimmed.includes('"assistant.message"');
		const hasTaskComplete = trimmed.includes('"session.task_complete"');
		if (!hasAssistantMessage && !hasTaskComplete) continue;
		try {
			const evt = JSON.parse(trimmed) as {
				type?: string;
				data?: {
					content?: string;
					phase?: string;
					toolRequests?: unknown[];
					summary?: string;
					/** Set on assistant.message events emitted by a delegated subagent
					 *  in response to the parent's `task` tool call. Subagent replies
					 *  are NOT the parent's final answer and must be excluded. */
					parentToolCallId?: string;
				};
			};
			const data = evt.data;
			if (!data) continue;
			if (evt.type === 'assistant.message') {
				if (typeof data.content !== 'string' || data.content.length === 0) continue;
				if (data.toolRequests && data.toolRequests.length > 0) continue;
				if (data.phase !== undefined && data.phase !== 'final_answer') continue;
				// Skip subagent replies - they live in the same events.jsonl as the
				// parent's messages but are not the parent's conclusion.
				if (data.parentToolCallId) continue;
				latest = data.content;
			} else if (evt.type === 'session.task_complete') {
				if (typeof data.summary !== 'string' || data.summary.length === 0) continue;
				latest = data.summary;
			}
		} catch {
			// Malformed line - skip.
		}
	}

	return latest === null ? null : { content: latest };
}

/**
 * Read the LATEST `session.shutdown` event from a Copilot session's
 * `events.jsonl` and extract a `CopilotShutdownUsage` snapshot suitable for
 * pushing into the renderer's usage gauge.
 *
 * Copilot CLI in batch mode emits `session.shutdown` ONLY to disk; nothing on
 * stdout carries `currentTokens`. Without this read the renderer's context
 * gauge stays at 0% for every Copilot tab even though the actual context is
 * being filled. The companion `extractCopilotUsageFromDisk` helper in
 * `group-chat/copilot-usage-extractor.ts` does the same for group chat
 * participants; this one targets the regular AI-tab spawn path.
 *
 * Returns null when the file is unreadable, no shutdown event has been
 * written yet, or the shutdown event is missing the model-metric block.
 */
export async function readCopilotShutdownUsage(
	agentSessionId: string,
	configDir?: string,
	sshRemote: SshRemoteConfig | null = null
): Promise<CopilotShutdownUsage | null> {
	const content = await readCopilotEventsContent(agentSessionId, sshRemote, configDir);
	if (content === null) return null;

	interface ShutdownData {
		currentTokens?: number;
		currentModel?: string;
		modelMetrics?: Record<
			string,
			{
				usage?: {
					inputTokens?: number;
					outputTokens?: number;
					cacheReadTokens?: number;
					cacheWriteTokens?: number;
					reasoningTokens?: number;
				};
			}
		>;
	}

	// Scope to the current turn's segment so the gauge reflects this turn's
	// shutdown snapshot, not a stale one from an earlier turn of a resumed
	// session. See `currentSegmentOffset`.
	let latest: ShutdownData | null = null;
	for (const line of sliceToCurrentSegment(content).split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || !trimmed.includes('"session.shutdown"')) continue;
		try {
			const evt = JSON.parse(trimmed) as { type?: string; data?: ShutdownData };
			if (evt.type === 'session.shutdown' && evt.data) {
				latest = evt.data;
			}
		} catch {
			// Malformed line - skip.
		}
	}

	if (!latest) return null;

	const currentTokens = typeof latest.currentTokens === 'number' ? latest.currentTokens : 0;
	const modelMetrics = latest.modelMetrics ?? {};

	// Sum the per-model usage rows. In practice a single session usually has
	// one entry keyed on `currentModel`, but Copilot allows mid-session model
	// switches that can leave multiple rows behind; summing keeps the picture
	// honest. Cache fields are subsets of inputs at the Copilot reporting
	// layer (combined-context semantics) - see COMBINED_CONTEXT_AGENTS.
	let outputTokens = 0;
	let cacheReadInputTokens = 0;
	let cacheCreationInputTokens = 0;
	let reasoningTokens = 0;
	for (const metric of Object.values(modelMetrics)) {
		outputTokens += metric.usage?.outputTokens ?? 0;
		cacheReadInputTokens += metric.usage?.cacheReadTokens ?? 0;
		cacheCreationInputTokens += metric.usage?.cacheWriteTokens ?? 0;
		reasoningTokens += metric.usage?.reasoningTokens ?? 0;
	}

	// `currentTokens` is the live context-window occupancy; we surface it as
	// inputTokens so the combined-formula gauge (`input + cacheCreation +
	// output`) approximates the right value without re-adding cache reads
	// already represented in the conversation slice of currentTokens.
	if (
		currentTokens === 0 &&
		outputTokens === 0 &&
		cacheReadInputTokens === 0 &&
		cacheCreationInputTokens === 0
	) {
		return null;
	}

	return {
		inputTokens: currentTokens,
		outputTokens,
		cacheReadInputTokens,
		cacheCreationInputTokens,
		reasoningTokens,
	};
}

function contentContainsShutdown(content: string): boolean {
	for (const pattern of SHUTDOWN_PATTERNS) {
		if (content.includes(pattern)) return true;
	}
	return false;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
