// Source: src/__tests__/shared/maestro-lib/client/ssh-forward.test.ts
// Source: src/__tests__/shared/maestro-lib/client/ssh-forward-default-spawn.test.ts
// Source: src/__tests__/shared/maestro-lib/client/local-port.test.ts
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { statSync } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach } from 'vitest';
import { beforeEach } from 'vitest';
import { describe } from 'vitest';
import { expect } from 'vitest';
import { it } from 'vitest';
import { vi } from 'vitest';
import { SshForwardError } from '../../../../shared/maestro-lib/client/ssh-forward';
import { SshForwardManager } from '../../../../shared/maestro-lib/client/ssh-forward';
import { buildSshForwardArgs } from '../../../../shared/maestro-lib/client/ssh-forward';
import { buildSshForwardMasterArgs } from '../../../../shared/maestro-lib/client/ssh-forward';
import { buildSshMuxArgs } from '../../../../shared/maestro-lib/client/ssh-forward';
import { createForwardControlSocket } from '../../../../shared/maestro-lib/client/ssh-forward';
import { ownForwardBindFailed } from '../../../../shared/maestro-lib/client/ssh-forward';
import type { ForwardControlSocket } from '../../../../shared/maestro-lib/client/ssh-forward';
import type { SshForwardControl } from '../../../../shared/maestro-lib/client/ssh-forward';
import type { SshForwardManagerOptions } from '../../../../shared/maestro-lib/client/ssh-forward';
import type { SshForwardSpawn } from '../../../../shared/maestro-lib/client/ssh-forward';
import type { SshForwardState } from '../../../../shared/maestro-lib/client/ssh-forward';
import type { RemoteHostDiscovery } from '../../../../shared/maestro-lib/client/remote-discovery';
import { buildSshConnectionArgs } from '../../../../shared/sshConnection';
import type { SshRemoteConfig } from '../../../../shared/types';
import net from 'net';
import { availableLocalPort } from '../../../../shared/maestro-lib/client/local-port';
import { waitForLocalPort } from '../../../../shared/maestro-lib/client/local-port';
const { spawnMock, execMock } = vi.hoisted(() => ({
	spawnMock: vi.fn(),
	execMock: vi.fn(),
}));

vi.mock('child_process', async (importOriginal) => ({
	...(await importOriginal<typeof import('child_process')>()),
	spawn: spawnMock,
}));
vi.mock('../../../../shared/maestro-lib/launch/exec-file', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../../shared/maestro-lib/launch/exec-file')>()),
	execFileNoThrow: execMock,
}));
vi.mock('../../../../shared/maestro-lib/launch/ssh-path', () => ({
	resolveSshPath: vi.fn(async () => '/usr/bin/ssh'),
	detectSshPath: vi.fn(async () => '/usr/bin/ssh'),
}));
describe('ssh-forward', () => {
	const remote: SshRemoteConfig = {
		id: 'r1',
		name: 'Build box',
		host: 'build.example.com',
		port: 22,
		username: 'pedram',
		privateKeyPath: '',
		enabled: true,
		federation: true,
	};

	const TOKEN = 'tok-6f1d0c2a-secret-path-token';
	const SECRET = 'cli-secret-9a8b7c6d5e4f';

	/** A child process stand-in: `kill()` exits it unless `holdOnKill` is set. */
	class FakeChild extends EventEmitter {
		exitCode: number | null = null;
		signalCode: NodeJS.Signals | null = null;
		readonly stderr = new EventEmitter();
		readonly signals: string[] = [];
		holdOnKill = false;

		kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
			this.signals.push(signal);
			if (!this.holdOnKill) this.exit(null, signal);
			return true;
		}

		exit(code: number | null, signal: NodeJS.Signals | null = null): void {
			if (this.exitCode !== null || this.signalCode !== null) return;
			this.exitCode = code;
			this.signalCode = signal;
			this.emit('exit', code, signal);
		}

		writeStderr(text: string): void {
			this.stderr.emit('data', Buffer.from(text));
		}
	}

	function running(port: number): RemoteHostDiscovery {
		return {
			installed: true,
			running: true,
			launcher: 'path',
			cliVersion: '1.2.3',
			endpoint: { port, token: TOKEN, cliSecret: SECRET, version: '1.2.3', pid: 4242 },
		};
	}

	interface FakeSocket extends ForwardControlSocket {
		dispose: ReturnType<typeof vi.fn<() => Promise<void>>>;
	}

	interface Harness {
		manager: SshForwardManager;
		discover: ReturnType<typeof vi.fn<(remote: SshRemoteConfig) => Promise<RemoteHostDiscovery>>>;
		spawn: ReturnType<typeof vi.fn<SshForwardSpawn>>;
		children: FakeChild[];
		waitForPort: ReturnType<typeof vi.fn<NonNullable<SshForwardManagerOptions['waitForPort']>>>;
		/** `ssh -O` requests; every one succeeds unless a test says otherwise. */
		control: ReturnType<typeof vi.fn<SshForwardControl>>;
		sockets: FakeSocket[];
	}

	function harness(
		answers: Array<RemoteHostDiscovery | Error>,
		overrides: Partial<SshForwardManagerOptions> = {}
	): Harness {
		const children: FakeChild[] = [];
		let nextPort = 50000;
		const discover = vi.fn(async (_remote: SshRemoteConfig) => {
			const answer = answers.length > 1 ? answers.shift()! : answers[0];
			if (answer instanceof Error) throw answer;
			return answer;
		});
		const spawn = vi.fn<SshForwardSpawn>(() => {
			const child = new FakeChild();
			children.push(child);
			return child as unknown as ChildProcess;
		});
		const waitForPort = vi.fn<NonNullable<SshForwardManagerOptions['waitForPort']>>(
			async () => true
		);
		const control = vi.fn<SshForwardControl>(async () => ({ exitCode: 0, stderr: '' }));
		const sockets: FakeSocket[] = [];
		const controlSocket = async () => {
			const socket: FakeSocket = {
				path: `/tmp/mfwd-${sockets.length}/ssh`,
				dispose: vi.fn(async () => {}),
			};
			sockets.push(socket);
			return socket;
		};
		const manager = new SshForwardManager({
			discover,
			spawn,
			waitForPort,
			control,
			controlSocket,
			useControlMaster: true,
			sshPath: '/usr/bin/ssh',
			allocatePort: async () => nextPort++,
			backoffInitialMs: 1000,
			backoffMaxMs: 8000,
			stopGraceMs: 100,
			...overrides,
		});
		return { manager, discover, spawn, children, waitForPort, control, sockets };
	}

	/** Let pending promise chains run without moving the clock. */
	const settle = () => vi.advanceTimersByTimeAsync(0);

	/** The `-L` spec of every `ssh -O forward` request, in order. */
	function forwardSpecs(h: Harness): string[] {
		return h.control.mock.calls
			.map(([, args]) => args)
			.filter((args) => args[args.indexOf('-O') + 1] === 'forward')
			.map((args) => args[args.indexOf('-L') + 1]);
	}

	/** The `-O` operation of every request, in order. */
	function controlOps(h: Harness): string[] {
		return h.control.mock.calls.map(([, args]) => args[args.indexOf('-O') + 1]);
	}

	beforeEach(() => {
		vi.useFakeTimers();
		// No jitter, so backoff delays are exact.
		vi.spyOn(Math, 'random').mockReturnValue(0.5);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	describe('buildSshForwardMasterArgs', () => {
		it('opens the connection with no forwards, on a private ControlMaster socket', () => {
			const args = buildSshForwardMasterArgs(remote, '/tmp/mfwd-abc/ssh');
			expect(args[0]).toBe('-N');
			expect(args).not.toContain('-L');
			expect(args).toEqual(
				expect.arrayContaining([
					'ClearAllForwardings=yes',
					'ControlMaster=yes',
					'ControlPersist=no',
					'LogLevel=INFO',
					'ServerAliveInterval=15',
				])
			);
			expect(args[args.indexOf('-S') + 1]).toBe('/tmp/mfwd-abc/ssh');
			expect(args).not.toContain('ClearAllForwardings=no');
			const connection = buildSshConnectionArgs(remote);
			expect(args.slice(-connection.length)).toEqual(connection);
		});

		it("holds ClearAllForwardings and the master against the remote's own options", () => {
			const args = buildSshForwardMasterArgs(
				{
					...remote,
					sshOptions: {
						ClearAllForwardings: 'no',
						ControlMaster: 'auto',
						ControlPath: '~/.ssh/cm',
					},
				},
				'/tmp/mfwd-abc/ssh'
			);
			// First-wins: the forward's options precede the remote's.
			expect(args.indexOf('ClearAllForwardings=yes')).toBeLessThan(
				args.indexOf('ClearAllForwardings=no')
			);
			expect(args.indexOf('ControlMaster=yes')).toBeLessThan(args.indexOf('ControlMaster=auto'));
		});

		it('doubles a % in the socket path, which ssh would expand as a token', () => {
			const args = buildSshForwardMasterArgs(remote, '/tmp/50%/ssh');
			expect(args[args.indexOf('-S') + 1]).toBe('/tmp/50%%/ssh');
		});
	});

	describe('buildSshMuxArgs', () => {
		it('checks the master without reading any ssh config', () => {
			expect(buildSshMuxArgs(remote, '/tmp/mfwd-abc/ssh', { op: 'check' })).toEqual([
				'-F',
				'none',
				'-S',
				'/tmp/mfwd-abc/ssh',
				'-O',
				'check',
				'build.example.com',
			]);
		});

		it("asks the master for the forward's own port only", () => {
			expect(
				buildSshMuxArgs(remote, '/tmp/mfwd-abc/ssh', {
					op: 'forward',
					localPort: 50000,
					remotePort: 4001,
				})
			).toEqual([
				'-F',
				'none',
				'-S',
				'/tmp/mfwd-abc/ssh',
				'-O',
				'forward',
				'-L',
				'127.0.0.1:50000:127.0.0.1:4001',
				'build.example.com',
			]);
		});

		it('refuses a port outside 1-65535', () => {
			expect(() =>
				buildSshMuxArgs(remote, '/tmp/s', { op: 'forward', localPort: 50000, remotePort: 0 })
			).toThrow(/Invalid forward port/);
		});
	});

	describe('createForwardControlSocket', () => {
		it('makes a private directory per forward and removes it on dispose', async () => {
			const first = await createForwardControlSocket();
			const second = await createForwardControlSocket();
			try {
				const dir = path.dirname(first.path);
				expect(path.basename(first.path)).toBe('ssh');
				expect(dir.startsWith(path.join(os.tmpdir(), 'mfwd-'))).toBe(true);
				expect(path.dirname(second.path)).not.toBe(dir);
				if (process.platform !== 'win32') expect(statSync(dir).mode & 0o777).toBe(0o700);
				await first.dispose();
				expect(existsSync(dir)).toBe(false);
			} finally {
				await first.dispose();
				await second.dispose();
			}
		});

		it.skipIf(process.platform === 'win32')(
			'falls back to /tmp when the temp folder would make the socket path too long',
			async () => {
				const socket = await createForwardControlSocket(`/var/${'x'.repeat(90)}`);
				try {
					expect(path.dirname(path.dirname(socket.path))).toBe('/tmp');
				} finally {
					await socket.dispose();
				}
			}
		);
	});

	describe('buildSshForwardArgs (Windows, no ControlMaster)', () => {
		it('puts the forward options before the remote connection args', () => {
			const args = buildSshForwardArgs(remote, 50000, 4001);
			expect(args[0]).toBe('-N');
			expect(args).toEqual(
				expect.arrayContaining([
					'ExitOnForwardFailure=no',
					'ClearAllForwardings=no',
					'ControlMaster=no',
					'ControlPath=none',
					'ServerAliveInterval=15',
				])
			);
			expect(args[args.indexOf('-L') + 1]).toBe('127.0.0.1:50000:127.0.0.1:4001');
			const connection = buildSshConnectionArgs(remote);
			expect(args.slice(-connection.length)).toEqual(connection);
			// First-wins: the forward's ClearAllForwardings=no precedes Maestro's default `yes`.
			expect(args.indexOf('ClearAllForwardings=no')).toBeLessThan(
				args.indexOf('ClearAllForwardings=yes')
			);
		});

		it("leaves keepalive to the remote's own ServerAliveInterval", () => {
			const args = buildSshForwardArgs(
				{ ...remote, sshOptions: { serveraliveinterval: '30' } },
				50000,
				4001
			);
			expect(args).not.toContain('ServerAliveInterval=15');
			expect(args).toContain('serveraliveinterval=30');
		});

		it('refuses a port outside 1-65535', () => {
			expect(() => buildSshForwardArgs(remote, 0, 4001)).toThrow(/Invalid forward port/);
			expect(() => buildSshForwardArgs(remote, 50000, 70000)).toThrow(/Invalid forward port/);
		});
	});

	describe('ownForwardBindFailed', () => {
		it("names only the forward's own port, in either of ssh's spellings", () => {
			expect(ownForwardBindFailed('bind [127.0.0.1]:50000: Address already in use\n', 50000)).toBe(
				true
			);
			expect(
				ownForwardBindFailed(
					'channel_setup_fwd_listener_tcpip: cannot listen to port: 50000',
					50000
				)
			).toBe(true);
		});

		it("ignores a LocalForward from the user's ssh config", () => {
			const configForward =
				'bind [127.0.0.1]:5901: Address already in use\n' +
				'channel_setup_fwd_listener_tcpip: cannot listen to port: 5901\n' +
				'Could not request local forwarding.\n';
			expect(ownForwardBindFailed(configForward, 50000)).toBe(false);
			// A port that merely starts with the same digits is a different port.
			expect(ownForwardBindFailed('cannot listen to port: 500001', 50000)).toBe(false);
		});
	});

	describe('SshForwardManager', () => {
		it('discovers, forwards, and hands back the local end with the host credentials', async () => {
			const h = harness([running(4001)]);
			const lease = h.manager.acquire(remote);
			const endpoint = await lease.ready();

			expect(h.discover).toHaveBeenCalledOnce();
			expect(h.spawn).toHaveBeenCalledOnce();
			expect(h.spawn.mock.calls[0][0]).toBe('/usr/bin/ssh');
			expect(h.spawn.mock.calls[0][1]).toEqual(
				buildSshForwardMasterArgs(remote, h.sockets[0].path)
			);
			expect(controlOps(h)).toEqual(['check', 'forward']);
			expect(h.control.mock.calls[1]).toEqual([
				'/usr/bin/ssh',
				buildSshMuxArgs(remote, h.sockets[0].path, {
					op: 'forward',
					localPort: 50000,
					remotePort: 4001,
				}),
			]);
			expect(forwardSpecs(h)).toEqual(['127.0.0.1:50000:127.0.0.1:4001']);
			expect(endpoint).toEqual({
				port: 50000,
				remotePort: 4001,
				token: TOKEN,
				cliSecret: SECRET,
				version: '1.2.3',
				pid: 4242,
			});
			expect(lease.state()).toEqual({ status: 'up', endpoint });
			await lease.release();
		});

		it('shares one forward between leases and stops it with the last release', async () => {
			const h = harness([running(4001)]);
			const first = h.manager.acquire(remote);
			const second = h.manager.acquire(remote);
			await Promise.all([first.ready(), second.ready()]);
			expect(h.discover).toHaveBeenCalledOnce();
			expect(h.spawn).toHaveBeenCalledOnce();

			await first.release();
			await first.release(); // a second release is a no-op, not a second decrement
			expect(h.children[0].signals).toEqual([]);
			expect(h.manager.activeRemoteIds()).toEqual(['r1']);

			await second.release();
			expect(h.children[0].signals).toEqual(['SIGTERM']);
			expect(second.state()).toEqual({ status: 'stopped' });
			expect(h.manager.activeRemoteIds()).toEqual([]);
		});

		it('adds the forward only once the master answers -O check', async () => {
			const h = harness([running(4001)]);
			h.control
				.mockResolvedValueOnce({ exitCode: 255, stderr: 'Control socket connect: No such file\n' })
				.mockResolvedValueOnce({ exitCode: 255, stderr: 'Control socket connect: No such file\n' });
			const lease = h.manager.acquire(remote);
			await settle();
			expect(controlOps(h)).toEqual(['check']);
			expect(h.waitForPort).not.toHaveBeenCalled();

			await vi.advanceTimersByTimeAsync(250);
			expect(controlOps(h)).toEqual(['check', 'check']);
			await vi.advanceTimersByTimeAsync(250);
			expect(controlOps(h)).toEqual(['check', 'check', 'check', 'forward']);
			expect(await lease.ready()).toMatchObject({ port: 50000, remotePort: 4001 });
			await lease.release();
		});

		it('reports a refused -O forward as a forward failure and takes the master down', async () => {
			const h = harness([running(4001)]);
			h.control.mockImplementation(async (_command, args) =>
				args.includes('forward')
					? {
							exitCode: 255,
							stderr: 'mux_client_forward: forwarding request failed: Port forwarding failed\n',
						}
					: { exitCode: 0, stderr: '' }
			);
			const lease = h.manager.acquire(remote);
			const error = (await lease.ready().catch((e: unknown) => e)) as SshForwardError;
			expect(error).toBeInstanceOf(SshForwardError);
			expect(error.code).toBe('forward-failed');
			expect(error.message).toContain('50000');
			expect(error.message).toContain('Port forwarding failed');
			expect(h.waitForPort).not.toHaveBeenCalled();
			expect(h.children[0].signals).toEqual(['SIGTERM']);
			await settle();
			expect(h.sockets[0].dispose).toHaveBeenCalledOnce();
			await lease.release();
		});

		it('fails an attempt whose master exits before it answers', async () => {
			const h = harness([running(4001)]);
			h.control.mockResolvedValue({
				exitCode: 255,
				stderr: 'Control socket connect: No such file\n',
			});
			const lease = h.manager.acquire(remote);
			await settle();
			h.children[0].writeStderr(
				'ssh: connect to host build.example.com port 22: Operation timed out\n'
			);
			h.children[0].exit(255);
			await vi.advanceTimersByTimeAsync(250);

			const error = (await lease.ready().catch((e: unknown) => e)) as SshForwardError;
			expect(error.code).toBe('forward-failed');
			expect(controlOps(h)).not.toContain('forward');
			await lease.release();
		});

		it('removes the control socket only after the master has exited', async () => {
			const h = harness([running(4001)]);
			const lease = h.manager.acquire(remote);
			await lease.ready();
			h.children[0].holdOnKill = true;

			const releasing = lease.release();
			await settle();
			expect(h.children[0].signals).toEqual(['SIGTERM']);
			expect(h.sockets[0].dispose).not.toHaveBeenCalled();

			h.children[0].exit(null, 'SIGTERM');
			await releasing;
			expect(h.sockets[0].dispose).toHaveBeenCalledOnce();
		});

		it('gives every restart its own control socket', async () => {
			const h = harness([running(4001), running(4002)]);
			const lease = h.manager.acquire(remote);
			await lease.ready();
			lease.restart();
			await settle();
			await lease.ready();

			expect(h.sockets.map((socket) => socket.path)).toEqual([
				'/tmp/mfwd-0/ssh',
				'/tmp/mfwd-1/ssh',
			]);
			expect(h.sockets[0].dispose).toHaveBeenCalledOnce();
			expect(h.sockets[1].dispose).not.toHaveBeenCalled();
			await lease.release();
			expect(h.sockets[1].dispose).toHaveBeenCalledOnce();
		});

		it('restarts a dropped forward with backoff and rediscovers the moved host port', async () => {
			const h = harness([running(4001), running(4002)]);
			const lease = h.manager.acquire(remote);
			await lease.ready();
			const states: SshForwardState[] = [];
			lease.onChange((state) => states.push(state));

			h.children[0].writeStderr('Connection to build.example.com closed by remote host.\n');
			h.children[0].exit(255);
			const down = lease.state();
			expect(down).toMatchObject({ status: 'down', attempt: 1, retryInMs: 1000 });
			expect((down as { error: SshForwardError }).error.code).toBe('forward-failed');
			expect(h.discover).toHaveBeenCalledOnce();

			await vi.advanceTimersByTimeAsync(1000);
			expect(h.discover).toHaveBeenCalledTimes(2);
			expect(h.spawn).toHaveBeenCalledTimes(2);
			expect(forwardSpecs(h)[1]).toBe('127.0.0.1:50001:127.0.0.1:4002');
			expect(await lease.ready()).toMatchObject({ port: 50001, remotePort: 4002 });
			expect(states.map((state) => state.status)).toEqual(['down', 'starting', 'up']);
			await lease.release();
		});

		it('restarts when ssh reports the forwarded port refusing (the host moved)', async () => {
			const h = harness([running(4001), running(4555)]);
			const lease = h.manager.acquire(remote);
			await lease.ready();

			h.children[0].writeStderr('channel 3: open failed: connect failed: Connection refused\n');
			expect(lease.state()).toMatchObject({ status: 'down' });
			expect((lease.state() as { error: SshForwardError }).error.code).toBe('host-gone');
			expect(h.children[0].signals).toEqual(['SIGTERM']);

			await vi.advanceTimersByTimeAsync(1000);
			expect(await lease.ready()).toMatchObject({ remotePort: 4555 });
			await lease.release();
		});

		it('doubles the delay while the host is not running, up to the ceiling', async () => {
			const notRunning: RemoteHostDiscovery = { installed: true, running: false, launcher: 'path' };
			const h = harness([notRunning]);
			const lease = h.manager.acquire(remote);
			await expect(lease.ready()).rejects.toMatchObject({ code: 'not-running' });
			expect((lease.state() as { error: Error }).error.message).toContain(
				'maestro-cli remote-host start Build box'
			);

			const delays: number[] = [];
			for (let i = 0; i < 5; i++) {
				const state = lease.state() as { retryInMs: number };
				delays.push(state.retryInMs);
				await vi.advanceTimersByTimeAsync(state.retryInMs);
			}
			expect(delays).toEqual([1000, 2000, 4000, 8000, 8000]);
			expect(h.spawn).not.toHaveBeenCalled();
			await lease.release();
		});

		it('reports a remote with no maestro-cli with the install fix', async () => {
			const h = harness([{ installed: false, fix: 'Install Maestro on the remote.' }]);
			const lease = h.manager.acquire(remote);
			const error = await lease.ready().catch((e: unknown) => e);
			expect(error).toBeInstanceOf(SshForwardError);
			expect(error).toMatchObject({
				code: 'not-installed',
				message: 'Install Maestro on the remote.',
			});
			await lease.release();
		});

		it('fails an attempt whose ssh never listens, and keeps secrets out of the message', async () => {
			const h = harness([running(4001)]);
			h.waitForPort.mockImplementation(async (_port, { shouldStop }) => {
				h.children[0].writeStderr(`bind failed for ${TOKEN} ${'ab12'.repeat(16)}\n`);
				h.children[0].exit(255);
				return !shouldStop?.();
			});
			const lease = h.manager.acquire(remote);
			const error = (await lease.ready().catch((e: unknown) => e)) as SshForwardError;
			expect(error.code).toBe('forward-failed');
			expect(error.message).not.toContain('ab12'.repeat(16));
			expect(error.message).not.toContain(SECRET);
			await lease.release();
		});

		it('never dials again while the previous ssh is still exiting', async () => {
			const h = harness([running(4001), running(4002)]);
			const lease = h.manager.acquire(remote);
			await lease.ready();
			h.children[0].holdOnKill = true;

			lease.restart();
			await settle();
			expect(h.children[0].signals).toEqual(['SIGTERM']);
			expect(h.discover).toHaveBeenCalledOnce();

			h.children[0].exit(null, 'SIGTERM');
			await settle();
			expect(h.discover).toHaveBeenCalledTimes(2);
			expect(await lease.ready()).toMatchObject({ remotePort: 4002 });
			await lease.release();
		});

		it('waits for a released forward to stop before a new lease dials the same remote', async () => {
			const h = harness([running(4001)]);
			const first = h.manager.acquire(remote);
			await first.ready();
			h.children[0].holdOnKill = true;
			const releasing = first.release();
			await settle();

			const second = h.manager.acquire(remote);
			await settle();
			expect(h.discover).toHaveBeenCalledOnce();

			h.children[0].exit(null, 'SIGTERM');
			await releasing;
			await settle();
			expect(h.discover).toHaveBeenCalledTimes(2);
			await second.ready();
			await second.release();
		});

		it('restart() skips a pending backoff', async () => {
			const h = harness([new Error('ssh down'), running(4001)]);
			const lease = h.manager.acquire(remote);
			await expect(lease.ready()).rejects.toThrow('ssh down');
			expect(lease.state()).toMatchObject({ status: 'down', retryInMs: 1000 });

			lease.restart();
			await settle();
			expect(await lease.ready()).toMatchObject({ remotePort: 4001 });
			await lease.release();
		});

		it('dispose stops every forward and refuses later acquires', async () => {
			const h = harness([running(4001)]);
			const lease = h.manager.acquire(remote);
			const other = h.manager.acquire({ ...remote, id: 'r2', name: 'Other' });
			await Promise.all([lease.ready(), other.ready()]);

			await h.manager.dispose();
			expect(h.children.map((child) => child.signals)).toEqual([['SIGTERM'], ['SIGTERM']]);
			expect(lease.state()).toEqual({ status: 'stopped' });
			expect(() => h.manager.acquire(remote)).toThrow(/disposed/);
		});
	});

	describe('SshForwardManager on Windows (no ControlMaster)', () => {
		it('forwards in one ssh with -L and sends no -O requests', async () => {
			const h = harness([running(4001)], { useControlMaster: false });
			const lease = h.manager.acquire(remote);
			expect(await lease.ready()).toMatchObject({ port: 50000, remotePort: 4001 });
			expect(h.spawn.mock.calls[0][1]).toEqual(buildSshForwardArgs(remote, 50000, 4001));
			expect(h.control).not.toHaveBeenCalled();
			expect(h.sockets).toEqual([]);
			await lease.release();
			expect(h.children[0].signals).toEqual(['SIGTERM']);
		});

		it("stays up when a LocalForward from the user's ssh config cannot bind", async () => {
			const h = harness([running(4001)], { useControlMaster: false });
			h.waitForPort.mockImplementation(async () => {
				h.children[0].writeStderr(
					'bind [127.0.0.1]:5901: Address already in use\n' +
						'channel_setup_fwd_listener_tcpip: cannot listen to port: 5901\n' +
						'Could not request local forwarding.\n'
				);
				return true;
			});
			const lease = h.manager.acquire(remote);
			expect(await lease.ready()).toMatchObject({ port: 50000, remotePort: 4001 });
			expect(lease.state()).toMatchObject({ status: 'up' });
			await lease.release();
		});

		it('fails an attempt whose own port cannot bind, even while ssh stays running', async () => {
			const h = harness([running(4001)], { useControlMaster: false });
			h.waitForPort.mockImplementation(async (_port, { shouldStop }) => {
				h.children[0].writeStderr('bind [127.0.0.1]:50000: Address already in use\n');
				return !shouldStop?.();
			});
			const lease = h.manager.acquire(remote);
			const error = (await lease.ready().catch((e: unknown) => e)) as SshForwardError;
			expect(error.code).toBe('forward-failed');
			expect(error.message).toContain('50000');
			await lease.release();
		});
	});
});
describe('ssh-forward-default-spawn', () => {
	const remote: SshRemoteConfig = {
		id: 'r1',
		name: 'Build box',
		host: 'build.example.com',
		port: 22,
		username: 'pedram',
		privateKeyPath: '',
		enabled: true,
		federation: true,
	};

	const TOKEN = 'tok-6f1d0c2a-secret-path-token';
	const SECRET = 'cli-secret-9a8b7c6d5e4f';

	class FakeChild extends EventEmitter {
		exitCode: number | null = null;
		signalCode: NodeJS.Signals | null = null;
		readonly stderr = new EventEmitter();
		readonly signals: string[] = [];

		kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
			this.signals.push(signal);
			this.exit(null, signal);
			return true;
		}

		exit(code: number | null, signal: NodeJS.Signals | null = null): void {
			if (this.exitCode !== null || this.signalCode !== null) return;
			this.exitCode = code;
			this.signalCode = signal;
			this.emit('exit', code, signal);
		}
	}

	/** What `maestro-cli host endpoint --json` prints on the remote, behind the script's markers. */
	function hostRunningOn(port: number) {
		const body = JSON.stringify({
			running: true,
			port,
			token: TOKEN,
			cliSecret: SECRET,
			version: '0.17.2',
			pid: 812,
		});
		return {
			stdout: `MAESTRO_REMOTE_CLI=path\nMAESTRO_REMOTE_CLI_VERSION=0.17.2\n${body}\n`,
			stderr: '',
			exitCode: 0,
		};
	}

	let children: FakeChild[];
	/** What discovery answers next; `ssh -O` requests always succeed. */
	let discovery: Array<ReturnType<typeof hostRunningOn>>;

	function isControlRequest(args: readonly string[]): boolean {
		return args.includes('-O');
	}

	/** The exec calls that were discovery, not requests to a master. */
	function discoveryCalls(): unknown[][] {
		return execMock.mock.calls.filter(([, args]) => !isControlRequest(args as string[]));
	}

	/** The `-L` spec of every `ssh -O forward` request, in order. */
	function forwardSpecs(): string[] {
		return execMock.mock.calls
			.map(([, args]) => args as string[])
			.filter((args) => args[args.indexOf('-O') + 1] === 'forward')
			.map((args) => args[args.indexOf('-L') + 1]);
	}

	function manager(options: { useControlMaster?: boolean } = {}): SshForwardManager {
		let nextPort = 51000;
		let nextSocket = 0;
		return new SshForwardManager({
			useControlMaster: options.useControlMaster ?? true,
			controlSocket: async () => ({
				path: `/tmp/mfwd-${nextSocket++}/ssh`,
				dispose: async () => {},
			}),
			allocatePort: async () => nextPort++,
			waitForPort: async () => true,
			backoffInitialMs: 1000,
			backoffMaxMs: 8000,
			stopGraceMs: 100,
		});
	}

	beforeEach(() => {
		vi.useFakeTimers();
		vi.spyOn(Math, 'random').mockReturnValue(0.5);
		children = [];
		spawnMock.mockReset().mockImplementation(() => {
			const child = new FakeChild();
			children.push(child);
			return child as unknown as ChildProcess;
		});
		discovery = [];
		execMock.mockReset().mockImplementation(async (_command: string, args: string[]) => {
			if (isControlRequest(args)) return { stdout: '', stderr: '', exitCode: 0 };
			return discovery.length > 1 ? discovery.shift() : discovery[0];
		});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	describe('SshForwardManager on the default seams', () => {
		it('discovers over one ssh exec, starts the master on spawn, then adds the forward', async () => {
			discovery = [hostRunningOn(4001)];
			const forwards = manager();
			const lease = forwards.acquire(remote);
			const endpoint = await lease.ready();

			expect(discoveryCalls()).toHaveLength(1);
			const [execCommand, execArgs, , execOptions] = execMock.mock.calls[0];
			expect(execCommand).toBe('/usr/bin/ssh');
			expect(execArgs.slice(0, -1)).toEqual(buildSshConnectionArgs(remote));
			expect(execArgs.at(-1)).toMatch(/host.*endpoint.*--json/);
			expect(execOptions).toMatchObject({ timeout: expect.any(Number) });

			expect(spawnMock).toHaveBeenCalledOnce();
			const [spawnCommand, spawnArgs, spawnOptions] = spawnMock.mock.calls[0];
			expect(spawnCommand).toBe('/usr/bin/ssh');
			expect(spawnArgs).toEqual(buildSshForwardMasterArgs(remote, '/tmp/mfwd-0/ssh'));
			expect(spawnOptions).toEqual({
				stdio: ['ignore', 'ignore', 'pipe'],
				windowsHide: true,
				shell: false,
			});

			// The master's requests ride the same exec helper, with a timeout of their own.
			const requests = execMock.mock.calls.slice(1);
			expect(requests.map(([, args]) => args[args.indexOf('-O') + 1])).toEqual([
				'check',
				'forward',
			]);
			expect(requests[0][3]).toMatchObject({ timeout: expect.any(Number) });
			expect(forwardSpecs()).toEqual(['127.0.0.1:51000:127.0.0.1:4001']);
			expect(endpoint).toMatchObject({ port: 51000, remotePort: 4001, token: TOKEN });
			await forwards.dispose();
		});

		it('runs one ssh with -L and no master requests where there is no ControlMaster', async () => {
			discovery = [hostRunningOn(4001)];
			const forwards = manager({ useControlMaster: false });
			const lease = forwards.acquire(remote);
			expect(await lease.ready()).toMatchObject({ port: 51000, remotePort: 4001 });

			expect(execMock).toHaveBeenCalledOnce();
			expect(spawnMock.mock.calls[0][1]).toEqual(buildSshForwardArgs(remote, 51000, 4001));
			await forwards.dispose();
		});

		it('shares one spawned forward between leases and kills it with the last release', async () => {
			discovery = [hostRunningOn(4001)];
			const forwards = manager();
			const first = forwards.acquire(remote);
			const second = forwards.acquire(remote);
			await Promise.all([first.ready(), second.ready()]);
			expect(discoveryCalls()).toHaveLength(1);
			expect(spawnMock).toHaveBeenCalledOnce();

			await first.release();
			expect(children[0].signals).toEqual([]);
			await second.release();
			expect(children[0].signals).toEqual(['SIGTERM']);
			await forwards.dispose();
		});

		it('re-runs discovery on restart and forwards to the port the host moved to', async () => {
			discovery = [hostRunningOn(4001), hostRunningOn(4777)];
			const forwards = manager();
			const lease = forwards.acquire(remote);
			await lease.ready();

			children[0].exit(255);
			expect(lease.state()).toMatchObject({ status: 'down', retryInMs: 1000 });
			await vi.advanceTimersByTimeAsync(1000);

			expect(discoveryCalls()).toHaveLength(2);
			expect(spawnMock).toHaveBeenCalledTimes(2);
			expect(forwardSpecs()[1]).toBe('127.0.0.1:51001:127.0.0.1:4777');
			expect(await lease.ready()).toMatchObject({ port: 51001, remotePort: 4777 });
			await forwards.dispose();
		});

		it('dispose kills the spawned ssh and refuses later acquires', async () => {
			discovery = [hostRunningOn(4001)];
			const forwards = manager();
			const lease = forwards.acquire(remote);
			await lease.ready();

			await forwards.dispose();
			expect(children[0].signals).toEqual(['SIGTERM']);
			expect(lease.state()).toEqual({ status: 'stopped' });
			expect(() => forwards.acquire(remote)).toThrow(/disposed/);
		});
	});
});
describe('local-port', () => {
	const servers: net.Server[] = [];

	afterEach(async () => {
		await Promise.all(
			servers
				.splice(0)
				.map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
		);
	});

	function listen(port: number): Promise<net.Server> {
		return new Promise((resolve, reject) => {
			const server = net.createServer((socket) => socket.destroy());
			server.once('error', reject);
			server.listen(port, '127.0.0.1', () => {
				servers.push(server);
				resolve(server);
			});
		});
	}

	describe('availableLocalPort', () => {
		it('returns a free port that can then be bound', async () => {
			const port = await availableLocalPort();
			expect(port).toBeGreaterThan(0);
			await expect(listen(port)).resolves.toBeDefined();
		});

		it('rejects a requested port that is taken', async () => {
			const port = await availableLocalPort();
			await listen(port);
			await expect(availableLocalPort(port)).rejects.toMatchObject({ code: 'EADDRINUSE' });
		});
	});

	describe('waitForLocalPort', () => {
		it('resolves true once something listens', async () => {
			const port = await availableLocalPort();
			const waiting = waitForLocalPort(port, { timeoutMs: 5000, intervalMs: 20 });
			setTimeout(() => void listen(port), 60);
			await expect(waiting).resolves.toBe(true);
		});

		it('resolves false on the timeout when nothing listens', async () => {
			const port = await availableLocalPort();
			await expect(waitForLocalPort(port, { timeoutMs: 100, intervalMs: 20 })).resolves.toBe(false);
		});

		it('resolves false at once when shouldStop says so', async () => {
			const port = await availableLocalPort();
			const started = Date.now();
			await expect(
				waitForLocalPort(port, { timeoutMs: 5000, shouldStop: () => true })
			).resolves.toBe(false);
			expect(Date.now() - started).toBeLessThan(1000);
		});
	});
});
