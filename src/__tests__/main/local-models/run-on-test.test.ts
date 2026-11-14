/**
 * @file run-on-test.test.ts
 *
 * The Run on Test: one short turn through the real harness, launched the way
 * the agent's own turns are. The stores, the source's model list and the turn
 * itself are injected, so nothing is spawned and no network is touched.
 *
 * What is pinned: the test launches with the target applied (the recipe's
 * variables and model are on the process it would start); it is read-only; a
 * target that cannot run is refused with the launch's own code and words and
 * starts nothing; it never runs on the provider's model; a form's unsaved
 * values replace the stored agent's; and an SSH agent is tested on its remote.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const wrapSpawnWithSsh = vi.fn();
vi.mock('../../../main/utils/ssh-spawn-wrapper', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../main/utils/ssh-spawn-wrapper')>()),
	wrapSpawnWithSsh: (...args: unknown[]) => wrapSpawnWithSsh(...args),
}));

/** When set, what the Windows shell plan answers, in place of this host's own answer. */
const shellPlan = vi.hoisted(() => ({
	forced: null as null | { command: string; args: string[]; shell: boolean | string },
}));
vi.mock('../../../main/process-manager/utils/windowsSpawnShell', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('../../../main/process-manager/utils/windowsSpawnShell')>();
	return {
		...actual,
		planSpawnShell: (...args: Parameters<typeof actual.planSpawnShell>) =>
			shellPlan.forced ?? actual.planSpawnShell(...args),
	};
});

import {
	configureAgentRunOn,
	resetAgentRunOnForTests,
	type AgentRunOnDeps,
} from '../../../main/local-models/run-on';
import {
	configureRunOnTest,
	resetRunOnTestForTests,
	testAgentRunOn,
	type RunOnTestDeps,
} from '../../../main/local-models/run-on-test';
import type { LocalModelEndpoint } from '../../../shared/local-models/endpoints';
import {
	RUN_ON_TEST_PROMPT,
	RUN_ON_TEST_REPLY_MAX_CHARS,
	type RunOnSourceTarget,
} from '../../../shared/local-models/run-on';
import type { CompletedTurn } from '../../../shared/maestro-lib/run/run-to-completion';
import type { TurnProcessSpec } from '../../../shared/maestro-lib/run/start-turn';
import type { SshRemoteConfig } from '../../../shared/types';

const OLLAMA: LocalModelEndpoint = {
	id: 'ep-ollama',
	name: 'Ollama',
	kind: 'ollama',
	baseUrl: 'http://127.0.0.1:11434',
	enabled: true,
};

const WORKSTATION: LocalModelEndpoint = {
	id: 'ep-ws',
	name: 'Workstation',
	kind: 'openai-compatible',
	baseUrl: 'https://models.example.com',
	apiKeyEnvVar: 'WORKSTATION_KEY',
	enabled: true,
};

const QWEN: RunOnSourceTarget = {
	type: 'source',
	endpointId: OLLAMA.id,
	model: 'qwen3:latest',
	contextTokens: 65_536,
};
const BIG: RunOnSourceTarget = { type: 'source', endpointId: WORKSTATION.id, model: 'big-model' };

const REMOTE: SshRemoteConfig = {
	id: 'remote-1',
	name: 'Build box',
	host: 'build.example.com',
	port: 22,
	username: 'dev',
	privateKeyPath: '',
	enabled: true,
};

const AGENT = {
	id: 'agent-1',
	name: 'Scout',
	toolType: 'claude-code',
	projectRoot: '/work/project',
	cwd: '/work/project',
	runOn: QWEN,
};

function turn(overrides: Partial<CompletedTurn> = {}): CompletedTurn {
	return {
		outcome: 'completed',
		answerText: 'ready',
		sessionId: 'provider-session',
		usage: undefined,
		error: undefined,
		exit: {
			exitCode: 0,
			signal: null,
			interrupted: false,
			stderrText: '',
			stdoutText: '',
			droppedOutputBytes: 0,
		},
		...overrides,
	};
}

let runOnDeps: { [K in keyof Required<AgentRunOnDeps>]: ReturnType<typeof vi.fn> };
let runTurn: ReturnType<typeof vi.fn>;
let testDeps: RunOnTestDeps;

function configure(
	sessions: Array<Record<string, unknown>> = [AGENT],
	overrides: Partial<RunOnTestDeps> = {}
): void {
	runOnDeps = {
		sessions: vi.fn(() => sessions),
		endpoints: vi.fn(() => [OLLAMA, WORKSTATION]),
		shellEnvVars: vi.fn(() => ({ WORKSTATION_KEY: 'sk-workstation' })),
		modelServer: vi.fn(async () => ({ ok: true, baseUrl: 'http://127.0.0.1:52100', key: 'sk' })),
		listModels: vi.fn(async () => [{ id: 'qwen3:latest' }, { id: 'big-model' }]),
	};
	configureAgentRunOn(runOnDeps as unknown as AgentRunOnDeps);
	runTurn = vi.fn(async () => turn());
	testDeps = {
		agentConfig: vi.fn(() => ({})),
		detectedAgentPath: vi.fn(async () => '/opt/bin/claude'),
		sshStore: () => ({ getSshRemotes: () => [REMOTE] }),
		shellEnvVars: () => ({ WORKSTATION_KEY: 'sk-workstation' }),
		runTurn: runTurn as unknown as RunOnTestDeps['runTurn'],
		...overrides,
	};
	configureRunOnTest(testDeps);
}

/** The process the test would have started. */
function startedSpec(): TurnProcessSpec {
	expect(runTurn).toHaveBeenCalledTimes(1);
	return runTurn.mock.calls[0][0] as TurnProcessSpec;
}

beforeEach(() => {
	vi.clearAllMocks();
	shellPlan.forced = null;
	configure();
});

afterEach(() => {
	resetRunOnTestForTests();
	resetAgentRunOnForTests();
});

describe('testAgentRunOn: a turn on the target', () => {
	it('launches the stored agent on its target and reports the reply', async () => {
		const result = await testAgentRunOn({ agentId: 'agent-1' });

		expect(result).toMatchObject({
			ok: true,
			model: 'qwen3:latest',
			label: 'qwen3:latest on Ollama',
			reply: 'ready',
			contextTokens: 65_536,
		});
		const spec = startedSpec();
		expect(spec.command).toBe('/opt/bin/claude');
		expect(spec.cwd).toBe('/work/project');
		// The recipe is on the process: the source's address, the model in the
		// provider's own flag, and the context the harness is told.
		expect(spec.env.ANTHROPIC_BASE_URL).toBe(OLLAMA.baseUrl);
		expect(spec.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('65536');
		const modelFlag = spec.args.indexOf('--model');
		expect(spec.args[modelFlag + 1]).toBe('qwen3:latest');
		expect(spec.args).toContain(RUN_ON_TEST_PROMPT);
	});

	it('starts a harness directly when this system can, with no shell', async () => {
		await testAgentRunOn({ agentId: 'agent-1' });

		expect(startedSpec().shell).toBeUndefined();
	});

	it('starts a harness Windows cannot spawn directly through the shell a tab spawn uses', async () => {
		// What the shell plan answers on Windows for an npm `.cmd` shim: Node
		// refuses to spawn one directly ("spawn EINVAL"), so it goes through
		// cmd.exe with the path quoted and the arguments escaped.
		shellPlan.forced = {
			command: '"C:\\Users\\Pat Doe\\AppData\\Roaming\\npm\\claude.cmd"',
			args: ['--print', '"escaped for cmd.exe"'],
			shell: true,
		};

		const result = await testAgentRunOn({ agentId: 'agent-1' });

		expect(result).toMatchObject({ ok: true, model: 'qwen3:latest' });
		const spec = startedSpec();
		expect(spec.command).toBe(shellPlan.forced.command);
		expect(spec.args).toEqual(['--print', '"escaped for cmd.exe"']);
		expect(spec.shell).toBe(true);
		// The target is still on the process that starts.
		expect(spec.env.ANTHROPIC_BASE_URL).toBe(OLLAMA.baseUrl);
		expect(spec.cwd).toBe('/work/project');
	});

	it('is read-only: it does not hand the model write access to answer one word', async () => {
		await testAgentRunOn({ agentId: 'agent-1' });

		const { args } = startedSpec();
		expect(args).not.toContain('--dangerously-skip-permissions');
		const mode = args.indexOf('--permission-mode');
		expect(args[mode + 1]).toBe('plan');
	});

	it('runs the turn as the agent, under a budget, with no stdin left open', async () => {
		await testAgentRunOn({ agentId: 'agent-1' });

		const options = runTurn.mock.calls[0][1];
		expect(options.agentId).toBe('claude-code');
		expect(options.emptyStdin).toBe('ignore');
		expect(options.signal).toBeInstanceOf(AbortSignal);
	});

	it('tests a target that is not saved yet in place of the stored one', async () => {
		const result = await testAgentRunOn({ agentId: 'agent-1', target: BIG });

		expect(result).toMatchObject({ ok: true, model: 'big-model' });
		const spec = startedSpec();
		expect(spec.env.ANTHROPIC_BASE_URL).toBe(WORKSTATION.baseUrl);
		expect(spec.env.ANTHROPIC_AUTH_TOKEN).toBe('sk-workstation');
	});

	it('launches with a form that is not saved yet, as a set', async () => {
		configure([{ ...AGENT, customArgs: '--stored-flag', customEnvVars: { STORED: '1' } }]);

		await testAgentRunOn({
			agentId: 'agent-1',
			subject: { toolType: 'codex', cwd: '/work/other', customEnvVars: { FORM: '1' } },
		});

		const spec = startedSpec();
		expect(runTurn.mock.calls[0][1].agentId).toBe('codex');
		expect(spec.cwd).toBe('/work/other');
		expect(spec.env.FORM).toBe('1');
		// What the form left out is unset in the form, not filled from the agent.
		expect(spec.env.STORED).toBeUndefined();
		expect(spec.args).not.toContain('--stored-flag');
	});

	it('tests an agent that does not exist yet from the form alone', async () => {
		const result = await testAgentRunOn({
			target: QWEN,
			subject: { toolType: 'claude-code', cwd: '/work/new' },
		});

		expect(result.ok).toBe(true);
		expect(startedSpec().cwd).toBe('/work/new');
	});

	it('caps a long reply', async () => {
		runTurn.mockResolvedValueOnce(turn({ answerText: 'x'.repeat(5_000) }));

		const result = await testAgentRunOn({ agentId: 'agent-1' });

		expect(result.ok && result.reply.length).toBe(RUN_ON_TEST_REPLY_MAX_CHARS);
	});
});

describe('testAgentRunOn: what it refuses before anything starts', () => {
	it.each([
		['an agent that is not stored', { agentId: 'agent-9' }, 'No agent has the id "agent-9"'],
		['a request that names nothing', {}, 'needs an agent or a provider'],
		[
			'a form with no working directory',
			{ target: QWEN, subject: { toolType: 'claude-code' } },
			'needs a working directory',
		],
	])('refuses %s', async (_name, request, expected) => {
		const result = await testAgentRunOn(request);

		expect(result).toMatchObject({ ok: false, code: 'run-on-test-invalid-request' });
		expect(!result.ok && result.message).toContain(expected);
		expect(runTurn).not.toHaveBeenCalled();
	});

	it.each([[undefined], [{ type: 'provider' }]])(
		'never tests the provider model: %j has no source to test',
		async (runOn) => {
			configure([{ ...AGENT, runOn }]);

			const result = await testAgentRunOn({ agentId: 'agent-1' });

			expect(result).toMatchObject({ ok: false, code: 'run-on-test-provider-target' });
			expect(runTurn).not.toHaveBeenCalled();
			expect(runOnDeps.listModels).not.toHaveBeenCalled();
		}
	);

	it('refuses a provider with no recipe, in the launch own words', async () => {
		const result = await testAgentRunOn({
			agentId: 'agent-1',
			subject: { toolType: 'gemini-cli', cwd: '/work/project' },
		});

		expect(result).toMatchObject({ ok: false, code: 'run-on-unsupported-provider' });
		expect(runTurn).not.toHaveBeenCalled();
	});

	it('refuses a source that does not serve the model', async () => {
		runOnDeps.listModels.mockResolvedValueOnce([{ id: 'other:latest' }]);

		const result = await testAgentRunOn({ agentId: 'agent-1' });

		expect(result).toMatchObject({ ok: false, code: 'run-on-model-not-served' });
		expect(!result.ok && result.message).toContain('does not serve "qwen3:latest"');
		expect(runTurn).not.toHaveBeenCalled();
	});

	it('refuses a malformed target instead of reading it as the provider', async () => {
		const result = await testAgentRunOn({
			agentId: 'agent-1',
			target: { type: 'source', endpointId: OLLAMA.id },
		});

		expect(result).toMatchObject({ ok: false, code: 'run-on-invalid-target' });
		expect(runTurn).not.toHaveBeenCalled();
	});

	it('refuses a provider that cannot run a single turn', async () => {
		const result = await testAgentRunOn({
			target: QWEN,
			subject: { toolType: 'terminal', cwd: '/work/project' },
		});

		expect(result.ok).toBe(false);
		expect(runTurn).not.toHaveBeenCalled();
	});

	it('throws when the process was never given its stores', async () => {
		resetRunOnTestForTests();

		await expect(testAgentRunOn({ agentId: 'agent-1' })).rejects.toThrow('configureRunOnTest');
	});
});

describe('testAgentRunOn: a turn that did not answer', () => {
	it('reports a turn the budget stopped', async () => {
		runTurn.mockResolvedValueOnce(turn({ outcome: 'interrupted', answerText: undefined }));

		const result = await testAgentRunOn({ agentId: 'agent-1' });

		expect(result).toMatchObject({ ok: false, code: 'run-on-test-timeout' });
		expect(!result.ok && result.message).toContain('qwen3:latest on Ollama');
	});

	it('reports what the harness said when the turn crashed, with no key in it', async () => {
		runTurn.mockResolvedValueOnce(
			turn({
				outcome: 'crashed',
				answerText: undefined,
				exit: {
					exitCode: 1,
					signal: null,
					interrupted: false,
					stderrText:
						'boot\nAPI Error: 401 bad key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n',
					stdoutText: '',
					droppedOutputBytes: 0,
				},
			})
		);

		const result = await testAgentRunOn({ agentId: 'agent-1' });

		expect(result).toMatchObject({ ok: false, code: 'run-on-test-turn-failed' });
		expect(!result.ok && result.message).toContain('API Error: 401');
		expect(!result.ok && result.message).not.toContain('sk-ant-api03-AAAA');
	});

	it('prefers the classified error to raw stderr', async () => {
		runTurn.mockResolvedValueOnce(
			turn({
				outcome: 'crashed',
				answerText: undefined,
				error: {
					type: 'agent_crashed',
					message: 'Prompt is too long',
					recoverable: false,
					agentId: 'claude-code',
					timestamp: 1,
				},
			})
		);

		const result = await testAgentRunOn({ agentId: 'agent-1' });

		expect(!result.ok && result.message).toBe(
			'Claude Code did not complete a turn on qwen3:latest on Ollama: Prompt is too long.'
		);
	});

	it('reports an empty reply as a failure, not a pass', async () => {
		runTurn.mockResolvedValueOnce(turn({ answerText: '   ' }));

		const result = await testAgentRunOn({ agentId: 'agent-1' });

		expect(result).toMatchObject({ ok: false, code: 'run-on-test-turn-failed' });
		expect(!result.ok && result.message).toContain('empty reply');
	});

	it('names the exit code when the harness said nothing', async () => {
		runTurn.mockResolvedValueOnce(
			turn({
				outcome: 'crashed',
				answerText: undefined,
				exit: {
					exitCode: 127,
					signal: null,
					interrupted: false,
					stderrText: '',
					stdoutText: '',
					droppedOutputBytes: 0,
				},
			})
		);

		const result = await testAgentRunOn({ agentId: 'agent-1' });

		expect(!result.ok && result.message).toContain('exited with code 127');
	});
});

describe('testAgentRunOn: an agent on an SSH remote', () => {
	const SSH = { enabled: true, remoteId: REMOTE.id, workingDirOverride: '~/project' };

	beforeEach(() => {
		wrapSpawnWithSsh.mockResolvedValue({
			command: 'ssh',
			args: ['build.example.com'],
			cwd: '/Users/me',
			sshStdinScript: 'exec claude ...',
			sshRemoteUsed: REMOTE,
		});
	});

	it('runs the test on the remote, through the SSH wrapper', async () => {
		configure([{ ...AGENT, runOn: BIG, sessionSshRemoteConfig: SSH }]);

		const result = await testAgentRunOn({ agentId: 'agent-1' });

		expect(result.ok).toBe(true);
		const [wrapConfig, sshConfig] = wrapSpawnWithSsh.mock.calls[0];
		// The remote runs the provider's binary by name, in the remote directory,
		// with the recipe's variables exported there.
		expect(wrapConfig.command).toBe('claude');
		expect(wrapConfig.cwd).toBe('~/project');
		expect(wrapConfig.prompt).toBe(RUN_ON_TEST_PROMPT);
		expect(wrapConfig.customEnvVars.ANTHROPIC_BASE_URL).toBe(WORKSTATION.baseUrl);
		expect(sshConfig).toEqual(SSH);
		const spec = startedSpec();
		expect(spec.command).toBe('ssh');
		expect(spec.stdin).toBe('exec claude ...');
	});

	it('refuses a loopback source the remote cannot reach', async () => {
		configure([{ ...AGENT, sessionSshRemoteConfig: SSH }]);

		const result = await testAgentRunOn({ agentId: 'agent-1' });

		expect(result).toMatchObject({ ok: false, code: 'run-on-loopback-on-remote' });
		expect(wrapSpawnWithSsh).not.toHaveBeenCalled();
		expect(runTurn).not.toHaveBeenCalled();
	});

	it('refuses a remote that is not configured, and never runs locally', async () => {
		configure([
			{ ...AGENT, runOn: BIG, sessionSshRemoteConfig: { ...SSH, remoteId: 'remote-gone' } },
		]);

		const result = await testAgentRunOn({ agentId: 'agent-1' });

		expect(result).toMatchObject({ ok: false, code: 'run-on-test-not-startable' });
		expect(runTurn).not.toHaveBeenCalled();
	});

	it('refuses when the wrapper lost the remote, and never runs locally', async () => {
		configure([{ ...AGENT, runOn: BIG, sessionSshRemoteConfig: SSH }]);
		wrapSpawnWithSsh.mockResolvedValueOnce({
			command: 'claude',
			args: [],
			cwd: '~/project',
			sshRemoteUsed: null,
		});

		const result = await testAgentRunOn({ agentId: 'agent-1' });

		expect(result).toMatchObject({ ok: false, code: 'run-on-test-not-startable' });
		expect(runTurn).not.toHaveBeenCalled();
	});
});
