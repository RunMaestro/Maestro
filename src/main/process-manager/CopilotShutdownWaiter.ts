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
 * Scan `events.jsonl` for the authoritative final assistant message Copilot
 * actually produced. Returns the content of the last `assistant.message`
 * line whose data has non-empty `content`, no tool requests, and either
 * `phase === 'final_answer'` or no `phase` field (the modern Copilot CLI
 * convention).
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
		if (!trimmed || !trimmed.includes('"assistant.message"')) continue;
		try {
			const evt = JSON.parse(trimmed) as {
				type?: string;
				data?: {
					content?: string;
					phase?: string;
					toolRequests?: unknown[];
				};
			};
			if (evt.type !== 'assistant.message') continue;
			const data = evt.data;
			if (!data || typeof data.content !== 'string' || data.content.length === 0) continue;
			if (data.toolRequests && data.toolRequests.length > 0) continue;
			if (data.phase !== undefined && data.phase !== 'final_answer') continue;
			latest = data.content;
		} catch {
			// Malformed line — skip.
		}
	}

	return latest === null ? null : { content: latest };
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
