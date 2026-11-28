/**
 * The one gate where Federation starts (`src/main/federation/hosting-gate.ts`): with hosted agents
 * off, Maestro starts nothing of Federation and opens no connection to any SSH remote on its own.
 *
 * The zero-call test boots both start sites exactly as the app does (`startFederationWhileHosting`
 * from `src/main/index.ts`, `registerFederationHandlers` from the IPC bootstrap) on their REAL
 * transport: the shared SSH forward manager and the real discovery. It asserts on the lowest seam,
 * `child_process`, so any ssh, scp, or helper process the mirror, the forward, the discovery, or
 * the coordinator would run is counted. A companion test turns hosting on in the same world and
 * sees that seam called, so the zero is not an artefact of the mocks.
 */

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

const processCalls: string[] = [];

/** A child that fails at once, the way a missing ssh would. */
function failingChild() {
	const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.stdin = { write: () => true, end: () => undefined, on: () => undefined };
	child.pid = undefined;
	child.exitCode = 1;
	child.kill = () => true;
	setImmediate(() => {
		if (child.listenerCount('error') > 0) {
			child.emit('error', Object.assign(new Error('spawn ssh ENOENT'), { code: 'ENOENT' }));
		}
		child.emit('exit', 1, null);
		child.emit('close', 1, null);
	});
	return child;
}

vi.mock('child_process', async (importOriginal) => {
	const actual = await importOriginal<typeof import('child_process')>();
	const record =
		(name: string) =>
		(...args: unknown[]) => {
			processCalls.push(`${name} ${String(args[0])}`);
			const callback = args[args.length - 1];
			if (typeof callback === 'function') {
				setImmediate(() =>
					(callback as (error: Error, stdout: string, stderr: string) => void)(
						Object.assign(new Error('ssh is not available in tests'), { code: 255 }),
						'',
						''
					)
				);
			}
			return failingChild();
		};
	const recordSync =
		(name: string) =>
		(...args: unknown[]) => {
			processCalls.push(`${name} ${String(args[0])}`);
			throw new Error('ssh is not available in tests');
		};
	const mocked = {
		...actual,
		spawn: record('spawn'),
		execFile: record('execFile'),
		exec: record('exec'),
		fork: record('fork'),
		spawnSync: recordSync('spawnSync'),
		execFileSync: recordSync('execFileSync'),
		execSync: recordSync('execSync'),
	};
	return { ...mocked, default: mocked };
});
vi.mock('electron', () => ({
	ipcMain: { handle: vi.fn() },
	app: { getVersion: () => '1.1.3-RC' },
}));
vi.mock('../../../main/maestro-cli-manager', () => ({
	resolveBundledCliPathSync: () => null,
}));
vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
}));
vi.mock('../../../main/web-server/callbacks/remoteRequest', () => ({
	requestFromRenderer: vi.fn(),
}));
vi.mock('../../../main/utils/safe-send', () => ({
	isWebContentsAvailable: (win: unknown) => Boolean(win),
}));
vi.mock('../../../main/utils/agent-busy', () => ({
	isAgentBusy: () => false,
}));

import { ipcMain } from 'electron';
import {
	FEDERATION_AUTO_CHANNEL,
	FEDERATION_RESET_CHANNEL,
	getAutoFederation,
	getPeerMirrorService,
	setAutoFederation,
	setPeerMirrorServiceForTests,
	startFederationWhileHosting,
} from '../../../main/federation';
import {
	followHostingSetting,
	hostingSettingOf,
	type HostingSettingStore,
} from '../../../main/federation/hosting-gate';
import { registerFederationHandlers } from '../../../main/ipc/handlers/federation';
import { disposeSshForwardManager } from '../../../shared/maestro-lib/client/ssh-forward';
import type { SshForwardLease } from '../../../shared/maestro-lib/client/ssh-forward';
import type { MaestroClient } from '../../../shared/maestro-lib/client/types';
import type { AgentRecord } from '../../../shared/maestro-lib/store/records';
import type { SshRemoteConfig } from '../../../shared/types';

const remoteOf = (id: string): SshRemoteConfig =>
	({
		id,
		name: id,
		host: `${id}.example.com`,
		port: 22,
		username: 'me',
		privateKeyPath: '',
		enabled: true,
	}) as SshRemoteConfig;

const sshAgent = (id: string, remoteId: string): AgentRecord => ({
	id,
	name: id,
	toolType: 'claude-code',
	cwd: '/home/me',
	state: 'idle',
	sessionSshRemoteConfig: { enabled: true, remoteId },
	aiTabs: [{ id: `${id}-tab`, name: 'Main', agentSessionId: 'sess', logs: [] }],
});

/** A settings store with `get`, `set`, and per-key `onDidChange`, like electron-store's. */
function fakeStore<T extends Record<string, unknown>>(initial: T) {
	const data: Record<string, unknown> = { ...initial };
	const watchers = new Map<string, Set<() => void>>();
	return {
		get: (key: string) => data[key],
		set: (key: string, value: unknown) => {
			data[key] = value;
			for (const watcher of watchers.get(key) ?? []) watcher();
		},
		onDidChange: (key: string, callback: () => void) => {
			const set = watchers.get(key) ?? new Set();
			set.add(callback);
			watchers.set(key, set);
			return () => set.delete(callback);
		},
		watcherCount: () => [...watchers.values()].reduce((sum, set) => sum + set.size, 0),
	};
}

/** Boot both Federation start sites the way the app does, over one settings store. */
function bootApp(options: {
	hosting: boolean;
	transport?: { acquireForward: (remote: SshRemoteConfig) => SshForwardLease };
}) {
	const settings = fakeStore({
		federationHostedAgents: options.hosting,
		// An install the migration has not reached yet would still hold the old `true`.
		federationAutoMove: true,
		sshRemotes: [remoteOf('r1')],
	});
	const sessions = fakeStore({ sessions: [sshAgent('a1', 'r1')] });
	const safeSend = vi.fn();
	const hosting = hostingSettingOf(settings as unknown as HostingSettingStore);
	const stopFederation = startFederationWhileHosting({
		readRemotes: () => settings.get('sshRemotes') as SshRemoteConfig[],
		watchRemotes: (onChange) => settings.onDidChange('sshRemotes', onChange),
		safeSend,
		hosting,
		...(options.transport
			? {
					overrides: {
						acquireForward: options.transport.acquireForward,
						createClient: fakeClient,
					},
				}
			: {}),
	});
	registerFederationHandlers({
		readSessions: () => sessions.get('sessions'),
		readSshRemotes: () => settings.get('sshRemotes'),
		readAgentConfigs: () => ({}),
		getMainWindow: () => null,
		getProcessManager: () => null,
		readAutoMove: () => settings.get('federationAutoMove') === true,
		hosting,
		watchSessions: (onChange) => sessions.onDidChange('sessions', onChange),
		safeSend,
	});
	return { settings, sessions, safeSend, stopFederation };
}

/** A host client that attaches at once with no agents. */
function fakeClient(): MaestroClient {
	const ok = async () => ({ ok: true, value: [] });
	return {
		connection: {
			connect: vi.fn(async () => ({ ok: true, value: {} })),
			reconnect: vi.fn(async () => ({ ok: true, value: {} })),
			close: vi.fn(async () => undefined),
			state: () => 'connected',
		},
		agents: { list: ok },
		groups: { list: ok },
		providers: { list: ok },
		tabs: { transcript: ok },
		turns: { queue: { list: ok } },
		events: { subscribe: () => () => undefined },
	} as unknown as MaestroClient;
}

/** Forwards that are up at once, counting the ones still held. */
function countingTransport() {
	let live = 0;
	const endpoint = { port: 50123, remotePort: 41234, token: 't', cliSecret: 's', pid: 1 };
	return {
		live: () => live,
		acquireForward: (remote: SshRemoteConfig): SshForwardLease => {
			live++;
			let released = false;
			return {
				remoteId: remote.id,
				state: () => ({ status: 'up', endpoint }),
				ready: () => Promise.resolve(endpoint),
				onChange: () => () => undefined,
				restart: () => undefined,
				release: async () => {
					if (released) return;
					released = true;
					live--;
				},
			} as unknown as SshForwardLease;
		},
	};
}

const MINUTE = 60_000;

beforeEach(() => {
	processCalls.length = 0;
	(ipcMain.handle as Mock).mockReset();
	setPeerMirrorServiceForTests(null);
	setAutoFederation(null);
});

afterEach(async () => {
	vi.useRealTimers();
	setPeerMirrorServiceForTests(null);
	setAutoFederation(null);
	await disposeSshForwardManager();
});

describe('followHostingSetting', () => {
	it('starts on boot only when on, and follows each change once', () => {
		let on = false;
		let notify = () => undefined as void;
		const service = { start: vi.fn(), stop: vi.fn() };
		const dispose = followHostingSetting(
			{
				isOn: () => on,
				watch: (onChange) => {
					notify = onChange;
					return () => undefined;
				},
			},
			service
		);
		expect(service.start).not.toHaveBeenCalled();
		notify();
		expect(service.stop).not.toHaveBeenCalled();
		on = true;
		notify();
		notify();
		expect(service.start).toHaveBeenCalledTimes(1);
		on = false;
		notify();
		expect(service.stop).toHaveBeenCalledTimes(1);
		on = true;
		notify();
		dispose();
		expect(service.start).toHaveBeenCalledTimes(2);
		expect(service.stop).toHaveBeenCalledTimes(2);
	});

	it('reads anything but an explicit true as off', () => {
		for (const value of [undefined, null, 'true', 1, false]) {
			const store = fakeStore({ federationHostedAgents: value });
			expect(hostingSettingOf(store as unknown as HostingSettingStore).isOn()).toBe(false);
		}
		const store = fakeStore({ federationHostedAgents: true });
		expect(hostingSettingOf(store as unknown as HostingSettingStore).isOn()).toBe(true);
	});
});

describe('with hosted agents off', () => {
	it('runs no process at all across app start, a remote edit, an agent edit, and 20 minutes', async () => {
		vi.useFakeTimers();
		const app = bootApp({ hosting: false });

		app.settings.set('sshRemotes', [remoteOf('r1'), remoteOf('r2')]);
		app.sessions.set('sessions', [sshAgent('a1', 'r1'), sshAgent('a2', 'r2')]);
		await vi.advanceTimersByTimeAsync(20 * MINUTE);

		expect(processCalls).toEqual([]);
		expect(getPeerMirrorService()).toBeNull();
		expect(getAutoFederation()).toBeNull();
		expect(vi.getTimerCount()).toBe(0);
		app.stopFederation();
	});

	it('answers the automatic Federation status and Run Now with the idle snapshot, dialing nothing', async () => {
		bootApp({ hosting: false });
		const handlers = new Map(
			(ipcMain.handle as Mock).mock.calls.map(([channel, handler]) => [channel, handler])
		);
		const idle = { autoMove: true, running: false, remotes: [], agents: [] };
		expect(await handlers.get('federation:autoStatus')({})).toEqual(idle);
		expect(await handlers.get('federation:autoRun')({})).toEqual(idle);
		expect(processCalls).toEqual([]);
	});
});

describe('the seam the zero-call test reads', () => {
	it('records the processes the real mirror runs once hosting is on', async () => {
		const app = bootApp({ hosting: true });
		await vi.waitFor(() => expect(processCalls.length).toBeGreaterThan(0));
		// Off again stops both start sites, so nothing of this test outlives it.
		app.settings.set('federationHostedAgents', false);
		expect(getPeerMirrorService()).toBeNull();
		expect(getAutoFederation()).toBeNull();
		app.stopFederation();
	});
});

describe('hosting turned on, then off', () => {
	it('leaves no forward, no timer, and empty windows behind', async () => {
		vi.useFakeTimers();
		const transport = countingTransport();
		const app = bootApp({ hosting: false, transport });
		expect(vi.getTimerCount()).toBe(0);

		app.settings.set('federationHostedAgents', true);
		await vi.advanceTimersByTimeAsync(0);
		expect(getPeerMirrorService()).not.toBeNull();
		expect(getAutoFederation()).not.toBeNull();
		expect(transport.live()).toBe(1);
		expect(vi.getTimerCount()).toBeGreaterThan(0);

		app.safeSend.mockClear();
		app.settings.set('federationHostedAgents', false);
		await vi.advanceTimersByTimeAsync(0);
		expect(getPeerMirrorService()).toBeNull();
		expect(getAutoFederation()).toBeNull();
		expect(transport.live()).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
		expect(app.safeSend).toHaveBeenCalledWith(FEDERATION_RESET_CHANNEL);
		expect(app.safeSend).toHaveBeenCalledWith(
			FEDERATION_AUTO_CHANNEL,
			expect.objectContaining({ remotes: [], agents: [], running: false })
		);

		// Twenty more minutes off: still nothing.
		await vi.advanceTimersByTimeAsync(20 * MINUTE);
		expect(transport.live()).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
		expect(processCalls).toEqual([]);
		app.stopFederation();
	});
});
