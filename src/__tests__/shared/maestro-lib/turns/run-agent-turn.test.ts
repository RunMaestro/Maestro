/**
 * `runAgentTurn`: an assembled turn started, streamed, stopped, and refused.
 *
 * The provider is `src/__tests__/fixtures/fake-agent.mjs` replaying a real recorded turn
 * (`src/__tests__/main/process-manager/recordings/`), so a turn here is a real process on a
 * real pipe. The assembled turn is the real `assembleTurn` output with only the command swapped
 * for the fake agent, which is what proves the plan, the environment, and the prompt reach the
 * process the way `assembleTurn` described them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import {
	assembleTurn,
	type AssembledTurn,
	type TurnAgent,
	type TurnContext,
	type TurnTab,
} from '../../../../shared/maestro-lib/turns/assemble';
import {
	runAgentTurn,
	type AgentTurnRun,
	type RunAgentTurnOptions,
} from '../../../../shared/maestro-lib/turns/run-agent-turn';
import type { ParsedEvent } from '../../../../shared/maestro-lib/parsers/agent-output-parser';
import type { SshRemoteConfig } from '../../../../shared/types';
import {
	CAPTURED_RECORDINGS,
	CAPTURED_CLAUDE_CODE_SESSION_ID,
	CAPTURED_OPENCODE_SESSION_ID,
} from '../../../main/process-manager/recordings/captured';
import {
	createScratchDir,
	FAKE_AGENT_PATH,
	fakeTurnFromRecording,
	writeFakeTurn,
} from '../run/fakeAgent';
import { makeAgent, makeContext, makeTab } from './fixtures';

let scratch: { dir: string; cleanup: () => void };

beforeAll(() => {
	scratch = createScratchDir('maestro-run-agent-turn');
});

afterAll(() => {
	scratch.cleanup();
});

type RunAgentTurnDeps = NonNullable<RunAgentTurnOptions['deps']>;

let sequence = 0;

interface FakeOptions {
	recording: string;
	agent?: Partial<TurnAgent>;
	tab?: Partial<TurnTab>;
	context?: Partial<TurnContext>;
	/** Keep the fake agent running after its replay, until it is stopped. */
	hold?: boolean;
	/** Extra environment for the fake agent (it records what it was given). */
	env?: Record<string, string>;
	text?: string;
}

/** A real `assembleTurn` result whose process is the fake agent replaying a recording. */
function assembleWithFakeAgent(toolType: string, options: FakeOptions): AssembledTurn {
	const recording = CAPTURED_RECORDINGS[options.recording];
	const file = writeFakeTurn(scratch.dir, fakeTurnFromRecording(recording));
	const result = assembleTurn(
		makeAgent({
			toolType,
			cwd: scratch.dir,
			customEnvVars: {
				FAKE_AGENT_RECORDING: file,
				...(options.hold ? { FAKE_AGENT_HOLD: '1' } : {}),
				...options.env,
			},
			...options.agent,
		}),
		makeTab(options.tab),
		{ text: options.text ?? 'hello' },
		makeContext(toolType, options.context)
	);
	if (!result.ok) throw new Error(`expected a turn: ${result.message}`);
	const turn = result.turn;
	return {
		...turn,
		launch: {
			...turn.launch,
			command: process.execPath,
			args: [FAKE_AGENT_PATH, ...turn.launch.args],
		},
	};
}

function outFile(name: string): string {
	return path.join(scratch.dir, `${name}-${++sequence}.out`);
}

function optionsFor(overrides: Partial<RunAgentTurnOptions> = {}): RunAgentTurnOptions {
	return { sessionId: 'agent-1-ai-tab-1', stopGraceMs: 200, ...overrides };
}

async function start(turn: AssembledTurn, overrides: Partial<RunAgentTurnOptions> = {}) {
	const started = await runAgentTurn(turn, optionsFor(overrides));
	if (!started.ok) throw new Error(`expected a running turn: ${started.message}`);
	return started.run;
}

async function collect(run: AgentTurnRun): Promise<ParsedEvent[]> {
	const events: ParsedEvent[] = [];
	for await (const event of run.events) events.push(event);
	return events;
}

describe('runAgentTurn: a local turn', () => {
	it('streams the parsed events, then reports the outcome and the session id', async () => {
		const run = await start(
			assembleWithFakeAgent('opencode', { recording: 'captured-opencode-normal' })
		);

		const events = await collect(run);
		const result = await run.result;

		expect(events.map((event) => event.type)).toContain('result');
		expect(result.outcome).toBe('completed');
		expect(result.sessionId).toBe(CAPTURED_OPENCODE_SESSION_ID);
		expect(result.answerText).toBe('The capital of France is Paris.');
		expect(result.error).toBeUndefined();
		expect(result.exit.exitCode).toBe(0);
	});

	it('completes a Claude Code turn from its real recording', async () => {
		const run = await start(
			assembleWithFakeAgent('claude-code', { recording: 'captured-claude-code-normal' })
		);

		const result = await run.result;

		expect(result.outcome).toBe('completed');
		expect(result.sessionId).toBe(CAPTURED_CLAUDE_CODE_SESSION_ID);
		expect(result.usage?.outputTokens).toBeGreaterThan(0);
	});

	it('holds events that arrive before anyone iterates, and ends the stream with the turn', async () => {
		const run = await start(
			assembleWithFakeAgent('opencode', { recording: 'captured-opencode-normal' })
		);
		await run.result;

		const late = await collect(run);

		expect(late.length).toBeGreaterThan(0);
		expect(late.map((event) => event.type)).toContain('result');
	});

	it('hands the process the arguments, the prompt, and the environment `assembleTurn` described', async () => {
		const argvOut = outFile('argv');
		const envOut = outFile('env');
		const turn = assembleWithFakeAgent('opencode', {
			recording: 'captured-opencode-normal',
			text: 'what is the capital of France',
			env: { FAKE_AGENT_ARGV_OUT: argvOut, FAKE_AGENT_ENV_OUT: envOut },
		});

		const run = await start(turn);
		await run.result;

		const argv = JSON.parse(fs.readFileSync(argvOut, 'utf8')) as string[];
		const env = JSON.parse(fs.readFileSync(envOut, 'utf8')) as Record<string, string>;
		// Everything after the script is what `assembleTurn` planned: its arguments, then the prompt.
		expect(argv.slice(0, turn.launch.args.length - 1)).toEqual(turn.launch.args.slice(1));
		expect(argv.join('\n')).toContain('what is the capital of France');
		expect(env.MAESTRO_CALLER_AGENT_ID).toBe('agent-1');
		expect(env.MAESTRO_CALLER_TAB_ID).toBe('tab-1');
	});

	it('resumes with the tab session id and returns the id the provider announced', async () => {
		const argvOut = outFile('argv');
		const run = await start(
			assembleWithFakeAgent('opencode', {
				recording: 'captured-opencode-resumed',
				tab: { agentSessionId: CAPTURED_OPENCODE_SESSION_ID },
				env: { FAKE_AGENT_ARGV_OUT: argvOut },
			})
		);

		const result = await run.result;

		expect(JSON.parse(fs.readFileSync(argvOut, 'utf8'))).toContain(CAPTURED_OPENCODE_SESSION_ID);
		expect(result.sessionId).toBe(CAPTURED_OPENCODE_SESSION_ID);
	});

	it('reports a provider that cannot be started as a crash that names the command', async () => {
		const turn = assembleWithFakeAgent('opencode', { recording: 'captured-opencode-normal' });

		const run = await start({ ...turn, launch: { ...turn.launch, command: '/no/such/provider' } });
		const result = await run.result;

		expect(result.outcome).toBe('crashed');
		expect(result.error?.message).toContain('/no/such/provider');
		expect(await collect(run)).toEqual([]);
	});
});

describe('runAgentTurn: stopping', () => {
	it('stops a running turn through the stop ladder and reports it as interrupted', async () => {
		const run = await start(
			assembleWithFakeAgent('opencode', { recording: 'captured-opencode-normal', hold: true })
		);

		// The fake agent has replayed the whole turn once the result event has arrived.
		for await (const event of run.events) {
			if (event.type === 'result') break;
		}
		expect(run.stopRequested()).toBe(false);
		run.interrupt();
		const result = await run.result;

		expect(run.stopRequested()).toBe(true);
		expect(result.outcome).toBe('interrupted');
		expect(result.exit.interrupted).toBe(true);
		expect(result.sessionId).toBe(CAPTURED_OPENCODE_SESSION_ID);
	});

	it('ends the event stream when the turn is stopped, so a reader never waits forever', async () => {
		const run = await start(
			assembleWithFakeAgent('opencode', { recording: 'captured-opencode-normal', hold: true })
		);
		const reader = collect(run);

		await new Promise((resolve) => setTimeout(resolve, 300));
		run.terminate();

		const events = await reader;
		expect(events.length).toBeGreaterThan(0);
		expect((await run.result).outcome).toBe('interrupted');
	});

	it('stops when its signal aborts', async () => {
		const controller = new AbortController();
		const run = await start(
			assembleWithFakeAgent('opencode', { recording: 'captured-opencode-normal', hold: true }),
			{ signal: controller.signal }
		);

		await new Promise((resolve) => setTimeout(resolve, 300));
		controller.abort();

		expect((await run.result).outcome).toBe('interrupted');
	});
});

describe('runAgentTurn: an SSH remote', () => {
	const remote: SshRemoteConfig = {
		id: 'remote-1',
		name: 'Build box',
		host: 'build.example.com',
		port: 22,
		username: 'dev',
		privateKeyPath: '~/.ssh/id_ed25519',
		enabled: true,
	};
	const sshAgent: Partial<TurnAgent> = {
		sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
	};

	it('fails when the remote does not exist, and never runs the agent here in its place', async () => {
		const argvOut = outFile('argv');
		const turn = assembleWithFakeAgent('opencode', {
			recording: 'captured-opencode-normal',
			agent: { sessionSshRemoteConfig: { enabled: true, remoteId: 'gone' } },
			env: { FAKE_AGENT_ARGV_OUT: argvOut },
		});

		const started = await runAgentTurn(
			turn,
			optionsFor({ sshStore: { getSshRemotes: () => [remote] } })
		);

		expect(started.ok).toBe(false);
		if (started.ok) return;
		expect(started.reason).toBe('ssh-unresolved');
		expect(started.message).toContain('"gone"');
		expect(started.message).toContain('nothing ran on this machine');
		expect(fs.existsSync(argvOut)).toBe(false);
	});

	it('fails when the remote is disabled', async () => {
		const argvOut = outFile('argv');
		const turn = assembleWithFakeAgent('opencode', {
			recording: 'captured-opencode-normal',
			agent: sshAgent,
			env: { FAKE_AGENT_ARGV_OUT: argvOut },
		});

		const started = await runAgentTurn(
			turn,
			optionsFor({ sshStore: { getSshRemotes: () => [{ ...remote, enabled: false }] } })
		);

		expect(started.ok).toBe(false);
		if (!started.ok) expect(started.message).toContain('disabled');
		expect(fs.existsSync(argvOut)).toBe(false);
	});

	it('fails when there is no remote list to look the remote up in', async () => {
		const argvOut = outFile('argv');
		const turn = assembleWithFakeAgent('opencode', {
			recording: 'captured-opencode-normal',
			agent: sshAgent,
			env: { FAKE_AGENT_ARGV_OUT: argvOut },
		});

		const started = await runAgentTurn(turn, optionsFor());

		expect(started.ok).toBe(false);
		expect(fs.existsSync(argvOut)).toBe(false);
	});

	it('fails when the wrapper degrades to a local spawn', async () => {
		const argvOut = outFile('argv');
		const turn = assembleWithFakeAgent('opencode', {
			recording: 'captured-opencode-normal',
			agent: sshAgent,
			env: { FAKE_AGENT_ARGV_OUT: argvOut },
		});

		const started = await runAgentTurn(
			turn,
			optionsFor({
				sshStore: { getSshRemotes: () => [remote] },
				deps: {
					wrapSpawnWithSsh: async (config) => ({
						command: process.execPath,
						args: [FAKE_AGENT_PATH],
						cwd: config.cwd,
						sshRemoteUsed: null,
					}),
				},
			})
		);

		expect(started.ok).toBe(false);
		if (!started.ok) expect(started.reason).toBe('ssh-unresolved');
		expect(fs.existsSync(argvOut)).toBe(false);
	});

	it('runs what the SSH wrapper built, with the remote command, not this machine`s path', async () => {
		const stdinOut = outFile('stdin');
		const turn = assembleWithFakeAgent('opencode', {
			recording: 'captured-opencode-normal',
			agent: { ...sshAgent, customPath: '/opt/remote/bin/opencode' },
		});
		let wrapped: Parameters<NonNullable<RunAgentTurnDeps['wrapSpawnWithSsh']>>[0] | undefined;

		const run = await start(turn, {
			sshStore: { getSshRemotes: () => [remote] },
			deps: {
				env: {
					...process.env,
					FAKE_AGENT_RECORDING: writeFakeTurn(
						scratch.dir,
						fakeTurnFromRecording(CAPTURED_RECORDINGS['captured-opencode-normal'])
					),
					FAKE_AGENT_STDIN_OUT: stdinOut,
				},
				wrapSpawnWithSsh: async (config) => {
					wrapped = config;
					return {
						command: process.execPath,
						args: [FAKE_AGENT_PATH],
						cwd: scratch.dir,
						sshStdinScript: 'cd /work && exec opencode',
						sshRemoteUsed: remote,
					};
				},
			},
		});
		const result = await run.result;

		expect(wrapped?.command).toBe('/opt/remote/bin/opencode');
		expect(wrapped?.prompt).toBe(turn.launch.prompt);
		expect(wrapped?.cwd).toBe(scratch.dir);
		expect(wrapped?.agentBinaryName).toBe('opencode');
		expect(wrapped?.querySource).toBe('user');
		expect(fs.readFileSync(stdinOut, 'utf8')).toBe('cd /work && exec opencode');
		expect(result.outcome).toBe('completed');
	});
});

describe('runAgentTurn: refusals', () => {
	it('refuses images before anything is started', async () => {
		const argvOut = outFile('argv');
		const turn = assembleWithFakeAgent('opencode', {
			recording: 'captured-opencode-normal',
			env: { FAKE_AGENT_ARGV_OUT: argvOut },
		});

		const started = await runAgentTurn(
			{ ...turn, launch: { ...turn.launch, hasImages: true } },
			optionsFor()
		);

		expect(started).toMatchObject({ ok: false, reason: 'images-unsupported' });
		expect(fs.existsSync(argvOut)).toBe(false);
	});

	it('refuses Standard permission mode on a Claude Code API turn, never downgrading it', async () => {
		const argvOut = outFile('argv');
		const turn = assembleWithFakeAgent('claude-code', {
			recording: 'captured-claude-code-normal',
			tab: { permissionMode: 'standard' },
			env: { FAKE_AGENT_ARGV_OUT: argvOut },
		});
		expect(turn.permissionMode).toBe('standard');

		const started = await runAgentTurn(turn, optionsFor());

		expect(started).toMatchObject({ ok: false, reason: 'standard-mode-unsupported' });
		expect(fs.existsSync(argvOut)).toBe(false);
	});

	it('runs Standard mode for a provider with no permission relay to miss', async () => {
		const run = await start(
			assembleWithFakeAgent('opencode', {
				recording: 'captured-opencode-normal',
				tab: { permissionMode: 'standard' },
			})
		);

		expect((await run.result).outcome).toBe('completed');
	});

	it('refuses a provider with no output parser', async () => {
		const turn = assembleWithFakeAgent('opencode', { recording: 'captured-opencode-normal' });

		const started = await runAgentTurn(
			{ ...turn, provider: { ...turn.provider, id: 'no-such-provider' } },
			optionsFor()
		);

		expect(started).toMatchObject({ ok: false, reason: 'no-parser' });
	});
});

describe('runAgentTurn: the Claude token source', () => {
	const tuiSource = { enableMaestroP: true, maestroPMode: 'interactive' as const };

	it('runs the maestro-p TUI for an agent set to it, pointing it at the real claude', async () => {
		const argvOut = outFile('argv');
		const envOut = outFile('env');
		const turn = assembleWithFakeAgent('claude-code', {
			recording: 'captured-claude-code-normal',
			env: { FAKE_AGENT_ARGV_OUT: argvOut, FAKE_AGENT_ENV_OUT: envOut },
		});

		// The fake agent stands in for the maestro-p script: it exists, and it is what runs.
		const run = await start(turn, {
			claudeTokenSource: tuiSource,
			maestroPBinPath: FAKE_AGENT_PATH,
		});
		await run.result;

		const argv = JSON.parse(fs.readFileSync(argvOut, 'utf8')) as string[];
		const env = JSON.parse(fs.readFileSync(envOut, 'utf8')) as Record<string, string>;
		expect(argv).toContain('--dangerously-skip-permissions');
		expect(env.MAESTRO_CLAUDE_BIN).toBe(turn.launch.command);
		expect(env.ELECTRON_RUN_AS_NODE).toBe('1');
	});

	it('falls back to API when the TUI is chosen but no maestro-p is installed', async () => {
		const envOut = outFile('env');
		const run = await start(
			assembleWithFakeAgent('claude-code', {
				recording: 'captured-claude-code-normal',
				env: { FAKE_AGENT_ENV_OUT: envOut },
			}),
			{ claudeTokenSource: tuiSource }
		);
		await run.result;

		expect(JSON.parse(fs.readFileSync(envOut, 'utf8')).MAESTRO_CLAUDE_BIN).toBeUndefined();
	});

	it('allows Standard mode on the TUI, which draws its own permission prompts', async () => {
		const run = await start(
			assembleWithFakeAgent('claude-code', {
				recording: 'captured-claude-code-normal',
				tab: { permissionMode: 'standard' },
			}),
			{ claudeTokenSource: tuiSource, maestroPBinPath: FAKE_AGENT_PATH }
		);

		expect((await run.result).outcome).toBe('completed');
	});
});

describe('runAgentTurn: the system prompt file (Windows host)', () => {
	it('writes it, appends the file argument, and removes it when the turn ends', async () => {
		const argvOut = outFile('argv');
		const turn = assembleWithFakeAgent('claude-code', {
			recording: 'captured-claude-code-normal',
			hold: true,
			context: { isWindowsHost: true },
			env: { FAKE_AGENT_ARGV_OUT: argvOut },
		});
		expect(turn.systemPromptDelivery).toEqual({ via: 'file' });

		const run = await start(turn, { deps: { tempDir: scratch.dir } });
		for await (const event of run.events) {
			if (event.type === 'result') break;
		}

		const argv = JSON.parse(fs.readFileSync(argvOut, 'utf8')) as string[];
		const flag = argv.indexOf('--append-system-prompt-file');
		expect(flag).toBeGreaterThan(-1);
		const file = argv[flag + 1];
		expect(path.dirname(file)).toBe(scratch.dir);
		expect(fs.readFileSync(file, 'utf8')).toBe(turn.systemPrompt);
		expect(argv).not.toContain('--append-system-prompt');

		run.terminate();
		await run.result;
		await waitUntil(() => !fs.existsSync(file));
		expect(fs.existsSync(file)).toBe(false);
	});
});

/** Poll until `done`, for a removal that happens after the turn settles. */
async function waitUntil(done: () => boolean): Promise<void> {
	const deadline = Date.now() + 2000;
	while (!done() && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}
