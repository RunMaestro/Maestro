import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { gunzipSync } from 'zlib';
import * as ts from 'typescript';

vi.mock('fs', async (importOriginal) => {
	const actual = await importOriginal<typeof import('fs')>();
	return { ...actual, renameSync: vi.fn(actual.renameSync) };
});
vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }));
vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));

import { logger } from '../../../main/utils/logger';
import { captureException } from '../../../main/utils/sentry';
import { PluginManager, type PluginSandboxLifecycle } from '../../../main/plugins/plugin-manager';
import {
	pluginsDir,
	readPluginState,
	readGrants,
	setPluginEnabled,
	setGrants,
} from '../../../main/plugins/plugin-store-main';
import {
	AuthorizationStore,
	type AuthorizationStoreDeps,
	type Anchor,
} from '../../../main/plugins/authorization-ledger';
import { obscuringSeal } from '../../../main/utils/safe-storage-seal';
import { pluginIdentity } from '../../../main/plugins/plugin-identity';
import { grantsFromRequests } from '../../../shared/plugins/permissions';
import { PluginKvStore } from '../../../main/plugins/plugin-kv-store';
import { PluginAgentSessionBindings } from '../../../main/plugins/plugin-agent-session-bindings';
import { PluginEventBusImpl } from '../../../main/plugins/plugin-event-bus';
import { purgePluginData } from '../../../main/plugins/plugin-host-handlers';
import { makeSigningKeys, signPluginDir } from './plugin-signing-helper';

const originalRename = vi.mocked(fs.renameSync).getMockImplementation()!;

let dataDir: string;
let previousUserData: string | undefined;
let authorization: AuthorizationStore;
let authorizationDeps: AuthorizationStoreDeps;
let manager: PluginManager;
let kvStore: PluginKvStore;
let bindings: PluginAgentSessionBindings;
let eventBus: PluginEventBusImpl;
let sandbox: PluginSandboxLifecycle;
let settings: Map<string, string>;
let enabled: boolean;
const files: Record<string, string> = JSON.parse(
	gunzipSync(fs.readFileSync(path.join(__dirname, 'fixtures/agent-flow-0.3.0.json.gz'))).toString()
);

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(fs.renameSync).mockImplementation(originalRename);
	previousUserData = process.env.MAESTRO_USER_DATA;
	dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-flow-retirement-'));
	process.env.MAESTRO_USER_DATA = dataDir;
	const source = path.join(pluginsDir(), 'agent-flow');
	fs.mkdirSync(source, { recursive: true });
	for (const [name, content] of Object.entries(files)) {
		fs.writeFileSync(path.join(source, name), content);
	}
	let freshness: Anchor | null = null;
	authorizationDeps = {
		seal: obscuringSeal(),
		anchor: {
			available: () => true,
			read: () => freshness,
			write: (value) => {
				freshness = { ...value };
			},
			clear: () => {
				freshness = null;
			},
		},
		ledgerPath: path.join(dataDir, 'test-authorization.bin'),
	};
	authorization = new AuthorizationStore(authorizationDeps);
	authorization.mint(
		'agent-flow',
		grantsFromRequests(JSON.parse(files['plugin.json']).permissions),
		pluginIdentity(source, [])!
	);
	kvStore = new PluginKvStore({ baseDir: path.join(dataDir, 'plugin-data') });
	bindings = new PluginAgentSessionBindings(path.join(dataDir, 'plugin-agent-sessions'));
	settings = new Map([['plugins.agent-flow.layout', 'saved layout']]);
	eventBus = new PluginEventBusImpl({ isPermitted: () => true, push: () => true });
	sandbox = {
		start: vi.fn(),
		stop: vi.fn(async () => {}),
		stopAll: vi.fn(),
		isRunning: () => false,
		runningIds: () => [],
		invokeCommand: () => false,
		invokeTool: async () => undefined,
	};
	enabled = true;
	manager = new PluginManager({
		isEnabled: () => enabled,
		sandbox,
		getGrants: (id) => authorization.readGrants(id),
		purgePluginData: (id) => {
			bindings.purge(id);
			purgePluginData(id, {
				kvStore,
				eventBus,
				settingsDeleteNamespace: (prefix) => {
					for (const key of settings.keys()) if (key.startsWith(prefix)) settings.delete(key);
				},
			});
		},
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	if (previousUserData === undefined) delete process.env.MAESTRO_USER_DATA;
	else process.env.MAESTRO_USER_DATA = previousUserData;
	fs.rmSync(dataDir, { recursive: true, force: true });
});

it('retires the unchanged 0.3.0 installation left behind by #1740 before discovery', async () => {
	const { recoveryPath } = await manager.retireBundledAgentFlow(authorization);
	manager.refresh();
	expect(manager.getRegistry().records.map((record) => record.id)).not.toContain('agent-flow');
	expect(fs.existsSync(path.join(pluginsDir(), 'agent-flow'))).toBe(false);
	for (const [name, content] of Object.entries(files)) {
		expect(fs.readFileSync(path.join(recoveryPath!, 'agent-flow', name), 'utf8')).toBe(content);
	}
	expect(authorization.isTombstoned('agent-flow')).toBe(true);
});

it('removes orphan grants through the host tombstone contract when the package is already absent', async () => {
	fs.rmSync(path.join(pluginsDir(), 'agent-flow'), { recursive: true });
	manager.refresh();
	expect(manager.getRequestedPermissions('agent-flow')).toEqual([]);
	expect(authorization.readGrants('agent-flow')).toHaveLength(4);
	await manager.retireBundledAgentFlow(authorization);
	expect(authorization.readGrants('agent-flow')).toEqual([]);
	const restarted = new AuthorizationStore(authorizationDeps);
	expect(restarted.readGrants('agent-flow')).toEqual([]);
	expect(restarted.isTombstoned('agent-flow')).toBe(true);
});

it('purges only Agent Flow state and keeps unrelated plugins, grants, data and bindings across repeated runs', async () => {
	const otherIds = ['sh.maestro.relay', 'sh.maestro.transcription', 'example.user'];
	for (const id of ['agent-flow', ...otherIds]) {
		if (id !== 'agent-flow') {
			const source = path.join(pluginsDir(), id);
			fs.mkdirSync(source);
			fs.writeFileSync(
				path.join(source, 'plugin.json'),
				JSON.stringify({
					id,
					name: id,
					version: '1.0.0',
					tier: 0,
					maestro: { minHostApi: '1.0.0' },
				})
			);
			authorization.mint(
				id,
				grantsFromRequests([{ capability: 'events:subscribe' }]),
				pluginIdentity(source, [])!
			);
		}
		setPluginEnabled(id, true);
		setGrants(id, grantsFromRequests([{ capability: 'events:subscribe' }]));
		kvStore.set(id, 'state', `saved ${id}`);
		bindings.remember(id, 'agent-a', `session-${id}`);
		settings.set(`plugins.${id}.layout`, `saved ${id}`);
		eventBus.subscribe(id, ['tool.executed']);
	}
	manager.refresh();
	const otherRecords = manager.getRegistry().records.filter((record) => record.id !== 'agent-flow');
	const otherGrants = otherIds.map((id) => authorization.readGrants(id));
	const { recoveryPath } = await manager.retireBundledAgentFlow(authorization);
	const ledger = fs.readFileSync(authorizationDeps.ledgerPath);
	await expect(manager.retireBundledAgentFlow(authorization)).resolves.toEqual({
		recoveryPath: undefined,
	});
	manager.refresh();
	expect(manager.getRegistry().records).toEqual(otherRecords);
	expect(otherIds.map((id) => authorization.readGrants(id))).toEqual(otherGrants);
	expect(fs.readFileSync(authorizationDeps.ledgerPath)).toEqual(ledger);
	expect(fs.readdirSync(path.join(dataDir, 'retired-plugins'))).toEqual([
		path.basename(recoveryPath!),
	]);
	expect(kvStore.get('agent-flow', 'state')).toBeNull();
	expect(bindings.hasBindings('agent-flow')).toBe(false);
	expect(settings.has('plugins.agent-flow.layout')).toBe(false);
	expect(eventBus.topicsFor('agent-flow')).toEqual([]);
	expect(readPluginState().plugins['agent-flow']).toBeUndefined();
	expect(readGrants('agent-flow')).toEqual([]);
	for (const id of otherIds) {
		expect(kvStore.get(id, 'state')).toBe(`saved ${id}`);
		expect(bindings.isOwned(id, 'agent-a', `session-${id}`)).toBe(true);
		expect(settings.get(`plugins.${id}.layout`)).toBe(`saved ${id}`);
		expect(eventBus.topicsFor(id)).toEqual(['tool.executed']);
		expect(readPluginState().plugins[id].enabled).toBe(true);
		expect(readGrants(id)).toHaveLength(1);
	}
});

it.each([
	'changed code',
	'wrong id',
	'newer version',
	'extra file',
	'nested directory',
	'missing file',
])('preserves the package and authorization for %s', async (change) => {
	const source = path.join(pluginsDir(), 'agent-flow');
	if (change === 'changed code')
		fs.appendFileSync(path.join(source, 'main.js'), '\n// user change');
	if (change === 'extra file') fs.writeFileSync(path.join(source, 'notes.txt'), 'user data');
	if (change === 'nested directory') fs.mkdirSync(path.join(source, 'node_modules'));
	if (change === 'missing file') fs.unlinkSync(path.join(source, 'README.md'));
	if (change === 'wrong id' || change === 'newer version') {
		const manifest = JSON.parse(files['plugin.json']);
		if (change === 'wrong id') manifest.id = 'other-plugin';
		else manifest.version = '0.4.0';
		fs.writeFileSync(path.join(source, 'plugin.json'), JSON.stringify(manifest));
	}
	setPluginEnabled('agent-flow', true);
	setGrants('agent-flow', grantsFromRequests([{ capability: 'events:subscribe' }]));
	kvStore.set('agent-flow', 'state', 'saved');
	bindings.remember('agent-flow', 'agent-a', 'session-a');
	eventBus.subscribe('agent-flow', ['tool.executed']);
	const ledger = fs.readFileSync(authorizationDeps.ledgerPath);
	const state = readPluginState();
	const revoke = vi.spyOn(authorization, 'uninstall');
	vi.mocked(fs.renameSync).mockClear();
	await expect(manager.retireBundledAgentFlow(authorization)).resolves.toEqual({
		preserved: 'not the unchanged retired 0.3.0 bundle',
	});
	expect(fs.existsSync(source)).toBe(true);
	expect(fs.readFileSync(authorizationDeps.ledgerPath)).toEqual(ledger);
	expect(readPluginState()).toEqual(state);
	expect(readGrants('agent-flow')).toHaveLength(1);
	expect(kvStore.get('agent-flow', 'state')).toBe('saved');
	expect(bindings.isOwned('agent-flow', 'agent-a', 'session-a')).toBe(true);
	expect(eventBus.topicsFor('agent-flow')).toEqual(['tool.executed']);
	expect(settings.get('plugins.agent-flow.layout')).toBe('saved layout');
	expect(sandbox.stop).not.toHaveBeenCalled();
	expect(revoke).not.toHaveBeenCalled();
	expect(fs.renameSync).not.toHaveBeenCalled();
	expect(fs.existsSync(path.join(dataDir, 'retired-plugins'))).toBe(false);
});

it.each(['plugin root', 'package', 'file', 'dangling package', 'recovery root'])(
	'refuses a symlink at the %s without touching its target',
	async (location) => {
		const outside = path.join(dataDir, 'outside');
		fs.mkdirSync(outside);
		fs.writeFileSync(path.join(outside, 'sentinel'), 'unrelated');
		const source = path.join(pluginsDir(), 'agent-flow');
		if (location === 'plugin root' || location === 'package') {
			const target = location === 'plugin root' ? pluginsDir() : source;
			fs.renameSync(target, path.join(outside, 'original'));
			fs.symlinkSync(path.join(outside, 'original'), target, 'junction');
		} else if (location === 'file') {
			fs.unlinkSync(path.join(source, 'main.js'));
			fs.symlinkSync(path.join(outside, 'sentinel'), path.join(source, 'main.js'));
		} else if (location === 'dangling package') {
			fs.rmSync(source, { recursive: true });
			fs.symlinkSync(path.join(outside, 'missing'), source, 'junction');
		} else {
			fs.symlinkSync(outside, path.join(dataDir, 'retired-plugins'), 'junction');
		}
		if (location === 'file') {
			await expect(manager.retireBundledAgentFlow(authorization)).resolves.toEqual({
				preserved: 'not the unchanged retired 0.3.0 bundle',
			});
		} else {
			await expect(manager.retireBundledAgentFlow(authorization)).rejects.toThrow();
		}
		expect(fs.readFileSync(path.join(outside, 'sentinel'), 'utf8')).toBe('unrelated');
		expect(fs.readdirSync(outside).sort()).toEqual(
			location === 'package' || location === 'plugin root' ? ['original', 'sentinel'] : ['sentinel']
		);
	}
);

it('awaits the sandbox drain and rechecks changed bytes before revoking or archiving', async () => {
	let finish!: () => void;
	vi.mocked(fs.renameSync).mockClear();
	vi.mocked(sandbox.stop).mockImplementation(
		() =>
			new Promise<void>((resolve) => {
				finish = resolve;
			})
	);
	const pending = manager.retireBundledAgentFlow(authorization);
	await vi.waitFor(() => expect(sandbox.stop).toHaveBeenCalledWith('agent-flow'));
	expect(authorization.readGrants('agent-flow')).toHaveLength(4);
	const source = path.join(pluginsDir(), 'agent-flow');
	fs.appendFileSync(path.join(source, 'main.js'), '\n// changed during drain');
	finish();
	await expect(pending).resolves.toEqual({
		preserved: 'not the unchanged retired 0.3.0 bundle',
	});
	expect(authorization.readGrants('agent-flow')).toHaveLength(4);
	expect(fs.existsSync(source)).toBe(true);
	expect(authorization.isTombstoned('agent-flow')).toBe(false);
	expect(fs.renameSync).not.toHaveBeenCalled();
	expect(settings.get('plugins.agent-flow.layout')).toBe('saved layout');
});

it('reports a failed drain and leaves the package and authorization intact for retry', async () => {
	vi.mocked(sandbox.stop).mockRejectedValueOnce(new Error('drain failed'));
	await expect(manager.retireBundledAgentFlow(authorization)).rejects.toThrow('drain failed');
	expect(fs.existsSync(path.join(pluginsDir(), 'agent-flow'))).toBe(true);
	expect(authorization.readGrants('agent-flow')).toHaveLength(4);
	await expect(manager.retireBundledAgentFlow(authorization)).resolves.toHaveProperty(
		'recoveryPath'
	);
});

it('reports archive failure, retains the package, revokes access and retries without overwriting recovery', async () => {
	const rename = originalRename;
	vi.mocked(fs.renameSync).mockImplementation((from, to) => {
		if (String(from) === path.join(pluginsDir(), 'agent-flow')) throw new Error('archive failed');
		return rename(from, to);
	});
	await expect(manager.retireBundledAgentFlow(authorization)).rejects.toThrow('archive failed');
	expect(fs.existsSync(path.join(pluginsDir(), 'agent-flow'))).toBe(true);
	expect(authorization.readGrants('agent-flow')).toEqual([]);
	vi.mocked(fs.renameSync).mockImplementation(rename);
	await expect(manager.retireBundledAgentFlow(authorization)).resolves.toHaveProperty(
		'recoveryPath'
	);
});

it('retries a failed purge on the next host run even though the package is already archived', async () => {
	kvStore.set('agent-flow', 'state', 'saved');
	vi.spyOn(kvStore, 'purge').mockImplementationOnce(() => {
		throw new Error('purge failed');
	});
	await expect(manager.retireBundledAgentFlow(authorization)).rejects.toThrow('purge failed');
	expect(fs.existsSync(path.join(pluginsDir(), 'agent-flow'))).toBe(false);
	expect(new AuthorizationStore(authorizationDeps).readGrants('agent-flow')).toEqual([]);
	const restartedKv = new PluginKvStore({ baseDir: path.join(dataDir, 'plugin-data') });
	const restartedManager = new PluginManager({
		isEnabled: () => true,
		purgePluginData: (id) => restartedKv.purge(id),
	});
	await restartedManager.retireBundledAgentFlow(new AuthorizationStore(authorizationDeps));
	expect(restartedKv.get('agent-flow', 'state')).toBeNull();
});

it('leaves disk and authorization untouched while Plugins is switched off', async () => {
	enabled = false;
	const ledger = fs.readFileSync(authorizationDeps.ledgerPath);
	await manager.retireBundledAgentFlow(authorization);
	expect(fs.readFileSync(authorizationDeps.ledgerPath)).toEqual(ledger);
	expect(fs.existsSync(path.join(pluginsDir(), 'agent-flow'))).toBe(true);
	expect(sandbox.stop).not.toHaveBeenCalled();
});

it.each(['moved', 'additional'])(
	'preserves an %s user-managed copy in a different folder and its authorization',
	async (mode) => {
		const source = path.join(pluginsDir(), 'agent-flow');
		const custom = path.join(pluginsDir(), 'custom-flow');
		if (mode === 'moved') fs.renameSync(source, custom);
		else fs.cpSync(source, custom, { recursive: true });
		vi.mocked(fs.renameSync).mockClear();
		const ledger = fs.readFileSync(authorizationDeps.ledgerPath);
		const revoke = vi.spyOn(authorization, 'uninstall');
		await expect(manager.retireBundledAgentFlow(authorization)).resolves.toEqual({
			preserved: 'installed in a user-managed folder',
		});
		expect(fs.existsSync(path.join(pluginsDir(), 'custom-flow', 'main.js'))).toBe(true);
		expect(fs.readFileSync(authorizationDeps.ledgerPath)).toEqual(ledger);
		expect(fs.existsSync(source)).toBe(mode === 'additional');
		expect(sandbox.stop).not.toHaveBeenCalled();
		expect(revoke).not.toHaveBeenCalled();
		expect(fs.renameSync).not.toHaveBeenCalled();
	}
);

it.each(['preserved', 'read failure', 'archive failure', 'purge failure'])(
	'startup reports %s at the appropriate level and continues discovery',
	async (outcome) => {
		const error = new Error(outcome);
		if (outcome === 'preserved') {
			fs.appendFileSync(path.join(pluginsDir(), 'agent-flow', 'main.js'), '\n// user change');
			vi.spyOn(authorization, 'isSessionOnly').mockReturnValue(true);
		} else if (outcome === 'read failure') {
			vi.spyOn(fs, 'readdirSync').mockImplementationOnce(() => {
				throw error;
			});
		} else if (outcome === 'archive failure') {
			vi.mocked(fs.renameSync).mockImplementation((from, to) => {
				if (String(from) === path.join(pluginsDir(), 'agent-flow')) throw error;
				return originalRename(from, to);
			});
		} else {
			vi.spyOn(kvStore, 'purge').mockImplementationOnce(() => {
				throw error;
			});
		}
		// Exercise the shipped startup callback, following the host wiring tests,
		// without booting Electron or replacing the retirement implementation.
		const source = fs.readFileSync(path.join(__dirname, '../../../main/index.ts'), 'utf8');
		const sf = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
		let callback: ts.ArrowFunction | undefined;
		const visit = (node: ts.Node): void => {
			if (
				ts.isPropertyAssignment(node) &&
				node.name.getText(sf) === 'reconcile' &&
				ts.isArrowFunction(node.initializer) &&
				node.initializer.getText(sf).includes('retireBundledAgentFlow')
			) {
				callback = node.initializer;
			}
			ts.forEachChild(node, visit);
		};
		visit(sf);
		expect(callback).toBeDefined();
		const js = ts.transpileModule(`const reconcile = ${callback!.getText(sf)}`, {
			compilerOptions: { target: ts.ScriptTarget.ES2024 },
		}).outputText;
		const refresh = vi.spyOn(manager, 'refresh').mockImplementation(() => {});
		const watch = vi.spyOn(manager, 'startWatching').mockImplementation(() => {});
		const seed = vi.fn();
		const scheduler = { start: vi.fn() };
		const reconcile = new Function(
			'pluginManager',
			'authStore',
			'logger',
			'captureException',
			'store',
			'seedBundledPlugins',
			'pluginScheduler',
			'trustedKeysFor',
			`${js}\nreturn reconcile;`
		)(
			manager,
			authorization,
			logger,
			captureException,
			{ get: () => ({ plugins: true }) },
			seed,
			scheduler,
			() => []
		);
		reconcile();
		await vi.waitFor(() => expect(scheduler.start).toHaveBeenCalledOnce());
		expect(seed).toHaveBeenCalledOnce();
		expect(refresh).toHaveBeenCalledOnce();
		expect(watch).toHaveBeenCalledOnce();
		if (outcome === 'preserved') {
			expect(logger.info).toHaveBeenCalledWith(
				'Agent Flow preserved: not the unchanged retired 0.3.0 bundle',
				'Plugins'
			);
			expect(logger.warn).not.toHaveBeenCalled();
			expect(logger.error).not.toHaveBeenCalled();
			expect(captureException).not.toHaveBeenCalled();
			expect(sandbox.stop).not.toHaveBeenCalled();
		} else {
			expect(logger.error).toHaveBeenCalledWith(
				`Agent Flow retirement incomplete: ${error}`,
				'Plugins'
			);
			expect(captureException).toHaveBeenCalledExactlyOnceWith(error, {
				operation: 'plugins:retire-agent-flow',
			});
		}
	}
);

it('ignores an unrelated invalid manifest when cleaning an absent package', async () => {
	fs.rmSync(path.join(pluginsDir(), 'agent-flow'), { recursive: true });
	fs.mkdirSync(path.join(pluginsDir(), 'invalid'));
	fs.writeFileSync(path.join(pluginsDir(), 'invalid', 'plugin.json'), '{broken');
	await manager.retireBundledAgentFlow(authorization);
	expect(fs.readFileSync(path.join(pluginsDir(), 'invalid', 'plugin.json'), 'utf8')).toBe(
		'{broken'
	);
	expect(authorization.readGrants('agent-flow')).toEqual([]);
});

it('keeps the package and authorization until a successful drain completes', async () => {
	let finish!: () => void;
	vi.mocked(sandbox.stop).mockImplementation(
		() =>
			new Promise<void>((resolve) => {
				finish = resolve;
			})
	);
	const pending = manager.retireBundledAgentFlow(authorization);
	await vi.waitFor(() => expect(sandbox.stop).toHaveBeenCalledWith('agent-flow'));
	expect(fs.existsSync(path.join(pluginsDir(), 'agent-flow'))).toBe(true);
	expect(authorization.readGrants('agent-flow')).toHaveLength(4);
	finish();
	await pending;
	expect(fs.existsSync(path.join(pluginsDir(), 'agent-flow'))).toBe(false);
	expect(authorization.readGrants('agent-flow')).toEqual([]);
});

it('does not continue a retirement if Plugins is switched off during the drain', async () => {
	vi.mocked(sandbox.stop).mockImplementation(async () => {
		enabled = false;
	});
	await manager.retireBundledAgentFlow(authorization);
	expect(fs.existsSync(path.join(pluginsDir(), 'agent-flow'))).toBe(true);
	expect(authorization.readGrants('agent-flow')).toHaveLength(4);
});

it('preserves the ledger session-only fallback when the freshness anchor becomes unavailable', async () => {
	authorizationDeps.anchor.write = () => {
		throw new Error('keyring locked');
	};
	await manager.retireBundledAgentFlow(authorization);
	expect(authorization.readGrants('agent-flow')).toEqual([]);
	expect(authorization.isSessionOnly()).toBe(true);
	// A later host run retries the same absent-package cleanup through the store.
	authorization = new AuthorizationStore(authorizationDeps);
	await manager.retireBundledAgentFlow(authorization);
	expect(authorization.readGrants('agent-flow')).toEqual([]);
});

it('archives an optional release signature intact without changing the pinned payload identity', async () => {
	const source = path.join(pluginsDir(), 'agent-flow');
	signPluginDir(source, makeSigningKeys());
	const signature = fs.readFileSync(path.join(source, 'signature.json'), 'utf8');
	const { recoveryPath } = await manager.retireBundledAgentFlow(authorization);
	expect(fs.readFileSync(path.join(recoveryPath!, 'agent-flow', 'signature.json'), 'utf8')).toBe(
		signature
	);
});

it('does not restart a cached enabled sandbox after archive failure', async () => {
	const keys = makeSigningKeys();
	const source = path.join(pluginsDir(), 'agent-flow');
	signPluginDir(source, keys);
	setPluginEnabled('agent-flow', true);
	const liveManager = new PluginManager({
		isEnabled: () => true,
		sandbox,
		trustedKeys: () => [keys.publicKeyB64],
	});
	liveManager.refresh();
	expect(sandbox.start).toHaveBeenCalledOnce();
	vi.mocked(fs.renameSync).mockImplementation((from, to) => {
		if (String(from) === source) throw new Error('archive failed');
		return originalRename(from, to);
	});
	await expect(liveManager.retireBundledAgentFlow(authorization)).rejects.toThrow('archive failed');
	expect(sandbox.start).toHaveBeenCalledOnce();
	expect(liveManager.getActiveRecords()).toEqual([]);
});

it.each(['plugin root', 'package', 'recovery root'])(
	'refuses an unexpected regular file at the %s',
	async (location) => {
		const target =
			location === 'plugin root'
				? pluginsDir()
				: location === 'package'
					? path.join(pluginsDir(), 'agent-flow')
					: path.join(dataDir, 'retired-plugins');
		fs.rmSync(target, { recursive: true, force: true });
		fs.writeFileSync(target, 'unrelated file');
		await expect(manager.retireBundledAgentFlow(authorization)).rejects.toThrow();
		expect(fs.readFileSync(target, 'utf8')).toBe('unrelated file');
	}
);

it('cleans orphan authorization even when the entire plugin directory is absent', async () => {
	fs.rmSync(pluginsDir(), { recursive: true });
	await manager.retireBundledAgentFlow(authorization);
	expect(authorization.readGrants('agent-flow')).toEqual([]);
	expect(authorization.isTombstoned('agent-flow')).toBe(true);
	expect(fs.existsSync(pluginsDir())).toBe(false);
});
