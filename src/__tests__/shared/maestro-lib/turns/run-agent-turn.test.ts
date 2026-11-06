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
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';

// Stop's remote half is observed here, never sent: a real one runs ssh.
const remoteSignals = vi.hoisted(
	() =>
		[] as Array<{
			pidFile: string;
			mode: string;
			promptArtifactPath?: string;
		}>
);
vi.mock('../../../../shared/maestro-lib/control/ssh-remote-signal', async (importOriginal) => ({
	...(await importOriginal<
		typeof import('../../../../shared/maestro-lib/control/ssh-remote-signal')
	>()),
	signalRemoteAgent: (target: { pidFile: string; promptArtifactPath?: string }, mode: string) => {
		remoteSignals.push({
			pidFile: target.pidFile,
			mode,
			...(target.promptArtifactPath ? { promptArtifactPath: target.promptArtifactPath } : {}),
		});
		return true;
	},
}));

import {
	claudeTranscriptPath,
	clearRememberedClaudeSessionCosts,
} from '../../../../shared/claudeCostTracker';
import { getEffortRejection, resetEffortRejections } from '../../../../shared/effortRejection';
import { SSH_STDIN_REMOTE_SHELL } from '../../../../shared/maestro-lib/control/ssh-remote-signal';
import { newRemotePromptFileDestination } from '../../../../shared/maestro-lib/launch/ssh-command-builder';
import * as launchPlanner from '../../../../shared/maestro-lib/launch/launch-plan';
import * as runToCompletion from '../../../../shared/maestro-lib/run/run-to-completion';
import { DEFAULT_MAX_LINE_LENGTH } from '../../../../shared/maestro-lib/run/start-turn';
import * as pipeSpawn from '../../../../shared/maestro-lib/run/pipe-spawn';
import * as turnArgs from '../../../../shared/maestro-lib/turns/args';
import { logger, setMaestroLibImageRefResolver } from '../../../../shared/maestro-lib/host';
import type { EmbeddedImageSupport } from '../../../../shared/maestro-lib/launch/image-refs';
import { nativeAccountRef, type GrokLaunchScopePorts } from '../../../../shared/agentAccountDir';
import type { NativeSessionBinding } from '../../../../shared/maestro-lib/agents/providerSwap';

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
	FAKE_AGENT_PATH,
	fakeTurnFromRecording,
	writeFakeTurn,
	type FakeTurn,
} from '../run/fakeAgent';
import {
	GROK_SYNTHETIC_ROUNDS,
	GROK_SYNTHETIC_SESSION_ID,
	grokSyntheticStream,
	rechunk,
} from '../../../helpers/grokSyntheticStream';
import { makeAgent, makeContext, makeTab, providerFor } from './fixtures';
import { createMockSession } from '../../../helpers/mockSession';
import {
	readSyntheticGrokAcpLog,
	writeSyntheticGrokAcpPeer,
} from '../../../fixtures/grok-acp-peer';
import { createMockAITab } from '../../../helpers/mockTab';
import { buildWorktreeSession } from '../../../../renderer/utils/worktreeSession';

let scratch: { dir: string; cleanup: () => void };

beforeAll(() => {
	const root = path.resolve(__dirname, '../../../../../tmp');
	fs.mkdirSync(root, { recursive: true });
	const dir = fs.mkdtempSync(path.join(root, 'maestro-run-agent-turn-'));
	scratch = { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
});

afterAll(() => {
	scratch.cleanup();
});

beforeEach(() => {
	remoteSignals.length = 0;
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
	/** Attachments in the user's order, as the composer hands them to `assembleTurn`. */
	images?: string[];
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
		{ text: options.text ?? 'hello', ...(options.images ? { images: options.images } : {}) },
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

/** Directory observations only; no account contents or remote transport are accessed. */
function grokScopeFixture(cwd: string, account: string, remote?: SshRemoteConfig) {
	const canonicalCwd = remote ? '/native/work' : cwd;
	const canonicalAccount = remote ? '/native/account' : account;
	const host = {
		kind: remote ? ('ssh' as const) : ('local' as const),
		identity: 'fixture-installation',
	};
	const ports = {
		local: {
			homedir: vi.fn(() => scratch.dir),
			realpath: vi.fn(async (directory: string) => directory),
			stat: vi.fn(async () => ({ isDirectory: () => true })),
			realpathSync: vi.fn((directory: string) => directory),
			isExpectedError: vi.fn(
				(error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT'
			),
			installationId: vi.fn(() => host.identity),
		},
		remote: {
			// The host-attested installation identity of the remote, none for a local turn.
			qualify: vi.fn<GrokLaunchScopePorts['remote']['qualify']>(async () =>
				remote ? host.identity : undefined
			),
			observe: vi.fn<GrokLaunchScopePorts['remote']['observe']>(async () => ({
				success: true,
				data: {
					cwd: { canonicalPath: canonicalCwd },
					account: { canonicalPath: canonicalAccount },
				},
			})),
			isExpectedError: vi.fn(() => false),
		},
	} satisfies GrokLaunchScopePorts;
	const binding = {
		version: 1,
		state: 'bound',
		provider: 'grok',
		nativeSessionId: 'grok-native-session',
		cwd: canonicalCwd,
		accountRef: nativeAccountRef('grok', canonicalAccount),
		host: { ...host },
	} satisfies NativeSessionBinding;
	return { ports, binding };
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
		expect(wrapped?.agentBinaryName).toBe('/opt/remote/bin/opencode');
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

describe('runAgentTurn: Grok launch refusals', () => {
	const remote: SshRemoteConfig = {
		id: 'remote-1',
		name: 'Build box',
		host: 'build.example.com',
		port: 22,
		username: 'dev',
		privateKeyPath: '~/.ssh/id_ed25519',
		enabled: true,
	};
	let turn: AssembledTurn;

	beforeEach(() => {
		resetEffortRejections();
		vi.spyOn(runToCompletion, 'runTurn').mockImplementation(() => {
			throw new Error('A refused launch must never start a process');
		});
		vi.spyOn(launchPlanner, 'buildAgentLaunchPlan');
		const assembled = assembleTurn(
			makeAgent({ toolType: 'grok', cwd: scratch.dir }),
			makeTab(),
			{ text: 'Keep the selected model and effort.' },
			makeContext('grok')
		);
		if (!assembled.ok) throw new Error(assembled.message);
		turn = assembled.turn;
	});

	afterEach(() => {
		try {
			expect(runToCompletion.runTurn).not.toHaveBeenCalled();
		} finally {
			vi.restoreAllMocks();
			resetEffortRejections();
		}
	});

	describe.each(['local', 'resolved SSH'] as const)('%s', (target) => {
		it.each([
			{
				selection: 'unverified none',
				args: ['-m', 'fixture-model', '--reasoning-effort', 'none'],
				message: 'Grok effort "none" requires verified support for the selected model.',
			},
			{
				selection: 'conflicting models',
				args: ['-m', 'fixture-model', '--model=another-model', '--reasoning-effort', 'high'],
				message:
					'Conflicting Grok model selections. Configure one value across settings and custom arguments.',
			},
			{
				selection: 'conflicting efforts',
				args: ['-m', 'fixture-model', '--reasoning-effort', 'high', '--effort=low'],
				message:
					'Conflicting Grok effort selections. Configure one value across settings and custom arguments.',
			},
		])(
			'preserves $selection as a model/effort refusal without retrying',
			async ({ args, message }) => {
				const getSshRemotes = vi.fn(() => [remote]);
				const wrapSpawnWithSsh = vi.fn<NonNullable<RunAgentTurnDeps['wrapSpawnWithSsh']>>();
				// Exercise the final launch boundary: normal assembly rejects these selections earlier.
				const launch = {
					...turn.launch,
					args: [...args],
					sshRemoteConfig:
						target === 'resolved SSH' ? { enabled: true, remoteId: remote.id } : undefined,
				};
				const started = await runAgentTurn(
					{ ...turn, launch },
					optionsFor({ sshStore: { getSshRemotes }, deps: { wrapSpawnWithSsh, env: {} } })
				);

				expect(started).toEqual({ ok: false, reason: 'grok-model-effort-refused', message });
				expect(launchPlanner.buildAgentLaunchPlan).toHaveBeenCalledOnce();
				expect(launchPlanner.buildAgentLaunchPlan).toHaveBeenCalledWith(
					expect.objectContaining({ args, sshRemoteConfig: launch.sshRemoteConfig })
				);
				expect(launch.args).toEqual(args);
				// A remote prompt destination and the final plan each resolve the selected host.
				expect(getSshRemotes).toHaveBeenCalledTimes(target === 'resolved SSH' ? 2 : 0);
				expect(wrapSpawnWithSsh).not.toHaveBeenCalled();
			}
		);
	});

	describe.each(['local', 'SSH'] as const)('%s grants', (host) => {
		describe.each([null, 'selected-native-session'])('resume %s', (resume) => {
			it.each([
				{ access: 'read', readOnly: false },
				{ access: 'write', readOnly: false },
				{ access: 'mixed', readOnly: false },
				{ access: 'read', readOnly: true },
				{ access: 'write', readOnly: true },
				{ access: 'duplicate read', readOnly: true },
				{ access: 'duplicate write', readOnly: true },
			])(
				'refuses $access with readonly=$readOnly before any artifact or retry',
				async ({ access, readOnly }) => {
					const root = '/PRIVATE grants/雪';
					const privateText = 'PRIVATE turn bytes 雪';
					const account =
						host === 'SSH'
							? '/remote/selected-account'
							: path.join(scratch.dir, 'selected-account');
					const cwd = host === 'SSH' ? '/remote/selected-project' : scratch.dir;
					const additionalDirectories = [
						{ path: root, read: access !== 'write', write: access !== 'read' },
						...(access === 'mixed'
							? [{ path: root + '/independent-read', read: true, write: false }]
							: []),
						...(access.startsWith('duplicate')
							? [
									{
										path: root,
										read: access === 'duplicate read',
										write: access === 'duplicate write',
									},
								]
							: []),
					];
					const captured = additionalDirectories.map((row) => ({ ...row }));
					const sshRemoteConfig =
						host === 'SSH' ? { enabled: true, remoteId: remote.id } : undefined;
					const assembled = assembleTurn(
						makeAgent({
							toolType: 'grok',
							cwd,
							additionalDirectories,
							customPath: '/selected/bin/grok',
							customEnvVars: { GROK_HOME: account },
							sessionSshRemoteConfig: sshRemoteConfig,
						}),
						makeTab({ agentSessionId: resume, readOnlyMode: readOnly }),
						{ text: privateText },
						makeContext('grok', { command: '/selected/bin/grok' })
					);
					if (!assembled.ok) throw new Error(assembled.message);
					const turn = assembled.turn;
					// An edit after assembly cannot drop the already selected grant refusal.
					additionalDirectories.forEach((row) => {
						row.read = false;
						row.write = false;
					});
					additionalDirectories.length = 0;
					// Synthetic file placement exercises ordering, not a Grok system-file capability.
					turn.systemPrompt = privateText;
					turn.systemPromptDelivery = { via: 'file' };
					const write = vi.spyOn(turnArgs, 'writeSystemPromptFile');
					const cleanup = vi.spyOn(pipeSpawn, 'removeTempFiles');
					const getSshRemotes = vi.fn(() => [remote]);
					const wrap = vi.fn<NonNullable<RunAgentTurnDeps['wrapSpawnWithSsh']>>();
					const logs = (['debug', 'info', 'warn', 'error'] as const).map((level) =>
						vi.spyOn(logger, level).mockImplementation(() => {})
					);
					const started = await runAgentTurn(
						turn,
						optionsFor({
							sshStore: { getSshRemotes },
							deps: { wrapSpawnWithSsh: wrap, env: {}, tempDir: scratch.dir },
						})
					);
					const message =
						readOnly && (access === 'write' || access === 'duplicate write')
							? "Grok CLI writable directory grants exceed this launch's read-only mode."
							: 'Grok CLI additional-directory read and write grants have no qualified native mechanism. Remove the grants to run with the selected working directory.';
					expect(started).toEqual({ ok: false, reason: 'grok-directory-grants-refused', message });
					expect(launchPlanner.buildAgentLaunchPlan).toHaveBeenCalledOnce();
					expect(launchPlanner.buildAgentLaunchPlan).toHaveBeenCalledWith(
						expect.objectContaining({
							agent: turn.provider,
							additionalDirectories: captured,
							cwd,
							command: '/selected/bin/grok',
							remoteCommand: '/selected/bin/grok',
							sessionCustomEnvVars: { GROK_HOME: account },
							sshRemoteConfig,
							isResuming: !!resume,
							readOnlyMode: readOnly,
						})
					);
					if (resume) expect(turn.launch.args).toContain(resume);
					expect(getSshRemotes).toHaveBeenCalledTimes(host === 'SSH' ? 2 : 0);
					expect(write).not.toHaveBeenCalled();
					expect(cleanup).not.toHaveBeenCalled();
					expect(wrap).not.toHaveBeenCalled();
					expect(runToCompletion.runTurn).not.toHaveBeenCalled();
					expect(remoteSignals).toEqual([]);
					const disclosure = JSON.stringify({ started, logs: logs.map((log) => log.mock.calls) });
					for (const secret of [root, privateText, turn.launch.prompt!, account]) {
						expect(disclosure).not.toContain(secret);
						expect(disclosure).not.toContain(JSON.stringify(secret).slice(1, -1));
					}
				}
			);
		});
	});

	it.each(['missing', 'disabled'] as const)(
		'keeps a genuinely %s SSH remote classified as SSH, before effort validation',
		async (state) => {
			const wrapSpawnWithSsh = vi.fn<NonNullable<RunAgentTurnDeps['wrapSpawnWithSsh']>>();
			const started = await runAgentTurn(
				{
					...turn,
					launch: {
						...turn.launch,
						args: ['--reasoning-effort', 'none'],
						additionalDirectories: [{ path: '/private/grant', read: true, write: true }],
						sshRemoteConfig: { enabled: true, remoteId: remote.id },
					},
				},
				optionsFor({
					sshStore: {
						getSshRemotes: () => (state === 'missing' ? [] : [{ ...remote, enabled: false }]),
					},
					deps: { wrapSpawnWithSsh, env: {} },
				})
			);

			expect(started).toMatchObject({ ok: false, reason: 'ssh-unresolved' });
			if (started.ok) throw new Error('Expected an SSH refusal');
			expect(started.message).toContain(state === 'disabled' ? 'disabled' : remote.id);
			expect(started.message).toContain('nothing ran on this machine');
			expect(launchPlanner.buildAgentLaunchPlan).toHaveBeenCalledOnce();
			expect(wrapSpawnWithSsh).not.toHaveBeenCalled();
		}
	);

	it('leaves an unowned file untouched when Grok preflight refuses before materialization', async () => {
		const file = outFile('owned-system-prompt');
		fs.writeFileSync(file, 'Synthetic system prompt');
		// Ownership would transfer only if the materializer ran; preflight must skip it.
		const write = vi.spyOn(turnArgs, 'writeSystemPromptFile').mockImplementation(async (input) => ({
			args: [...input.args, '--append-system-prompt-file', file],
			prompt: input.prompt,
			tempFile: file,
			delivery: 'file',
		}));
		const cleanup = vi.spyOn(pipeSpawn, 'removeTempFiles');
		const started = await runAgentTurn(
			{
				...turn,
				systemPrompt: 'Synthetic system prompt',
				systemPromptDelivery: { via: 'file' },
				launch: { ...turn.launch, args: ['--reasoning-effort', 'none'] },
			},
			optionsFor({ deps: { tempDir: scratch.dir } })
		);

		expect(started).toEqual({
			ok: false,
			reason: 'grok-model-effort-refused',
			message: 'Grok effort "none" requires verified support for the selected model.',
		});
		expect(write).not.toHaveBeenCalled();
		expect(cleanup).not.toHaveBeenCalled();
		expect(launchPlanner.buildAgentLaunchPlan).toHaveBeenCalledOnce();
		expect(fs.readFileSync(file, 'utf8')).toBe('Synthetic system prompt');
	});
});

describe('runAgentTurn: private prompt-file handoff', () => {
	const remote: SshRemoteConfig = {
		id: 'remote-file',
		name: 'File host',
		host: 'files.example.test',
		port: 2222,
		username: 'dev',
		privateKeyPath: '~/.ssh/id_ed25519',
		enabled: true,
	};
	const fileAgent = {
		...makeContext('grok').provider,
		promptFile: { format: 'acp-json' as const, exclusivePromptFlags: ['-p', '--prompt-json-file'] },
		promptFileArgs: (file: string) => ['--prompt-json-file', file],
	};
	beforeEach(() => {
		vi.spyOn(runToCompletion, 'runTurn');
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe.each(['local', 'SSH'] as const)('%s owner', (host) => {
		it.each([
			{
				name: 'short fresh',
				text: '--resume another-id --cwd /elsewhere agent stdio Unicode 雪',
				resume: null,
				grants: 'empty',
			},
			{
				name: 'long resumed',
				text: 'large 雪\n'.repeat(12_000),
				resume: 'grok-native-session',
				grants: 'off',
			},
			{
				name: 'empty resumed',
				text: '',
				resume: 'grok-native-session',
				grants: 'duplicate disabled',
			},
		])(
			'delivers $name content once and retains the correct cleanup owner',
			async ({ text, resume, grants }) => {
				const argvOut = outFile('file-argv');
				const stdinOut = outFile('file-stdin');
				const env = {
					FAKE_AGENT_RECORDING: writeFakeTurn(scratch.dir, {
						chunks: [],
						close: { code: 0, signal: null },
					}),
					FAKE_AGENT_HOLD: '1',
					FAKE_AGENT_ARGV_OUT: argvOut,
					FAKE_AGENT_STDIN_OUT: stdinOut,
					GROK_HOME: path.join(scratch.dir, 'selected-account'),
				};
				const turn = assembleWithFakeAgent('grok', {
					recording: 'captured-opencode-normal',
					text: text || 'assembled placeholder',
					env,
					tab: { agentSessionId: resume },
					agent: {
						customPath: '/opt/remote grok/bin/grok',
						additionalDirectories:
							grants === 'empty'
								? []
								: [
										...(grants === 'duplicate disabled'
											? [{ path: '/private/root 雪', read: true, write: true }]
											: []),
										{ path: '/private/root 雪', read: false, write: false },
										{ path: '  ', read: true, write: true },
									],
					},
				});
				// Exercise an explicitly empty final launch without changing assembleTurn's empty-message gate.
				if (!text) turn.launch.prompt = '';
				if (host === 'SSH') turn.launch.sshRemoteConfig = { enabled: true, remoteId: remote.id };
				const destination =
					host === 'SSH'
						? newRemotePromptFileDestination(remote.id, 'acp-json')
						: { owner: 'local' as const, path: outFile('private-prompt') + '.json' };
				turn.launch.promptFileDestination = destination;
				const sshArgs = ['-p', '2222', 'dev@files.example.test', ...SSH_STDIN_REMOTE_SHELL];
				const wrap = vi.fn<NonNullable<RunAgentTurnDeps['wrapSpawnWithSsh']>>(async () => ({
					command: process.execPath,
					args: [FAKE_AGENT_PATH, ...sshArgs],
					cwd: scratch.dir,
					sshStdinScript: 'synthetic remote transfer',
					sshRemoteUsed: remote,
				}));
				const plan = vi.spyOn(launchPlanner, 'buildAgentLaunchPlan');
				const getSshRemotes = vi.fn(() => [remote]);
				const scope = grokScopeFixture(
					scratch.dir,
					env.GROK_HOME,
					host === 'SSH' ? remote : undefined
				);
				const run = await start(turn, {
					grokLaunchScope: scope.ports,
					retainedNativeSessionBinding: resume ? scope.binding : undefined,
					sshStore: { getSshRemotes },
					deps: { wrapSpawnWithSsh: wrap, env: { ...process.env, ...env } },
				});
				try {
					await waitUntil(() => fs.existsSync(stdinOut));
					const argv = JSON.parse(fs.readFileSync(argvOut, 'utf8')) as string[];
					const spec = vi.mocked(runToCompletion.runTurn).mock.calls[0][0];
					const content = JSON.stringify({
						type: 'acp',
						content: [{ type: 'text', text: turn.launch.prompt }],
					});
					expect(runToCompletion.runTurn).toHaveBeenCalledOnce();
					expect(plan).toHaveBeenCalledOnce();
					expect(getSshRemotes).toHaveBeenCalledTimes(host === 'SSH' ? 3 : 0);
					expect(plan.mock.calls[0][0].additionalDirectories).toEqual(
						turn.launch.additionalDirectories
					);
					expect(turn.launch.args.join(' ')).not.toContain('/private/root');
					if (host === 'local') {
						expect(wrap).not.toHaveBeenCalled();
						expect(spec).toMatchObject({
							command: process.execPath,
							cwd: scratch.dir,
							env: { GROK_HOME: env.GROK_HOME },
						});
						expect(argv).toEqual([...turn.launch.args.slice(1), '--prompt-file', destination.path]);
						expect(fs.readFileSync(stdinOut, 'utf8')).toBe('');
						expect(fs.readFileSync(destination.path, 'utf8')).toBe(content);
					} else {
						expect(wrap).toHaveBeenCalledOnce();
						expect(wrap.mock.calls[0][0]).toMatchObject({
							command: '/opt/remote grok/bin/grok',
							cwd: scratch.dir,
							prompt: undefined,
							customEnvVars: { GROK_HOME: env.GROK_HOME },
							promptArtifact: { ...destination, content },
							args: [...turn.launch.args, '--prompt-file', destination.path],
						});
						expect(wrap.mock.calls[0][1]).toEqual(turn.launch.sshRemoteConfig);
						expect(spec.promptArtifact).toBeUndefined();
						expect(argv).toEqual(sshArgs);
						expect(fs.readFileSync(stdinOut, 'utf8')).toContain('synthetic remote transfer');
					}
					if (resume) expect(turn.launch.args).toContain(resume);
					const receipt = run.nativeLaunchReceipt!;
					const { nativeSessionId: _id, ...expectedScope } = structuredClone(scope.binding);
					expect(receipt).toEqual({
						scope: expectedScope,
						requestedNativeSessionId: resume ?? undefined,
					});
					expect(receipt.scope).not.toHaveProperty('nativeSessionId');
					expect(Object.getOwnPropertyDescriptor(run, 'nativeLaunchReceipt')).toMatchObject({
						writable: false,
						configurable: false,
					});
					for (const value of [
						receipt,
						receipt.scope,
						receipt.scope.state === 'bound' && receipt.scope.host,
					])
						expect(Object.isFrozen(value)).toBe(true);
					scope.binding.host.identity = 'changed after spawn';
					expect(receipt.scope).toEqual(expectedScope);
					if (host === 'SSH') {
						expect(scope.ports.local.realpath).not.toHaveBeenCalled();
						expect(scope.ports.remote.observe).toHaveBeenCalledWith(scratch.dir, remote, {
							env: expect.objectContaining({ GROK_HOME: env.GROK_HOME }),
							nativeCwd: scratch.dir,
						});
					} else {
						expect(scope.ports.local.realpath.mock.calls).toEqual([[scratch.dir], [env.GROK_HOME]]);
						expect(scope.ports.remote.observe).not.toHaveBeenCalled();
					}
				} finally {
					run.terminate();
					await run.result;
					expect(await collect(run)).toEqual([]);
				}
				if (host === 'local') {
					expect(fs.existsSync(destination.path)).toBe(false);
					expect(remoteSignals).toEqual([]);
				} else {
					expect(remoteSignals[0]).toMatchObject({
						mode: 'terminate',
						promptArtifactPath: destination.path,
						pidFile: expect.stringMatching(/^\/tmp\/maestro-prompt-owner-[0-9a-f-]+\.pid$/),
					});
				}
			}
		);
	});

	describe.each(['local', 'resolved SSH'] as const)('%s refusal', (host) => {
		it.each([
			'conflicting source',
			'wrong owner',
			'realized conflict',
			...(host === 'resolved SSH' ? ['remote preparation'] : []),
		])('preserves %s diagnostics and cleans only owned preparation', async (failure) => {
			const privateText = 'PRIVATE prompt "雪"\nnever disclose';
			const owned = outFile('private-owned-system');
			const untouched = outFile('unowned-preparation');
			fs.writeFileSync(untouched, 'keep unowned bytes');
			const destination =
				host === 'resolved SSH'
					? newRemotePromptFileDestination(remote.id, 'acp-json')
					: { owner: 'local' as const, path: outFile('private-prompt') + '.json' };
			const assembled = assembleTurn(
				makeAgent({ toolType: 'grok', cwd: scratch.dir }),
				makeTab(),
				{ text: privateText },
				makeContext('grok')
			);
			if (!assembled.ok) throw new Error(assembled.message);
			const turn = assembled.turn;
			turn.systemPrompt = privateText;
			turn.systemPromptDelivery = { via: 'file' };
			turn.launch.agent = fileAgent;
			turn.launch.promptFileDestination = destination;
			if (host === 'resolved SSH')
				turn.launch.sshRemoteConfig = { enabled: true, remoteId: remote.id };
			if (failure === 'conflicting source') turn.launch.args.push('-p', privateText);
			if (failure === 'wrong owner')
				turn.launch.promptFileDestination = {
					...destination,
					owner: host === 'local' ? 'remote' : 'local',
				};
			const write = vi
				.spyOn(turnArgs, 'writeSystemPromptFile')
				.mockImplementation(async (input) => {
					fs.writeFileSync(owned, input.systemPrompt);
					return {
						args: [
							...input.args,
							...(failure === 'realized conflict'
								? ['-p', privateText]
								: ['--append-system-prompt-file', owned]),
						],
						prompt: input.prompt,
						tempFile: owned,
						delivery: 'file',
					};
				});
			const cleanup = vi.spyOn(pipeSpawn, 'removeTempFiles');
			const plan = vi.spyOn(launchPlanner, 'buildAgentLaunchPlan');
			vi.mocked(runToCompletion.runTurn).mockImplementation(() => {
				throw new Error('A refused launch must never start a process');
			});
			const logs = (['debug', 'info', 'warn', 'error'] as const).map((level) =>
				vi.spyOn(logger, level).mockImplementation(() => {})
			);
			const getSshRemotes = vi.fn(() => [remote]);
			const wrap = vi
				.fn<NonNullable<RunAgentTurnDeps['wrapSpawnWithSsh']>>()
				.mockRejectedValue(new Error(`${privateText} ${owned} ${destination.path}`));
			const started = await runAgentTurn(
				turn,
				optionsFor({
					sshStore: { getSshRemotes },
					deps: { wrapSpawnWithSsh: wrap, env: {} },
				})
			);
			const message =
				failure === 'remote preparation'
					? 'Remote prompt preparation unavailable.'
					: failure === 'wrong owner'
						? 'Prompt-file delivery requires a fresh owned .json destination on the executing host and a provider file-argument builder.'
						: 'Prompt-file delivery conflicts with another prompt source in the launch arguments.';
			expect(started).toEqual({
				ok: false,
				reason: 'prompt-delivery-refused',
				message,
			});
			const materialized = failure === 'remote preparation' || failure === 'realized conflict';
			expect(plan).toHaveBeenCalledTimes(materialized ? 2 : 1);
			expect(getSshRemotes).toHaveBeenCalledTimes(
				host === 'resolved SSH' ? (materialized ? 2 : 1) : 0
			);
			if (materialized) {
				expect(plan.mock.results[0].value.ok).toBe(true);
				expect(plan.mock.calls[1][0].args).toEqual([
					...turn.launch.args,
					...(failure === 'realized conflict'
						? ['-p', privateText]
						: ['--append-system-prompt-file', owned]),
				]);
			}
			if (failure !== 'remote preparation') {
				expect(plan.mock.results.at(-1)!.value).toEqual({
					ok: false,
					reason: 'prompt-delivery-refused',
					error: message,
				});
			} else {
				expect(plan.mock.results[0].value).toMatchObject({
					ok: true,
					plan: { target: { kind: 'remote' } },
				});
				expect(wrap.mock.calls[0][0]).toMatchObject({
					prompt: undefined,
					promptArtifact: destination,
				});
			}
			expect(wrap).toHaveBeenCalledTimes(failure === 'remote preparation' ? 1 : 0);
			expect(runToCompletion.runTurn).not.toHaveBeenCalled();
			if (materialized) {
				expect(write).toHaveBeenCalledOnce();
				expect(cleanup).toHaveBeenCalledExactlyOnceWith([owned]);
				await waitUntil(() => !fs.existsSync(owned));
			} else {
				expect(write).not.toHaveBeenCalled();
				expect(cleanup).not.toHaveBeenCalled();
			}
			expect(fs.existsSync(owned)).toBe(false);
			expect(fs.readFileSync(untouched, 'utf8')).toBe('keep unowned bytes');
			if (host === 'local') expect(fs.existsSync(destination.path)).toBe(false);
			expect(remoteSignals).toEqual([]);
			const disclosure = JSON.stringify({ started, logs: logs.map((log) => log.mock.calls) });
			for (const secret of [
				privateText,
				'never disclose',
				turn.launch.prompt!,
				owned,
				destination.path,
			]) {
				expect(disclosure).not.toContain(secret);
				expect(disclosure).not.toContain(JSON.stringify(secret).slice(1, -1));
			}
		});
	});
});

describe('runAgentTurn: Grok ordered image payloads', () => {
	const remote: SshRemoteConfig = {
		id: 'remote-images',
		name: 'Image host',
		host: 'images.example.test',
		port: 2222,
		username: 'dev',
		privateKeyPath: '~/.ssh/id_ed25519',
		enabled: true,
	};
	// phase02's embedded-image wire shapes: canonical padded base64 bytes, never a path.
	const PNG = 'iVBORw0KGgo=';
	const JPEG = '/9j/4AAQ';
	const REF_BYTES = Buffer.from([1, 2, 3]);
	const png = `data:image/png;base64,${PNG}`;
	const jpeg = `data:image/jpeg;base64,${JPEG}`;
	const ref = 'maestro-image://sha256/fixture-webp';
	const support: EmbeddedImageSupport = {
		mimeTypes: ['image/png', 'image/jpeg', 'image/webp'],
		maxCount: 3,
		maxBytesPerImage: 64,
		maxTotalBytes: 128,
	};
	const acp = (text: string, ...images: Array<[mimeType: string, data: string]>) =>
		JSON.stringify({
			type: 'acp',
			content: [
				{ type: 'text', text },
				...images.map(([mimeType, data]) => ({ type: 'image', data, mimeType })),
			],
		});
	beforeEach(() => {
		vi.spyOn(runToCompletion, 'runTurn');
		setMaestroLibImageRefResolver((value) =>
			value === ref ? { buffer: Buffer.from(REF_BYTES), mediaType: 'image/webp' } : null
		);
	});
	afterEach(() => {
		setMaestroLibImageRefResolver(() => null);
		vi.restoreAllMocks();
	});

	/** A Grok turn with attachments on the fake agent; its prompt file goes to a known owned path. */
	function imageTurn(options: {
		host: 'local' | 'SSH';
		images: string[];
		resume?: string | null;
		tab?: Partial<TurnTab>;
	}) {
		const argvOut = outFile('image-argv');
		const stdinOut = outFile('image-stdin');
		const env = {
			FAKE_AGENT_RECORDING: writeFakeTurn(scratch.dir, {
				chunks: [],
				close: { code: 0, signal: null },
			}),
			FAKE_AGENT_HOLD: '1',
			FAKE_AGENT_ARGV_OUT: argvOut,
			FAKE_AGENT_STDIN_OUT: stdinOut,
			GROK_HOME: path.join(scratch.dir, 'image-account'),
		};
		const turn = assembleWithFakeAgent('grok', {
			recording: 'captured-opencode-normal',
			text: 'describe these',
			images: options.images,
			env,
			tab: { agentSessionId: options.resume ?? null, ...options.tab },
			agent: { customPath: '/opt/remote grok/bin/grok' },
		});
		if (options.host === 'SSH')
			turn.launch.sshRemoteConfig = { enabled: true, remoteId: remote.id };
		const destination =
			options.host === 'SSH'
				? newRemotePromptFileDestination(remote.id, 'acp-json')
				: { owner: 'local' as const, path: outFile('image-prompt') + '.json' };
		turn.launch.promptFileDestination = destination;
		const sshArgs = ['-p', '2222', 'dev@images.example.test', ...SSH_STDIN_REMOTE_SHELL];
		const wrap = vi.fn<NonNullable<RunAgentTurnDeps['wrapSpawnWithSsh']>>(async () => ({
			command: process.execPath,
			args: [FAKE_AGENT_PATH, ...sshArgs],
			cwd: scratch.dir,
			sshStdinScript: 'synthetic remote transfer',
			sshRemoteUsed: remote,
		}));
		const scope = grokScopeFixture(
			scratch.dir,
			env.GROK_HOME,
			options.host === 'SSH' ? remote : undefined
		);
		const runOptions = (overrides: Partial<RunAgentTurnOptions> = {}) =>
			optionsFor({
				grokLaunchScope: scope.ports,
				retainedNativeSessionBinding: options.resume ? scope.binding : undefined,
				sshStore: { getSshRemotes: () => [remote] },
				deps: { wrapSpawnWithSsh: wrap, env: { ...process.env, ...env } },
				...overrides,
			});
		return { turn, env, argvOut, stdinOut, destination, sshArgs, wrap, scope, runOptions };
	}

	/** Nothing was dispatched: no process, no transfer, no prompt file, no argv. */
	function expectNothingStarted(t: ReturnType<typeof imageTurn>) {
		expect(runToCompletion.runTurn).not.toHaveBeenCalled();
		expect(t.wrap).not.toHaveBeenCalled();
		expect(fs.existsSync(t.argvOut)).toBe(false);
		if (t.destination.owner === 'local') expect(fs.existsSync(t.destination.path)).toBe(false);
		expect(remoteSignals).toEqual([]);
	}

	describe.each(['local', 'SSH'] as const)('%s owner', (host) => {
		it.each([
			{ name: 'fresh', resume: null },
			{ name: 'resumed', resume: 'grok-native-session' },
		])(
			'carries the text, then every image in attachment order, once on a $name native route',
			async ({ resume }) => {
				const t = imageTurn({ host, images: [png, ref, jpeg], resume });
				const plan = vi.spyOn(launchPlanner, 'buildAgentLaunchPlan');
				const run = await start(t.turn, t.runOptions({ embeddedImageSupport: support }));
				const content = acp(
					t.turn.launch.prompt!,
					['image/png', PNG],
					['image/webp', REF_BYTES.toString('base64')],
					['image/jpeg', JPEG]
				);
				try {
					await waitUntil(() => fs.existsSync(t.stdinOut));
					expect(runToCompletion.runTurn).toHaveBeenCalledOnce();
					expect(plan).toHaveBeenCalledOnce();
					expect(plan.mock.calls[0][0]).toMatchObject({
						prompt: undefined,
						hasImages: true,
						embeddedImageSupport: support,
					});
					// The planner holds a copy of the caller's bounds, never the caller's object.
					expect(plan.mock.calls[0][0].embeddedImageSupport).not.toBe(support);
					const spec = vi.mocked(runToCompletion.runTurn).mock.calls[0][0];
					const argv = JSON.parse(fs.readFileSync(t.argvOut, 'utf8')) as string[];
					if (host === 'local') {
						expect(t.wrap).not.toHaveBeenCalled();
						expect(spec).toMatchObject({ cwd: scratch.dir, env: { GROK_HOME: t.env.GROK_HOME } });
						expect(argv).toEqual([
							...t.turn.launch.args.slice(1),
							'--prompt-file',
							t.destination.path,
						]);
						expect(fs.readFileSync(t.destination.path, 'utf8')).toBe(content);
						expect(fs.readFileSync(t.stdinOut, 'utf8')).toBe('');
					} else {
						expect(t.wrap).toHaveBeenCalledOnce();
						expect(t.wrap.mock.calls[0][0]).toMatchObject({
							cwd: scratch.dir,
							prompt: undefined,
							customEnvVars: { GROK_HOME: t.env.GROK_HOME },
							promptArtifact: { ...t.destination, content },
							args: [...t.turn.launch.args, '--prompt-file', t.destination.path],
						});
						expect(spec.promptArtifact).toBeUndefined();
						expect(argv).toEqual(t.sshArgs);
					}
					// One prompt source and no tool-read workaround: no `-p`, no image path or ref.
					if (host === 'local') expect(argv).not.toContain('-p');
					else expect(t.wrap.mock.calls[0][0].args).not.toContain('-p');
					expect(content.split(JSON.stringify(t.turn.launch.prompt)).length).toBe(2);
					expect(content).not.toContain('maestro-image://');
					if (resume) expect(t.turn.launch.args).toContain(resume);
					expect(run.nativeLaunchReceipt?.requestedNativeSessionId).toBe(resume ?? undefined);
				} finally {
					run.terminate();
					await run.result;
				}
				if (host === 'local') {
					expect(fs.existsSync(t.destination.path)).toBe(false);
					expect(remoteSignals).toEqual([]);
				} else {
					expect(remoteSignals[0]).toMatchObject({
						mode: 'terminate',
						promptArtifactPath: t.destination.path,
					});
				}
			}
		);

		it.each([
			{
				name: 'no host-admitted support',
				images: [png],
				bounds: undefined,
				message: 'Embedded images require explicit support and bounded image limits.',
			},
			{
				name: 'an unadmitted MIME type',
				images: [png, 'data:image/gif;base64,R0lGODlh'],
				bounds: support,
				message: 'The embedded image MIME type is not supported for this turn.',
			},
			{
				name: 'one image too many',
				images: [png, jpeg],
				bounds: { ...support, maxCount: 1 },
				message: 'The prompt exceeds the admitted image count.',
			},
			{
				name: 'an image over the per-image bound',
				images: [jpeg, png],
				bounds: { ...support, maxBytesPerImage: 7 },
				message: 'The prompt exceeds the admitted image byte limits.',
			},
			{
				name: 'images over the total bound',
				images: [png, jpeg],
				bounds: { ...support, maxTotalBytes: 13 },
				message: 'The prompt exceeds the admitted image byte limits.',
			},
			{
				name: 'malformed bytes',
				images: ['data:image/png;base64,AAA'],
				bounds: support,
				message: 'An embedded image must contain valid base64 bytes.',
			},
		])('refuses $name before dispatch, every attachment still in the plan', async (test) => {
			const t = imageTurn({ host, images: test.images });
			const plan = vi.spyOn(launchPlanner, 'buildAgentLaunchPlan');

			const started = await runAgentTurn(
				t.turn,
				t.runOptions(test.bounds ? { embeddedImageSupport: test.bounds } : {})
			);

			expect(started).toEqual({
				ok: false,
				reason: 'prompt-delivery-refused',
				message: test.message,
			});
			// Validation saw the text and each attachment: none was dropped to make the turn fit.
			expect(plan.mock.calls[0][0].promptBlocks).toHaveLength(test.images.length + 1);
			expectNothingStarted(t);
		});

		it.each([
			{ name: 'a ref the host cannot resolve', image: 'maestro-image://sha256/missing' },
			{ name: 'a data URL that is not an image', image: 'data:text/plain;base64,AAAA' },
		])('refuses $name before planning, with no text-only retry', async ({ image }) => {
			const t = imageTurn({ host, images: [png, image] });
			const plan = vi.spyOn(launchPlanner, 'buildAgentLaunchPlan');

			const started = await runAgentTurn(t.turn, t.runOptions({ embeddedImageSupport: support }));

			expect(started).toEqual({
				ok: false,
				reason: 'images-unsupported',
				message:
					'An attached image could not be read, so the turn was not started. Remove it and send again.',
			});
			expect(plan).not.toHaveBeenCalled();
			expectNothingStarted(t);
		});

		it('refuses images on a provider surface with no prompt-file route (capability)', async () => {
			const t = imageTurn({ host, images: [png] });
			t.turn.launch.agent = { ...t.turn.launch.agent!, promptFile: undefined };
			const plan = vi.spyOn(launchPlanner, 'buildAgentLaunchPlan');

			const started = await runAgentTurn(t.turn, t.runOptions({ embeddedImageSupport: support }));

			expect(started).toMatchObject({ ok: false, reason: 'images-unsupported' });
			expect(plan).not.toHaveBeenCalled();
			expectNothingStarted(t);
		});

		it('refuses images on the standard ACP route, never retrying them as text', async () => {
			const t = imageTurn({ host, images: [png, jpeg], tab: { permissionMode: 'standard' } });
			expect(t.turn.permissionMode).toBe('standard');

			const started = await runAgentTurn(t.turn, t.runOptions({ embeddedImageSupport: support }));

			expect(started).toMatchObject({ ok: false, reason: 'grok-route-refused' });
			if (started.ok) throw new Error('expected a refusal');
			// Refused on the route it asked for (no consent port), never re-planned headless.
			expect(started.message).toMatch(/acp-stdio route: .*consent-port.*Nothing was started\./);
			expectNothingStarted(t);
		});
	});

	it('refuses a failed remote upload of the image prompt file and starts nothing', async () => {
		const t = imageTurn({ host: 'SSH', images: [png, jpeg] });
		t.wrap.mockRejectedValue(new Error('upload failed'));

		const started = await runAgentTurn(t.turn, t.runOptions({ embeddedImageSupport: support }));

		expect(started).toEqual({
			ok: false,
			reason: 'prompt-delivery-refused',
			message: 'Remote prompt preparation unavailable.',
		});
		expect(t.wrap).toHaveBeenCalledOnce();
		expect(t.wrap.mock.calls[0][0].promptArtifact).toMatchObject({
			...t.destination,
			content: acp(t.turn.launch.prompt!, ['image/png', PNG], ['image/jpeg', JPEG]),
		});
		expect(runToCompletion.runTurn).not.toHaveBeenCalled();
		expect(remoteSignals).toEqual([]);
	});

	it('removes the local image prompt file when the spawn fails', async () => {
		const t = imageTurn({ host: 'local', images: [png] });
		t.turn.launch.command = path.join(scratch.dir, 'no-such-grok');
		t.turn.launch.args = t.turn.launch.args.slice(1);

		const started = await runAgentTurn(t.turn, t.runOptions({ embeddedImageSupport: support }));

		if (!started.ok) throw new Error(started.message);
		expect((await started.run.result).outcome).not.toBe('completed');
		expect(runToCompletion.runTurn).toHaveBeenCalledOnce();
		await waitUntil(() => !fs.existsSync(t.destination.path));
		expect(fs.existsSync(t.argvOut)).toBe(false);
	});

	it('removes the local image prompt file when the turn is cancelled', async () => {
		const t = imageTurn({ host: 'local', images: [png, jpeg] });
		const controller = new AbortController();
		const run = await start(
			t.turn,
			t.runOptions({ embeddedImageSupport: support, signal: controller.signal })
		);
		await waitUntil(() => fs.existsSync(t.stdinOut));
		expect(fs.readFileSync(t.destination.path, 'utf8')).toBe(
			acp(t.turn.launch.prompt!, ['image/png', PNG], ['image/jpeg', JPEG])
		);

		controller.abort();
		await run.result;

		expect(fs.existsSync(t.destination.path)).toBe(false);
		expect(runToCompletion.runTurn).toHaveBeenCalledOnce();
	});
});

describe.each(['local', 'SSH'] as const)('runAgentTurn: Grok worktree child on %s', (host) => {
	beforeEach(() => {
		// The local planner reads process.env; deps.env controls only the SSH client.
		// Capture fixture environment without copying the runner's credentials.
		vi.stubGlobal('process', {
			...process,
			env: {
				PATH: process.env.PATH,
				SystemRoot: process.env.SystemRoot,
				HOME: process.env.HOME,
				CODEX_HOME: process.env.CODEX_HOME,
			},
		});
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it.each([
		{ account: 'a', permission: 'readonly', refusal: null },
		{ account: 'b', permission: 'full', refusal: null },
		{ account: 'a', permission: 'readonly', refusal: 'route' },
	] as const)(
		'launches or refuses account $account, $permission, refusal=$refusal',
		async ({ account, permission, refusal }) => {
			const remote: SshRemoteConfig = {
				id: 'worktree-host',
				name: 'Worktree host',
				host: 'worktree.example.test',
				port: 22,
				username: 'dev',
				privateKeyPath: '~/.ssh/id_ed25519',
				enabled: true,
			};
			const cwd = host === 'SSH' ? '/remote/worktree' : outFile('worktree');
			if (host === 'local') fs.mkdirSync(cwd);
			const accountRoot =
				host === 'SSH' ? `/accounts/${account}` : path.join(scratch.dir, `account ${account}`);
			const selectedBinary = host === 'SSH' ? '/opt/Grok CLI/grok' : process.execPath;
			const argvOut = outFile('worktree-argv');
			const envOut = outFile('worktree-env');
			const stdinOut = outFile('worktree-stdin');
			const nativeId = `fresh-worktree-${account}`;
			const fixtureEnv = {
				FAKE_AGENT_RECORDING: writeFakeTurn(scratch.dir, {
					chunks: [
						JSON.stringify({ type: 'text', data: 'Child answer' }) + '\n',
						JSON.stringify({ type: 'end', stopReason: 'EndTurn', sessionId: nativeId }) + '\n',
					],
					close: { code: 0, signal: null },
				}),
				FAKE_AGENT_ARGV_OUT: argvOut,
				FAKE_AGENT_ENV_OUT: envOut,
				FAKE_AGENT_STDIN_OUT: stdinOut,
			};
			const selected = createMockAITab({
				id: 'selected',
				agentSessionId: `parent-native-${account}`,
				permissionMode: permission,
				...(account === 'a' ? { customModel: 'grok-4.5', customEffort: 'high' } : {}),
			});
			const parent = createMockSession({
				toolType: 'grok',
				cwd: host === 'SSH' ? '/remote/parent' : scratch.dir,
				customPath: selectedBinary,
				customArgs: refusal === 'route' ? 'agent stdio' : undefined,
				customEnvVars: { ...fixtureEnv, GROK_HOME: accountRoot, GROK_AUTH_PATH: '' },
				customModel: 'grok-composer-2.5-fast',
				customEffort: 'low',
				agentSessionId: 'legacy-parent-native',
				aiTabs: [createMockAITab({ id: 'other', customModel: 'wrong-model' }), selected],
				activeTabId: selected.id,
				sessionSshRemoteConfig:
					host === 'SSH'
						? { enabled: true, remoteId: remote.id, workingDirOverride: '/remote/parent' }
						: undefined,
			});
			const original = structuredClone(parent);
			const child = buildWorktreeSession({
				parentSession: parent,
				path: cwd,
				name: 'Grok child',
				defaultSaveToHistory: true,
				defaultShowThinking: 'off',
			});
			const tab = child.aiTabs[0];
			const assembled = assembleTurn(
				child,
				tab,
				{ text: 'Work in this child.' },
				makeContext('grok', { command: selectedBinary })
			);
			if (!assembled.ok) throw new Error(assembled.message);
			const turn = assembled.turn;
			// Only the local executable harness needs a script prefix. Remote configuration
			// reaches the real planner unchanged; the injected SSH client runs the fake agent.
			if (host === 'local') turn.launch.args.unshift(FAKE_AGENT_PATH);
			turn.launch.promptFileDestination =
				host === 'local'
					? { owner: 'local', path: outFile('worktree-prompt') + '.json' }
					: newRemotePromptFileDestination(remote.id, 'acp-json');
			const scope = grokScopeFixture(cwd, accountRoot, host === 'SSH' ? remote : undefined);
			scope.ports.remote.observe.mockResolvedValue({
				success: true,
				data: { cwd: { canonicalPath: cwd }, account: { canonicalPath: accountRoot } },
			});
			const wrap = vi.fn<NonNullable<RunAgentTurnDeps['wrapSpawnWithSsh']>>(async () => ({
				command: process.execPath,
				args: [FAKE_AGENT_PATH, 'dev@worktree.example.test', ...SSH_STDIN_REMOTE_SHELL],
				cwd: scratch.dir,
				sshStdinScript: 'synthetic worktree transfer',
				sshRemoteUsed: remote,
			}));
			const runTurn = vi.spyOn(runToCompletion, 'runTurn');
			const accountRef = nativeAccountRef('grok', accountRoot);
			const started = await runAgentTurn(
				turn,
				optionsFor({
					sessionId: `${child.id}-ai-${tab.id}`,
					grokLaunchScope: scope.ports,
					sshStore: { getSshRemotes: () => [remote] },
					deps: { env: host === 'SSH' ? fixtureEnv : {}, wrapSpawnWithSsh: wrap },
				})
			);

			expect(turn.settings).toEqual({
				provider: 'grok',
				model: account === 'a' ? 'grok-4.5' : 'grok-composer-2.5-fast',
				effort: account === 'a' ? 'high' : 'low',
			});
			expect(turn.permissionMode).toBe(permission);
			expect(turn.resumeSessionId).toBeUndefined();
			expect(turn.launch.args).not.toContain('--resume');
			expect(tab.agentSessionId).toBeNull();
			expect(parent).toEqual(original);
			if (refusal) {
				expect(started).toMatchObject({
					ok: false,
					reason: 'grok-native-session-refused',
					message: 'Grok ACP routing is not qualified on this native launch path.',
				});
				expect(started).not.toHaveProperty('run');
				expect(runTurn).not.toHaveBeenCalled();
				for (const file of [argvOut, envOut, stdinOut]) expect(fs.existsSync(file)).toBe(false);
			} else {
				if (!started.ok) throw new Error(started.message);
				expect(runTurn).toHaveBeenCalledOnce();
				const result = await started.run.result;
				expect(result).toMatchObject({
					outcome: 'completed',
					answerText: 'Child answer',
					sessionId: nativeId,
				});
				expect(result.sessionId).not.toBe(selected.agentSessionId);
				expect(started.run.nativeLaunchReceipt).toEqual({
					scope: {
						version: 1,
						state: 'bound',
						provider: 'grok',
						cwd,
						accountRef,
						host: { kind: host === 'SSH' ? 'ssh' : 'local', identity: 'fixture-installation' },
					},
					requestedNativeSessionId: undefined,
				});
				const argv = JSON.parse(fs.readFileSync(argvOut, 'utf8')) as string[];
				const providerArgs = host === 'local' ? argv : wrap.mock.calls[0][0].args;
				expect(providerArgs).toEqual(
					expect.arrayContaining([
						'-m',
						turn.settings.model,
						'--reasoning-effort',
						turn.settings.effort,
					])
				);
				if (permission === 'readonly') {
					expect(providerArgs).toEqual(
						expect.arrayContaining(['--permission-mode', 'plan', '--deny', 'Bash(*)'])
					);
					expect(providerArgs).not.toContain('--always-approve');
				} else expect(providerArgs).toContain('--always-approve');
				if (host === 'local') {
					expect(JSON.parse(fs.readFileSync(envOut, 'utf8'))).toMatchObject({
						GROK_HOME: accountRoot,
					});
					expect(runTurn.mock.calls[0][0].cwd).toBe(cwd);
				} else {
					expect(argv).toEqual(['dev@worktree.example.test', ...SSH_STDIN_REMOTE_SHELL]);
					expect(fs.readFileSync(stdinOut, 'utf8')).toContain('synthetic worktree transfer');
					expect(wrap.mock.calls[0][0]).toMatchObject({
						command: selectedBinary,
						cwd,
						customEnvVars: { GROK_HOME: accountRoot },
					});
					expect(wrap.mock.calls[0][1]).toEqual(child.sessionSshRemoteConfig);
				}
				expect(parent).toEqual(original);
			}
			expect(wrap).toHaveBeenCalledTimes(host === 'SSH' && !refusal ? 1 : 0);
		}
	);
});

describe.each(['local', 'SSH'] as const)('runAgentTurn: Grok native ownership on %s', (host) => {
	let turn: AssembledTurn;
	let options: RunAgentTurnOptions;
	let scope: ReturnType<typeof grokScopeFixture>;
	let remote: SshRemoteConfig;
	beforeEach(() => {
		remote = {
			id: 'native-host',
			name: 'Native host',
			host: 'native.example.test',
			port: 22,
			username: 'dev',
			privateKeyPath: '~/.ssh/id_ed25519',
			enabled: true,
		};
		const account =
			host === 'SSH' ? '/selected/account' : path.join(scratch.dir, 'selected-account');
		turn = assembleWithFakeAgent('grok', {
			recording: 'captured-opencode-normal',
			tab: { agentSessionId: 'grok-native-session' },
			env: { GROK_HOME: account },
		});
		if (host === 'SSH') turn.launch.sshRemoteConfig = { enabled: true, remoteId: remote.id };
		else
			turn.launch.promptFileDestination = {
				owner: 'local',
				path: outFile('native-prompt') + '.json',
			};
		scope = grokScopeFixture(scratch.dir, account, host === 'SSH' ? remote : undefined);
		options = optionsFor({
			grokLaunchScope: scope.ports,
			retainedNativeSessionBinding: scope.binding,
			sshStore: { getSshRemotes: () => [remote] },
			deps: {
				wrapSpawnWithSsh: vi.fn(async () => ({
					command: process.execPath,
					args: [FAKE_AGENT_PATH, 'dev@native.example.test', ...SSH_STDIN_REMOTE_SHELL],
					sshStdinScript: 'synthetic remote transfer',
					cwd: scratch.dir,
					sshRemoteUsed: structuredClone(remote),
				})),
			},
		});
		vi.spyOn(runToCompletion, 'runTurn').mockImplementation(() => {
			throw new Error('Unexpected process start');
		});
	});
	afterEach(() => vi.restoreAllMocks());

	it.each([
		'wrong account',
		'wrong cwd',
		'wrong host',
		'wrong ID',
		'unknown binding',
		'unobserved',
		'missing root',
		'resume selector',
		'cwd selector',
		'injected resume',
		'ACP route',
		'malformed ID',
	])('refuses %s without a process, receipt or fresh-session fallback', async (failure) => {
		if (failure === 'wrong account')
			scope.binding.accountRef = nativeAccountRef('grok', '/other/account');
		if (failure === 'wrong cwd') scope.binding.cwd += '/other';
		if (failure === 'wrong host') scope.binding.host.identity = 'another-installation';
		if (failure === 'wrong ID') scope.binding.nativeSessionId = 'another-native-id';
		if (failure === 'unknown binding')
			options.retainedNativeSessionBinding = { version: 1, state: 'unknown', reason: 'unobserved' };
		if (failure === 'unobserved') options.grokLaunchScope = undefined;
		if (failure === 'missing root') {
			scope.ports.local.realpath.mockRejectedValue(
				Object.assign(new Error('missing'), { code: 'ENOENT' })
			);
			scope.ports.remote.observe.mockResolvedValue({ success: false, errorCode: 'ENOENT' });
		}
		if (failure === 'resume selector') turn.launch.args.push('--resume', 'another-native-id');
		if (failure === 'cwd selector') turn.launch.args.push('--cwd', '/another/cwd');
		if (failure === 'injected resume') turn.resumeSessionId = undefined;
		if (failure === 'ACP route') turn.launch.args.push('agent', 'stdio');
		if (failure === 'malformed ID') {
			turn.resumeSessionId = '';
			turn.launch.args[turn.launch.args.indexOf('--resume') + 1] = '';
		}
		const started = await runAgentTurn(turn, options);
		expect(started).toMatchObject({ ok: false, reason: 'grok-native-session-refused' });
		expect(started).not.toHaveProperty('run');
		expect(runToCompletion.runTurn).not.toHaveBeenCalled();
	});

	it.each([
		'args',
		'env',
		'cwd',
		'binding',
		'native ID',
		'selection callback',
		'directory',
		'installation',
		'endpoint',
		'recheck throws',
		'spawn throws',
	])(
		'rechecks %s after a pending scope observation and cleans owned preparation',
		async (change) => {
			// The host directory observation is the await the selection, binding, endpoint and
			// directories must survive before spawn.
			const entered = Promise.withResolvers<void>();
			const gate = Promise.withResolvers<void>();
			if (host === 'SSH') {
				const observe = scope.ports.remote.observe.getMockImplementation()!;
				scope.ports.remote.observe.mockImplementationOnce(async (...args) => {
					entered.resolve();
					await gate.promise;
					return observe(...args);
				});
			} else {
				const stat = scope.ports.local.stat.getMockImplementation()!;
				scope.ports.local.stat.mockImplementationOnce(async () => {
					entered.resolve();
					await gate.promise;
					return stat();
				});
			}
			const owned = outFile('native-owned-system');
			turn.systemPromptDelivery = { via: 'file' };
			vi.spyOn(turnArgs, 'writeSystemPromptFile').mockImplementation(async (input) => {
				fs.writeFileSync(owned, 'fixture system');
				return { args: input.args, prompt: input.prompt, tempFile: owned, delivery: 'file' };
			});
			const cleanup = vi.spyOn(pipeSpawn, 'removeTempFiles');
			const pending = runAgentTurn(turn, options);
			await entered.promise;
			expect(runToCompletion.runTurn).not.toHaveBeenCalled();
			if (change === 'args') turn.launch.args.push('--resume', 'other');
			if (change === 'env') turn.launch.sessionCustomEnvVars = { GROK_HOME: '/another/account' };
			if (change === 'cwd') turn.launch.cwd += '/other';
			if (change === 'binding') scope.binding.accountRef = 'changed';
			if (change === 'native ID') turn.resumeSessionId = 'other';
			if (change === 'selection callback') options.recheckNativeSelection = () => false;
			if (change === 'directory') {
				scope.ports.local.realpathSync.mockReturnValue(path.join(scratch.dir, 'replacement'));
				scope.ports.remote.observe.mockResolvedValue({ success: false, errorCode: 'ENOENT' });
			}
			if (change === 'installation') {
				scope.ports.local.installationId.mockReturnValue('replacement');
				scope.ports.remote.qualify.mockResolvedValue(undefined);
			}
			if (change === 'endpoint') {
				if (host === 'SSH') remote.host = 'changed.example.test';
				else scope.ports.local.installationId.mockReturnValue('replacement');
			}
			const unexpected = new Error('unexpected directory failure');
			if (change === 'recheck throws') {
				scope.ports.local.realpathSync.mockImplementation(() => {
					throw unexpected;
				});
				scope.ports.remote.observe.mockRejectedValue(unexpected);
			}
			// Observe the rejection before releasing the observation, so no promise goes unhandled.
			const rejected =
				change === 'recheck throws' ? expect(pending).rejects.toBe(unexpected) : undefined;
			gate.resolve();
			if (rejected) await rejected;
			else {
				const started = await pending;
				expect(started).toMatchObject({
					ok: false,
					reason: change === 'spawn throws' ? 'launch' : 'grok-native-session-refused',
				});
				expect(started).not.toHaveProperty('run');
			}
			expect(runToCompletion.runTurn).toHaveBeenCalledTimes(change === 'spawn throws' ? 1 : 0);
			expect(cleanup).toHaveBeenCalledExactlyOnceWith([owned]);
			await waitUntil(() => !fs.existsSync(owned));
		}
	);

	it('does not attach a receipt to an asynchronous spawn failure', async () => {
		vi.mocked(runToCompletion.runTurn).mockRestore();
		turn.launch.command = path.join(scratch.dir, 'missing-executable');
		options.deps!.wrapSpawnWithSsh = async () => ({
			command: turn.launch.command,
			args: ['dev@native.example.test', ...SSH_STDIN_REMOTE_SHELL],
			sshStdinScript: 'synthetic remote transfer',
			cwd: scratch.dir,
			sshRemoteUsed: remote,
		});
		const started = await runAgentTurn(turn, options);
		expect(started.ok).toBe(true);
		if (!started.ok) return;
		expect(started.run.pid).toBeUndefined();
		expect(started.run).not.toHaveProperty('nativeLaunchReceipt');
		expect((await started.run.result).outcome).toBe('crashed');
		expect(await collect(started.run)).toEqual([]);
	});
});

// The portable consumer (library runtime, `maestro-cli host`) on the negotiated ACP
// route against the synthetic wire-1 peer of fixtures/grok-acp-peer.ts; not native qualification.
describe.skipIf(process.platform === 'win32')('runAgentTurn: the Grok ACP route', () => {
	let dir: string;
	let wrapper: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(scratch.dir, 'grok-acp-'));
		wrapper = writeSyntheticGrokAcpPeer(dir);
		vi.spyOn(runToCompletion, 'runTurn');
	});
	afterEach(() => vi.restoreAllMocks());

	const logOf = () => readSyntheticGrokAcpLog(path.join(dir, 'peer.log'));
	function grokTurn(env: Record<string, string>, tab: Partial<TurnTab> = {}) {
		const account = path.join(dir, 'account');
		const assembled = assembleTurn(
			makeAgent({
				toolType: 'grok',
				cwd: dir,
				customPath: wrapper,
				customEnvVars: { GROK_HOME: account, FAKE_LOG: path.join(dir, 'peer.log'), ...env },
			}),
			makeTab({ permissionMode: 'standard', ...tab }),
			{ text: 'portable work' },
			makeContext('grok', { provider: providerFor('grok', wrapper), command: wrapper })
		);
		if (!assembled.ok) throw new Error(assembled.message);
		return { turn: assembled.turn, scope: grokScopeFixture(dir, account) };
	}
	it('refuses a standard turn with no consent port before any process, with no headless fallback', async () => {
		const { turn, scope } = grokTurn({});
		const refused = await runAgentTurn(turn, optionsFor({ grokLaunchScope: scope.ports }));
		expect(refused).toMatchObject({ ok: false, reason: 'grok-route-refused' });
		expect(logOf()).toEqual([]);
		expect(runToCompletion.runTurn).not.toHaveBeenCalled();
	});

	it('keeps a Full Access turn on the native headless runner, never dialing ACP', async () => {
		const { turn, scope } = grokTurn({}, { permissionMode: 'full' });
		const run = await start(turn, { grokLaunchScope: scope.ports });
		await run.result;
		expect(runToCompletion.runTurn).toHaveBeenCalledTimes(1);
		const spec = vi.mocked(runToCompletion.runTurn).mock.calls[0][0];
		expect(spec.args).toContain('--always-approve');
		expect(spec.args).not.toContain('stdio');
		expect(logOf()).toEqual([]);
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
		expect(env.MAESTRO_P_ACCEPT_WORKSPACE_TRUST).toBeUndefined();
	});

	it("lets a TUI turn accept claude's folder trust when the caller says it is the agent's own cwd (#1872)", async () => {
		const envOut = outFile('env');
		const run = await start(
			assembleWithFakeAgent('claude-code', {
				recording: 'captured-claude-code-normal',
				env: { FAKE_AGENT_ENV_OUT: envOut },
			}),
			{ claudeTokenSource: tuiSource, maestroPBinPath: FAKE_AGENT_PATH, acceptWorkspaceTrust: true }
		);
		await run.result;

		expect(JSON.parse(fs.readFileSync(envOut, 'utf8')).MAESTRO_P_ACCEPT_WORKSPACE_TRUST).toBe('1');
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
		// The name every spawn uses: a safe slug of the session id, and a suffix that keeps two
		// spawns in the same millisecond apart.
		expect(path.basename(file)).toMatch(
			/^maestro-sysprompt-agent-1-ai-tab-1-\d+-[0-9a-f]{8}\.txt$/
		);
		expect(fs.readFileSync(file, 'utf8')).toBe(turn.systemPrompt);
		if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
		expect(argv).not.toContain('--append-system-prompt');

		run.terminate();
		await run.result;
		await waitUntil(() => !fs.existsSync(file));
		expect(fs.existsSync(file)).toBe(false);
	});
});

describe('runAgentTurn: the system prompt file cannot be written', () => {
	it('runs the turn with the prompt inline instead of refusing it', async () => {
		const argvOut = outFile('argv');
		const turn = assembleWithFakeAgent('claude-code', {
			recording: 'captured-claude-code-normal',
			context: { isWindowsHost: true },
			env: { FAKE_AGENT_ARGV_OUT: argvOut },
		});

		const run = await start(turn, { deps: { tempDir: path.join(scratch.dir, 'no-such-dir') } });
		await run.result;

		const argv = JSON.parse(fs.readFileSync(argvOut, 'utf8')) as string[];
		expect(argv).not.toContain('--append-system-prompt-file');
		expect(argv[argv.indexOf('--append-system-prompt') + 1]).toBe(turn.systemPrompt);
	});
});

describe('runAgentTurn: a resumed Claude session', () => {
	it('records the turn’s own cost, not the session’s running total', async () => {
		clearRememberedClaudeSessionCosts();
		const configDir = path.join(scratch.dir, `claude-config-${++sequence}`);
		// What the session had cost before this turn: the last `cost-state` row claude wrote.
		const transcript = claudeTranscriptPath(
			configDir,
			scratch.dir,
			CAPTURED_CLAUDE_CODE_SESSION_ID
		);
		fs.mkdirSync(path.dirname(transcript), { recursive: true });
		fs.writeFileSync(
			transcript,
			`${JSON.stringify({ type: 'cost-state', totalCostUSD: 0.0840728, modelUsage: {} })}\n`
		);
		const turn = assembleWithFakeAgent('claude-code', {
			recording: 'captured-claude-code-resumed',
			tab: { agentSessionId: CAPTURED_CLAUDE_CODE_SESSION_ID },
			env: { CLAUDE_CONFIG_DIR: configDir },
		});
		expect(turn.resumeSessionId).toBe(CAPTURED_CLAUDE_CODE_SESSION_ID);

		const result = await (await start(turn)).result;

		// The recording reports the session's total, 0.1948228; this turn spent the rest.
		expect(result.usage?.totalCostUsd).toBeCloseTo(0.1948228 - 0.0840728, 6);
	});
});

describe('runAgentTurn: an SSH turn’s remote agent', () => {
	const remote: SshRemoteConfig = {
		id: 'remote-1',
		name: 'Build box',
		host: 'build.example.com',
		port: 22,
		username: 'dev',
		privateKeyPath: '~/.ssh/id_ed25519',
		enabled: true,
	};

	/** An SSH turn whose ssh client is the fake agent, holding until stopped. */
	async function startRemote(stdinOut: string) {
		const turn = assembleWithFakeAgent('opencode', {
			recording: 'captured-opencode-normal',
			agent: { sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' } },
		});
		return start(turn, {
			sshStore: { getSshRemotes: () => [remote] },
			deps: {
				env: {
					...process.env,
					FAKE_AGENT_RECORDING: writeFakeTurn(
						scratch.dir,
						fakeTurnFromRecording(CAPTURED_RECORDINGS['captured-opencode-normal'])
					),
					FAKE_AGENT_STDIN_OUT: stdinOut,
					FAKE_AGENT_HOLD: '1',
				},
				wrapSpawnWithSsh: async () => ({
					command: process.execPath,
					// The stdin-script shape: the connection, then the remote shell that reads the script.
					args: [FAKE_AGENT_PATH, 'dev@build.example.com', ...SSH_STDIN_REMOTE_SHELL],
					cwd: scratch.dir,
					sshStdinScript: 'cd /work && exec opencode',
					sshRemoteUsed: remote,
				}),
			},
		});
	}

	it('records the agent’s pid in the script, and Stop signals it on its host', async () => {
		const stdinOut = outFile('stdin');
		const run = await startRemote(stdinOut);
		await waitUntil(() => fs.existsSync(stdinOut));

		const script = fs.readFileSync(stdinOut, 'utf8');
		const pidFile = /maestro-agent-[0-9a-f-]+\.pid/.exec(script)?.[0];
		expect(pidFile).toBeDefined();
		expect(script.endsWith('\ncd /work && exec opencode')).toBe(true);

		run.interrupt();
		await run.result;

		expect(remoteSignals[0]).toEqual({ pidFile: `/tmp/${pidFile}`, mode: 'interrupt' });
	});

	it('terminates the remote agent with the turn, and signals nothing once it has ended', async () => {
		const stdinOut = outFile('stdin');
		const run = await startRemote(stdinOut);
		await waitUntil(() => fs.existsSync(stdinOut));

		run.terminate();
		await run.result;
		expect(remoteSignals.map((signal) => signal.mode)).toEqual(['terminate']);

		run.terminate();
		expect(remoteSignals).toHaveLength(1);
	});
});

describe('runAgentTurn: a process whose stdio outlives it', () => {
	it.skipIf(process.platform === 'win32')(
		'settles once the grace after its exit has passed, though a grandchild holds the pipes',
		async () => {
			const pidOut = outFile('pid');
			const turn = assembleWithFakeAgent('opencode', { recording: 'captured-opencode-normal' });
			// The process exits at once and leaves a grandchild holding stdout and stderr open, as
			// an SSH ControlMaster does: `close` would not come for 30 seconds.
			const run = await start({
				...turn,
				launch: {
					...turn.launch,
					command: '/bin/sh',
					args: ['-c', 'sleep 30 & echo $! > "$0"; exit 0', pidOut],
				},
			});
			try {
				const result = await run.result;
				expect(result.exit.exitCode).toBe(0);
			} finally {
				const pid = Number(fs.readFileSync(pidOut, 'utf8'));
				if (pid > 0) process.kill(pid, 'SIGKILL');
			}
		},
		15_000
	);
});

describe('runAgentTurn: a refused effort', () => {
	beforeEach(() => {
		resetEffortRejections();
	});

	it('notes the refusal for the process, so the value stops being offered', async () => {
		const refusal = JSON.stringify({
			type: 'error',
			status: 400,
			error: {
				message:
					"Unsupported value: 'minimal' is not supported with the 'gpt-6-astra' model. " +
					"Supported values are: 'low', 'medium', 'high'.",
				param: 'reasoning.effort',
			},
		});
		const turn = assembleWithFakeAgent('opencode', {
			recording: 'captured-opencode-normal',
			env: {
				FAKE_AGENT_RECORDING: writeFakeTurn(scratch.dir, {
					chunks: [],
					stderr: `${refusal}\n`,
					close: { code: 1, signal: null },
				}),
			},
		});

		const result = await (await start(turn)).result;

		expect(result.outcome).toBe('crashed');
		expect(getEffortRejection('opencode', 'minimal')).toMatchObject({
			value: 'minimal',
			supported: ['low', 'medium', 'high'],
		});
	});
});

/** Poll until `done`, for a removal that happens after the turn settles. */
async function waitUntil(done: () => boolean): Promise<void> {
	const deadline = Date.now() + 2000;
	while (!done() && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

// Sanitized Grok `streaming-json` records through the portable consumer
// (library runtime, `maestro-cli host`) on the native headless route (Full Access), a real
// fake-agent process on a real pipe. Each case asserts the turn's resulting state (outcome,
// answer, native session, usage, error, exit), not a parser return value. Synthetic records,
// not native qualification.
describe('runAgentTurn: Grok native headless records', () => {
	const line = (record: Record<string, unknown>) => JSON.stringify(record) + '\n';
	const text = (data: string) => line({ type: 'text', data });
	const end = (sessionId: string) => line({ type: 'end', stopReason: 'EndTurn', sessionId });
	const closed = (code: number | null = 0, signal: NodeJS.Signals | null = null) => ({
		code,
		signal,
	});

	async function grokNative(
		fake: FakeTurn,
		extra: { tab?: Partial<TurnTab>; text?: string; env?: Record<string, string> } = {}
	) {
		const account = path.join(scratch.dir, 'grok-native-account');
		const turn = assembleWithFakeAgent('grok', {
			recording: 'captured-opencode-normal',
			text: extra.text,
			env: {
				FAKE_AGENT_RECORDING: writeFakeTurn(scratch.dir, fake),
				GROK_HOME: account,
				...extra.env,
			},
			tab: { permissionMode: 'full', ...extra.tab },
		});
		const scope = grokScopeFixture(scratch.dir, account);
		const resume = extra.tab?.agentSessionId;
		const run = await start(turn, {
			grokLaunchScope: scope.ports,
			...(resume
				? { retainedNativeSessionBinding: { ...scope.binding, nativeSessionId: resume } }
				: {}),
		});
		const [events, result] = await Promise.all([collect(run), run.result]);
		return { events, result };
	}

	it('keeps answer, thought and tool output apart across a long fragmented stream', async () => {
		const stream = grokSyntheticStream(GROK_SYNTHETIC_ROUNDS);
		const { events, result } = await grokNative({
			chunks: rechunk(stream.lines, 97),
			close: closed(),
		});
		expect(result.outcome).toBe('completed');
		expect(result.error).toBeUndefined();
		expect(result.answerText).toBe(stream.answer);
		expect(result.answerText).not.toMatch(/Step \d|contents \d/);
		expect(result.sessionId).toBe(GROK_SYNTHETIC_SESSION_ID);
		const reasoning = events.filter((event) => event.type === 'text' && event.isReasoning);
		expect(reasoning).toHaveLength(stream.rounds);
		expect(reasoning.map((event) => event.text).join('').length).toBe(stream.thoughtBytes);
		expect(events.filter((event) => event.type === 'tool_use')).toHaveLength(2 * stream.rounds);
		// The end record's turn total, once.
		expect(result.usage).toMatchObject({
			inputTokens: 100 * stream.rounds,
			outputTokens: 20 * stream.rounds,
		});
		expect(result.exit.droppedOutputBytes).toBe(0);
	});

	it.each([
		[
			'a startup login failure on stderr (exit 1)',
			{ chunks: [], stderr: 'Error: please run `grok login` first\n', close: closed(1) },
		],
		[
			'an in-band auth error on exit 0',
			{
				chunks: [line({ type: 'error', message: 'Not authenticated. Run grok login to sign in.' })],
				close: closed(0),
			},
		],
	])('settles %s as an auth crash with no answer or session', async (_label, fake) => {
		const { result } = await grokNative(fake);
		expect(result.outcome).toBe('crashed');
		expect(result.error?.type).toBe('auth_expired');
		expect(result.error?.agentId).toBe('grok');
		expect(result.answerText ?? '').toBe('');
		expect(result.sessionId).toBeUndefined();
	});

	it('reads a forced process loss mid-answer as a crash, never a stop or a completion', async () => {
		const { result } = await grokNative({
			chunks: [line({ type: 'thought', data: 'planning' }), text('I started the')],
			close: closed(null, 'SIGKILL'),
		});
		expect(result.outcome).toBe('crashed');
		// Windows has no signals: the killed fake agent reports exit code 1 and no signal.
		expect(result.exit).toMatchObject(
			process.platform === 'win32'
				? { exitCode: 1, signal: null, interrupted: false }
				: { exitCode: null, signal: 'SIGKILL', interrupted: false }
		);
		// The message follows the exit code, not the platform: a signal death reads as
		// exit 0 to the parser, so it names the missing terminal record; the Windows
		// kill exits 1, which is the ordinary non-zero-exit crash every provider reports.
		expect(result.error?.message).toMatch(
			process.platform === 'win32'
				? /without a successful terminal record|Agent exited with code 1/
				: /without a successful terminal record/
		);
		expect(result.sessionId).toBeUndefined();
	});

	it.each([
		['a record cut at exit (partial JSONL)', [text('partial '), '{"type":"text","da'], undefined],
		[
			'a malformed line between valid records',
			[text('a '), '{not json}\n', text('b'), end('grok-malformed')],
			'grok-malformed',
		],
	])('fails %s instead of completing the turn', async (_label, chunks, sessionId) => {
		const { result } = await grokNative({ chunks, close: closed() });
		expect(result.outcome).toBe('crashed');
		expect(result.error?.message).toMatch(/malformed/);
		// A native id that did arrive is kept, so the conversation can still be resumed.
		expect(result.sessionId).toBe(sessionId);
	});

	it('takes a large record whole under the line cap and an oversized one whole or not at all', async () => {
		const large = 'y'.repeat(512 * 1024);
		const kept = await grokNative({ chunks: [text(large), end('grok-large')], close: closed() });
		expect(kept.result).toMatchObject({ outcome: 'completed', sessionId: 'grok-large' });
		expect(kept.result.answerText).toBe(large);
		expect(kept.result.exit.droppedOutputBytes).toBe(0);

		const oversized = 'x'.repeat(DEFAULT_MAX_LINE_LENGTH + 4096);
		const dropped = await grokNative({
			chunks: [text(oversized), text('tail'), end('grok-oversized')],
			close: closed(),
		});
		// Whole or nothing, never half-parsed: whether the reader drops the record depends on how
		// the pipe chunks it (the cap bounds the unterminated remainder), so either none of it or
		// all of it reaches the answer, the drop is counted when it happens, and the records
		// after it still settle the native session.
		const answer = dropped.result.answerText;
		if (dropped.result.exit.droppedOutputBytes > 0) {
			expect(answer).toBe('tail');
			expect(dropped.result.exit.droppedOutputBytes).toBeGreaterThan(DEFAULT_MAX_LINE_LENGTH);
		} else {
			expect(answer).toBe(oversized + 'tail');
		}
		expect(dropped.result.sessionId).toBe('grok-oversized');
		// Current behavior: a dropped record still
		// settles `completed`, with droppedOutputBytes as the only signal of the loss.
		expect(dropped.result.outcome).toBe('completed');
	});

	it('settles exactly once when a duplicated end record arrives', async () => {
		const { events, result } = await grokNative({
			chunks: [text('once'), end('grok-dup'), end('grok-dup')],
			close: closed(),
		});
		expect(result).toMatchObject({
			outcome: 'completed',
			answerText: 'once',
			sessionId: 'grok-dup',
		});
		expect(events.filter((event) => event.type === 'text').map((event) => event.text)).toEqual([
			'once',
		]);
	});

	it('learns a late native session id only from the end record, split across chunks', async () => {
		const { events, result } = await grokNative({
			chunks: [
				text('a'),
				text('b'),
				'{"type":"end","stopReason":"EndTurn","sess',
				'ionId":"grok-late"}\n',
			],
			close: closed(),
		});
		expect(result).toMatchObject({
			outcome: 'completed',
			answerText: 'ab',
			sessionId: 'grok-late',
		});
		const carrying = events.filter((event) => event.sessionId);
		expect(carrying).toHaveLength(1);
		expect(carrying[0].type).toBe('result');
		expect(events.indexOf(carrying[0])).toBe(events.length - 1);
	});

	it('resumes a queued turn with a long input through the private prompt file, never argv', async () => {
		const argvOut = outFile('grok-native-argv');
		const longInput = 'L'.repeat(300_000);
		const { result } = await grokNative(
			{ chunks: [text('still here'), end('grok-resumed')], close: closed() },
			{
				text: longInput,
				tab: { agentSessionId: 'grok-resumed' },
				env: { FAKE_AGENT_ARGV_OUT: argvOut },
			}
		);
		expect(result).toMatchObject({
			outcome: 'completed',
			answerText: 'still here',
			sessionId: 'grok-resumed',
		});
		const argv = JSON.parse(fs.readFileSync(argvOut, 'utf8')) as string[];
		expect(argv[argv.indexOf('--resume') + 1]).toBe('grok-resumed');
		expect(argv[argv.indexOf('--prompt-file') + 1]).toMatch(/\.json$/);
		expect(argv.join(' ')).not.toContain('LLLL');
		expect(argv.join(' ').length).toBeLessThan(2048);
	});
});
