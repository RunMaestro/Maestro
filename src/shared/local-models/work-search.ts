/**
 * Searching past work: the wire vocabulary shared by the main-process search
 * (`src/main/local-models/work-search.ts`) and every surface that renders its
 * hits (the History panel, cross-tab search, `maestro-cli search`).
 *
 * One request shape and one hit shape serve two modes:
 *
 * - `semantic` - by meaning. The query is embedded on the Semantic search
 *   assignment and compared against the embedding index. A hit carries a
 *   `score`.
 * - `text`     - by exact words (case-insensitive). The same corpus is read
 *   directly, with no model and no index. A hit carries a `matchCount`.
 *
 * The corpus is the same in both: History entries, archived Director's Notes
 * synopses, and the AI tab transcripts Maestro persists.
 */

import type { HistoryEntry, HistoryEntryType } from '../types';
import {
	isEmbeddingSourceType,
	type EmbeddingSourceType,
	type SemanticIndexProgress,
} from './embedding-index';
import { taskAssignmentLocation } from './settings-location';

export const WORK_SEARCH_MODES = ['text', 'semantic'] as const;

export type WorkSearchMode = (typeof WORK_SEARCH_MODES)[number];

/** Hits returned when a request names no limit. */
export const DEFAULT_WORK_SEARCH_LIMIT = 20;

/** The most hits one request may ask for. */
export const MAX_WORK_SEARCH_LIMIT = 100;

/** A longer query is cut here: no model window holds more, and no person types it. */
export const MAX_WORK_SEARCH_QUERY_CHARS = 1000;

/** Longest snippet a hit carries. */
export const WORK_SEARCH_SNIPPET_CHARS = 240;

/**
 * How each source type is spelled on the command line (`--source`), and the
 * word a result row is labeled with.
 */
export const WORK_SEARCH_SOURCE_NAMES: Record<EmbeddingSourceType, string> = {
	history: 'history',
	'directors-notes': 'notes',
	transcript: 'transcripts',
};

/** The source types as a person reads them on one result row. */
export const WORK_SEARCH_SOURCE_LABELS: Record<EmbeddingSourceType, string> = {
	history: 'History',
	'directors-notes': "Director's Notes",
	transcript: 'Transcript',
};

/**
 * The source type a `--source` value names, or `null`. Accepts the short CLI
 * spelling (`notes`, `transcripts`), the singular (`transcript`), and the
 * stored type itself (`directors-notes`).
 */
export function parseWorkSearchSource(value: string): EmbeddingSourceType | null {
	const wanted = value.trim().toLowerCase();
	if (isEmbeddingSourceType(wanted)) return wanted;
	for (const [type, name] of Object.entries(WORK_SEARCH_SOURCE_NAMES)) {
		if (name === wanted || name === `${wanted}s`) return type as EmbeddingSourceType;
	}
	return null;
}

export interface WorkSearchRequest {
	query: string;
	/** Defaults to `semantic`. */
	mode?: WorkSearchMode;
	/** Restrict to these source types. Omitted means every type. */
	sourceTypes?: readonly EmbeddingSourceType[];
	/**
	 * Restrict to one agent. A Director's Notes synopsis belongs to no agent, so
	 * naming one leaves the notes out.
	 */
	agentId?: string;
	/** Defaults to {@link DEFAULT_WORK_SEARCH_LIMIT}. */
	limit?: number;
	/**
	 * Carry the whole History entry on each history hit. The History panel asks,
	 * because it opens the entry's detail view; the CLI does not, because an
	 * entry's full response can be tens of kilobytes.
	 */
	includeEntries?: boolean;
}

/** Where a history hit lives. */
export interface WorkSearchHistoryRef {
	type: HistoryEntryType;
	/** The provider session the entry came from, when it recorded one. */
	agentSessionId?: string;
	sessionName?: string;
	/** Only with {@link WorkSearchRequest.includeEntries}. */
	entry?: HistoryEntry;
}

/** Where a transcript hit lives. */
export interface WorkSearchTranscriptRef {
	tabId: string;
	/** The log entry that opens the turn: the jump target in the transcript. */
	turnId: string;
	/** The tab's own name, or a placeholder when it has none. */
	tabName: string;
}

/** One source that matched, best first in a result list. */
export interface WorkSearchHit {
	sourceType: EmbeddingSourceType;
	/** A history entry id, a synopsis id, or a `transcriptSourceId`. */
	sourceId: string;
	agentId: string | null;
	/** The agent's display name, when the agent still exists. */
	agentName?: string;
	/** Cosine similarity to the query, from -1 to 1. Semantic mode only. */
	score?: number;
	/** Occurrences of the query in the source. Text mode only. */
	matchCount?: number;
	/** One line naming the source: an entry's summary, a tab's name. */
	title: string;
	/** The part of the source that matched, whitespace collapsed. */
	snippet: string;
	/** When the source was written (Unix ms), when known. */
	timestamp?: number;
	history?: WorkSearchHistoryRef;
	transcript?: WorkSearchTranscriptRef;
}

/** How far along the index was when a semantic search ran. */
export type WorkSearchIndexState = Pick<SemanticIndexProgress, 'state' | 'indexed' | 'total'>;

/**
 * A search's verdict.
 *
 * - `ok`          - the search ran. Zero hits is still `ok`.
 * - `off`         - semantic mode, and Semantic search is assigned no source.
 * - `unavailable` - the search could not run. `reason` is written for a person.
 * - `cancelled`   - the embedding call was aborted.
 *
 * Nothing falls back: a semantic search that cannot run is never answered with
 * text matches under the same name.
 */
export type WorkSearchResult =
	| {
			status: 'ok';
			mode: WorkSearchMode;
			hits: WorkSearchHit[];
			durationMs: number;
			/** The index key searched. Semantic mode only. */
			modelId?: string;
			/** Semantic mode only. */
			index?: WorkSearchIndexState;
	  }
	| { status: 'off' }
	| { status: 'unavailable'; reason: string; code?: string }
	| { status: 'cancelled' };

/** What a surface says when Semantic search is assigned no source. */
export const WORK_SEARCH_OFF_REASON = `Semantic search is off. Assign it a source in ${taskAssignmentLocation('semantic-search')}.`;

/**
 * Validate a request that crossed a transport (IPC, the CLI bridge). Throws
 * for a caller bug; a search that merely cannot run is a verdict, not a throw.
 */
export function parseWorkSearchRequest(value: unknown): WorkSearchRequest {
	if (typeof value !== 'object' || value === null) {
		throw new Error('A search request must be an object.');
	}
	const raw = value as Record<string, unknown>;
	if (typeof raw.query !== 'string' || raw.query.trim() === '') {
		throw new Error('A search needs a query.');
	}
	const request: WorkSearchRequest = {
		query: raw.query.trim().slice(0, MAX_WORK_SEARCH_QUERY_CHARS),
	};

	if (raw.mode !== undefined) {
		if (!(WORK_SEARCH_MODES as readonly unknown[]).includes(raw.mode)) {
			throw new Error(`Unknown search mode. Use one of: ${WORK_SEARCH_MODES.join(', ')}.`);
		}
		request.mode = raw.mode as WorkSearchMode;
	}

	if (raw.sourceTypes !== undefined) {
		if (!Array.isArray(raw.sourceTypes) || !raw.sourceTypes.every(isEmbeddingSourceType)) {
			throw new Error(
				`Unknown search source. Use: ${Object.values(WORK_SEARCH_SOURCE_NAMES).join(', ')}.`
			);
		}
		request.sourceTypes = [...new Set(raw.sourceTypes)];
	}

	if (raw.agentId !== undefined) {
		if (typeof raw.agentId !== 'string' || raw.agentId === '') {
			throw new Error('agentId must be a non-empty string.');
		}
		request.agentId = raw.agentId;
	}

	if (raw.limit !== undefined) {
		if (typeof raw.limit !== 'number' || !Number.isFinite(raw.limit) || raw.limit < 1) {
			throw new Error('limit must be a positive number.');
		}
		request.limit = Math.min(MAX_WORK_SEARCH_LIMIT, Math.floor(raw.limit));
	}

	if (raw.includeEntries === true) request.includeEntries = true;
	return request;
}

/** A semantic score as a person reads it: `87%`. Never below 0% or above 100%. */
export function formatWorkSearchScore(score: number): string {
	if (!Number.isFinite(score)) return '0%';
	return `${Math.round(Math.max(0, Math.min(1, score)) * 100)}%`;
}

/**
 * The words of a query worth looking for in a hit's text: lowercased, at least
 * three characters, in the order typed. The snippet window is placed on them,
 * and a result row highlights them, so the two agree about what "matched".
 */
export function workSearchQueryWords(query: string): string[] {
	return query
		.toLowerCase()
		.split(/\s+/)
		.filter((word) => word.length >= 3);
}

/**
 * A snippet of `text` for a result row: whitespace collapsed, at most
 * `maxChars` long, with an ellipsis on each cut side.
 *
 * The window is placed on the whole query when the text holds it, else on the
 * first query word the text holds, else at the start. A semantic hit often
 * shares no word with its query, and its chunk's opening is then the honest
 * thing to show.
 */
export function workSearchSnippet(
	text: string,
	query: string,
	maxChars: number = WORK_SEARCH_SNIPPET_CHARS
): string {
	const flat = text.replace(/\s+/g, ' ').trim();
	if (flat.length <= maxChars) return flat;

	const lower = flat.toLowerCase();
	let at = lower.indexOf(query.replace(/\s+/g, ' ').trim().toLowerCase());
	if (at < 0) {
		for (const word of workSearchQueryWords(query)) {
			at = lower.indexOf(word);
			if (at >= 0) break;
		}
	}

	// A third of the window before the match, so the words that follow it (which
	// usually say more) get the rest.
	let start = at <= 0 ? 0 : Math.max(0, at - Math.floor(maxChars / 3));
	start = Math.min(start, flat.length - maxChars);
	// Start on a word, unless that would push the match out of the window.
	if (start > 0) {
		const space = flat.indexOf(' ', start);
		if (space >= 0 && space < start + 24 && (at < 0 || space < at)) start = space + 1;
	}
	const end = Math.min(flat.length, start + maxChars);
	return `${start > 0 ? '…' : ''}${flat.slice(start, end).trim()}${end < flat.length ? '…' : ''}`;
}

/** How many times `needle` occurs in `haystack`. Both must already be lowercased. */
export function countOccurrences(haystack: string, needle: string): number {
	if (needle === '') return 0;
	let count = 0;
	for (
		let at = haystack.indexOf(needle);
		at >= 0;
		at = haystack.indexOf(needle, at + needle.length)
	)
		count++;
	return count;
}

/**
 * One line telling the user the index does not cover everything yet, or
 * `null` when it does. A semantic search over a half-built index answers from
 * what is indexed so far, and a surface that hides that reads as the search
 * having missed something.
 */
export function describeWorkSearchIndex(index: WorkSearchIndexState | undefined): string | null {
	if (!index) return null;
	if (index.state === 'unavailable') return 'The index is not being updated right now.';
	if (index.total === 0) {
		return index.state === 'idle' ? null : 'The index has not finished its first pass yet.';
	}
	if (index.indexed >= index.total) return null;
	return `Index is still building: ${index.indexed} of ${index.total} sources.`;
}
