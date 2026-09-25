/**
 * OpenCode resume: the argv and environment a continued turn is spawned with.
 *
 * OpenCode continues a conversation with `--session <id>` in both of its
 * modes, but the two modes are different command lines:
 *
 *   batch (a prompt):   opencode run --format json [...] --session <id> -- "prompt"
 *   TUI   (no prompt):  opencode --session <id>
 *
 * Getting the batch half wrong is silent: a resume that loses `--session`
 * starts a fresh conversation (no context), and one that loses the YOLO
 * config can block forever on OpenCode's `question` tool, which waits on
 * stdin that a batch spawn never provides.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { AGENT_DEFINITIONS } from '../../../main/agents/definitions';
import { buildAgentArgs } from '../../../main/utils/agent-args';
import type { AgentConfig } from '../../../main/agents';

const opencode = AGENT_DEFINITIONS.find((a) => a.id === 'opencode') as unknown as AgentConfig;
const SESSION_ID = 'ses_4d585107dffeO9bO3HvMdvLYyC';
const PROJECT = '/Users/jane/Code/my app';

describe('OpenCode resume', () => {
	describe('arguments', () => {
		it('continues a batch turn with run --format json --session <id>', () => {
			const args = buildAgentArgs(opencode, {
				baseArgs: opencode.args,
				prompt: 'continue',
				cwd: PROJECT,
				agentSessionId: SESSION_ID,
			});
			expect(args).toEqual(['run', '--format', 'json', '--session', SESSION_ID]);
		});

		it('starts a fresh batch conversation (no --session) on the first turn', () => {
			const args = buildAgentArgs(opencode, {
				baseArgs: opencode.args,
				prompt: 'hello',
				cwd: PROJECT,
			});
			expect(args).toEqual(['run', '--format', 'json']);
		});

		it('reopens the TUI on the same session without batch-only flags', () => {
			const args = buildAgentArgs(opencode, {
				baseArgs: opencode.args,
				prompt: '',
				cwd: PROJECT,
				agentSessionId: SESSION_ID,
			});
			// `run` and `--format json` would turn the TUI launch into a batch run.
			expect(args).toEqual(['--session', SESSION_ID]);
		});

		it('keeps the plan agent and the model on a resumed read-only turn', () => {
			const args = buildAgentArgs(opencode, {
				baseArgs: opencode.args,
				prompt: 'look only',
				cwd: PROJECT,
				readOnlyMode: true,
				modelId: 'anthropic/claude-sonnet-4-20250514',
				agentSessionId: SESSION_ID,
			});
			expect(args).toEqual([
				'run',
				'--format',
				'json',
				'--agent',
				'plan',
				'--model',
				'anthropic/claude-sonnet-4-20250514',
				'--session',
				SESSION_ID,
			]);
		});

		it('separates the prompt with -- (a prompt may start with YAML frontmatter)', () => {
			// The spawner appends `-- <prompt>` unless the agent opts out; OpenCode
			// must not opt out, or `---` frontmatter is parsed as flags (#527).
			expect(opencode.noPromptSeparator).toBeFalsy();
			expect(opencode.promptArgs).toBeUndefined();
		});
	});

	describe('YOLO config (no stdin prompts during a resumed batch turn)', () => {
		const parse = (vars: Record<string, string> | undefined) =>
			JSON.parse(vars?.OPENCODE_CONFIG_CONTENT ?? 'null') as {
				permission: Record<string, string>;
				tools: Record<string, boolean>;
			};

		it.each([
			['normal turns', () => opencode.defaultEnvVars],
			['read-only turns', () => opencode.readOnlyEnvOverrides],
		])('allows every permission and disables the question tool for %s', (_label, vars) => {
			const config = parse(vars());
			expect(config.permission['*']).toBe('allow');
			expect(config.permission.external_directory).toBe('allow');
			// Both switches: "deny" via permissions and false via tools, since
			// OpenCode versions differ in which one they honor.
			expect(config.permission.question).toBe('deny');
			expect(config.tools.question).toBe(false);
		});
	});
});
