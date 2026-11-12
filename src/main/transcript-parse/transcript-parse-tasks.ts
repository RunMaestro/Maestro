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
 * Each task READS ITS OWN FILE rather than being handed the content, and reads
 * it as a STREAM, one line at a time. A transcript can run to hundreds of MB.
 * Reading one whole held it as one string (two bytes a character once it has
 * any non-Latin-1 text), then a second copy as the line array. A worker thread
 * that cannot fit one allocation does not just stop: V8's out-of-memory handler
 * aborts the whole process, so a single large transcript took the app down
 * (MAESTRO-183, MAESTRO-184, MAESTRO-186). Every result is therefore a FOLD fed
 * line by line; the cost is bounded by the longest line, not by the file.
 * Errors propagate to the caller unchanged in kind (see the pool's rehydration),
 * so the `RangeError` / unreadable-file carve-outs at each call site still apply.
 *
 * `parseClaudeSessionInfo` keeps a content form for transcripts already in hand
 * (an SSH read). It runs the SAME fold, so the two paths cannot disagree.
 */

import { CLAUDE_SESSION_PARSE_LIMITS } from '../constants';
import { forEachJsonlLine } from '../utils/jsonl-stream';
import {
	isAbsentTranscriptError,
	listClaudeSubagentTranscriptPaths,
} from '../../shared/claudeSessionUsage';
import { CodexTokenCounts } from '../../shared/codexTokenUsage';
import { createClaudeMessageCounter } from '../../shared/claudeTranscriptMessages';
import { createClaudeUsageAccumulator } from '../../shared/modelPricing';
import { claudeModelUsage } from '../../shared/modelUsage';
import {
	createClaudeSpeedSampler,
	TokenSpeedBucketer,
	type ClaudeSpeedSampler,
} from '../../shared/tokenSpeed';
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
		case 'claude-usage-stats':
			return (await foldClaudeSessionFiles(
				task.filePath,
				claudeUsageStatsFold(task.sizeBytes)
			)) as TranscriptParseResult<T>;
		case 'codex-usage-stats': {
			const fold = codexUsageStatsFold(task.sizeBytes);
			await forEachJsonlLine(task.filePath, fold.line);
			return fold.finish() as TranscriptParseResult<T>;
		}
		case 'claude-project-stats':
			return (await foldClaudeSessionFiles(
				task.filePath,
				claudeProjectStatsFold(task.sizeBytes)
			)) as TranscriptParseResult<T>;
		case 'claude-session-info':
			return (await foldClaudeSessionFiles(
				task.filePath,
				claudeSessionInfoFold(task.sessionId, task.projectPath, {
					size: task.sizeBytes,
					mtimeMs: task.mtimeMs,
				})
			)) as TranscriptParseResult<T>;
	}
}

/**
 * A result derived from a Claude session: its own transcript, then each of its
 * subagent transcripts (Claude Code keeps those in separate files), fed one
 * non-blank line at a time.
 */
interface ClaudeSessionFold<R> {
	/** One line of the session's own transcript. */
	parentLine(line: string): void;
	/** The next subagent transcript starts. Every `subagentLine` after this belongs to it. */
	beginSubagent(): void;
	/** One line of the current subagent transcript. */
	subagentLine(line: string): void;
	/** Every line has been fed. Called once. */
	finish(): R;
}

/** Stream a session file and its subagent files through a fold. */
async function foldClaudeSessionFiles<R>(
	sessionFilePath: string,
	fold: ClaudeSessionFold<R>
): Promise<R> {
	await forEachJsonlLine(sessionFilePath, fold.parentLine);
	for (const subagentPath of await listClaudeSubagentTranscriptPaths(sessionFilePath)) {
		fold.beginSubagent();
		try {
			await forEachJsonlLine(subagentPath, fold.subagentLine);
		} catch (error) {
			// A subagent file that vanished between the listing and the read is
			// not an error, matching `iterateClaudeSubagentTranscripts`.
			if (!isAbsentTranscriptError(error)) throw error;
		}
	}
	return fold.finish();
}

/** Run a fold over transcripts already in hand. Blank lines are skipped, as a stream skips them. */
function foldClaudeSessionContents<R>(
	fold: ClaudeSessionFold<R>,
	parentContent: string,
	subagentContents: readonly string[]
): R {
	for (const line of parentContent.split('\n')) if (line.trim()) fold.parentLine(line);
	for (const content of subagentContents) {
		fold.beginSubagent();
		for (const line of content.split('\n')) if (line.trim()) fold.subagentLine(line);
	}
	return fold.finish();
}

/**
 * Usage totals for one Claude transcript. Usage and cost include the session's
 * subagent transcripts; the message count is the session's own conversation.
 */
function claudeUsageStatsFold(sizeBytes: number): ClaudeSessionFold<UsageStatsParse> {
	const messages = createClaudeMessageCounter();
	const usage = createClaudeUsageAccumulator();
	return {
		parentLine(line) {
			messages.addLine(line);
			usage.addLine(line);
		},
		beginSubagent() {},
		subagentLine: usage.addLine,
		finish() {
			const { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, costUsd } =
				usage.finish();
			return {
				messages: messages.count(),
				inputTokens,
				outputTokens,
				cacheReadTokens,
				cacheCreationTokens,
				cachedInputTokens: 0,
				sizeBytes,
				costUsd,
			};
		},
	};
}

/** Usage totals for one Codex transcript, fed one line at a time. */
function codexUsageStatsFold(sizeBytes: number): {
	line(line: string): void;
	finish(): UsageStatsParse;
} {
	let messageCount = 0;
	const tokenCounts = new CodexTokenCounts();

	return {
		line(line) {
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
		},
		finish() {
			return {
				messages: messageCount,
				inputTokens: tokenCounts.inputTokens,
				outputTokens: tokenCounts.outputTokens,
				cacheReadTokens: 0,
				cacheCreationTokens: 0,
				cachedInputTokens: tokenCounts.cachedTokens,
				sizeBytes,
			};
		},
	};
}

/** Per-project stats for one Claude transcript (the Agent Sessions browser totals). */
function claudeProjectStatsFold(sizeBytes: number): ClaudeSessionFold<ProjectSessionStatsParse> {
	const messages = createClaudeMessageCounter();
	// Per-model token + cost extraction (a session may mix models).
	const usage = createClaudeUsageAccumulator();
	let parentLines = 0;
	let oldestTimestamp: string | null = null;

	return {
		parentLine(line) {
			messages.addLine(line);
			usage.addLine(line);
			if (
				oldestTimestamp === null &&
				parentLines++ < CLAUDE_SESSION_PARSE_LIMITS.OLDEST_TIMESTAMP_SCAN_LINES
			) {
				oldestTimestamp = readTimestamp(line);
			}
		},
		beginSubagent() {},
		subagentLine: usage.addLine,
		finish() {
			const { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, costUsd } =
				usage.finish();
			return {
				messages: messages.count(),
				costUsd,
				sizeBytes,
				tokens: inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens,
				tokenSplit: { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens },
				oldestTimestamp,
			};
		},
	};
}

/** A line's `timestamp`, or null when it has none or is not JSON. */
function readTimestamp(line: string): string | null {
	try {
		const entry = JSON.parse(line);
		return entry.timestamp || null;
	} catch {
		return null; // Skip malformed lines
	}
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
 * duration, token speed), from content already in hand. Throws on a transcript
 * it cannot make sense of; the storage layer decides how that is reported. A
 * local file goes through the worker pool, which streams the same fold.
 */
export function parseClaudeSessionInfo(
	content: string,
	sessionId: string,
	projectPath: string,
	stats: { size: number; mtimeMs: number },
	subagentContents: readonly string[] = []
): AgentSessionInfo {
	return foldClaudeSessionContents(
		claudeSessionInfoFold(sessionId, projectPath, stats),
		content,
		subagentContents
	);
}

function claudeSessionInfoFold(
	sessionId: string,
	projectPath: string,
	stats: { size: number; mtimeMs: number }
): ClaudeSessionFold<AgentSessionInfo> {
	const messages = createClaudeMessageCounter();
	// Per-model token + cost extraction (a session may mix models).
	const usage = createClaudeUsageAccumulator();
	// Timed per transcript: a subagent's first call must not be timed from the
	// parent's last line, so each transcript gets its own sampler.
	const speed = new TokenSpeedBucketer();
	let sampler: ClaudeSpeedSampler = createClaudeSpeedSampler((sample) => speed.add(sample));

	let parentLines = 0;
	let firstAssistantMessage = '';
	let firstUserMessage = '';
	let firstUserTimestamp: string | undefined;
	// The session's last few lines, for its end time. A ring of raw lines: only
	// the tail is ever parsed, so a long transcript is not parsed twice.
	const tail: string[] = [];

	return {
		parentLine(line) {
			messages.addLine(line);
			usage.addLine(line);
			sampler.addLine(line);

			// Extract first meaningful message content. Prefer the first assistant
			// response as preview (more meaningful than system context); fall back
			// to the first user message if no assistant response exists.
			if (
				!firstAssistantMessage &&
				parentLines < CLAUDE_SESSION_PARSE_LIMITS.FIRST_MESSAGE_SCAN_LINES
			) {
				try {
					const entry = JSON.parse(line);
					// Capture first user message as fallback
					if (!firstUserMessage && entry.type === 'user' && entry.message?.content) {
						const textContent = extractClaudeTextFromContent(entry.message.content);
						if (textContent.trim()) {
							firstUserMessage = textContent;
							firstUserTimestamp = entry.timestamp;
						}
					}
					// Capture first assistant message as preferred preview
					if (entry.type === 'assistant' && entry.message?.content) {
						const textContent = extractClaudeTextFromContent(entry.message.content);
						if (textContent.trim()) firstAssistantMessage = textContent;
					}
				} catch {
					// Skip malformed lines
				}
			}
			parentLines++;

			tail.push(line);
			if (tail.length > CLAUDE_SESSION_PARSE_LIMITS.LAST_TIMESTAMP_SCAN_LINES) tail.shift();
		},
		beginSubagent() {
			sampler.finish();
			sampler = createClaudeSpeedSampler((sample) => speed.add(sample));
		},
		subagentLine(line) {
			usage.addLine(line);
			sampler.addLine(line);
		},
		finish() {
			sampler.finish();

			const timestamp = firstUserTimestamp || new Date(stats.mtimeMs).toISOString();
			// Use assistant response as preview if available, otherwise fall back to user message
			const previewMessage = firstAssistantMessage || firstUserMessage;

			// Extract last timestamp for duration
			let lastTimestamp = timestamp;
			for (let i = tail.length - 1; i >= 0; i--) {
				const found = readTimestamp(tail[i]);
				if (found) {
					lastTimestamp = found;
					break;
				}
			}

			const startTime = new Date(timestamp).getTime();
			const endTime = new Date(lastTimestamp).getTime();
			const durationSeconds = Math.max(0, Math.floor((endTime - startTime) / 1000));

			const { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, costUsd, byModel } =
				usage.finish();

			return {
				sessionId,
				projectPath,
				timestamp,
				modifiedAt: new Date(stats.mtimeMs).toISOString(),
				firstMessage: previewMessage.slice(
					0,
					CLAUDE_SESSION_PARSE_LIMITS.FIRST_MESSAGE_PREVIEW_LENGTH
				),
				messageCount: messages.count(),
				sizeBytes: stats.size,
				costUsd,
				inputTokens,
				outputTokens,
				cacheReadTokens,
				cacheCreationTokens,
				byModel: claudeModelUsage(byModel),
				speed: speed.result(),
				durationSeconds,
			};
		},
	};
}
