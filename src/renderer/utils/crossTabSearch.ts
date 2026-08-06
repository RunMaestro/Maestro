/**
 * Cross-tab message search - the pure core behind the "Search Across All Tabs"
 * modal (Opt+Cmd+F).
 *
 * The in-tab Find bar (Cmd+F) searches the rendered DOM of the *active* tab via
 * the CSS Custom Highlight API. That approach can't see tabs that aren't
 * mounted, so this module searches the in-memory `AITab.logs` arrays instead and
 * returns match metadata the modal renders as a list.
 *
 * Kept free of React/store imports so it stays cheap to unit-test and can run
 * inside a memo without pulling the component tree in.
 */
import type { AITab, LogEntry } from '../types';
import { compileSearchRegex } from '../components/FilePreview/search/queryMatch';
import { getTabDisplayName } from './tabHelpers';

/** Characters of surrounding context kept on each side of a match in a snippet. */
const SNIPPET_CONTEXT = 70;

/** Default caps so a one-character query on a huge agent can't lock the UI. */
export const DEFAULT_MAX_MATCHES_PER_TAB = 100;
export const DEFAULT_MAX_MATCHES_TOTAL = 500;

/** A single matching log entry, already reduced to what the result row renders. */
export interface CrossTabSearchMatch {
	/** `LogEntry.id` - the jump target handed to the transcript. */
	logId: string;
	timestamp: number;
	source: LogEntry['source'];
	/** Whitespace-collapsed text around the first match in this entry. */
	snippet: string;
	/** `[start, end)` offsets of the match inside `snippet`. */
	range: [number, number];
	/** True when the snippet was cut at the start (renders a leading ellipsis). */
	truncatedStart: boolean;
	/** True when the snippet was cut at the end (renders a trailing ellipsis). */
	truncatedEnd: boolean;
	/** Total matches inside this entry (the row shows a pill when > 1). */
	matchCount: number;
}

/** All matches within one AI tab. */
export interface CrossTabSearchTabResult {
	tabId: string;
	tabName: string;
	starred: boolean;
	/** Capped at `maxPerTab`; `totalMatches` is the uncapped entry count. */
	matches: CrossTabSearchMatch[];
	/** Number of matching *entries* in this tab, before capping. */
	totalMatches: number;
}

export interface CrossTabSearchResult {
	tabs: CrossTabSearchTabResult[];
	/** Matching entries across every tab, before capping. */
	totalMatches: number;
	/** True when a cap dropped rows from the returned list. */
	truncated: boolean;
	/** Friendly message when regex mode got an invalid pattern. */
	error: string | null;
}

export interface CrossTabSearchOptions {
	/** Treat `query` as a regular expression source instead of a literal. */
	regex?: boolean;
	caseSensitive?: boolean;
	maxPerTab?: number;
	maxTotal?: number;
}

const EMPTY_RESULT: CrossTabSearchResult = {
	tabs: [],
	totalMatches: 0,
	truncated: false,
	error: null,
};

/** Collapse newlines and runs of whitespace so a snippet stays on one line. */
function collapse(text: string): string {
	return text.replace(/\s+/g, ' ');
}

/**
 * Build the snippet for one entry. Offsets are computed by collapsing the
 * prefix/match/suffix separately, so the highlight range stays exact even
 * though the displayed text is whitespace-normalized.
 */
function buildSnippet(
	text: string,
	start: number,
	end: number
): Omit<CrossTabSearchMatch, 'logId' | 'timestamp' | 'source' | 'matchCount'> {
	const rawStart = Math.max(0, start - SNIPPET_CONTEXT);
	const rawEnd = Math.min(text.length, end + SNIPPET_CONTEXT);
	const prefix = collapse(text.slice(rawStart, start)).trimStart();
	const matched = collapse(text.slice(start, end));
	const suffix = collapse(text.slice(end, rawEnd)).trimEnd();
	return {
		snippet: `${prefix}${matched}${suffix}`,
		range: [prefix.length, prefix.length + matched.length],
		truncatedStart: rawStart > 0,
		truncatedEnd: rawEnd < text.length,
	};
}

/** Count matches in `text`, stopping early once `limit` is reached. */
function countMatches(regex: RegExp, text: string, limit: number): number {
	regex.lastIndex = 0;
	let count = 0;
	let m = regex.exec(text);
	while (m !== null && count < limit) {
		count++;
		if (m[0].length === 0) regex.lastIndex++;
		m = regex.exec(text);
	}
	return count;
}

/**
 * Search the message history of every supplied AI tab.
 *
 * Returns one match per *entry* (the first hit in that entry) rather than one
 * per occurrence: the row jumps to the entry, and the in-tab Find bar handles
 * stepping through repeats once the user lands there.
 */
export function searchTabsMessages(
	tabs: AITab[],
	query: string,
	options: CrossTabSearchOptions = {}
): CrossTabSearchResult {
	const trimmed = query.trim();
	if (!trimmed) return EMPTY_RESULT;

	const { regex, error } = compileSearchRegex(trimmed, {
		regex: options.regex,
		caseSensitive: options.caseSensitive,
	});
	if (!regex) return { ...EMPTY_RESULT, error };

	const maxPerTab = options.maxPerTab ?? DEFAULT_MAX_MATCHES_PER_TAB;
	const maxTotal = options.maxTotal ?? DEFAULT_MAX_MATCHES_TOTAL;

	const results: CrossTabSearchTabResult[] = [];
	let totalMatches = 0;
	let emitted = 0;
	let truncated = false;

	for (const tab of tabs) {
		const matches: CrossTabSearchMatch[] = [];
		let tabTotal = 0;

		for (const log of tab.logs ?? []) {
			const text = log.text;
			if (!text) continue;
			regex.lastIndex = 0;
			const first = regex.exec(text);
			if (!first) continue;

			tabTotal++;
			if (matches.length >= maxPerTab || emitted >= maxTotal) {
				truncated = true;
				continue;
			}

			matches.push({
				logId: log.id,
				timestamp: log.timestamp,
				source: log.source,
				matchCount: countMatches(regex, text, 100),
				...buildSnippet(text, first.index, first.index + first[0].length),
			});
			emitted++;
		}

		totalMatches += tabTotal;
		if (tabTotal > 0) {
			results.push({
				tabId: tab.id,
				tabName: getTabDisplayName(tab),
				starred: tab.starred,
				matches,
				totalMatches: tabTotal,
			});
		}
	}

	return { tabs: results, totalMatches, truncated, error: null };
}

/** Flatten grouped results into the linear order the keyboard navigates. */
export function flattenCrossTabMatches(
	result: CrossTabSearchResult
): Array<{ tab: CrossTabSearchTabResult; match: CrossTabSearchMatch }> {
	const flat: Array<{ tab: CrossTabSearchTabResult; match: CrossTabSearchMatch }> = [];
	for (const tab of result.tabs) {
		for (const match of tab.matches) {
			flat.push({ tab, match });
		}
	}
	return flat;
}
