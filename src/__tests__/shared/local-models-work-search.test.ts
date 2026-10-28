/**
 * @file local-models-work-search.test.ts
 *
 * The search's wire helpers: request validation at a transport, the CLI's
 * source spelling, the score a person reads, and the snippet a result row
 * shows.
 */

import { describe, it, expect } from 'vitest';
import {
	countOccurrences,
	describeWorkSearchIndex,
	formatWorkSearchScore,
	MAX_WORK_SEARCH_LIMIT,
	MAX_WORK_SEARCH_QUERY_CHARS,
	parseWorkSearchRequest,
	parseWorkSearchSource,
	workSearchQueryWords,
	workSearchSnippet,
} from '../../shared/local-models/work-search';

describe('parseWorkSearchSource', () => {
	it('accepts the CLI spelling, the singular, and the stored type', () => {
		expect(parseWorkSearchSource('history')).toBe('history');
		expect(parseWorkSearchSource('notes')).toBe('directors-notes');
		expect(parseWorkSearchSource('note')).toBe('directors-notes');
		expect(parseWorkSearchSource('directors-notes')).toBe('directors-notes');
		expect(parseWorkSearchSource('Transcripts')).toBe('transcript');
		expect(parseWorkSearchSource(' transcript ')).toBe('transcript');
	});

	it('refuses anything else', () => {
		expect(parseWorkSearchSource('cue')).toBeNull();
		expect(parseWorkSearchSource('')).toBeNull();
	});
});

describe('parseWorkSearchRequest', () => {
	it('keeps a valid request and trims the query', () => {
		expect(
			parseWorkSearchRequest({
				query: '  retry logic  ',
				mode: 'text',
				sourceTypes: ['history', 'history', 'transcript'],
				agentId: 'agent-1',
				limit: 7.9,
				includeEntries: true,
			})
		).toEqual({
			query: 'retry logic',
			mode: 'text',
			sourceTypes: ['history', 'transcript'],
			agentId: 'agent-1',
			limit: 7,
			includeEntries: true,
		});
	});

	it('leaves optional fields off rather than defaulting them', () => {
		expect(parseWorkSearchRequest({ query: 'q' })).toEqual({ query: 'q' });
	});

	it('caps the limit and the query length', () => {
		const parsed = parseWorkSearchRequest({ query: 'x'.repeat(5000), limit: 10_000 });
		expect(parsed.limit).toBe(MAX_WORK_SEARCH_LIMIT);
		expect(parsed.query).toHaveLength(MAX_WORK_SEARCH_QUERY_CHARS);
	});

	it('throws for a caller bug', () => {
		expect(() => parseWorkSearchRequest(undefined)).toThrow('must be an object');
		expect(() => parseWorkSearchRequest({ query: '   ' })).toThrow('needs a query');
		expect(() => parseWorkSearchRequest({ query: 'q', mode: 'fuzzy' })).toThrow('search mode');
		expect(() => parseWorkSearchRequest({ query: 'q', sourceTypes: ['cue'] })).toThrow(
			'history, notes, transcripts'
		);
		expect(() => parseWorkSearchRequest({ query: 'q', agentId: '' })).toThrow('agentId');
		expect(() => parseWorkSearchRequest({ query: 'q', limit: 0 })).toThrow('limit');
	});
});

describe('formatWorkSearchScore', () => {
	it('reads as a percentage, clamped', () => {
		expect(formatWorkSearchScore(0.874)).toBe('87%');
		expect(formatWorkSearchScore(1.2)).toBe('100%');
		expect(formatWorkSearchScore(-0.3)).toBe('0%');
		expect(formatWorkSearchScore(Number.NaN)).toBe('0%');
	});
});

describe('workSearchSnippet', () => {
	it('returns a short text whole, with whitespace collapsed', () => {
		expect(workSearchSnippet('Fixed  the\n\nlogin   timeout', 'login')).toBe(
			'Fixed the login timeout'
		);
	});

	it('places the window on the query and marks both cuts', () => {
		const text = `${'alpha '.repeat(80)}the token refresh raced the logout ${'omega '.repeat(80)}`;
		const snippet = workSearchSnippet(text, 'token refresh', 80);
		expect(snippet).toContain('token refresh');
		expect(snippet.startsWith('…')).toBe(true);
		expect(snippet.endsWith('…')).toBe(true);
		expect(snippet.length).toBeLessThanOrEqual(82);
	});

	it('falls back to the first query word the text holds', () => {
		const text = `${'alpha '.repeat(80)}the scheduler dropped a job ${'omega '.repeat(80)}`;
		expect(workSearchSnippet(text, 'why did the scheduler stall', 80)).toContain('scheduler');
	});

	it('shows the opening when no query word occurs, as a semantic hit often has none', () => {
		const text = `Opening sentence here. ${'filler '.repeat(100)}`;
		const snippet = workSearchSnippet(text, 'unrelated', 60);
		expect(snippet.startsWith('Opening sentence')).toBe(true);
		expect(snippet.endsWith('…')).toBe(true);
	});
});

describe('workSearchQueryWords and countOccurrences', () => {
	it('keeps words of three characters or more, lowercased', () => {
		expect(workSearchQueryWords('Why is CI so Red')).toEqual(['why', 'red']);
	});

	it('counts non-overlapping occurrences', () => {
		expect(countOccurrences('retry, then retry again; no retries', 'retry')).toBe(2);
		expect(countOccurrences('aaaa', 'aa')).toBe(2);
		expect(countOccurrences('anything', '')).toBe(0);
	});
});

describe('describeWorkSearchIndex', () => {
	it('says nothing when the index covers everything', () => {
		expect(describeWorkSearchIndex(undefined)).toBeNull();
		expect(describeWorkSearchIndex({ state: 'idle', indexed: 40, total: 40 })).toBeNull();
		expect(describeWorkSearchIndex({ state: 'idle', indexed: 0, total: 0 })).toBeNull();
	});

	it('names how far a building index has got', () => {
		expect(describeWorkSearchIndex({ state: 'indexing', indexed: 120, total: 900 })).toBe(
			'Index is still building: 120 of 900 sources.'
		);
		expect(describeWorkSearchIndex({ state: 'indexing', indexed: 0, total: 0 })).toBe(
			'The index has not finished its first pass yet.'
		);
		expect(describeWorkSearchIndex({ state: 'unavailable', indexed: 3, total: 9 })).toBe(
			'The index is not being updated right now.'
		);
	});
});
