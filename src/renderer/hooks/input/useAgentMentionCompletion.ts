import { useCallback, useMemo } from 'react';
import type { Session, Group, ToolType } from '../../types';
import {
	buildAgentMentionSuggestions,
	buildKnownMentionNameSet,
	filterAgentMentionSuggestions,
	resolveMentionedTargetSessionIds,
	type AgentMentionSuggestion as LibAgentMentionSuggestion,
} from '../../../shared/maestro-lib/mentions/roster';

// The roster rules (who is mentionable, what a name resolves to, how a filter
// ranks) moved to maestro-lib so the TUI composer reads the same ones. They are
// re-exported here so renderer import sites keep working.
export { buildAgentMentionSuggestions, buildKnownMentionNameSet, resolveMentionedTargetSessionIds };

/** A picker row for a renderer agent: the library's row, typed with the renderer's provider union. */
export type AgentMentionSuggestion = LibAgentMentionSuggestion<ToolType>;

export interface UseAgentMentionCompletionReturn {
	getSuggestions: (filter: string) => AgentMentionSuggestion[];
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
		(filter: string): AgentMentionSuggestion[] => filterAgentMentionSuggestions(items, filter),
		[items]
	);

	return { getSuggestions };
}
