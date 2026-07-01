/**
 * Tests for cross-agent @@mention parsing and context-window heuristics.
 *
 * @file src/shared/crossAgentContext.ts
 */

import { describe, it, expect } from 'vitest';
import {
	parseAgentMentions,
	inferContextStrategy,
	selectContextWindow,
	DEFAULT_RECENT_TURNS,
} from '../../shared/crossAgentContext';
import type { LogEntry } from '../../renderer/types';

// Minimal LogEntry factory - only the fields the heuristics read matter.
function log(id: string, source: LogEntry['source'], text = id): LogEntry {
	return { id, source, text, timestamp: 0 };
}

// ============================================================================
// parseAgentMentions
// ============================================================================

describe('parseAgentMentions', () => {
	it('returns [] for an empty string', () => {
		expect(parseAgentMentions('')).toEqual([]);
	});

	it('parses a single mention', () => {
		expect(parseAgentMentions('hey @@review-bot look at this')).toEqual([
			{ token: '@@review-bot', mentionName: 'review-bot', startIndex: 4, endIndex: 16 },
		]);
	});

	it('parses multiple mentions in one message', () => {
		const result = parseAgentMentions('cc @@alice and @@bob');
		expect(result.map((m) => m.mentionName)).toEqual(['alice', 'bob']);
	});

	it('parses "@@a @@b @@c-d-e" as three mentions', () => {
		const result = parseAgentMentions('@@a @@b @@c-d-e');
		expect(result.map((m) => m.mentionName)).toEqual(['a', 'b', 'c-d-e']);
	});

	it('ignores a single "@"', () => {
		expect(parseAgentMentions('email me @ noon')).toEqual([]);
	});

	it('skips mid-word mentions like "foo@@bar"', () => {
		expect(parseAgentMentions('foo@@bar')).toEqual([]);
	});

	it('skips malformed "@@@" and "@@@@" runs rather than crashing', () => {
		expect(parseAgentMentions('@@@triple')).toEqual([]);
		expect(parseAgentMentions('@@@@quad')).toEqual([]);
	});

	it('captures capitalized names (matches normalizeMentionName output)', () => {
		const result = parseAgentMentions('ping @@Review-Bot now');
		expect(result.map((m) => m.mentionName)).toEqual(['Review-Bot']);
	});

	it('produces index ranges that slice back to the token', () => {
		const input = 'hi @@bob bye';
		const [mention] = parseAgentMentions(input);
		expect(input.slice(mention.startIndex, mention.endIndex)).toBe(mention.token);
		expect(mention.token).toBe('@@bob');
	});
});

// ============================================================================
// inferContextStrategy
// ============================================================================

describe('inferContextStrategy', () => {
	it('returns "full" for a plain message', () => {
		expect(inferContextStrategy('take a look at the login bug')).toEqual({ kind: 'full' });
	});

	it('returns "full" for a message that only contains a mention', () => {
		expect(inferContextStrategy('@@bob can you help')).toEqual({ kind: 'full' });
	});

	it('recognizes "share the last 10 messages with @@b" as recent-messages: 10', () => {
		expect(inferContextStrategy('share the last 10 messages with @@b')).toEqual({
			kind: 'recent-messages',
			messages: 10,
		});
	});

	it('recognizes "last 3 turns" as recent-turns: 3', () => {
		expect(inferContextStrategy('send the last 3 turns to @@b')).toEqual({
			kind: 'recent-turns',
			turns: 3,
		});
	});

	it('recognizes "last 2 exchanges" as recent-turns: 2', () => {
		expect(inferContextStrategy('forward the last 2 exchanges')).toEqual({
			kind: 'recent-turns',
			turns: 2,
		});
	});

	it('treats a unit-less "share the last 4" as recent-messages: 4', () => {
		expect(inferContextStrategy('share the last 4 with @@b')).toEqual({
			kind: 'recent-messages',
			messages: 4,
		});
	});

	it('matches case-insensitively', () => {
		expect(inferContextStrategy('SHARE THE LAST 5 MESSAGES')).toEqual({
			kind: 'recent-messages',
			messages: 5,
		});
	});

	it('recognizes "pull @@b in on this recent matter" as recent-turns: 5', () => {
		expect(inferContextStrategy('pull @@b in on this recent matter')).toEqual({
			kind: 'recent-turns',
			turns: DEFAULT_RECENT_TURNS,
		});
	});

	it('recognizes "most recent" as a soft recent-turns hint', () => {
		expect(inferContextStrategy('@@b the most recent stuff is relevant')).toEqual({
			kind: 'recent-turns',
			turns: DEFAULT_RECENT_TURNS,
		});
	});

	it('lets an explicit number override a soft hint when both are present', () => {
		expect(inferContextStrategy('@@b share the last 3 messages about this thread')).toEqual({
			kind: 'recent-messages',
			messages: 3,
		});
	});
});

// ============================================================================
// selectContextWindow
// ============================================================================

describe('selectContextWindow', () => {
	it('returns a shallow clone (not the input reference) for "full"', () => {
		const logs = [log('u1', 'user'), log('a1', 'ai')];
		const result = selectContextWindow(logs, { kind: 'full' });
		expect(result).not.toBe(logs);
		expect(result).toEqual(logs);
	});

	it('returns the last 3 conversational entries plus interleaved tool entries', () => {
		// 2 users + 2 ai + 1 tool. Conversational: u1, a1, u2, a2.
		const logs = [
			log('u1', 'user'),
			log('a1', 'ai'),
			log('u2', 'user'),
			log('t1', 'tool'),
			log('a2', 'ai'),
		];
		const result = selectContextWindow(logs, { kind: 'recent-messages', messages: 3 });
		// Last 3 conversational are a1, u2, a2; t1 falls inside the window.
		expect(result.map((e) => e.id)).toEqual(['a1', 'u2', 't1', 'a2']);
	});

	it('returns the most recent user+ai pair for recent-turns: 1', () => {
		const logs = [log('u1', 'user'), log('a1', 'ai'), log('u2', 'user'), log('a2', 'ai')];
		const result = selectContextWindow(logs, { kind: 'recent-turns', turns: 1 });
		expect(result.map((e) => e.id)).toEqual(['u2', 'a2']);
	});

	it('returns the whole transcript when fewer conversational entries exist than requested', () => {
		const logs = [log('u1', 'user'), log('a1', 'ai')];
		const result = selectContextWindow(logs, { kind: 'recent-messages', messages: 5 });
		expect(result.map((e) => e.id)).toEqual(['u1', 'a1']);
	});

	it('returns [] for a non-positive count', () => {
		const logs = [log('u1', 'user'), log('a1', 'ai')];
		expect(selectContextWindow(logs, { kind: 'recent-messages', messages: 0 })).toEqual([]);
	});
});
