/**
 * @file group-chat-types.ts
 * @description Shared type definitions and utilities for Group Chat feature.
 * Used by both main process and renderer.
 */

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Normalize a name for use in @mentions.
 * Replaces spaces with hyphens and drops bracket punctuation so names can be
 * referenced without quotes.
 *
 * @param name - Original name (may contain spaces)
 * @returns Normalized mention-safe name
 */
export function normalizeMentionName(name: string): string {
	return name
		.normalize('NFKC')
		.replace(/[()[\]{}]/g, '')
		.replace(/\s+/g, '-');
}

/**
 * Legacy group-chat aliases only replaced whitespace. Keep accepting them so
 * saved moderator prompts and older chat history can still target agents whose
 * names contain parentheses.
 */
export function normalizeLegacyMentionName(name: string): string {
	return name.normalize('NFKC').replace(/\s+/g, '-');
}

const CLOSING_BRACKET_PAIRS: Record<string, string> = {
	')': '(',
	']': '[',
	'}': '{',
};

const OPENING_BRACKET_PAIRS: Record<string, string> = {
	'(': ')',
	'[': ']',
	'{': '}',
};

export function stripUnmatchedTrailingClosers(name: string): string {
	// Determine which brackets are matched by scanning left-to-right with a
	// per-type opener stack, then drop only trailing closers that have no
	// matching opener. A positional scan (not global counts) is required so an
	// unmatched closer earlier in the string can't make a balanced trailing
	// group look unmatched, e.g. "foo)-bar(1))" must yield "foo)-bar(1)".
	const matched = new Array<boolean>(name.length).fill(false);
	const openStacks: Record<string, number[]> = { ')': [], ']': [], '}': [] };
	for (let i = 0; i < name.length; i++) {
		const char = name[i];
		const expectedCloser = OPENING_BRACKET_PAIRS[char];
		if (expectedCloser) {
			openStacks[expectedCloser].push(i);
			continue;
		}
		const stack = openStacks[char];
		if (stack && stack.length > 0) {
			const openIndex = stack.pop()!;
			matched[openIndex] = true;
			matched[i] = true;
		}
	}

	let end = name.length;
	while (end > 0 && CLOSING_BRACKET_PAIRS[name[end - 1]] && !matched[end - 1]) {
		end--;
	}
	return name.slice(0, end);
}

/**
 * Drops a trailing Markdown link tail so a mention used as link text resolves.
 * `[@Client](https://example.com)` is captured as `Client](https` by the mention
 * scanner (brackets and `(` are allowed for legacy bracketed names); everything
 * from the `](` link syntax onward can never be part of a real name, so cut it.
 */
function stripMarkdownLinkTail(name: string): string {
	const linkSyntaxIndex = name.indexOf('](');
	return linkSyntaxIndex === -1 ? name : name.slice(0, linkSyntaxIndex);
}

export function cleanMentionName(name: string): string {
	const withoutMarkdown = name.normalize('NFKC').replace(/^[*_`~]+|[*_`~.,;:!?]+$/g, '');
	return stripUnmatchedTrailingClosers(stripMarkdownLinkTail(withoutMarkdown));
}

function foldMentionName(name: string): string {
	return name.toLowerCase();
}

export function getMentionMatchPriority(mentionedName: string, actualName: string): number {
	const cleanedMention = cleanMentionName(mentionedName);
	const foldedMention = foldMentionName(cleanedMention);
	const foldedActual = foldMentionName(actualName.normalize('NFKC'));
	const foldedLegacyActual = foldMentionName(normalizeLegacyMentionName(actualName));
	const foldedSafeActual = foldMentionName(normalizeMentionName(actualName));
	const foldedSafeMention = foldMentionName(normalizeMentionName(cleanedMention));

	if (foldedMention === foldedActual) return 4;
	if (foldedMention === foldedLegacyActual) return 3;
	if (foldedMention === foldedSafeActual) return 2;
	if (foldedSafeMention === foldedSafeActual) return 1;
	return 0;
}

/**
 * Check if a name matches a mention target (handles normalized names).
 *
 * @param mentionedName - The name from the @mention (may be hyphenated)
 * @param actualName - The actual session/participant name (may have spaces)
 * @returns True if they match
 */
export function mentionMatches(mentionedName: string, actualName: string): boolean {
	return getMentionMatchPriority(mentionedName, actualName) > 0;
}

export function findUniqueMentionMatch<T>(
	mentionedName: string,
	items: readonly T[],
	getName: (item: T) => string
): T | undefined {
	let bestPriority = 0;
	let bestMatches: T[] = [];

	for (const item of items) {
		const priority = getMentionMatchPriority(mentionedName, getName(item));
		if (priority === 0) continue;

		if (priority > bestPriority) {
			bestPriority = priority;
			bestMatches = [item];
			continue;
		}

		if (priority === bestPriority) {
			bestMatches.push(item);
		}
	}

	return bestMatches.length === 1 ? bestMatches[0] : undefined;
}

/**
 * Pick the highest-fidelity @mention alias that resolves *uniquely back to this
 * exact name* among the given peers. Normalized collisions (e.g. "Review Bot
 * [Linux]" vs "Review Bot (Linux)", which both safe-normalize to
 * "Review-Bot-Linux") would otherwise advertise an ambiguous alias that
 * findUniqueMentionMatch refuses to route. Falls back to the safe name when no
 * single-token alias disambiguates, so the mention safely no-ops instead of
 * targeting the wrong peer.
 */
export function getMentionNameForContext(name: string, peerNames: readonly string[]): string {
	const candidates = [normalizeMentionName(name), normalizeLegacyMentionName(name)];
	for (const candidate of candidates) {
		if (!candidate) continue;
		if (findUniqueMentionMatch(candidate, peerNames, (peer) => peer) === name) {
			return candidate;
		}
	}
	return normalizeMentionName(name);
}

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

/** Stable serialized identity for a group-chat participant. */
export interface GroupChatParticipantBase {
	name: string;
	agentId: string;
	/** Internal process session ID used for routing. */
	sessionId: string;
	addedAt: number;
}

/** Persisted participant status and presentation metadata. */
export interface GroupChatParticipantStatus {
	/** Agent's session ID (e.g., Claude Code's session GUID for continuity). */
	agentSessionId?: string;
	lastActivity?: number;
	lastSummary?: string;
	contextUsage?: number;
	color?: string;
	tokenCount?: number;
	messageCount?: number;
	processingTimeMs?: number;
	totalCost?: number;
	sshRemoteName?: string;
}

/** Serializable participant record used by storage and the renderer. */
export interface GroupChatParticipant
	extends GroupChatParticipantBase, GroupChatParticipantStatus {}

/**
 * Custom configuration for an agent (moderator)
 */
export interface ModeratorConfig {
	/** Custom path to the agent binary */
	customPath?: string;
	/** Custom CLI arguments */
	customArgs?: string;
	/** Custom environment variables */
	customEnvVars?: Record<string, string>;
	/** Custom model selection (e.g., 'ollama/qwen3:8b') */
	customModel?: string;
	/** SSH remote config for remote execution */
	sshRemoteConfig?: {
		enabled: boolean;
		remoteId: string | null;
		workingDirOverride?: string;
	};
	/** Claude token-source opt-in (Claude Code moderator only). See getClaudeTokenMode. */
	enableMaestroP?: boolean;
	/** Refines enableMaestroP: 'interactive' (always TUI) vs 'dynamic' (auto-switch). */
	maestroPMode?: 'interactive' | 'dynamic';
	/** Optional maestro-p script override. */
	maestroPPath?: string;
}

/** Stable serialized group-chat metadata shared by storage and UI. */
export interface GroupChatBase {
	id: string;
	name: string;
	createdAt: number;
	moderatorAgentId: string;
	/** Internal session ID prefix used for routing. */
	moderatorSessionId: string;
	participants: GroupChatParticipant[];
}

/** Fields owned by group-chat metadata storage. */
export interface GroupChatStorageFields {
	updatedAt?: number;
	/** Claude Code agent session UUID (set after first message is processed). */
	moderatorAgentSessionId?: string;
	moderatorConfig?: ModeratorConfig;
	logPath: string;
	imagesDir: string;
	archived?: boolean;
}

/** UI-only, non-persisted group-chat fields. */
export interface GroupChatUiFields {
	draftMessage?: string;
}

/** Group-chat model composed from stable, storage, and UI concerns. */
export interface GroupChat extends GroupChatBase, GroupChatStorageFields, GroupChatUiFields {}

/** Stable line payload persisted in the group-chat log. */
export interface GroupChatLogMessage {
	timestamp: string;
	from: string;
	content: string;
}

/** Parsed log payload augmented for UI display. */
export interface GroupChatMessage extends GroupChatLogMessage {
	readOnly?: boolean;
	/** Base64 data URLs of images attached to this message. */
	images?: string[];
}

/**
 * Group chat state for UI display
 */
export type GroupChatState = 'idle' | 'moderator-thinking' | 'agent-working';

/**
 * Type of history entry in a group chat
 */
export type GroupChatHistoryEntryType = 'delegation' | 'response' | 'synthesis' | 'error';

/**
 * History entry for group chat activity tracking.
 * Stored in JSONL format in the group chat directory.
 */
export interface GroupChatHistoryEntry {
	/** Unique identifier for the entry */
	id: string;
	/** Timestamp when this entry was created */
	timestamp: number;
	/** One-sentence summary of what was accomplished */
	summary: string;
	/** Name of the participant who did the work (or 'Moderator' for synthesis) */
	participantName: string;
	/** Color assigned to this participant (for visualization) */
	participantColor: string;
	/** Type of activity */
	type: GroupChatHistoryEntryType;
	/** Time taken to complete the task (ms) */
	elapsedTimeMs?: number;
	/** Token count for this activity */
	tokenCount?: number;
	/** Cost in USD for this activity */
	cost?: number;
	/** Full response text (optional, for detail view) */
	fullResponse?: string;
}
