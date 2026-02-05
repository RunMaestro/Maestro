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
	saveImageToTempFile: vi.fn(),
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

		it('should enable stream-json mode when sendPromptViaStdinRaw is true', () => {
			const { processes, spawner } = createTestContext();

			spawner.spawn(
				createBaseConfig({
					args: ['--print'],
					sendPromptViaStdinRaw: true,
					prompt: 'test prompt',
				})
			);

			const proc = processes.get('test-session');
			expect(proc?.isStreamJsonMode).toBe(true);
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
});
