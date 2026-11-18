/**
 * The `spawn` event on the OpenCode serve transport.
 *
 * That transport reports its `exit` through the handlers every other process
 * uses, so anything that pairs a start with an end (the agent-run capture, the
 * dispatch callbacks) has to be told of the start too. This pins that the
 * process manager emits `spawn` for it exactly as it does for a CLI process:
 * once, with the config it was given, after the spawner has the process.
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('os', async (importOriginal) => ({
	...(await importOriginal<typeof import('os')>()),
}));

vi.mock('fs', async (importOriginal) => {
	const actual = await importOriginal<typeof import('fs')>();
	const writes = {
		openSync: vi.fn(() => {
			throw new Error('Prompt artifact tests must not open prompt files.');
		}),
		writeFileSync: vi.fn(() => {
			throw new Error('Prompt artifact tests must not write prompt files.');
		}),
	};
	return { ...actual, ...writes, default: { ...actual, ...writes } };
});

// Prompt artifact tests stop at the fake spawners, before any artifact I/O or child.
vi.mock('../../../shared/maestro-lib/run/start-turn', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../shared/maestro-lib/run/start-turn')>()),
	startTurn: vi.fn(() => {
		throw new Error(
			'Prompt artifact tests must not reach artifact materialization or process launch.'
		);
	}),
}));

vi.mock('node-pty', () => ({
	spawn: vi.fn(),
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../main/coworking/coworking-socket-path', () => ({
	getBridgeSocketPath: () => '/tmp/maestro-test-coworking.sock',
}));

import { ProcessManager } from '../../../main/process-manager';
import { startTurn } from '../../../shared/maestro-lib/run/start-turn';
import { logger } from '../../../main/utils/logger';
import type { ManagedProcess, ProcessConfig } from '../../../main/process-manager/types';

const SERVE_RESULT = { pid: -1, success: true };

function config(overrides: Partial<ProcessConfig> = {}): ProcessConfig {
	return {
		sessionId: 'agent-1-ai-tab-1',
		toolType: 'opencode',
		cwd: os.tmpdir(),
		command: 'opencode',
		args: [],
		prompt: 'List the files.',
		...overrides,
	} as ProcessConfig;
}

/** A manager whose serve transport is on, with the two spawners stood in for. */
function createManager(): {
	manager: ProcessManager;
	order: string[];
	serve: ReturnType<typeof vi.fn>;
	cli: ReturnType<typeof vi.fn>;
} {
	const manager = new ProcessManager(() => true);
	const order: string[] = [];
	const serve = vi.fn(() => {
		order.push('serve spawner');
		return SERVE_RESULT;
	});
	const cli = vi.fn(() => {
		order.push('cli spawner');
		return { pid: 4242, success: true };
	});
	const internals = manager as unknown as {
		opencodeServerSpawner: { spawn: typeof serve };
		childProcessSpawner: { spawn: typeof cli };
	};
	internals.opencodeServerSpawner = { spawn: serve };
	internals.childProcessSpawner = { spawn: cli };
	manager.on('spawn', () => order.push('spawn event'));
	return { manager, order, serve, cli };
}

describe('ProcessManager spawn event on the OpenCode serve transport', () => {
	it('emits spawn once, with the config, after the serve spawner has the process', () => {
		const { manager, order, serve, cli } = createManager();
		const heard: ProcessConfig[] = [];
		manager.on('spawn', (spawned: ProcessConfig) => heard.push(spawned));
		const spawned = config();

		expect(manager.spawn(spawned)).toBe(SERVE_RESULT);

		expect(serve).toHaveBeenCalledWith(spawned);
		expect(cli).not.toHaveBeenCalled();
		expect(heard).toEqual([spawned]);
		expect(heard[0]).toBe(spawned);
		expect(order).toEqual(['serve spawner', 'spawn event']);
	});

	it('does not let a listener that throws break the spawn', () => {
		const { manager } = createManager();
		manager.on('spawn', () => {
			throw new Error('A capture listener failed.');
		});

		expect(manager.spawn(config())).toBe(SERVE_RESULT);
	});

	it('emits spawn once on the CLI path too, for a turn the serve transport does not take', () => {
		const { manager, order, serve } = createManager();

		// An image keeps an OpenCode turn on the CLI path.
		manager.spawn(config({ images: ['data:image/png;base64,AAAA'] }));

		expect(serve).not.toHaveBeenCalled();
		expect(order).toEqual(['cli spawner', 'spawn event']);
	});
});

/**
 * A Grok resume's retained ownership: the launch scope and the binding naming the same
 * native session, as the desktop attaches them (ProcessManager refuses a resume without).
 */
function boundGrokResume(
	nativeSessionId: string,
	host: { kind: 'local' | 'ssh'; identity: string }
): Pick<ProcessConfig, 'nativeSessionScope' | 'nativeSessionBinding'> {
	const scope = {
		version: 1,
		state: 'bound',
		provider: 'grok',
		accountRef: 'grok:fixture-account',
		host,
		cwd: '/synthetic',
	} as const;
	return {
		nativeSessionScope: scope as ProcessConfig['nativeSessionScope'],
		nativeSessionBinding: { ...scope, nativeSessionId } as ProcessConfig['nativeSessionBinding'],
	};
}

/**
 * The private prompt artifact at the process manager:
 * only the child-process sink owns a prompt file, the spawner receives the
 * artifact untouched, the `spawn` event carries lifecycle metadata only, and a
 * `spawnChecked` refusal starts nothing. The spawners are fakes; nothing here
 * writes a prompt file or launches a child.
 */
describe('ProcessManager private prompt artifact', () => {
	const artifact: NonNullable<ProcessConfig['promptArtifact']> = {
		owner: 'local',
		path: path.join(os.tmpdir(), 'maestro-prompt-00000000-0000-4000-8000-000000000001.json'),
		content: JSON.stringify([{ type: 'text', text: 'PRIVATE prompt: \u{96EA}\nsecond line' }]),
		encoding: 'utf8',
		mode: 0o600,
		flag: 'wx',
		cleanup: 'turn',
	};

	function grokManager() {
		const manager = new ProcessManager(() => true);
		const serve = vi.fn((_config: ProcessConfig) => SERVE_RESULT);
		const cli = vi.fn((_config: ProcessConfig) => ({ pid: 4242, success: true }));
		const internals = manager as unknown as {
			opencodeServerSpawner: { spawn: typeof serve };
			childProcessSpawner: { spawn: typeof cli };
		};
		internals.opencodeServerSpawner = { spawn: serve };
		internals.childProcessSpawner = { spawn: cli };
		const errors: unknown[] = [];
		manager.on('agent-error', (_id: string, error: unknown) => errors.push(error));
		return { manager, serve, cli, errors };
	}

	function disclosedBy(...values: unknown[]): string {
		return JSON.stringify([
			...values,
			...Object.values(logger).map((log) => vi.mocked(log).mock.calls),
		]);
	}

	beforeEach(() => {
		vi.clearAllMocks();
		// Exercise the real tilde-copy path without reading the operator's home.
		vi.spyOn(os, 'homedir').mockReturnValue(os.tmpdir());
	});
	afterEach(() => {
		vi.restoreAllMocks();
		expect(startTurn).not.toHaveBeenCalled();
		expect(fs.openSync).not.toHaveBeenCalled();
		expect(fs.writeFileSync).not.toHaveBeenCalled();
	});

	it.each(['local', 'remote'] as const)(
		'keeps a successful checked %s artifact spawn private',
		async (owner) => {
			const request = config({
				toolType: 'grok',
				command: owner === 'remote' ? 'ssh' : 'grok',
				prompt: undefined,
				promptArtifact: {
					...artifact,
					owner,
					...(owner === 'remote'
						? { path: '/var/tmp/private-prompt.json', sshRemoteId: 'remote-selected' }
						: {}),
				},
				sshRemoteId: owner === 'remote' ? 'remote-selected' : undefined,
				sshStdinScript: owner === 'remote' ? 'PRIVATE SSH script' : undefined,
			});
			const original = structuredClone(request);
			const { manager, cli, serve, errors } = grokManager();
			const capture = vi.fn();
			manager.on('spawn', capture);
			const beforeSpawn = vi.fn(() => undefined);

			expect(await manager.spawnChecked(request, { beforeSpawn })).toEqual({
				pid: 4242,
				success: true,
			});

			expect(beforeSpawn).toHaveBeenCalledTimes(1);
			expect(cli).toHaveBeenCalledTimes(1);
			expect(serve).not.toHaveBeenCalled();
			expect(cli.mock.calls[0][0].promptArtifact).toBe(request.promptArtifact);
			expect(request).toEqual(original);
			expect(errors).toEqual([]);
			expect(capture).toHaveBeenCalledTimes(1);
			for (const key of ['promptArtifact', 'prompt', 'sshStdinScript'])
				expect(capture.mock.calls[0][0]).not.toHaveProperty(key);
			const disclosed = disclosedBy(capture.mock.calls);
			for (const privateValue of [request.promptArtifact!.path, 'PRIVATE'])
				expect(disclosed).not.toContain(privateValue);
		}
	);

	it.each<[string, Partial<ProcessConfig>]>([
		['terminal attach', { toolType: 'terminal', reuseTerminal: true, prompt: undefined }],
		['PTY', { toolType: 'grok', requiresPty: true, prompt: undefined }],
		['OpenCode serve', { toolType: 'opencode' }],
		['Codex app-server', { toolType: 'codex', codexTransport: 'app-server' }],
	])('refuses an artifact on %s without replacing the owner', (_route, overrides) => {
		const { manager, cli, serve, errors } = grokManager();
		const internals = manager as unknown as {
			processes: Map<string, ManagedProcess>;
			ptySpawner: { spawn: (request: ProcessConfig) => unknown };
			codexAppServerSpawner: { spawn: (request: ProcessConfig) => unknown };
		};
		const pty = vi.spyOn(internals.ptySpawner, 'spawn').mockReturnValue({ success: true });
		const sdk = vi
			.spyOn(internals.codexAppServerSpawner, 'spawn')
			.mockReturnValue({ success: true });
		const capture = vi.fn();
		manager.on('spawn', capture);
		const request = config({ promptArtifact: artifact, ...overrides });
		const old = {
			sessionId: request.sessionId,
			pid: 73,
			isTerminal: true,
			ptyProcess: { kill: vi.fn() },
		} as unknown as ManagedProcess;
		internals.processes.set(request.sessionId, old);
		// Ordinary terminal reattachment still attaches to the live handle.
		expect(manager.spawn(config({ toolType: 'terminal', reuseTerminal: true }))).toEqual({
			pid: 73,
			success: true,
			attached: true,
		});

		const message = 'Prompt-file delivery is unavailable on this transport. Nothing was started.';
		expect(manager.spawn(request)).toEqual({ pid: -1, success: false, error: message });

		expect(manager.get(request.sessionId)).toBe(old);
		expect(old.ptyProcess!.kill).not.toHaveBeenCalled();
		for (const sink of [cli, serve, pty, sdk, capture]) expect(sink).not.toHaveBeenCalled();
		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatchObject({ message, recoverable: false });
		const disclosed = disclosedBy(errors);
		expect(disclosed).not.toContain(artifact.path);
		expect(disclosed).not.toContain('PRIVATE prompt');
	});

	it('captures remote identity without changing the private request', async () => {
		const { manager, cli } = grokManager();
		const selected = {
			...artifact,
			owner: 'remote' as const,
			path: '/var/tmp/private-remote-prompt.json',
			sshRemoteId: 'selected-remote',
		};
		const request = config({
			toolType: 'grok',
			command: 'ssh',
			prompt: undefined,
			promptArtifact: selected,
			sshRemoteId: selected.sshRemoteId,
			sshRemoteHost: 'synthetic.invalid',
			sshStdinScript: 'PRIVATE remote script',
			sshRemoteCommand: selected.path,
			args: ['synthetic.invalid', 'bash'],
			agentSessionId: 'resume-native',
			tabId: 'tab-1',
			// A Grok resume names the account and host it was retained under.
			...boundGrokResume('resume-native', { kind: 'ssh', identity: 'selected-remote' }),
		});
		const original = structuredClone(request);
		const heard: ProcessConfig[] = [];
		manager.on('spawn', (value) => heard.push(value));

		expect((await manager.spawnChecked(request)).success).toBe(true);

		const spawned = cli.mock.calls[0][0];
		// A Grok request is copied before the check; the artifact rides along unchanged.
		expect(spawned).not.toBe(request);
		expect(spawned.promptArtifact).toBe(selected);
		expect(spawned.sshStdinScript).toBe(request.sshStdinScript);
		expect(spawned.nativeSessionBinding).toEqual(request.nativeSessionBinding);
		expect(request).toEqual(original);
		expect(heard).toHaveLength(1);
		expect(heard[0]).toMatchObject({
			sshRemoteId: selected.sshRemoteId,
			sshRemoteHost: request.sshRemoteHost,
			agentSessionId: 'resume-native',
			tabId: 'tab-1',
			args: [],
		});
		for (const key of ['promptArtifact', 'sshStdinScript', 'sshRemoteCommand'])
			expect(heard[0]).not.toHaveProperty(key);
		const disclosed = disclosedBy(heard);
		for (const privateValue of [selected.path, 'PRIVATE prompt', 'PRIVATE remote script'])
			expect(disclosed).not.toContain(privateValue);
	});

	it.each(['fresh', 'empty', 'resumed'] as const)(
		'preserves the %s artifact through the checked, cwd and environment copies',
		async (turn) => {
			const { manager, cli, serve } = grokManager();
			const selected = { ...artifact, content: turn === 'empty' ? '' : artifact.content };
			const request = config({
				toolType: 'grok',
				command: 'grok',
				cwd: '~',
				prompt: undefined,
				args:
					turn === 'resumed'
						? ['--resume', 'native-resume-id', '--prompt-file', selected.path]
						: ['--prompt-file', selected.path],
				promptArtifact: selected,
				customEnvVars: { GROK_HOME: path.join(os.tmpdir(), 'synthetic-grok-account') },
				agentSessionId: turn === 'resumed' ? 'native-resume-id' : undefined,
				...(turn === 'resumed'
					? boundGrokResume('native-resume-id', { kind: 'local', identity: 'fixture-machine' })
					: {}),
			});
			const original = structuredClone(request);
			// A caller that edits its record while the check is pending cannot change what spawns.
			const beforeSpawn = async () => {
				request.args.push('--PRIVATE-late-arg');
				request.customEnvVars!.GROK_HOME = '/PRIVATE/late-home';
				return undefined;
			};

			expect(await manager.spawnChecked(request, { beforeSpawn })).toEqual({
				pid: 4242,
				success: true,
			});

			expect(cli).toHaveBeenCalledTimes(1);
			expect(serve).not.toHaveBeenCalled();
			const spawned = cli.mock.calls[0][0] as ProcessConfig;
			expect(spawned).not.toBe(request);
			expect(spawned.promptArtifact).toBe(selected);
			expect(spawned).toMatchObject({
				cwd: os.tmpdir(),
				args: original.args,
				agentSessionId: original.agentSessionId,
			});
			expect(spawned.customEnvVars).toEqual({
				...original.customEnvVars,
				MAESTRO_COWORKING_SESSION_ID: 'agent-1',
				MAESTRO_COWORKING_SOCKET_OVERRIDE: '/tmp/maestro-test-coworking.sock',
			});
		}
	);

	it('projects capture metadata without exposing or stripping the private spawner input', async () => {
		const { manager, cli } = grokManager();
		const heard: ProcessConfig[] = [];
		manager.on('spawn', (captured) => heard.push(captured));
		// Poison every legacy carrier to catch capture leaks, not to qualify
		// a mixed delivery plan at the child spawner (which is fake here).
		const request = config({
			toolType: 'grok',
			command: 'grok',
			promptArtifact: artifact,
			args: ['--prompt-file', artifact.path],
			prompt: artifact.content,
			sshStdinScript: artifact.content,
			sshRemoteCommand: artifact.path,
			images: [artifact.content],
			customEnvVars: { PRIVATE_FIXTURE: artifact.content },
			promptArgs: () => [artifact.content],
			imagePromptBuilder: () => artifact.path,
			querySource: 'auto',
			tabId: 'tab-1',
			projectPath: os.tmpdir(),
		});

		expect((await manager.spawnChecked(request)).success).toBe(true);

		expect(heard).toHaveLength(1);
		expect(heard[0]).toEqual({
			sessionId: request.sessionId,
			toolType: 'grok',
			cwd: request.cwd,
			command: 'grok',
			args: [],
			querySource: 'auto',
			tabId: 'tab-1',
			projectPath: os.tmpdir(),
			agentSessionId: undefined,
			sshRemoteId: undefined,
			sshRemoteHost: undefined,
		});
		const disclosed = disclosedBy(heard);
		expect(disclosed).not.toContain(artifact.path);
		expect(disclosed).not.toContain(path.basename(artifact.path));
		expect(disclosed).not.toContain('PRIVATE prompt');
		const spawned = cli.mock.calls[0][0] as ProcessConfig;
		expect(spawned.promptArtifact).toBe(artifact);
		expect(spawned.args).toEqual(request.args);
		expect(spawned.promptArgs).toBe(request.promptArgs);
		expect(spawned.sshStdinScript).toBe(artifact.content);
	});

	it('starts nothing when the final check refuses, and discloses no private field', async () => {
		const { manager, cli, serve, errors } = grokManager();
		const capture = vi.fn();
		manager.on('spawn', capture);
		const request = config({ toolType: 'grok', command: 'grok', promptArtifact: artifact });
		const refusal = 'Grok launch ownership changed. Nothing was started.';

		const result = await manager.spawnChecked(request, { beforeSpawn: async () => refusal });

		expect(result).toEqual({ pid: -1, success: false, error: refusal });
		for (const sink of [cli, serve, capture]) expect(sink).not.toHaveBeenCalled();
		expect(manager.get(request.sessionId)).toBeUndefined();
		expect(errors).toEqual([]);
		const disclosed = disclosedBy(result, errors);
		expect(disclosed).not.toContain(artifact.path);
		expect(disclosed).not.toContain(path.basename(artifact.path));
		expect(disclosed).not.toContain('PRIVATE prompt');
	});

	it.each(['omitted', 'undefined'] as const)(
		'keeps the ordinary serve spawn and its capture identity with an %s artifact',
		async (field) => {
			const { manager, serve, cli } = grokManager();
			const request = config(field === 'undefined' ? { promptArtifact: undefined } : {});
			const heard: ProcessConfig[] = [];
			manager.on('spawn', (captured) => heard.push(captured));

			expect(await manager.spawnChecked(request)).toBe(SERVE_RESULT);

			expect(serve).toHaveBeenCalledExactlyOnceWith(request);
			expect(cli).not.toHaveBeenCalled();
			expect(heard).toHaveLength(1);
			expect(heard[0]).toBe(request);
		}
	);
});
