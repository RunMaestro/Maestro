/**
 * A spawn into a directory that is not there must be refused before it reaches
 * node-pty, whose Windows path throws ERROR_DIRECTORY from an async callback
 * nothing can catch (see main/process-manager/utils/spawnCwd.ts).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { ChildProcess } from 'child_process';

import { unusableCwdReason } from '../../../main/process-manager/utils/spawnCwd';

const { mockPtySpawn, mockChildSpawn, mockGetBridgeSocketPath } = vi.hoisted(() => ({
	mockPtySpawn: vi.fn(),
	mockChildSpawn: vi.fn(),
	mockGetBridgeSocketPath: vi.fn(() => '/tmp/maestro-test-coworking.sock'),
}));

vi.mock('node-pty', () => ({
	spawn: mockPtySpawn,
}));

vi.mock('child_process', async (importOriginal) => {
	const actual = await importOriginal<typeof import('child_process')>();
	const overrides = {
		spawn: mockChildSpawn,
		execFile: vi.fn(),
		execFileSync: vi.fn(),
	};
	return {
		...actual,
		...overrides,
		default: { ...actual, ...overrides },
	};
});

vi.mock('../../../main/utils/logger', () => ({
	logger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

vi.mock('../../../main/coworking/coworking-socket-path', () => ({
	getBridgeSocketPath: () => mockGetBridgeSocketPath(),
}));

import { ProcessManager } from '../../../main/process-manager';
import type { AgentError } from '../../../shared/types';

class FakeReadable extends EventEmitter {
	setEncoding = vi.fn();
}

class FakeWritable extends EventEmitter {
	write = vi.fn();
	end = vi.fn();
}

class FakeChildProcess extends EventEmitter {
	pid = 24680;
	stdout = new FakeReadable();
	stderr = new FakeReadable();
	stdin = new FakeWritable();
	kill = vi.fn(() => true);
}

function makeFakePty() {
	return {
		pid: 13579,
		onData: vi.fn(),
		onExit: vi.fn(),
		write: vi.fn(),
		resize: vi.fn(),
		kill: vi.fn(),
	};
}

/** A path under the temp dir that is guaranteed not to exist. */
const missingDir = path.join(os.tmpdir(), `maestro-missing-cwd-${process.pid}-${Date.now()}`);

/** A real file, to cover "exists but is not a directory". */
const realFile = path.join(os.tmpdir(), `maestro-cwd-file-${process.pid}-${Date.now()}.txt`);

fs.writeFileSync(realFile, 'not a directory', 'utf-8');

afterAll(() => {
	try {
		fs.unlinkSync(realFile);
	} catch {
		// Best effort - a leftover temp file must not fail the suite.
	}
});

describe('unusableCwdReason', () => {
	it('names a directory that does not exist', () => {
		expect(unusableCwdReason(missingDir)).toBe(`Working directory does not exist: ${missingDir}`);
	});

	it('rejects a path that exists but is a file', () => {
		expect(unusableCwdReason(realFile)).toBe(`Working directory is not a directory: ${realFile}`);
	});

	it('accepts a real directory', () => {
		expect(unusableCwdReason(os.tmpdir())).toBeNull();
	});

	it('accepts an absent cwd, which means "inherit ours"', () => {
		expect(unusableCwdReason(undefined)).toBeNull();
		expect(unusableCwdReason('')).toBeNull();
	});
});

describe('ProcessManager refuses a missing working directory', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockPtySpawn.mockReturnValue(makeFakePty());
		mockChildSpawn.mockReturnValue(new FakeChildProcess() as unknown as ChildProcess);
	});

	it('never reaches node-pty when the directory is gone', () => {
		const pm = new ProcessManager();

		const result = pm.spawn({
			sessionId: 'pty-missing-cwd',
			toolType: 'terminal',
			cwd: missingDir,
			command: 'bash',
			args: [],
		});

		expect(result).toEqual({ pid: -1, success: false });
		expect(mockPtySpawn).not.toHaveBeenCalled();
		expect(pm.get('pty-missing-cwd')).toBeUndefined();
	});

	it('never reaches child_process when the directory is gone', () => {
		const pm = new ProcessManager();

		const result = pm.spawn({
			sessionId: 'child-missing-cwd',
			toolType: 'claude-code',
			cwd: missingDir,
			command: 'claude',
			args: [],
			requiresPty: false,
			prompt: 'summarize this repository',
		});

		expect(result).toEqual({ pid: -1, success: false });
		expect(mockChildSpawn).not.toHaveBeenCalled();
	});

	it('emits an agent-error naming the directory so the failure is not silent', () => {
		const pm = new ProcessManager();
		const errors: AgentError[] = [];
		pm.on('agent-error', (_sessionId: string, error: AgentError) => errors.push(error));

		pm.spawn({
			sessionId: 'error-missing-cwd',
			toolType: 'claude-code',
			cwd: missingDir,
			command: 'claude',
			args: [],
			requiresPty: false,
			prompt: 'hello',
		});

		expect(errors).toHaveLength(1);
		expect(errors[0].message).toContain(missingDir);
		expect(errors[0].agentId).toBe('claude-code');
		expect(errors[0].sessionId).toBe('error-missing-cwd');
		expect(errors[0].recoverable).toBe(false);
	});

	it('still spawns when the directory is there', () => {
		const pm = new ProcessManager();

		const result = pm.spawn({
			sessionId: 'pty-present-cwd',
			toolType: 'terminal',
			cwd: os.tmpdir(),
			command: 'bash',
			args: [],
		});

		expect(result).toEqual({ pid: 13579, success: true });
		expect(mockPtySpawn).toHaveBeenCalledOnce();
	});
});
