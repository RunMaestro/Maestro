import { useCallback, useMemo } from 'react';
import type { Session, Group, ToolType } from '../../types';
import {
	normalizeMentionName,
	getMentionNameForContext,
	formatGroupMentionExpansion,
} from '../../utils/participantColors';
import { fuzzyMatchWithScore } from '../../utils/search';
import { parseAgentMentions } from '../../../shared/crossAgentContext';

/**
 * A single agent- or group-mention row for the unified `@` picker.
 *
 * The picker uses one `@` trigger for everything, and the inserted token is a
 * single-`@` bare name (`@name `). Files and agents are told apart by SHAPE, not
 * a double-at prefix: a file body has a slash or dotted extension (`@src/x`,
 * `@a.md`) while an agent/group name is a bare word (`@codex`) that must resolve
 * against the live roster. Keep `value` exactly `@name ` (single-at, single
 * trailing space).
 */
export interface AgentMentionSuggestion {
	/**
	 * The `@name ` token this row is identified by (single-at prefix, trailing
	 * space). For agents it is also what gets inserted; for GROUPS the inserted
	 * literal is {@link memberMentionValue} instead - the group token only names
	 * the row (it is what the picker filters and sorts on) and never reaches the
	 * composer.
	 */
	value: string;
	/** Visible name for the row. */
	displayText: string;
	/** Discriminates agent rows from group rows. */
	kind: 'agent' | 'group';
	/** For agents: the target session id (used by later routing phases). */
	targetSessionId?: string;
	/** For groups: the group id. */
	groupId?: string;
	/**
	 * For groups: the non-terminal member session ids. Display only - the picker
	 * row shows "N agents". Dispatch never reads this: a group is expanded into
	 * member `@name` tokens at accept time, and only agents are message targets.
	 */
	memberSessionIds?: string[];
	/**
	 * For groups: the literal accepting the row inserts - every member's own
	 * `@name` token, space-separated (see `formatGroupMentionExpansion`). A group
	 * is shorthand for its members, not a target, so the picker expands it the
	 * same way Group Chat does and the composer never carries a group token.
	 * Expansion is the ONLY way a group reaches a message - a group name is not
	 * dispatchable (see {@link resolveMentionedTargetSessionIds}).
	 */
	memberMentionValue?: string;
	/** For agents: the tool type, used to pick the row icon. */
	toolType?: ToolType;
	/**
	 * For agents: true when the target runs on an SSH remote rather than this
	 * machine. Drives the picker's SSH pill so the sender can tell where the
	 * message is about to land. Absent/false means local.
	 */
	isSshRemote?: boolean;
	/**
	 * For SSH agents: the remote's config id. The picker resolves it to a display
	 * name (see `useSshRemoteNames`); ids are carried instead of names so this
	 * builder stays pure and synchronous.
	 */
	sshRemoteId?: string | null;
	/** Relevance score for sorting (higher is better). */
	score: number;
}

export interface UseAgentMentionCompletionReturn {
	getSuggestions: (filter: string) => AgentMentionSuggestion[];
}

/**
 * PERF/UX: cap results to match the file hook so the unified picker never grows
 * an unbounded row list.
 */
const MAX_SUGGESTION_RESULTS = 15;

/**
 * Build the full set of mentionable agent/group rows for the `@` picker.
 *
 * Pure (no React) so both {@link useAgentMentionCompletion} and the cross-agent
 * send-path resolver ({@link resolveMentionedTargetSessionIds}) share one source
 * of truth for how a `@name` token maps back to a session.
 *
 * @param sessions - All agents (sessions). Terminal-only agents are excluded.
 * @param groups - Session groups. Groups with no non-terminal members are skipped.
 * @param currentSessionId - The mentioning agent; excluded (can't mention itself).
 */
export function buildAgentMentionSuggestions(
	sessions: Session[],
	groups: Group[] | undefined,
	currentSessionId: string | null | undefined
): AgentMentionSuggestion[] {
	const mentionable = sessions.filter(
		(s) => s.toolType !== 'terminal' && s.id !== currentSessionId
	);
	const peerNames = mentionable.map((s) => s.name);

	const result: AgentMentionSuggestion[] = [];

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
 * Matches how {@link parseAgentMentions} reports `mentionName`, folded to lower
 * case so `@Review-Bot` resolves the same as `@review-bot`.
 */
function suggestionToken(suggestion: AgentMentionSuggestion): string {
	return suggestion.value.replace(/^@/, '').trimEnd().toLowerCase();
}

/**
 * The lowercased set of AGENT mention tokens currently mentionable from
 * `currentSessionId`. The chip overlay and the rendered transcript plugin pass
 * this to `tokenizeMentions` so a bare `@word` only lights up when it names a
 * real agent; a `@word` that matches nothing stays plain text.
 *
 * Group names are deliberately NOT in here. A group is not a message target
 * (see {@link resolveMentionedTargetSessionIds}), so chipping `@Squad` would
 * promise a dispatch that never happens - and worse, it would make a message
 * LEADING with a group name suppress the local send, addressing the message to
 * nobody at all.
 */
export function buildKnownMentionNameSet(
	sessions: Session[],
	groups: Group[] | undefined,
	currentSessionId: string | null | undefined
): Set<string> {
	return new Set(
		buildAgentMentionSuggestions(sessions, groups, currentSessionId)
			.filter((item) => item.kind === 'agent')
			.map(suggestionToken)
	);
}

/**
 * Resolve every `@mention` in a message to the target session ids it should
 * dispatch to. The result is de-duped in first-seen order.
 *
 * ONLY AGENTS ARE TARGETS. A group is shorthand the picker expands into its
 * members' own `@name` tokens at accept time (`memberMentionValue`), so the sent
 * text names agents and nothing else - which is exactly why a group must not
 * resolve here too. Routing a hand-typed `@name` to a group is how an agent that
 * merely SHARES a name with a group had its message fanned out to every member
 * of that group instead: the user picked the agent they could see, and the
 * message went to five agents. Since groups are built first, a group would have
 * won that name every time.
 *
 * A group name that survives into the sent text therefore resolves to nothing
 * and stays plain text, like any other unrecognized `@word`.
 *
 * Used by the cross-agent send path (Phase 03) so a manually typed `@name`
 * resolves identically to one picked from the popover.
 */
export function resolveMentionedTargetSessionIds(
	message: string,
	sessions: Session[],
	groups: Group[] | undefined,
	currentSessionId: string | null | undefined
): string[] {
	// Fast path: no `@` at all -> nothing to resolve, skip building the roster.
	if (!message.includes('@')) return [];

	const byToken = new Map<string, AgentMentionSuggestion>();
	for (const item of buildAgentMentionSuggestions(sessions, groups, currentSessionId)) {
		if (item.kind !== 'agent') continue; // Groups are not targets - see above.
		const token = suggestionToken(item);
		if (!byToken.has(token)) byToken.set(token, item);
	}

	// Pass the roster (the token keys) so a file-shaped agent name like
	// `@RunMaestro.ai` parses as an agent mention instead of being dropped as a
	// file. Without it, the dot classifies the body as a path and the mention is
	// silently lost.
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

/**
 * Agents/Groups data source for the unified `@` mention picker.
 *
 * Mirrors the API surface of {@link useAtMentionCompletion} (a stable
 * `getSuggestions(filter)`) so the two compose cleanly inside
 * {@link useMentionPicker}. Reuses the group-chat mention-name normalization and
 * the shared fuzzy matcher so ranking stays consistent with file mentions.
 *
 * @param sessions - All agents (sessions). Terminal-only agents are excluded.
 * @param groups - Session groups. Groups with no non-terminal members are skipped.
 * @param currentSessionId - The agent doing the mentioning; excluded (an agent
 *   can't mention itself).
 */
export function useAgentMentionCompletion(
	sessions: Session[],
	groups: Group[] | undefined,
	currentSessionId: string | null | undefined
): UseAgentMentionCompletionReturn {
	// Build the mentionable set once per sessions/groups change (see
	// buildAgentMentionSuggestions for the ordering rationale).
	const items = useMemo<AgentMentionSuggestion[]>(
		() => buildAgentMentionSuggestions(sessions, groups, currentSessionId),
		[sessions, groups, currentSessionId]
	);

	const getSuggestions = useCallback(
		(filter: string): AgentMentionSuggestion[] => {
			if (items.length === 0) return [];

			let scored: AgentMentionSuggestion[];
			if (!filter) {
				// No filter (user just typed `@`): everything is eligible at score 0.
				scored = items.map((it) => ({ ...it }));
			} else {
				scored = [];
				for (const item of items) {
					// Match against both the visible name and the normalized token
					// (minus the `@` prefix / trailing space) so hyphenated aliases hit.
					const token = item.value.replace(/^@/, '').trimEnd();
					const nameMatch = fuzzyMatchWithScore(item.displayText, filter);
					const tokenMatch = fuzzyMatchWithScore(token, filter);
					const best = nameMatch.score > tokenMatch.score ? nameMatch : tokenMatch;
					if (best.matches) {
						scored.push({ ...item, score: best.score });
					}
				}
			}

			// Sort by score (highest first); groups above agents on tie, then alpha.
			scored.sort((a, b) => {
				if (b.score !== a.score) return b.score - a.score;
				if (a.kind !== b.kind) return a.kind === 'group' ? -1 : 1;
				return a.displayText.localeCompare(b.displayText);
			});

			return scored.slice(0, MAX_SUGGESTION_RESULTS);
		},
		[items]
	);

	return { getSuggestions };
}
