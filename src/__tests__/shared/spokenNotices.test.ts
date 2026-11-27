/**
 * @file spokenNotices.test.ts
 *
 * The pure half of spoken notices: the setting's vocabulary, the gate, the
 * line that needs no model, the input a model is shown, and the cleanup of
 * what it wrote.
 */

import { describe, it, expect } from 'vitest';

import {
	SPOKEN_NOTICE_MAX_CHARS,
	asSpokenNoticeMode,
	boundAgentFinishedNotice,
	cleanSpokenText,
	composeNoticeLine,
	fallbackNoticeLine,
	formatSpokenNoticeInput,
	isSpokenNoticeMode,
	parseAgentFinishedNotice,
	parseSpokenNoticeReply,
	shouldSpeakNotice,
} from '../../shared/spokenNotices';

describe('the spokenNotices setting', () => {
	it('knows its three modes', () => {
		expect(isSpokenNoticeMode('off')).toBe(true);
		expect(isSpokenNoticeMode('unfocused')).toBe(true);
		expect(isSpokenNoticeMode('always')).toBe(true);
		expect(isSpokenNoticeMode('sometimes')).toBe(false);
	});

	it('reads anything it does not know as off, because speaking is consent', () => {
		expect(asSpokenNoticeMode('always')).toBe('always');
		expect(asSpokenNoticeMode(true)).toBe('off');
		expect(asSpokenNoticeMode('ALWAYS')).toBe('off');
		expect(asSpokenNoticeMode(undefined)).toBe('off');
	});
});

describe('shouldSpeakNotice', () => {
	it('never speaks when off', () => {
		expect(shouldSpeakNotice('off', false)).toBe(false);
		expect(shouldSpeakNotice('off', true)).toBe(false);
	});

	it('speaks only while Maestro is not focused in unfocused mode', () => {
		expect(shouldSpeakNotice('unfocused', false)).toBe(true);
		expect(shouldSpeakNotice('unfocused', true)).toBe(false);
	});

	it('speaks either way in always mode', () => {
		expect(shouldSpeakNotice('always', false)).toBe(true);
		expect(shouldSpeakNotice('always', true)).toBe(true);
	});
});

describe('fallbackNoticeLine', () => {
	it('names the agent and nothing else', () => {
		expect(fallbackNoticeLine('Backend')).toBe('Backend finished');
	});

	it('drops markup a voice would stumble on', () => {
		expect(fallbackNoticeLine('`api`_server')).toBe('api server finished');
	});

	it('has something to say when the agent has no name', () => {
		expect(fallbackNoticeLine('')).toBe('An agent finished');
		expect(fallbackNoticeLine(undefined)).toBe('An agent finished');
	});
});

describe('cleanSpokenText', () => {
	it('flattens text to one speakable line', () => {
		expect(cleanSpokenText('  **Done**:\n\n- tests `pass`  ')).toBe('Done : - tests pass');
	});

	it('speaks a markdown link as its label and drops bare URLs', () => {
		expect(cleanSpokenText('See [the PR](https://example.com/1) at https://example.com/2')).toBe(
			'See the PR at'
		);
	});

	it('drops fenced code', () => {
		expect(cleanSpokenText('Fixed it.\n```ts\nconst a = 1;\n```\nAll good.')).toBe(
			'Fixed it. All good.'
		);
	});

	it('cuts at a word, never mid-word', () => {
		const cleaned = cleanSpokenText('one two three four five six seven', 18);
		expect(cleaned).toBe('one two three four');
	});

	it('answers null when nothing is left to say', () => {
		expect(cleanSpokenText('   ')).toBeNull();
		expect(cleanSpokenText('```\ncode\n```')).toBeNull();
		expect(cleanSpokenText(42)).toBeNull();
	});
});

describe('composeNoticeLine', () => {
	it('puts the agent name in front of the summary', () => {
		expect(composeNoticeLine('Backend', 'tests pass, two files changed')).toBe(
			'Backend finished: tests pass, two files changed'
		);
	});

	it('strips the quotes and the trailing period a model adds', () => {
		expect(composeNoticeLine('Backend', '"tests pass."')).toBe('Backend finished: tests pass');
	});

	it('keeps the whole line inside the spoken cap', () => {
		const line = composeNoticeLine('Backend', 'word '.repeat(200));
		expect(line).not.toBeNull();
		expect(line!.length).toBeLessThanOrEqual(SPOKEN_NOTICE_MAX_CHARS);
		expect(line!.startsWith('Backend finished: word')).toBe(true);
	});

	it('answers null when the model wrote nothing usable', () => {
		expect(composeNoticeLine('Backend', '')).toBeNull();
		expect(composeNoticeLine('Backend', '```\nx\n```')).toBeNull();
		expect(composeNoticeLine('Backend', null)).toBeNull();
	});
});

describe('parseSpokenNoticeReply', () => {
	it('reads the summary field', () => {
		expect(parseSpokenNoticeReply({ summary: 'tests pass' })).toBe('tests pass');
	});

	it('answers null for anything else', () => {
		expect(parseSpokenNoticeReply({ summary: '  ' })).toBeNull();
		expect(parseSpokenNoticeReply({ line: 'tests pass' })).toBeNull();
		expect(parseSpokenNoticeReply('tests pass')).toBeNull();
		expect(parseSpokenNoticeReply(undefined)).toBeNull();
	});
});

describe('formatSpokenNoticeInput', () => {
	it('names the agent, the request, and the reply', () => {
		expect(
			formatSpokenNoticeInput({
				agentName: 'Backend',
				prompt: 'Fix the login test',
				response: 'Fixed. Tests pass.',
			})
		).toBe(
			"Agent: Backend\n\nThe request:\nFix the login test\n\nThe agent's reply:\nFixed. Tests pass."
		);
	});

	it('says so when there is no reply', () => {
		expect(formatSpokenNoticeInput({ agentName: 'Backend' })).toBe(
			"Agent: Backend\n\nThe agent's reply: (none)"
		);
	});

	it('keeps the END of a long reply, where an agent says what it did', () => {
		const input = formatSpokenNoticeInput({
			agentName: 'Backend',
			response: `${'x'.repeat(10_000)} THE END`,
		});
		expect(input.length).toBeLessThan(3000);
		expect(input.endsWith('THE END')).toBe(true);
		expect(input).toContain('[...]');
	});
});

describe('boundAgentFinishedNotice', () => {
	it('cuts the request and the reply down before they cross a process boundary', () => {
		const bounded = boundAgentFinishedNotice({
			agentName: 'Backend',
			prompt: 'p'.repeat(5000),
			response: 'r'.repeat(50_000),
		});
		expect(bounded.prompt!.length).toBeLessThan(500);
		expect(bounded.response!.length).toBeLessThan(2500);
	});

	it('leaves out what is empty', () => {
		expect(boundAgentFinishedNotice({ agentName: 'Backend', prompt: ' ', response: '' })).toEqual({
			agentName: 'Backend',
		});
	});
});

describe('parseAgentFinishedNotice', () => {
	it('accepts a well-formed report', () => {
		expect(
			parseAgentFinishedNotice({ agentName: 'Backend', prompt: 'p', response: 'r', extra: 1 })
		).toEqual({ agentName: 'Backend', prompt: 'p', response: 'r' });
	});

	it('refuses a report with no agent name', () => {
		expect(() => parseAgentFinishedNotice({})).toThrow(/agent name/);
		expect(() => parseAgentFinishedNotice({ agentName: '  ' })).toThrow(/agent name/);
		expect(() => parseAgentFinishedNotice(null)).toThrow(/agent name/);
	});

	it('refuses a field that is not text', () => {
		expect(() => parseAgentFinishedNotice({ agentName: 'Backend', response: 42 })).toThrow(
			/response must be a string/
		);
	});
});
