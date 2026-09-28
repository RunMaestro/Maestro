/**
 * @file prompt-echo.test.ts
 * @description Tests for src/maestro-p/prompt-echo.ts - the check that the
 * prompt claude logged is the prompt maestro-p typed into its TUI.
 */

import { describe, expect, it } from 'vitest';

import {
	checkPromptEcho,
	isPromptEchoVerifiable,
	normalizePromptForEcho,
	promptEchoText,
} from '../../maestro-p/prompt-echo';

// A multi-paragraph prompt comfortably larger than a PTY input queue (1,022 bytes).
function longPrompt(): string {
	const paragraphs: string[] = [];
	for (let i = 0; i < 40; i += 1) {
		paragraphs.push(`Rule ${i}: keep paragraph ${i} intact, it matters to the run.`);
	}
	return paragraphs.join('\n\n');
}

describe('normalizePromptForEcho', () => {
	it('drops whitespace and control characters, keeping content', () => {
		expect(normalizePromptForEcho(' a b\r\n\tc\x00d\x7f ')).toBe('abcd');
	});
});

describe('isPromptEchoVerifiable', () => {
	it('accepts ordinary prompts', () => {
		expect(isPromptEchoVerifiable('Summarize the diff')).toBe(true);
	});

	it('skips slash commands and bash-mode input, which claude rewrites before logging', () => {
		expect(isPromptEchoVerifiable('/compact')).toBe(false);
		expect(isPromptEchoVerifiable('  !ls -la')).toBe(false);
	});

	it('skips blank prompts', () => {
		expect(isPromptEchoVerifiable(' \n\t')).toBe(false);
	});
});

describe('promptEchoText', () => {
	it('returns string content of a plain user row', () => {
		expect(promptEchoText({ type: 'user', message: { role: 'user', content: 'hello' } })).toBe(
			'hello'
		);
	});

	it('joins text blocks of an array-content user row', () => {
		const entry = {
			type: 'user',
			message: {
				content: [
					{ type: 'text', text: 'first ' },
					{ type: 'image', source: {} },
					{ type: 'text', text: 'second' },
				],
			},
		};
		expect(promptEchoText(entry)).toBe('first second');
	});

	it('returns null for rows that are not a typed prompt', () => {
		expect(promptEchoText({ type: 'assistant', message: { content: 'hi' } })).toBeNull();
		expect(promptEchoText({ type: 'user', isMeta: true, message: { content: 'ctx' } })).toBeNull();
		expect(
			promptEchoText({ type: 'user', isCompactSummary: true, message: { content: 'sum' } })
		).toBeNull();
		expect(
			promptEchoText({
				type: 'user',
				message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
			})
		).toBeNull();
		expect(
			promptEchoText({ type: 'user', message: { content: [{ type: 'image', source: {} }] } })
		).toBeNull();
		expect(promptEchoText({ type: 'user' })).toBeNull();
	});
});

describe('checkPromptEcho', () => {
	it('passes when claude logged exactly what was typed', () => {
		const prompt = longPrompt();
		expect(checkPromptEcho(prompt, prompt)).toBeNull();
	});

	it('passes when the editor only changed whitespace (trimmed, CRLF, re-wrapped)', () => {
		const prompt = `${longPrompt()}\n`;
		const logged = prompt.replace(/\n/g, '\r\n').replace(/: /g, ':  ').trim();
		expect(checkPromptEcho(prompt, logged)).toBeNull();
	});

	it('fails on the Cue failure: a 1,022-byte hole in the middle of the prompt', () => {
		const prompt = longPrompt();
		const holeStart = 900;
		const logged = prompt.slice(0, holeStart) + prompt.slice(holeStart + 1022);
		const mismatch = checkPromptEcho(prompt, logged);
		expect(mismatch).not.toBeNull();
		expect(mismatch!.sentBytes - mismatch!.receivedBytes).toBe(1022);
		// The snippet starts where claude stopped receiving the prompt.
		const expected = prompt
			.slice(holeStart, holeStart + 80)
			.replace(/\s+/g, ' ')
			.trim();
		expect(mismatch!.missingFrom.startsWith(expected.slice(0, 20))).toBe(true);
	});

	it('fails when the head of the prompt was lost', () => {
		const prompt = longPrompt();
		const mismatch = checkPromptEcho(prompt, prompt.slice(1022));
		expect(mismatch).not.toBeNull();
		expect(mismatch!.missingFrom.startsWith('Rule 0:')).toBe(true);
	});

	it('fails when the tail of the prompt was lost', () => {
		const prompt = longPrompt();
		expect(checkPromptEcho(prompt, prompt.slice(0, prompt.length - 1022))).not.toBeNull();
	});
});
