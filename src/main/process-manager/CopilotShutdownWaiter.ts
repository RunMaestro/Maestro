// src/main/process-manager/CopilotShutdownWaiter.ts

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { logger } from '../utils/logger';

const LOG_CONTEXT = 'CopilotShutdownWaiter';

// Bytes of "type":"session.shutdown". Match with or without a space after the
// colon since JSON serializers differ on whitespace.
const SHUTDOWN_PATTERNS = ['"type":"session.shutdown"', '"type": "session.shutdown"'];

const DEFAULT_POLL_INTERVAL_MS = 500;
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
	/** Override for testing — defaults to `~/.copilot` (or $COPILOT_CONFIG_DIR). */
	configDir?: string;
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
 * Resolve the on-disk path Copilot uses for a given agent session.
 */
export function resolveCopilotEventsPath(agentSessionId: string, configDir?: string): string {
	const root = configDir || process.env.COPILOT_CONFIG_DIR || path.join(os.homedir(), '.copilot');
	return path.join(root, 'session-state', agentSessionId, 'events.jsonl');
}

/**
 * Block until Copilot CLI has written its `session.shutdown` event to the
 * on-disk `events.jsonl`. Copilot CLI in batch mode does NOT emit
 * `session.shutdown` to stdout — it only writes it to disk, and it can
 * continue writing AFTER the parent process we spawned has already exited
 * (subagent delegation runs work in additional processes that share the
 * same session-state directory). Without this wait, Maestro flips the
 * tab to `idle` while Copilot is still working.
 *
 * Return values:
 *  - `observed`  — shutdown marker found; Copilot is truly done
 *  - `inactive`  — file went idle for `inactivityMs` without a shutdown marker
 *                  (likely a crash; safe to stop waiting)
 *  - `timeout`   — `maxWaitMs` elapsed; hard cap to avoid stuck `busy` state
 *  - `missing`   — file never appeared (e.g. Copilot crashed before
 *                  `session.start` could be persisted)
 */
export async function waitForCopilotShutdown(
	agentSessionId: string,
	options: CopilotShutdownWaitOptions = {}
): Promise<CopilotShutdownWaitResult> {
	const filePath = resolveCopilotEventsPath(agentSessionId, options.configDir);
	const maxWait = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
	const inactivityThreshold = options.inactivityMs ?? DEFAULT_INACTIVITY_MS;
	const pollInterval = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

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
			// File doesn't exist yet or transiently unreadable — fall through.
		}

		if (content && contentContainsShutdown(content)) {
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
	configDir?: string
): Promise<CopilotFinalAnswer | null> {
	const filePath = resolveCopilotEventsPath(agentSessionId, configDir);
	let content: string;
	try {
		content = await fs.readFile(filePath, 'utf8');
	} catch (err) {
		logger.debug('events.jsonl unavailable', LOG_CONTEXT, {
			error: String(err),
			agentSessionId,
		});
		return null;
	}

	let latest: string | null = null;
	for (const line of content.split(/\r?\n/)) {
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
				// Skip subagent replies — they live in the same events.jsonl as the
				// parent's messages but are not the parent's conclusion.
				if (data.parentToolCallId) continue;
				latest = data.content;
			} else if (evt.type === 'session.task_complete') {
				if (typeof data.summary !== 'string' || data.summary.length === 0) continue;
				latest = data.summary;
			}
		} catch {
			// Malformed line — skip.
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
	configDir?: string
): Promise<CopilotShutdownUsage | null> {
	const filePath = resolveCopilotEventsPath(agentSessionId, configDir);
	let content: string;
	try {
		content = await fs.readFile(filePath, 'utf8');
	} catch (err) {
		logger.debug('events.jsonl unavailable for usage extraction', LOG_CONTEXT, {
			error: String(err),
			agentSessionId,
		});
		return null;
	}

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

	let latest: ShutdownData | null = null;
	for (const line of content.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || !trimmed.includes('"session.shutdown"')) continue;
		try {
			const evt = JSON.parse(trimmed) as { type?: string; data?: ShutdownData };
			if (evt.type === 'session.shutdown' && evt.data) {
				latest = evt.data;
			}
		} catch {
			// Malformed line — skip.
		}
	}

	if (!latest) return null;

	const currentTokens = typeof latest.currentTokens === 'number' ? latest.currentTokens : 0;
	const modelMetrics = latest.modelMetrics ?? {};

	// Sum the per-model usage rows. In practice a single session usually has
	// one entry keyed on `currentModel`, but Copilot allows mid-session model
	// switches that can leave multiple rows behind; summing keeps the picture
	// honest. Cache fields are subsets of inputs at the Copilot reporting
	// layer (combined-context semantics) — see COMBINED_CONTEXT_AGENTS.
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
