/**
 * Tests for src/main/process-manager/spawners/ChildProcessSpawner.ts
 *
 * These tests verify the isStreamJsonMode detection logic which determines
 * whether output should be processed as JSON lines or raw text.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import * as nodeFs from 'fs';
import * as nodeOs from 'os';
import * as nodePath from 'path';
import { existsSync, readFileSync, unlinkSync } from 'fs';

// ── Mocks ──────────────────────────────────────────────────────────────────

// Create mock spawn function at module level (before vi.mock hoisting)
const mockSpawn = vi.fn();

// Track created managed processes for verification
let mockChildProcess: any;

function createMockChildProcess() {
	return {
		pid: 12345,
		stdout: Object.assign(new EventEmitter(), { setEncoding: vi.fn(), destroy: vi.fn() }),
		stderr: Object.assign(new EventEmitter(), { setEncoding: vi.fn(), destroy: vi.fn() }),
		stdin: { write: vi.fn(), end: vi.fn(), on: vi.fn() },
		on: vi.fn(),
		unref: vi.fn(),
		killed: false,
		exitCode: null,
	};
}

// Mock child_process before imports - wrap in function to avoid hoisting issues
vi.mock('fs', async (importOriginal) => {
	const actual = await importOriginal<typeof import('fs')>();
	return { ...actual, writeFileSync: vi.fn() };
});

vi.mock('child_process', async (importOriginal) => {
	const actual = await importOriginal<typeof import('child_process')>();
	return {
		...actual,
		spawn: (...args: unknown[]) => mockSpawn(...args),
		default: {
			...actual,
			spawn: (...args: unknown[]) => mockSpawn(...args),
		},
	};
});

vi.mock('../../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

vi.mock('../../../../main/parsers', () => ({
	createOutputParser: vi.fn(() => ({
		agentId: 'claude-code',
		parseJsonLine: vi.fn(),
		extractUsage: vi.fn(),
		extractSessionId: vi.fn(),
		extractSlashCommands: vi.fn(),
		isResultMessage: vi.fn(),
		detectErrorFromLine: vi.fn(),
		detectErrorFromExit: vi.fn(() => null),
	})),
}));

vi.mock('../../../../main/agents', () => ({
	getAgentCapabilities: vi.fn(() => ({
		supportsStreamJsonInput: true,
	})),
}));

vi.mock('../../../../main/process-manager/utils/envBuilder', () => ({
	buildChildProcessEnv: vi.fn(() => ({ PATH: '/usr/bin' })),
	collectMaestroEnvVars: vi.fn(() => ({})),
}));

vi.mock('../../../../main/process-manager/utils/imageUtils', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../../main/process-manager/utils/imageUtils')>()),
	saveImageToTempFile: vi.fn(),
	savePromptToTempFile: vi.fn(() => 'C:\\tmp\\maestro-prompt-1.md'),
	cleanupTempFiles: vi.fn(),
	buildImagePromptPrefix: vi.fn((paths: string[]) => {
		if (paths.length === 0) return '';
		return `[Attached images: ${paths.join(', ')}]\n\n`;
	}),
}));

vi.mock('../../../../main/process-manager/utils/streamJsonBuilder', () => ({
	buildStreamJsonMessage: vi.fn(() => '{"type":"message"}'),
}));

vi.mock('../../../../main/process-manager/utils/shellEscape', () => ({
	escapeArgsForShell: vi.fn((args) => args),
	isPowerShellShell: vi.fn(() => false),
}));

// Default to non-Windows; individual tests opt into Windows via mockReturnValue(true).
vi.mock('../../../../shared/platformDetection', () => ({
	isWindows: vi.fn(() => false),
	isMacOS: vi.fn(() => false),
	isLinux: vi.fn(() => false),
}));

// ── Imports (after mocks) ──────────────────────────────────────────────────

import { ChildProcessSpawner } from '../../../../main/process-manager/spawners/ChildProcessSpawner';
import type { ManagedProcess, ProcessConfig } from '../../../../main/process-manager/types';
import { getAgentCapabilities } from '../../../../main/agents';
import { buildChildProcessEnv } from '../../../../main/process-manager/utils/envBuilder';
import { buildStreamJsonMessage } from '../../../../main/process-manager/utils/streamJsonBuilder';
import {
	saveImageToTempFile,
	savePromptToTempFile,
	cleanupTempFiles,
} from '../../../../main/process-manager/utils/imageUtils';
import * as fs from 'fs';
import { ProcessManager } from '../../../../main/process-manager/ProcessManager';

vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('../../../../main/process-manager/utils/spawnCwd', () => ({
	unusableCwdReason: () => null,
}));
vi.mock('../../../../main/process-manager/utils/childProcessInfo', () => ({
	isPidAlive: vi.fn(() => false),
}));
vi.mock('../../../../main/coworking/coworking-socket-path', () => ({
	getBridgeSocketPath: () => '/tmp/maestro-test-coworking.sock',
}));
import { isPidAlive } from '../../../../main/process-manager/utils/childProcessInfo';
import { createOutputParser } from '../../../../main/parsers';
import { isWindows } from '../../../../shared/platformDetection';
import { getAgentDefinition } from '../../../../main/agents/definitions';
import { getAgentCapabilities as getRealAgentCapabilities } from '../../../../main/agents/capabilities';
import { logger } from '../../../../main/utils/logger';
import * as copilotShutdownWaiter from '../../../../main/process-manager/CopilotShutdownWaiter';
import * as supervisor from '../../../../shared/maestro-lib/control/agent-process-supervisor';
import {
	CODEX_STARTUP_TIMEOUT_MS,
	HEADLESS_IDLE_PROFILE,
} from '../../../../shared/plugins/headless-agent-timeouts';
import * as turnRunner from '../../../../shared/maestro-lib/run/start-turn';
import * as agentDefinitions from '../../../../main/agents/definitions';
import * as sentry from '../../../../main/utils/sentry';
import { POSIX_PROMPT_ARGV_MAX_BYTES } from '../../../../shared/maestro-lib/launch/prompt-delivery';
import { __resetPendingRemoteReapsForTest } from '../../../../main/utils/ssh-remote-signal';
// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * The child's event handlers by name, keeping the FIRST registration of each.
 * `close` and `exit` also get listeners from the stdio watchdog, registered
 * after the spawner's own, and a plain Map would keep those instead.
 */
function childHandlers(child: { on: { mock: { calls: unknown[][] } } }): Map<string, Function> {
	const handlers = new Map<string, Function>();
	for (const [event, fn] of child.on.mock.calls as [string, Function][]) {
		if (!handlers.has(event)) handlers.set(event, fn);
	}
	return handlers;
}

function createTestContext() {
	const processes = new Map<string, ManagedProcess>();
	const emitter = new EventEmitter();
	const bufferManager = {
		emitDataBuffered: vi.fn(),
		flushDataBuffer: vi.fn(),
	};

	const spawner = new ChildProcessSpawner(processes, emitter, bufferManager as any);

	return { processes, emitter, bufferManager, spawner };
}

function createBaseConfig(overrides: Partial<ProcessConfig> = {}): ProcessConfig {
	return {
		sessionId: 'test-session',
		toolType: 'claude-code',
		cwd: '/tmp/test',
		command: 'claude',
		args: ['--print'],
		...overrides,
	};
}

async function useRealPromptFiles(): Promise<void> {
	const [actualUtils, actualFs] = await Promise.all([
		vi.importActual('../../../../main/process-manager/utils/imageUtils'),
		vi.importActual('fs'),
	]);
	vi.mocked(savePromptToTempFile).mockImplementation(actualUtils.savePromptToTempFile);
	vi.mocked(fs.writeFileSync).mockImplementation(actualFs.writeFileSync);
	vi.mocked(cleanupTempFiles).mockImplementation(actualUtils.cleanupTempFiles);
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('ChildProcessSpawner', () => {
	describe('ProcessManager stale-entry cleanup', () => {
		it('cleans predecessor temp files before replacing a stale agent without close callbacks', () => {
			vi.mocked(isPidAlive).mockReturnValue(false);
			const manager = new ProcessManager();
			manager.spawn(createBaseConfig({ prompt: 'first turn' }));
			const predecessor = manager.get('test-session')!;
			predecessor.tempFiles = ['/tmp/old-image.png', '/tmp/old-prompt.md'];
			vi.mocked(cleanupTempFiles).mockImplementationOnce((files) => {
				expect(files).toEqual(['/tmp/old-image.png', '/tmp/old-prompt.md']);
				expect(mockSpawn).toHaveBeenCalledTimes(1);
			});
			manager.spawn(createBaseConfig({ prompt: 'second turn' }));
			expect(cleanupTempFiles).toHaveBeenCalledExactlyOnceWith([
				'/tmp/old-image.png',
				'/tmp/old-prompt.md',
			]);
			expect(manager.get('test-session')).not.toBe(predecessor);
			const successor = manager.get('test-session')!;
			successor.tempFiles = ['/tmp/new-prompt.md'];
			const close = (predecessor.childProcess!.on as ReturnType<typeof vi.fn>).mock.calls.find(
				([event]) => event === 'close'
			)![1];
			close(0);
			expect(cleanupTempFiles).toHaveBeenCalledTimes(1);
			expect(successor.tempFiles).toEqual(['/tmp/new-prompt.md']);
		});
	});

	describe('prompt temp file creation', () => {
		it('creates distinct exclusive image files for sessions sharing a timestamp and image index', async () => {
			const actual = await vi.importActual<
				typeof import('../../../../main/process-manager/utils/imageUtils')
			>('../../../../main/process-manager/utils/imageUtils');
			const write = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
			vi.spyOn(Date, 'now').mockReturnValue(123456);
			try {
				const first = actual.saveImageToTempFile('data:image/png;base64,YQ==', 0);
				const second = actual.saveImageToTempFile('data:image/png;base64,Yg==', 0);
				expect(first).not.toBeNull();
				expect(second).not.toBe(first);
				expect(write).toHaveBeenCalledWith(first, Buffer.from('a'), { mode: 0o600, flag: 'wx' });
				expect(write).toHaveBeenCalledWith(second, Buffer.from('b'), { mode: 0o600, flag: 'wx' });
			} finally {
				vi.restoreAllMocks();
			}
		});

		it('creates distinct exclusive files for consecutive prompts in the same millisecond', async () => {
			const actual = await vi.importActual<
				typeof import('../../../../main/process-manager/utils/imageUtils')
			>('../../../../main/process-manager/utils/imageUtils');
			const write = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
			vi.spyOn(Date, 'now').mockReturnValue(123456);
			try {
				const first = actual.savePromptToTempFile('first');
				const second = actual.savePromptToTempFile('second');
				expect(first).not.toBeNull();
				expect(second).not.toBe(first);
				expect(write).toHaveBeenCalledWith(first, 'first', {
					encoding: 'utf8',
					mode: 0o600,
					flag: 'wx',
				});
				expect(write).toHaveBeenCalledWith(second, 'second', {
					encoding: 'utf8',
					mode: 0o600,
					flag: 'wx',
				});
			} finally {
				vi.restoreAllMocks();
			}
		});

		it('retries an exclusive prompt-file collision without overwriting the existing file', async () => {
			const actual = await vi.importActual<
				typeof import('../../../../main/process-manager/utils/imageUtils')
			>('../../../../main/process-manager/utils/imageUtils');
			const write = vi
				.spyOn(fs, 'writeFileSync')
				.mockImplementationOnce(() => {
					throw Object.assign(new Error('exists'), { code: 'EEXIST' });
				})
				.mockImplementation(() => undefined);
			try {
				const file = actual.savePromptToTempFile('prompt');
				expect(file).not.toBeNull();
				expect(write).toHaveBeenCalledTimes(2);
				expect(write.mock.calls[0][0]).not.toBe(write.mock.calls[1][0]);
				expect(write.mock.calls[1]).toEqual([
					file,
					'prompt',
					{
						encoding: 'utf8',
						mode: 0o600,
						flag: 'wx',
					},
				]);
			} finally {
				vi.restoreAllMocks();
			}
		});
	});

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(savePromptToTempFile).mockReturnValue('C:\\tmp\\maestro-prompt-1.md');
		vi.mocked(fs.writeFileSync).mockImplementation(() => undefined);
		vi.mocked(cleanupTempFiles).mockImplementation(() => undefined);
		// Setup mock spawn to return a fresh mock child process
		mockSpawn.mockImplementation(() => {
			mockChildProcess = createMockChildProcess();
			return mockChildProcess;
		});
	});

	it.each([
		{ args: ['exec'], prompt: 'prompt' },
		{ args: [], sshStdinScript: 'script' },
	])('uses startup and idle budgets without a desktop Codex lifetime ceiling', (config) => {
		vi.useFakeTimers();
		const spy = vi.spyOn(supervisor, 'superviseAgentProcess');
		try {
			const { spawner } = createTestContext();
			expect(
				spawner.spawn(createBaseConfig({ toolType: 'codex', command: 'codex', ...config })).success
			).toBe(true);
			expect(spy).toHaveBeenCalledOnce();
			expect(spy.mock.calls[0][1]).toMatchObject({
				startupMs: CODEX_STARTUP_TIMEOUT_MS,
				idle: HEADLESS_IDLE_PROFILE,
			});
			expect(spy.mock.calls[0][1].timeoutMs).toBeUndefined();
		} finally {
			spy.mock.results[0]?.value?.dispose();
			spy.mockRestore();
			vi.useRealTimers();
		}
	});

	describe('isStreamJsonMode detection', () => {
		it('should enable stream-json mode when args contain "stream-json"', () => {
			const { processes, spawner } = createTestContext();

			spawner.spawn(
				createBaseConfig({
					args: ['--output-format', 'stream-json'],
				})
			);

			const proc = processes.get('test-session');
			expect(proc?.isStreamJsonMode).toBe(true);
		});

		it('should enable stream-json mode when args contain "--json"', () => {
			const { processes, spawner } = createTestContext();

			spawner.spawn(
				createBaseConfig({
					args: ['--json'],
				})
			);

			const proc = processes.get('test-session');
			expect(proc?.isStreamJsonMode).toBe(true);
		});

		it('should enable stream-json mode when args contain "--format" and "json"', () => {
			const { processes, spawner } = createTestContext();

			spawner.spawn(
				createBaseConfig({
					args: ['--format', 'json'],
				})
			);

			const proc = processes.get('test-session');
			expect(proc?.isStreamJsonMode).toBe(true);
		});

		it('should enable stream-json mode when args contain "--output-format" and "json"', () => {
			const { processes, spawner } = createTestContext();

			spawner.spawn(
				createBaseConfig({
					toolType: 'copilot-cli',
					command: 'copilot',
					args: ['--output-format', 'json'],
					prompt: 'test prompt',
				})
			);

			const proc = processes.get('test-session');
			expect(proc?.isStreamJsonMode).toBe(true);
			expect(proc?.isBatchMode).toBe(true);
		});

		it('treats --resume=<id> as a resumed session when building env', () => {
			const { spawner } = createTestContext();

			spawner.spawn(
				createBaseConfig({
					toolType: 'copilot-cli',
					command: 'copilot',
					args: ['--output-format', 'json', '--resume=session-123'],
					prompt: 'continue',
				})
			);

			expect(buildChildProcessEnv).toHaveBeenCalledWith(
				undefined,
				true,
				undefined,
				undefined,
				// querySource, threaded through so downstream tooling can tell an
				// interactive turn from an automated one. Unset on this config.
				undefined
			);
		});

		it('should enable stream-json mode when sendPromptViaStdin is true', () => {
			const { processes, spawner } = createTestContext();

			spawner.spawn(
				createBaseConfig({
					args: ['--print'],
					sendPromptViaStdin: true,
					prompt: 'test prompt',
				})
			);

			const proc = processes.get('test-session');
			expect(proc?.isStreamJsonMode).toBe(true);
		});

		it('should NOT enable stream-json mode when sendPromptViaStdinRaw is true (no parser)', () => {
			const { processes, spawner } = createTestContext();

			// sendPromptViaStdinRaw sends RAW text via stdin, not JSON
			// So it should NOT set isStreamJsonMode (which is for JSON streaming).
			// Override the parser mock to simulate an agent without a parser.
			vi.mocked(createOutputParser).mockReturnValueOnce(null);

			spawner.spawn(
				createBaseConfig({
					toolType: 'terminal',
					command: 'bash',
					args: [],
					sendPromptViaStdinRaw: true,
					prompt: 'test prompt',
				})
			);

			const proc = processes.get('test-session');
			expect(proc?.isStreamJsonMode).toBe(false);
		});

		it('should enable stream-json mode when sshStdinScript is provided', () => {
			const { processes, spawner } = createTestContext();

			// SSH sessions pass a script via stdin - this should trigger stream-json mode
			// even though the args (SSH args) don't contain 'stream-json'
			spawner.spawn(
				createBaseConfig({
					args: ['-o', 'BatchMode=yes', 'user@host', '/bin/bash'],
					sshStdinScript: 'export PATH="$HOME/.local/bin:$PATH"\ncd /project\nexec claude --print',
				})
			);

			const proc = processes.get('test-session');
			expect(proc?.isStreamJsonMode).toBe(true);
		});

		it('should NOT enable stream-json mode for plain args without JSON flags (no parser)', () => {
			const { processes, spawner } = createTestContext();

			// An agent with a parser (e.g. claude-code) now enables stream-json mode
			// by parser presence alone. Override the mock to simulate no parser.
			vi.mocked(createOutputParser).mockReturnValueOnce(null);

			spawner.spawn(
				createBaseConfig({
					toolType: 'terminal',
					command: 'bash',
					args: ['-l'],
				})
			);

			const proc = processes.get('test-session');
			expect(proc?.isStreamJsonMode).toBe(false);
		});

		it('should enable stream-json mode when images are provided with prompt', () => {
			const { processes, spawner } = createTestContext();

			spawner.spawn(
				createBaseConfig({
					args: ['--print'],
					images: ['data:image/png;base64,abc123'],
					prompt: 'describe this image',
				})
			);

			const proc = processes.get('test-session');
			expect(proc?.isStreamJsonMode).toBe(true);
		});
	});

	describe('isBatchMode detection', () => {
		it('should enable batch mode when prompt is provided', () => {
			const { processes, spawner } = createTestContext();

			spawner.spawn(
				createBaseConfig({
					prompt: 'test prompt',
				})
			);

			const proc = processes.get('test-session');
			expect(proc?.isBatchMode).toBe(true);
		});

		it('should NOT enable batch mode when no prompt is provided', () => {
			const { processes, spawner } = createTestContext();

			spawner.spawn(
				createBaseConfig({
					prompt: undefined,
				})
			);

			const proc = processes.get('test-session');
			expect(proc?.isBatchMode).toBe(false);
		});
	});

	// MAESTRO-153: a wizard prompt carrying a NUL byte made Node refuse the spawn
	// ("The argument 'args[4]' must be a string without null bytes").
	describe('NUL bytes in arguments', () => {
		it('drops them from the prompt and every other argument before spawning', () => {
			const { spawner } = createTestContext();

			const result = spawner.spawn(
				createBaseConfig({
					args: ['--print', '--append-system-prompt', 'sys\0tem'],
					prompt: 'Conductor\0 Profile\0',
				})
			);

			expect(result.success).toBe(true);
			const spawnedArgs = mockSpawn.mock.calls[0][1] as string[];
			expect(spawnedArgs.some((arg) => arg.includes('\0'))).toBe(false);
			expect(spawnedArgs).toContain('system');
			expect(spawnedArgs).toContain('Conductor Profile');
		});

		it('leaves arguments without NUL bytes untouched', () => {
			const { spawner } = createTestContext();

			spawner.spawn(createBaseConfig({ args: ['--print'], prompt: 'plain' }));

			expect(mockSpawn.mock.calls[0][1]).toEqual(['--print', '--', 'plain']);
		});
	});

	describe('prompt too long for argv on Linux/macOS (MAESTRO-VR)', () => {
		const longPrompt = 'x'.repeat(POSIX_PROMPT_ARGV_MAX_BYTES + 1);
		const stdinCapable = { supportsStreamJsonInput: false, supportsPromptViaStdin: true } as any;

		it('sends a prompt past the limit over stdin instead of argv', () => {
			vi.mocked(getAgentCapabilities).mockReturnValueOnce(stdinCapable);
			const { spawner } = createTestContext();

			const result = spawner.spawn(createBaseConfig({ prompt: longPrompt }));

			expect(result.success).toBe(true);
			const spawnedArgs = mockSpawn.mock.calls[0][1] as string[];
			expect(spawnedArgs).toEqual(['--print']);
			// The run layer writes stdin with a completion callback.
			expect(mockChildProcess.stdin.write).toHaveBeenCalledWith(longPrompt, expect.any(Function));
			expect(mockChildProcess.stdin.end).toHaveBeenCalled();
		});

		it('keeps a prompt under the limit in argv', () => {
			vi.mocked(getAgentCapabilities).mockReturnValueOnce(stdinCapable);
			const { spawner } = createTestContext();

			spawner.spawn(createBaseConfig({ prompt: 'short' }));

			expect(mockSpawn.mock.calls[0][1]).toEqual(['--print', '--', 'short']);
			expect(mockChildProcess.stdin.write).not.toHaveBeenCalled();
		});

		it('keeps the prompt in argv for an agent that does not read stdin', () => {
			vi.mocked(getAgentCapabilities).mockReturnValueOnce({
				supportsStreamJsonInput: false,
				supportsPromptViaStdin: false,
			} as any);
			const { spawner } = createTestContext();

			spawner.spawn(createBaseConfig({ toolType: 'omp', command: 'omp', prompt: longPrompt }));

			expect(mockSpawn.mock.calls[0][1]).toEqual(['--print', '--', longPrompt]);
			expect(mockChildProcess.stdin.write).not.toHaveBeenCalled();
		});

		it('leaves an SSH spawn alone', () => {
			vi.mocked(getAgentCapabilities).mockReturnValueOnce(stdinCapable);
			const { spawner } = createTestContext();

			spawner.spawn(
				createBaseConfig({ command: 'ssh', prompt: longPrompt, sshRemoteId: 'remote-1' })
			);

			expect(mockSpawn.mock.calls[0][1]).toEqual(['--print', '--', longPrompt]);
			expect(mockChildProcess.stdin.write).not.toHaveBeenCalled();
		});

		it('leaves Windows to the callers, which already pick stdin there', () => {
			vi.mocked(isWindows).mockReturnValue(true);
			try {
				vi.mocked(getAgentCapabilities).mockReturnValueOnce(stdinCapable);
				const { spawner } = createTestContext();

				spawner.spawn(createBaseConfig({ command: 'claude.exe', prompt: longPrompt }));

				expect(mockChildProcess.stdin.write).not.toHaveBeenCalled();
			} finally {
				vi.mocked(isWindows).mockReturnValue(false);
			}
		});
	});

	describe('SSH remote context', () => {
		it('should store sshRemoteId on managed process', () => {
			const { processes, spawner } = createTestContext();

			spawner.spawn(
				createBaseConfig({
					sshRemoteId: 'my-remote-server',
					sshRemoteHost: 'dev.example.com',
					sshStdinScript: 'exec claude',
				})
			);

			const proc = processes.get('test-session');
			expect(proc?.sshRemoteId).toBe('my-remote-server');
			expect(proc?.sshRemoteHost).toBe('dev.example.com');
		});

		// Stop over SSH used to signal only the local ssh client, leaving the remote
		// agent running. The launch script records the remote pid so Stop can reach it.
		it('records the remote agent pid ahead of a stdin launch script', () => {
			const { processes, spawner } = createTestContext();

			spawner.spawn(
				createBaseConfig({
					command: '/usr/bin/ssh',
					args: ['-o', 'BatchMode=yes', 'user@host', '/bin/bash', '--norc', '--noprofile', '-s'],
					sshStdinScript: 'cd /project\nexec claude --print\n',
				})
			);

			const pidFile = processes.get('test-session')?.sshRemotePidFile;
			expect(pidFile).toMatch(/^\/tmp\/maestro-agent-[0-9a-f-]+\.pid$/);
			const written = mockChildProcess.stdin.write.mock.calls[0][0] as string;
			expect(written).toContain(`printf '%s %s\\n' "$$"`);
			expect(written).toContain(pidFile);
			expect(written.endsWith('cd /project\nexec claude --print\n')).toBe(true);
		});

		it('records nothing when the args are not a stdin-script ssh invocation', () => {
			const { processes, spawner } = createTestContext();

			spawner.spawn(
				createBaseConfig({
					args: ['-o', 'BatchMode=yes', 'user@host', '/bin/bash'],
					sshStdinScript: 'exec claude',
				})
			);

			expect(processes.get('test-session')?.sshRemotePidFile).toBeUndefined();
			expect(mockChildProcess.stdin.write.mock.calls[0][0]).toBe('exec claude');
		});

		describe('remote prompt-file owner handoff', () => {
			const artifact: NonNullable<ProcessConfig['promptArtifact']> = {
				owner: 'remote',
				sshRemoteId: 'synthetic-grok-remote',
				path: '/tmp/maestro-prompt-private-10e1.json',
				content: 'private-body-10e1: 雪\nsecond line',
				encoding: 'utf8',
				mode: 0o600,
				flag: 'wx',
				cleanup: 'turn',
			};
			const config = createBaseConfig({
				toolType: 'grok',
				command: '/usr/bin/ssh',
				args: ['-o', 'BatchMode=yes', 'user@host', '/bin/bash', '--norc', '--noprofile', '-s'],
				sshRemoteId: artifact.sshRemoteId,
				sshStdinScript: 'private-script-10e1\nexec /remote/bin/grok\n',
				// Direct callers may bypass the SSH builder's display redaction.
				sshRemoteCommand: `grok --prompt-file ${artifact.path} ${artifact.content}`,
				promptArtifact: artifact,
			});

			it.each(['', artifact.content])(
				'binds one remote owner without local materialization (%j)',
				(content) => {
					const { processes, spawner } = createTestContext();
					const start = vi.spyOn(turnRunner, 'startTurn');
					try {
						const result = spawner.spawn({ ...config, promptArtifact: { ...artifact, content } });
						expect(result.success).toBe(true);
						expect(mockSpawn).toHaveBeenCalledTimes(1);
						expect(start).toHaveBeenCalledTimes(1);
						const spec = start.mock.calls[0][0];
						expect(spec).not.toHaveProperty('promptArtifact');
						expect(spec.args).toEqual(config.args);
						const proc = processes.get(config.sessionId)!;
						expect(processes.size).toBe(1);
						expect(proc.sshRemotePromptArtifactPath).toBe(artifact.path);
						expect(proc.sshRemotePidFile).toMatch(
							/^\/tmp\/maestro-prompt-owner-[0-9a-f-]{36}\.pid$/
						);
						const script = mockChildProcess.stdin.write.mock.calls[0][0] as string;
						expect(script).toBe(spec.stdin);
						expect(script).toContain(`readonly _maestro_prompt_path='${artifact.path}'`);
						expect(script).toContain(
							`readonly _maestro_prompt_pid_file='${proc.sshRemotePidFile}'`
						);
						expect(script.match(/readonly _maestro_prompt_pid_file=/g)).toHaveLength(1);
						expect(script).not.toContain('maestro-agent-');
						expect(script).toContain(config.sshStdinScript);
						expect(mockChildProcess.stdin.end).toHaveBeenCalledTimes(1);
						expect(proc.args).toEqual(config.args);
						expect(proc.sshRemoteCommand).toBeUndefined();
						expect(proc).not.toHaveProperty('promptArtifact');
						expect(proc).not.toHaveProperty('sshStdinScript');
						expect(proc.tempFiles).toBeUndefined();
						expect(saveImageToTempFile).not.toHaveBeenCalled();
						mockChildProcess.stderr.emit(
							'error',
							new Error(`${artifact.path} ${artifact.content}`)
						);
						expect(logger.error).toHaveBeenCalledWith(
							'[ProcessManager] stderr error',
							'ProcessManager',
							{ sessionId: config.sessionId, error: 'Prompt-file process stderr failed.' }
						);
						const diagnostic = JSON.stringify([
							result,
							proc.command,
							proc.args,
							proc.maestroEnvVars,
							proc.sshRemoteCommand,
							vi.mocked(logger.debug).mock.calls,
							vi.mocked(logger.info).mock.calls,
							vi.mocked(logger.warn).mock.calls,
							vi.mocked(logger.error).mock.calls,
						]);
						for (const privateText of [artifact.path, 'private-body-10e1', 'private-script-10e1']) {
							expect(diagnostic).not.toContain(privateText);
						}
					} finally {
						start.mockRestore();
					}
				}
			);

			it('uses the same private owner when SSH closes nonzero', async () => {
				const { processes, spawner } = createTestContext();
				spawner.spawn(config);
				const proc = processes.get(config.sessionId)!;
				childHandlers(mockChildProcess).get('close')?.(255, null);
				await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(2));
				const cleanup = mockChildProcess.stdin.end.mock.calls[0][0] as string;
				expect(cleanup).toContain(`f='${proc.sshRemotePidFile}'; a='${artifact.path}'`);
				expect(cleanup).toContain('kill -TERM');
				expect(cleanup).not.toContain('private-body-10e1');
				expect(cleanup).not.toContain('private-script-10e1');
				expect(mockSpawn.mock.calls[1][1]).toContain('user@host');
				childHandlers(mockChildProcess).get('exit')?.(0);
			});

			it('refuses a remote artifact bound to another host without spawning or exposing it', () => {
				const { processes, spawner } = createTestContext();
				expect(spawner.spawn({ ...config, sshRemoteId: 'different-remote' })).toEqual({
					pid: -1,
					success: false,
					error: 'Prompt-file delivery does not match its host plan.',
				});
				expect(mockSpawn).not.toHaveBeenCalled();
				expect(processes.size).toBe(0);
			});

			it('preserves ordinary SSH command display and the legacy PID namespace', () => {
				const { processes, spawner } = createTestContext();
				spawner.spawn({
					...config,
					toolType: 'codex',
					promptArtifact: undefined,
					sshStdinScript: 'exec codex exec --json\n',
					sshRemoteCommand: 'codex exec --json',
				});
				const proc = processes.get(config.sessionId)!;
				expect(proc.sshRemoteCommand).toBe('codex exec --json');
				expect(proc.sshRemotePromptArtifactPath).toBeUndefined();
				expect(proc.sshRemotePidFile).toMatch(/^\/tmp\/maestro-agent-[0-9a-f-]{36}\.pid$/);
				expect(mockChildProcess.stdin.write.mock.calls[0][0]).not.toContain('_maestro_prompt_path');
			});
		});

		// 2026-10-15: the local ssh of a Codex turn exited non-zero while Codex
		// kept working on the remote for two more minutes. The turn settled, the
		// synopsis resumed the thread under it, and Codex refused ("already has an
		// active writer"). An unrequested SSH failure now stops the remote agent.
		describe('remote agent after the local ssh client fails', () => {
			const sshConfig = () =>
				createBaseConfig({
					command: '/usr/bin/ssh',
					args: ['-o', 'BatchMode=yes', 'user@host', '/bin/bash', '--norc', '--noprofile', '-s'],
					sshStdinScript: 'exec codex exec --json\n',
				});

			function closeWith(code: number | null, signal: string | null = null) {
				childHandlers(mockChildProcess).get('close')?.(code, signal);
			}

			afterEach(() => {
				__resetPendingRemoteReapsForTest();
			});

			it('terminates the remote agent when ssh exits non-zero on its own', async () => {
				const { processes, spawner } = createTestContext();
				spawner.spawn(sshConfig());
				const pidFile = processes.get('test-session')!.sshRemotePidFile!;
				const sshChild = mockChildProcess;

				closeWith(255);

				await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(2));
				const [command, args] = mockSpawn.mock.calls[1] as [string, string[]];
				expect(command).toBe('/usr/bin/ssh');
				expect(args).toContain('user@host');
				const script = mockChildProcess.stdin.end.mock.calls[0][0] as string;
				expect(script).toContain(pidFile);
				expect(script).toContain('TERM');
				expect(mockChildProcess).not.toBe(sshChild);
			});

			// 2026-11-13: pedtome's sshd refused every connection for minutes after a
			// tunnel drop, so the one terminate failed and the orphaned Claude turn
			// committed and deployed while the tab's next send was already going out.
			it("hands an orphan the host refused to stop to the tab's next launch", async () => {
				const { processes, spawner, emitter } = createTestContext();
				const onExit = vi.fn();
				emitter.on('exit', onExit);
				spawner.spawn(sshConfig());
				const orphanPidFile = processes.get('test-session')!.sshRemotePidFile!;

				closeWith(255);
				await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(2));
				// The signal ssh was refused too.
				childHandlers(mockChildProcess).get('exit')?.(255, null);
				await vi.waitFor(() => expect(onExit).toHaveBeenCalled());

				spawner.spawn(sshConfig());
				const nextPidFile = processes.get('test-session')!.sshRemotePidFile!;
				const launch = mockChildProcess.stdin.write.mock.calls[0][0] as string;
				expect(nextPidFile).not.toBe(orphanPidFile);
				expect(launch).toContain('kill -TERM');
				expect(launch.indexOf(orphanPidFile)).toBeGreaterThanOrEqual(0);
				expect(launch.indexOf(orphanPidFile)).toBeLessThan(launch.indexOf(nextPidFile));
				expect(launch.endsWith('exec codex exec --json\n')).toBe(true);

				// Taken once: a third launch carries no reap.
				closeWith(0);
				spawner.spawn(sshConfig());
				const third = mockChildProcess.stdin.write.mock.calls[0][0] as string;
				expect(third).not.toContain(orphanPidFile);
			});

			it('leaves the remote alone after a clean exit', async () => {
				const { spawner, emitter } = createTestContext();
				const onExit = vi.fn();
				emitter.on('exit', onExit);
				spawner.spawn(sshConfig());

				closeWith(0);

				await vi.waitFor(() => expect(onExit).toHaveBeenCalled());
				expect(mockSpawn).toHaveBeenCalledTimes(1);
			});

			it('leaves the remote to the Stop path when the user interrupted', async () => {
				const { processes, spawner, emitter } = createTestContext();
				const onExit = vi.fn();
				emitter.on('exit', onExit);
				spawner.spawn(sshConfig());
				processes.get('test-session')!.interrupted = true;

				closeWith(130);

				await vi.waitFor(() => expect(onExit).toHaveBeenCalled());
				expect(mockSpawn).toHaveBeenCalledTimes(1);
			});
		});
	});

	describe('local prompt-file sink', () => {
		const artifact: NonNullable<ProcessConfig['promptArtifact']> = {
			owner: 'local',
			path: nodePath.join(nodeOs.tmpdir(), 'maestro-prompt-synthetic-10et.json'),
			content: JSON.stringify([{ type: 'text', text: '雪\nprivate-turn-10et' }]),
			encoding: 'utf8',
			mode: 0o600,
			flag: 'wx',
			cleanup: 'turn',
		};
		const config = createBaseConfig({
			toolType: 'grok',
			command: nodePath.join(nodeOs.tmpdir(), 'synthetic-grok.exe'),
			args: ['--output-format', 'streaming-json', '--prompt-file', artifact.path],
			promptArtifact: artifact,
		});

		beforeEach(() => {
			// The production Grok file route remains inactive; opt in only this fixture.
			const definition = getAgentDefinition('grok')!;
			vi.spyOn(agentDefinitions, 'getAgentDefinition').mockReturnValue({
				...definition,
				promptFileArgs: (file) => ['--prompt-file', file],
			});
			vi.spyOn(nodeFs, 'openSync').mockReturnValue(41);
			vi.spyOn(nodeFs, 'writeFileSync').mockImplementation(() => {});
			vi.spyOn(nodeFs, 'fstatSync').mockReturnValue({ dev: 1, ino: 41 } as nodeFs.Stats);
			vi.spyOn(nodeFs, 'lstatSync').mockReturnValue({ dev: 1, ino: 41 } as nodeFs.Stats);
			vi.spyOn(nodeFs, 'unlinkSync').mockImplementation(() => {});
			vi.spyOn(nodeFs, 'closeSync').mockImplementation(() => {});
			vi.spyOn(sentry, 'captureException').mockResolvedValue();
		});
		afterEach(() => {
			vi.restoreAllMocks();
			vi.mocked(isWindows).mockReturnValue(false);
		});

		it.each([
			{ name: 'empty', windows: false, content: '' },
			{ name: 'Unicode', windows: false, content: artifact.content },
			{
				name: 'large Windows input',
				windows: true,
				content: JSON.stringify([{ type: 'text', text: '雪\n'.repeat(50000) }]),
			},
		])(
			'delivers $name exactly once despite competing legacy options',
			async ({ windows, content }) => {
				vi.mocked(isWindows).mockReturnValue(windows);
				const { spawner, processes } = createTestContext();
				const imageArgs = vi.fn(() => ['--legacy-image']);
				const imagePromptBuilder = vi.fn(() => 'legacy-image-prefix');
				const promptArgs = vi.fn(() => ['--single']);
				expect(
					spawner.spawn({
						...config,
						promptArtifact: { ...artifact, content },
						prompt: 'obsolete raw prompt',
						images: ['data:image/png;base64,c3ludGhldGlj'],
						imageArgs,
						imagePromptBuilder,
						promptArgs,
						sendPromptViaStdin: true,
						sendPromptViaStdinRaw: true,
					})
				).toMatchObject({ success: true });
				expect(nodeFs.openSync).toHaveBeenCalledExactlyOnceWith(artifact.path, 'wx', 0o600);
				expect(nodeFs.writeFileSync).toHaveBeenCalledExactlyOnceWith(41, content, 'utf8');
				expect(mockSpawn).toHaveBeenCalledExactlyOnceWith(
					config.command,
					config.args,
					expect.objectContaining({ shell: false })
				);
				for (const legacy of [
					saveImageToTempFile,
					buildStreamJsonMessage,
					imageArgs,
					imagePromptBuilder,
					promptArgs,
				]) {
					expect(legacy).not.toHaveBeenCalled();
				}
				expect(mockChildProcess.stdin.write).not.toHaveBeenCalled();
				expect(mockChildProcess.stdin.end).toHaveBeenCalledTimes(1);
				expect(processes.get(config.sessionId)).toMatchObject({ isBatchMode: true, args: [] });
				expect(processes.get(config.sessionId)?.tempFiles).toBeUndefined();
				expect(nodeFs.unlinkSync).not.toHaveBeenCalled();
				childHandlers(mockChildProcess).get('close')?.(0, null);
				await vi.waitFor(() => expect(processes.size).toBe(0));
				expect(nodeFs.unlinkSync).toHaveBeenCalledExactlyOnceWith(artifact.path);
				expect(nodeFs.closeSync).toHaveBeenCalledExactlyOnceWith(41);
			}
		);

		it('cleans an owned artifact on synchronous spawn failure using a fixed private diagnostic', () => {
			const { spawner, processes } = createTestContext();
			mockSpawn.mockImplementationOnce(() => {
				throw new Error(`${artifact.path}: ${artifact.content}`);
			});
			expect(spawner.spawn(config)).toEqual({
				pid: -1,
				success: false,
				error: 'Prompt-file process could not be started.',
			});
			expect(nodeFs.unlinkSync).toHaveBeenCalledExactlyOnceWith(artifact.path);
			expect(nodeFs.closeSync).toHaveBeenCalledExactlyOnceWith(41);
			expect(processes.size).toBe(0);
			expect(sentry.captureException).toHaveBeenCalledExactlyOnceWith(
				new Error('Prompt-file process could not be started.')
			);
			expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain(artifact.path);
			expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain('private-turn-10et');
		});

		it.each(['error', 'cancelled'] as const)(
			'cleans a started reader after %s and reports one outcome',
			async (outcome) => {
				const { spawner, processes, emitter } = createTestContext();
				const exit = vi.fn();
				const data = vi.fn();
				const agentError = vi.fn();
				emitter.on('exit', exit);
				emitter.on('data', data);
				emitter.on('agent-error', agentError);
				spawner.spawn(config);
				const handlers = childHandlers(mockChildProcess);
				if (outcome === 'error') {
					// An asynchronous spawn failure never acquired a native process.
					mockChildProcess.pid = undefined;
					handlers.get('error')?.(new Error(`${artifact.path}: ${artifact.content}`));
				} else processes.get(config.sessionId)!.interrupted = true;
				handlers.get('close')?.(
					outcome === 'error' ? -1 : 130,
					outcome === 'cancelled' ? 'SIGINT' : null
				);
				await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(1));
				expect(processes.size).toBe(0);
				expect(nodeFs.unlinkSync).toHaveBeenCalledExactlyOnceWith(artifact.path);
				expect(nodeFs.closeSync).toHaveBeenCalledExactlyOnceWith(41);
				const diagnostics = JSON.stringify([
					exit.mock.calls,
					data.mock.calls,
					agentError.mock.calls,
					vi.mocked(logger.error).mock.calls,
				]);
				expect(diagnostics).not.toContain(artifact.path);
				expect(diagnostics).not.toContain('private-turn-10et');
			}
		);

		it('cleans a superseded reader without touching the successor file or exit', async () => {
			const { spawner, processes, emitter } = createTestContext();
			const exit = vi.fn();
			emitter.on('exit', exit);
			spawner.spawn(config);
			const oldChild = mockChildProcess;
			const nextPath = nodePath.join(nodeOs.tmpdir(), 'maestro-prompt-successor-10et.json');
			vi.mocked(nodeFs.openSync).mockReturnValueOnce(42);
			spawner.spawn({
				...config,
				args: [...config.args.slice(0, -1), nextPath],
				promptArtifact: { ...artifact, path: nextPath },
			});
			const successor = processes.get(config.sessionId);
			childHandlers(oldChild).get('close')?.(143, 'SIGTERM');
			await vi.waitFor(() => expect(nodeFs.closeSync).toHaveBeenCalledExactlyOnceWith(41));
			expect(nodeFs.unlinkSync).toHaveBeenCalledExactlyOnceWith(artifact.path);
			expect(processes.get(config.sessionId)).toBe(successor);
			expect(exit).not.toHaveBeenCalled();
			childHandlers(mockChildProcess).get('close')?.(0, null);
			await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(1));
			expect(nodeFs.unlinkSync).toHaveBeenNthCalledWith(2, nextPath);
			expect(nodeFs.closeSync).toHaveBeenNthCalledWith(2, 42);
		});

		it.each([
			{ sshRemoteId: 'remote-10et' },
			{ sshStdinScript: 'exec remote-grok' },
			{ args: [...config.args, '--single', 'second-source'] },
		])('refuses local artifacts crossing host/argv boundaries (%j)', (overrides) => {
			const { spawner, processes } = createTestContext();
			expect(spawner.spawn({ ...config, ...overrides })).toEqual({
				pid: -1,
				success: false,
				error: 'Prompt-file delivery does not match its host plan.',
			});
			expect(mockSpawn).not.toHaveBeenCalled();
			expect(nodeFs.openSync).not.toHaveBeenCalled();
			expect(processes.size).toBe(0);
		});
	});

	describe('image input-format flag (regression: commit 2d227ed0)', () => {
		// Claude Code's default args always include --output-format stream-json.
		// A prior fix for Windows (2d227ed0) made promptViaStdin true whenever
		// ANY arg contained "stream-json", which prevented --input-format stream-json
		// from being added when sending images. Without that flag, Claude Code treats
		// the JSON+base64 stdin blob as a plain text prompt, blowing the token limit.

		const CLAUDE_DEFAULT_ARGS = [
			'--print',
			'--verbose',
			'--output-format',
			'stream-json',
			'--dangerously-skip-permissions',
		];

		it('should add --input-format stream-json when images are present with default Claude Code args', () => {
			const { spawner } = createTestContext();

			spawner.spawn(
				createBaseConfig({
					args: CLAUDE_DEFAULT_ARGS,
					images: ['data:image/png;base64,abc123'],
					prompt: 'describe this image',
				})
			);

			// Verify --input-format stream-json was added to spawn args
			const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
			expect(spawnArgs).toContain('--input-format');
			const inputFormatIdx = spawnArgs.indexOf('--input-format');
			expect(spawnArgs[inputFormatIdx + 1]).toBe('stream-json');
		});

		it('should add --input-format stream-json even when sendPromptViaStdin is true', () => {
			const { spawner } = createTestContext();

			spawner.spawn(
				createBaseConfig({
					args: CLAUDE_DEFAULT_ARGS,
					images: ['data:image/png;base64,abc123'],
					prompt: 'describe this image',
					sendPromptViaStdin: true,
				})
			);

			const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
			expect(spawnArgs).toContain('--input-format');
			const inputFormatIdx = spawnArgs.indexOf('--input-format');
			expect(spawnArgs[inputFormatIdx + 1]).toBe('stream-json');
		});

		it('should not duplicate --input-format when it is already in args', () => {
			const { spawner } = createTestContext();

			spawner.spawn(
				createBaseConfig({
					args: [...CLAUDE_DEFAULT_ARGS, '--input-format', 'stream-json'],
					images: ['data:image/png;base64,abc123'],
					prompt: 'describe this image',
				})
			);

			const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
			const inputFormatCount = spawnArgs.filter((arg: string) => arg === '--input-format').length;
			expect(inputFormatCount).toBe(1);
		});

		it('should send stream-json message via stdin when images are present', () => {
			const { spawner } = createTestContext();

			spawner.spawn(
				createBaseConfig({
					args: CLAUDE_DEFAULT_ARGS,
					images: ['data:image/png;base64,abc123'],
					prompt: 'describe this image',
				})
			);

			// buildStreamJsonMessage should have been called with prompt and images
			expect(buildStreamJsonMessage).toHaveBeenCalledWith('describe this image', [
				'data:image/png;base64,abc123',
			]);

			// The message should be written to stdin
			expect(mockChildProcess.stdin.write).toHaveBeenCalled();
			expect(mockChildProcess.stdin.end).toHaveBeenCalled();
		});

		it('should send stream-json message via stdin with multiple images', () => {
			const { spawner } = createTestContext();

			const images = [
				'data:image/png;base64,abc123',
				'data:image/jpeg;base64,def456',
				'data:image/webp;base64,ghi789',
			];

			spawner.spawn(
				createBaseConfig({
					args: CLAUDE_DEFAULT_ARGS,
					images,
					prompt: 'compare these images',
				})
			);

			const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
			expect(spawnArgs).toContain('--input-format');
			expect(buildStreamJsonMessage).toHaveBeenCalledWith('compare these images', images);
			expect(mockChildProcess.stdin.write).toHaveBeenCalled();
		});
	});

	describe('promptViaStdin detection', () => {
		// Ensures --output-format stream-json (present in Claude Code default args)
		// does NOT trigger promptViaStdin, while --input-format stream-json does.

		const CLAUDE_DEFAULT_ARGS = [
			'--print',
			'--verbose',
			'--output-format',
			'stream-json',
			'--dangerously-skip-permissions',
		];

		it('should NOT treat --output-format stream-json as promptViaStdin', () => {
			const { spawner } = createTestContext();

			spawner.spawn(
				createBaseConfig({
					args: CLAUDE_DEFAULT_ARGS,
					prompt: 'hello',
				})
			);

			// When promptViaStdin is false, prompt should be appended to args (with --)
			const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
			expect(spawnArgs).toContain('--');
			expect(spawnArgs).toContain('hello');
		});

		it('should treat --input-format stream-json as promptViaStdin', () => {
			const { spawner } = createTestContext();

			spawner.spawn(
				createBaseConfig({
					args: [...CLAUDE_DEFAULT_ARGS, '--input-format', 'stream-json'],
					prompt: 'hello',
				})
			);

			// When promptViaStdin is true, prompt should NOT be appended to args
			const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
			expect(spawnArgs).not.toContain('--');
			expect(spawnArgs).not.toContain('hello');
		});

		it('should treat sendPromptViaStdin as promptViaStdin', () => {
			const { spawner } = createTestContext();

			spawner.spawn(
				createBaseConfig({
					args: CLAUDE_DEFAULT_ARGS,
					prompt: 'hello',
					sendPromptViaStdin: true,
				})
			);

			const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
			expect(spawnArgs).not.toContain('hello');
		});

		it('should treat sendPromptViaStdinRaw as promptViaStdin', () => {
			const { spawner } = createTestContext();

			spawner.spawn(
				createBaseConfig({
					args: CLAUDE_DEFAULT_ARGS,
					prompt: 'hello',
					sendPromptViaStdinRaw: true,
				})
			);

			const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
			expect(spawnArgs).not.toContain('hello');
		});
	});

	describe('stdin write guard for non-stream-json-input agents', () => {
		it('should NOT write stream-json to stdin when prompt is already in CLI args (Codex --json)', () => {
			// Codex uses --json for JSON *output*, not input. The prompt goes as a CLI arg.
			// Without the promptViaStdin guard, isStreamJsonMode (true from --json) would
			// cause the prompt to be double-sent: once in CLI args and once via stdin.
			vi.mocked(getAgentCapabilities).mockReturnValueOnce({
				supportsStreamJsonInput: false,
			} as any);

			const { spawner } = createTestContext();

			spawner.spawn(
				createBaseConfig({
					toolType: 'codex',
					command: 'codex',
					args: ['exec', '--json', '--dangerously-bypass-approvals-and-sandbox'],
					prompt: 'test prompt',
				})
			);

			// Prompt should be in CLI args
			const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
			expect(spawnArgs).toContain('--');
			expect(spawnArgs).toContain('test prompt');

			// stdin should NOT have received the prompt as stream-json
			// buildStreamJsonMessage should NOT have been called
			expect(buildStreamJsonMessage).not.toHaveBeenCalled();
			// stdin.write should only be called for actual stdin delivery, not here
			// stdin.end should be called (to close stdin for batch mode)
			expect(mockChildProcess.stdin.end).toHaveBeenCalled();
		});
	});

	describe('child process event handling', () => {
		it('should listen on "close" event (not "exit") to ensure all stdio data is drained', () => {
			const { spawner } = createTestContext();

			spawner.spawn(createBaseConfig({ prompt: 'test' }));

			// Verify 'close' is registered (ensures all stdout/stderr data is consumed
			// before exit handler runs - fixes data loss for short-lived processes)
			const onCalls = mockChildProcess.on.mock.calls as [string, Function][];
			const eventNames = onCalls.map(([event]) => event);
			expect(eventNames).toContain('close');
		});

		it('does not settle the turn on "exit" alone (that listener only arms the stdio watchdog)', async () => {
			const { spawner, emitter, processes } = createTestContext();
			const config = createBaseConfig({ prompt: 'test' });
			const onExit = vi.fn();
			emitter.on('exit', onExit);

			spawner.spawn(config);
			const exitHandlers = (mockChildProcess.on.mock.calls as [string, Function][])
				.filter(([event]) => event === 'exit')
				.map(([, fn]) => fn);
			exitHandlers.forEach((fn) => fn(0, null));
			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(onExit).not.toHaveBeenCalled();
			expect(processes.has(config.sessionId)).toBe(true);
		});

		it('releases the entry and reports exit when handleExit throws before doing so', async () => {
			const { spawner, emitter, processes } = createTestContext();
			const config = createBaseConfig({ prompt: 'test' });
			const onExit = vi.fn();
			emitter.on('exit', onExit);

			spawner.spawn(config);
			const exitHandler = (spawner as any).exitHandler;
			vi.spyOn(exitHandler, 'handleExit').mockRejectedValueOnce(new Error('boom'));
			const handlers = childHandlers(mockChildProcess);

			handlers.get('close')?.(130);
			await vi.waitFor(() => expect(onExit).toHaveBeenCalledWith(config.sessionId, 130));
			expect(processes.has(config.sessionId)).toBe(false);
		});

		it('should listen for "error" events on the child process', () => {
			const { spawner } = createTestContext();

			spawner.spawn(createBaseConfig({ prompt: 'test' }));

			const onCalls = mockChildProcess.on.mock.calls as [string, Function][];
			const eventNames = onCalls.map(([event]) => event);
			expect(eventNames).toContain('error');
		});
	});

	// Regression (issue #1044): ProcessManager.spawn() kills the process holding a
	// sessionId before registering the replacement under the same key. The killed
	// process drains stdio and fires `close` afterwards, and every downstream
	// handler is keyed by sessionId alone - so those late events used to be
	// attributed to the live successor, surfacing "Agent exited with code 143"
	// (SIGTERM) on a healthy turn and deleting the successor's tracking entry.
	describe('late events from a superseded generation', () => {
		function spawnTwoGenerations() {
			const ctx = createTestContext();
			const config = createBaseConfig({ prompt: 'first turn' });

			ctx.spawner.spawn(config);
			const first = mockChildProcess;
			const firstHandlers = childHandlers(first);

			// ProcessManager.spawn() kills the predecessor (dropping its map entry)
			// before the spawner registers the successor under the same key.
			ctx.processes.delete(config.sessionId);
			ctx.spawner.spawn(createBaseConfig({ prompt: 'second turn' }));
			const second = ctx.processes.get(config.sessionId);

			return { ...ctx, config, first, firstHandlers, second };
		}

		it('ignores a late close from the killed predecessor', async () => {
			const { emitter, processes, config, firstHandlers, second } = spawnTwoGenerations();
			const onExit = vi.fn();
			const onAgentError = vi.fn();
			emitter.on('exit', onExit);
			emitter.on('agent-error', onAgentError);

			// Predecessor finally reports its SIGTERM death (128 + 15).
			firstHandlers.get('close')?.(143);
			// handleExit is async - give the (suppressed) exit path room to run.
			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(onExit).not.toHaveBeenCalled();
			expect(onAgentError).not.toHaveBeenCalled();
			// The live process stays tracked, so the user can still stop it.
			expect(processes.get(config.sessionId)).toBe(second);
		});

		it('ignores a late error from the killed predecessor', () => {
			const { emitter, processes, config, firstHandlers, second } = spawnTwoGenerations();
			const onExit = vi.fn();
			const onAgentError = vi.fn();
			emitter.on('exit', onExit);
			emitter.on('agent-error', onAgentError);

			firstHandlers.get('error')?.(new Error('EPIPE'));

			expect(onExit).not.toHaveBeenCalled();
			expect(onAgentError).not.toHaveBeenCalled();
			expect(processes.get(config.sessionId)).toBe(second);
		});

		it.each(['kill', 'stale'])(
			'cleans once when %s replaces a turn parked in Copilot shutdown',
			async (route) => {
				let release!: (result: copilotShutdownWaiter.CopilotShutdownWaitResult) => void;
				const wait = vi
					.spyOn(copilotShutdownWaiter, 'waitForCopilotShutdown')
					.mockImplementationOnce(
						() =>
							new Promise((resolve) => {
								release = resolve;
							})
					);
				try {
					const manager = new ProcessManager();
					manager.spawn(
						createBaseConfig({
							toolType: 'copilot-cli',
							agentSessionId: 'copilot-old',
							prompt: 'first turn',
						})
					);
					const predecessor = manager.get('test-session')!;
					predecessor.tempFiles = ['/tmp/old-prompt.md'];
					predecessor.childProcess!.kill = vi.fn(() => true);
					const close = mockChildProcess.on.mock.calls.find(
						([event]: [string]) => event === 'close'
					)[1];
					close(0);
					await vi.waitFor(() => expect(wait).toHaveBeenCalledOnce());
					if (route === 'kill') expect(manager.kill('test-session')).toBe(true);
					manager.spawn(createBaseConfig({ prompt: 'second turn' }));
					const successor = manager.get('test-session')!;
					successor.tempFiles = ['/tmp/new-prompt.md'];
					release('timeout');
					await vi.waitFor(() => expect(predecessor.tempFiles).toBeUndefined());
					close(0);
					expect(cleanupTempFiles).toHaveBeenCalledExactlyOnceWith(['/tmp/old-prompt.md']);
					expect(successor.tempFiles).toEqual(['/tmp/new-prompt.md']);
					expect(manager.get('test-session')).toBe(successor);
				} finally {
					wait.mockRestore();
				}
			}
		);

		it('cleans only predecessor files on a superseded close, only once', async () => {
			const ctx = createTestContext();
			ctx.spawner.spawn(createBaseConfig({ prompt: 'first turn' }));
			const predecessor = ctx.processes.get('test-session')!;
			predecessor.tempFiles = ['/tmp/old-image.png', '/tmp/old-prompt.md'];
			const close = mockChildProcess.on.mock.calls.find(
				([event]: [string]) => event === 'close'
			)[1];
			ctx.processes.delete('test-session');
			ctx.spawner.spawn(createBaseConfig({ prompt: 'second turn' }));
			const successor = ctx.processes.get('test-session')!;
			successor.tempFiles = ['/tmp/new-prompt.md'];

			close(143);
			close(143);
			await vi.waitFor(() => expect(predecessor.tempFiles).toBeUndefined());

			expect(cleanupTempFiles).toHaveBeenCalledExactlyOnceWith([
				'/tmp/old-image.png',
				'/tmp/old-prompt.md',
			]);
			expect(predecessor.tempFiles).toBeUndefined();
			expect(successor.tempFiles).toEqual(['/tmp/new-prompt.md']);
			expect(ctx.processes.get('test-session')).toBe(successor);
		});

		it('ignores late stdout/stderr from the killed predecessor', () => {
			const { emitter, bufferManager, first, second } = spawnTwoGenerations();
			const onRawStdout = vi.fn();
			emitter.on('raw-stdout', onRawStdout);

			first.stdout.emit('data', 'stale output from the dead turn');
			first.stderr.emit('data', 'stale stderr');

			expect(onRawStdout).not.toHaveBeenCalled();
			expect(bufferManager.emitDataBuffered).not.toHaveBeenCalled();
			expect(second?.stderrBuffer).toBe('');
		});

		it('still reports exit for the current generation', async () => {
			const { emitter, processes, spawner } = createTestContext();
			const baseConfig = createBaseConfig({ prompt: 'only turn' });

			spawner.spawn(baseConfig);
			const handlers = childHandlers(mockChildProcess);
			const onExit = vi.fn();
			emitter.on('exit', onExit);

			handlers.get('close')?.(0);
			// handleExit is async (post-exit reconciliation) - let it settle.
			await vi.waitFor(() => expect(onExit).toHaveBeenCalled());

			expect(onExit).toHaveBeenCalledWith(
				baseConfig.sessionId,
				0,
				undefined,
				expect.objectContaining({ outcome: 'completed' })
			);
			expect(processes.has(baseConfig.sessionId)).toBe(false);
		});
	});

	describe('image handling with non-stream-json agents', () => {
		it('should use file-based image args for agents without stream-json support', () => {
			// Override capabilities for this test
			vi.mocked(getAgentCapabilities).mockReturnValueOnce({
				supportsStreamJsonInput: false,
			} as any);
			vi.mocked(saveImageToTempFile).mockReturnValueOnce('/tmp/maestro-image-0.png');

			const { spawner } = createTestContext();

			spawner.spawn(
				createBaseConfig({
					toolType: 'codex',
					command: 'codex',
					args: ['exec', '--json'],
					images: ['data:image/png;base64,abc123'],
					prompt: 'describe this image',
					imageArgs: (path: string) => ['-i', path],
				})
			);

			const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
			expect(spawnArgs).toContain('-i');
			expect(spawnArgs).toContain('/tmp/maestro-image-0.png');
			// Should NOT have --input-format since this agent doesn't support it
			expect(spawnArgs).not.toContain('--input-format');
		});

		it('should embed Copilot image paths into the prompt when imagePromptBuilder is provided', () => {
			vi.mocked(getAgentCapabilities).mockReturnValueOnce({
				supportsStreamJsonInput: false,
			} as any);
			vi.mocked(saveImageToTempFile).mockReturnValueOnce('/tmp/maestro-image-0.png');

			const { spawner } = createTestContext();

			spawner.spawn(
				createBaseConfig({
					toolType: 'copilot-cli',
					command: 'copilot',
					args: ['--output-format', 'json'],
					images: ['data:image/png;base64,abc123'],
					prompt: 'describe this image',
					imagePromptBuilder: (paths: string[]) =>
						`Use these attached images as context:\n${paths.map((imagePath) => `@${imagePath}`).join('\n')}\n\n`,
					promptArgs: (prompt: string) => ['-p', prompt],
				})
			);

			const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
			expect(spawnArgs).toContain('-p');
			const promptArg = spawnArgs[spawnArgs.indexOf('-p') + 1];
			expect(promptArg).toContain('@/tmp/maestro-image-0.png');
			expect(promptArg).toContain('describe this image');
		});
	});

	describe('resume mode with prompt-embed image handling', () => {
		it('should embed image paths in prompt when resuming with imageResumeMode=prompt-embed', () => {
			vi.mocked(getAgentCapabilities).mockReturnValueOnce({
				supportsStreamJsonInput: false,
				imageResumeMode: 'prompt-embed',
			} as any);
			vi.mocked(saveImageToTempFile).mockReturnValueOnce('/tmp/maestro-image-0.png');

			const { spawner } = createTestContext();

			spawner.spawn(
				createBaseConfig({
					toolType: 'codex',
					command: 'codex',
					args: ['exec', 'resume', 'thread-123', '--json'],
					images: ['data:image/png;base64,abc123'],
					prompt: 'describe this image',
					imageArgs: (path: string) => ['-i', path],
				})
			);

			const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
			// Should NOT have -i flag (resume mode skips it)
			expect(spawnArgs).not.toContain('-i');
			// Should have the modified prompt with image paths embedded
			expect(spawnArgs).toContain('--');
			const promptArg = spawnArgs[spawnArgs.indexOf('--') + 1];
			expect(promptArg).toContain('[Attached images:');
			expect(promptArg).toContain('/tmp/maestro-image-0.png');
			expect(promptArg).toContain('describe this image');
		});

		it('should use -i flag for initial spawn even when imageResumeMode=prompt-embed', () => {
			vi.mocked(getAgentCapabilities).mockReturnValueOnce({
				supportsStreamJsonInput: false,
				imageResumeMode: 'prompt-embed',
			} as any);
			vi.mocked(saveImageToTempFile).mockReturnValueOnce('/tmp/maestro-image-0.png');

			const { spawner } = createTestContext();

			// Args do NOT contain 'resume' - this is an initial spawn
			spawner.spawn(
				createBaseConfig({
					toolType: 'codex',
					command: 'codex',
					args: ['exec', '--json'],
					images: ['data:image/png;base64,abc123'],
					prompt: 'describe this image',
					imageArgs: (path: string) => ['-i', path],
				})
			);

			const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
			// Should have -i flag (initial spawn uses it)
			expect(spawnArgs).toContain('-i');
			expect(spawnArgs).toContain('/tmp/maestro-image-0.png');
		});

		it('should send modified prompt via stdin in resume mode when promptViaStdin is true', () => {
			vi.mocked(getAgentCapabilities).mockReturnValueOnce({
				supportsStreamJsonInput: false,
				imageResumeMode: 'prompt-embed',
			} as any);
			vi.mocked(saveImageToTempFile).mockReturnValueOnce('/tmp/maestro-image-0.png');

			const { spawner } = createTestContext();

			spawner.spawn(
				createBaseConfig({
					toolType: 'codex',
					command: 'codex',
					args: ['exec', 'resume', 'thread-123', '--json'],
					images: ['data:image/png;base64,abc123'],
					prompt: 'describe this image',
					imageArgs: (path: string) => ['-i', path],
					sendPromptViaStdinRaw: true,
				})
			);

			const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
			// Should NOT have -i flag
			expect(spawnArgs).not.toContain('-i');
			// Prompt should NOT be in args (sent via stdin instead)
			expect(spawnArgs).not.toContain('--');

			// The modified prompt with image prefix should be sent via stdin
			const writtenData = mockChildProcess.stdin.write.mock.calls[0][0];
			expect(writtenData).toContain('[Attached images:');
			expect(writtenData).toContain('/tmp/maestro-image-0.png');
			expect(writtenData).toContain('describe this image');
		});

		it('should handle multiple images in resume mode', () => {
			vi.mocked(getAgentCapabilities).mockReturnValueOnce({
				supportsStreamJsonInput: false,
				imageResumeMode: 'prompt-embed',
			} as any);
			vi.mocked(saveImageToTempFile)
				.mockReturnValueOnce('/tmp/maestro-image-0.png')
				.mockReturnValueOnce('/tmp/maestro-image-1.jpg');

			const { spawner } = createTestContext();

			spawner.spawn(
				createBaseConfig({
					toolType: 'codex',
					command: 'codex',
					args: ['exec', 'resume', 'thread-123', '--json'],
					images: ['data:image/png;base64,abc123', 'data:image/jpeg;base64,def456'],
					prompt: 'compare these images',
					imageArgs: (path: string) => ['-i', path],
				})
			);

			const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
			expect(spawnArgs).not.toContain('-i');
			const promptArg = spawnArgs[spawnArgs.indexOf('--') + 1];
			expect(promptArg).toContain('/tmp/maestro-image-0.png');
			expect(promptArg).toContain('/tmp/maestro-image-1.jpg');
			expect(promptArg).toContain('compare these images');
		});

		it('should NOT use prompt-embed when imageResumeMode is undefined', () => {
			vi.mocked(getAgentCapabilities).mockReturnValueOnce({
				supportsStreamJsonInput: false,
				imageResumeMode: undefined,
			} as any);
			vi.mocked(saveImageToTempFile).mockReturnValueOnce('/tmp/maestro-image-0.png');

			const { spawner } = createTestContext();

			// Even with 'resume' in args, if imageResumeMode is undefined, use -i flag
			spawner.spawn(
				createBaseConfig({
					toolType: 'opencode',
					command: 'opencode',
					args: ['run', '--session', 'sess-123', '--format', 'json'],
					images: ['data:image/png;base64,abc123'],
					prompt: 'describe this image',
					imageArgs: (path: string) => ['-f', path],
				})
			);

			const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
			// Should have -f flag (uses default file-based args)
			expect(spawnArgs).toContain('-f');
			expect(spawnArgs).toContain('/tmp/maestro-image-0.png');
		});
	});

	// ----------------------------------------------------------------
	// Windows batch-file spawning (MAESTRO-Q8)
	//
	// Node.js throws "spawn EINVAL" when asked to spawn a .cmd/.bat file
	// without a shell. npm-installed agent CLIs resolve to such shims on
	// Windows, so the spawner must auto-enable shell for them.
	// ----------------------------------------------------------------
	describe('Windows batch-file handling (MAESTRO-Q8)', () => {
		beforeEach(() => {
			vi.mocked(isWindows).mockReturnValue(true);
		});
		afterEach(() => {
			vi.mocked(isWindows).mockReturnValue(false);
		});
		it('delivers a long OMP prompt as a UTF-8 attachment while preserving launch options and images', async () => {
			await useRealPromptFiles();
			const { spawner, processes } = createTestContext();
			const omp = getAgentDefinition('omp')!;
			const prompt = '---\nPrivate playbook "quoted" & %PATH% 日本語\n'.repeat(1000);
			vi.mocked(getAgentCapabilities).mockReturnValueOnce(getRealAgentCapabilities('omp'));
			vi.mocked(saveImageToTempFile).mockReturnValueOnce('/tmp/maestro-image-0.png');
			spawner.spawn(
				createBaseConfig({
					toolType: 'omp',
					command: 'omp.exe',
					args: [
						'-p',
						'--mode',
						'json',
						'--model',
						'openai-codex/gpt-6.1-sol',
						'--resume',
						'saved-session',
						'--tools',
						'read,grep,glob',
					],
					prompt,
					images: ['data:image/png;base64,abc123'],
					imageArgs: omp.imageArgs,
				})
			);
			const args = mockSpawn.mock.calls[0][1] as string[];
			const promptFile = args.at(-1)!.slice(1);
			try {
				expect(args.slice(0, -1)).toEqual([
					'-p',
					'--mode',
					'json',
					'--model',
					'openai-codex/gpt-6.1-sol',
					'--resume',
					'saved-session',
					'--tools',
					'read,grep,glob',
					'@/tmp/maestro-image-0.png',
				]);
				expect(readFileSync(promptFile, 'utf8')).toBe(prompt);
				expect(processes.get('test-session')?.tempFiles).toContain(promptFile);
				expect(mockChildProcess.stdin.write).not.toHaveBeenCalled();
			} finally {
				if (args.at(-1)!.startsWith('@')) unlinkSync(promptFile);
			}
		});

		it('reports a synchronous spawn failure and removes its temporary prompt attachment', async () => {
			const { spawner, processes } = createTestContext();
			await useRealPromptFiles();
			let promptFile = '';
			mockSpawn.mockImplementationOnce((_command, args: string[]) => {
				promptFile = args.at(-1)!.slice(1);
				throw Object.assign(new Error('spawn ENAMETOOLONG'), { code: 'ENAMETOOLONG' });
			});
			const result = spawner.spawn(
				createBaseConfig({
					toolType: 'omp',
					command: 'omp.exe',
					args: ['-p', '--mode', 'json'],
					prompt: 'Long prompt'.repeat(10000),
				})
			);
			expect(result).toMatchObject({ success: false, pid: -1, error: 'spawn ENAMETOOLONG' });
			await vi.waitFor(() => expect(existsSync(promptFile)).toBe(false));
			expect(processes.has('test-session')).toBe(false);
		});

		it('cleans a failed child attachment and publishes one failure rather than a second close outcome', async () => {
			const { spawner, emitter, processes } = createTestContext();
			await useRealPromptFiles();
			const exit = vi.fn();
			emitter.on('exit', exit);
			spawner.spawn(
				createBaseConfig({
					toolType: 'omp',
					command: 'omp.exe',
					args: ['-p', '--mode', 'json'],
					prompt: 'Prompt content'.repeat(3000),
				})
			);
			const promptFile = processes.get('test-session')!.tempFiles![0];
			const errorHandler = mockChildProcess.on.mock.calls.find(
				([event]: [string]) => event === 'error'
			)[1];
			const closeHandler = mockChildProcess.on.mock.calls.find(
				([event]: [string]) => event === 'close'
			)[1];
			errorHandler(new Error('spawn ENOENT'));
			closeHandler(-1);
			await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(1));
			expect(exit.mock.calls[0].slice(0, 2)).toEqual(['test-session', 1]);
			expect(exit.mock.calls[0][3]).toMatchObject({ outcome: 'crashed', answerCaptured: false });
			expect(processes.has('test-session')).toBe(false);
			await vi.waitFor(() => expect(existsSync(promptFile)).toBe(false));
		});

		it('removes a replaced turn attachment without settling or deleting its live successor', async () => {
			const { spawner, emitter, processes } = createTestContext();
			const exit = vi.fn();
			await useRealPromptFiles();
			emitter.on('exit', exit);
			const config = createBaseConfig({
				toolType: 'omp',
				command: 'omp.exe',
				args: ['-p', '--mode', 'json'],
				prompt: 'First prompt'.repeat(3000),
			});
			spawner.spawn(config);
			const firstChild = mockChildProcess;
			const firstFile = processes.get('test-session')!.tempFiles![0];
			spawner.spawn({ ...config, prompt: 'Successor prompt'.repeat(3000) });
			const successor = processes.get('test-session')!;
			const secondFile = successor.tempFiles![0];
			try {
				firstChild.on.mock.calls.find(([event]: [string]) => event === 'close')[1](143);
				await vi.waitFor(() => expect(existsSync(firstFile)).toBe(false));
				expect(existsSync(secondFile)).toBe(true);
				expect(processes.get('test-session')).toBe(successor);
				expect(exit).not.toHaveBeenCalled();
			} finally {
				unlinkSync(secondFile);
			}
		});

		it('does not report success when Node returns a pidless child', () => {
			const { spawner } = createTestContext();
			mockSpawn.mockImplementationOnce(() => ({ ...createMockChildProcess(), pid: undefined }));
			const result = spawner.spawn(createBaseConfig({ command: 'missing.exe', prompt: 'hello' }));
			expect(result).toMatchObject({ success: false, pid: -1 });
		});

		it('cleans its prompt file when spawning throws before lifecycle handlers exist', () => {
			const { spawner } = createTestContext();
			const omp = getAgentDefinition('omp')!;
			vi.mocked(savePromptToTempFile).mockReturnValueOnce('/tmp/unstarted-prompt.md');
			mockSpawn.mockImplementationOnce(() => {
				throw new Error('Invalid spawn argument');
			});
			const result = spawner.spawn(
				createBaseConfig({
					toolType: 'omp',
					command: 'omp.exe',
					prompt: 'x'.repeat(30_000),
					promptFileArgs: omp.promptFileArgs,
				})
			);
			expect(result.success).toBe(false);
			expect(cleanupTempFiles).toHaveBeenCalledExactlyOnceWith(['/tmp/unstarted-prompt.md']);
		});

		it('delivers a long omp prompt through a temp file instead of argv (ENAMETOOLONG)', () => {
			// PowerShell caps the command line near 32K; the embedded system prompt alone
			// pushes a one-line task past it. omp reads an @file message, so use that.
			const { spawner } = createTestContext();
			const omp = getAgentDefinition('omp')!;
			const prompt = 'x'.repeat(30_000);
			spawner.spawn(
				createBaseConfig({
					toolType: 'omp',
					command: 'omp.exe',
					args: [...omp.batchModePrefix!, ...omp.jsonOutputArgs!],
					promptFileArgs: omp.promptFileArgs,
					prompt,
				})
			);
			const args = mockSpawn.mock.calls[0][1] as string[];
			expect(args).toEqual(['-p', '--mode', 'json', '@C:\\tmp\\maestro-prompt-1.md']);
			expect(args.join(' ')).not.toContain('xxxx');
		});

		it.each([false, true])(
			'delivers a long image turn through a prompt file (embedded=%s)',
			(embedded) => {
				const { spawner, processes } = createTestContext();
				const omp = getAgentDefinition('omp')!;
				const prompt = 'x'.repeat(30_000);
				vi.mocked(getAgentCapabilities).mockReturnValueOnce(getRealAgentCapabilities('omp'));
				vi.mocked(saveImageToTempFile).mockReturnValue('/tmp/image.png');
				vi.mocked(savePromptToTempFile).mockReturnValueOnce('/tmp/prompt.md');
				spawner.spawn(
					createBaseConfig({
						toolType: 'omp',
						command: 'omp.exe',
						args: [...omp.batchModePrefix!, ...omp.jsonOutputArgs!],
						promptFileArgs: omp.promptFileArgs,
						prompt,
						images: ['data:image/png;base64,abc123'],
						imageArgs: (file) => ['--image', file],
						imagePromptBuilder: embedded
							? (files) => 'Images: ' + files.join(', ') + '\n'
							: undefined,
					})
				);
				const args = mockSpawn.mock.calls[0][1] as string[];
				expect(args.at(-1)).toBe('@/tmp/prompt.md');
				expect(args.at(-2)).not.toBe('--');
				expect(args.join(' ')).not.toContain(prompt);
				if (embedded) {
					expect(savePromptToTempFile).toHaveBeenCalledWith('Images: /tmp/image.png\n' + prompt);
				} else {
					expect(args).toContain('--image');
					expect(args).toContain('/tmp/image.png');
					expect(savePromptToTempFile).toHaveBeenCalledWith(prompt);
				}
				expect(processes.get('test-session')?.tempFiles).toEqual([
					'/tmp/image.png',
					'/tmp/prompt.md',
				]);
			}
		);

		it('keeps a short omp prompt on argv', () => {
			const { spawner } = createTestContext();
			const omp = getAgentDefinition('omp')!;
			spawner.spawn(
				createBaseConfig({
					toolType: 'omp',
					command: 'omp.exe',
					args: [...omp.batchModePrefix!],
					promptFileArgs: omp.promptFileArgs,
					prompt: 'short task',
				})
			);
			const args = mockSpawn.mock.calls[0][1] as string[];
			expect(args).toEqual(['-p', '--', 'short task']);
		});

		it('delivers a long Hermes query through stdin with explicit one-shot query selection', () => {
			const { spawner } = createTestContext();
			const hermes = getAgentDefinition('hermes')!;
			const capabilities = getRealAgentCapabilities('hermes');
			vi.mocked(getAgentCapabilities).mockReturnValueOnce(capabilities);
			const prompt = 'Private playbook text "quoted" & %PATH% 日本語\n'.repeat(1000);
			spawner.spawn(
				createBaseConfig({
					toolType: 'hermes',
					command: 'hermes.cmd',
					args: [...hermes.batchModePrefix!, ...hermes.batchModeArgs!],
					promptArgs: hermes.promptArgs,
					prompt,
					sendPromptViaStdinRaw: capabilities.supportsPromptViaStdin,
				})
			);
			const args = mockSpawn.mock.calls[0][1] as string[];
			expect(args).toEqual(['chat', '-Q', '--yolo', '--query-file', '-']);
			expect(mockChildProcess.stdin.write).toHaveBeenCalledExactlyOnceWith(
				prompt,
				expect.any(Function)
			);
			expect(mockChildProcess.stdin.end).toHaveBeenCalledOnce();
		});

		it.each([false, true])('keeps prompt content out of spawn diagnostics (stdin=%s)', (stdin) => {
			const { spawner } = createTestContext();
			const secret = 'PRIVATE_HERMES_PROMPT_CONTENT';
			spawner.spawn(
				createBaseConfig({
					toolType: 'hermes',
					command: 'hermes.cmd',
					args: ['chat', '-Q', '--yolo'],
					promptArgs: getAgentDefinition('hermes')!.promptArgs,
					prompt: secret,
					sendPromptViaStdinRaw: stdin,
				})
			);
			expect(mockSpawn).toHaveBeenCalledOnce();
			for (const level of ['info', 'debug', 'warn', 'error'] as const) {
				expect(JSON.stringify(vi.mocked(logger[level]).mock.calls)).not.toContain(secret);
			}
		});
		it('auto-enables shell for a .cmd command on Windows', () => {
			const { spawner } = createTestContext();

			spawner.spawn(createBaseConfig({ command: 'claude.cmd' }));

			const options = mockSpawn.mock.calls[0][2] as { shell?: boolean | string };
			expect(options.shell).toBe(true);
		});

		it('auto-enables shell for a .bat command on Windows', () => {
			const { spawner } = createTestContext();

			spawner.spawn(createBaseConfig({ command: 'agent.bat' }));

			const options = mockSpawn.mock.calls[0][2] as { shell?: boolean | string };
			expect(options.shell).toBe(true);
		});

		it('quotes a batch-file command path that contains spaces', () => {
			const { spawner } = createTestContext();
			const cmdPath = 'C:\\Users\\First Last\\AppData\\Roaming\\npm\\claude.cmd';

			spawner.spawn(createBaseConfig({ command: cmdPath }));

			const spawnCommand = mockSpawn.mock.calls[0][0] as string;
			const options = mockSpawn.mock.calls[0][2] as { shell?: boolean | string };
			expect(options.shell).toBe(true);
			expect(spawnCommand).toBe(`"${cmdPath}"`);
		});

		it('does not quote a batch-file command path without spaces', () => {
			const { spawner } = createTestContext();
			const cmdPath = 'C:\\npm\\claude.cmd';

			spawner.spawn(createBaseConfig({ command: cmdPath }));

			const spawnCommand = mockSpawn.mock.calls[0][0] as string;
			const options = mockSpawn.mock.calls[0][2] as { shell?: boolean | string };
			expect(options.shell).toBe(true);
			expect(spawnCommand).toBe(cmdPath);
		});

		it('does not auto-enable shell for a .cmd command off Windows', () => {
			vi.mocked(isWindows).mockReturnValue(false);
			const { spawner } = createTestContext();

			spawner.spawn(createBaseConfig({ command: 'claude.cmd' }));

			const options = mockSpawn.mock.calls[0][2] as { shell?: boolean | string };
			expect(options.shell).toBe(false);
		});
	});

	describe('agentSessionId seeding (for resumed sessions)', () => {
		// Regression: Copilot CLI emits `session.resume` (no sessionId) instead of
		// `session.start` when resuming a session, so StdoutHandler.emitSessionIdIfNeeded
		// can never populate managedProcess.agentSessionId from the stream. Without the
		// config-time seed, ExitHandler.awaitCopilotShutdown bails at its
		// `if (!agentSessionId) return` guard, the disk-derived final answer and the
		// context window snapshot never reach the renderer, and the UI surfaces the
		// streamed commentary deltas instead of the authoritative task_complete.summary.
		it('seeds managedProcess.agentSessionId from config when provided (Copilot resume)', () => {
			const { processes, spawner } = createTestContext();

			spawner.spawn(
				createBaseConfig({
					toolType: 'copilot-cli',
					command: 'copilot',
					args: ['--output-format', 'json', '--resume=cp-resumed-1'],
					prompt: 'follow-up question',
					agentSessionId: 'cp-resumed-1',
				})
			);

			const proc = processes.get('test-session');
			expect(proc?.agentSessionId).toBe('cp-resumed-1');
		});

		it('leaves managedProcess.agentSessionId undefined for fresh sessions (will be set from stdout later)', () => {
			const { processes, spawner } = createTestContext();

			spawner.spawn(
				createBaseConfig({
					toolType: 'copilot-cli',
					command: 'copilot',
					args: ['--output-format', 'json'],
					prompt: 'first message',
					// No agentSessionId - fresh session, sessionId will arrive via session.start
				})
			);

			const proc = processes.get('test-session');
			expect(proc?.agentSessionId).toBeUndefined();
		});
	});

	// Claude reports its cost as a running SESSION total; the spawn hands the
	// parser the total the resumed transcript held, so it can report the turn's.
	describe('Claude session cost baseline', () => {
		const primedParser = () => {
			const primeResumedSession = vi.fn();
			vi.mocked(createOutputParser).mockReturnValueOnce({
				agentId: 'claude-code',
				parseJsonLine: vi.fn(),
				extractUsage: vi.fn(),
				extractSessionId: vi.fn(),
				extractSlashCommands: vi.fn(),
				isResultMessage: vi.fn(),
				detectErrorFromLine: vi.fn(),
				detectErrorFromExit: vi.fn(() => null),
				primeResumedSession,
			} as any);
			return primeResumedSession;
		};

		it("primes a resumed turn with the transcript's last cost-state row", async () => {
			const actualFs = await vi.importActual('fs');
			const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'spawner-cost-'));
			try {
				const cwd = nodePath.join(root, 'proj');
				const projectDir = nodePath.join(
					root,
					'cfg',
					'projects',
					cwd.replace(/[^a-zA-Z0-9]/g, '-')
				);
				nodeFs.mkdirSync(projectDir, { recursive: true });
				actualFs.writeFileSync(
					nodePath.join(projectDir, 'sid-1.jsonl'),
					JSON.stringify({ type: 'cost-state', totalCostUSD: 0.5, modelUsage: {} }) + '\n'
				);
				vi.mocked(buildChildProcessEnv).mockReturnValueOnce({
					PATH: '/usr/bin',
					CLAUDE_CONFIG_DIR: nodePath.join(root, 'cfg'),
				});
				const prime = primedParser();
				const { spawner } = createTestContext();

				spawner.spawn(
					createBaseConfig({ cwd, args: ['--print', '--resume', 'sid-1'], prompt: 'next' })
				);

				expect(prime).toHaveBeenCalledWith('sid-1', { totalCostUSD: 0.5, modelUsage: {} });
			} finally {
				nodeFs.rmSync(root, { recursive: true, force: true });
			}
		});

		it('primes a remote resumed turn with an unknown baseline', () => {
			const prime = primedParser();
			const { spawner } = createTestContext();

			spawner.spawn(
				createBaseConfig({ agentSessionId: 'sid-2', sshRemoteId: 'remote-1', prompt: 'next' })
			);

			expect(prime).toHaveBeenCalledWith('sid-2', undefined);
		});

		it('does not prime a fresh session', () => {
			const prime = primedParser();
			const { spawner } = createTestContext();

			spawner.spawn(createBaseConfig({ args: ['--print', '--session-id', 'new'], prompt: 'hi' }));

			expect(prime).not.toHaveBeenCalled();
		});
	});
});
