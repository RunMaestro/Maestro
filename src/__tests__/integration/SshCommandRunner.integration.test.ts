import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SshRemoteConfig } from '../../shared/types';

const mocks = vi.hoisted(() => ({
	spawn: vi.fn(),
	resolveSshPath: vi.fn(),
	getExpandedEnv: vi.fn(),
	matchSshErrorPattern: vi.fn(),
	logger: {
		debug: vi.fn(),
		error: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
	},
}));

vi.mock('child_process', () => ({
	default: { spawn: mocks.spawn },
	spawn: mocks.spawn,
}));

vi.mock('../../main/utils/logger', () => ({
	logger: mocks.logger,
}));

vi.mock('../../main/parsers/error-patterns', () => ({
	matchSshErrorPattern: mocks.matchSshErrorPattern,
}));

vi.mock('../../main/utils/cliDetection', () => ({
	resolveSshPath: mocks.resolveSshPath,
	getExpandedEnv: mocks.getExpandedEnv,
}));

import { SshCommandRunner } from '../../main/process-manager/runners/SshCommandRunner';

function createConfig(overrides: Partial<SshRemoteConfig> = {}): SshRemoteConfig {
	return {
		id: 'remote-1',
		name: 'Build Box',
		host: 'build.example.com',
		port: 2200,
		username: 'builder',
		privateKeyPath: '~/.ssh/id_ed25519',
		enabled: true,
		remoteEnv: { REMOTE_TOKEN: "it's-secret", '1INVALID': 'skip-me' },
		...overrides,
	};
}

function createChildProcess() {
	const child = new EventEmitter() as EventEmitter & {
		stdout: EventEmitter;
		stderr: EventEmitter;
	};
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	return child;
}

describe('SshCommandRunner', () => {
	const originalHome = process.env.HOME;
	const originalSshAuthSock = process.env.SSH_AUTH_SOCK;

	beforeEach(() => {
		vi.clearAllMocks();
		process.env.HOME = '/home/tester';
		process.env.SSH_AUTH_SOCK = '/tmp/ssh-agent.sock';
		mocks.resolveSshPath.mockResolvedValue('/usr/bin/ssh');
		mocks.getExpandedEnv.mockReturnValue({ PATH: '/mock/bin', LANG: 'C' });
		mocks.matchSshErrorPattern.mockReturnValue(null);
	});

	afterEach(() => {
		process.env.HOME = originalHome;
		process.env.SSH_AUTH_SOCK = originalSshAuthSock;
	});

	it('spawns ssh with key, port, user, escaped env, and relays child events', async () => {
		const child = createChildProcess();
		mocks.spawn.mockReturnValue(child);
		mocks.matchSshErrorPattern.mockReturnValueOnce({
			type: 'auth',
			message: 'Permission denied',
		});
		const emitter = new EventEmitter();
		const dataEvents: string[] = [];
		const stderrEvents: string[] = [];
		const exitEvents: number[] = [];
		emitter.on('data', (_sessionId: string, output: string) => dataEvents.push(output));
		emitter.on('stderr', (_sessionId: string, output: string) => stderrEvents.push(output));
		emitter.on('command-exit', (_sessionId: string, code: number) => exitEvents.push(code));

		const runner = new SshCommandRunner(emitter);
		const resultPromise = runner.run('session-1', 'echo "hello"', "/srv/app's", createConfig(), {
			SHELL_FLAG: '1',
		});

		await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled());
		const [sshPath, sshArgs, spawnOptions] = mocks.spawn.mock.calls[0];
		expect(sshPath).toBe('/usr/bin/ssh');
		expect(sshArgs).toEqual(
			expect.arrayContaining([
				'-T',
				'-i',
				'/home/tester/.ssh/id_ed25519',
				'-o',
				'BatchMode=yes',
				'-o',
				'StrictHostKeyChecking=accept-new',
				'-o',
				'ConnectTimeout=10',
				'-o',
				'ClearAllForwardings=yes',
				'-o',
				'RequestTTY=no',
				'-p',
				'2200',
				'builder@build.example.com',
			])
		);
		expect(spawnOptions.env).toMatchObject({
			PATH: '/mock/bin',
			LANG: 'C',
			HOME: '/home/tester',
			SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
		});
		const wrappedRemoteCommand = sshArgs.at(-1) as string;
		expect(wrappedRemoteCommand).toContain('/srv/app');
		expect(wrappedRemoteCommand).toContain('REMOTE_TOKEN=');
		expect(wrappedRemoteCommand).toContain('s-secret');
		expect(wrappedRemoteCommand).toContain("SHELL_FLAG='1'");
		expect(wrappedRemoteCommand).not.toContain('1INVALID');
		expect(wrappedRemoteCommand).toContain('echo');
		expect(wrappedRemoteCommand).toContain('hello');

		child.stdout.emit('data', Buffer.from('hello from remote\n'));
		child.stderr.emit('data', Buffer.from('Permission denied (publickey).\n'));
		child.emit('exit', 7);

		await expect(resultPromise).resolves.toEqual({ exitCode: 7 });
		expect(dataEvents).toEqual(['hello from remote\n']);
		expect(stderrEvents).toEqual(['Permission denied (publickey).\n']);
		expect(exitEvents).toEqual([7]);
		expect(mocks.matchSshErrorPattern).toHaveBeenCalledWith('Permission denied (publickey).\n');
		expect(mocks.logger.warn).toHaveBeenCalledWith(
			'[ProcessManager] SSH error detected in terminal command',
			'ProcessManager',
			expect.objectContaining({ sessionId: 'session-1', errorType: 'auth' })
		);
	});

	it('omits optional key, port, env, and username arguments when config does not require them', async () => {
		const child = createChildProcess();
		mocks.spawn.mockReturnValue(child);
		const emitter = new EventEmitter();
		const dataEvents: string[] = [];
		const stderrEvents: string[] = [];
		const exitEvents: number[] = [];
		emitter.on('data', (_sessionId: string, output: string) => dataEvents.push(output));
		emitter.on('stderr', (_sessionId: string, output: string) => stderrEvents.push(output));
		emitter.on('command-exit', (_sessionId: string, code: number) => exitEvents.push(code));

		const runner = new SshCommandRunner(emitter);
		const resultPromise = runner.run(
			'session-2',
			'pwd',
			'',
			createConfig({
				privateKeyPath: '   ',
				useSshConfig: true,
				port: 22,
				username: '   ',
				remoteEnv: undefined,
			})
		);

		await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled());
		const [, sshArgs] = mocks.spawn.mock.calls[0];
		expect(sshArgs).not.toContain('-i');
		expect(sshArgs).not.toContain('-p');
		expect(sshArgs).toContain('build.example.com');
		expect(sshArgs).not.toContain('builder@build.example.com');
		const wrappedRemoteCommand = sshArgs.at(-1) as string;
		expect(wrappedRemoteCommand).toContain("cd '~'");
		expect(wrappedRemoteCommand).not.toContain('REMOTE_TOKEN');

		mocks.logger.warn.mockClear();
		mocks.matchSshErrorPattern.mockReturnValue(null);
		child.stdout.emit('data', Buffer.from('   \n'));
		child.stderr.emit('data', Buffer.from('warning only\n'));
		child.emit('exit', null);

		await expect(resultPromise).resolves.toEqual({ exitCode: 0 });
		expect(dataEvents).toEqual([]);
		expect(stderrEvents).toEqual(['warning only\n']);
		expect(exitEvents).toEqual([0]);
		expect(mocks.matchSshErrorPattern).toHaveBeenCalledWith('warning only\n');
	});

	it('emits stderr and resolves with exit code 1 when ssh spawn fails', async () => {
		const child = createChildProcess();
		mocks.spawn.mockReturnValue(child);
		const emitter = new EventEmitter();
		const stderrEvents: string[] = [];
		const exitEvents: number[] = [];
		emitter.on('stderr', (_sessionId: string, output: string) => stderrEvents.push(output));
		emitter.on('command-exit', (_sessionId: string, code: number) => exitEvents.push(code));

		const runner = new SshCommandRunner(emitter);
		const resultPromise = runner.run('session-3', 'uptime', '/srv/app', createConfig());

		await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled());
		child.emit('error', new Error('spawn EACCES'));

		await expect(resultPromise).resolves.toEqual({ exitCode: 1 });
		expect(stderrEvents).toEqual(['SSH Error: spawn EACCES']);
		expect(exitEvents).toEqual([1]);
		expect(mocks.logger.error).toHaveBeenCalledWith(
			'[ProcessManager] runCommandViaSsh error',
			'ProcessManager',
			{ sessionId: 'session-3', error: 'spawn EACCES' }
		);
	});
});
