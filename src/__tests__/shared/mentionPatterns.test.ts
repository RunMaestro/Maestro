import { describe, it, expect } from 'vitest';
import {
	AGENT_MENTION_PATTERN_SOURCE,
	isFileMentionBody,
	tokenizeMentions,
	type MentionSegment,
} from '../../shared/mentionPatterns';

/** Reconstructing the input from segment values is the core overlay invariant. */
function reconstruct(segments: MentionSegment[]): string {
	return segments.map((s) => s.value).join('');
}

describe('AGENT_MENTION_PATTERN_SOURCE', () => {
	it('matches @@name (case-insensitive, hyphens allowed)', () => {
		const re = new RegExp(AGENT_MENTION_PATTERN_SOURCE, 'g');
		expect('@@review-bot @@Codex'.match(re)).toEqual(['@@review-bot', '@@Codex']);
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

describe('tokenizeMentions', () => {
	it('returns [] for empty input', () => {
		expect(tokenizeMentions('')).toEqual([]);
	});

	it('returns a single text segment when there are no mentions', () => {
		expect(tokenizeMentions('just some prose')).toEqual([
			{ kind: 'text', value: 'just some prose' },
		]);
	});

	it('tokenizes an agent mention', () => {
		expect(tokenizeMentions('hey @@review-bot look')).toEqual([
			{ kind: 'text', value: 'hey ' },
			{ kind: 'agent', value: '@@review-bot', name: 'review-bot' },
			{ kind: 'text', value: ' look' },
		]);
	});

	it('tokenizes a file mention and captures the extension', () => {
		expect(tokenizeMentions('see @src/main/index.ts here')).toEqual([
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
		expect(tokenizeMentions('@todo later')).toEqual([{ kind: 'text', value: '@todo later' }]);
	});

	it('skips mid-word mentions (foo@@bar, email@host)', () => {
		expect(tokenizeMentions('foo@@bar')).toEqual([{ kind: 'text', value: 'foo@@bar' }]);
		expect(tokenizeMentions('me@example.com')).toEqual([{ kind: 'text', value: 'me@example.com' }]);
	});

	it('trims trailing sentence punctuation off a file mention', () => {
		expect(tokenizeMentions('open @docs/releases.md.')).toEqual([
			{ kind: 'text', value: 'open ' },
			{ kind: 'file', value: '@docs/releases.md', path: 'docs/releases.md', extension: 'md' },
			{ kind: 'text', value: '.' },
		]);
	});

	it('handles a sentence mixing agent + two file mentions', () => {
		const input = 'ask @@codex about @src/main/cue/cue-engine.ts and @docs/releases.md';
		const segs = tokenizeMentions(input);
		expect(segs.filter((s) => s.kind === 'agent')).toHaveLength(1);
		expect(segs.filter((s) => s.kind === 'file')).toHaveLength(2);
		// Full round-trip: segments concatenate back to the exact input.
		expect(reconstruct(segs)).toBe(input);
	});

	it('always reconstructs the original input from segment values', () => {
		for (const input of [
			'',
			'plain',
			'@@a @b/c.ts @nope end.',
			'edge @@@triple and me@x.com',
			'@src/x.ts,@@codex',
		]) {
			expect(reconstruct(tokenizeMentions(input))).toBe(input);
		}
	});
});
