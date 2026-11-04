// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/maestro-p/plan-mode.test.ts
// Source: src/__tests__/maestro-p/timeout-report.test.ts
// Source: src/__tests__/maestro-p/prompt-echo.test.ts
import { describe, it, expect } from 'vitest';
import { extractExitPlanText } from '../../maestro-p/plan-mode';
import {
	formatScreenTailReport,
	idleTimeoutMessage,
	readyTimeoutMessage,
} from '../../maestro-p/timeout-report';
import {
	checkPromptEcho,
	isPromptEchoVerifiable,
	normalizePromptForEcho,
	promptEchoText,
} from '../../maestro-p/prompt-echo';
// Source: src/__tests__/maestro-p/plan-mode.test.ts
describe('', () => {
	describe('extractExitPlanText', () => {
		it('returns the plan body when the message calls ExitPlanMode', () => {
			const message = {
				stop_reason: 'tool_use',
				content: [
					{ type: 'text', text: 'Here is what I found.' },
					{ type: 'tool_use', name: 'ExitPlanMode', input: { plan: 'Step 1. Do the thing.' } },
				],
			};
			expect(extractExitPlanText(message)).toBe('Step 1. Do the thing.');
		});
		it('returns an empty string when ExitPlanMode is present without a plan body', () => {
			const message = {
				content: [{ type: 'tool_use', name: 'ExitPlanMode', input: {} }],
			};
			expect(extractExitPlanText(message)).toBe('');
		});
		it('returns an empty string when the plan input is not a string', () => {
			const message = {
				content: [{ type: 'tool_use', name: 'ExitPlanMode', input: { plan: 42 } }],
			};
			expect(extractExitPlanText(message)).toBe('');
		});
		it('returns null for a normal end_turn message with no tool calls', () => {
			const message = {
				stop_reason: 'end_turn',
				content: [{ type: 'text', text: 'Austin is in Texas.' }],
			};
			expect(extractExitPlanText(message)).toBeNull();
		});
		it('returns null for a tool_use turn that is not ExitPlanMode', () => {
			const message = {
				stop_reason: 'tool_use',
				content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/tmp/x' } }],
			};
			expect(extractExitPlanText(message)).toBeNull();
		});
		it('finds ExitPlanMode regardless of block position', () => {
			const message = {
				content: [
					{ type: 'tool_use', name: 'Grep', input: { pattern: 'foo' } },
					{ type: 'tool_use', name: 'ExitPlanMode', input: { plan: 'Plan body.' } },
				],
			};
			expect(extractExitPlanText(message)).toBe('Plan body.');
		});
		it('is defensive against malformed input', () => {
			expect(extractExitPlanText(null)).toBeNull();
			expect(extractExitPlanText(undefined)).toBeNull();
			expect(extractExitPlanText('nope')).toBeNull();
			expect(extractExitPlanText({})).toBeNull();
			expect(extractExitPlanText({ content: 'not-an-array' })).toBeNull();
		});
	});
});
// Source: src/__tests__/maestro-p/timeout-report.test.ts
describe('', () => {
	describe('formatScreenTailReport', () => {
		it('writes the message, then the screen tail under the shared header', () => {
			const report = formatScreenTailReport(
				'something stalled.',
				'Do you want to proceed?\n❯ 1. Yes'
			);
			expect(report).toBe(
				'maestro-p: something stalled.\n' +
					'maestro-p: last screen at timeout (ANSI-stripped tail):\n' +
					'Do you want to proceed?\n❯ 1. Yes\n'
			);
		});
		it('still ends with a newline when the screen is empty', () => {
			expect(formatScreenTailReport('x', '').endsWith('tail):\n\n')).toBe(true);
		});
	});
	describe('idleTimeoutMessage', () => {
		it('reports the observed silence and the --max-wait budget', () => {
			const message = idleTimeoutMessage(961400, 900);
			expect(message).toContain('no transcript output for 961s');
			expect(message).toContain('--max-wait 900s');
			expect(message).toContain('Failing with timeout.');
		});
	});
	describe('readyTimeoutMessage', () => {
		it('names the boot budget, says nothing reached the model, and the error code', () => {
			const message = readyTimeoutMessage(30);
			expect(message).toContain('within 30s (--ready-timeout)');
			expect(message).toContain('Nothing was sent to the model.');
			expect(message).toContain('Failing with ready_timeout.');
		});
	});
});
// Source: src/__tests__/maestro-p/prompt-echo.test.ts
describe('', () => {
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
			expect(
				promptEchoText({ type: 'user', isMeta: true, message: { content: 'ctx' } })
			).toBeNull();
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
		it('passes when the editor composed decomposed Unicode (NFD in, NFC logged)', () => {
			// The Pedsidian command-bus failure: iMessage context carried "Lagardère"
			// and claude logged "Lagardère", so a whole prompt read as truncated.
			const prompt = `${longPrompt()}\n\nParadies Lagardère (Hut's) and more.`;
			expect(checkPromptEcho(prompt, prompt.normalize('NFC'))).toBeNull();
		});
		it('passes when the editor logged part of the typing as a paste', () => {
			// claude 2.1.294+ wraps a span it read as a paste in paste markers; the
			// synopsis turns that failed this way had every character inside them.
			const prompt = `Give a brief synopsis.\n\n${longPrompt()}`;
			const split = prompt.indexOf('Rule 3:');
			const logged = `\n\n<pasted_content id="bb60">\n${prompt.slice(0, split)}\n</pasted_content id="bb60">\n\n${prompt.slice(split)}`;
			expect(checkPromptEcho(prompt, logged)).toBeNull();
		});
		it('still fails a real hole inside a paste-wrapped echo', () => {
			const prompt = longPrompt();
			const logged = `<pasted_content id="855e">\n${prompt.slice(1022)}\n</pasted_content id="855e">`;
			const mismatch = checkPromptEcho(prompt, logged);
			expect(mismatch).not.toBeNull();
			expect(mismatch!.missingFrom.startsWith('Rule 0:')).toBe(true);
		});
		it('points the snippet at the hole even after a decomposed character', () => {
			const prompt = `Café first. ${longPrompt()}`;
			const holeStart = prompt.indexOf('Rule 5:');
			const logged = (prompt.slice(0, holeStart) + prompt.slice(holeStart + 1022)).normalize('NFC');
			const mismatch = checkPromptEcho(prompt, logged);
			expect(mismatch).not.toBeNull();
			expect(mismatch!.missingFrom.startsWith('Rule 5:')).toBe(true);
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
});
