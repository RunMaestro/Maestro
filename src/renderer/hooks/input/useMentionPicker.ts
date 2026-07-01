import { useMemo } from 'react';
import type { Session, Group } from '../../types';
import type { AtMentionSuggestion } from './useAtMentionCompletion';
import {
	useAgentMentionCompletion,
	type AgentMentionSuggestion,
} from './useAgentMentionCompletion';

/**
 * The four filter scopes of the unified `@` picker. `all` interleaves every
 * kind; the rest narrow to a single kind (agents + groups both surface under
 * `agents`).
 */
export type MentionCategory = 'all' | 'files' | 'directories' | 'agents';

/**
 * Cycle order for the category bar. ArrowLeft/ArrowRight step through this list
 * (wrapping both directions).
 */
export const MENTION_CATEGORY_CYCLE: MentionCategory[] = ['all', 'files', 'directories', 'agents'];

/**
 * The visible/cyclable categories given the Cross-Agent Mentions Encore flag.
 * When the feature is off the `agents` scope is dropped entirely so the `@`
 * picker only offers files/directories (the single-`@` file experience is never
 * gated). Single source of truth for both the category bar (AtMentionPopover)
 * and the keyboard cycle (useInputKeyDown), so they can never disagree.
 */
export function getMentionCategoryCycle(crossAgentMentionsEnabled: boolean): MentionCategory[] {
	return crossAgentMentionsEnabled
		? MENTION_CATEGORY_CYCLE
		: MENTION_CATEGORY_CYCLE.filter((c) => c !== 'agents');
}

/**
 * A file or directory row. `value` is the *full literal token* to splice into
 * the textarea: `@path ` for files (trailing space, closes the picker) and
 * `@path/` for directories (trailing slash, no space, drills in and re-filters).
 */
export interface FileMentionItem {
	kind: 'file' | 'directory';
	value: string;
	displayText: string;
	fullPath: string;
	score: number;
	source?: 'project' | 'autorun';
}

/**
 * A ranked item in the unified picker: a file, a directory, an agent, or a
 * group. Every item carries a `value` (the literal to insert) and a
 * `displayText`.
 */
export type MentionPickerItem = FileMentionItem | AgentMentionSuggestion;

export interface UseMentionPickerParams {
	/** Current mention filter (text typed after the `@`). */
	filter: string;
	/** Active category scope. */
	category: MentionCategory;
	/** All agents (sessions) - the Agents data source. */
	sessions: Session[];
	/** Session groups. */
	groups: Group[] | undefined;
	/** The mentioning agent, excluded from the Agents list. */
	currentSessionId: string | null | undefined;
	/** File/directory suggestions from {@link useAtMentionCompletion}. */
	fileSuggestions: AtMentionSuggestion[];
	/**
	 * Cross-Agent Mentions Encore flag. When false the Agents category is
	 * suppressed (no agent/group rows, zero count) and, defensively, an `agents`
	 * scope falls back to `all`. Files/directories are never affected.
	 */
	crossAgentMentionsEnabled: boolean;
}

export interface UseMentionPickerReturn {
	/** Rows for the active category (interleaved by score when `all`). */
	items: MentionPickerItem[];
	/** Per-category totals for the category bar labels + empty-state handling. */
	counts: Record<MentionCategory, number>;
}

/** Display cap per category, matching the file/agent hooks. */
const MAX_ITEMS = 15;

/** Stable tie-break order when scores match in the `all` view. */
const KIND_RANK: Record<MentionPickerItem['kind'], number> = {
	file: 0,
	directory: 1,
	group: 2,
	agent: 3,
};

/**
 * Compose the file hook's output and the agent hook into one ranked,
 * category-aware list. This is the single source of truth for what the unified
 * `@` dropdown shows - there is no parallel `@@` dropdown.
 *
 * `fileSuggestions` are already filtered by the file hook; agents/groups are
 * filtered here via {@link useAgentMentionCompletion}. `counts` always reflect
 * every category (independent of the active one) so the bar can label and skip
 * empty scopes.
 */
export function useMentionPicker(params: UseMentionPickerParams): UseMentionPickerReturn {
	const {
		filter,
		category,
		sessions,
		groups,
		currentSessionId,
		fileSuggestions,
		crossAgentMentionsEnabled,
	} = params;

	const { getSuggestions: getAgentSuggestions } = useAgentMentionCompletion(
		sessions,
		groups,
		currentSessionId
	);

	return useMemo(() => {
		// Split/tag the file hook output into file vs directory rows, building the
		// full `@...` token up front so acceptance is a uniform splice.
		const fileItems: MentionPickerItem[] = [];
		const dirItems: MentionPickerItem[] = [];
		for (const f of fileSuggestions) {
			if (f.type === 'folder') {
				dirItems.push({
					kind: 'directory',
					value: `@${f.value}/`,
					displayText: f.displayText,
					fullPath: f.fullPath,
					score: f.score,
					source: f.source,
				});
			} else {
				fileItems.push({
					kind: 'file',
					value: `@${f.value} `,
					displayText: f.displayText,
					fullPath: f.fullPath,
					score: f.score,
					source: f.source,
				});
			}
		}

		// Encore-gated: with the flag off the picker never surfaces agents/groups.
		const agentItems: MentionPickerItem[] = crossAgentMentionsEnabled
			? getAgentSuggestions(filter)
			: [];

		const counts: Record<MentionCategory, number> = {
			all: fileItems.length + dirItems.length + agentItems.length,
			files: fileItems.length,
			directories: dirItems.length,
			agents: agentItems.length,
		};

		// Defensive: if the flag flips off while the picker sits on `agents`,
		// fall back to `all` so the user still sees files/directories.
		const effectiveCategory: MentionCategory =
			!crossAgentMentionsEnabled && category === 'agents' ? 'all' : category;

		let items: MentionPickerItem[];
		switch (effectiveCategory) {
			case 'files':
				items = fileItems.slice(0, MAX_ITEMS);
				break;
			case 'directories':
				items = dirItems.slice(0, MAX_ITEMS);
				break;
			case 'agents':
				items = agentItems.slice(0, MAX_ITEMS);
				break;
			case 'all':
			default: {
				const combined = [...fileItems, ...dirItems, ...agentItems];
				combined.sort((a, b) => {
					if (b.score !== a.score) return b.score - a.score;
					if (KIND_RANK[a.kind] !== KIND_RANK[b.kind]) {
						return KIND_RANK[a.kind] - KIND_RANK[b.kind];
					}
					return a.displayText.localeCompare(b.displayText);
				});
				items = combined.slice(0, MAX_ITEMS);
				break;
			}
		}

		return { items, counts };
	}, [filter, category, fileSuggestions, getAgentSuggestions]);
}

export interface MentionAcceptResult {
	/** New textarea value after splicing the accepted token. */
	value: string;
	/** Directory drill-in keeps the picker open to re-filter inside the folder. */
	keepOpen: boolean;
	/** New mention filter when `keepOpen` (the directory path + `/`). */
	nextFilter: string;
}

/**
 * Compute the textarea update for accepting a picker item. Replaces the
 * `@<filter>` span at `startIndex` with the item's literal `value`. Directories
 * drill in (keep open, re-filter inside the folder); everything else closes.
 */
export function buildMentionAccept(
	inputValue: string,
	startIndex: number,
	filter: string,
	item: MentionPickerItem
): MentionAcceptResult {
	const beforeAt = inputValue.substring(0, startIndex);
	const afterFilter = inputValue.substring(startIndex + 1 + filter.length);
	const value = beforeAt + item.value + afterFilter;

	if (item.kind === 'directory') {
		// `item.value` is `@path/`; the re-filter drops the leading `@`.
		return { value, keepOpen: true, nextFilter: item.value.slice(1) };
	}
	return { value, keepOpen: false, nextFilter: '' };
}
