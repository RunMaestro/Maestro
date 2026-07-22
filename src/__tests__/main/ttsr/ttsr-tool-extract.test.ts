/**
 * Tests for TTSR tool snapshot extraction (file writes + shell commands)
 * across the per-agent tool event shapes described by Gate A.
 */

import { describe, it, expect } from 'vitest';
import {
	extractToolSnapshots,
	extractPatchAdditions,
	extractPatchPath,
} from '../../../main/ttsr/ttsr-tool-extract';
import type { ParsedEvent } from '../../../main/parsers/agent-output-parser';

describe('extractToolSnapshots', () => {
	it('extracts a claude-code Write block', () => {
		const event: ParsedEvent = {
			type: 'tool_use',
			toolUseBlocks: [
				{ name: 'Write', id: 't1', input: { file_path: 'src/a.ts', content: 'const a = 1;' } },
			],
		};

		expect(extractToolSnapshots(event)).toEqual([
			{ source: 'tool:write', toolName: 'Write', filePath: 'src/a.ts', content: 'const a = 1;' },
		]);
	});

	it('extracts a claude-code Edit replacement string', () => {
		const event: ParsedEvent = {
			type: 'tool_use',
			toolUseBlocks: [
				{ name: 'Edit', input: { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' } },
			],
		};

		expect(extractToolSnapshots(event)[0]).toMatchObject({
			source: 'tool:edit',
			content: 'b',
		});
	});

	it('concatenates every replacement in a MultiEdit', () => {
		const event: ParsedEvent = {
			type: 'tool_use',
			toolUseBlocks: [
				{
					name: 'MultiEdit',
					input: {
						file_path: 'src/a.ts',
						edits: [{ new_string: 'first' }, { new_string: 'second' }, { bogus: true }],
					},
				},
			],
		};

		expect(extractToolSnapshots(event)[0].content).toBe('first\nsecond');
	});

	it('extracts an opencode toolState write', () => {
		const event: ParsedEvent = {
			type: 'tool_use',
			toolName: 'write',
			toolState: { status: 'running', input: { filePath: 'src/b.ts', content: 'x' } },
		};

		expect(extractToolSnapshots(event)).toEqual([
			{ source: 'tool:write', toolName: 'write', filePath: 'src/b.ts', content: 'x' },
		]);
	});

	it('recovers added lines and the path from a codex apply_patch', () => {
		const patch = [
			'*** Begin Patch',
			'*** Update File: src/c.ts',
			'@@',
			'-const old = 1;',
			'+const next = 2;',
			' unchanged',
			'*** End Patch',
		].join('\n');
		const event: ParsedEvent = {
			type: 'tool_use',
			toolName: 'apply_patch',
			toolState: { status: 'running', input: patch },
		};

		expect(extractToolSnapshots(event)).toEqual([
			{
				source: 'tool:edit',
				toolName: 'apply_patch',
				filePath: 'src/c.ts',
				content: 'const next = 2;',
			},
		]);
	});

	it('ignores non-mutating tools and payloads with no content', () => {
		expect(
			extractToolSnapshots({
				type: 'tool_use',
				toolUseBlocks: [{ name: 'Read', input: { file_path: 'src/a.ts' } }],
			})
		).toEqual([]);
		expect(
			extractToolSnapshots({
				type: 'tool_use',
				toolUseBlocks: [{ name: 'Write', input: { file_path: 'src/a.ts' } }],
			})
		).toEqual([]);
		expect(extractToolSnapshots({ type: 'text', text: 'hi' })).toEqual([]);
	});
});

describe('TTSR config files are never matched', () => {
	// A rule file necessarily contains the text its own rule looks for, and
	// editing rules is how a user asks an agent to set TTSR up - so without this
	// carve-out the authoring path trips the rules it is authoring.
	it.each([
		['project-relative', '.maestro/rules/no-console-log.md', '/repo'],
		['absolute', '/repo/.maestro/rules/no-console-log.md', '/repo'],
		['windows separators', 'C:\\repo\\.maestro\\rules\\no-console-log.md', 'C:\\repo'],
		['the settings file', '/repo/.maestro/ttsr.yaml', '/repo'],
	])('drops a write to %s', (_label, filePath, projectRoot) => {
		const event: ParsedEvent = {
			type: 'tool_use',
			toolUseBlocks: [
				{
					name: 'Write',
					input: { file_path: filePath, content: 'Do not use console.log( in shipped source.' },
				},
			],
		};

		expect(extractToolSnapshots(event, projectRoot)).toEqual([]);
	});

	// The carve-out is anchored, not a substring test. A nested `.maestro/rules/`
	// (fixture, vendored repo, sub-project) is ordinary content: suppressing it
	// would hide real violations behind a directory name.
	it.each([
		['a relative nested rules dir', 'fixtures/.maestro/rules/example.md', '/repo'],
		['an absolute nested rules dir', '/repo/fixtures/.maestro/rules/example.md', '/repo'],
		["another project's rules dir", '/other-repo/.maestro/rules/example.md', '/repo'],
		['an absolute path with no known root', '/repo/.maestro/rules/example.md', undefined],
	])('still matches a write to %s', (_label, filePath, projectRoot) => {
		const event: ParsedEvent = {
			type: 'tool_use',
			toolUseBlocks: [
				{
					name: 'Write',
					input: { file_path: filePath, content: 'console.log(1)' },
				},
			],
		};

		expect(extractToolSnapshots(event, projectRoot)).toHaveLength(1);
	});

	// A `tool:bash` snapshot carries no `filePath`, so the path guard above cannot
	// see it: an agent authoring a rule through the shell would otherwise trip
	// every shell-scoped rule whose condition appears in the rule body.
	it.each([
		[
			'heredoc into the rules dir',
			"cat > .maestro/rules/no-force-push.md <<'EOF'\ncondition: git push --force\nEOF",
		],
		['append into the settings file', "echo 'enabled: true' >> .maestro/ttsr.yaml"],
		['tee into a rule file', "echo 'git push --force' | tee -a .maestro/rules/no-force-push.md"],
		['copy over a rule file', 'cp /tmp/no-force-push.md .maestro/rules/no-force-push.md'],
		['in-place edit of a rule file', "sed -i 's/foo/git push --force/' .maestro/rules/x.md"],
		['windows separators', 'cat > .maestro\\rules\\no-force-push.md'],
	])('drops a shell command that writes TTSR config (%s)', (_label, command) => {
		const event: ParsedEvent = {
			type: 'tool_use',
			toolUseBlocks: [{ name: 'Bash', id: 't1', input: { command } }],
		};

		expect(extractToolSnapshots(event)).toEqual([]);
	});

	it.each([
		['an unrelated command', 'git push --force origin main'],
		['a read of the rules dir', "grep -rn 'git push --force' .maestro/rules"],
		['a listing of the rules dir', 'ls -la .maestro/rules/'],
		['an unrelated write elsewhere', 'echo "git push --force" > notes.txt'],
	])('still matches %s', (_label, command) => {
		const event: ParsedEvent = {
			type: 'tool_use',
			toolUseBlocks: [{ name: 'Bash', id: 't1', input: { command } }],
		};

		// Reading rules is not authoring them; suppressing it would open a hole an
		// agent could hide real work behind.
		expect(extractToolSnapshots(event)).toHaveLength(1);
	});

	it('still matches an ordinary file inside .maestro', () => {
		const event: ParsedEvent = {
			type: 'tool_use',
			toolUseBlocks: [
				{
					name: 'Write',
					input: { file_path: '.maestro/playbooks/x.md', content: 'console.log(1)' },
				},
			],
		};

		// Only TTSR's own config is exempt, not the whole .maestro directory.
		expect(extractToolSnapshots(event)).toHaveLength(1);
	});
});

describe('shell command extraction', () => {
	it('extracts a claude-code Bash command', () => {
		const event: ParsedEvent = {
			type: 'tool_use',
			toolUseBlocks: [
				{
					name: 'Bash',
					id: 't1',
					input: { command: 'git push --force origin main', description: 'push' },
				},
			],
		};

		expect(extractToolSnapshots(event)).toEqual([
			{ source: 'tool:bash', toolName: 'Bash', content: 'git push --force origin main' },
		]);
	});

	it('extracts a codex shell command', () => {
		const event: ParsedEvent = {
			type: 'tool_use',
			toolName: 'shell',
			toolState: { status: 'running', input: { command: 'rm -rf build' } },
		};

		expect(extractToolSnapshots(event)[0]).toEqual({
			source: 'tool:bash',
			toolName: 'shell',
			content: 'rm -rf build',
		});
	});

	it('extracts an opencode bash command', () => {
		const event: ParsedEvent = {
			type: 'tool_use',
			toolName: 'bash',
			toolState: { status: 'running', input: { command: 'npm publish' } },
		};

		expect(extractToolSnapshots(event)[0]).toMatchObject({
			source: 'tool:bash',
			content: 'npm publish',
		});
	});

	it('joins an argv array into one matchable command line', () => {
		const event: ParsedEvent = {
			type: 'tool_use',
			toolName: 'local_shell',
			toolState: { status: 'running', input: { command: ['git', 'push', '--force'] } },
		};

		expect(extractToolSnapshots(event)[0].content).toBe('git push --force');
	});

	it('never reports a file path for a command', () => {
		const event: ParsedEvent = {
			type: 'tool_use',
			toolName: 'bash',
			toolState: { status: 'running', input: { command: 'cat src/a.ts', path: 'src/a.ts' } },
		};

		// A command is not "in" a file, so globs must not be able to narrow it.
		expect(extractToolSnapshots(event)[0].filePath).toBeUndefined();
	});

	it('ignores a shell call with no command', () => {
		expect(
			extractToolSnapshots({
				type: 'tool_use',
				toolName: 'bash',
				toolState: { status: 'running', input: { description: 'nothing to run' } },
			})
		).toEqual([]);
	});
});

describe('patch helpers', () => {
	it('keeps added lines and drops the +++ header', () => {
		expect(extractPatchAdditions('--- a/x\n+++ b/x\n@@\n+added\n-removed')).toBe('added');
	});

	it('reads the path from a unified diff header when no apply_patch header exists', () => {
		expect(extractPatchPath('--- a/src/x.ts\n+++ b/src/x.ts\n@@\n+a')).toBe('src/x.ts');
		expect(extractPatchPath('no headers here')).toBeUndefined();
	});
});
