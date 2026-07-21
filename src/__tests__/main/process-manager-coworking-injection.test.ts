/**
 * Regression tests for the per-spawn coworking socket override.
 *
 * Contracts under test:
 *  - ProcessManager.spawn() injects MAESTRO_COWORKING_SOCKET_OVERRIDE (the owning
 *    window's bridge socket, from getBridgeSocketPath) into customEnvVars for
 *    non-terminal agent spawns, so the coworking MCP subprocess binds to the
 *    bridge of the window that spawned it.
 *  - Terminal spawns are passed through unchanged (no injection).
 *  - A caller-supplied override in customEnvVars wins over the injected default
 *    (caller spread is last).
 *  - The generated MCP server script resolves its socket preferring the override
 *    env over the shared config socket env.
 *
 * The spawner modules are mocked so we capture the exact ProcessConfig that
 * ProcessManager.spawn() forwards, without launching a real PTY/child process.
 * getBridgeSocketPath is stubbed to a sentinel (and to avoid its electron
 * userData / named-pipe machinery).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProcessConfig, SpawnResult } from '../../main/process-manager';

// The literal env var names the generated MCP server script actually reads.
// Asserting the literals (not the source constants) pins the real wire contract
// between the injector and the script - a rename of the constant's value would
// silently break that contract and must redden these tests.
const OVERRIDE_ENV = 'MAESTRO_COWORKING_SOCKET_OVERRIDE';
const SESSION_ID_ENV = 'MAESTRO_COWORKING_SESSION_ID';
const CONFIG_ENV = 'MAESTRO_COWORKING_SOCKET';

const SENTINEL_SOCKET = '\\\\.\\pipe\\test-sock';
const SPAWN_RESULT: SpawnResult = { pid: 4242, success: true };

// Captured configs forwarded to each spawner. Hoisted so the vi.mock factories
// (which are lifted above imports) can close over them.
const captured = vi.hoisted(() => ({
	child: [] as ProcessConfig[],
	pty: [] as ProcessConfig[],
	server: [] as ProcessConfig[],
}));

// Stub the owning-window bridge socket path with a controllable sentinel.
const { mockGetBridgeSocketPath } = vi.hoisted(() => ({
	mockGetBridgeSocketPath: vi.fn<() => string>(),
}));
vi.mock('../../main/coworking/coworking-socket-path', () => ({
	getBridgeSocketPath: () => mockGetBridgeSocketPath(),
}));

// Replace the spawners with capture-only stubs so spawn() launches nothing.
vi.mock('../../main/process-manager/spawners/ChildProcessSpawner', () => ({
	ChildProcessSpawner: class {
		spawn(config: ProcessConfig): SpawnResult {
			captured.child.push(config);
			return SPAWN_RESULT;
		}
	},
}));
vi.mock('../../main/process-manager/spawners/PtySpawner', () => ({
	PtySpawner: class {
		spawn(config: ProcessConfig): SpawnResult {
			captured.pty.push(config);
			return SPAWN_RESULT;
		}
	},
}));
vi.mock('../../main/process-manager/spawners/OpencodeServerSpawner', () => ({
	OpencodeServerSpawner: class {
		spawn(config: ProcessConfig): SpawnResult {
			captured.server.push(config);
			return SPAWN_RESULT;
		}
	},
}));

// Avoid logger side effects (mirrors the existing process-manager test).
vi.mock('../../main/utils/logger', () => ({
	logger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

import { ProcessManager } from '../../main/process-manager';
import { getCoworkingServerScript } from '../../main/coworking/coworking-server-script';

describe('ProcessManager per-spawn coworking socket override', () => {
	let pm: ProcessManager;

	beforeEach(() => {
		captured.child.length = 0;
		captured.pty.length = 0;
		captured.server.length = 0;
		mockGetBridgeSocketPath.mockReset();
		mockGetBridgeSocketPath.mockReturnValue(SENTINEL_SOCKET);
		pm = new ProcessManager();
	});

	it('injects the owning window socket override for a non-terminal agent spawn', () => {
		pm.spawn({
			sessionId: 'agent-1',
			toolType: 'claude-code',
			cwd: '/tmp',
			command: 'claude',
			args: [],
		});

		// A non-terminal, non-pty agent spawn routes through the child spawner.
		expect(captured.pty).toHaveLength(0);
		expect(captured.child).toHaveLength(1);

		const forwarded = captured.child[0];
		expect(forwarded.customEnvVars?.[OVERRIDE_ENV]).toBe(SENTINEL_SOCKET);
	});

	it('does not inject the socket override for terminal spawns', () => {
		pm.spawn({
			sessionId: 'term-1',
			toolType: 'terminal',
			cwd: '/tmp',
			command: 'zsh',
			args: [],
			shell: 'zsh',
		});

		// Terminals go through the PTY spawner and are passed through unchanged.
		expect(captured.child).toHaveLength(0);
		expect(captured.pty).toHaveLength(1);

		const forwarded = captured.pty[0];
		expect(forwarded.customEnvVars?.[OVERRIDE_ENV]).toBeUndefined();
		// Pass-through means the session-id env is not injected either.
		expect(forwarded.customEnvVars?.[SESSION_ID_ENV]).toBeUndefined();
		expect(mockGetBridgeSocketPath).not.toHaveBeenCalled();
	});

	it('routes OpenCode prompts through the CLI child path with coworking env when the server gate is off', () => {
		pm.spawn({
			sessionId: 'oc-gate-off',
			toolType: 'opencode',
			cwd: '/tmp',
			command: 'opencode',
			args: [],
			prompt: 'do a thing',
		});

		// The default-OFF server gate keeps local interactive OpenCode on the CLI path.
		expect(captured.child).toHaveLength(1);
		expect(captured.server).toHaveLength(0);
		expect(captured.pty).toHaveLength(0);

		const forwarded = captured.child[0];
		const forwardedSessionId = forwarded.customEnvVars?.[SESSION_ID_ENV];
		expect(forwardedSessionId).toEqual(expect.any(String));
		expect(forwardedSessionId).not.toBe('');
		expect(forwarded.customEnvVars?.[OVERRIDE_ENV]).toBe(SENTINEL_SOCKET);
	});

	it('does not inject coworking env on the OpenCode SDK-serve path when the server gate is on', () => {
		// An OpenCode prompt turn routes to the shared `opencode serve` spawner.
		// Coworking env MUST NOT be injected there: MAESTRO_COWORKING_SESSION_ID is
		// per-session and would fingerprint into a separate server per session
		// (OpencodeServerManager.buildServerKey), fragmenting the shared server. The
		// serve decision runs on the raw config, before injection.
		const pmOn = new ProcessManager(() => true);
		pmOn.spawn({
			sessionId: 'oc-gate-on',
			toolType: 'opencode',
			cwd: '/tmp',
			command: 'opencode',
			args: [],
			prompt: 'do a thing',
		});

		// Routes to the server spawner, not child/pty.
		expect(captured.server).toHaveLength(1);
		expect(captured.child).toHaveLength(0);
		expect(captured.pty).toHaveLength(0);

		const forwarded = captured.server[0];
		expect(forwarded.customEnvVars?.[SESSION_ID_ENV]).toBeUndefined();
		expect(forwarded.customEnvVars?.[OVERRIDE_ENV]).toBeUndefined();
		// The serve path short-circuits before the injection block, so the owning
		// window socket is never even resolved.
		expect(mockGetBridgeSocketPath).not.toHaveBeenCalled();
	});

	it('lets a caller-supplied socket override win over the injected default', () => {
		const callerSocket = '\\\\.\\pipe\\caller';
		pm.spawn({
			sessionId: 'agent-2',
			toolType: 'claude-code',
			cwd: '/tmp',
			command: 'claude',
			args: [],
			customEnvVars: { [OVERRIDE_ENV]: callerSocket },
		});

		expect(captured.child).toHaveLength(1);
		const forwarded = captured.child[0];
		// Caller's customEnvVars are spread last, so the caller value wins.
		expect(forwarded.customEnvVars?.[OVERRIDE_ENV]).toBe(callerSocket);
		expect(forwarded.customEnvVars?.[OVERRIDE_ENV]).not.toBe(SENTINEL_SOCKET);
	});
});

interface FakeProcess {
	env: Record<string, string | undefined>;
}
// new Function() is untyped; name the callable contract we expect it to satisfy.
type SocketResolver = (proc: FakeProcess) => string | undefined;

describe('getCoworkingServerScript socket precedence', () => {
	it('resolves the socket preferring the override env over the config env', () => {
		const script = getCoworkingServerScript();

		// Pull the exact SOCKET_PATH assignment expression out of the generated
		// script and evaluate IT (not a reimplementation) under controlled envs.
		// This exercises the real precedence rule in the emitted artifact, so a
		// flipped `||` order reddens the first assertion.
		const match = script.match(/const SOCKET_PATH\s*=\s*([\s\S]*?);/);
		expect(match, 'SOCKET_PATH assignment not found in generated script').not.toBeNull();

		const resolveExpr = match![1];
		const resolve = new Function('process', `return (${resolveExpr});`) as SocketResolver;

		// Override present alongside config → override wins.
		expect(resolve({ env: { [OVERRIDE_ENV]: 'ov-sock', [CONFIG_ENV]: 'cfg-sock' } })).toBe(
			'ov-sock'
		);
		// Only the config socket present → falls back to it.
		expect(resolve({ env: { [CONFIG_ENV]: 'cfg-sock' } })).toBe('cfg-sock');
		// Only the override present → uses it.
		expect(resolve({ env: { [OVERRIDE_ENV]: 'ov-sock' } })).toBe('ov-sock');
	});

	it('guards the exact override-first precedence line in the generated script', () => {
		// Content guard on the codegen artifact: the override MUST be the left
		// operand of `||` so it is preferred over the shared config socket.
		expect(getCoworkingServerScript()).toContain(
			'process.env.MAESTRO_COWORKING_SOCKET_OVERRIDE || process.env.MAESTRO_COWORKING_SOCKET'
		);
	});
});
