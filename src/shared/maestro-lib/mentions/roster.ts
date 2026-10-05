/**
 * Cross-agent `@mentions`, the pure half: who a message can mention, which
 * agents a message names, and what to do with it.
 *
 * The desktop composer and the TUI composer both read this, so a name the picker
 * inserts is a name dispatch resolves, and a message leading with `@agent`
 * suppresses the local send the same way on both. The renderer's
 * `useAgentMentionCompletion` and `crossAgentMentions` re-export from here; what
 * stays there is what needs the store, React, or the consult transport.
 *
 * The roster is structural (`MentionableAgent`, `MentionableGroup`) so a
 * renderer `Session`, a TUI `AgentRecord`, and a test literal all satisfy it
 * without this module naming either one.
 *
 * Pure: no IO, no clock, no globals beyond one memo cache.
 */

import {
	formatGroupMentionExpansion,
	getMentionNameForContext,
	normalizeMentionName,
} from '../../group-chat-types';
import { messageStartsWithAgentMention, parseAgentMentions } from '../../crossAgentContext';
import { fuzzyMatchWithScore } from '../../fuzzyMatch';
import { scanMentionSpans } from '../../mentionPatterns';
import type { AgentRecord, GroupRecord } from '../store/records';

/** What the roster reads off an agent. A renderer `Session` satisfies it as is. */
export interface MentionableAgent<T extends string = string> {
	id: string;
	name: string;
	toolType: T;
	groupId?: string;
	sessionSshRemoteConfig?: { enabled?: boolean; remoteId?: string | null } | null;
}

/** What the roster reads off a group. */
export interface MentionableGroup {
	id: string;
	name: string;
}

/**
 * A single agent- or group-mention row for the `@` picker.
 *
 * The inserted token is a single-`@` bare name (`@name `). Keep `value` exactly
 * that: one `@`, one trailing space.
 */
export interface AgentMentionSuggestion<T extends string = string> {
	/**
	 * The `@name ` token this row is identified by. For agents it is also what
	 * gets inserted; for GROUPS the inserted literal is {@link memberMentionValue}
	 * instead - the group token only names the row and never reaches the composer.
	 */
	value: string;
	/** Visible name for the row. */
	displayText: string;
	kind: 'agent' | 'group';
	/** For agents: the target agent id. */
	targetSessionId?: string;
	/** For groups: the group id. */
	groupId?: string;
	/** For groups: the non-terminal member ids. Display only. */
	memberSessionIds?: string[];
	/**
	 * For groups: the literal accepting the row inserts, every member's own
	 * `@name` token. A group is shorthand for its members, never a target, so the
	 * picker expands it at accept time and the composer never carries a group token.
	 */
	memberMentionValue?: string;
	/** For agents: the provider, used to pick the row icon. */
	toolType?: T;
	/** For agents: true when the target runs on an SSH remote. */
	isSshRemote?: boolean;
	/** For SSH agents: the remote's config id. */
	sshRemoteId?: string | null;
	/** Relevance score for sorting (higher is better). */
	score: number;
}

/** Cap results so a picker never grows an unbounded row list. */
export const MAX_SUGGESTION_RESULTS = 15;

/**
 * Every mentionable agent/group row for the `@` picker. Terminal-only agents are
 * excluded, groups with no members are skipped, and `currentSessionId` (the
 * mentioning agent) never appears: an agent cannot mention itself.
 */
export function buildAgentMentionSuggestions<T extends string>(
	agents: readonly MentionableAgent<T>[],
	groups: readonly MentionableGroup[] | undefined,
	currentSessionId: string | null | undefined
): AgentMentionSuggestion<T>[] {
	const mentionable = agents.filter((s) => s.toolType !== 'terminal' && s.id !== currentSessionId);
	const peerNames = mentionable.map((s) => s.name);

	const result: AgentMentionSuggestion<T>[] = [];

	// Groups first so that, on a score tie, groups sort above agents.
	if (groups) {
		for (const group of groups) {
			const members = mentionable.filter((s) => s.groupId === group.id);
			if (members.length === 0) continue;
			result.push({
				value: `@${normalizeMentionName(group.name)} `,
				displayText: group.name,
				kind: 'group',
				groupId: group.id,
				memberSessionIds: members.map((m) => m.id),
				// Built from the same peer roster the agent rows below use, so an
				// expanded member token is byte-identical to picking that agent.
				memberMentionValue: formatGroupMentionExpansion(
					members.map((m) => m.name),
					peerNames
				),
				score: 0,
			});
		}
	}

	for (const s of mentionable) {
		result.push({
			value: `@${getMentionNameForContext(s.name, peerNames)} `,
			displayText: s.name,
			kind: 'agent',
			targetSessionId: s.id,
			toolType: s.toolType,
			isSshRemote: Boolean(s.sessionSshRemoteConfig?.enabled),
			sshRemoteId: s.sessionSshRemoteConfig?.remoteId ?? null,
			score: 0,
		});
	}

	return result;
}

/**
 * The normalized token (`@name ` -> `name`, lowercased) a suggestion inserts.
 * Matches how `parseAgentMentions` reports `mentionName`, folded to lower case
 * so `@Review-Bot` resolves the same as `@review-bot`.
 */
function suggestionToken(suggestion: AgentMentionSuggestion): string {
	return suggestion.value.replace(/^@/, '').trimEnd().toLowerCase();
}

/**
 * The picker's rows for what the person has typed after the `@`: fuzzy matched
 * against the visible name and the inserted token, best first, groups above
 * agents on a tie, then alphabetical. An empty filter lists everything.
 */
export function filterAgentMentionSuggestions<T extends string>(
	items: readonly AgentMentionSuggestion<T>[],
	filter: string
): AgentMentionSuggestion<T>[] {
	if (items.length === 0) return [];

	let scored: AgentMentionSuggestion<T>[];
	if (!filter) {
		// No filter (just typed `@`): everything is eligible at score 0.
		scored = items.map((it) => ({ ...it }));
	} else {
		scored = [];
		for (const item of items) {
			// Match against both the visible name and the normalized token (minus the
			// `@` prefix / trailing space) so hyphenated aliases hit.
			const token = item.value.replace(/^@/, '').trimEnd();
			const nameMatch = fuzzyMatchWithScore(item.displayText, filter);
			const tokenMatch = fuzzyMatchWithScore(token, filter);
			const best = nameMatch.score > tokenMatch.score ? nameMatch : tokenMatch;
			if (best.matches) scored.push({ ...item, score: best.score });
		}
	}

	scored.sort((a, b) => {
		if (b.score !== a.score) return b.score - a.score;
		if (a.kind !== b.kind) return a.kind === 'group' ? -1 : 1;
		return a.displayText.localeCompare(b.displayText);
	});

	return scored.slice(0, MAX_SUGGESTION_RESULTS);
}

/**
 * The lowercased set of AGENT mention tokens currently mentionable from
 * `currentSessionId`. Callers pass it to `tokenizeMentions` so a bare `@word`
 * only lights up when it names a real agent.
 *
 * Group names are deliberately NOT in here. A group is not a message target (see
 * {@link resolveMentionedTargetSessionIds}), so chipping `@Squad` would promise a
 * dispatch that never happens - and a message LEADING with a group name would
 * suppress the local send, addressing it to nobody.
 */
export function buildKnownMentionNameSet(
	agents: readonly MentionableAgent[],
	groups: readonly MentionableGroup[] | undefined,
	currentSessionId: string | null | undefined
): ReadonlySet<string> {
	const signature = mentionRosterSignature(agents, groups);
	if (signature !== knownMentionCacheSignature) {
		knownMentionCacheSignature = signature;
		knownMentionCache.clear();
	}

	const key = currentSessionId ?? '';
	const cached = knownMentionCache.get(key);
	if (cached) return cached;

	const built: ReadonlySet<string> = new Set(
		buildAgentMentionSuggestions(agents, groups, currentSessionId)
			.filter((item) => item.kind === 'agent')
			.map(suggestionToken)
	);
	knownMentionCache.set(key, built);
	return built;
}

/**
 * Cache for {@link buildKnownMentionNameSet}, keyed by the mentioning agent and
 * invalidated whenever {@link mentionRosterSignature} changes.
 *
 * The set costs O(agents^2) Unicode normalizations to build, and the rendered
 * transcript asks for it at the top of every markdown transform while an agent
 * streams, so it is paid once per roster change rather than once per call. Keyed
 * by `currentSessionId` because callers disagree about it and run in the same
 * frame (the transcript excludes nobody, a composer excludes its own agent); a
 * single entry would thrash. Bounded by the roster, since a change clears it.
 */
const knownMentionCache = new Map<string, ReadonlySet<string>>();
let knownMentionCacheSignature: string | null = null;

/**
 * An O(agents) fingerprint of everything the mention roster derives from.
 * Identity of the agents array is NOT usable: the renderer store replaces it on
 * every streaming flush. What the tokens depend on is each mentionable agent's
 * id and name (`toolType` decides who is mentionable at all).
 */
function mentionRosterSignature(
	agents: readonly MentionableAgent[],
	groups: readonly MentionableGroup[] | undefined
): string {
	// NUL and SOH separate the fields. A name is user-supplied and can contain any
	// printable character, so a printable delimiter could let two rosters collide.
	const parts: string[] = [];
	for (const s of agents) {
		if (s.toolType === 'terminal') continue;
		parts.push(s.id, '\u0000', s.name, '\u0001');
	}
	parts.push('\u0002');
	if (groups) {
		for (const g of groups) parts.push(g.id, '\u0000', g.name, '\u0001');
	}
	return parts.join('');
}

/**
 * Every `@mention` in a message as the target agent ids it dispatches to,
 * de-duped in first-seen order.
 *
 * ONLY AGENTS ARE TARGETS. A group is shorthand the picker expands into its
 * members' own `@name` tokens at accept time, so the sent text names agents and
 * nothing else. Routing a hand-typed `@name` to a group is how an agent that
 * merely SHARES a name with a group had its message fanned out to every member
 * of that group. A group name that survives into the sent text resolves to
 * nothing and stays plain text, like any other unrecognized `@word`.
 */
export function resolveMentionedTargetSessionIds(
	message: string,
	agents: readonly MentionableAgent[],
	groups: readonly MentionableGroup[] | undefined,
	currentSessionId: string | null | undefined
): string[] {
	// Fast path: no `@` at all -> nothing to resolve, skip building the roster.
	if (!message.includes('@')) return [];

	const byToken = new Map<string, AgentMentionSuggestion>();
	for (const item of buildAgentMentionSuggestions(agents, groups, currentSessionId)) {
		if (item.kind !== 'agent') continue; // Groups are not targets - see above.
		const token = suggestionToken(item);
		if (!byToken.has(token)) byToken.set(token, item);
	}

	// Pass the roster so a file-shaped agent name like `@RunMaestro.ai` parses as
	// an agent mention instead of being dropped as a file.
	const mentions = parseAgentMentions(message, new Set(byToken.keys()));
	if (mentions.length === 0) return [];

	const targetIds: string[] = [];
	const seen = new Set<string>();
	for (const mention of mentions) {
		const id = byToken.get(mention.mentionName.toLowerCase())?.targetSessionId;
		if (id && !seen.has(id)) {
			seen.add(id);
			targetIds.push(id);
		}
	}
	return targetIds;
}

/** What a message's `@mentions` resolve to, before anything is sent. */
export interface CrossAgentMentionPlan {
	/** The agents to consult, de-duped, self-mention filtered. Never empty. */
	targetAgentIds: string[];
	/**
	 * The message LEADS with an `@agent` mention, so it is addressed only at the
	 * consulted agent(s): the source agent must not be sent to at all.
	 */
	suppressLocal: boolean;
}

/**
 * Resolve the mentions in `message` without sending anything. `null` when the
 * message mentions no other agent, so "no plan" and "nothing to do" are one case.
 */
export function planMentions(
	message: string,
	agents: readonly MentionableAgent[],
	groups: readonly MentionableGroup[] | undefined,
	sourceAgentId: string
): CrossAgentMentionPlan | null {
	const targetAgentIds = resolveMentionedTargetSessionIds(
		message,
		agents,
		groups,
		sourceAgentId
	).filter((id) => id !== sourceAgentId); // Self-mention guard (defend at dispatch).
	if (targetAgentIds.length === 0) return null;

	// Roster for the leading-mention check, so a message that leads with a
	// file-shaped agent name (`@RunMaestro.ai fix this`) suppresses the local send
	// just like a bare `@Codex` does.
	const knownMentionNames = buildKnownMentionNameSet(agents, groups, sourceAgentId);
	return {
		targetAgentIds,
		suppressLocal: messageStartsWithAgentMention(message, knownMentionNames),
	};
}

/**
 * The message with each RESOLVED mention wrapped in quotes (`"@codex"`), the
 * form the scanner reads as literal text. A surface that consults the mentioned
 * agents itself sends the source agent this copy, so the desktop (which consults
 * any mention in a message it is handed) does not consult a second time.
 */
export function escapeResolvedMentions(
	message: string,
	agents: readonly MentionableAgent[],
	groups: readonly MentionableGroup[] | undefined,
	sourceAgentId: string
): string {
	const known = buildKnownMentionNameSet(agents, groups, sourceAgentId);
	let out = '';
	let cursor = 0;
	for (const span of scanMentionSpans(message, known)) {
		if (span.isFile || !span.isName || !known.has(span.body.toLowerCase())) continue;
		out += `${message.slice(cursor, span.start)}"${span.value}"`;
		cursor = span.end;
	}
	return out + message.slice(cursor);
}

/**
 * The question a consult carries: the message with its RESOLVED mention tokens
 * removed (`@Backend which branch?` asks "which branch?"). An unknown `@word`
 * stays, since it is part of what the person said.
 */
export function consultQuestionOf(
	message: string,
	agents: readonly MentionableAgent[],
	groups: readonly MentionableGroup[] | undefined,
	sourceAgentId: string
): string {
	const known = buildKnownMentionNameSet(agents, groups, sourceAgentId);
	let out = '';
	let cursor = 0;
	for (const span of scanMentionSpans(message, known)) {
		if (span.isFile || !span.isName || !known.has(span.body.toLowerCase())) continue;
		out += message.slice(cursor, span.start);
		cursor = span.end;
	}
	return (out + message.slice(cursor))
		.replace(/[ \t]+/g, ' ')
		.replace(/ ?\n ?/g, '\n')
		.trim();
}

/** The roster as the mention helpers read it, from the store records a library client holds. */
export function mentionableAgentsOf(agents: readonly AgentRecord[]): MentionableAgent[] {
	return agents.map((agent) => {
		const ssh = agent.sessionSshRemoteConfig;
		const config =
			ssh && typeof ssh === 'object'
				? {
						enabled: (ssh as { enabled?: unknown }).enabled === true,
						remoteId:
							typeof (ssh as { remoteId?: unknown }).remoteId === 'string'
								? (ssh as { remoteId: string }).remoteId
								: null,
					}
				: undefined;
		return {
			id: agent.id,
			name: agent.name,
			toolType: agent.toolType,
			groupId: agent.groupId,
			sessionSshRemoteConfig: config,
		};
	});
}

/** The groups as the mention helpers read them. */
export function mentionableGroupsOf(groups: readonly GroupRecord[]): MentionableGroup[] {
	return groups.map((group) => ({ id: group.id, name: group.name }));
}
