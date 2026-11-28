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
// The real setup, counted: the coordinator must not reach it with automatic moves off.
vi.mock('../../../main/federation/setup-host', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../main/federation/setup-host')>();
	return { ...actual, setupHostFromDesktop: vi.fn(actual.setupHostFromDesktop) };
});

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
	readHostingSwitches,
	type HostingSettingStore,
} from '../../../main/federation/hosting-gate';
import { registerFederationHandlers } from '../../../main/ipc/handlers/federation';
import { AutoFederationCoordinator } from '../../../main/federation/auto-federation';
import { setupHostFromDesktop } from '../../../main/federation/setup-host';
import { settleHostingAfterExternalChange } from '../../../main/federation/hosting-gate';
import { runSettingsMigrations } from '../../../main/stores/migrations';
import { captureException } from '../../../main/utils/sentry';
import { handleFederationCommand } from '../../../main/web-server/handlers/messageHandlers/federation';
import { PeerConnectError } from '../../../shared/maestro-lib/client/peer-connection';
import { FEDERATION_NOT_RUNNING_MESSAGE } from '../../../shared/federationCommands';
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
function fakeStore<T extends Record<string, unknown>>(
	initial: T,
	options: { failWrites?: boolean } = {}
) {
	const data: Record<string, unknown> = { ...initial };
	const watchers = new Map<string, Set<() => void>>();
	return {
		data,
		get: (key: string) => data[key],
		set: (key: string, value: unknown) => {
			if (options.failWrites) throw new Error('EROFS: read-only file system');
			data[key] = value;
			for (const watcher of watchers.get(key) ?? []) watcher();
		},
		/** An edit made outside the store (the CLI writes the file): no `onDidChange` fires. */
		writeFile: (key: string, value: unknown) => {
			data[key] = value;
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
	autoMove?: boolean;
	/** The default-off migration ran (default true). */
	migrated?: boolean;
	remotes?: SshRemoteConfig[];
	agents?: AgentRecord[];
	/** Bring a settings store the test already prepared (the migration ran on it). */
	settings?: ReturnType<typeof fakeStore>;
	transport?: { acquireForward: (remote: SshRemoteConfig) => SshForwardLease };
}) {
	const settings =
		options.settings ??
		fakeStore({
			federationHostedAgents: options.hosting,
			federationAutoMove: options.autoMove ?? true,
			...(options.migrated === false ? {} : { [MIGRATION_MARKER]: true }),
			sshRemotes: options.remotes ?? [remoteOf('r1')],
		});
	const sessions = fakeStore({ sessions: options.agents ?? [sshAgent('a1', 'r1')] });
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
		// As the IPC bootstrap reads it.
		readAutoMove: () => {
			const switches = readHostingSwitches(settings as unknown as HostingSettingStore);
			return switches.federationAutoMove && switches.federationHostedAgents;
		},
		hosting,
		watchSessions: (onChange) => sessions.onDidChange('sessions', onChange),
		safeSend,
	});
	const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>(
		(ipcMain.handle as Mock).mock.calls.map(([channel, handler]) => [channel, handler])
	);
	const call = (channel: string, ...args: unknown[]) => {
		const handler = handlers.get(channel);
		if (!handler) throw new Error(`No handler for ${channel}`);
		return handler({}, ...args);
	};
	return { settings, sessions, safeSend, stopFederation, call };
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

/**
 * Forwards that are up at once, counting the ones still held. A remote named in `answers` reports
 * that state instead (a stopped host, a CLI too old), as the real forward's discovery would.
 */
function countingTransport(answers: Record<string, 'host-down' | 'outdated'> = {}) {
	let live = 0;
	const endpoint = { port: 50123, remotePort: 41234, token: 't', cliSecret: 's', pid: 1 };
	return {
		live: () => live,
		acquireForward: (remote: SshRemoteConfig): SshForwardLease => {
			live++;
			let released = false;
			const answer = answers[remote.id];
			return {
				remoteId: remote.id,
				state: () => ({ status: 'up', endpoint }),
				ready: () =>
					answer
						? Promise.reject(new PeerConnectError(answer, `${remote.id}: ${answer}`, remote.id))
						: Promise.resolve(endpoint),
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
const MIGRATION_MARKER = 'migration_federationHostingDefaultOffV1';

beforeEach(() => {
	processCalls.length = 0;
	vi.mocked(setupHostFromDesktop).mockClear();
	vi.mocked(captureException).mockClear();
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
		// The old default's `true`, before the default-off migration ran, is not an opt-in.
		const unmigrated = fakeStore({ federationHostedAgents: true });
		expect(hostingSettingOf(unmigrated as unknown as HostingSettingStore).isOn()).toBe(false);
		const store = fakeStore({ federationHostedAgents: true, [MIGRATION_MARKER]: true });
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
		// No automatic moves are in effect while hosting is off, whatever the stored switch says.
		const idle = { autoMove: false, running: false, remotes: [], agents: [] };
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

describe('a default-off migration that could not write', () => {
	it('leaves hosting off, reports the failure, and runs no process', async () => {
		vi.useFakeTimers();
		// An install from the release that shipped hosting on, on a read-only settings file.
		const settings = fakeStore(
			{ federationHostedAgents: true, federationAutoMove: true, sshRemotes: [remoteOf('r1')] },
			{ failWrites: true }
		);
		runSettingsMigrations(settings as never);
		expect(captureException).toHaveBeenCalledWith(expect.any(Error), {
			operation: 'migration:federationHostingDefaultOff',
		});
		expect(settings.get('federationHostedAgents')).toBe(true);
		// Every desktop reader (the launch guard, the settings the windows read) sees what the gate
		// sees: a moved agent's turn runs as its SSH turn, never sent to a mirror that is not there.
		expect(readHostingSwitches(settings as unknown as HostingSettingStore)).toEqual({
			federationHostedAgents: false,
			federationAutoMove: false,
		});

		const app = bootApp({ hosting: true, settings });
		await vi.advanceTimersByTimeAsync(20 * MINUTE);
		expect(processCalls).toEqual([]);
		expect(getPeerMirrorService()).toBeNull();
		expect(getAutoFederation()).toBeNull();
		app.stopFederation();
	});
});

describe('a change made outside the store (maestro-cli settings set)', () => {
	it('starts and stops Federation through the settings file watcher', async () => {
		vi.useFakeTimers();
		const transport = countingTransport();
		const app = bootApp({ hosting: false, transport });

		app.settings.writeFile('federationHostedAgents', true);
		settleHostingAfterExternalChange();
		await vi.advanceTimersByTimeAsync(0);
		expect(getPeerMirrorService()).not.toBeNull();
		expect(getAutoFederation()).not.toBeNull();
		expect(transport.live()).toBe(1);

		app.settings.writeFile('federationHostedAgents', false);
		settleHostingAfterExternalChange();
		await vi.advanceTimersByTimeAsync(0);
		expect(getPeerMirrorService()).toBeNull();
		expect(getAutoFederation()).toBeNull();
		expect(transport.live()).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
		app.stopFederation();
	});
});

describe('hosting on, automatic moves off', () => {
	const remotes = [remoteOf('down'), remoteOf('old')];
	const agents = [sshAgent('a1', 'down'), sshAgent('a2', 'old')];

	async function threePasses(autoMove: boolean) {
		vi.useFakeTimers();
		const runSetup = vi.spyOn(
			AutoFederationCoordinator.prototype as unknown as { runSetup: () => Promise<boolean> },
			'runSetup'
		);
		const transport = countingTransport({ down: 'host-down', old: 'outdated' });
		const app = bootApp({ hosting: true, autoMove, remotes, agents, transport });
		// The first pass 30 s after launch, then one every five minutes.
		await vi.advanceTimersByTimeAsync(30_000 + 2 * 5 * MINUTE + 1_000);
		const snapshot = (await app.call('federation:autoStatus')) as {
			remotes: Array<{ remoteId: string; state: string }>;
			lastPassAt?: number;
		};
		app.settings.set('federationHostedAgents', false);
		app.stopFederation();
		const spawned = processCalls.filter((call) => /\b(ssh|scp)\b/.test(call));
		const setupCalls = runSetup.mock.calls.length;
		runSetup.mockRestore();
		return { snapshot, spawned, setupCalls };
	}

	it('never sets up a host from a timer: no runSetup, no setup call, no ssh or scp', async () => {
		const { snapshot, spawned, setupCalls } = await threePasses(false);
		expect(typeof snapshot.lastPassAt).toBe('number');
		expect(snapshot.remotes.map((remote) => remote.state)).toEqual(['waiting', 'waiting']);
		expect(setupCalls).toBe(0);
		expect(setupHostFromDesktop).not.toHaveBeenCalled();
		expect(spawned).toEqual([]);
	});

	it('does set the hosts up once automatic moves are on (the seam above is live)', async () => {
		const { setupCalls } = await threePasses(true);
		expect(setupCalls).toBeGreaterThan(0);
		expect(setupHostFromDesktop).toHaveBeenCalled();
	});
});

describe('user actions and the CLI while hosting is off', () => {
	it('Move Back from Host is still reachable, and starts neither the mirror nor the coordinator', async () => {
		const lifted = {
			...sshAgent('a1', 'r1'),
			liftedTo: { peer: 'r1', agentId: 'host-1', at: 1 },
		} as AgentRecord;
		const app = bootApp({ hosting: false, agents: [lifted] });
		// Offline: restored from this machine's copy. The window is absent here, so it answers why.
		const answer = (await app.call('federation:unlift', 'a1', { offline: true })) as {
			ok: boolean;
			error?: string;
		};
		expect(answer.ok).toBe(false);
		expect(answer.error).toContain('window');
		expect(getPeerMirrorService()).toBeNull();
		expect(getAutoFederation()).toBeNull();
		expect(processCalls).toEqual([]);
	});

	it('setupHost, reconnect, and act answer "not running" and run no process', async () => {
		const app = bootApp({ hosting: false });
		expect(await app.call('federation:setupHost', 'r1', {})).toEqual({
			ok: false,
			code: 'FEDERATION_NOT_RUNNING',
			error: FEDERATION_NOT_RUNNING_MESSAGE,
		});
		expect(await app.call('federation:reconnect', 'r1')).toEqual({
			ok: false,
			error: FEDERATION_NOT_RUNNING_MESSAGE,
		});
		expect(await app.call('federation:act', 'r1', 'x', { kind: 'new-tab' })).toEqual({
			ok: false,
			error: FEDERATION_NOT_RUNNING_MESSAGE,
		});
		expect(processCalls).toEqual([]);
	});

	it('the CLI bridge answers "not running" for peers and reconnect, idle for auto, and runs no process', async () => {
		bootApp({ hosting: false });
		const replies: Array<Record<string, unknown>> = [];
		const ctx = {
			send: (_client: unknown, payload: Record<string, unknown>) => replies.push(payload),
		};
		const cli = { id: 'cli-1', cli: true };
		for (const message of [
			{ action: 'peers' },
			{ action: 'reconnect', peer: 'r1' },
			{ action: 'auto-status' },
			{ action: 'auto-run' },
		]) {
			await handleFederationCommand(
				ctx as never,
				cli as never,
				{
					type: 'federation_command',
					requestId: 'q',
					...message,
				} as never
			);
		}
		expect(replies.slice(0, 2)).toEqual([
			expect.objectContaining({ success: false, error: FEDERATION_NOT_RUNNING_MESSAGE }),
			expect.objectContaining({ success: false, error: FEDERATION_NOT_RUNNING_MESSAGE }),
		]);
		const idle = { autoMove: false, running: false, remotes: [], agents: [] };
		expect(replies.slice(2)).toEqual([
			expect.objectContaining({ success: true, auto: idle }),
			expect.objectContaining({ success: true, auto: idle }),
		]);
		expect(processCalls).toEqual([]);
	});
});
