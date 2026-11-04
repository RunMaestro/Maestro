/**
 * Tests for shared/normalizeChatDisplayMath.ts - pre-parse normalization of
 * multi-line `$$...$$` display math on chat surfaces (#622 follow-up).
 */

import { describe, it, expect } from 'vitest';
import { normalizeChatDisplayMath } from '../../shared/normalizeChatDisplayMath';

describe('normalizeChatDisplayMath', () => {
	it('moves hugging delimiters of a multi-line block onto their own lines', () => {
		const input = '$$\\begin{aligned}\na &= b\n\\end{aligned}$$';
		expect(normalizeChatDisplayMath(input)).toBe(
			'$$\n\\begin{aligned}\na &= b\n\\end{aligned}\n$$'
		);
	});

	it('leaves single-line $$...$$ untouched (inline -> promote path)', () => {
		const input = 'before $$x + y$$ after';
		expect(normalizeChatDisplayMath(input)).toBe(input);
	});

	it('is idempotent for blocks already on their own lines', () => {
		const input = '$$\n\\begin{aligned}\na &= b\n\\end{aligned}\n$$';
		expect(normalizeChatDisplayMath(input)).toBe(input);
	});

	it('normalizes only the opening delimiter when the close is already clean', () => {
		const input = '$$\\begin{aligned}\na &= b\n\\end{aligned}\n$$';
		expect(normalizeChatDisplayMath(input)).toBe(
			'$$\n\\begin{aligned}\na &= b\n\\end{aligned}\n$$'
		);
	});

	it('normalizes multiple multi-line blocks independently', () => {
		const input = '$$a\nb$$\n\ntext\n\n$$c\nd$$';
		expect(normalizeChatDisplayMath(input)).toBe('$$\na\nb\n$$\n\ntext\n\n$$\nc\nd\n$$');
	});

	it('does not touch $$ inside a fenced code block', () => {
		const input = '```\n$$a\nb$$\n```';
		expect(normalizeChatDisplayMath(input)).toBe(input);
	});

	it('does not touch $$ inside a tilde-fenced code block', () => {
		const input = '~~~\n$$a\nb$$\n~~~';
		expect(normalizeChatDisplayMath(input)).toBe(input);
	});

	it('does not touch $$ inside an inline code span', () => {
		const input = 'use `$$a$$` literally';
		expect(normalizeChatDisplayMath(input)).toBe(input);
	});

	it('returns input unchanged when there is no $$', () => {
		const input = 'plain text with $5 and $HOME';
		expect(normalizeChatDisplayMath(input)).toBe(input);
	});

	it('leaves an unbalanced trailing $$ alone', () => {
		const input = '$$a\nb$$ tail $$';
		// First pair (multi-line) is normalized; the lone trailing $$ is left.
		expect(normalizeChatDisplayMath(input)).toBe('$$\na\nb\n$$ tail $$');
	});

	it('trims spaces hugging the delimiters but preserves inner newlines', () => {
		const input = '$$  a\nb  $$';
		expect(normalizeChatDisplayMath(input)).toBe('$$\na\nb\n$$');
	});
});
