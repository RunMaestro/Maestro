import { useCallback, useMemo } from 'react';
import type { Session, Group, ToolType } from '../../types';
import { normalizeMentionName, getMentionNameForContext } from '../../utils/participantColors';
import { fuzzyMatchWithScore } from '../../utils/search';

/**
 * A single agent- or group-mention row for the unified `@` picker.
 *
 * The picker uses one `@` trigger for everything, but the *inserted token still
 * disambiguates*: agents and groups produce a double-at token (`@@name `) so the
 * later cross-agent-dispatch phases (parse/route/render) can tell an agent
 * mention apart from a plain `@file` mention. Keep `value` exactly `@@name `
 * (double-at, single trailing space).
 */
export interface AgentMentionSuggestion {
	/** The `@@name ` token to insert (double-at prefix, trailing space). */
	value: string;
	/** Visible name for the row. */
	displayText: string;
	/** Discriminates agent rows from group rows. */
	kind: 'agent' | 'group';
	/** For agents: the target session id (used by later routing phases). */
	targetSessionId?: string;
	/** For groups: the group id. */
	groupId?: string;
	/** For groups: the non-terminal member session ids (used by later routing). */
	memberSessionIds?: string[];
	/** For agents: the tool type, used to pick the row icon. */
	toolType?: ToolType;
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
	// Build the mentionable set once per sessions/groups change. Groups are added
	// before individual agents so that, on a score tie, groups sort above agents.
	const items = useMemo<AgentMentionSuggestion[]>(() => {
		const mentionable = sessions.filter(
			(s) => s.toolType !== 'terminal' && s.id !== currentSessionId
		);
		const peerNames = mentionable.map((s) => s.name);

		const result: AgentMentionSuggestion[] = [];

		if (groups) {
			for (const group of groups) {
				const members = mentionable.filter((s) => s.groupId === group.id);
				if (members.length === 0) continue;
				result.push({
					value: `@@${normalizeMentionName(group.name)} `,
					displayText: group.name,
					kind: 'group',
					groupId: group.id,
					memberSessionIds: members.map((m) => m.id),
					score: 0,
				});
			}
		}

		for (const s of mentionable) {
			result.push({
				value: `@@${getMentionNameForContext(s.name, peerNames)} `,
				displayText: s.name,
				kind: 'agent',
				targetSessionId: s.id,
				toolType: s.toolType,
				score: 0,
			});
		}

		return result;
	}, [sessions, groups, currentSessionId]);

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
					// (minus the `@@` prefix / trailing space) so hyphenated aliases hit.
					const token = item.value.replace(/^@@/, '').trimEnd();
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
