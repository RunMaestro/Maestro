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
const mockIsWindows = vi.hoisted(() => vi.fn(() => false));
const mockReadFileSync = vi.hoisted(() => vi.fn());

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

vi.mock('fs', async (importOriginal) => {
	const actual = await importOriginal<typeof import('fs')>();
	return {
		...actual,
		readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
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
		detectErrorFromParsed: vi.fn(),
		detectErrorFromExit: vi.fn(() => null),
	})),
}));

vi.mock('../../../../main/agents', () => ({
	getAgentCapabilities: vi.fn(() => ({
		supportsStreamJsonInput: true,
	})),
}));

vi.mock('../../../../shared/platformDetection', () => ({
	isWindows: () => mockIsWindows(),
}));

vi.mock('../../../../main/process-manager/utils/envBuilder', () => ({
	buildChildProcessEnv: vi.fn(() => ({ PATH: '/usr/bin' })),
}));

vi.mock('../../../../main/process-manager/utils/imageUtils', () => ({
	saveImageToTempFile: vi.fn(),
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

// ── Imports (after mocks) ──────────────────────────────────────────────────

import { ChildProcessSpawner } from '../../../../main/process-manager/spawners/ChildProcessSpawner';
import type { ManagedProcess, ProcessConfig } from '../../../../main/process-manager/types';
import { getAgentCapabilities } from '../../../../main/agents';
import { logger } from '../../../../main/utils/logger';
import { getOutputParser } from '../../../../main/parsers';
import { buildChildProcessEnv } from '../../../../main/process-manager/utils/envBuilder';
import { buildStreamJsonMessage } from '../../../../main/process-manager/utils/streamJsonBuilder';
import {
	saveImageToTempFile,
	buildImagePromptPrefix,
} from '../../../../main/process-manager/utils/imageUtils';
import {
	escapeArgsForShell,
	isPowerShellShell,
} from '../../../../main/process-manager/utils/shellEscape';

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
		mockIsWindows.mockReturnValue(false);
		mockReadFileSync.mockImplementation(() => {
			throw new Error('readFileSync not mocked');
		});
		// Setup mock spawn to return a fresh mock child process
		mockSpawn.mockImplementation(() => {
			mockChildProcess = createMockChildProcess();
			return mockChildProcess;
		});
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

		it('should NOT enable stream-json mode when sendPromptViaStdinRaw is true', () => {
			const { processes, spawner } = createTestContext();

			// sendPromptViaStdinRaw sends RAW text via stdin, not JSON
			// So it should NOT set isStreamJsonMode (which is for JSON streaming)
			spawner.spawn(
				createBaseConfig({
					args: ['--print'],
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

		it('should NOT enable stream-json mode for plain args without JSON flags', () => {
			const { processes, spawner } = createTestContext();

			spawner.spawn(
				createBaseConfig({
					args: ['--print', '--verbose'],
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
			// before exit handler runs — fixes data loss for short-lived processes)
			const onCalls = mockChildProcess.on.mock.calls as [string, Function][];
			const eventNames = onCalls.map(([event]) => event);
			expect(eventNames).toContain('close');
			expect(eventNames).not.toContain('exit');
		});

		it('should listen for "error" events on the child process', () => {
			const { spawner } = createTestContext();

			spawner.spawn(createBaseConfig({ prompt: 'test' }));

			const onCalls = mockChildProcess.on.mock.calls as [string, Function][];
			const eventNames = onCalls.map(([event]) => event);
			expect(eventNames).toContain('error');
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

			// Args do NOT contain 'resume' — this is an initial spawn
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

	describe('prompt argument shaping', () => {
		it('uses promptArgs for regular prompts', () => {
			const { spawner } = createTestContext();

			spawner.spawn(
				createBaseConfig({
					args: ['run'],
					prompt: 'hello',
					promptArgs: (prompt) => ['--message', prompt],
				})
			);

			expect(mockSpawn.mock.calls[0][1]).toEqual(['run', '--message', 'hello']);
		});

		it('uses noPromptSeparator for regular prompts', () => {
			const { spawner } = createTestContext();

			spawner.spawn(
				createBaseConfig({
					args: ['run'],
					prompt: 'hello',
					noPromptSeparator: true,
				})
			);

			expect(mockSpawn.mock.calls[0][1]).toEqual(['run', 'hello']);
		});

		it('uses promptArgs for prompt-embed resume prompts', () => {
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
					args: ['exec', 'resume', 'thread-123'],
					images: ['data:image/png;base64,abc123'],
					prompt: 'describe',
					imageArgs: (path: string) => ['-i', path],
					promptArgs: (prompt) => ['--prompt', prompt],
				})
			);

			const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
			expect(spawnArgs).toContain('--prompt');
			expect(spawnArgs[spawnArgs.indexOf('--prompt') + 1]).toContain('/tmp/maestro-image-0.png');
		});

		it('uses noPromptSeparator for prompt-embed resume prompts', () => {
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
					args: ['exec', 'resume', 'thread-123'],
					images: ['data:image/png;base64,abc123'],
					prompt: 'describe',
					imageArgs: (path: string) => ['-i', path],
					noPromptSeparator: true,
				})
			);

			const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
			expect(spawnArgs).not.toContain('--');
			expect(spawnArgs.at(-1)).toContain('/tmp/maestro-image-0.png');
		});

		it('uses promptArgs and noPromptSeparator variants for initial file-image prompts', () => {
			vi.mocked(getAgentCapabilities).mockReturnValue({
				supportsStreamJsonInput: false,
			} as any);
			vi.mocked(saveImageToTempFile)
				.mockReturnValueOnce('/tmp/maestro-image-0.png')
				.mockReturnValueOnce('/tmp/maestro-image-1.png');
			const { spawner } = createTestContext();

			spawner.spawn(
				createBaseConfig({
					toolType: 'codex',
					command: 'codex',
					args: ['exec'],
					images: ['data:image/png;base64,abc123'],
					prompt: 'with prompt args',
					imageArgs: (path: string) => ['-i', path],
					promptArgs: (prompt) => ['--prompt', prompt],
				})
			);
			spawner.spawn(
				createBaseConfig({
					sessionId: 'test-session-2',
					toolType: 'codex',
					command: 'codex',
					args: ['exec'],
					images: ['data:image/png;base64,def456'],
					prompt: 'no separator',
					imageArgs: (path: string) => ['-i', path],
					noPromptSeparator: true,
				})
			);

			expect(mockSpawn.mock.calls[0][1]).toContain('--prompt');
			expect(mockSpawn.mock.calls[0][1]).toContain('with prompt args');
			expect(mockSpawn.mock.calls[1][1]).not.toContain('--');
			expect(mockSpawn.mock.calls[1][1]).toContain('no separator');
		});
	});

	describe('Windows shell handling and process events', () => {
		it('logs and passes shell env vars to the environment builder', () => {
			const { spawner } = createTestContext();

			spawner.spawn(
				createBaseConfig({
					prompt: 'hello',
					shellEnvVars: { FOO: 'bar' },
					customEnvVars: { BAZ: 'qux' },
				})
			);

			expect(buildChildProcessEnv).toHaveBeenCalledWith({ BAZ: 'qux' }, false, { FOO: 'bar' });
			expect(logger.debug).toHaveBeenCalledWith(
				'[ProcessManager] Applying global environment variables',
				'ProcessManager',
				expect.objectContaining({
					globalVarCount: 1,
					hasCustomVars: true,
					customVarCount: 1,
				})
			);
		});

		it('logs shell env vars when no custom env vars are provided', () => {
			const { spawner } = createTestContext();

			spawner.spawn(
				createBaseConfig({
					shellEnvVars: { FOO: 'bar' },
				})
			);

			expect(logger.debug).toHaveBeenCalledWith(
				'[ProcessManager] Applying global environment variables',
				'ProcessManager',
				expect.objectContaining({
					hasCustomVars: false,
					customVarCount: 0,
				})
			);
		});

		it('auto-enables shell for bare Windows exe commands and escapes args with custom shell', () => {
			mockIsWindows.mockReturnValue(true);
			vi.mocked(escapeArgsForShell).mockReturnValueOnce(['escaped prompt']);
			vi.mocked(isPowerShellShell).mockReturnValueOnce(true);
			const { spawner } = createTestContext();

			spawner.spawn(
				createBaseConfig({
					command: 'agent.exe',
					args: ['--print'],
					prompt: 'hello',
					shell: 'pwsh.exe',
				})
			);

			expect(escapeArgsForShell).toHaveBeenCalledWith(['--print', '--', 'hello'], 'pwsh.exe');
			expect(mockSpawn).toHaveBeenCalledWith(
				'agent.exe',
				['escaped prompt'],
				expect.objectContaining({ shell: 'pwsh.exe' })
			);
			expect(logger.info).toHaveBeenCalledWith(
				'[ProcessManager] Auto-enabling shell for Windows to allow PATH resolution of basename exe',
				'ProcessManager',
				{ command: 'agent.exe' }
			);
		});

		it('auto-enables shell for Windows shebang scripts and ignores unreadable scripts', () => {
			mockIsWindows.mockReturnValue(true);
			mockReadFileSync.mockReturnValueOnce('#!/usr/bin/env node\nconsole.log(1)');
			mockReadFileSync.mockImplementationOnce(() => {
				throw new Error('unreadable');
			});
			const { spawner } = createTestContext();

			spawner.spawn(
				createBaseConfig({
					command: 'C:/tools/opencode',
					args: ['run'],
				})
			);
			spawner.spawn(
				createBaseConfig({
					sessionId: 'test-session-2',
					command: 'C:/tools/unreadable',
					args: ['run'],
				})
			);

			expect(mockSpawn.mock.calls[0][2]).toEqual(expect.objectContaining({ shell: true }));
			expect(mockSpawn.mock.calls[1][2]).toEqual(expect.objectContaining({ shell: false }));
		});

		it('wires stdin/stdout/stderr/close/error handlers', () => {
			const { spawner, emitter } = createTestContext();
			emitter.on('raw-stdout', () => {
				throw new Error('listener failed');
			});

			spawner.spawn(createBaseConfig({ prompt: 'hello' }));

			const stdinErrorHandler = mockChildProcess.stdin.on.mock.calls.find(
				([event]: [string]) => event === 'error'
			)?.[1] as (error: NodeJS.ErrnoException) => void;
			stdinErrorHandler(Object.assign(new Error('closed'), { code: 'EPIPE' }));
			stdinErrorHandler(Object.assign(new Error('bad stdin'), { code: 'EINVAL' }));

			mockChildProcess.stdout.emit('error', new Error('stdout failed'));
			mockChildProcess.stdout.emit('data', 'raw output');
			mockChildProcess.stderr.emit('error', new Error('stderr failed'));
			mockChildProcess.stderr.emit('data', 'stderr output');

			const closeHandler = mockChildProcess.on.mock.calls.find(
				([event]: [string]) => event === 'close'
			)?.[1] as (code: number | null) => void;
			const errorHandler = mockChildProcess.on.mock.calls.find(
				([event]: [string]) => event === 'error'
			)?.[1] as (error: Error) => void;
			closeHandler(null);
			errorHandler(new Error('child failed'));

			expect(logger.debug).toHaveBeenCalledWith(
				'[ProcessManager] stdin EPIPE - process closed before write completed',
				'ProcessManager',
				{ sessionId: 'test-session' }
			);
			expect(logger.error).toHaveBeenCalledWith(
				'[ProcessManager] stdin error',
				'ProcessManager',
				expect.objectContaining({ code: 'EINVAL' })
			);
			expect(logger.error).toHaveBeenCalledWith(
				'[ProcessManager] stdout error',
				'ProcessManager',
				expect.objectContaining({ error: 'Error: stdout failed' })
			);
			expect(logger.error).toHaveBeenCalledWith(
				'[ProcessManager] raw-stdout listener error',
				'ProcessManager',
				expect.objectContaining({ error: 'Error: listener failed' })
			);
			expect(logger.error).toHaveBeenCalledWith(
				'[ProcessManager] stderr error',
				'ProcessManager',
				expect.objectContaining({ error: 'Error: stderr failed' })
			);
		});

		it('warns when stdout is unavailable and returns failure when spawn throws', () => {
			mockSpawn
				.mockReturnValueOnce({
					...createMockChildProcess(),
					stdout: null,
				})
				.mockImplementationOnce(() => {
					throw new Error('spawn denied');
				});
			const { spawner } = createTestContext();

			expect(spawner.spawn(createBaseConfig())).toEqual({ pid: 12345, success: true });
			expect(logger.warn).toHaveBeenCalledWith(
				'[ProcessManager] childProcess.stdout is null',
				'ProcessManager',
				{ sessionId: 'test-session' }
			);
			expect(spawner.spawn(createBaseConfig({ sessionId: 'test-session-2' }))).toEqual({
				pid: -1,
				success: false,
			});
			expect(logger.error).toHaveBeenCalledWith(
				'[ProcessManager] Failed to spawn process',
				'ProcessManager',
				{ error: 'Error: spawn denied' }
			);
		});

		it('handles missing parser, empty args, missing pid, and missing stderr', () => {
			vi.mocked(getOutputParser).mockReturnValueOnce(null as any);
			mockSpawn.mockReturnValueOnce({
				...createMockChildProcess(),
				pid: undefined,
				stderr: null,
			});
			const { processes, spawner } = createTestContext();

			const result = spawner.spawn(
				createBaseConfig({
					args: [],
					prompt: undefined,
				})
			);

			expect(result).toEqual({ pid: -1, success: true });
			expect(processes.get('test-session')).toMatchObject({
				pid: -1,
				outputParser: undefined,
			});
		});
	});

	describe('image edge cases', () => {
		it('skips missing temp image files and sends initial file-image prompt via raw stdin', () => {
			vi.mocked(getAgentCapabilities).mockReturnValueOnce({
				supportsStreamJsonInput: false,
			} as any);
			vi.mocked(saveImageToTempFile).mockReturnValueOnce(null);
			const { spawner } = createTestContext();

			spawner.spawn(
				createBaseConfig({
					toolType: 'codex',
					command: 'codex',
					args: ['exec'],
					images: ['data:image/png;base64,abc123'],
					prompt: 'describe missing temp image',
					imageArgs: (path: string) => ['-i', path],
					sendPromptViaStdinRaw: true,
				})
			);

			expect(mockSpawn.mock.calls[0][1]).toEqual(['exec']);
			expect(mockChildProcess.stdin.write).toHaveBeenCalledWith('describe missing temp image');
			expect(mockChildProcess.stdin.end).toHaveBeenCalled();
		});
	});
});
