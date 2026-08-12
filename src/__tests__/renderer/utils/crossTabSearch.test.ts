import { describe, it, expect } from 'vitest';
import { searchTabsMessages, flattenCrossTabMatches } from '../../../renderer/utils/crossTabSearch';
import { createMockAITab } from '../../helpers';
import type { LogEntry } from '../../../renderer/types';

function log(overrides: Partial<LogEntry> & { id: string; text: string }): LogEntry {
	return {
		timestamp: 1_700_000_000_000,
		source: 'ai',
		...overrides,
	} as LogEntry;
}

describe('searchTabsMessages', () => {
	it('returns an empty result for a blank query', () => {
		const tabs = [createMockAITab({ id: 't1', logs: [log({ id: 'l1', text: 'hello world' })] })];
		const result = searchTabsMessages(tabs, '   ');
		expect(result.tabs).toEqual([]);
		expect(result.totalMatches).toBe(0);
		expect(result.error).toBeNull();
	});

	it('finds matches across multiple tabs and groups them per tab', () => {
		const tabs = [
			createMockAITab({
				id: 't1',
				name: 'First',
				logs: [log({ id: 'a', text: 'deploy the widget' }), log({ id: 'b', text: 'unrelated' })],
			}),
			createMockAITab({
				id: 't2',
				name: 'Second',
				logs: [log({ id: 'c', text: 'the WIDGET broke' })],
			}),
		];

		const result = searchTabsMessages(tabs, 'widget');

		expect(result.totalMatches).toBe(2);
		expect(result.tabs.map((t) => t.tabId)).toEqual(['t1', 't2']);
		expect(result.tabs[0].tabName).toBe('First');
		expect(result.tabs[0].matches.map((m) => m.logId)).toEqual(['a']);
		// Case-insensitive by default
		expect(result.tabs[1].matches.map((m) => m.logId)).toEqual(['c']);
	});

	it('omits tabs with no matches entirely', () => {
		const tabs = [
			createMockAITab({ id: 't1', logs: [log({ id: 'a', text: 'nothing here' })] }),
			createMockAITab({ id: 't2', logs: [log({ id: 'b', text: 'found it' })] }),
		];
		const result = searchTabsMessages(tabs, 'found');
		expect(result.tabs).toHaveLength(1);
		expect(result.tabs[0].tabId).toBe('t2');
	});

	it('highlights the exact matched span within the snippet', () => {
		const tabs = [
			createMockAITab({ id: 't1', logs: [log({ id: 'a', text: 'alpha beta gamma' })] }),
		];
		const [match] = searchTabsMessages(tabs, 'beta').tabs[0].matches;
		const [start, end] = match.range;
		expect(match.snippet.slice(start, end)).toBe('beta');
	});

	it('collapses whitespace in snippets while keeping the highlight aligned', () => {
		const tabs = [
			createMockAITab({
				id: 't1',
				logs: [log({ id: 'a', text: 'line one\n\n   line two NEEDLE trailing\n\ttext' })],
			}),
		];
		const [match] = searchTabsMessages(tabs, 'needle').tabs[0].matches;
		const [start, end] = match.range;
		expect(match.snippet).not.toContain('\n');
		expect(match.snippet.slice(start, end)).toBe('NEEDLE');
	});

	it('marks snippets truncated when the entry is longer than the context window', () => {
		const filler = 'x'.repeat(500);
		const tabs = [
			createMockAITab({ id: 't1', logs: [log({ id: 'a', text: `${filler} target ${filler}` })] }),
		];
		const [match] = searchTabsMessages(tabs, 'target').tabs[0].matches;
		expect(match.truncatedStart).toBe(true);
		expect(match.truncatedEnd).toBe(true);
	});

	it('counts repeated matches within a single entry', () => {
		const tabs = [createMockAITab({ id: 't1', logs: [log({ id: 'a', text: 'foo foo foo bar' })] })];
		const [match] = searchTabsMessages(tabs, 'foo').tabs[0].matches;
		expect(match.matchCount).toBe(3);
		// Still one row per entry
		expect(searchTabsMessages(tabs, 'foo').tabs[0].matches).toHaveLength(1);
	});

	it('treats the query literally in plain-text mode', () => {
		const tabs = [
			createMockAITab({ id: 't1', logs: [log({ id: 'a', text: 'cost is $1.50 today' })] }),
		];
		expect(searchTabsMessages(tabs, '$1.50').totalMatches).toBe(1);
		// The regex metacharacters must not be interpreted
		expect(searchTabsMessages(tabs, 'c.st').totalMatches).toBe(0);
	});

	it('compiles the query as a pattern in regex mode', () => {
		const tabs = [
			createMockAITab({ id: 't1', logs: [log({ id: 'a', text: 'error code 4711 raised' })] }),
		];
		expect(searchTabsMessages(tabs, '\\d{4}', { regex: true }).totalMatches).toBe(1);
	});

	it('reports an invalid regex instead of throwing', () => {
		const tabs = [createMockAITab({ id: 't1', logs: [log({ id: 'a', text: 'anything' })] })];
		const result = searchTabsMessages(tabs, '(unclosed', { regex: true });
		expect(result.error).toBeTruthy();
		expect(result.tabs).toEqual([]);
	});

	it('honors case sensitivity when requested', () => {
		const tabs = [createMockAITab({ id: 't1', logs: [log({ id: 'a', text: 'Widget' })] })];
		expect(searchTabsMessages(tabs, 'widget', { caseSensitive: true }).totalMatches).toBe(0);
		expect(searchTabsMessages(tabs, 'Widget', { caseSensitive: true }).totalMatches).toBe(1);
	});

	it('caps emitted rows per tab but still reports the true total', () => {
		const logs = Array.from({ length: 5 }, (_, i) => log({ id: `l${i}`, text: 'hit' }));
		const tabs = [createMockAITab({ id: 't1', logs })];
		const result = searchTabsMessages(tabs, 'hit', { maxPerTab: 2 });
		expect(result.tabs[0].matches).toHaveLength(2);
		expect(result.tabs[0].totalMatches).toBe(5);
		expect(result.totalMatches).toBe(5);
		expect(result.truncated).toBe(true);
	});

	it('caps emitted rows across all tabs', () => {
		const tabs = [
			createMockAITab({ id: 't1', logs: [log({ id: 'a', text: 'hit' })] }),
			createMockAITab({ id: 't2', logs: [log({ id: 'b', text: 'hit' })] }),
		];
		const result = searchTabsMessages(tabs, 'hit', { maxTotal: 1 });
		expect(flattenCrossTabMatches(result)).toHaveLength(1);
		expect(result.totalMatches).toBe(2);
		expect(result.truncated).toBe(true);
	});

	it('searches every log source, tagging each hit with its origin', () => {
		const tabs = [
			createMockAITab({
				id: 't1',
				logs: [
					log({ id: 'a', text: 'ping', source: 'user' }),
					log({ id: 'b', text: 'ping', source: 'tool' }),
					log({ id: 'c', text: 'ping', source: 'error' }),
				],
			}),
		];
		const sources = searchTabsMessages(tabs, 'ping').tabs[0].matches.map((m) => m.source);
		expect(sources).toEqual(['user', 'tool', 'error']);
	});

	it('skips entries with empty text', () => {
		const tabs = [
			createMockAITab({
				id: 't1',
				logs: [log({ id: 'a', text: '' }), log({ id: 'b', text: 'real' })],
			}),
		];
		expect(searchTabsMessages(tabs, 'real').tabs[0].matches.map((m) => m.logId)).toEqual(['b']);
	});
});

describe('flattenCrossTabMatches', () => {
	it('flattens grouped results into keyboard-navigation order', () => {
		const tabs = [
			createMockAITab({
				id: 't1',
				logs: [log({ id: 'a', text: 'hit' }), log({ id: 'b', text: 'hit' })],
			}),
			createMockAITab({ id: 't2', logs: [log({ id: 'c', text: 'hit' })] }),
		];
		const flat = flattenCrossTabMatches(searchTabsMessages(tabs, 'hit'));
		expect(flat.map((f) => f.match.logId)).toEqual(['a', 'b', 'c']);
		expect(flat.map((f) => f.tab.tabId)).toEqual(['t1', 't1', 't2']);
	});
});
