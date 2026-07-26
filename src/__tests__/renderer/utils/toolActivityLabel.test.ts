/**
 * toolActivityLabel tests
 *
 * The live activity feed's whole value is that a user can scan it, so the
 * per-provider tool-name variance (Claude Code `Read`/`Bash`, OpenCode lowercase
 * `read`/`bash`, Codex `shell`/`apply_patch`/`update_plan`, Copilot
 * `write_to_file`, MCP `mcp__server__tool`) must all collapse to plain English,
 * and an unrecognized tool must still produce a usable line rather than nothing.
 */
import { describe, it, expect } from 'vitest';
import { describeToolActivity } from '../../../renderer/utils/toolActivityLabel';

describe('describeToolActivity', () => {
	describe('file reads', () => {
		it('labels Claude Code Read with the file path', () => {
			expect(describeToolActivity('Read', { file_path: 'src/App.tsx' })).toEqual({
				verb: 'Read',
				target: 'src/App.tsx',
			});
		});

		it('labels OpenCode lowercase read via its `path` key', () => {
			expect(describeToolActivity('read', { path: 'README.md' })).toEqual({
				verb: 'Read',
				target: 'README.md',
			});
		});

		it('truncates a very long path from the left, keeping the filename', () => {
			const long = `/Users/someone/${'nested/'.repeat(20)}target.ts`;
			const { verb, target } = describeToolActivity('Read', { file_path: long });
			expect(verb).toBe('Read');
			expect(target.length).toBeLessThanOrEqual(72);
			expect(target).toContain('target.ts');
		});
	});

	describe('shell commands', () => {
		it('labels Bash with the command string', () => {
			expect(
				describeToolActivity('Bash', { command: 'npm test', description: 'Run tests' })
			).toEqual({ verb: 'Ran', target: 'npm test' });
		});

		it('joins an argv-array command (Codex/OpenCode shape)', () => {
			expect(describeToolActivity('shell', { command: ['npm', 'run', 'lint'] })).toEqual({
				verb: 'Ran',
				target: 'npm run lint',
			});
		});

		it('collapses a multi-line command onto one line', () => {
			const { target } = describeToolActivity('Bash', { command: 'cd /tmp\nls -la' });
			expect(target).not.toContain('\n');
		});

		it('labels BashOutput and KillShell with no target', () => {
			expect(describeToolActivity('BashOutput', { bash_id: 'x' })).toEqual({
				verb: 'Checked background output',
				target: '',
			});
			expect(describeToolActivity('KillShell', { shell_id: 'x' })).toEqual({
				verb: 'Stopped a background command',
				target: '',
			});
		});
	});

	describe('edits and writes', () => {
		it('labels Edit and MultiEdit as Edited', () => {
			expect(describeToolActivity('Edit', { file_path: 'a.ts' }).verb).toBe('Edited');
			expect(describeToolActivity('MultiEdit', { file_path: 'a.ts' }).verb).toBe('Edited');
		});

		it('labels Copilot write_to_file as Wrote', () => {
			expect(describeToolActivity('write_to_file', { path: 'out.txt' })).toEqual({
				verb: 'Wrote',
				target: 'out.txt',
			});
		});

		it('falls back to the patch body when apply_patch sends a bare string', () => {
			// Codex delivers apply_patch as one raw diff string with no path field;
			// iterating it as an object would emit character-by-character garbage.
			const { verb, target } = describeToolActivity('apply_patch', '*** Update File: src/a.ts');
			expect(verb).toBe('Edited');
			expect(target).toContain('src/a.ts');
		});

		it('labels NotebookEdit distinctly', () => {
			expect(describeToolActivity('NotebookEdit', { notebook_path: 'nb.ipynb' })).toEqual({
				verb: 'Edited notebook',
				target: 'nb.ipynb',
			});
		});
	});

	describe('search and web', () => {
		it('labels Grep with its pattern', () => {
			expect(describeToolActivity('Grep', { pattern: 'TODO' })).toEqual({
				verb: 'Searched for',
				target: 'TODO',
			});
		});

		it('labels Glob distinctly from Grep', () => {
			expect(describeToolActivity('Glob', { pattern: '**/*.ts' })).toEqual({
				verb: 'Looked for files matching',
				target: '**/*.ts',
			});
		});

		it('labels WebFetch with the URL and WebSearch with the query', () => {
			expect(describeToolActivity('WebFetch', { url: 'https://example.com' })).toEqual({
				verb: 'Fetched',
				target: 'https://example.com',
			});
			expect(describeToolActivity('WebSearch', { query: 'electron ipc' })).toEqual({
				verb: 'Searched the web for',
				target: 'electron ipc',
			});
		});
	});

	describe('planning and delegation', () => {
		it('summarizes TodoWrite as the in-progress task plus a progress count', () => {
			expect(
				describeToolActivity('TodoWrite', {
					todos: [
						{ content: 'one', status: 'completed' },
						{ content: 'two', activeForm: 'Doing two', status: 'in_progress' },
						{ content: 'three', status: 'pending' },
					],
				})
			).toEqual({ verb: 'Updated the task list', target: 'Doing two (1/3)' });
		});

		it('handles Codex update_plan, which uses `plan` instead of `todos`', () => {
			expect(
				describeToolActivity('update_plan', {
					plan: [{ step: 'Investigate', status: 'in_progress' }],
				})
			).toEqual({ verb: 'Updated the task list', target: 'Investigate (0/1)' });
		});

		it('labels Task with its description', () => {
			expect(
				describeToolActivity('Task', { description: 'Audit the parsers', prompt: 'long prompt' })
			).toEqual({ verb: 'Delegated to a subagent', target: 'Audit the parsers' });
		});
	});

	describe('MCP and unknown tools', () => {
		it('splits an MCP tool name into server and tool', () => {
			expect(describeToolActivity('mcp__linear__create_issue', {})).toEqual({
				verb: 'Called linear',
				target: 'create issue',
			});
		});

		it('handles an MCP server name containing underscores', () => {
			expect(describeToolActivity('mcp__my_server__do_thing', {}).verb).toBe('Called my_server');
		});

		it('still produces a line for an unrecognized tool', () => {
			expect(describeToolActivity('SomeNewTool', { file_path: 'x.ts' })).toEqual({
				verb: 'Used SomeNewTool',
				target: 'x.ts',
			});
		});

		it('never throws on a missing name or a null input', () => {
			expect(describeToolActivity('', null)).toEqual({ verb: 'Used a tool', target: '' });
			expect(describeToolActivity('Read', undefined)).toEqual({ verb: 'Read', target: '' });
			expect(describeToolActivity('Bash', [1, 2, 3])).toEqual({ verb: 'Ran', target: '' });
		});
	});
});
