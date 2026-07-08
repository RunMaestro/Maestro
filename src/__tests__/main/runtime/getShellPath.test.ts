import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());
const isWindowsMock = vi.hoisted(() => vi.fn());

vi.mock('child_process', () => ({
	default: { spawn: spawnMock },
	spawn: spawnMock,
}));

vi.mock('../../../shared/platformDetection', () => ({
	isWindows: isWindowsMock,
}));

import getShellPath, {
	clearShellPathCache,
	getShellPath as namedGetShellPath,
	refreshShellPath,
} from '../../../main/runtime/getShellPath';

type MockChildProcess = EventEmitter & {
	stdout?: EventEmitter;
	stderr?: EventEmitter;
	kill: ReturnType<typeof vi.fn>;
};

const originalPath = process.env.PATH;
const originalShell = process.env.SHELL;

function restoreEnv(): void {
	if (originalPath === undefined) {
		delete process.env.PATH;
	} else {
		process.env.PATH = originalPath;
	}

	if (originalShell === undefined) {
		delete process.env.SHELL;
	} else {
		process.env.SHELL = originalShell;
	}
}

function createChildProcess(
	options: {
		withStdout?: boolean;
		withStderr?: boolean;
		kill?: () => void;
	} = {}
): MockChildProcess {
	const child = new EventEmitter() as MockChildProcess;
	if (options.withStdout !== false) {
		child.stdout = new EventEmitter();
	}
	if (options.withStderr !== false) {
		child.stderr = new EventEmitter();
	}
	child.kill = vi.fn(options.kill ?? (() => undefined));
	return child;
}

describe('getShellPath runtime probing', () => {
	beforeEach(() => {
		clearShellPathCache();
		spawnMock.mockReset();
		isWindowsMock.mockReset();
		isWindowsMock.mockReturnValue(false);
		restoreEnv();
	});

	afterEach(() => {
		clearShellPathCache();
		vi.useRealTimers();
		restoreEnv();
	});

	it('uses PATH directly on Windows and avoids spawning a POSIX shell', async () => {
		isWindowsMock.mockReturnValue(true);
		process.env.PATH = 'C:\\Tools;C:\\Windows';

		await expect(refreshShellPath()).resolves.toBe('C:\\Tools;C:\\Windows');
		await expect(getShellPath()).resolves.toBe('C:\\Tools;C:\\Windows');

		expect(spawnMock).not.toHaveBeenCalled();
	});

	it('returns an empty string on Windows when PATH is missing', async () => {
		isWindowsMock.mockReturnValue(true);
		delete process.env.PATH;

		await expect(refreshShellPath()).resolves.toBe('');
		expect(spawnMock).not.toHaveBeenCalled();
	});

	it('spawns zsh as a login interactive shell and caches concurrent refreshes', async () => {
		process.env.SHELL = '/bin/zsh';
		const child = createChildProcess();
		spawnMock.mockReturnValue(child);

		const first = refreshShellPath();
		const second = refreshShellPath();

		expect(spawnMock).toHaveBeenCalledTimes(1);
		expect(spawnMock).toHaveBeenCalledWith('/bin/zsh', ['-l', '-i', '-c', 'printf "%s" "$PATH"'], {
			stdio: ['ignore', 'pipe', 'pipe'],
		});

		child.stdout?.emit('data', ' /opt/bin:');
		child.stdout?.emit('data', '/usr/local/bin \n');
		child.emit('close', 0);

		await expect(first).resolves.toBe('/opt/bin:/usr/local/bin');
		await expect(second).resolves.toBe('/opt/bin:/usr/local/bin');
		await expect(namedGetShellPath()).resolves.toBe('/opt/bin:/usr/local/bin');
		expect(spawnMock).toHaveBeenCalledTimes(1);
	});

	it('uses bash as the default non-Windows shell when SHELL is unset', async () => {
		delete process.env.SHELL;
		const child = createChildProcess();
		spawnMock.mockReturnValue(child);

		const promise = refreshShellPath();

		expect(spawnMock).toHaveBeenCalledWith('/bin/bash', ['-l', '-c', 'printf "%s" "$PATH"'], {
			stdio: ['ignore', 'pipe', 'pipe'],
		});

		child.stdout?.emit('data', '/usr/bin');
		child.emit('close', 0);

		await expect(promise).resolves.toBe('/usr/bin');
	});

	it('refreshes through the default export when no shell PATH is cached', async () => {
		const child = createChildProcess();
		spawnMock.mockReturnValue(child);

		const promise = getShellPath();
		child.stdout?.emit('data', '/fresh/bin');
		child.emit('close', 0);

		await expect(promise).resolves.toBe('/fresh/bin');
		expect(spawnMock).toHaveBeenCalledTimes(1);
	});

	it('treats a successful shell with no stdout stream as an empty PATH', async () => {
		const child = createChildProcess({ withStdout: false, withStderr: false });
		spawnMock.mockReturnValue(child);

		const promise = refreshShellPath();
		child.emit('close', 0);

		await expect(promise).resolves.toBe('');
	});

	it('rejects with stderr when the shell exits unsuccessfully', async () => {
		const child = createChildProcess();
		spawnMock.mockReturnValue(child);

		const promise = refreshShellPath();
		child.stderr?.emit('data', 'shell startup failed');
		child.emit('close', 2);

		await expect(promise).rejects.toThrow('shell startup failed');
	});

	it('rejects with a fallback message when the shell exits without stderr', async () => {
		const child = createChildProcess();
		spawnMock.mockReturnValue(child);

		const promise = refreshShellPath();
		child.emit('close', 127);

		await expect(promise).rejects.toThrow('Shell exited with code 127');
	});

	it('clears the in-flight cache after spawn errors so later calls can retry', async () => {
		const failingChild = createChildProcess();
		const succeedingChild = createChildProcess();
		spawnMock.mockReturnValueOnce(failingChild).mockReturnValueOnce(succeedingChild);

		const failedProbe = refreshShellPath();
		failingChild.emit('error', new Error('spawn failed'));

		await expect(failedProbe).rejects.toThrow('spawn failed');

		const retry = refreshShellPath();
		succeedingChild.stdout?.emit('data', '/retry/bin');
		succeedingChild.emit('close', 0);

		await expect(retry).resolves.toBe('/retry/bin');
		expect(spawnMock).toHaveBeenCalledTimes(2);
	});

	it('kills and rejects a shell probe that times out', async () => {
		vi.useFakeTimers();
		const child = createChildProcess();
		spawnMock.mockReturnValue(child);

		const promise = refreshShellPath();
		const assertion = expect(promise).rejects.toThrow('Timed out reading shell PATH');

		await vi.advanceTimersByTimeAsync(2000);

		await assertion;
		expect(child.kill).toHaveBeenCalledTimes(1);
	});

	it('ignores kill failures while rejecting a timed-out shell probe', async () => {
		vi.useFakeTimers();
		const child = createChildProcess({
			kill: () => {
				throw new Error('already exited');
			},
		});
		spawnMock.mockReturnValue(child);

		const promise = refreshShellPath();
		const assertion = expect(promise).rejects.toThrow('Timed out reading shell PATH');

		await vi.advanceTimersByTimeAsync(2000);

		await assertion;
		expect(child.kill).toHaveBeenCalledTimes(1);
	});
});
