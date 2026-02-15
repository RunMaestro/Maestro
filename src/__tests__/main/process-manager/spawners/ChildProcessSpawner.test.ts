/**
 * Tests for src/main/process-manager/spawners/ChildProcessSpawner.ts
 *
 * These tests verify the isStreamJsonMode detection logic which determines
 * whether output should be processed as JSON lines or raw text.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// ── Mocks ──────────────────────────────────────────────────────────────────

// Create mock spawn function at module level (before vi.mock hoisting)
const mockSpawn = vi.fn();

// Track created managed processes for verification
let mockChildProcess: any;

function createMockChildProcess() {
	return {
		pid: 12345,
		stdout: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
		stderr: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
		stdin: { write: vi.fn(), end: vi.fn(), on: vi.fn() },
		on: vi.fn(),
		killed: false,
		exitCode: null,
	};
}

// Mock child_process before imports - wrap in function to avoid hoisting issues
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
	getOutputParser: vi.fn(() => ({
		agentId: 'claude-code',
		parseJsonLine: vi.fn(),
		extractUsage: vi.fn(),
		extractSessionId: vi.fn(),
		extractSlashCommands: vi.fn(),
		isResultMessage: vi.fn(),
		detectErrorFromLine: vi.fn(),
	})),
}));

vi.mock('../../../../main/agents', () => ({
	getAgentCapabilities: vi.fn(() => ({
		supportsStreamJsonInput: true,
	})),
}));

vi.mock('../../../../main/process-manager/utils/envBuilder', () => ({
	buildChildProcessEnv: vi.fn(() => ({ PATH: '/usr/bin' })),
}));

vi.mock('../../../../main/process-manager/utils/imageUtils', () => ({
	saveImageToTempFile: vi.fn(() => Promise.resolve(null)),
}));

vi.mock('../../../../main/process-manager/utils/streamJsonBuilder', () => ({
	buildStreamJsonMessage: vi.fn(() => '{"type":"message"}'),
}));

vi.mock('../../../../main/process-manager/utils/shellEscape', () => ({
	escapeArgsForShell: vi.fn((args) => args),
	isPowerShellShell: vi.fn(() => false),
}));

// ── Imports (after mocks) ──────────────────────────────────────────────────

import { ChildProcessSpawner } from '../../../../main/process-manager/spawners/ChildProcessSpawner';
import type { ManagedProcess, ProcessConfig } from '../../../../main/process-manager/types';
import { getAgentCapabilities } from '../../../../main/agents';
import { buildStreamJsonMessage } from '../../../../main/process-manager/utils/streamJsonBuilder';
import { saveImageToTempFile } from '../../../../main/process-manager/utils/imageUtils';

// ── Helpers ────────────────────────────────────────────────────────────────

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

// ── Tests ──────────────────────────────────────────────────────────────────

describe('ChildProcessSpawner', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Setup mock spawn to return a fresh mock child process
		mockSpawn.mockImplementation(() => {
			mockChildProcess = createMockChildProcess();
			return mockChildProcess;
		});
	});

	describe('isStreamJsonMode detection', () => {
		it('should enable stream-json mode when args contain "stream-json"', async () => {
			const { processes, spawner } = createTestContext();

			await spawner.spawn(
				createBaseConfig({
					args: ['--output-format', 'stream-json'],
				})
			);

			const proc = processes.get('test-session');
			expect(proc?.isStreamJsonMode).toBe(true);
		});

		it('should enable stream-json mode when args contain "--json"', async () => {
			const { processes, spawner } = createTestContext();

			await spawner.spawn(
				createBaseConfig({
					args: ['--json'],
				})
			);

			const proc = processes.get('test-session');
			expect(proc?.isStreamJsonMode).toBe(true);
		});

		it('should enable stream-json mode when args contain "--format" and "json"', async () => {
			const { processes, spawner } = createTestContext();

			await spawner.spawn(
				createBaseConfig({
					args: ['--format', 'json'],
				})
			);

			const proc = processes.get('test-session');
			expect(proc?.isStreamJsonMode).toBe(true);
		});

		it('should enable stream-json mode when sendPromptViaStdin is true', async () => {
			const { processes, spawner } = createTestContext();

			await spawner.spawn(
				createBaseConfig({
					args: ['--print'],
					sendPromptViaStdin: true,
					prompt: 'test prompt',
				})
			);

			const proc = processes.get('test-session');
			expect(proc?.isStreamJsonMode).toBe(true);
		});

		it('should NOT enable stream-json mode when sendPromptViaStdinRaw is true', async () => {
			const { processes, spawner } = createTestContext();

			// sendPromptViaStdinRaw sends RAW text via stdin, not JSON
			// So it should NOT set isStreamJsonMode (which is for JSON streaming)
			await spawner.spawn(
				createBaseConfig({
					args: ['--print'],
					sendPromptViaStdinRaw: true,
					prompt: 'test prompt',
				})
			);

			const proc = processes.get('test-session');
			expect(proc?.isStreamJsonMode).toBe(false);
		});

		it('should enable stream-json mode when sshStdinScript is provided', async () => {
			const { processes, spawner } = createTestContext();

			// SSH sessions pass a script via stdin - this should trigger stream-json mode
			// even though the args (SSH args) don't contain 'stream-json'
			await spawner.spawn(
				createBaseConfig({
					args: ['-o', 'BatchMode=yes', 'user@host', '/bin/bash'],
					sshStdinScript: 'export PATH="$HOME/.local/bin:$PATH"\ncd /project\nexec claude --print',
				})
			);

			const proc = processes.get('test-session');
			expect(proc?.isStreamJsonMode).toBe(true);
		});

		it('should NOT enable stream-json mode for plain args without JSON flags', async () => {
			const { processes, spawner } = createTestContext();

			await spawner.spawn(
				createBaseConfig({
					args: ['--print', '--verbose'],
				})
			);

			const proc = processes.get('test-session');
			expect(proc?.isStreamJsonMode).toBe(false);
		});

		it('should enable stream-json mode when images are provided with prompt', async () => {
			const { processes, spawner } = createTestContext();

			await spawner.spawn(
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
		it('should enable batch mode when prompt is provided', async () => {
			const { processes, spawner } = createTestContext();

			await spawner.spawn(
				createBaseConfig({
					prompt: 'test prompt',
				})
			);

			const proc = processes.get('test-session');
			expect(proc?.isBatchMode).toBe(true);
		});

		it('should NOT enable batch mode when no prompt is provided', async () => {
			const { processes, spawner } = createTestContext();

			await spawner.spawn(
				createBaseConfig({
					prompt: undefined,
				})
			);

			const proc = processes.get('test-session');
			expect(proc?.isBatchMode).toBe(false);
		});
	});

	describe('SSH remote context', () => {
		it('should store sshRemoteId on managed process', async () => {
			const { processes, spawner } = createTestContext();

			await spawner.spawn(
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

		it('should add --input-format stream-json when images are present with default Claude Code args', async () => {
			const { spawner } = createTestContext();

			await spawner.spawn(
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

		it('should add --input-format stream-json even when sendPromptViaStdin is true', async () => {
			const { spawner } = createTestContext();

			await spawner.spawn(
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

		it('should not duplicate --input-format when it is already in args', async () => {
			const { spawner } = createTestContext();

			await spawner.spawn(
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

		it('should send stream-json message via stdin when images are present', async () => {
			const { spawner } = createTestContext();

			await spawner.spawn(
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

		it('should send stream-json message via stdin with multiple images', async () => {
			const { spawner } = createTestContext();

			const images = [
				'data:image/png;base64,abc123',
				'data:image/jpeg;base64,def456',
				'data:image/webp;base64,ghi789',
			];

			await spawner.spawn(
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

		it('should NOT treat --output-format stream-json as promptViaStdin', async () => {
			const { spawner } = createTestContext();

			await spawner.spawn(
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

		it('should treat --input-format stream-json as promptViaStdin', async () => {
			const { spawner } = createTestContext();

			await spawner.spawn(
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

		it('should treat sendPromptViaStdin as promptViaStdin', async () => {
			const { spawner } = createTestContext();

			await spawner.spawn(
				createBaseConfig({
					args: CLAUDE_DEFAULT_ARGS,
					prompt: 'hello',
					sendPromptViaStdin: true,
				})
			);

			const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
			expect(spawnArgs).not.toContain('hello');
		});

		it('should treat sendPromptViaStdinRaw as promptViaStdin', async () => {
			const { spawner } = createTestContext();

			await spawner.spawn(
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
		it('should NOT write stream-json to stdin when prompt is already in CLI args (Codex --json)', async () => {
			// Codex uses --json for JSON *output*, not input. The prompt goes as a CLI arg.
			// Without the promptViaStdin guard, isStreamJsonMode (true from --json) would
			// cause the prompt to be double-sent: once in CLI args and once via stdin.
			vi.mocked(getAgentCapabilities).mockReturnValueOnce({
				supportsStreamJsonInput: false,
			} as any);

			const { spawner } = createTestContext();

			await spawner.spawn(
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
		it('should listen on "close" event (not "exit") to ensure all stdio data is drained', async () => {
			const { spawner } = createTestContext();

			await spawner.spawn(createBaseConfig({ prompt: 'test' }));

			// Verify 'close' is registered (ensures all stdout/stderr data is consumed
			// before exit handler runs — fixes data loss for short-lived processes)
			const onCalls = mockChildProcess.on.mock.calls as [string, Function][];
			const eventNames = onCalls.map(([event]) => event);
			expect(eventNames).toContain('close');
			expect(eventNames).not.toContain('exit');
		});

		it('should listen for "error" events on the child process', async () => {
			const { spawner } = createTestContext();

			await spawner.spawn(createBaseConfig({ prompt: 'test' }));

			const onCalls = mockChildProcess.on.mock.calls as [string, Function][];
			const eventNames = onCalls.map(([event]) => event);
			expect(eventNames).toContain('error');
		});
	});

	describe('image handling with non-stream-json agents', () => {
		it('should use file-based image args for agents without stream-json support', async () => {
			// Override capabilities for this test
			vi.mocked(getAgentCapabilities).mockReturnValueOnce({
				supportsStreamJsonInput: false,
			} as any);
			vi.mocked(saveImageToTempFile).mockResolvedValueOnce('/tmp/maestro-image-0.png');

			const { spawner } = createTestContext();

			await spawner.spawn(
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
	});
});
