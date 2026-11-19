import { describe as __maestroMicrobenchDescribe } from 'vitest';
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { extractAskUserQuestionText } from '../../maestro-p/ask-user-question';
import { formatScreenTailReport } from '../../maestro-p/timeout-report';
import { idleTimeoutMessage } from '../../maestro-p/timeout-report';
import { readyTimeoutMessage } from '../../maestro-p/timeout-report';
import { startupDialogBlockedMessage } from '../../maestro-p/timeout-report';
import { isPreTurnRow } from '../../maestro-p/turn-start';
__maestroMicrobenchDescribe('ask-user-question', () => {
	describe('extractAskUserQuestionText', () => {
		it('renders the questions when the message calls AskUserQuestion', () => {
			const message = {
				stop_reason: 'tool_use',
				content: [
					{
						type: 'tool_use',
						name: 'AskUserQuestion',
						input: {
							questions: [
								{
									question: 'Where should the template live?',
									header: 'Where',
									options: [
										{ label: 'In place', description: 'Edit these repos' },
										{ label: 'Fork', description: 'Copy into new repos' },
									],
									multiSelect: false,
								},
							],
						},
					},
				],
			};
			expect(extractAskUserQuestionText(message)).toBe(
				[
					'**Where:** Where should the template live?',
					'',
					'1. **In place** - Edit these repos',
					'2. **Fork** - Copy into new repos',
				].join('\n')
			);
		});

		it('finds the call after other content blocks', () => {
			const message = {
				content: [
					{ type: 'text', text: 'One decision first.' },
					{
						type: 'tool_use',
						name: 'AskUserQuestion',
						input: { questions: [{ question: 'Proceed?', options: ['Yes', 'No'] }] },
					},
				],
			};
			expect(extractAskUserQuestionText(message)).toBe('Proceed?\n\n1. **Yes**\n2. **No**');
		});

		it('returns null when the call carries no usable question', () => {
			const message = {
				content: [{ type: 'tool_use', name: 'AskUserQuestion', input: { questions: [{}] } }],
			};
			expect(extractAskUserQuestionText(message)).toBeNull();
		});

		it('returns null for a message with no AskUserQuestion call', () => {
			expect(
				extractAskUserQuestionText({
					content: [
						{ type: 'text', text: 'done' },
						{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
					],
				})
			).toBeNull();
		});

		it('returns null for malformed messages', () => {
			expect(extractAskUserQuestionText(null)).toBeNull();
			expect(extractAskUserQuestionText('text')).toBeNull();
			expect(extractAskUserQuestionText({ content: 'not an array' })).toBeNull();
			expect(extractAskUserQuestionText({ content: [null, 7] })).toBeNull();
		});
	});
});
__maestroMicrobenchDescribe('timeout-report', () => {
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
			const message = idleTimeoutMessage(961_400, 900);
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

	describe('startupDialogBlockedMessage', () => {
		it('quotes the highlighted option, says nothing reached the model, and the error code', () => {
			const message = startupDialogBlockedMessage('No, exit');
			expect(message).toContain('its highlighted option is "No, exit"');
			expect(message).toContain('Nothing was sent to the model.');
			expect(message).toContain('Failing with startup_dialog_blocked.');
		});
	});
});
__maestroMicrobenchDescribe('turn-start', () => {
	describe('isPreTurnRow', () => {
		it('treats the SessionStart hook result claude logs at resume as pre-turn', () => {
			expect(
				isPreTurnRow({
					type: 'attachment',
					attachment: {
						type: 'hook_success',
						hookName: 'SessionStart:resume',
						hookEvent: 'SessionStart',
						exitCode: 0,
					},
				})
			).toBe(true);
		});

		it('treats the context a SessionStart hook injects as pre-turn', () => {
			expect(
				isPreTurnRow({
					type: 'attachment',
					attachment: {
						type: 'hook_additional_context',
						hookName: 'SessionStart',
						hookEvent: 'SessionStart',
					},
				})
			).toBe(true);
		});

		it('counts the prompt echo and the reply as the turn starting', () => {
			expect(isPreTurnRow({ type: 'user', message: { role: 'user', content: 'hi' } })).toBe(false);
			expect(isPreTurnRow({ type: 'assistant', message: { content: [] } })).toBe(false);
		});

		it('counts attachments from other hooks as the turn starting', () => {
			expect(
				isPreTurnRow({
					type: 'attachment',
					attachment: {
						type: 'hook_success',
						hookName: 'UserPromptSubmit',
						hookEvent: 'UserPromptSubmit',
					},
				})
			).toBe(false);
			expect(
				isPreTurnRow({ type: 'attachment', attachment: { type: 'total_tokens_reminder' } })
			).toBe(false);
		});

		it('rejects values that are not transcript rows', () => {
			expect(isPreTurnRow(null)).toBe(false);
			expect(isPreTurnRow('attachment')).toBe(false);
			expect(isPreTurnRow({ type: 'attachment' })).toBe(false);
		});
	});
});
