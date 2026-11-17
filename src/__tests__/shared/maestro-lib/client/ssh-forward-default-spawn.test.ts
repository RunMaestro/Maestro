/**
 * The Federation SSH path through its real default seams: `SshForwardManager` with no injected
 * `discover`, `control` or `spawn`, so discovery and the master's `ssh -O` requests run over the
 * shared exec helper and the ControlMaster runs on `child_process.spawn`. Only those two process
 * boundaries (and the ssh binary lookup) are mocked; everything between them is production code.
 * The control socket directory is injected so the fake clock never races real file I/O.
 */

import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SshRemoteConfig } from '../../../../shared/types';

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

import {
	SshForwardManager,
	buildSshForwardArgs,
	buildSshForwardMasterArgs,
} from '../../../../shared/maestro-lib/client/ssh-forward';
import { buildSshConnectionArgs } from '../../../../shared/sshConnection';

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
		controlSocket: async () => ({ path: `/tmp/mfwd-${nextSocket++}/ssh`, dispose: async () => {} }),
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
		expect(requests.map(([, args]) => args[args.indexOf('-O') + 1])).toEqual(['check', 'forward']);
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
