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

/**
 * The literal a group row inserts when it is accepted in an `@` picker: every
 * member's own `@name` token, space-separated, with a trailing space.
 *
 * A group is shorthand for the agents inside it, never a message target of its
 * own, so accepting one EXPANDS it instead of leaving a `@group` token in the
 * composer. That is what keeps "is this a group or an agent?" from ever
 * mattering downstream - the sent text only ever names agents. Group Chat, the
 * Prompt Composer, and the standard AI chat picker all insert through here so
 * the three cannot drift on the expansion.
 *
 * @param memberNames - Names of the group's mentionable members.
 * @param peerNames - Every mentionable name in the same context, so each member
 *   gets the alias that resolves uniquely back to it.
 */
export function formatGroupMentionExpansion(
	memberNames: readonly string[],
	peerNames: readonly string[]
): string {
	if (memberNames.length === 0) return '';
	return memberNames.map((name) => `@${getMentionNameForContext(name, peerNames)}`).join(' ') + ' ';
}

/**
 * Strips leading/trailing markdown formatting characters from a mention name.
 * AI moderators often wrap mentions in bold/italic/code/strikethrough markdown
 * (e.g. `**@name**`, `_@name_`, `` `@name` ``), which leaves formatting chars
 * attached to the extracted name and breaks participant matching.
 */
export function stripMarkdownFormatting(name: string): string {
	return cleanMentionName(name);
}

/** One way to read a raw `@token`: the name, and where it ends in the token. */
interface MentionReading {
	name: string;
	end: number;
}

/**
 * Every way to read a raw `@token` that holds colons, longest first: the whole
 * token, then the token cut at each colon from the right. A colon is both a
 * legal name character (`CyberForce: Isabelle Quinn` normalizes to
 * `CyberForce:-Isabelle-Quinn`) and a separator (`@Agent:plan.md`, `@Agent: hi`),
 * so only a known name can say which reading is meant.
 */
function colonReadings(rawToken: string): MentionReading[] {
	const readings: MentionReading[] = [];
	let end = rawToken.length;
	while (end > 0) {
		const name = stripMarkdownFormatting(rawToken.slice(0, end));
		if (name && !readings.some((r) => r.name === name)) readings.push({ name, end });
		end = rawToken.lastIndexOf(':', end - 1);
	}
	return readings;
}

/**
 * Resolve one raw `@token` to the mention it stands for.
 *
 * With `knownNames`, the longest colon reading that matches a known name wins.
 * Without them, or when nothing matches, the token is cut at its first colon,
 * which is how mentions were read before colon names were supported.
 * `fullWhenUnmatched` returns the whole token instead in the no-match case, so
 * a warning can name what the user actually typed.
 */
function resolveMentionToken(
	rawToken: string,
	knownNames: readonly string[] | undefined,
	fullWhenUnmatched = false
): MentionReading | undefined {
	const readings = colonReadings(rawToken);
	if (readings.length === 0) return undefined;
	if (knownNames && knownNames.length > 0) {
		const matched = readings.find((reading) =>
			knownNames.some((known) => mentionMatches(reading.name, known))
		);
		if (matched) return matched;
		if (fullWhenUnmatched) return readings[0];
	}
	return readings[readings.length - 1];
}

/**
 * The raw `@token`s in a text. The pattern captures characters after @
 * excluding whitespace, @, and the punctuation that typically follows a mention
 * (,;!?'"<>). Colons are kept and resolved later (see `colonReadings`).
 */
function scanMentionTokens(text: string): Array<{ raw: string; index: number }> {
	const tokens: Array<{ raw: string; index: number }> = [];
	const mentionPattern = /@([^\s@,;!?'"<>]+)/g;
	let match;
	while ((match = mentionPattern.exec(text)) !== null) {
		tokens.push({ raw: match[1], index: match.index });
	}
	return tokens;
}

/**
 * Extracts ALL @mentions from text (regardless of whether they're participants).
 * Handles markdown-formatted mentions (e.g. **@name**, _@name_).
 *
 * Names with emojis, Unicode, dots, hyphens, underscores, colons, and the
 * bracket punctuation of legacy normalized display names survive:
 * @RunMaestro.ai, @my-agent, @CIA-Agent-(Super-Cool), @日本語,
 * @Tome:-RSSidian.
 *
 * Pass `knownNames` (participant and agent names) so a colon inside a name is
 * kept only when it produces a real name. Without them a mention ends at its
 * first colon, so `@Agent:plan.md` and `@Agent: hi` both read as `Agent`.
 *
 * @param text - The text to search for mentions
 * @param knownNames - Names a mention may resolve to
 * @returns Array of unique names that were mentioned (without @ prefix)
 */
export function extractAllMentions(text: string, knownNames?: readonly string[]): string[] {
	const mentions: string[] = [];
	for (const { raw } of scanMentionTokens(text)) {
		const name = resolveMentionToken(raw, knownNames)?.name;
		if (name && !mentions.includes(name)) mentions.push(name);
	}
	return mentions;
}

/**
 * The @mentions in a text that match none of `knownNames`, as the user typed
 * them, so the chat can say so instead of dropping them silently.
 *
 * Only standalone mentions count. A token glued to a preceding letter, digit,
 * dot or underscore is an email address (`me@example.com`), and a token with a
 * slash is a package scope or path (`@types/node`); neither is meant as a
 * mention.
 */
export function findUnmatchedMentions(text: string, knownNames: readonly string[]): string[] {
	const unmatched: string[] = [];
	for (const { raw, index } of scanMentionTokens(text)) {
		if (index > 0 && /[\p{L}\p{N}_.]/u.test(text[index - 1])) continue;
		if (raw.includes('/')) continue;
		const name = resolveMentionToken(raw, knownNames, true)?.name;
		if (!name) continue;
		if (knownNames.some((known) => mentionMatches(name, known))) continue;
		if (!unmatched.includes(name)) unmatched.push(name);
	}
	return unmatched;
}

/**
 * Split the `@Agent` or `@Agent:file.md` target of an `!autorun` directive.
 *
 * With `knownNames`, the longest colon reading that is a known name is the
 * agent and the rest is the file, so `@Tome:-RSSidian:plan.md` targets
 * `Tome:-RSSidian`. Without them, or when nothing matches, the first colon
 * splits name from file.
 */
export function splitAutoRunTarget(
	rawTarget: string,
	knownNames?: readonly string[]
): { name: string; filename?: string } | undefined {
	const reading = resolveMentionToken(rawTarget, knownNames);
	if (!reading) return undefined;
	const rest = rawTarget[reading.end] === ':' ? rawTarget.slice(reading.end + 1) : '';
	const filename = stripUnmatchedTrailingClosers(rest) || undefined;
	return { name: reading.name, filename };
}

/** True when `text` is a full agent GUID, e.g. `8dac9050-cc32-4bfa-a0e3-33bd62d8a503`. */
export function isAgentGuid(text: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text);
}

/**
 * The agent a mention names when the mention is that agent's full GUID
 * (`@8dac9050-...`), so a script can address an agent that has since been
 * renamed. Only a full GUID counts: a prefix in prose could be any word.
 */
export function findAgentByGuidMention<T extends { id: string }>(
	mentionedName: string,
	agents: readonly T[]
): T | undefined {
	const cleaned = cleanMentionName(mentionedName);
	if (!isAgentGuid(cleaned)) return undefined;
	const lower = cleaned.toLowerCase();
	return agents.find((agent) => agent.id.toLowerCase() === lower);
}

/**
 * Conservative name match from a persisted participant name to the agent it
 * came from: exact (4), legacy (3) or safe-normalized (2) matches only, and no
 * pick on a tie. Priority-1 ("safe folded") matches collapse bracket styles
 * ("Review Bot [Linux]" vs "Review Bot (Linux)") and could borrow the wrong
 * agent's cwd, SSH config or settings.
 */
export function findAgentForParticipantName<T extends { name: string }>(
	participantName: string,
	agents: readonly T[]
): T | undefined {
	let bestPriority = 0;
	let bestMatches: T[] = [];
	for (const agent of agents) {
		const priority = getMentionMatchPriority(participantName, agent.name);
		if (priority < 2) continue;
		if (priority > bestPriority) {
			bestPriority = priority;
			bestMatches = [agent];
		} else if (priority === bestPriority) {
			bestMatches.push(agent);
		}
	}
	return bestMatches.length === 1 ? bestMatches[0] : undefined;
}

/**
 * The Maestro agent a participant was added from. By `sourceSessionId` when
 * the participant has one, so a renamed agent stays linked and a deleted one
 * resolves to nothing (never to a newer agent that took its name). Chats
 * saved before the field existed fall back to a conservative name match.
 */
export function findParticipantSourceAgent<T extends { id: string; name: string }>(
	participant: { name: string; sourceSessionId?: string },
	agents: readonly T[]
): T | undefined {
	if (participant.sourceSessionId) {
		return agents.find((agent) => agent.id === participant.sourceSessionId);
	}
	return findAgentForParticipantName(participant.name, agents);
}

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

/**
 * Group chat participant
 */
export interface GroupChatParticipant {
	name: string;
	/** Provider type (e.g. `claude-code`), NOT the Maestro agent. See `sourceSessionId`. */
	agentId: string;
	/**
	 * GUID of the Maestro agent (`Session.id`) this participant was added from.
	 * It is the participant's link back to that agent's cwd, SSH config and
	 * settings, so the link survives a rename. Chats saved before this field
	 * existed have none; the router backfills it by name (see
	 * `findParticipantSourceAgent`).
	 */
	sourceSessionId?: string;
	/** Internal process session ID (used for routing) */
	sessionId: string;
	/** Agent's session ID (e.g., Claude Code's session GUID for continuity) */
	agentSessionId?: string;
	addedAt: number;
	lastActivity?: number;
	lastSummary?: string;
	contextUsage?: number;
	// Color for this participant (assigned on join)
	color?: string;
	// Stats tracking
	tokenCount?: number;
	messageCount?: number;
	processingTimeMs?: number;
	/** Total cost in USD (optional, depends on provider) */
	totalCost?: number;
	/** SSH remote name (displayed as pill when running on SSH remote) */
	sshRemoteName?: string;
}

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
	/** Env vars switched off in the editor: parked, never passed to the moderator. */
	customEnvVarsDisabled?: Record<string, string>;
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

/**
 * Group chat metadata
 */
export interface GroupChat {
	id: string;
	name: string;
	createdAt: number;
	updatedAt?: number;
	moderatorAgentId: string;
	/** Internal session ID prefix used for routing (e.g., 'group-chat-{id}-moderator') */
	moderatorSessionId: string;
	/** Claude Code agent session UUID (set after first message is processed) */
	moderatorAgentSessionId?: string;
	/** Custom configuration for the moderator agent */
	moderatorConfig?: ModeratorConfig;
	participants: GroupChatParticipant[];
	logPath: string;
	imagesDir: string;
	draftMessage?: string;
	archived?: boolean;
	/**
	 * When true (the default), the moderator only hands work to an agent whose
	 * Maestro agent is idle, holding the handoff until it is rather than
	 * starting a second process there. Undefined means enabled - read it through
	 * {@link requiresIdleParticipants} rather than testing the field, so chats
	 * created before this setting existed keep the safe behavior.
	 */
	requireIdleParticipants?: boolean;
}

/**
 * Whether a group chat may only engage agents that are currently free.
 *
 * The default is ON and lives here rather than at each read site: the router,
 * the create/edit modal, and the info overlay all have to agree, and a missing
 * field must never read as "opted out".
 */
export function requiresIdleParticipants(
	chat: { requireIdleParticipants?: boolean } | null | undefined
): boolean {
	return chat?.requireIdleParticipants !== false;
}

/**
 * Group chat message entry from the chat log
 */
export interface GroupChatMessage {
	timestamp: string;
	from: string;
	content: string;
	readOnly?: boolean;
	/** Base64 data URLs of images attached to this message */
	images?: string[];
}

/**
 * Group chat state for UI display
 */
export type GroupChatState = 'idle' | 'moderator-thinking' | 'agent-working';

/**
 * Name stamped on the conductor's own history entries. Shared so the main
 * process writes exactly what the renderer colors and filters on.
 */
export const GROUP_CHAT_USER_NAME = 'You';

/**
 * Type of history entry in a group chat
 */
// 'user' is the conductor's own message into the room. It carries no cost or
// duration, but without it the history reads as agent chatter with no visible
// cause - the prompt that started each round is the anchor a reader needs.
export type GroupChatHistoryEntryType = 'user' | 'delegation' | 'response' | 'synthesis' | 'error';

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

/**
 * One message waiting to be delivered to a group chat's moderator.
 *
 * Structurally a narrowed `QueuedItem` (the renderer type in
 * `src/renderer/types/index.ts`), carrying only the fields a group chat send
 * actually uses. It lives here rather than there because the QUEUE IS OWNED BY
 * MAIN: the renderer copy was per-client, so a message queued on a phone was
 * invisible to the desktop and died with the tab that held it. Main cannot
 * import a renderer module, so the shape has to be shared.
 *
 * `failed` is set when a send attempt threw. The item is KEPT rather than
 * dropped - a queue that silently discards what the user typed is the failure
 * this whole change exists to end - and the chat is paused so the same failure
 * is not retried on every subsequent idle.
 */
export interface GroupChatQueuedItem {
	id: string;
	timestamp: number;
	text: string;
	images?: string[];
	readOnlyMode?: boolean;
	failed?: boolean;
	failureReason?: string;
	/**
	 * Handed to the moderator and not yet confirmed.
	 *
	 * Broadcast so clients can show it, and checked so remove and reorder refuse
	 * to touch it: an item the moderator already has cannot be un-sent, and
	 * letting it be deleted mid-flight is how the completion lands on whatever
	 * item happened to be first instead.
	 */
	sending?: boolean;
}

/**
 * A group chat's pending sends, as main holds and broadcasts them.
 *
 * `paused` is deliberately part of the persisted state rather than a runtime
 * flag. It is set by Stop All (nobody presses that expecting the room to start
 * itself again), by a failed send, and by main loading a non-empty queue at
 * startup (launching the app must not spawn a moderator just to flush a queue
 * from a previous session). Each of those must survive a restart, or the very
 * next idle would undo the pause.
 */
export interface GroupChatQueueState {
	items: GroupChatQueuedItem[];
	paused: boolean;
}
