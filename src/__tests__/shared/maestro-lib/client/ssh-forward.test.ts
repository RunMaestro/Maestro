/**
 * Tests for src/shared/maestro-lib/client/ssh-forward.ts: one refcounted SSH forward per
 * Federation remote, restarted with backoff and a fresh discovery, never two ssh at once.
 */

import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	SshForwardError,
	SshForwardManager,
	buildSshForwardArgs,
	type SshForwardManagerOptions,
	type SshForwardSpawn,
	type SshForwardState,
} from '../../../../shared/maestro-lib/client/ssh-forward';
import type { RemoteHostDiscovery } from '../../../../shared/maestro-lib/client/remote-discovery';
import { buildSshConnectionArgs } from '../../../../shared/sshConnection';
import type { SshRemoteConfig } from '../../../../shared/types';

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

interface Harness {
	manager: SshForwardManager;
	discover: ReturnType<typeof vi.fn<(remote: SshRemoteConfig) => Promise<RemoteHostDiscovery>>>;
	spawn: ReturnType<typeof vi.fn<SshForwardSpawn>>;
	children: FakeChild[];
	waitForPort: ReturnType<typeof vi.fn<NonNullable<SshForwardManagerOptions['waitForPort']>>>;
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
	const waitForPort = vi.fn<NonNullable<SshForwardManagerOptions['waitForPort']>>(async () => true);
	const manager = new SshForwardManager({
		discover,
		spawn,
		waitForPort,
		sshPath: '/usr/bin/ssh',
		allocatePort: async () => nextPort++,
		backoffInitialMs: 1000,
		backoffMaxMs: 8000,
		stopGraceMs: 100,
		...overrides,
	});
	return { manager, discover, spawn, children, waitForPort };
}

/** Let pending promise chains run without moving the clock. */
const settle = () => vi.advanceTimersByTimeAsync(0);

function forwardSpec(h: Harness, call: number): string {
	const args = h.spawn.mock.calls[call][1];
	return args[args.indexOf('-L') + 1];
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

describe('buildSshForwardArgs', () => {
	it('puts the forward options before the remote connection args', () => {
		const args = buildSshForwardArgs(remote, 50000, 4001);
		expect(args[0]).toBe('-N');
		expect(args).toEqual(
			expect.arrayContaining([
				'ExitOnForwardFailure=yes',
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

describe('SshForwardManager', () => {
	it('discovers, forwards, and hands back the local end with the host credentials', async () => {
		const h = harness([running(4001)]);
		const lease = h.manager.acquire(remote);
		const endpoint = await lease.ready();

		expect(h.discover).toHaveBeenCalledOnce();
		expect(h.spawn).toHaveBeenCalledOnce();
		expect(h.spawn.mock.calls[0][0]).toBe('/usr/bin/ssh');
		expect(forwardSpec(h, 0)).toBe('127.0.0.1:50000:127.0.0.1:4001');
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
		expect(forwardSpec(h, 1)).toBe('127.0.0.1:50001:127.0.0.1:4002');
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
