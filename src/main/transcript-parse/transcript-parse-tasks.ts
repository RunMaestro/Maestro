/**
 * Transcript parse tasks: read one session transcript from disk and derive the
 * numbers a stats cache stores for it.
 *
 * These are the bodies the worker pool runs (`transcript-parse-pool.ts`). They
 * live in their own module, apart from the IPC handlers and storage classes
 * that used to inline them, for one reason: a worker thread has no `electron`,
 * so nothing reachable from here may import it. Keep it that way - `import
 * type` is fine, a value import of anything that touches `electron`, the
 * logger, or Sentry breaks the worker at load.
 *
 * Each task READS ITS OWN FILE rather than being handed the content. A
 * transcript can run to hundreds of MB; reading it inside the worker keeps that
 * string out of the main process heap entirely instead of copying it across.
 * Errors propagate to the caller unchanged in kind (see the pool's rehydration),
 * so the `RangeError` / unreadable-file carve-outs at each call site still apply.
 */

import fs from 'fs/promises';
import { CLAUDE_SESSION_PARSE_LIMITS } from '../constants';
import {
	computeClaudeSessionUsage,
	computeClaudeUsageWithSubagents,
	readClaudeSubagentTranscripts,
} from '../../shared/claudeSessionUsage';
import { CodexTokenCounts } from '../../shared/codexTokenUsage';
import { countClaudeTranscriptMessages } from '../../shared/claudeTranscriptMessages';
import { claudeModelUsage } from '../../shared/modelUsage';
import { computeClaudeTokenSpeed } from '../../shared/tokenSpeed';
import type { CachedSessionStats } from '../utils/statsCache';
import type { AgentSessionInfo } from '../agents/session-storage';

/** What the global stats cache stores per transcript, minus its fingerprint. */
export type UsageStatsParse = Omit<CachedSessionStats, 'fileMtimeMs'>;

/** What the per-project stats cache stores per transcript, minus its fingerprint. */
export interface ProjectSessionStatsParse {
	messages: number;
	costUsd: number;
	sizeBytes: number;
	tokens: number;
	tokenSplit: {
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens: number;
		cacheCreationTokens: number;
	};
	oldestTimestamp: string | null;
}

export type TranscriptParseTask =
	| { kind: 'claude-usage-stats'; filePath: string; sizeBytes: number }
	| { kind: 'codex-usage-stats'; filePath: string; sizeBytes: number }
	| { kind: 'claude-project-stats'; filePath: string; sizeBytes: number }
	| {
			kind: 'claude-session-info';
			filePath: string;
			sessionId: string;
			projectPath: string;
			sizeBytes: number;
			mtimeMs: number;
	  };

interface TranscriptParseResults {
	'claude-usage-stats': UsageStatsParse;
	'codex-usage-stats': UsageStatsParse;
	'claude-project-stats': ProjectSessionStatsParse;
	'claude-session-info': AgentSessionInfo;
}

export type TranscriptParseResult<T extends TranscriptParseTask> =
	TranscriptParseResults[T['kind']];

/** Run one task in the current thread. The worker calls this; so does the inline fallback. */
export async function runTranscriptParseTask<T extends TranscriptParseTask>(
	task: T
): Promise<TranscriptParseResult<T>> {
	switch (task.kind) {
		case 'claude-usage-stats': {
			const content = await fs.readFile(task.filePath, 'utf-8');
			const subagents = await readClaudeSubagentTranscripts(task.filePath);
			return parseClaudeUsageStats(content, task.sizeBytes, subagents) as TranscriptParseResult<T>;
		}
		case 'codex-usage-stats': {
			const content = await fs.readFile(task.filePath, 'utf-8');
			return parseCodexUsageStats(content, task.sizeBytes) as TranscriptParseResult<T>;
		}
		case 'claude-project-stats': {
			const content = await fs.readFile(task.filePath, 'utf-8');
			return (await parseClaudeProjectStats(
				task.filePath,
				content,
				task.sizeBytes
			)) as TranscriptParseResult<T>;
		}
		case 'claude-session-info': {
			const content = await fs.readFile(task.filePath, 'utf-8');
			const subagents = await readClaudeSubagentTranscripts(task.filePath);
			return parseClaudeSessionInfo(
				content,
				task.sessionId,
				task.projectPath,
				{ size: task.sizeBytes, mtimeMs: task.mtimeMs },
				subagents
			) as TranscriptParseResult<T>;
		}
	}
}

/**
 * Usage totals for one Claude transcript. Usage and cost include the session's
 * subagent transcripts, which Claude Code keeps in separate files.
 */
export function parseClaudeUsageStats(
	content: string,
	sizeBytes: number,
	subagentContents: readonly string[]
): UsageStatsParse {
	const { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, costUsd } =
		computeClaudeUsageWithSubagents(content, subagentContents);

	return {
		messages: countClaudeTranscriptMessages(content),
		inputTokens,
		outputTokens,
		cacheReadTokens,
		cacheCreationTokens,
		cachedInputTokens: 0,
		sizeBytes,
		costUsd,
	};
}

/** Usage totals for one Codex transcript. */
export function parseCodexUsageStats(content: string, sizeBytes: number): UsageStatsParse {
	const lines = content.split('\n').filter((l) => l.trim());

	let messageCount = 0;
	const tokenCounts = new CodexTokenCounts();

	for (const line of lines) {
		try {
			const entry = JSON.parse(line);

			// Count messages from response_item entries
			if (entry.type === 'response_item' && entry.payload?.type === 'message') {
				const role = entry.payload.role;
				if (role === 'user' || role === 'assistant') {
					messageCount++;
				}
			}

			// Extract token usage from event_msg with token_count payload.
			// `total_token_usage` is cumulative, so it must never be summed - see
			// CodexTokenCounts.
			if (entry.type === 'event_msg' && entry.payload?.type === 'token_count') {
				tokenCounts.addTokenCountEvent(entry.payload.info);
			}
		} catch {
			// Skip malformed lines
		}
	}

	return {
		messages: messageCount,
		inputTokens: tokenCounts.inputTokens,
		outputTokens: tokenCounts.outputTokens,
		cacheReadTokens: 0,
		cacheCreationTokens: 0,
		cachedInputTokens: tokenCounts.cachedTokens,
		sizeBytes,
	};
}

/** Per-project stats for one Claude transcript (the Agent Sessions browser totals). */
export async function parseClaudeProjectStats(
	filePath: string,
	content: string,
	sizeBytes: number
): Promise<ProjectSessionStatsParse> {
	const messages = countClaudeTranscriptMessages(content);

	// Per-model token + cost extraction (a session may mix models).
	const { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, costUsd } =
		await computeClaudeSessionUsage(filePath, content);

	let oldestTimestamp: string | null = null;
	const lines = content.split('\n').filter((l) => l.trim());
	for (
		let j = 0;
		j < Math.min(lines.length, CLAUDE_SESSION_PARSE_LIMITS.OLDEST_TIMESTAMP_SCAN_LINES);
		j++
	) {
		try {
			const entry = JSON.parse(lines[j]);
			if (entry.timestamp) {
				oldestTimestamp = entry.timestamp;
				break;
			}
		} catch {
			// Skip malformed lines
		}
	}

	return {
		messages,
		costUsd,
		sizeBytes,
		tokens: inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens,
		tokenSplit: { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens },
		oldestTimestamp,
	};
}

/**
 * Extract semantic text from a Claude message's content.
 * Skips images, tool_use, and tool_result - only returns actual text content.
 */
export function extractClaudeTextFromContent(content: unknown): string {
	if (typeof content === 'string') {
		return content;
	}
	if (Array.isArray(content)) {
		const textParts = content
			.filter((part: { type?: string }) => part.type === 'text')
			.map((part: { type?: string; text?: string }) => part.text || '')
			.filter((text: string) => text.trim());
		return textParts.join(' ');
	}
	return '';
}

/**
 * Session-list metadata for one Claude transcript (preview, usage, cost,
 * duration, token speed). Throws on a transcript it cannot make sense of; the
 * storage layer decides how that is reported.
 */
export function parseClaudeSessionInfo(
	content: string,
	sessionId: string,
	projectPath: string,
	stats: { size: number; mtimeMs: number },
	subagentContents: readonly string[] = []
): AgentSessionInfo {
	const lines = content.split('\n').filter((l) => l.trim());

	let firstAssistantMessage = '';
	let firstUserMessage = '';
	let timestamp = new Date(stats.mtimeMs).toISOString();

	const messageCount = countClaudeTranscriptMessages(content);

	// Extract first meaningful message content
	// Prefer first assistant response as preview (more meaningful than system context)
	// Fall back to first user message if no assistant response exists
	for (
		let i = 0;
		i < Math.min(lines.length, CLAUDE_SESSION_PARSE_LIMITS.FIRST_MESSAGE_SCAN_LINES);
		i++
	) {
		try {
			const entry = JSON.parse(lines[i]);
			// Capture first user message as fallback
			if (!firstUserMessage && entry.type === 'user' && entry.message?.content) {
				const textContent = extractClaudeTextFromContent(entry.message.content);
				if (textContent.trim()) {
					firstUserMessage = textContent;
					timestamp = entry.timestamp || timestamp;
				}
			}
			// Capture first assistant message as preferred preview
			if (!firstAssistantMessage && entry.type === 'assistant' && entry.message?.content) {
				const textContent = extractClaudeTextFromContent(entry.message.content);
				if (textContent.trim()) {
					firstAssistantMessage = textContent;
					// Once we have assistant message, we can stop scanning
					break;
				}
			}
		} catch {
			// Skip malformed lines
		}
	}

	// Use assistant response as preview if available, otherwise fall back to user message
	const previewMessage = firstAssistantMessage || firstUserMessage;

	// Per-model token + cost extraction (a session may mix models).
	const {
		inputTokens: totalInputTokens,
		outputTokens: totalOutputTokens,
		cacheReadTokens: totalCacheReadTokens,
		cacheCreationTokens: totalCacheCreationTokens,
		costUsd,
		byModel,
	} = computeClaudeUsageWithSubagents(content, subagentContents);

	// Extract last timestamp for duration
	let lastTimestamp = timestamp;
	for (
		let i = lines.length - 1;
		i >= Math.max(0, lines.length - CLAUDE_SESSION_PARSE_LIMITS.LAST_TIMESTAMP_SCAN_LINES);
		i--
	) {
		try {
			const entry = JSON.parse(lines[i]);
			if (entry.timestamp) {
				lastTimestamp = entry.timestamp;
				break;
			}
		} catch {
			// Skip malformed lines
		}
	}

	const startTime = new Date(timestamp).getTime();
	const endTime = new Date(lastTimestamp).getTime();
	const durationSeconds = Math.max(0, Math.floor((endTime - startTime) / 1000));

	return {
		sessionId,
		projectPath,
		timestamp,
		modifiedAt: new Date(stats.mtimeMs).toISOString(),
		firstMessage: previewMessage.slice(0, CLAUDE_SESSION_PARSE_LIMITS.FIRST_MESSAGE_PREVIEW_LENGTH),
		messageCount,
		sizeBytes: stats.size,
		costUsd,
		inputTokens: totalInputTokens,
		outputTokens: totalOutputTokens,
		cacheReadTokens: totalCacheReadTokens,
		cacheCreationTokens: totalCacheCreationTokens,
		byModel: claudeModelUsage(byModel),
		// Timed per transcript: a subagent's first call must not be timed
		// from the parent's last line.
		speed: computeClaudeTokenSpeed([content, ...subagentContents]),
		durationSeconds,
	};
}
