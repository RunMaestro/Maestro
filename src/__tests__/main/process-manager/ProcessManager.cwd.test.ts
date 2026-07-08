import { EventEmitter } from 'events';
import * as os from 'os';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChildProcess, SpawnOptionsWithoutStdio } from 'child_process';

const { mockPtySpawn, mockChildSpawn, mockGetBridgeSocketPath } = vi.hoisted(() => ({
	mockPtySpawn: vi.fn(),
	mockChildSpawn: vi.fn(),
	mockGetBridgeSocketPath: vi.fn(() => '/tmp/maestro-test-coworking.sock'),
}));

vi.mock('node-pty', () => ({
	spawn: mockPtySpawn,
}));

vi.mock('child_process', () => ({
	spawn: mockChildSpawn,
	execFile: vi.fn(),
	execFileSync: vi.fn(),
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

vi.mock('../../../shared/platformDetection', () => ({
	isWindows: () => false,
}));

vi.mock('../../../main/coworking/coworking-socket-path', () => ({
	getBridgeSocketPath: () => mockGetBridgeSocketPath(),
}));

import { ProcessManager } from '../../../main/process-manager';

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
	beforeEach(() => {
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
