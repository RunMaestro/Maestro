import { describe, it, expect } from 'vitest';
import {
	AGENT_MENTION_PATTERN_SOURCE,
	formatFileMention,
	isFileMentionBody,
	mentionQuoteChar,
	stripMentionQuotes,
	tokenizeMentions,
	type MentionSegment,
} from '../../shared/mentionPatterns';

/** Reconstructing the input from segment values is the core overlay invariant. */
function reconstruct(segments: MentionSegment[]): string {
	return segments.map((s) => s.value).join('');
}

/** Roster used by the agent-mention cases below (lowercased, as callers pass). */
const KNOWN = new Set([
	'review-bot',
	'codex',
	'squad',
	'☁-substrate',
	'café-bot',
	'日本語-agent',
	'runmaestro.ai',
]);

describe('AGENT_MENTION_PATTERN_SOURCE', () => {
	it('matches @name (single at, case-insensitive, hyphens allowed)', () => {
		// The source uses \p{...} escapes, so it MUST be compiled with the `u` flag.
		const re = new RegExp(AGENT_MENTION_PATTERN_SOURCE, 'gu');
		expect('@review-bot @Codex'.match(re)).toEqual(['@review-bot', '@Codex']);
	});

	it('matches non-ASCII names (emoji, accented, CJK)', () => {
		const re = new RegExp(AGENT_MENTION_PATTERN_SOURCE, 'gu');
		expect('@☁-Substrate @café-Bot @日本語-agent'.match(re)).toEqual([
			'@☁-Substrate',
			'@café-Bot',
			'@日本語-agent',
		]);
	});
});

describe('isFileMentionBody', () => {
	it('accepts paths with a slash or a dotted extension', () => {
		expect(isFileMentionBody('src/main/index.ts')).toBe(true);
		expect(isFileMentionBody('notes.md')).toBe(true);
		expect(isFileMentionBody('src/main')).toBe(true);
	});
	it('rejects bare words', () => {
		expect(isFileMentionBody('todo')).toBe(false);
		expect(isFileMentionBody('review-bot')).toBe(false);
	});
});

describe('formatFileMention', () => {
	it('leaves a space-free path bare', () => {
		expect(formatFileMention('src/main/index.ts')).toBe('@src/main/index.ts');
	});

	it('quotes a path that carries spaces', () => {
		expect(formatFileMention('Meetings/MEET-07-13 - Diagnostics App.md')).toBe(
			'@"Meetings/MEET-07-13 - Diagnostics App.md"'
		);
	});

	it('falls back to single quotes when the path itself holds a double quote', () => {
		expect(formatFileMention('odd/say "hi" here.md')).toBe(`@'odd/say "hi" here.md'`);
	});

	it('emits a path holding BOTH quote characters bare rather than mis-delimiting it', () => {
		const path = `odd/it's "quoted".md`;
		expect(formatFileMention(path)).toBe(`@${path}`);
	});

	it('round-trips through the tokenizer for a spaced path', () => {
		const path = 'Meetings/MEET-07-13 - Diagnostics App.md';
		const segments = tokenizeMentions(formatFileMention(path));
		expect(segments).toEqual([
			{
				kind: 'file',
				value: `@"${path}"`,
				path,
				extension: 'md',
			},
		]);
	});
});

describe('mentionQuoteChar / stripMentionQuotes', () => {
	it('reports the opening quote of a quoted filter', () => {
		expect(mentionQuoteChar('"my no')).toBe('"');
		expect(mentionQuoteChar("'my no")).toBe("'");
		expect(mentionQuoteChar('src/in')).toBeNull();
	});

	it('bares a filter for searching, closed or not', () => {
		expect(stripMentionQuotes('"my notes')).toBe('my notes');
		expect(stripMentionQuotes('"my notes.md"')).toBe('my notes.md');
		expect(stripMentionQuotes('src/index.ts')).toBe('src/index.ts');
		expect(stripMentionQuotes('"')).toBe('');
	});
});

describe('tokenizeMentions', () => {
	it('returns [] for empty input', () => {
		expect(tokenizeMentions('')).toEqual([]);
	});

	it('returns a single text segment when there are no mentions', () => {
		expect(tokenizeMentions('just some prose')).toEqual([
			{ kind: 'text', value: 'just some prose' },
		]);
	});

	it('tokenizes a known agent mention (single @)', () => {
		expect(tokenizeMentions('hey @review-bot look', KNOWN)).toEqual([
			{ kind: 'text', value: 'hey ' },
			{ kind: 'agent', value: '@review-bot', name: 'review-bot' },
			{ kind: 'text', value: ' look' },
		]);
	});

	it('tokenizes an emoji-named agent (the @☁-Substrate regression)', () => {
		expect(tokenizeMentions('hey @☁-Substrate ping', KNOWN)).toEqual([
			{ kind: 'text', value: 'hey ' },
			{ kind: 'agent', value: '@☁-Substrate', name: '☁-Substrate' },
			{ kind: 'text', value: ' ping' },
		]);
	});

	it('tokenizes accented and CJK agent names', () => {
		expect(tokenizeMentions('ask @café-Bot and @日本語-agent', KNOWN)).toEqual([
			{ kind: 'text', value: 'ask ' },
			{ kind: 'agent', value: '@café-Bot', name: 'café-Bot' },
			{ kind: 'text', value: ' and ' },
			{ kind: 'agent', value: '@日本語-agent', name: '日本語-agent' },
		]);
	});

	it('reconstructs input containing a non-ASCII mention', () => {
		const input = 'hey @☁-Substrate, what is up?';
		expect(reconstruct(tokenizeMentions(input, KNOWN))).toBe(input);
	});

	it('leaves a bare @word that is NOT a known agent as plain text', () => {
		expect(tokenizeMentions('hey @nobody look', KNOWN)).toEqual([
			{ kind: 'text', value: 'hey @nobody look' },
		]);
	});

	it('never treats a bare @word as an agent without a roster', () => {
		expect(tokenizeMentions('hey @review-bot look')).toEqual([
			{ kind: 'text', value: 'hey @review-bot look' },
		]);
	});

	it('chips a dotted agent name as an agent, not a file (the @RunMaestro.ai regression)', () => {
		// `RunMaestro.ai` is path-shaped (dotted extension) but names a known agent,
		// so the roster wins and it must chip as an agent - otherwise the mention is
		// silently dropped from dispatch.
		expect(tokenizeMentions('ping @RunMaestro.ai now', KNOWN)).toEqual([
			{ kind: 'text', value: 'ping ' },
			{ kind: 'agent', value: '@RunMaestro.ai', name: 'RunMaestro.ai' },
			{ kind: 'text', value: ' now' },
		]);
	});

	it('still chips a dotted body as a file when it is NOT a known agent', () => {
		// No roster entry for `notes.md`, so the shape classification stands.
		expect(tokenizeMentions('open @notes.md please', KNOWN)).toEqual([
			{ kind: 'text', value: 'open ' },
			{ kind: 'file', value: '@notes.md', path: 'notes.md', extension: 'md' },
			{ kind: 'text', value: ' please' },
		]);
	});

	it('routes all three mentions when one agent name carries a dot', () => {
		// The exact reported case: three @mentions where the middle name has a dot.
		const roster = new Set(['maestro-marketing', 'runmaestro.ai', 'pedtome-pedsidian']);
		const input = 'next? @Maestro-Marketing @RunMaestro.ai @PedTome-Pedsidian';
		const agents = tokenizeMentions(input, roster).filter((s) => s.kind === 'agent');
		expect(agents.map((s) => (s.kind === 'agent' ? s.name : ''))).toEqual([
			'Maestro-Marketing',
			'RunMaestro.ai',
			'PedTome-Pedsidian',
		]);
		expect(reconstruct(tokenizeMentions(input, roster))).toBe(input);
	});

	it('tokenizes a file mention and captures the extension', () => {
		expect(tokenizeMentions('see @src/main/index.ts here', KNOWN)).toEqual([
			{ kind: 'text', value: 'see ' },
			{ kind: 'file', value: '@src/main/index.ts', path: 'src/main/index.ts', extension: 'ts' },
			{ kind: 'text', value: ' here' },
		]);
	});

	it('chips a dotted file with no slash', () => {
		const segs = tokenizeMentions('@notes.md');
		expect(segs).toEqual([{ kind: 'file', value: '@notes.md', path: 'notes.md', extension: 'md' }]);
	});

	it('leaves a bare @word as plain text', () => {
		expect(tokenizeMentions('@todo later', KNOWN)).toEqual([
			{ kind: 'text', value: '@todo later' },
		]);
	});

	it('tokenizes a quoted file mention whole, spaces and all', () => {
		const input = 'read @"Meetings/MEET-07-13 - Diagnostics App.md" then reply';
		expect(tokenizeMentions(input, KNOWN)).toEqual([
			{ kind: 'text', value: 'read ' },
			{
				kind: 'file',
				value: '@"Meetings/MEET-07-13 - Diagnostics App.md"',
				path: 'Meetings/MEET-07-13 - Diagnostics App.md',
				extension: 'md',
			},
			{ kind: 'text', value: ' then reply' },
		]);
		// The overlay invariant still holds: segments concatenate back to the input.
		expect(reconstruct(tokenizeMentions(input, KNOWN))).toBe(input);
	});

	it('keeps the closing quote of a quoted mention (never trims it as punctuation)', () => {
		const [seg] = tokenizeMentions('@"my notes.md"');
		expect(seg).toEqual({
			kind: 'file',
			value: '@"my notes.md"',
			path: 'my notes.md',
			extension: 'md',
		});
	});

	it('accepts a single-quoted body too', () => {
		expect(tokenizeMentions(`open @'my notes.md'`)).toEqual([
			{ kind: 'text', value: 'open ' },
			{ kind: 'file', value: `@'my notes.md'`, path: 'my notes.md', extension: 'md' },
		]);
	});

	it('leaves an unclosed quoted mention as plain text', () => {
		// Mid-typing state: nothing chips until the quote closes, and the unclosed
		// quote never swallows the rest of the message.
		expect(tokenizeMentions('@"my notes and more prose', KNOWN)).toEqual([
			{ kind: 'text', value: '@"my notes and more prose' },
		]);
	});

	it('skips mid-word mentions (foo@bar, email@host)', () => {
		expect(tokenizeMentions('foo@bar', KNOWN)).toEqual([{ kind: 'text', value: 'foo@bar' }]);
		expect(tokenizeMentions('me@example.com', KNOWN)).toEqual([
			{ kind: 'text', value: 'me@example.com' },
		]);
	});

	it('does not treat a URL/path segment (host/@codex) as a mention', () => {
		// `/` before `@` glues it to the path, so a known agent name embedded in a
		// URL must not light up as an agent mention.
		expect(tokenizeMentions('see https://github.com/@codex/repo', KNOWN)).toEqual([
			{ kind: 'text', value: 'see https://github.com/@codex/repo' },
		]);
		expect(tokenizeMentions('path is ./@codex', KNOWN)).toEqual([
			{ kind: 'text', value: 'path is ./@codex' },
		]);
	});

	it('escapes a mention when the name is quoted or backticked', () => {
		// A quote/backtick immediately before `@` is the user opting out of a
		// lookup, so `"@codex"`, `'@codex'`, and `` `@codex` `` stay plain text.
		for (const wrap of ['"', "'", '`', '‘', '“']) {
			expect(tokenizeMentions(`say ${wrap}@codex${wrap}`, KNOWN)).toEqual([
				{ kind: 'text', value: `say ${wrap}@codex${wrap}` },
			]);
		}
		// A quoted file body is likewise left literal.
		expect(tokenizeMentions('open `@docs/releases.md`', KNOWN)).toEqual([
			{ kind: 'text', value: 'open `@docs/releases.md`' },
		]);
	});

	it('trims trailing sentence punctuation off a file mention', () => {
		expect(tokenizeMentions('open @docs/releases.md.', KNOWN)).toEqual([
			{ kind: 'text', value: 'open ' },
			{ kind: 'file', value: '@docs/releases.md', path: 'docs/releases.md', extension: 'md' },
			{ kind: 'text', value: '.' },
		]);
	});

	it('chips a known agent even with trailing sentence punctuation', () => {
		expect(tokenizeMentions('ask @codex.', KNOWN)).toEqual([
			{ kind: 'text', value: 'ask ' },
			{ kind: 'agent', value: '@codex', name: 'codex' },
			{ kind: 'text', value: '.' },
		]);
	});

	it('handles a sentence mixing agent + two file mentions', () => {
		const input = 'ask @codex about @src/main/cue/cue-engine.ts and @docs/releases.md';
		const segs = tokenizeMentions(input, KNOWN);
		expect(segs.filter((s) => s.kind === 'agent')).toHaveLength(1);
		expect(segs.filter((s) => s.kind === 'file')).toHaveLength(2);
		// Full round-trip: segments concatenate back to the exact input.
		expect(reconstruct(segs)).toBe(input);
	});

	it('always reconstructs the original input from segment values', () => {
		for (const input of [
			'',
			'plain',
			'@codex @b/c.ts @nope end.',
			'edge @@triple and me@x.com',
			'@src/x.ts,@codex',
		]) {
			expect(reconstruct(tokenizeMentions(input, KNOWN))).toBe(input);
		}
	});
});
