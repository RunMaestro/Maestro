import { describe, it, expect } from 'vitest';
import { removeClaudeMessagePair } from '../../../main/storage/claude-message-pair';

const line = (entry: unknown) => JSON.stringify(entry);
const jsonl = (...entries: unknown[]) => entries.map(line).join('\n') + '\n';
const user = (uuid: string, content: unknown) => ({ type: 'user', uuid, message: { content } });
const assistant = (content: unknown[]) => ({ type: 'assistant', message: { content } });
const text = (t: string) => ({ type: 'text', text: t });
const toolUse = (id: string) => ({ type: 'tool_use', id, name: 'Bash', input: {} });
const toolResult = (id: string) => ({ type: 'tool_result', tool_use_id: id, content: 'ok' });

describe('removeClaudeMessagePair', () => {
	it('removes the user message matched by uuid and its reply', () => {
		const result = removeClaudeMessagePair(
			jsonl(user('u1', 'one'), assistant([text('r1')]), user('u2', 'two'), assistant([text('r2')])),
			'u1'
		);

		expect(result).toMatchObject({ found: true, linesRemoved: 2 });
		expect(result.found && result.content).toBe(jsonl(user('u2', 'two'), assistant([text('r2')])));
	});

	it('falls back to the newest user turn with matching text', () => {
		const result = removeClaudeMessagePair(
			jsonl(
				user('u1', 'same'),
				assistant([text('r1')]),
				user('u2', [text('same')]),
				assistant([text('r2')])
			),
			'maestro-id',
			'  same  '
		);

		expect(result.found && result.content).toBe(jsonl(user('u1', 'same'), assistant([text('r1')])));
	});

	it('reports not found and leaves nothing to write', () => {
		expect(removeClaudeMessagePair(jsonl(user('u1', 'one')), 'nope', 'missing')).toEqual({
			found: false,
		});
	});

	it('keeps the whole reply across tool calls, not just up to the first tool result', () => {
		const result = removeClaudeMessagePair(
			jsonl(
				user('u1', 'run it'),
				assistant([toolUse('t1')]),
				user('tr1', [toolResult('t1')]),
				assistant([text('done')]),
				user('u2', 'next'),
				assistant([text('r2')])
			),
			'u1'
		);

		expect(result).toMatchObject({ found: true, linesRemoved: 4, deletedToolUseIds: ['t1'] });
		expect(result.found && result.content).toBe(jsonl(user('u2', 'next'), assistant([text('r2')])));
	});

	it('strips tool results elsewhere that point at a deleted tool_use', () => {
		const result = removeClaudeMessagePair(
			jsonl(
				user('u1', 'run it'),
				assistant([toolUse('t1')]),
				user('u2', [text('later'), toolResult('t1')])
			),
			'u1'
		);

		expect(result.found && result.content).toBe(jsonl(user('u2', [text('later')])));
	});

	it('passes unparseable lines through untouched', () => {
		const content = ['not json', line(user('u1', 'one')), line(assistant([text('r1')]))].join('\n');

		expect(removeClaudeMessagePair(content, 'u1')).toMatchObject({
			found: true,
			content: 'not json\n',
		});
	});
});
