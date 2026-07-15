import { useMemo } from 'react';
import type { Session, Group } from '../../types';
import type { AtMentionSuggestion } from './useAtMentionCompletion';
import {
	useAgentMentionCompletion,
	type AgentMentionSuggestion,
} from './useAgentMentionCompletion';
import {
	formatFileMention,
	mentionQuoteChar,
	stripMentionQuotes,
} from '../../../shared/mentionPatterns';

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
 * A file or directory row. `value` is the *full literal token* to splice into
 * the textarea: `@path ` for files (trailing space, closes the picker) and
 * `@path/` for directories (trailing slash, no space, drills in and re-filters).
 *
 * A path carrying spaces is quoted (`@"my notes.md" `, `@"my folder/"`) so it
 * scans back out as ONE mention - see `formatFileMention`. For a quoted
 * directory the caret is parked INSIDE the closing quote (see
 * {@link buildMentionAccept}) so drilling in keeps typing within the quotes.
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
 * `@` dropdown shows - files and agents/groups share one `@` trigger.
 *
 * `fileSuggestions` are already filtered by the file hook; agents/groups are
 * filtered here via {@link useAgentMentionCompletion}. `counts` always reflect
 * every category (independent of the active one) so the bar can label and skip
 * empty scopes.
 */
export function useMentionPicker(params: UseMentionPickerParams): UseMentionPickerReturn {
	const { filter, category, sessions, groups, currentSessionId, fileSuggestions } = params;

	const { getSuggestions: getAgentSuggestions } = useAgentMentionCompletion(
		sessions,
		groups,
		currentSessionId
	);

	return useMemo(() => {
		// The stored filter is raw (it may carry the opening quote of a quoted
		// mention); agents are searched on the bare text. Files are already filtered
		// upstream against the same bare term.
		const searchTerm = stripMentionQuotes(filter);

		// Split/tag the file hook output into file vs directory rows, building the
		// full `@...` token up front so acceptance is a uniform splice.
		const fileItems: MentionPickerItem[] = [];
		const dirItems: MentionPickerItem[] = [];
		for (const f of fileSuggestions) {
			if (f.type === 'folder') {
				dirItems.push({
					kind: 'directory',
					value: formatFileMention(`${f.value}/`),
					displayText: f.displayText,
					fullPath: f.fullPath,
					score: f.score,
					source: f.source,
				});
			} else {
				fileItems.push({
					kind: 'file',
					value: `${formatFileMention(f.value)} `,
					displayText: f.displayText,
					fullPath: f.fullPath,
					score: f.score,
					source: f.source,
				});
			}
		}

		const agentItems: MentionPickerItem[] = getAgentSuggestions(searchTerm);

		const counts: Record<MentionCategory, number> = {
			all: fileItems.length + dirItems.length + agentItems.length,
			files: fileItems.length,
			directories: dirItems.length,
			agents: agentItems.length,
		};

		let items: MentionPickerItem[];
		switch (category) {
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
	/**
	 * Where the caret should land after acceptance: right after the spliced
	 * token. For files/agents that includes the token's trailing space, so the
	 * user can keep typing immediately without the caret sitting mid-mention.
	 */
	caretPos: number;
	/** Directory drill-in keeps the picker open to re-filter inside the folder. */
	keepOpen: boolean;
	/** New mention filter when `keepOpen` (the directory path + `/`). */
	nextFilter: string;
}

/**
 * Compute the textarea update for accepting a picker item. Replaces the
 * `@<filter>` span at `startIndex` with the item's literal `value`. Directories
 * drill in (keep open, re-filter inside the folder); everything else closes.
 *
 * Quoted mentions (paths with spaces) add one wrinkle: while drilled into a
 * quoted directory the caret sits INSIDE the quotes, so the closing quote of the
 * previous token still sits just past the filter. The accepted token brings its
 * own closing quote, so that stale one is swallowed instead of doubled.
 */
export function buildMentionAccept(
	inputValue: string,
	startIndex: number,
	filter: string,
	item: MentionPickerItem
): MentionAcceptResult {
	const beforeAt = inputValue.substring(0, startIndex);
	let afterIndex = startIndex + 1 + filter.length;
	const openQuote = mentionQuoteChar(filter);
	if (openQuote && inputValue[afterIndex] === openQuote) afterIndex += 1;
	const afterFilter = inputValue.substring(afterIndex);
	const value = beforeAt + item.value + afterFilter;

	if (item.kind === 'directory') {
		// A quoted directory (`@"my folder/"`) parks the caret before its closing
		// quote so the next keystrokes land inside the quotes; the re-filter is the
		// token minus the leading `@` and that closing quote (`"my folder/`).
		const quoted = !!mentionQuoteChar(item.value.slice(1));
		return {
			value,
			caretPos: startIndex + item.value.length - (quoted ? 1 : 0),
			keepOpen: true,
			nextFilter: quoted ? item.value.slice(1, -1) : item.value.slice(1),
		};
	}
	// Caret lands immediately after the spliced token, past its trailing space.
	return { value, caretPos: startIndex + item.value.length, keepOpen: false, nextFilter: '' };
}
