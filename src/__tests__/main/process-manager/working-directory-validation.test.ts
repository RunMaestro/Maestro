// Source: src/__tests__/main/process-manager/ProcessManager.missingCwd.test.ts
// Source: src/__tests__/main/process-manager/ProcessManager.cwd.test.ts
// Source: src/shared/maestro-lib/launch/__tests__/cwd.test.ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { vi } from 'vitest';
import { beforeEach } from 'vitest';
import { afterAll } from 'vitest';
import type { ChildProcess } from 'child_process';
import { unusableCwdReason } from '../../../main/process-manager/utils/spawnCwd';
import { ProcessManager } from '../../../main/process-manager';
import type { AgentError } from '../../../shared/types';
import { afterEach } from 'vitest';
import type { SpawnOptionsWithoutStdio } from 'child_process';
import * as platform from '../../../shared/platformDetection';
import * as workingDirectory from '../../../main/process-manager/utils/spawnCwd';
import { unusableCwdReason as source0_unusableCwdReason } from '../../../shared/maestro-lib/launch/cwd';
import { unusableDirectoryReason } from '../../../shared/maestro-lib/launch/cwd';
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
describe('ProcessManager.missingCwd', () => {
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
});
describe('ProcessManager.cwd', () => {
	type PtySpawnOptions = {
		cwd?: string;
	};

	type ChildSpawnCall = [command: string, args: string[], options: SpawnOptionsWithoutStdio];

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
		killed = false;
		exitCode: number | null = null;
		kill = vi.fn(() => {
			this.killed = true;
			return true;
		});
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

	function spawnTerminal(pm: ProcessManager, cwd: string, sessionId = `term-${cwd}`) {
		return pm.spawn({
			sessionId,
			toolType: 'terminal',
			cwd,
			command: 'bash',
			args: [],
		});
	}

	describe('ProcessManager cwd tilde expansion', () => {
		afterEach(() => vi.restoreAllMocks());
		beforeEach(() => {
			vi.spyOn(platform, 'isWindows').mockReturnValue(false);
			vi.spyOn(workingDirectory, 'unusableCwdReason').mockReturnValue(null);
			vi.clearAllMocks();
			mockGetBridgeSocketPath.mockReturnValue('/tmp/maestro-test-coworking.sock');
			mockPtySpawn.mockReturnValue(makeFakePty());
			mockChildSpawn.mockReturnValue(new FakeChildProcess() as unknown as ChildProcess);
		});

		it('expands a leading ~/ cwd before spawning a PTY process', () => {
			const pm = new ProcessManager();
			const cwd = '~/Documents/x';
			const expandedCwd = `${os.homedir()}/Documents/x`;

			const result = spawnTerminal(pm, cwd, 'pty-leading-tilde');

			expect(result).toEqual({ pid: 13579, success: true });
			expect(mockPtySpawn).toHaveBeenCalledOnce();
			const options = mockPtySpawn.mock.calls[0][2] as PtySpawnOptions;
			expect(options.cwd).toBe(expandedCwd);
		});

		it('expands a bare ~ cwd to the user home before spawning a PTY process', () => {
			const pm = new ProcessManager();

			spawnTerminal(pm, '~', 'pty-bare-tilde');

			expect(mockPtySpawn).toHaveBeenCalledOnce();
			const options = mockPtySpawn.mock.calls[0][2] as PtySpawnOptions;
			expect(options.cwd).toBe(os.homedir());
		});

		it('passes an absolute cwd through unchanged for PTY processes', () => {
			const pm = new ProcessManager();
			const cwd = '/var/tmp/maestro-project';

			spawnTerminal(pm, cwd, 'pty-absolute');

			expect(mockPtySpawn).toHaveBeenCalledOnce();
			const options = mockPtySpawn.mock.calls[0][2] as PtySpawnOptions;
			expect(options.cwd).toBe(cwd);
		});

		it('records the expanded cwd on the tracked managed process', () => {
			const pm = new ProcessManager();
			const sessionId = 'tracked-expanded-cwd';
			const expandedCwd = `${os.homedir()}/Documents/x`;

			spawnTerminal(pm, '~/Documents/x', sessionId);

			expect(pm.get(sessionId)?.cwd).toBe(expandedCwd);
		});

		it('expands cwd before the non-PTY child_process spawn path receives it', () => {
			const pm = new ProcessManager();
			const expandedCwd = `${os.homedir()}/Documents/x`;

			const result = pm.spawn({
				sessionId: 'child-expanded-cwd',
				toolType: 'claude-code',
				cwd: '~/Documents/x',
				command: 'claude',
				args: [],
				requiresPty: false,
				prompt: 'summarize this repository',
			});

			expect(result).toEqual({ pid: 24680, success: true });
			expect(mockPtySpawn).not.toHaveBeenCalled();
			expect(mockChildSpawn).toHaveBeenCalledOnce();
			const [, , options] = mockChildSpawn.mock.calls[0] as ChildSpawnCall;
			expect(options.cwd).toBe(expandedCwd);
			expect(pm.get('child-expanded-cwd')?.cwd).toBe(expandedCwd);
		});
	});
});
describe('cwd', () => {
	describe('unusableDirectoryReason', () => {
		let root: string;

		beforeEach(() => {
			root = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-cwd-'));
			fs.writeFileSync(path.join(root, 'file'), '');
		});

		afterEach(() => {
			fs.rmSync(root, { recursive: true, force: true });
		});

		it('accepts a directory and an absent path', () => {
			expect(unusableDirectoryReason(root, 'Config dir')).toBeNull();
			expect(unusableDirectoryReason(undefined, 'Config dir')).toBeNull();
			expect(unusableDirectoryReason('', 'Config dir')).toBeNull();
		});

		it('names the directory by its label', () => {
			const missing = path.join(root, 'gone');
			const file = path.join(root, 'file');
			expect(unusableDirectoryReason(missing, 'Config dir')).toBe(
				`Config dir does not exist: ${missing}`
			);
			expect(unusableDirectoryReason(file, 'Config dir')).toBe(
				`Config dir is not a directory: ${file}`
			);
		});

		it('is what unusableCwdReason reports for a working directory', () => {
			const missing = path.join(root, 'gone');
			expect(source0_unusableCwdReason(missing)).toBe(
				`Working directory does not exist: ${missing}`
			);
		});
	});
});
