/**
 * Routing of Codex turns between `codex exec --json` (the default) and the
 * opt-in `codex app-server` transport.
 *
 * Contracts under test:
 *  - A Codex agent with no transport (or `exec`) runs on the CLI child spawner.
 *  - An interactive Codex prompt turn on an `app-server` agent routes to the
 *    CodexAppServerSpawner, with the coworking env injected like any CLI spawn.
 *  - SSH, image, no-prompt, Auto Run and Cue turns stay on exec even when the
 *    agent opted in.
 *  - The transport field is ignored on a non-Codex agent.
 *  - `steer()` sends `turn/steer` for a process carrying a `codexAppServer`
 *    handle and emits its later verdict as `steering-verdict`; an exec turn
 *    is refused without contacting a maestro-p socket.
 *
 * The spawners are capture-only stubs, so nothing is launched.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProcessConfig, SpawnResult } from '../../../main/process-manager';

const SPAWN_RESULT: SpawnResult = { pid: 4242, success: true };

const captured = vi.hoisted(() => ({
	child: [] as ProcessConfig[],
	pty: [] as ProcessConfig[],
	appServer: [] as ProcessConfig[],
	appServerOptions: [] as unknown[],
	appServerProcesses: null as Map<string, unknown> | null,
	fallbackToCli: null as ((config: ProcessConfig) => SpawnResult) | null,
	socketSteers: [] as unknown[],
}));

vi.mock('../../../main/process-manager/steering-client', () => ({
	sendSteeringRequest: (options: { id: string }) => {
		captured.socketSteers.push(options);
		return Promise.resolve({
			type: 'steering',
			id: options.id,
			verdict: 'refused',
			refusal: 'not-running',
		});
	},
}));

vi.mock('../../../main/coworking/coworking-socket-path', () => ({
	getBridgeSocketPath: () => '/tmp/test-bridge.sock',
}));

vi.mock('../../../main/process-manager/spawners/ChildProcessSpawner', () => ({
	ChildProcessSpawner: class {
		spawn(config: ProcessConfig): SpawnResult {
			captured.child.push(config);
			captured.appServerProcesses?.set(config.sessionId, {
				sessionId: config.sessionId,
				toolType: config.toolType,
				pid: SPAWN_RESULT.pid,
			});
			return SPAWN_RESULT;
		}
	},
}));
vi.mock('../../../main/process-manager/spawners/PtySpawner', () => ({
	PtySpawner: class {
		spawn(config: ProcessConfig): SpawnResult {
			captured.pty.push(config);
			return SPAWN_RESULT;
		}
	},
}));
vi.mock('../../../main/process-manager/spawners/OpencodeServerSpawner', () => ({
	OpencodeServerSpawner: class {
		spawn(): SpawnResult {
			return SPAWN_RESULT;
		}
	},
}));
vi.mock('../../../main/process-manager/spawners/CodexAppServerSpawner', () => ({
	CodexAppServerSpawner: class {
		constructor(...args: unknown[]) {
			captured.appServerProcesses = args[0] as Map<string, unknown>;
			captured.appServerOptions.push(args[4]);
			captured.fallbackToCli = args[3] as (config: ProcessConfig) => SpawnResult;
		}
		spawn(config: ProcessConfig): SpawnResult {
			captured.appServer.push(config);
			captured.appServerProcesses!.set(config.sessionId, {
				sessionId: config.sessionId,
				toolType: 'codex',
				pid: SPAWN_RESULT.pid,
				codexAppServer: {},
			});
			return SPAWN_RESULT;
		}
	},
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

import { ProcessManager } from '../../../main/process-manager';
import type { ManagedProcess } from '../../../main/process-manager/types';
import type { CodexAppServerProcessHandle } from '../../../main/codex-app-server/protocol';
import type { SteeringResultFrame } from '../../../shared/chatSteering';

let nextId = 0;

function codexTurn(overrides: Partial<ProcessConfig> = {}): ProcessConfig {
	nextId += 1;
	return {
		sessionId: `codex-agent-ai-tab-${nextId}`,
		toolType: 'codex',
		cwd: '/tmp',
		command: 'codex',
		args: ['exec', '--json', '--dangerously-bypass-approvals-and-sandbox'],
		prompt: 'fix the bug',
		codexTransport: 'app-server',
		querySource: 'user',
		...overrides,
	};
}

describe('ProcessManager Codex transport routing', () => {
	let pm: ProcessManager;

	beforeEach(() => {
		captured.child.length = 0;
		captured.pty.length = 0;
		captured.appServer.length = 0;
		captured.appServerOptions.length = 0;
		pm = new ProcessManager(undefined, { appVersion: '9.9.9' });
	});

	it('hands the app version to the app-server spawner', () => {
		expect(captured.appServerOptions).toEqual([{ clientVersion: '9.9.9' }]);
	});

	it('reports the actual transport at spawn and after an asynchronous fallback', () => {
		const onTransport = vi.fn();
		pm.on('codex-transport', onTransport);
		const config = codexTurn();
		pm.spawn(config);
		expect(onTransport).toHaveBeenLastCalledWith(config.sessionId, 'app-server');

		captured.fallbackToCli!(config);
		expect(onTransport).toHaveBeenLastCalledWith(config.sessionId, 'exec');
	});

	it('reports exec for an image turn despite the app-server preference', () => {
		const onTransport = vi.fn();
		pm.on('codex-transport', onTransport);
		const config = codexTurn({ images: ['data:image/png;base64,AA=='] });
		pm.spawn(config);
		expect(onTransport).toHaveBeenCalledWith(config.sessionId, 'exec');
	});

	it('runs a Codex turn with no transport on exec (the default)', () => {
		pm.spawn(codexTurn({ codexTransport: undefined }));

		expect(captured.child).toHaveLength(1);
		expect(captured.appServer).toHaveLength(0);
	});

	it('runs a Codex turn set to exec on exec', () => {
		pm.spawn(codexTurn({ codexTransport: 'exec' }));

		expect(captured.child).toHaveLength(1);
		expect(captured.appServer).toHaveLength(0);
	});

	it('routes an interactive prompt turn on an app-server agent to the app-server spawner', () => {
		pm.spawn(codexTurn());

		expect(captured.appServer).toHaveLength(1);
		expect(captured.child).toHaveLength(0);
		expect(captured.pty).toHaveLength(0);
		// A per-turn child, so it gets the coworking env like any CLI spawn.
		expect(captured.appServer[0].customEnvVars?.MAESTRO_COWORKING_SESSION_ID).toBe('codex-agent');
	});

	it('treats a turn with no querySource as interactive', () => {
		pm.spawn(codexTurn({ querySource: undefined }));

		expect(captured.appServer).toHaveLength(1);
	});

	it('emits spawn for an app-server turn', () => {
		const onSpawn = vi.fn();
		pm.on('spawn', onSpawn);
		const config = codexTurn();

		pm.spawn(config);

		expect(onSpawn).toHaveBeenCalledWith(config);
	});

	it('keeps an SSH turn with no app-server launch on exec', () => {
		pm.spawn(codexTurn({ sshRemoteId: 'remote-1' }));

		expect(captured.child).toHaveLength(1);
		expect(captured.appServer).toHaveLength(0);
	});

	it('routes an SSH turn that carries an app-server launch to app-server', () => {
		pm.spawn(
			codexTurn({
				command: 'ssh',
				args: ['host', '/bin/bash', '--norc', '--noprofile', '-s'],
				prompt: undefined,
				sshRemoteId: 'remote-1',
				sshStdinScript: 'exec codex exec --json',
				codexAppServerSsh: {
					command: 'ssh',
					args: ['host', '/bin/bash', '--norc', '--noprofile', '-s'],
					stdinScript: 'exec codex app-server\n',
					remoteCommandLine: 'codex app-server',
					execArgs: ['exec', '--json', '--dangerously-bypass-approvals-and-sandbox'],
					cwd: '/home/me/proj',
					prompt: 'fix the bug',
				},
			})
		);

		expect(captured.appServer).toHaveLength(1);
		expect(captured.child).toHaveLength(0);
	});

	it('keeps an image turn on exec', () => {
		pm.spawn(codexTurn({ images: ['data:image/png;base64,AAAA'] }));

		expect(captured.child).toHaveLength(1);
		expect(captured.appServer).toHaveLength(0);
	});

	it('keeps a spawn with no prompt on exec', () => {
		pm.spawn(codexTurn({ prompt: undefined }));

		expect(captured.child).toHaveLength(1);
		expect(captured.appServer).toHaveLength(0);
	});

	it('keeps an Auto Run (batch) turn on exec', () => {
		pm.spawn(codexTurn({ querySource: 'auto' }));

		expect(captured.child).toHaveLength(1);
		expect(captured.appServer).toHaveLength(0);
	});

	it('keeps a Cue turn on exec', () => {
		// Cue claims its own origin; ProcessConfig narrows the type, the wire does not.
		pm.spawn(codexTurn({ querySource: 'cue' as unknown as ProcessConfig['querySource'] }));

		expect(captured.child).toHaveLength(1);
		expect(captured.appServer).toHaveLength(0);
	});

	it('ignores the transport on a non-Codex agent', () => {
		pm.spawn(codexTurn({ toolType: 'claude-code', command: 'claude' }));

		expect(captured.child).toHaveLength(1);
		expect(captured.appServer).toHaveLength(0);
	});
});

describe('ProcessManager.steer on Codex', () => {
	let pm: ProcessManager;

	beforeEach(() => {
		captured.socketSteers.length = 0;
		pm = new ProcessManager(undefined, { appVersion: '9.9.9' });
	});

	/** Register a process the way the app-server spawner does, with a scriptable handle. */
	function registerAppServerTurn(sessionId: string) {
		const userMessageListeners = new Set<
			(message: { turnId: string; itemId: string; text: string }) => void
		>();
		const sendRequest = vi.fn(() => Promise.resolve({ turnId: 'turn-1' }));
		const handle: CodexAppServerProcessHandle = {
			threadId: 'thread-1',
			activeTurnId: 'turn-1',
			sendRequest: sendRequest as CodexAppServerProcessHandle['sendRequest'],
			onUserMessage: (listener) => {
				userMessageListeners.add(listener);
				return () => userMessageListeners.delete(listener);
			},
			onTurnEnd: () => () => {},
		};
		captured.appServerProcesses!.set(sessionId, {
			sessionId,
			toolType: 'codex',
			codexAppServer: handle,
		} as unknown as ManagedProcess);
		return {
			sendRequest,
			echo: (text: string) => {
				for (const listener of [...userMessageListeners])
					listener({ turnId: 'turn-1', itemId: 'item-1', text });
			},
		};
	}

	it('sends turn/steer and emits the absorbed verdict with the same id', async () => {
		const turn = registerAppServerTurn('codex-agent-ai-tab');
		const verdicts: Array<[string, SteeringResultFrame]> = [];
		pm.on('steering-verdict', (sessionId: string, verdict: SteeringResultFrame) =>
			verdicts.push([sessionId, verdict])
		);

		const result = await pm.steer('codex-agent-ai-tab', 'use tabs');

		expect(result.verdict).toBe('delivered');
		expect(turn.sendRequest).toHaveBeenCalledWith(
			'turn/steer',
			{
				threadId: 'thread-1',
				expectedTurnId: 'turn-1',
				input: [{ type: 'text', text: 'use tabs' }],
			},
			expect.any(Object)
		);
		expect(captured.socketSteers).toEqual([]);

		turn.echo('use tabs');
		expect(verdicts).toEqual([
			['codex-agent-ai-tab', { type: 'steering', id: result.id, verdict: 'absorbed' }],
		]);
	});

	it('refuses a running exec turn with an accurate transport explanation', async () => {
		captured.appServerProcesses!.set('codex-exec-ai-tab', {
			sessionId: 'codex-exec-ai-tab',
			toolType: 'codex',
		} as unknown as ManagedProcess);

		const result = await pm.steer('codex-exec-ai-tab', 'use tabs');

		expect(captured.socketSteers).toHaveLength(0);
		expect(result).toMatchObject({
			verdict: 'refused',
			refusal: 'unsupported-transport',
			detail: expect.stringContaining('Codex exec'),
		});
	});
});
