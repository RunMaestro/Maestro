/**
 * Tests for cross-agent @mention parsing and context-window heuristics.
 *
 * @file src/shared/crossAgentContext.ts
 */

import { describe, it, expect } from 'vitest';
import {
	parseAgentMentions,
	messageStartsWithAgentMention,
	inferContextStrategy,
	selectContextWindow,
	deriveConsultSubject,
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

	it('parses a single mention (single @)', () => {
		expect(parseAgentMentions('hey @review-bot look at this')).toEqual([
			{ token: '@review-bot', mentionName: 'review-bot', startIndex: 4, endIndex: 15 },
		]);
	});

	it('parses multiple mentions in one message', () => {
		const result = parseAgentMentions('cc @alice and @bob');
		expect(result.map((m) => m.mentionName)).toEqual(['alice', 'bob']);
	});

	it('parses "@a @b @c-d-e" as three mentions', () => {
		const result = parseAgentMentions('@a @b @c-d-e');
		expect(result.map((m) => m.mentionName)).toEqual(['a', 'b', 'c-d-e']);
	});

	it('ignores a single "@"', () => {
		expect(parseAgentMentions('email me @ noon')).toEqual([]);
	});

	it('skips a file-shaped body (path or dotted extension), not an agent', () => {
		expect(parseAgentMentions('see @src/main/index.ts')).toEqual([]);
		expect(parseAgentMentions('open @notes.md now')).toEqual([]);
	});

	it('parses a dotted agent name when it is in the roster (the @RunMaestro.ai regression)', () => {
		const roster = new Set(['runmaestro.ai']);
		const result = parseAgentMentions('ping @RunMaestro.ai now', roster);
		expect(result.map((m) => m.mentionName)).toEqual(['RunMaestro.ai']);
		// Slice bounds still map back to the exact token.
		const [mention] = result;
		expect('ping @RunMaestro.ai now'.slice(mention.startIndex, mention.endIndex)).toBe(
			'@RunMaestro.ai'
		);
	});

	it('parses all three mentions when the middle agent name carries a dot', () => {
		const roster = new Set(['maestro-marketing', 'runmaestro.ai', 'pedtome-pedsidian']);
		const result = parseAgentMentions(
			'next? @Maestro-Marketing @RunMaestro.ai @PedTome-Pedsidian',
			roster
		);
		expect(result.map((m) => m.mentionName)).toEqual([
			'Maestro-Marketing',
			'RunMaestro.ai',
			'PedTome-Pedsidian',
		]);
	});

	it('still skips a dotted body that is NOT in the roster', () => {
		expect(parseAgentMentions('open @notes.md now', new Set(['runmaestro.ai']))).toEqual([]);
	});

	it('skips mid-word mentions like "foo@bar"', () => {
		expect(parseAgentMentions('foo@bar')).toEqual([]);
	});

	it('does not dispatch a mention embedded in a URL/path (host/@name)', () => {
		expect(parseAgentMentions('see https://github.com/@codex')).toEqual([]);
		expect(parseAgentMentions('open ./@codex')).toEqual([]);
	});

	it('skips malformed "@@" and "@@@" runs rather than crashing', () => {
		expect(parseAgentMentions('@@double')).toEqual([]);
		expect(parseAgentMentions('@@@triple')).toEqual([]);
	});

	it('captures capitalized names (matches normalizeMentionName output)', () => {
		const result = parseAgentMentions('ping @Review-Bot now');
		expect(result.map((m) => m.mentionName)).toEqual(['Review-Bot']);
	});

	it('produces index ranges that slice back to the token', () => {
		const input = 'hi @bob bye';
		const [mention] = parseAgentMentions(input);
		expect(input.slice(mention.startIndex, mention.endIndex)).toBe(mention.token);
		expect(mention.token).toBe('@bob');
	});
});

// ============================================================================
// messageStartsWithAgentMention (gates "route to remote agents only")
// ============================================================================

describe('messageStartsWithAgentMention', () => {
	it('is true when an agent mention leads the message', () => {
		expect(messageStartsWithAgentMention('@Backend what do you think?')).toBe(true);
		expect(messageStartsWithAgentMention('@review-bot @codex thoughts?')).toBe(true);
	});

	it('ignores leading whitespace before the mention', () => {
		expect(messageStartsWithAgentMention('   @Backend hi')).toBe(true);
	});

	it('is false when the mention appears later in the message', () => {
		expect(messageStartsWithAgentMention('hey @Backend, thoughts?')).toBe(false);
	});

	it('is false when the message leads with a FILE mention (a local question)', () => {
		expect(messageStartsWithAgentMention('@src/app.ts explain this')).toBe(false);
		expect(messageStartsWithAgentMention('@notes.md summarize')).toBe(false);
	});

	it('is true when the leading agent name carries a dot and is in the roster', () => {
		const roster = new Set(['runmaestro.ai']);
		expect(messageStartsWithAgentMention('@RunMaestro.ai fix this', roster)).toBe(true);
		// Without the roster the dotted name reads as a file, so the local send stands.
		expect(messageStartsWithAgentMention('@RunMaestro.ai fix this')).toBe(false);
	});

	it('is false for plain text and empty input', () => {
		expect(messageStartsWithAgentMention('just some prose')).toBe(false);
		expect(messageStartsWithAgentMention('')).toBe(false);
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
		expect(inferContextStrategy('@bob can you help')).toEqual({ kind: 'full' });
	});

	it('recognizes "share the last 10 messages with @b" as recent-messages: 10', () => {
		expect(inferContextStrategy('share the last 10 messages with @b')).toEqual({
			kind: 'recent-messages',
			messages: 10,
		});
	});

	it('recognizes "last 3 turns" as recent-turns: 3', () => {
		expect(inferContextStrategy('send the last 3 turns to @b')).toEqual({
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
		expect(inferContextStrategy('share the last 4 with @b')).toEqual({
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

	it('recognizes "pull @b in on this recent matter" as recent-turns: 5', () => {
		expect(inferContextStrategy('pull @b in on this recent matter')).toEqual({
			kind: 'recent-turns',
			turns: DEFAULT_RECENT_TURNS,
		});
	});

	it('recognizes "most recent" as a soft recent-turns hint', () => {
		expect(inferContextStrategy('@b the most recent stuff is relevant')).toEqual({
			kind: 'recent-turns',
			turns: DEFAULT_RECENT_TURNS,
		});
	});

	it('lets an explicit number override a soft hint when both are present', () => {
		expect(inferContextStrategy('@b share the last 3 messages about this thread')).toEqual({
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

describe('deriveConsultSubject', () => {
	it('strips a leading @mention and keeps the prose', () => {
		expect(deriveConsultSubject('@rc which branch should I build the drafts feature on?')).toBe(
			'which branch should I build the drafts feature on?'
		);
	});

	it('strips mid-sentence mentions and collapses whitespace', () => {
		expect(deriveConsultSubject('hey @Backend,   thoughts   on\nthe API?')).toBe(
			'hey , thoughts on the API?'
		);
	});

	it('truncates past maxLen with an ellipsis', () => {
		const subject = deriveConsultSubject('@rc ' + 'a'.repeat(100), 10);
		expect(subject).toBe('aaaaaaaaa…');
		expect(subject.length).toBe(10);
	});

	it('returns empty string when only a mention with no prose', () => {
		expect(deriveConsultSubject('@rc')).toBe('');
		expect(deriveConsultSubject('   @rc   ')).toBe('');
	});
});
