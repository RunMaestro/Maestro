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
import {
	describeToolActivity,
	describeToolActivityStatus,
} from '../../../renderer/utils/toolActivityLabel';

describe('describeToolActivity', () => {
	describe('file reads', () => {
		it('labels Claude Code Read with the file path', () => {
			expect(describeToolActivity('Read', { file_path: 'src/App.tsx' })).toEqual({
				verb: 'Read',
				target: 'src/App.tsx',
				targetIsCode: true,
			});
		});

		it('labels OpenCode lowercase read via its `path` key', () => {
			expect(describeToolActivity('read', { path: 'README.md' })).toEqual({
				verb: 'Read',
				target: 'README.md',
				targetIsCode: true,
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
			).toEqual({ verb: 'Ran', target: 'npm test', targetIsCode: true });
		});

		it('joins an argv-array command (Codex/OpenCode shape)', () => {
			expect(describeToolActivity('shell', { command: ['npm', 'run', 'lint'] })).toEqual({
				verb: 'Ran',
				target: 'npm run lint',
				targetIsCode: true,
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
				targetIsCode: false,
			});
			expect(describeToolActivity('KillShell', { shell_id: 'x' })).toEqual({
				verb: 'Stopped a background command',
				target: '',
				targetIsCode: false,
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
				targetIsCode: true,
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
				targetIsCode: true,
			});
		});
	});

	describe('search and web', () => {
		it('labels Grep with its pattern', () => {
			expect(describeToolActivity('Grep', { pattern: 'TODO' })).toEqual({
				verb: 'Searched for',
				target: 'TODO',
				targetIsCode: true,
			});
		});

		it('labels Glob distinctly from Grep', () => {
			expect(describeToolActivity('Glob', { pattern: '**/*.ts' })).toEqual({
				verb: 'Looked for files matching',
				target: '**/*.ts',
				targetIsCode: true,
			});
		});

		it('labels WebFetch with the URL and WebSearch with the query', () => {
			expect(describeToolActivity('WebFetch', { url: 'https://example.com' })).toEqual({
				verb: 'Fetched',
				target: 'https://example.com',
				targetIsCode: true,
			});
			expect(describeToolActivity('WebSearch', { query: 'electron ipc' })).toEqual({
				verb: 'Searched the web for',
				target: 'electron ipc',
				targetIsCode: false,
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
			).toEqual({
				verb: 'Updated the task list',
				target: 'Doing two (1/3)',
				targetIsCode: false,
			});
		});

		it('handles Codex update_plan, which uses `plan` instead of `todos`', () => {
			expect(
				describeToolActivity('update_plan', {
					plan: [{ step: 'Investigate', status: 'in_progress' }],
				})
			).toEqual({
				verb: 'Updated the task list',
				target: 'Investigate (0/1)',
				targetIsCode: false,
			});
		});

		it('labels Task with its description', () => {
			expect(
				describeToolActivity('Task', { description: 'Audit the parsers', prompt: 'long prompt' })
			).toEqual({
				verb: 'Delegated to a subagent',
				target: 'Audit the parsers',
				targetIsCode: false,
			});
		});
	});

	describe('MCP and unknown tools', () => {
		it('splits an MCP tool name into server and tool', () => {
			expect(describeToolActivity('mcp__linear__create_issue', {})).toEqual({
				verb: 'Called linear',
				target: 'create issue',
				targetIsCode: false,
			});
		});

		it('handles an MCP server name containing underscores', () => {
			expect(describeToolActivity('mcp__my_server__do_thing', {}).verb).toBe('Called my_server');
		});

		it('still produces a line for an unrecognized tool', () => {
			expect(describeToolActivity('SomeNewTool', { file_path: 'x.ts' })).toEqual({
				verb: 'Used SomeNewTool',
				target: 'x.ts',
				targetIsCode: true,
			});
		});

		it('never throws on a missing name or a null input', () => {
			expect(describeToolActivity('', null)).toEqual({
				verb: 'Used a tool',
				target: '',
				targetIsCode: true,
			});
			expect(describeToolActivity('Read', undefined)).toEqual({
				verb: 'Read',
				target: '',
				targetIsCode: true,
			});
			expect(describeToolActivity('Bash', [1, 2, 3])).toEqual({
				verb: 'Ran',
				target: '',
				targetIsCode: true,
			});
		});
	});

	/**
	 * `targetIsCode` decides whether the activity feed wraps the target in the
	 * same inline-code chip markdown backticks get. The distinction is not
	 * cosmetic: a literal is something the user can copy and run, and prose we
	 * wrote about the call is not. Getting it backwards either strips a command
	 * of the formatting that makes it readable, or dresses an English sentence
	 * up as something runnable.
	 */
	describe('literal vs prose targets', () => {
		it.each([
			['Read', { file_path: 'src/App.tsx' }],
			['Bash', { command: 'npm test' }],
			['Grep', { pattern: 'TODO' }],
			['Glob', { pattern: '**/*.ts' }],
			['WebFetch', { url: 'https://example.com' }],
			['ls', { path: 'src/' }],
			['apply_patch', '*** Update File: src/a.ts'],
			['SomeNewTool', { command: 'do-the-thing --now' }],
		])('marks %s as a literal the user could paste', (tool, input) => {
			expect(describeToolActivity(tool, input).targetIsCode).toBe(true);
		});

		it.each([
			// "Doing two (1/3)" is a sentence about progress, not a command.
			[
				'TodoWrite',
				{ todos: [{ content: 'two', activeForm: 'Doing two', status: 'in_progress' }] },
			],
			// A subagent description is the prompt in English.
			['Task', { description: 'Audit the parsers' }],
			// A web search is typed the way you would say it out loud.
			['WebSearch', { query: 'electron ipc' }],
			// `create issue` is the MCP tool's name with the underscores taken out.
			['mcp__linear__create_issue', {}],
		])('marks %s as prose', (tool, input) => {
			expect(describeToolActivity(tool, input).targetIsCode).toBe(false);
		});
	});
});

/**
 * The status half. A supervision feed exists to make a failure obvious, so the
 * one thing it must never do is draw a check mark beside a command that broke -
 * and the provider's own `status` word is not enough to prevent that.
 */
describe('describeToolActivityStatus', () => {
	it('reads a Codex shell failure, which arrives as `completed` with a non-zero exit code', () => {
		// codex-output-parser.ts maps item.status 'failed' -> 'completed' and
		// carries the real outcome in exit_code. This is THE regression: the feed
		// used to show a check mark next to a failed build.
		expect(
			describeToolActivityStatus({
				status: 'completed',
				input: { command: 'npm test' },
				exitCode: 1,
			})
		).toBe('failed');
	});

	it('accepts the snake_case spelling of the exit code', () => {
		expect(describeToolActivityStatus({ status: 'completed', exit_code: 127 })).toBe('failed');
	});

	it('keeps a zero exit code a success', () => {
		expect(describeToolActivityStatus({ status: 'completed', exitCode: 0 })).toBe('completed');
	});

	it('treats a zero exit code as finished even when the provider sent no status word', () => {
		expect(describeToolActivityStatus({ exitCode: 0 })).toBe('completed');
	});

	it('reads the boolean spelling other providers use', () => {
		expect(describeToolActivityStatus({ status: 'completed', isError: true })).toBe('failed');
		expect(describeToolActivityStatus({ status: 'completed', is_error: true })).toBe('failed');
		expect(describeToolActivityStatus({ status: 'completed', isError: false })).toBe('completed');
	});

	it('maps the status words providers actually send', () => {
		expect(describeToolActivityStatus({ status: 'running' })).toBe('running');
		expect(describeToolActivityStatus({ status: 'completed' })).toBe('completed');
		expect(describeToolActivityStatus({ status: 'success' })).toBe('completed');
		expect(describeToolActivityStatus({ status: 'failed' })).toBe('failed');
		expect(describeToolActivityStatus({ status: 'error' })).toBe('failed');
		expect(describeToolActivityStatus({ status: 'FAILED' })).toBe('failed');
	});

	it('falls back to running for an absent or unrecognized status', () => {
		// The reading that cannot mislead: it resolves itself the moment the
		// completion event arrives.
		expect(describeToolActivityStatus({})).toBe('running');
		expect(describeToolActivityStatus({ status: 'in_progress' })).toBe('running');
		expect(describeToolActivityStatus({ status: 'something-new' })).toBe('running');
	});

	it('never throws on a missing or non-object payload', () => {
		expect(describeToolActivityStatus(undefined)).toBe('running');
		expect(describeToolActivityStatus(null)).toBe('running');
		expect(describeToolActivityStatus('completed')).toBe('running');
		expect(describeToolActivityStatus({ exitCode: Number.NaN })).toBe('running');
	});
});
