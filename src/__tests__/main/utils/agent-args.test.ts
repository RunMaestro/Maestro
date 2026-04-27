/**
 * Tests for src/main/utils/agent-args.ts
 *
 * Covers buildAgentArgs, applyAgentConfigOverrides, and getContextWindowValue.
 */

import { describe, it, expect, vi } from 'vitest';
import {
	buildAgentArgs,
	applyAgentConfigOverrides,
	getContextWindowValue,
} from '../../../main/utils/agent-args';
import type { AgentConfig } from '../../../main/agents';

vi.mock('../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

/**
 * Helper to create a minimal AgentConfig for testing.
 * Only the fields relevant to agent-args are populated.
 */
function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		id: 'test-agent',
		name: 'Test Agent',
		binaryName: 'test',
		command: 'test',
		args: ['--default'],
		available: true,
		capabilities: {} as AgentConfig['capabilities'],
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// buildAgentArgs
// ---------------------------------------------------------------------------
describe('buildAgentArgs', () => {
	it('returns baseArgs when agent is null', () => {
		const result = buildAgentArgs(null, { baseArgs: ['--foo', '--bar'] });
		expect(result).toEqual(['--foo', '--bar']);
	});

	it('returns baseArgs when agent is undefined', () => {
		const result = buildAgentArgs(undefined, { baseArgs: ['--foo'] });
		expect(result).toEqual(['--foo']);
	});

	// -- batchModePrefix --
	it('adds batchModePrefix before baseArgs when prompt provided', () => {
		const agent = makeAgent({ batchModePrefix: ['run'] });
		const result = buildAgentArgs(agent, {
			baseArgs: ['--print'],
			prompt: 'hello',
		});
		expect(result[0]).toBe('run');
		expect(result).toEqual(['run', '--print']);
	});

	it('does not add batchModePrefix when no prompt', () => {
		const agent = makeAgent({ batchModePrefix: ['run'] });
		const result = buildAgentArgs(agent, { baseArgs: ['--print'] });
		expect(result).toEqual(['--print']);
	});

	// -- forceBatchMode --
	// Regression: when a Cue template variable like {{CUE_SOURCE_OUTPUT}}
	// substituted to `""`, the empty-string prompt was falsy and dropped
	// batch-mode args. For Codex specifically, that meant spawning `codex`
	// (interactive TUI) instead of `codex exec` (batch), which died with
	// "Error: stdin is not a terminal" since Cue provides no TTY.
	it('adds batchModePrefix with empty prompt when forceBatchMode is true', () => {
		const agent = makeAgent({ batchModePrefix: ['exec'] });
		const result = buildAgentArgs(agent, {
			baseArgs: [],
			prompt: '',
			forceBatchMode: true,
		});
		expect(result).toEqual(['exec']);
	});

	it('adds batchModeArgs with empty prompt when forceBatchMode is true', () => {
		const agent = makeAgent({ batchModeArgs: ['--skip-git'] });
		const result = buildAgentArgs(agent, {
			baseArgs: ['--print'],
			prompt: '',
			forceBatchMode: true,
		});
		expect(result).toEqual(['--print', '--skip-git']);
	});

	it('adds jsonOutputArgs with empty prompt when forceBatchMode is true', () => {
		const agent = makeAgent({ jsonOutputArgs: ['--json'] });
		const result = buildAgentArgs(agent, {
			baseArgs: ['--print'],
			prompt: '',
			forceBatchMode: true,
		});
		expect(result).toEqual(['--print', '--json']);
	});

	it('still skips batch args with empty prompt when forceBatchMode is false', () => {
		const agent = makeAgent({
			batchModePrefix: ['exec'],
			batchModeArgs: ['--skip-git'],
			jsonOutputArgs: ['--json'],
		});
		const result = buildAgentArgs(agent, {
			baseArgs: ['--print'],
			prompt: '',
		});
		expect(result).toEqual(['--print']);
	});

	// -- batchModeArgs --
	it('adds batchModeArgs when prompt provided', () => {
		const agent = makeAgent({ batchModeArgs: ['--skip-git'] });
		const result = buildAgentArgs(agent, {
			baseArgs: ['--print'],
			prompt: 'hello',
		});
		expect(result).toEqual(['--print', '--skip-git']);
	});

	it('does not add batchModeArgs when no prompt', () => {
		const agent = makeAgent({ batchModeArgs: ['--skip-git'] });
		const result = buildAgentArgs(agent, { baseArgs: ['--print'] });
		expect(result).toEqual(['--print']);
	});

	// -- jsonOutputArgs --
	it('adds jsonOutputArgs when prompt provided and not already present', () => {
		const agent = makeAgent({ jsonOutputArgs: ['--format', 'json'] });
		const result = buildAgentArgs(agent, { baseArgs: ['--print'], prompt: 'hello' });
		expect(result).toEqual(['--print', '--format', 'json']);
	});

	it('does not add jsonOutputArgs for interactive sessions without a prompt', () => {
		const agent = makeAgent({ jsonOutputArgs: ['--format', 'json'] });
		const result = buildAgentArgs(agent, { baseArgs: ['--print'] });
		expect(result).toEqual(['--print']);
	});

	it('does not duplicate jsonOutputArgs when exact sequence already present', () => {
		const agent = makeAgent({ jsonOutputArgs: ['--format', 'json'] });
		const result = buildAgentArgs(agent, {
			baseArgs: ['--print', '--format', 'json'],
			prompt: 'hello',
		});
		// '--format json' exact sequence is already in baseArgs, so jsonOutputArgs should not be added
		expect(result).toEqual(['--print', '--format', 'json']);
	});

	it('does not duplicate jsonOutputArgs when same flag key present with different value', () => {
		const agent = makeAgent({ jsonOutputArgs: ['--format', 'json'] });
		const result = buildAgentArgs(agent, {
			baseArgs: ['--print', '--format', 'stream'],
			prompt: 'hello',
		});
		// '--format' flag key is already present, so jsonOutputArgs should not be added
		expect(result).toEqual(['--print', '--format', 'stream']);
	});

	it('skips jsonOutputArgs when prompt is empty', () => {
		const agent = makeAgent({ jsonOutputArgs: ['--format', 'json'] });
		const result = buildAgentArgs(agent, { baseArgs: ['--print'], prompt: '' });
		expect(result).toEqual(['--print']);
	});

	it('does not false-match jsonOutputArgs on bare value token', () => {
		const agent = makeAgent({ jsonOutputArgs: ['--output-format', 'json'] });
		const result = buildAgentArgs(agent, {
			baseArgs: ['--print', 'json'],
			prompt: 'hello',
		});
		// 'json' is a positional arg, not the '--output-format' flag, so jsonOutputArgs should be added
		expect(result).toEqual(['--print', 'json', '--output-format', 'json']);
	});

	// -- workingDirArgs --
	it('adds workingDirArgs when cwd provided', () => {
		const agent = makeAgent({
			workingDirArgs: (dir: string) => ['-C', dir],
		});
		const result = buildAgentArgs(agent, {
			baseArgs: ['--print'],
			cwd: '/home/user/project',
		});
		expect(result).toEqual(['--print', '-C', '/home/user/project']);
	});

	it('does not add workingDirArgs when cwd is not provided', () => {
		const agent = makeAgent({
			workingDirArgs: (dir: string) => ['-C', dir],
		});
		const result = buildAgentArgs(agent, { baseArgs: ['--print'] });
		expect(result).toEqual(['--print']);
	});

	// -- readOnlyArgs --
	it('adds readOnlyArgs when readOnlyMode is true', () => {
		const agent = makeAgent({ readOnlyArgs: ['--agent', 'plan'] });
		const result = buildAgentArgs(agent, {
			baseArgs: ['--print'],
			readOnlyMode: true,
		});
		expect(result).toEqual(['--print', '--agent', 'plan']);
	});

	it('does not add readOnlyArgs when readOnlyMode is false', () => {
		const agent = makeAgent({ readOnlyArgs: ['--agent', 'plan'] });
		const result = buildAgentArgs(agent, {
			baseArgs: ['--print'],
			readOnlyMode: false,
		});
		expect(result).toEqual(['--print']);
	});

	// -- modelArgs --
	it('adds modelArgs when modelId provided', () => {
		const agent = makeAgent({
			modelArgs: (model: string) => ['--model', model],
		});
		const result = buildAgentArgs(agent, {
			baseArgs: ['--print'],
			modelId: 'claude-3-opus',
		});
		expect(result).toEqual(['--print', '--model', 'claude-3-opus']);
	});

	it('does not add modelArgs when modelId is not provided', () => {
		const agent = makeAgent({
			modelArgs: (model: string) => ['--model', model],
		});
		const result = buildAgentArgs(agent, { baseArgs: ['--print'] });
		expect(result).toEqual(['--print']);
	});

	// -- yoloModeArgs --
	it('adds yoloModeArgs when yoloMode is true', () => {
		const agent = makeAgent({ yoloModeArgs: ['--dangerously-bypass'] });
		const result = buildAgentArgs(agent, {
			baseArgs: ['--print'],
			yoloMode: true,
		});
		expect(result).toEqual(['--print', '--dangerously-bypass']);
	});

	it('does not add yoloModeArgs when yoloMode is false', () => {
		const agent = makeAgent({ yoloModeArgs: ['--dangerously-bypass'] });
		const result = buildAgentArgs(agent, {
			baseArgs: ['--print'],
			yoloMode: false,
		});
		expect(result).toEqual(['--print']);
	});

	it('deduplicates Codex bypass flag when batch and yolo args both include it', () => {
		const agent = makeAgent({
			batchModeArgs: ['--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check'],
			yoloModeArgs: ['--dangerously-bypass-approvals-and-sandbox'],
		});
		const result = buildAgentArgs(agent, {
			baseArgs: ['--json'],
			prompt: 'fix bug',
			yoloMode: true,
		});
		expect(result).toEqual([
			'--json',
			'--dangerously-bypass-approvals-and-sandbox',
			'--skip-git-repo-check',
		]);
	});

	it('does not deduplicate positional args when deduplicating flags', () => {
		const agent = makeAgent({
			batchModeArgs: ['--dangerously-bypass-approvals-and-sandbox'],
			yoloModeArgs: ['--dangerously-bypass-approvals-and-sandbox'],
		});
		const result = buildAgentArgs(agent, {
			baseArgs: ['input-a', 'input-a'],
			prompt: 'fix bug',
			yoloMode: true,
		});
		expect(result).toEqual(['input-a', 'input-a', '--dangerously-bypass-approvals-and-sandbox']);
	});

	// -- resumeArgs --
	it('adds resumeArgs when agentSessionId provided', () => {
		const agent = makeAgent({
			resumeArgs: (sid: string) => ['--resume', sid],
		});
		const result = buildAgentArgs(agent, {
			baseArgs: ['--print'],
			agentSessionId: 'sess-123',
		});
		expect(result).toEqual(['--print', '--resume', 'sess-123']);
	});

	it('does not add resumeArgs when agentSessionId is not provided', () => {
		const agent = makeAgent({
			resumeArgs: (sid: string) => ['--resume', sid],
		});
		const result = buildAgentArgs(agent, { baseArgs: ['--print'] });
		expect(result).toEqual(['--print']);
	});

	// -- combined --
	it('combines multiple options together', () => {
		const agent = makeAgent({
			batchModePrefix: ['run'],
			batchModeArgs: ['--skip-git'],
			jsonOutputArgs: ['--format', 'json'],
			workingDirArgs: (dir: string) => ['-C', dir],
			readOnlyArgs: ['--agent', 'plan'],
			modelArgs: (model: string) => ['--model', model],
			yoloModeArgs: ['--yolo'],
			resumeArgs: (sid: string) => ['--resume', sid],
		});

		const result = buildAgentArgs(agent, {
			baseArgs: ['--print'],
			prompt: 'do stuff',
			cwd: '/tmp',
			readOnlyMode: true,
			modelId: 'gpt-4',
			yoloMode: true,
			agentSessionId: 'abc',
		});

		// batchModeArgs (--skip-git) is omitted when readOnlyMode is true —
		// batch mode args grant write/approval permissions that conflict with read-only
		expect(result).toEqual([
			'run',
			'--print',
			'--format',
			'json',
			'-C',
			'/tmp',
			'--agent',
			'plan',
			'--model',
			'gpt-4',
			'--yolo',
			'--resume',
			'abc',
		]);
	});

	// -- readOnlyMode + batchModeArgs interaction (TASK-S05) --
	it('skips batchModeArgs when readOnlyMode is true even with empty readOnlyArgs', () => {
		// Gemini CLI scenario: readOnlyArgs is [] but -y should still be skipped
		const agent = makeAgent({
			batchModeArgs: ['-y'],
			readOnlyArgs: [],
		});
		const result = buildAgentArgs(agent, {
			baseArgs: ['--output-format', 'stream-json'],
			prompt: 'analyze this code',
			readOnlyMode: true,
		});
		expect(result).not.toContain('-y');
		expect(result).toEqual(['--output-format', 'stream-json']);
	});

	it('skips batchModeArgs when readOnlyMode is true and readOnlyArgs is undefined', () => {
		const agent = makeAgent({
			batchModeArgs: ['--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check'],
		});
		const result = buildAgentArgs(agent, {
			baseArgs: ['--json'],
			prompt: 'review code',
			readOnlyMode: true,
		});
		expect(result).not.toContain('--dangerously-bypass-approvals-and-sandbox');
		expect(result).not.toContain('--skip-git-repo-check');
	});

	it('includes batchModeArgs when readOnlyMode is false even with empty readOnlyArgs', () => {
		const agent = makeAgent({
			batchModeArgs: ['-y'],
			readOnlyArgs: [],
		});
		const result = buildAgentArgs(agent, {
			baseArgs: ['--output-format', 'stream-json'],
			prompt: 'fix this bug',
			readOnlyMode: false,
		});
		expect(result).toContain('-y');
	});

	it('logs warning when readOnlyMode requested and readOnlyCliEnforced is false', async () => {
		const { logger } = await import('../../../main/utils/logger');
		vi.mocked(logger.warn).mockClear();

		const agent = makeAgent({
			readOnlyArgs: [],
			readOnlyCliEnforced: false,
		});
		buildAgentArgs(agent, {
			baseArgs: [],
			readOnlyMode: true,
		});
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining('read-only mode requested but no CLI-level enforcement'),
			'[AgentArgs]',
			{ agentId: 'test-agent' }
		);
	});

	it('does not log warning when readOnlyCliEnforced is true', async () => {
		const { logger } = await import('../../../main/utils/logger');
		vi.mocked(logger.warn).mockClear();

		const agent = makeAgent({
			readOnlyArgs: ['--agent', 'plan'],
			readOnlyCliEnforced: true,
		});
		buildAgentArgs(agent, {
			baseArgs: [],
			readOnlyMode: true,
		});
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it('does not log warning when readOnlyCliEnforced is undefined', async () => {
		const { logger } = await import('../../../main/utils/logger');
		vi.mocked(logger.warn).mockClear();

		const agent = makeAgent({
			readOnlyArgs: ['--sandbox', 'read-only'],
		});
		buildAgentArgs(agent, {
			baseArgs: [],
			readOnlyMode: true,
		});
		// readOnlyCliEnforced is undefined (not explicitly false), so no warning
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it('does not mutate the original baseArgs array', () => {
		const baseArgs = ['--print'];
		const agent = makeAgent({ jsonOutputArgs: ['--format', 'json'] });
		buildAgentArgs(agent, { baseArgs, prompt: 'test' });
		expect(baseArgs).toEqual(['--print']);
	});

	// -- Real agent config: readOnly mode produces correct non-interactive commands --
	describe('readOnly mode with real agent configs', () => {
		it('Codex: readOnlyArgs include bypass flags for non-interactive execution', () => {
			const codexAgent = makeAgent({
				id: 'codex',
				batchModePrefix: ['exec'],
				batchModeArgs: ['--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check'],
				jsonOutputArgs: ['--json'],
				readOnlyArgs: [
					'--sandbox',
					'read-only',
					'--dangerously-bypass-approvals-and-sandbox',
					'--skip-git-repo-check',
				],
				workingDirArgs: (dir: string) => ['-C', dir],
			});

			const result = buildAgentArgs(codexAgent, {
				baseArgs: [],
				prompt: 'generate a tab name',
				cwd: '/project',
				readOnlyMode: true,
			});

			// batchModeArgs skipped, but readOnlyArgs provides the needed flags
			expect(result).toContain('exec');
			expect(result).toContain('--sandbox');
			expect(result).toContain('read-only');
			expect(result).toContain('--dangerously-bypass-approvals-and-sandbox');
			expect(result).toContain('--skip-git-repo-check');
			expect(result).toContain('--json');
			expect(result).toContain('-C');
			expect(result).toContain('/project');
		});

		it('Codex: non-readOnly mode deduplicates flags from batchModeArgs and yoloModeArgs', () => {
			const codexAgent = makeAgent({
				id: 'codex',
				batchModePrefix: ['exec'],
				batchModeArgs: ['--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check'],
				jsonOutputArgs: ['--json'],
				readOnlyArgs: [
					'--sandbox',
					'read-only',
					'--dangerously-bypass-approvals-and-sandbox',
					'--skip-git-repo-check',
				],
				yoloModeArgs: ['--dangerously-bypass-approvals-and-sandbox'],
				workingDirArgs: (dir: string) => ['-C', dir],
			});

			const result = buildAgentArgs(codexAgent, {
				baseArgs: [],
				prompt: 'fix a bug',
				cwd: '/project',
				readOnlyMode: false,
				yoloMode: true,
			});

			// --dangerously-bypass-approvals-and-sandbox should appear only once (deduped)
			const bypassCount = result.filter(
				(a) => a === '--dangerously-bypass-approvals-and-sandbox'
			).length;
			expect(bypassCount).toBe(1);
			// readOnlyArgs should NOT be included
			expect(result).not.toContain('--sandbox');
			expect(result).not.toContain('read-only');
		});

		it('Gemini CLI: readOnlyArgs include -y for non-interactive execution', () => {
			const geminiAgent = makeAgent({
				id: 'gemini-cli',
				batchModeArgs: ['-y'],
				jsonOutputArgs: ['--output-format', 'stream-json'],
				readOnlyArgs: ['-y'],
				readOnlyCliEnforced: false,
				promptArgs: (prompt: string) => ['-p', prompt],
			});

			const result = buildAgentArgs(geminiAgent, {
				baseArgs: [],
				prompt: 'generate a tab name',
				readOnlyMode: true,
			});

			// batchModeArgs skipped, but readOnlyArgs provides -y
			expect(result).toContain('-y');
			expect(result).toContain('--output-format');
			expect(result).toContain('stream-json');
		});

		it('Factory Droid: readOnly works without extra flags (exec is read-only by default)', () => {
			const droidAgent = makeAgent({
				id: 'factory-droid',
				batchModePrefix: ['exec'],
				batchModeArgs: ['--skip-permissions-unsafe'],
				jsonOutputArgs: ['-o', 'stream-json'],
				readOnlyArgs: [],
				readOnlyCliEnforced: true,
				workingDirArgs: (dir: string) => ['--cwd', dir],
				noPromptSeparator: true,
			});

			const result = buildAgentArgs(droidAgent, {
				baseArgs: [],
				prompt: 'generate a tab name',
				cwd: '/project',
				readOnlyMode: true,
			});

			// --skip-permissions-unsafe should NOT be present (exec is read-only by default)
			expect(result).not.toContain('--skip-permissions-unsafe');
			expect(result).toContain('exec');
			expect(result).toContain('-o');
			expect(result).toContain('stream-json');
		});
	});
});

// ---------------------------------------------------------------------------
// applyAgentConfigOverrides
// ---------------------------------------------------------------------------
describe('applyAgentConfigOverrides', () => {
	it('processes configOptions with argBuilder', () => {
		const agent = makeAgent({
			configOptions: [
				{
					key: 'maxTokens',
					type: 'number',
					label: 'Max Tokens',
					description: 'Max tokens',
					default: 1000,
					argBuilder: (val: any) => ['--max-tokens', String(val)],
				},
			],
		});

		const result = applyAgentConfigOverrides(agent, ['--print'], {});
		expect(result.args).toEqual(['--print', '--max-tokens', '1000']);
	});

	it('skips configOptions without argBuilder', () => {
		const agent = makeAgent({
			configOptions: [
				{
					key: 'maxTokens',
					type: 'number',
					label: 'Max Tokens',
					description: 'Max tokens',
					default: 1000,
					// no argBuilder
				},
			],
		});

		const result = applyAgentConfigOverrides(agent, ['--print'], {});
		expect(result.args).toEqual(['--print']);
	});

	// -- model precedence --
	it('model precedence: session overrides agent overrides default', () => {
		const agent = makeAgent({
			configOptions: [
				{
					key: 'model',
					type: 'text',
					label: 'Model',
					description: 'Model',
					default: 'default-model',
					argBuilder: (val: any) => ['--model', String(val)],
				},
			],
		});

		// default
		const r1 = applyAgentConfigOverrides(agent, [], {});
		expect(r1.args).toEqual(['--model', 'default-model']);
		expect(r1.modelSource).toBe('default');

		// agent overrides default
		const r2 = applyAgentConfigOverrides(agent, [], {
			agentConfigValues: { model: 'agent-model' },
		});
		expect(r2.args).toEqual(['--model', 'agent-model']);
		expect(r2.modelSource).toBe('agent');

		// session overrides agent
		const r3 = applyAgentConfigOverrides(agent, [], {
			agentConfigValues: { model: 'agent-model' },
			sessionCustomModel: 'session-model',
		});
		expect(r3.args).toEqual(['--model', 'session-model']);
		expect(r3.modelSource).toBe('session');
	});

	it('uses agentConfigValues for non-model config options', () => {
		const agent = makeAgent({
			configOptions: [
				{
					key: 'temperature',
					type: 'text',
					label: 'Temperature',
					description: 'Temperature',
					default: '0.7',
					argBuilder: (val: any) => ['--temp', String(val)],
				},
			],
		});

		const result = applyAgentConfigOverrides(agent, [], {
			agentConfigValues: { temperature: '0.9' },
		});
		expect(result.args).toEqual(['--temp', '0.9']);
	});

	// -- custom args --
	it('custom args from session override agent config', () => {
		const agent = makeAgent();

		const result = applyAgentConfigOverrides(agent, ['--print'], {
			agentConfigValues: { customArgs: '--from-agent' },
			sessionCustomArgs: '--from-session',
		});
		expect(result.args).toContain('--from-session');
		expect(result.args).not.toContain('--from-agent');
		expect(result.customArgsSource).toBe('session');
	});

	it('uses agent customArgs when session customArgs not provided', () => {
		const agent = makeAgent();

		const result = applyAgentConfigOverrides(agent, ['--print'], {
			agentConfigValues: { customArgs: '--from-agent' },
		});
		expect(result.args).toContain('--from-agent');
		expect(result.customArgsSource).toBe('agent');
	});

	it('customArgsSource is none when no custom args exist', () => {
		const agent = makeAgent();

		const result = applyAgentConfigOverrides(agent, ['--print'], {});
		expect(result.customArgsSource).toBe('none');
	});

	// -- parseCustomArgs (tested through applyAgentConfigOverrides) --
	it('parses quoted custom args correctly', () => {
		const agent = makeAgent();

		const result = applyAgentConfigOverrides(agent, [], {
			sessionCustomArgs: '--flag "arg with spaces" \'another arg\' plain',
		});
		expect(result.args).toEqual(['--flag', 'arg with spaces', 'another arg', 'plain']);
		expect(result.customArgsSource).toBe('session');
	});

	it('returns customArgsSource none for empty custom args string', () => {
		const agent = makeAgent();

		const result = applyAgentConfigOverrides(agent, ['--print'], {
			sessionCustomArgs: '   ',
		});
		// Whitespace-only string should parse to empty array
		expect(result.customArgsSource).toBe('none');
		expect(result.args).toEqual(['--print']);
	});

	// -- env vars --
	it('merges env vars with correct precedence', () => {
		const agent = makeAgent({
			defaultEnvVars: { A: 'default-a', B: 'default-b' },
		});

		// Agent config values override defaults
		const r1 = applyAgentConfigOverrides(agent, [], {
			agentConfigValues: { customEnvVars: { A: 'agent-a', C: 'agent-c' } },
		});
		expect(r1.effectiveCustomEnvVars).toEqual({
			A: 'agent-a',
			B: 'default-b',
			C: 'agent-c',
		});
		expect(r1.customEnvSource).toBe('agent');

		// Session env vars override both agent config and defaults
		const r2 = applyAgentConfigOverrides(agent, [], {
			agentConfigValues: { customEnvVars: { A: 'agent-a' } },
			sessionCustomEnvVars: { A: 'session-a', D: 'session-d' },
		});
		expect(r2.effectiveCustomEnvVars).toEqual({
			A: 'session-a',
			B: 'default-b',
			D: 'session-d',
		});
		expect(r2.customEnvSource).toBe('session');
	});

	it('returns undefined effectiveCustomEnvVars when no env vars exist', () => {
		const agent = makeAgent(); // no defaultEnvVars
		const result = applyAgentConfigOverrides(agent, [], {});
		expect(result.effectiveCustomEnvVars).toBeUndefined();
		expect(result.customEnvSource).toBe('none');
	});

	it('returns agent defaultEnvVars when no overrides are provided', () => {
		const agent = makeAgent({
			defaultEnvVars: { FOO: 'bar' },
		});

		const result = applyAgentConfigOverrides(agent, [], {});
		expect(result.effectiveCustomEnvVars).toEqual({ FOO: 'bar' });
		// No user-configured env vars, so source should be 'none'
		expect(result.customEnvSource).toBe('none');
	});

	it('returns correct source indicators', () => {
		const agent = makeAgent({
			configOptions: [
				{
					key: 'model',
					type: 'text',
					label: 'Model',
					description: 'Model',
					default: 'default-model',
					argBuilder: (val: any) => ['--model', String(val)],
				},
			],
			defaultEnvVars: { X: '1' },
		});

		const result = applyAgentConfigOverrides(agent, [], {
			sessionCustomModel: 'my-model',
			sessionCustomArgs: '--extra',
			sessionCustomEnvVars: { Y: '2' },
		});

		expect(result.modelSource).toBe('session');
		expect(result.customArgsSource).toBe('session');
		expect(result.customEnvSource).toBe('session');
	});

	// -- null/undefined agent --
	it('handles null agent', () => {
		const result = applyAgentConfigOverrides(null, ['--print'], {
			sessionCustomArgs: '--extra',
		});
		expect(result.args).toEqual(['--print', '--extra']);
		expect(result.modelSource).toBe('default');
	});

	it('handles undefined agent', () => {
		const result = applyAgentConfigOverrides(undefined, ['--base'], {});
		expect(result.args).toEqual(['--base']);
		expect(result.modelSource).toBe('default');
		expect(result.customArgsSource).toBe('none');
		expect(result.customEnvSource).toBe('none');
	});

	it('does not mutate the original baseArgs array', () => {
		const baseArgs = ['--print'];
		const agent = makeAgent({
			configOptions: [
				{
					key: 'foo',
					type: 'text',
					label: 'Foo',
					description: 'Foo',
					default: 'bar',
					argBuilder: (val: any) => ['--foo', String(val)],
				},
			],
		});
		applyAgentConfigOverrides(agent, baseArgs, {});
		expect(baseArgs).toEqual(['--print']);
	});
});

// ---------------------------------------------------------------------------
// getContextWindowValue
// ---------------------------------------------------------------------------
describe('getContextWindowValue', () => {
	it('session-level override takes highest priority', () => {
		const agent = makeAgent({
			configOptions: [
				{
					key: 'contextWindow',
					type: 'number',
					label: 'Context Window',
					description: 'Context window size',
					default: 100000,
				},
			],
		});

		const result = getContextWindowValue(agent, { contextWindow: 50000 }, 200000);
		expect(result).toBe(200000);
	});

	it('falls back to agentConfigValues when no session override', () => {
		const agent = makeAgent({
			configOptions: [
				{
					key: 'contextWindow',
					type: 'number',
					label: 'Context Window',
					description: 'Context window size',
					default: 100000,
				},
			],
		});

		const result = getContextWindowValue(agent, { contextWindow: 50000 });
		expect(result).toBe(50000);
	});

	it('falls back to configOption default when no agentConfigValues', () => {
		const agent = makeAgent({
			configOptions: [
				{
					key: 'contextWindow',
					type: 'number',
					label: 'Context Window',
					description: 'Context window size',
					default: 100000,
				},
			],
		});

		const result = getContextWindowValue(agent, {});
		expect(result).toBe(100000);
	});

	it('returns 0 when no config exists', () => {
		const agent = makeAgent(); // no configOptions
		const result = getContextWindowValue(agent, {});
		expect(result).toBe(0);
	});

	it('returns 0 when agent is null', () => {
		const result = getContextWindowValue(null, {});
		expect(result).toBe(0);
	});

	it('returns 0 when agent is undefined', () => {
		const result = getContextWindowValue(undefined, {});
		expect(result).toBe(0);
	});

	it('ignores session override of 0', () => {
		const agent = makeAgent({
			configOptions: [
				{
					key: 'contextWindow',
					type: 'number',
					label: 'Context Window',
					description: 'Context window size',
					default: 100000,
				},
			],
		});

		// sessionCustomContextWindow of 0 should be ignored (not > 0)
		const result = getContextWindowValue(agent, { contextWindow: 50000 }, 0);
		expect(result).toBe(50000);
	});

	it('ignores session override when undefined', () => {
		const agent = makeAgent({
			configOptions: [
				{
					key: 'contextWindow',
					type: 'number',
					label: 'Context Window',
					description: 'Context window size',
					default: 100000,
				},
			],
		});

		const result = getContextWindowValue(agent, { contextWindow: 50000 }, undefined);
		expect(result).toBe(50000);
	});
});
