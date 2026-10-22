import { describe, expect, it } from 'vitest';
import { collectAssistantText, ReplyText } from '../../maestro-p/reply-text';

const text = (t: string) => ({ content: [{ type: 'text', text: t }] });
const toolUse = { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] };

describe('ReplyText', () => {
	it('reports only the final reply, not the narration between tool calls', () => {
		const reply = new ReplyText();
		reply.addAssistant(text("I'm looking for it now."));
		reply.addAssistant(toolUse);
		reply.addToolResult();
		reply.addAssistant(text('Logged in. Checking the data.'));
		reply.addAssistant(toolUse);
		reply.addToolResult();
		reply.addAssistant(text('The connection is live.'));
		expect(reply.text).toBe('The connection is live.');
	});

	it('joins a final reply that spans several assistant rows', () => {
		const reply = new ReplyText();
		reply.addAssistant(text('Part one. '));
		reply.addAssistant(text('Part two.'));
		expect(reply.text).toBe('Part one. Part two.');
	});

	it('falls back to the last narration when the turn ends on a tool call', () => {
		const reply = new ReplyText();
		reply.addAssistant(text('First.'));
		reply.addToolResult();
		reply.addAssistant(text('Second.'));
		reply.addAssistant(toolUse);
		reply.addToolResult();
		expect(reply.text).toBe('Second.');
	});

	it('appends a plan once, after the reply', () => {
		const reply = new ReplyText();
		reply.addAssistant(text('Here is the plan.'));
		reply.appendIfMissing('1. Do it');
		reply.appendIfMissing('1. Do it');
		expect(reply.text).toBe('Here is the plan.\n\n1. Do it');
	});

	it('uses slash-command output only when nothing else was produced', () => {
		const reply = new ReplyText();
		reply.setIfEmpty('Compacted.');
		expect(reply.text).toBe('Compacted.');
		reply.setIfEmpty('Other.');
		expect(reply.text).toBe('Compacted.');
	});
});

describe('collectAssistantText', () => {
	it('concatenates text blocks and skips everything else', () => {
		expect(
			collectAssistantText({
				content: [
					{ type: 'thinking', thinking: 'x' },
					{ type: 'text', text: 'a' },
					toolUse.content[0],
					{ type: 'text', text: 'b' },
				],
			})
		).toBe('ab');
		expect(collectAssistantText(null)).toBe('');
	});
});
