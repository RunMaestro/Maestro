/**
 * useComposerCompletions - the composer's completion lists: shell Tab
 * completion (the terminal composer, and the AI composer's command mode) and
 * the unified `@` picker (files, folders, agents, groups).
 *
 * Reads the dropdown state from `InputContext`, the live draft from
 * `composerInputStore`, and the active agent (file tree, cwd, history) from the
 * session store. Shared by the app window's composer (`useInputHandlers`) and a
 * tab window's, which holds its one agent as the store's active agent.
 *
 * PERF: every subscription is gated on its dropdown being open, so normal
 * typing and streaming flushes re-render nothing here.
 */

import { useMemo } from 'react';
import type { Group, Session } from '../../types';
import { useInputContext } from '../../contexts/InputContext';
import { useSessionStore } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useComposerInputStore } from '../../stores/composerInputStore';
import { filterSessionsVisibleInSidebar } from '../../utils/sessionVisibility';
import { useDebouncedValue } from '../utils';
import { useTabCompletion, type TabCompletionSuggestion } from './useTabCompletion';
import { useAtMentionCompletion } from './useAtMentionCompletion';
import { useMentionPicker, type MentionCategory, type MentionPickerItem } from './useMentionPicker';
import { stripMentionQuotes } from '../../../shared/mentionPatterns';

// Stable empty references so the gated sessions/groups selectors return the same
// value while the picker is closed (Object.is bails out of the re-render).
const EMPTY_SESSIONS: Session[] = [];
const EMPTY_GROUPS: Group[] = [];

export interface ComposerCompletions {
	/** Shell completions for the open Tab dropdown (empty while it is closed). */
	tabCompletionSuggestions: TabCompletionSuggestion[];
	/** Shell completions for an input, on demand (the Tab key). */
	getTabCompletionSuggestions: ReturnType<typeof useTabCompletion>['getSuggestions'];
	/** Rows of the open `@` picker for its current category. */
	atMentionItems: MentionPickerItem[];
	/** Row count per `@` picker category. */
	atMentionCounts: Record<MentionCategory, number>;
}

/**
 * @param activeSessionId - The agent the composer drafts for.
 * @param inputMode - Its input mode: the terminal composer completes its own
 *                    draft; the AI composer completes only in command mode, and
 *                    is the only one with an `@` picker.
 */
export function useComposerCompletions(
	activeSessionId: string,
	inputMode: Session['inputMode'] | undefined
): ComposerCompletions {
	const {
		tabCompletionOpen,
		tabCompletionFilter,
		atMentionOpen,
		atMentionFilter,
		atMentionCategory,
	} = useInputContext();

	// All agents + groups feed the Agents scope of the unified `@` picker. Gate
	// the subscription on atMentionOpen so streaming flushes from any agent don't
	// recompute mention suggestions while the picker is closed (mirrors the
	// fileSuggestions gate below). Stable empty refs avoid re-render churn.
	const allSessions = useSessionStore((s) => (atMentionOpen ? s.sessions : EMPTY_SESSIONS));
	// Mentionable agents follow the Left Bar: the Pianola agent outlives its
	// Encore flag in the session store and is not offered while the flag is off.
	const pianolaEnabled = useSettingsStore((s) => s.encoreFeatures?.pianola);
	const sessions = useMemo(
		() => filterSessionsVisibleInSidebar(allSessions, { pianolaEnabled }),
		[allSessions, pianolaEnabled]
	);
	const groups = useSessionStore((s) => (atMentionOpen ? s.groups : EMPTY_GROUPS));

	// Tab / @mention completion: no-arg form subscribes only to non-streaming fields
	const { getSuggestions: getTabCompletionSuggestions } = useTabCompletion();
	const { getSuggestions: getAtMentionSuggestions } = useAtMentionCompletion();

	// Gated store subscription: returns '' (a stable primitive) unless the
	// tab-completion dropdown is open, so zustand's Object.is bail-out means
	// normal typing does NOT re-render this hook. Only while the dropdown is
	// open do we track the live text to refresh suggestions.
	//
	// Reads the AI draft in AI mode: completion also serves command mode, where
	// the shell draft lives in `aiValue`, not `terminalValue`.
	const tabCompletionInput = useComposerInputStore((s) => {
		if (!tabCompletionOpen) return '';
		return inputMode === 'terminal' ? s.terminalValue : s.aiValue;
	});
	// Same gating trick for the mode flag: a stable `false` unless the dropdown
	// is open, so toggling command mode doesn't re-render this hook either. Only
	// the 'shell' rung completes - AI command mode's draft is prose.
	const tabCompletionCommandMode = useComposerInputStore((s) =>
		tabCompletionOpen ? s.aiCommandMode === 'shell' : false
	);
	const debouncedInputForTabCompletion = useDebouncedValue(tabCompletionInput, 50);
	const tabCompletionSuggestions = useMemo(() => {
		if (!tabCompletionOpen || !activeSessionId) return [];
		const isTerminal = inputMode === 'terminal';
		// AI mode only gets completions in command mode; an ordinary message has
		// nothing shell-shaped to complete against.
		if (!isTerminal && !tabCompletionCommandMode) return [];
		return getTabCompletionSuggestions(
			debouncedInputForTabCompletion,
			tabCompletionFilter,
			!isTerminal
		);
	}, [
		tabCompletionOpen,
		activeSessionId,
		inputMode,
		tabCompletionCommandMode,
		debouncedInputForTabCompletion,
		tabCompletionFilter,
		getTabCompletionSuggestions,
	]);

	// The stored filter is raw (it carries the opening quote while the user types a
	// quoted `@"path with spaces"` mention); the fuzzy file search wants it bare.
	const debouncedAtMentionFilter = useDebouncedValue(
		atMentionOpen ? stripMentionQuotes(atMentionFilter) : '',
		100
	);
	// File/directory suggestions (raw) - only computed while the picker is open in
	// AI mode. These feed the Files/Directories scopes of the unified picker.
	const fileSuggestions = useMemo(() => {
		if (!atMentionOpen || !activeSessionId || inputMode !== 'ai') {
			return [];
		}
		return getAtMentionSuggestions(debouncedAtMentionFilter);
	}, [
		atMentionOpen,
		activeSessionId,
		inputMode,
		debouncedAtMentionFilter,
		getAtMentionSuggestions,
	]);

	// Unified picker: composes file/dir suggestions with agents/groups into one
	// ranked, category-aware list. Single source of truth for the dropdown.
	const { items: atMentionItems, counts: atMentionCounts } = useMentionPicker({
		filter: debouncedAtMentionFilter,
		category: atMentionCategory,
		sessions,
		groups,
		currentSessionId: activeSessionId,
		fileSuggestions,
	});

	return { tabCompletionSuggestions, getTabCompletionSuggestions, atMentionItems, atMentionCounts };
}
