import { describe, expect, it } from 'vitest';
import {
	MAX_TOOL_DETAIL_LINES,
	entryBodyBlocks,
	entryBlocks,
	entryIndent,
	isFinishedEntry,
	sourceStyle,
	splitFinished,
	summarizeToolEntry,
} from '../entries';
import { entry, toolEntry } from './fixtures';

describe('sourceStyle', () => {
	it('names the known sources and falls back to the raw source for a newer one', () => {
		expect(sourceStyle('user').label).toBe('You');
		expect(sourceStyle('ai').label).toBe('Agent');
		expect(sourceStyle('newfangled').label).toBe('newfangled');
	});
});

describe('summarizeToolEntry', () => {
	it('describes a tool call in one line with its status', () => {
		expect(summarizeToolEntry(toolEntry('Read', { file_path: '/a/b/c.ts' }))).toEqual({
			status: 'completed',
			line: expect.stringContaining('Read'),
		});
		expect(
			summarizeToolEntry(toolEntry('Bash', { command: 'npm test' }, { status: 'running' }))
		).toMatchObject({
			status: 'running',
		});
	});

	it('reports a failed call from its exit code, not its status word', () => {
		const call = toolEntry('Bash', { command: 'make' }, { status: 'completed', exitCode: 2 });
		expect(summarizeToolEntry(call).status).toBe('failed');
	});
});

describe('splitFinished', () => {
	it('keeps everything from the first running tool call live, in order', () => {
		const a = entry('user', 'hi');
		const b = toolEntry('Bash', { command: 'x' }, { status: 'running' });
		const c = entry('ai', 'later');
		expect(isFinishedEntry(b)).toBe(false);
		expect(splitFinished([a, b, c])).toEqual({ finished: [a], live: [b, c] });
	});

	it('has no live entries when nothing is running', () => {
		const a = entry('user', 'hi');
		expect(splitFinished([a])).toEqual({ finished: [a], live: [] });
	});
});

describe('entryBodyBlocks', () => {
	it('renders user and agent text as markdown', () => {
		expect(entryBodyBlocks(entry('user', '**hi**'), false)[0]!.kind).toBe('paragraph');
		expect(entryBodyBlocks(entry('ai', '# T'), false)[0]!.kind).toBe('heading');
	});

	it('shows command output as literal text, not markdown', () => {
		const [block] = entryBodyBlocks(entry('stdout', '**not bold**'), false);
		expect(block).toMatchObject({ kind: 'code', lines: [[{ text: '**not bold**' }]] });
	});

	it('collapses a tool call to nothing and expands it to its input and output', () => {
		const call = toolEntry('Bash', { command: 'ls' }, { status: 'completed' }, 'file-a\nfile-b');
		expect(entryBodyBlocks(call, false)).toEqual([]);
		const blocks = entryBodyBlocks(call, true);
		expect(blocks).toHaveLength(2);
		expect(blocks[0]).toMatchObject({ kind: 'code', language: 'json' });
		expect(blocks[1]).toMatchObject({
			kind: 'code',
			lines: [[{ text: 'file-a' }], [{ text: 'file-b' }]],
		});
	});

	it('caps a long tool output and says how much was left out', () => {
		const output = Array.from({ length: MAX_TOOL_DETAIL_LINES + 5 }, (_, i) => `l${i}`).join('\n');
		const blocks = entryBodyBlocks(toolEntry('Bash', 'ls', { status: 'completed' }, output), true);
		const last = blocks[blocks.length - 1] as { lines: Array<Array<{ text: string }>> };
		expect(last.lines).toHaveLength(MAX_TOOL_DETAIL_LINES + 1);
		expect(last.lines[MAX_TOOL_DETAIL_LINES]![0]!.text).toBe('… 5 more lines');
	});
});

describe('entryBlocks', () => {
	it('parses an entry once and reparses when its text changes', () => {
		const item = entry('ai', 'one');
		expect(entryBlocks(item)).toBe(entryBlocks(item));
		const before = entryBlocks(item);
		item.text = 'two';
		expect(entryBlocks(item)).not.toBe(before);
	});
});

describe('entryIndent', () => {
	it('indents a subagent call under its parent', () => {
		expect(entryIndent(entry('tool', 'Read'))).toBe(0);
		expect(entryIndent(entry('tool', 'Read', { metadata: { parentToolUseId: 'p1' } }))).toBe(2);
	});
});
