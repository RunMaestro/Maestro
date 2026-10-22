/**
 * A message is a prompt the user sent or one model response, not a transcript
 * line: tool results, repeated content blocks, meta and sidechain lines are not.
 */

import { describe, it, expect } from 'vitest';
import { countClaudeTranscriptMessages } from '../../shared/claudeTranscriptMessages';

const line = (entry: Record<string, unknown>) => JSON.stringify(entry);

describe('countClaudeTranscriptMessages', () => {
	it('counts one prompt and one multi-block response as two messages', () => {
		const response = (block: string) =>
			line({ type: 'assistant', message: { id: 'msg_1', content: [{ type: block }] } });
		const content = [
			line({ type: 'user', message: { role: 'user', content: 'Fix the bug' } }),
			response('thinking'),
			response('text'),
			response('tool_use'),
		].join('\n');

		expect(countClaudeTranscriptMessages(content)).toBe(2);
	});

	it('does not count tool results, meta lines, command bookkeeping, or compaction summaries', () => {
		const content = [
			line({
				type: 'user',
				message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
			}),
			line({ type: 'user', isMeta: true, message: { content: 'Caveat: local command' } }),
			line({ type: 'user', message: { content: '<command-name>/clear</command-name>' } }),
			line({ type: 'user', isCompactSummary: true, message: { content: 'Summary...' } }),
			line({ type: 'user', message: { content: [{ type: 'text', text: 'Real prompt' }] } }),
		].join('\n');

		expect(countClaudeTranscriptMessages(content)).toBe(1);
	});

	it('counts each API response of a tool-calling turn, and skips sidechain lines', () => {
		const content = [
			line({ type: 'assistant', message: { id: 'msg_a' } }),
			line({ type: 'assistant', message: { id: 'msg_b' } }),
			line({ type: 'assistant', isSidechain: true, message: { id: 'msg_c' } }),
			line({ type: 'summary', summary: 'not a message' }),
			'not json',
		].join('\n');

		expect(countClaudeTranscriptMessages(content)).toBe(2);
	});

	it('still counts a response that carries no id', () => {
		const content = [line({ type: 'assistant' }), line({ type: 'assistant' })].join('\n');
		expect(countClaudeTranscriptMessages(content)).toBe(2);
	});
});
