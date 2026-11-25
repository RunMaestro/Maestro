/**
 * Codex session-info fold: the metadata `CodexSessionStorage.listSessions`
 * stores for one rollout, derived one line at a time.
 *
 * This used to run on the main thread over the whole file (`fs.readFile`, then
 * a line array, then every line parsed). Every Auto Run task grows a rollout,
 * the next listing sees a newer mtime and reparses it, and a rollout runs to
 * tens or hundreds of MB. Each reparse put several hundred MB of garbage on the
 * main heap, so long Codex Auto Runs drove the main process into near-constant
 * GC (#2084). It now runs as the `codex-session-info` task in the transcript
 * parse worker pool, streamed, like `claude-session-info`.
 *
 * Worker rule (see `transcript-parse-tasks.ts`): nothing reachable from here
 * may import `electron`, the logger, or Sentry.
 */

import path from 'path';
import type { AgentSessionInfo } from '../agents/session-storage';
import { CodexTokenCounts } from '../../shared/codexTokenUsage';
import { ModelUsageAccumulator } from '../../shared/modelUsage';
import { CodexTokenSpeedTracker } from '../../shared/tokenSpeed';

/** Characters of the first message kept as the session preview. */
export const CODEX_FIRST_MESSAGE_PREVIEW_LENGTH = 200;

/**
 * Codex session metadata structure (first line of JSONL)
 * Format: { type: 'session_meta', payload: { id, cwd, timestamp, ... } }
 */
export interface CodexSessionMetadata {
	type?: string;
	timestamp?: string;
	payload?: {
		id: string;
		cwd?: string;
		timestamp?: string;
		originator?: string;
		cli_version?: string;
		model_provider?: string;
		git?: {
			commit_hash?: string;
			branch?: string;
			repository_url?: string;
		};
	};
	// Legacy format (direct fields)
	id?: string;
	git?: {
		commit_hash?: string;
		branch?: string;
		repository_url?: string;
	};
}

/**
 * Codex message content structure
 */
export interface CodexMessageContent {
	type: string;
	text?: string;
	// Tool use fields
	tool?: string;
	args?: unknown;
	output?: string;
}

/**
 * Extract text from Codex message content array
 */
export function extractTextFromContent(content: CodexMessageContent[] | undefined): string {
	if (!content || !Array.isArray(content)) {
		return '';
	}

	const textParts = content
		.filter(
			(part) => part.type === 'input_text' || part.type === 'text' || part.type === 'output_text'
		)
		.map((part) => part.text || '')
		.filter((text) => text.trim());

	return textParts.join(' ');
}

/**
 * Check if text is a system/environment context message that should be skipped for preview
 */
export function isSystemContextMessage(text: string): boolean {
	if (!text) return false;
	const trimmed = text.trim();
	// Skip messages that start with environment/system context XML tags
	if (
		trimmed.startsWith('<environment_context>') ||
		trimmed.startsWith('<cwd>') ||
		trimmed.startsWith('<system>') ||
		trimmed.startsWith('<approval_policy>')
	) {
		return true;
	}
	// Skip markdown-formatted system context (e.g., "# Context Your name is **Maestro Codex**...")
	if (
		trimmed.startsWith('# Context') ||
		trimmed.startsWith('# Maestro System Context') ||
		trimmed.startsWith('# System Context')
	) {
		return true;
	}
	return false;
}

export function extractCwdFromText(text: string): string | null {
	const match = text.match(/<cwd>([^<]+)<\/cwd>/i);
	return match ? match[1].trim() : null;
}

export function normalizeProjectPath(projectPath: string): string {
	return path.resolve(projectPath);
}

/**
 * Session info for one local Codex rollout, fed its non-blank lines in order.
 * `finish()` returns null for a file with no non-blank lines.
 */
export function codexSessionInfoFold(
	sessionId: string,
	stats: { size: number; mtimeMs: number }
): { line(line: string): void; finish(): AgentSessionInfo | null } {
	let sawLine = false;
	let metadata: CodexSessionMetadata | null = null;
	let timestamp = new Date(stats.mtimeMs).toISOString();
	let sessionProjectPath: string | null = null;

	// Count messages and find first assistant response (preferred) or user message (fallback)
	let firstAssistantMessage = '';
	let firstUserMessage = '';
	let userMessageCount = 0;
	let assistantMessageCount = 0;
	const tokenCounts = new CodexTokenCounts();
	const speedTracker = new CodexTokenSpeedTracker();
	let firstTimestamp = timestamp;
	let lastTimestamp = timestamp;
	// Codex is single-model per session; the model id lives on turn_context /
	// session_meta entries rather than on the usage events. Capture the last
	// seen one so per-model token attribution has a real model to key on.
	let capturedModel: string | undefined;

	/** The first line carries the session metadata; read it before the entry pass. */
	function readMetadata(line: string): void {
		try {
			const firstLine = JSON.parse(line);
			// New format: { type: 'session_meta', payload: { id, cwd, timestamp, ... } }
			if (firstLine.type === 'session_meta' && firstLine.payload) {
				metadata = firstLine as CodexSessionMetadata;
				timestamp = firstLine.payload.timestamp || firstLine.timestamp || timestamp;
				// Get project path directly from session_meta
				if (firstLine.payload.cwd) {
					sessionProjectPath = firstLine.payload.cwd;
				}
			}
			// Legacy format: { id, timestamp, ... } at top level
			else if (firstLine.id && firstLine.timestamp) {
				metadata = firstLine as CodexSessionMetadata;
				timestamp = firstLine.timestamp || timestamp;
			}
		} catch {
			// First line may not be metadata, continue parsing
		}
		firstTimestamp = timestamp;
		lastTimestamp = timestamp;
		const payload = (metadata as CodexSessionMetadata | null)?.payload;
		capturedModel =
			payload && 'model' in payload ? (payload as { model?: string }).model : undefined;
	}

	function readEntry(line: string): void {
		try {
			const entry = JSON.parse(line);

			// Capture the model id from turn_context entries (current Codex format)
			if (entry.type === 'turn_context' && entry.payload?.model) {
				capturedModel = entry.payload.model;
			}

			speedTracker.observe(entry, capturedModel);

			// Handle turn.completed for usage stats (already per-turn)
			if (entry.type === 'turn.completed' && entry.usage) {
				tokenCounts.addTurn(entry.usage);
			}

			// Handle Codex "event_msg" usage stats
			if (entry.type === 'event_msg' && entry.payload?.type === 'token_count') {
				tokenCounts.addTokenCountEvent(entry.payload.info);
			}

			// Message entries: legacy (`message`) and current (`response_item`) formats
			const message =
				entry.type === 'message'
					? entry
					: entry.type === 'response_item' && entry.payload?.type === 'message'
						? entry.payload
						: null;
			if (message) {
				if (message.role === 'user') {
					userMessageCount++;
					if (message.content) {
						const text = extractTextFromContent(message.content);
						// Capture first user message as fallback preview (skip system context)
						if (!firstUserMessage && text.trim() && !isSystemContextMessage(text)) {
							firstUserMessage = text;
						}
						// Fallback: extract cwd from message content if not in session_meta
						if (!sessionProjectPath) {
							const cwd = extractCwdFromText(text);
							if (cwd) {
								sessionProjectPath = cwd;
							}
						}
					}
				} else if (message.role === 'assistant') {
					assistantMessageCount++;
					// Capture first assistant message as preferred preview
					if (!firstAssistantMessage && message.content) {
						const text = extractTextFromContent(message.content);
						if (text.trim()) {
							firstAssistantMessage = text;
						}
					}
				}
			}

			// Handle item.completed for agent messages
			if (entry.type === 'item.completed' && entry.item) {
				if (entry.item.type === 'agent_message') {
					assistantMessageCount++;
					// Capture first agent message as preferred preview
					if (!firstAssistantMessage && entry.item.text) {
						firstAssistantMessage = entry.item.text;
					}
				}
			}

			// Track timestamps for duration
			if (entry.timestamp) {
				const entryTime = new Date(entry.timestamp).getTime();
				const firstTime = new Date(firstTimestamp).getTime();
				const lastTime = new Date(lastTimestamp).getTime();

				if (entryTime < firstTime) {
					firstTimestamp = entry.timestamp;
				}
				if (entryTime > lastTime) {
					lastTimestamp = entry.timestamp;
				}
			}
		} catch {
			// Skip malformed lines
		}
	}

	return {
		line(line) {
			if (!sawLine) {
				sawLine = true;
				readMetadata(line);
			}
			readEntry(line);
		},
		finish() {
			if (!sawLine) return null;

			// Use assistant response as preview if available, otherwise fall back to user message
			const previewMessage = firstAssistantMessage || firstUserMessage;
			const messageCount = userMessageCount + assistantMessageCount;

			const startTime = new Date(firstTimestamp).getTime();
			const endTime = new Date(lastTimestamp).getTime();
			const durationSeconds = Math.max(0, Math.floor((endTime - startTime) / 1000));

			// Extract session ID from metadata (new format uses payload.id, legacy uses id)
			const meta = metadata as CodexSessionMetadata | null;
			const metadataSessionId = meta?.payload?.id || meta?.id || sessionId;

			const modelAcc = new ModelUsageAccumulator();
			if (!tokenCounts.isEmpty) {
				modelAcc.add(capturedModel, {
					inputTokens: tokenCounts.inputTokens,
					outputTokens: tokenCounts.outputTokens,
					cacheReadTokens: tokenCounts.cachedTokens,
					cacheCreationTokens: 0,
				});
			}

			return {
				sessionId: metadataSessionId,
				projectPath: sessionProjectPath ? normalizeProjectPath(sessionProjectPath) : '',
				timestamp: firstTimestamp,
				modifiedAt: new Date(stats.mtimeMs).toISOString(),
				firstMessage: previewMessage.slice(0, CODEX_FIRST_MESSAGE_PREVIEW_LENGTH),
				messageCount,
				sizeBytes: stats.size,
				// Note: costUsd omitted - Codex doesn't provide cost and pricing varies by model
				inputTokens: tokenCounts.inputTokens,
				outputTokens: tokenCounts.outputTokens,
				cacheReadTokens: tokenCounts.cachedTokens,
				cacheCreationTokens: 0, // Codex doesn't report cache creation separately
				durationSeconds,
				byModel: modelAcc.isEmpty ? undefined : modelAcc.finalize(),
				speed: speedTracker.result(),
			};
		},
	};
}
