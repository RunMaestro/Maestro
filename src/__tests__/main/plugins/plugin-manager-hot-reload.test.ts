vi.mock('../../../main/plugins/plugin-scan', async () => {
	const actual = await import('../../helpers/pluginScan');
	return { scanPluginFiles: vi.fn(actual.scanPluginFiles) };
});
/**
 * @file plugin-manager-hot-reload.test.ts
 * @description Refresh-driven plugin hot reload. Editing a runnable plugin's
 * manifest or code must rebuild the registry and restart only that plugin's
 * sandbox; removing the plugin must stop the stale sandbox and remove the
 * record. Real temp dir + real fs; MAESTRO_USER_DATA redirects plugin storage.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';

const { forkMock } = vi.hoisted(() => ({ forkMock: vi.fn() }));

// fs passes straight through. `watch` is wrapped only so startWatchingWithNudge()
// can swap in inert watchers (an ESM namespace cannot be spied on directly).
vi.mock('fs', async (importOriginal) => {
	const actual = await importOriginal<typeof import('fs')>();
	const watch = vi.fn(actual.watch);
	return { ...actual, default: { ...actual, watch }, watch };
});

vi.mock('electron', () => ({
	app: { getPath: () => os.tmpdir() },
	utilityProcess: { fork: forkMock },
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn().mockResolvedValue(undefined),
}));

import { PluginManager, type PluginSandboxLifecycle } from '../../../main/plugins/plugin-manager';
import { PluginSandboxHost } from '../../../main/plugins/plugin-sandbox-host';
import type { PermissionBroker } from '../../../main/plugins/permission-broker';
import { logger } from '../../../main/utils/logger';
import { captureException } from '../../../main/utils/sentry';
import {
	pluginsDir,
	readPluginState,
	setPluginEnabled,
} from '../../../main/plugins/plugin-store-main';
import { SIGNATURE_FILENAME } from '../../../shared/plugins/signing';
import { PLUGIN_GRANTS_FILENAME } from '../../../shared/plugins/storage';
import type { PluginManifest } from '../../../shared/plugins/plugin-manifest';
import { TRANSCRIPTION_CONTRACT } from '../../../shared/plugins/services';
import { makeSigningKeys, signPluginDir } from './plugin-signing-helper';
import { scanPluginFiles } from '../../../main/plugins/plugin-scan';

// FC1 Option-B gate: code only RUNS with a trusted signature, so every fixture
// write is followed by a re-sign with this test key (stale signature = invalid
// = never runs) and the manager registers the key as trusted.
const keys = makeSigningKeys();
const mandatoryRequirement = {
	id: 'voice',
	provider: 'example.media',
	service: 'transcription',
	contract: TRANSCRIPTION_CONTRACT,
	version: '^1.0.0',
};

/** Write and sign a code-plugin fixture, optionally declaring its service dependencies. */
function writeCodePlugin(
	id: string,
	options: {
		version?: string;
		entry?: string;
		code?: string;
		requires?: PluginManifest['requires'];
	} = {}
): void {
	const entry = options.entry ?? 'main.js';
	const dir = path.join(pluginsDir(), id);
	fs.mkdirSync(path.dirname(path.join(dir, entry)), { recursive: true });
	const manifest = {
		id,
		name: id,
		version: options.version ?? '1.0.0',
		tier: 1,
		entry,
		maestro: { minHostApi: '1.0.0' },
		requires: options.requires,
	};
	fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(manifest));
	fs.writeFileSync(path.join(dir, entry), options.code ?? 'module.exports = "v1";');
	signPluginDir(dir, keys);
}

/**
 * Start the manager's hot-reload watcher and return `nudge()`, which delivers the
 * one event the plugins-root watcher is owed for a change the test just made.
 *
 * Every watcher the manager opens here is an inert fake, so `nudge()` is the only
 * event. The OS cannot be trusted in either direction: macOS FSEvents can drop an
 * event that lands right after a watch starts (a scan promise that never
 * resolved, or no `onChange`), and it can deliver one late, past the 30 ms
 * debounce (53 ms in 1 of 30 idle runs, longer under load). A late event starts a
 * second, unscripted discovery that breaks the exact scan and restart counts these
 * tests assert. The refresh still runs through the manager's own listener,
 * debounce, and discovery. `afterEach` puts the real `fs.watch` back.
 */
function startWatchingWithNudge(manager: PluginManager, debounceMs?: number): () => void {
	const listeners = new Map<string, () => void>();
	vi.mocked(fs.watch).mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
		const listener = rest.find((arg) => typeof arg === 'function') as () => void;
		listeners.set(String(target), listener);
		return Object.assign(new EventEmitter(), {
			close: vi.fn(),
			ref() {
				return this;
			},
			unref() {
				return this;
			},
		}) as unknown as fs.FSWatcher;
	}) as typeof fs.watch);
	manager.startWatching(debounceMs);
	const rootListener = listeners.get(pluginsDir());
	expect(rootListener).toBeTypeOf('function');
	return () => rootListener!();
}

function makeSandbox(): PluginSandboxLifecycle {
	const running = new Set<string>();
	return {
		start: vi.fn((pluginId: string) => {
			running.add(pluginId);
		}),
		stop: vi.fn((pluginId: string) => {
			running.delete(pluginId);
		}),
		stopAll: vi.fn(() => {
			running.clear();
		}),
		isRunning: vi.fn((pluginId: string) => running.has(pluginId)),
		runningIds: vi.fn(() => Array.from(running)),
		invokeCommand: vi.fn(() => false),
		invokeTool: vi.fn(async () => undefined),
	};
}

async function enableRunnablePlugin(manager: PluginManager, sandbox: PluginSandboxLifecycle): void {
	await manager.refresh();
	await manager.setEnabled('demo', true);
	expect(sandbox.start).toHaveBeenCalledTimes(1);
	expect(sandbox.isRunning('demo')).toBe(true);
	vi.mocked(sandbox.start).mockClear();
	vi.mocked(sandbox.stop).mockClear();
}

let workDir: string;
let prevUserData: string | undefined;

beforeEach(() => {
	prevUserData = process.env.MAESTRO_USER_DATA;
	workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-hot-reload-'));
	process.env.MAESTRO_USER_DATA = path.join(workDir, 'userData');
});

afterEach(() => {
	// Restore the real fs.watch that startWatchingWithNudge() replaced.
	vi.mocked(fs.watch).mockReset();
	if (prevUserData === undefined) delete process.env.MAESTRO_USER_DATA;
	else process.env.MAESTRO_USER_DATA = prevUserData;
	fs.rmSync(workDir, { recursive: true, force: true });
});

describe('PluginManager hot reload reconciliation', () => {
	it.each(['queued-uninstall', 'discovery'])(
		'keeps install acceptance safe while overlapping %s',
		async (overlap) => {
			const manager = new PluginManager({
				isEnabled: () => true,
				trustedKeys: () => [keys.publicKeyB64],
			});
			writeCodePlugin('demo');
			const destination = path.join(pluginsDir(), 'demo');
			const source = path.join(workDir, 'source');
			fs.renameSync(destination, source);
			const scanned = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const actual = await import('../../helpers/pluginScan');
			let held = false;
			vi.mocked(scanPluginFiles).mockImplementation(async (dir, trustedKeys) => {
				const result = await actual.scanPluginFiles(dir, trustedKeys);
				if (dir === destination && !held) {
					held = true;
					scanned.resolve();
					await release.promise;
				}
				return result;
			});
			const install = manager.install(source);
			let uninstall: ReturnType<PluginManager['uninstall']> | undefined;
			try {
				await scanned.promise;
				if (overlap === 'queued-uninstall') uninstall = manager.uninstall('demo');
				else await manager.refresh();
				release.resolve();
				const result = await install;
				if (uninstall) {
					expect(result).toMatchObject({ success: true, record: { id: 'demo' } });
					expect(await uninstall).toEqual({ success: true });
					expect(fs.existsSync(destination)).toBe(false);
					expect(manager.getRegistry().records).toEqual([]);
					expect(readPluginState().plugins.demo).toBeUndefined();
				} else {
					expect(result).toMatchObject({
						success: false,
						error: expect.stringContaining('superseded'),
					});
					expect(manager.getRegistry().records).toEqual([]);
					expect(fs.existsSync(destination)).toBe(true);
					expect(readPluginState().plugins.demo?.trustedPublisher).toBe(keys.publicKeyB64);
					await manager.refresh();
					expect(manager.getRegistry().records[0].id).toBe('demo');
				}
			} finally {
				release.resolve();
				await install;
				await uninstall;
				vi.mocked(scanPluginFiles).mockImplementation(actual.scanPluginFiles);
			}
		}
	);

	it.each(['manifest', 'root-symlink'])(
		'rejects a queued install whose source changes before ownership: %s',
		async (change) => {
			const sandbox = makeSandbox();
			const manager = new PluginManager({
				isEnabled: () => true,
				sandbox,
				trustedKeys: () => [keys.publicKeyB64],
			});
			writeCodePlugin('demo');
			await enableRunnablePlugin(manager, sandbox);
			const source = path.join(workDir, 'replacement');
			fs.cpSync(path.join(pluginsDir(), 'demo'), source, { recursive: true });
			const manifestPath = path.join(source, 'plugin.json');
			const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
			fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, version: '2.0.0' }));
			signPluginDir(source, keys);
			const drained = Promise.withResolvers<void>();
			const stop = sandbox.stop;
			sandbox.stop = vi.fn((id) => drained.promise.then(() => stop(id)));
			const uninstall = manager.uninstall('demo');
			await vi.waitFor(() => expect(sandbox.stop).toHaveBeenCalledWith('demo'));
			const install = manager.install(source);
			if (change === 'manifest') {
				fs.writeFileSync(
					manifestPath,
					JSON.stringify({ ...manifest, id: 'other', version: '2.0.0' })
				);
				signPluginDir(source, keys);
			} else {
				const linked = path.join(workDir, 'linked-source');
				fs.renameSync(source, linked);
				// Directory junctions avoid elevated symlink privileges on Windows.
				fs.symlinkSync(path.resolve(linked), source, 'junction');
			}
			drained.resolve();
			expect(await uninstall).toEqual({ success: true });
			const result = await install;
			expect(fs.existsSync(path.join(pluginsDir(), 'demo'))).toBe(false);
			expect(result).toMatchObject({
				success: false,
				error: expect.stringContaining(change === 'manifest' ? 'manifest changed' : 'directory'),
			});
			expect(manager.getRegistry().records).toEqual([]);
			expect(readPluginState().plugins.demo).toBeUndefined();
		}
	);

	it('rejects an in-flight install acceptance after sandbox shutdown', async () => {
		const sandbox = makeSandbox();
		const manager = new PluginManager({
			isEnabled: () => true,
			sandbox,
			trustedKeys: () => [keys.publicKeyB64],
		});
		writeCodePlugin('demo');
		const destination = path.join(pluginsDir(), 'demo');
		const source = path.join(workDir, 'source');
		fs.renameSync(destination, source);
		const scanned = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const actual = await import('../../helpers/pluginScan');
		vi.mocked(scanPluginFiles).mockImplementation(async (dir, trustedKeys) => {
			const result = await actual.scanPluginFiles(dir, trustedKeys);
			if (dir === destination) {
				scanned.resolve();
				await release.promise;
			}
			return result;
		});
		const install = manager.install(source);
		try {
			await scanned.promise;
			manager.stopAllSandboxes();
			release.resolve();
			expect(await install).toMatchObject({
				success: false,
				error: expect.stringContaining('superseded'),
			});
			expect(manager.getRegistry().records).toEqual([]);
			expect(readPluginState().plugins.demo).toBeUndefined();
			expect(sandbox.start).not.toHaveBeenCalled();
		} finally {
			release.resolve();
			await install;
			vi.mocked(scanPluginFiles).mockImplementation(actual.scanPluginFiles);
		}
	});

	it('coalesces concurrent full discovery requests into one trailing scan', async () => {
		const onChange = vi.fn();
		const manager = new PluginManager({
			isEnabled: () => true,
			onChange,
			trustedKeys: () => [keys.publicKeyB64],
		});
		writeCodePlugin('demo');
		await manager.refresh();
		onChange.mockClear();
		const scanned = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const actual = await import('../../helpers/pluginScan');
		let scans = 0;
		vi.mocked(scanPluginFiles).mockImplementation(async (dir, trustedKeys) => {
			const result = await actual.scanPluginFiles(dir, trustedKeys);
			if (dir === path.join(pluginsDir(), 'demo') && ++scans === 1) {
				scanned.resolve();
				await release.promise;
			}
			return result;
		});
		const first = manager.refresh();
		try {
			await scanned.promise;
			const second = manager.refresh();
			const third = manager.refresh();
			writeCodePlugin('demo', { version: '1.0.1' });
			release.resolve();
			await Promise.all([first, second, third]);
			await vi.waitFor(() =>
				expect(manager.getRegistry().records[0].manifest?.version).toBe('1.0.1')
			);
			expect(scans).toBe(2);
			expect(onChange).toHaveBeenCalledTimes(2);
		} finally {
			release.resolve();
			await first;
			manager.stopAllSandboxes();
			vi.mocked(scanPluginFiles).mockImplementation(actual.scanPluginFiles);
		}
	});

	it.each(
		['watching', 'sandboxes'].flatMap((stop) =>
			['in-flight', 'waiting'].map((phase) => ({ stop, phase }))
		)
	)(
		'cancels $phase watcher discovery when stopping $stop before publisher learning',
		async ({ stop, phase }) => {
			const sandbox = makeSandbox();
			const manager = new PluginManager({
				isEnabled: () => true,
				sandbox,
				trustedKeys: () => [keys.publicKeyB64],
			});
			writeCodePlugin('demo');
			writeCodePlugin('other');
			const source = path.join(pluginsDir(), 'demo');
			fs.rmSync(path.join(source, SIGNATURE_FILENAME));
			await manager.refresh();
			await manager.setEnabled('other', true);
			vi.mocked(sandbox.start).mockClear();
			const scanned = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const otherScanned = Promise.withResolvers<void>();
			const drained = Promise.withResolvers<void>();
			const actualStop = sandbox.stop;
			sandbox.stop = vi.fn((id) =>
				id === 'other'
					? drained.promise.then(() => {
							throw new Error('synthetic drain failure');
						})
					: actualStop(id)
			);
			const actual = await import('../../helpers/pluginScan');
			let held = false;
			let scans = 0;
			vi.mocked(scanPluginFiles).mockImplementation(async (dir, trustedKeys) => {
				const result = await actual.scanPluginFiles(dir, trustedKeys);
				scans++;
				if (!held && dir === source) {
					held = true;
					scanned.resolve();
					await release.promise;
				}
				if (dir === path.join(pluginsDir(), 'other')) otherScanned.resolve();
				return result;
			});
			const nudge = startWatchingWithNudge(manager, 30);
			let uninstall: Promise<unknown> | undefined;
			try {
				signPluginDir(source, keys);
				nudge();
				await scanned.promise;
				if (phase === 'waiting') {
					uninstall = manager.uninstall('other').catch((error: unknown) => error);
					await vi.waitFor(() => expect(sandbox.stop).toHaveBeenCalledWith('other'));
					release.resolve();
					await otherScanned.promise;
					await new Promise<void>((resolve) => setImmediate(resolve));
				}
				if (stop === 'watching') manager.stopWatching();
				else manager.stopAllSandboxes();
				release.resolve();
				drained.resolve();
				await uninstall;
				await otherScanned.promise;
				await new Promise<void>((resolve) => setImmediate(resolve));
				expect(scans).toBe(2);
				expect(readPluginState().plugins.demo).toBeUndefined();
				expect(
					manager.getRegistry().records.find((record) => record.id === 'demo')?.signature?.status
				).toBe('unsigned');
				expect(sandbox.start).not.toHaveBeenCalled();
				// Canceling background work does not disable a subsequent explicit discovery.
				await manager.refresh();
				expect(readPluginState().plugins.demo?.trustedPublisher).toBe(keys.publicKeyB64);
			} finally {
				release.resolve();
				drained.resolve();
				await uninstall;
				manager.stopWatching();
				manager.stopAllSandboxes();
				vi.mocked(scanPluginFiles).mockImplementation(actual.scanPluginFiles);
			}
		}
	);

	it('keeps a newer manual discovery when a canceled watcher scan finishes', async () => {
		const manager = new PluginManager({
			isEnabled: () => true,
			trustedKeys: () => [keys.publicKeyB64],
		});
		writeCodePlugin('demo');
		const source = path.join(pluginsDir(), 'demo');
		fs.rmSync(path.join(source, SIGNATURE_FILENAME));
		await manager.refresh();
		const oldScanned = Promise.withResolvers<void>();
		const releaseOld = Promise.withResolvers<void>();
		const newScanned = Promise.withResolvers<void>();
		const releaseNew = Promise.withResolvers<void>();
		const actual = await import('../../helpers/pluginScan');
		let scans = 0;
		vi.mocked(scanPluginFiles).mockImplementation(async (dir, trustedKeys) => {
			const result = await actual.scanPluginFiles(dir, trustedKeys);
			if (dir === source && ++scans === 1) {
				oldScanned.resolve();
				await releaseOld.promise;
			} else if (dir === source && scans === 2) {
				newScanned.resolve();
				await releaseNew.promise;
			}
			return result;
		});
		const nudge = startWatchingWithNudge(manager, 30);
		let manual: Promise<unknown> | undefined;
		try {
			signPluginDir(source, keys);
			nudge();
			await oldScanned.promise;
			manager.stopWatching();
			manual = manager.refresh();
			await newScanned.promise;
			releaseOld.resolve();
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(readPluginState().plugins.demo).toBeUndefined();
			releaseNew.resolve();
			await manual;
			expect(manager.getRegistry().records[0].signature?.status).toBe('trusted');
			expect(readPluginState().plugins.demo?.trustedPublisher).toBe(keys.publicKeyB64);
		} finally {
			releaseOld.resolve();
			releaseNew.resolve();
			await manual;
			manager.stopWatching();
			manager.stopAllSandboxes();
			vi.mocked(scanPluginFiles).mockImplementation(actual.scanPluginFiles);
		}
	});

	it('accepts a freshly installed target while an unrelated uninstall is draining', async () => {
		const sandbox = makeSandbox();
		const manager = new PluginManager({
			isEnabled: () => true,
			sandbox,
			trustedKeys: () => [keys.publicKeyB64],
		});
		writeCodePlugin('demo');
		const destination = path.join(pluginsDir(), 'demo');
		const source = path.join(workDir, 'source');
		fs.renameSync(destination, source);
		writeCodePlugin('other');
		await manager.refresh();
		await manager.setEnabled('other', true);
		const scanned = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const drained = Promise.withResolvers<void>();
		const stop = sandbox.stop;
		sandbox.stop = vi.fn((id) =>
			id === 'other' ? drained.promise.then(() => stop(id)) : stop(id)
		);
		const actual = await import('../../helpers/pluginScan');
		vi.mocked(scanPluginFiles).mockImplementation(async (dir, trustedKeys) => {
			const result = await actual.scanPluginFiles(dir, trustedKeys);
			if (dir === destination) {
				scanned.resolve();
				await release.promise;
			}
			return result;
		});
		const install = manager.install(source);
		let uninstall: ReturnType<PluginManager['uninstall']> | undefined;
		try {
			await scanned.promise;
			uninstall = manager.uninstall('other');
			await vi.waitFor(() => expect(sandbox.stop).toHaveBeenCalledWith('other'));
			release.resolve();
			const result = await install;
			expect(result).toMatchObject({
				success: true,
				record: {
					id: 'demo',
					source: destination,
					signature: { status: 'trusted' },
					enabled: false,
				},
			});
			expect(manager.getRegistry().records.find((record) => record.id === 'demo')).toBe(
				result.record
			);
			expect(readPluginState().plugins.demo?.trustedPublisher).toBe(keys.publicKeyB64);
			expect(sandbox.isRunning('other')).toBe(true);
		} finally {
			release.resolve();
			drained.resolve();
			await install;
			await uninstall;
			vi.mocked(scanPluginFiles).mockImplementation(actual.scanPluginFiles);
		}
	});

	it('retries a superseded watcher discovery after mutation failure without another file event', async () => {
		const sandbox = makeSandbox();
		const onWatchError = vi.fn();
		const manager = new PluginManager({
			isEnabled: () => true,
			sandbox,
			onWatchError,
			trustedKeys: () => [keys.publicKeyB64],
		});
		writeCodePlugin('demo');
		writeCodePlugin('other');
		await enableRunnablePlugin(manager, sandbox);
		await manager.setEnabled('other', true);
		vi.mocked(sandbox.start).mockClear();
		const scanned = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const drained = Promise.withResolvers<void>();
		const stop = sandbox.stop;
		sandbox.stop = vi.fn((id) =>
			id === 'other'
				? drained.promise.then(() => {
						throw new Error('synthetic drain failure');
					})
				: stop(id)
		);
		const actual = await import('../../helpers/pluginScan');
		let held = false;
		vi.mocked(scanPluginFiles).mockImplementation(async (dir, trustedKeys) => {
			const result = await actual.scanPluginFiles(dir, trustedKeys);
			if (!held && dir === path.join(pluginsDir(), 'demo')) {
				held = true;
				scanned.resolve();
				await release.promise;
			}
			return result;
		});
		const nudge = startWatchingWithNudge(manager, 30);
		let uninstall: Promise<unknown> | undefined;
		try {
			writeCodePlugin('demo', { version: '1.0.1' });
			nudge();
			await scanned.promise;
			uninstall = manager.uninstall('other').catch((error: unknown) => error);
			await vi.waitFor(() => expect(sandbox.stop).toHaveBeenCalledWith('other'));
			release.resolve();
			drained.resolve();
			expect(await uninstall).toBeInstanceOf(Error);
			// The rejected stop performs no file writes; no later filesystem event can rescue discovery.
			await vi.waitFor(() =>
				expect(
					manager.getRegistry().records.find((record) => record.id === 'demo')?.manifest?.version
				).toBe('1.0.1')
			);
			await vi.waitFor(() =>
				expect(sandbox.start).toHaveBeenCalledExactlyOnceWith(
					'demo',
					path.join(pluginsDir(), 'demo'),
					'main.js'
				)
			);
			expect(sandbox.isRunning('other')).toBe(true);
			expect(onWatchError).not.toHaveBeenCalled();
		} finally {
			release.resolve();
			drained.resolve();
			await uninstall;
			manager.stopWatching();
			vi.mocked(scanPluginFiles).mockImplementation(actual.scanPluginFiles);
		}
	});

	it.each(['draining', 'completed'])(
		'applies a fresh post-swap admission while an unrelated uninstall is %s',
		async (otherState) => {
			const sandbox = makeSandbox();
			const verifyRecord = vi.fn((record: { manifest?: PluginManifest | null }) => ({
				disable: record.manifest?.version === '2.0.0',
			}));
			const manager = new PluginManager({
				isEnabled: () => true,
				sandbox,
				verifyRecord,
				trustedKeys: () => [keys.publicKeyB64],
			});
			writeCodePlugin('demo');
			writeCodePlugin('other');
			await enableRunnablePlugin(manager, sandbox);
			await manager.setEnabled('other', true);
			vi.mocked(sandbox.start).mockClear();
			const installed = manager.getRegistry().records.find((record) => record.id === 'demo')!;
			const source = path.join(pluginsDir(), 'demo');
			const replacement = path.join(workDir, 'replacement');
			fs.cpSync(source, replacement, { recursive: true });
			const manifestPath = path.join(replacement, 'plugin.json');
			const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
			fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, version: '2.0.0' }));
			signPluginDir(replacement, keys);
			const scanned = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const drained = Promise.withResolvers<void>();
			const stop = sandbox.stop;
			sandbox.stop = vi.fn((id) =>
				id === 'other' ? drained.promise.then(() => stop(id)) : stop(id)
			);
			const actual = await import('../../helpers/pluginScan');
			vi.mocked(scanPluginFiles).mockImplementation(async (dir, trustedKeys) => {
				const result = await actual.scanPluginFiles(dir, trustedKeys);
				if (
					dir === source &&
					JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8')).version === '2.0.0'
				) {
					scanned.resolve();
					await release.promise;
				}
				return result;
			});
			const update = manager.update(replacement, 'demo');
			let uninstall: ReturnType<PluginManager['uninstall']> | undefined;
			try {
				await scanned.promise;
				uninstall = manager.uninstall('other');
				await vi.waitFor(() => expect(sandbox.stop).toHaveBeenCalledWith('other'));
				if (otherState === 'completed') {
					drained.resolve();
					await uninstall;
				}
				release.resolve();
				const registry = await update;
				const updated = registry.records.find((record) => record.id === 'demo')!;
				expect(verifyRecord).toHaveBeenCalledWith(
					expect.objectContaining({ manifest: expect.objectContaining({ version: '2.0.0' }) }),
					expect.anything()
				);
				expect(updated).toMatchObject({ enabled: false, manifest: { version: '2.0.0' } });
				expect(sandbox.start).not.toHaveBeenCalled();
				expect(sandbox.isRunning('demo')).toBe(false);
				expect(sandbox.isRunning('other')).toBe(otherState === 'draining');
				expect(registry.records.some((record) => record.id === 'other')).toBe(
					otherState === 'draining'
				);
				expect(() => manager.assertToolRecordCurrent(installed)).toThrow();
				expect(() => manager.assertToolRecordCurrent(updated)).toThrow();
			} finally {
				release.resolve();
				drained.resolve();
				await update.catch(() => undefined);
				await uninstall;
				vi.mocked(scanPluginFiles).mockImplementation(actual.scanPluginFiles);
			}
		}
	);

	it.each(['success', 'failed-purge', 'still-draining'])(
		'does not learn a retired publisher from a scan begun during uninstall: %s',
		async (cleanup) => {
			const sandbox = makeSandbox();
			const drained = Promise.withResolvers<void>();
			const stop = sandbox.stop;
			sandbox.stop = vi.fn((id) => drained.promise.then(() => stop(id)));
			const manager = new PluginManager({
				isEnabled: () => true,
				sandbox,
				trustedKeys: () => [keys.publicKeyB64],
			});
			writeCodePlugin('demo');
			const source = path.join(pluginsDir(), 'demo');
			fs.rmSync(path.join(source, SIGNATURE_FILENAME));
			await manager.refresh();
			signPluginDir(source, keys);
			const uninstall = manager.uninstall('demo').catch((error: unknown) => error);
			await vi.waitFor(() => expect(sandbox.stop).toHaveBeenCalledWith('demo'));
			const scanned = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const actual = await import('../../helpers/pluginScan');
			vi.mocked(scanPluginFiles).mockImplementation(async (dir, trustedKeys) => {
				const result = await actual.scanPluginFiles(dir, trustedKeys);
				if (dir === source && result.signature.status === 'trusted') {
					scanned.resolve();
					await release.promise;
				}
				return result;
			});
			const refresh = manager.refresh();
			try {
				await scanned.promise;
				if (cleanup === 'still-draining') {
					release.resolve();
					await refresh;
					expect(readPluginState().plugins.demo).toBeUndefined();
					expect(manager.getRegistry().records[0].signature?.status).toBe('unsigned');
				}
				if (cleanup === 'failed-purge')
					fs.mkdirSync(path.join(workDir, 'userData', PLUGIN_GRANTS_FILENAME));
				drained.resolve();
				const outcome = await uninstall;
				if (cleanup === 'failed-purge') expect(outcome).toBeInstanceOf(Error);
				else expect(outcome).toEqual({ success: true });
				release.resolve();
				await refresh;
				expect(readPluginState().plugins.demo).toBeUndefined();
				expect(manager.getRegistry().records).toEqual([]);
				expect(fs.existsSync(source)).toBe(false);
				expect(sandbox.start).not.toHaveBeenCalled();
			} finally {
				drained.resolve();
				release.resolve();
				await uninstall;
				await refresh;
				vi.mocked(scanPluginFiles).mockImplementation(actual.scanPluginFiles);
			}
		}
	);

	it.each(['uninstall', 'failed-purge', 'toggle'])(
		'does not overwrite fresh state when a trusted scan finishes after %s',
		async (operation) => {
			const manager = new PluginManager({
				isEnabled: () => true,
				trustedKeys: () => [keys.publicKeyB64],
			});
			writeCodePlugin('demo');
			const source = path.join(pluginsDir(), 'demo');
			fs.rmSync(path.join(source, SIGNATURE_FILENAME));
			await manager.refresh();
			expect(readPluginState().plugins.demo?.trustedPublisher).toBeUndefined();
			signPluginDir(source, keys);
			const scanned = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const actual = await import('../../helpers/pluginScan');
			vi.mocked(scanPluginFiles).mockImplementation(async (dir, trustedKeys) => {
				const result = await actual.scanPluginFiles(dir, trustedKeys);
				if (dir === source && result.signature.status === 'trusted') {
					scanned.resolve();
					await release.promise;
				}
				return result;
			});
			const refresh = manager.refresh();
			try {
				await scanned.promise;
				if (operation === 'uninstall') await manager.uninstall('demo');
				else if (operation === 'failed-purge') {
					// The enabled-state removal succeeds, then reading the grants file fails.
					fs.mkdirSync(path.join(workDir, 'userData', PLUGIN_GRANTS_FILENAME));
					await expect(manager.uninstall('demo')).rejects.toThrow();
				} else setPluginEnabled('demo', true);
			} finally {
				release.resolve();
				await refresh;
				vi.mocked(scanPluginFiles).mockImplementation(actual.scanPluginFiles);
			}
			if (operation !== 'toggle') {
				expect(readPluginState().plugins.demo).toBeUndefined();
				if (operation === 'uninstall') expect(manager.getRegistry().records).toEqual([]);
				expect(fs.existsSync(source)).toBe(false);
			} else {
				expect(readPluginState().plugins.demo).toEqual({
					enabled: true,
					trustedPublisher: keys.publicKeyB64,
				});
			}
		}
	);

	it.each([
		'unchanged',
		'queued-rejection',
		'draining',
		'disabled',
		'changed',
		'invalid',
		'dependency-loss',
	])(
		'keeps only a valid unchanged sandbox alive during update validation: %s',
		async (condition) => {
			const sandbox = makeSandbox();
			const onChange = vi.fn();
			let available = true;
			const manager = new PluginManager({
				isEnabled: () => true,
				sandbox,
				onChange,
				trustedKeys: () => [keys.publicKeyB64],
				serviceAvailable: () => available,
			});
			writeCodePlugin('demo', { requires: [mandatoryRequirement] });
			await enableRunnablePlugin(manager, sandbox);
			const installed = manager.getRegistry().records.find((record) => record.id === 'demo')!;
			expect(() => manager.assertToolRecordCurrent(installed)).not.toThrow();
			const drained = Promise.withResolvers<void>();
			let drain: Promise<void> | undefined;
			if (condition === 'draining') {
				const stop = sandbox.stop;
				sandbox.stop = vi.fn((id) => drained.promise.then(() => stop(id)));
			}
			const source = path.join(workDir, 'replacement');
			fs.cpSync(path.join(pluginsDir(), 'demo'), source, { recursive: true });
			const manifestPath = path.join(source, 'plugin.json');
			const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
			fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, version: '1.0.1' }));
			signPluginDir(source, keys);
			fs.writeFileSync(path.join(source, 'main.js'), 'tampered replacement');
			const scanned = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const actual = await import('../../helpers/pluginScan');
			vi.mocked(scanPluginFiles).mockImplementation(async (dir, trustedKeys) => {
				if (path.basename(path.dirname(dir)).startsWith('.update-')) {
					scanned.resolve();
					await release.promise;
				}
				return actual.scanPluginFiles(dir, trustedKeys);
			});
			onChange.mockClear();
			const nudge = startWatchingWithNudge(manager);
			const update = manager.update(source, 'demo');
			const queued = condition === 'queued-rejection' ? manager.update(source, 'demo') : null;
			const rejected = Promise.all([
				expect(update).rejects.toThrow(/signature/),
				...(queued ? [expect(queued).rejects.toThrow(/signature/)] : []),
			]);
			try {
				await scanned.promise;
				expect(() => manager.assertToolRecordCurrent(installed)).toThrow(
					expect.objectContaining({ code: 'PLUGIN_DENIED' })
				);
				// The service reconciler must also retain the unchanged working child.
				manager.reconcileServiceDependencies();
				expect(sandbox.stop).not.toHaveBeenCalled();
				if (condition === 'draining') {
					drain = manager.stopAndDrain('demo');
					expect(sandbox.isRunning('demo')).toBe(true);
				} else if (condition === 'disabled') {
					await manager.setEnabled('demo', false);
					onChange.mockClear();
				} else if (condition === 'changed') {
					writeCodePlugin('demo', { version: '2.0.0', requires: [mandatoryRequirement] });
				} else if (condition === 'invalid') {
					fs.writeFileSync(path.join(pluginsDir(), 'demo', 'main.js'), 'tampered installed bytes');
				} else if (condition === 'dependency-loss') {
					available = false;
					manager.reconcileServiceDependencies();
				}
				// Deliver the staging-dir event the watcher is owed, then wait for its
				// normal 150 ms debounced refresh.
				nudge();
				await vi.waitFor(() => expect(onChange).toHaveBeenCalled(), { timeout: 3000 });
				if (condition === 'unchanged' || condition === 'queued-rejection') {
					expect(sandbox.stop).not.toHaveBeenCalled();
					expect(sandbox.isRunning('demo')).toBe(true);
				} else if (condition === 'draining') {
					// Real sandbox controllers remain "running" until exit: no retention after stop.
					expect(vi.mocked(sandbox.stop).mock.calls.length).toBeGreaterThan(1);
				} else {
					expect(sandbox.stop).toHaveBeenCalledWith('demo');
					expect(sandbox.isRunning('demo')).toBe(false);
				}
				expect(sandbox.start).not.toHaveBeenCalled();
			} finally {
				drained.resolve();
				await drain;
				release.resolve();
				await rejected;
				manager.stopWatching();
				vi.mocked(scanPluginFiles).mockImplementation(actual.scanPluginFiles);
			}
			if (condition === 'unchanged' || condition === 'queued-rejection') {
				expect(sandbox.stop).not.toHaveBeenCalled();
				expect(sandbox.start).not.toHaveBeenCalled();
			}
			expect(fs.readdirSync(pluginsDir())).toEqual(['demo']);
		}
	);

	it('refreshes a manifest edit and restarts the still-runnable sandbox', async () => {
		const sandbox = makeSandbox();
		const onChange = vi.fn();
		const manager = new PluginManager({
			isEnabled: () => true,
			sandbox,
			onChange,
			trustedKeys: () => [keys.publicKeyB64],
		});
		writeCodePlugin('demo');
		await enableRunnablePlugin(manager, sandbox);

		writeCodePlugin('demo', { version: '1.0.1', code: 'module.exports = "v1";' });
		await manager.refresh();
		await vi.waitFor(() => expect(sandbox.start).toHaveBeenCalledTimes(1));

		expect(
			manager.getRegistry().records.find((record) => record.id === 'demo')?.manifest?.version
		).toBe('1.0.1');
		expect(sandbox.stop).toHaveBeenCalledTimes(1);
		expect(sandbox.stop).toHaveBeenCalledWith('demo');
		expect(sandbox.start).toHaveBeenCalledTimes(1);
		expect(sandbox.start).toHaveBeenCalledWith('demo', path.join(pluginsDir(), 'demo'), 'main.js');
		expect(onChange).toHaveBeenCalled();
		expect(sandbox.isRunning('demo')).toBe(true);
	});

	it('refreshes a code edit and restarts the affected sandbox', async () => {
		const sandbox = makeSandbox();
		const manager = new PluginManager({
			isEnabled: () => true,
			sandbox,
			trustedKeys: () => [keys.publicKeyB64],
		});
		writeCodePlugin('demo');
		await enableRunnablePlugin(manager, sandbox);

		fs.writeFileSync(path.join(pluginsDir(), 'demo', 'main.js'), 'module.exports = "v2";');
		signPluginDir(path.join(pluginsDir(), 'demo'), keys);
		await manager.refresh();
		await vi.waitFor(() => expect(sandbox.start).toHaveBeenCalledTimes(1));

		expect(sandbox.stop).toHaveBeenCalledTimes(1);
		expect(sandbox.stop).toHaveBeenCalledWith('demo');
		expect(sandbox.start).toHaveBeenCalledTimes(1);
		expect(sandbox.start).toHaveBeenCalledWith('demo', path.join(pluginsDir(), 'demo'), 'main.js');
		expect(sandbox.isRunning('demo')).toBe(true);
	});

	it('refreshes removal by stopping the sandbox and dropping the stale registry record', async () => {
		const sandbox = makeSandbox();
		const manager = new PluginManager({
			isEnabled: () => true,
			sandbox,
			trustedKeys: () => [keys.publicKeyB64],
		});
		writeCodePlugin('demo');
		await enableRunnablePlugin(manager, sandbox);

		fs.rmSync(path.join(pluginsDir(), 'demo'), { recursive: true, force: true });
		await manager.refresh();

		expect(sandbox.stop).toHaveBeenCalledTimes(1);
		expect(sandbox.stop).toHaveBeenCalledWith('demo');
		expect(sandbox.start).not.toHaveBeenCalled();
		expect(sandbox.isRunning('demo')).toBe(false);
		expect(manager.getRegistry().records.some((record) => record.id === 'demo')).toBe(false);
	});
});

describe('PluginManager hot reload with asynchronous sandbox shutdown', () => {
	let sandbox: PluginSandboxHost;
	let manager: PluginManager;
	let finishCleanup: () => void;
	let rejectCleanup: (error: Error) => void;
	let cleanup: Promise<void>;
	let pluginsEnabled: boolean;
	let servicesReady: boolean;

	beforeEach(async () => {
		pluginsEnabled = true;
		servicesReady = true;
		vi.mocked(logger.warn).mockClear();
		vi.mocked(captureException).mockClear();
		forkMock.mockReset();
		forkMock.mockImplementation(() =>
			Object.assign(new EventEmitter(), { postMessage: vi.fn(), kill: vi.fn() })
		);
		cleanup = new Promise<void>((resolve, reject) => {
			finishCleanup = resolve;
			rejectCleanup = reject;
		});
		sandbox = new PluginSandboxHost({
			broker: {} as PermissionBroker,
			handlers: {},
			onStop: vi
				.fn()
				.mockImplementationOnce(() => cleanup)
				.mockResolvedValue(undefined),
		});
		manager = new PluginManager({
			isEnabled: () => pluginsEnabled,
			sandbox,
			trustedKeys: () => [keys.publicKeyB64],
			serviceAvailable: () => servicesReady,
			// Production publishes registry changes through this dependency pass.
			onChange: () => manager.reconcileServiceDependencies(),
		});
		writeCodePlugin('demo');
		await manager.refresh();
		await manager.setEnabled('demo', true);
		expect(sandbox.isRunning('demo')).toBe(true);
	});

	afterEach(async () => {
		manager.stopAllSandboxes();
		const drain = sandbox.stopAll();
		for (const result of forkMock.mock.results) {
			if (result.type === 'return') result.value.emit('exit', 0);
		}
		finishCleanup();
		await drain;
	});

	it('resumes panel commands only after child exit and resource cleanup', async () => {
		writeCodePlugin('demo', { version: '1.0.1' });
		await manager.refresh();
		await manager.refresh();
		expect(manager.getRegistry().records[0].enabled).toBe(true);
		expect(manager.invokeCommand('demo/save-token', { token: 'test-token' })).toBe(false);
		expect(forkMock).toHaveBeenCalledTimes(1);

		forkMock.mock.results[0].value.emit('exit', 0);
		await Promise.resolve();
		expect(forkMock).toHaveBeenCalledTimes(1);
		finishCleanup();
		await vi.waitFor(() => expect(sandbox.isRunning('demo')).toBe(true));
		expect(forkMock).toHaveBeenCalledTimes(2);
		expect(manager.invokeCommand('demo/save-token', { token: 'test-token' })).toBe(true);
	});

	it.each(['draining', 'completed'])(
		'restarts a drained hot reload while an unrelated uninstall is %s',
		async (otherState) => {
			writeCodePlugin('other');
			await manager.refresh();
			await manager.setEnabled('other', true);
			const otherChild = forkMock.mock.results[1].value;
			writeCodePlugin('demo', { version: '1.0.1' });
			await manager.refresh();
			const scanned = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const actual = await import('../../helpers/pluginScan');
			vi.mocked(scanPluginFiles).mockImplementation(async (dir, trustedKeys) => {
				const result = await actual.scanPluginFiles(dir, trustedKeys);
				if (dir === path.join(pluginsDir(), 'demo')) {
					scanned.resolve();
					await release.promise;
				}
				return result;
			});
			const stop = vi.spyOn(manager, 'stopAndDrain');
			let uninstall: ReturnType<PluginManager['uninstall']> | undefined;
			try {
				forkMock.mock.results[0].value.emit('exit', 0);
				finishCleanup();
				await scanned.promise;
				uninstall = manager.uninstall('other');
				await vi.waitFor(() => expect(stop).toHaveBeenCalledWith('other'));
				if (otherState === 'completed') {
					otherChild.emit('exit', 0);
					await uninstall;
				}
				release.resolve();
				await vi.waitFor(() => expect(sandbox.isRunning('demo')).toBe(true));
				expect(forkMock).toHaveBeenCalledTimes(3);
				expect(manager.getRegistry().records.find((record) => record.id === 'demo')).toMatchObject({
					enabled: true,
					manifest: { version: '1.0.1' },
				});
				expect(manager.getRegistry().records.some((record) => record.id === 'other')).toBe(
					otherState === 'draining'
				);
				expect(sandbox.isRunning('other')).toBe(otherState === 'draining');
			} finally {
				release.resolve();
				otherChild.emit('exit', 0);
				await uninstall;
				stop.mockRestore();
				vi.mocked(scanPluginFiles).mockImplementation(actual.scanPluginFiles);
			}
		}
	);

	it('does not refresh or restart an unrelated plugin that crashes during the drain', async () => {
		writeCodePlugin('other');
		await manager.refresh();
		await manager.setEnabled('other', true);
		expect(sandbox.isRunning('other')).toBe(true);

		writeCodePlugin('demo', { version: '1.0.1' });
		await manager.refresh();
		forkMock.mock.results[1].value.emit('exit', 1);
		writeCodePlugin('other', { version: '1.0.1' });
		forkMock.mock.results[0].value.emit('exit', 0);
		finishCleanup();

		await vi.waitFor(() => expect(sandbox.isRunning('demo')).toBe(true));
		expect(sandbox.isRunning('other')).toBe(false);
		expect(
			manager.getRegistry().records.find((record) => record.id === 'other')?.manifest?.version
		).toBe('1.0.0');
		expect(forkMock).toHaveBeenCalledTimes(3);
	});

	it('preserves supervisor ownership of a crashed consumer through production change callbacks', async () => {
		writeCodePlugin('consumer', { requires: [mandatoryRequirement] });
		await manager.refresh();
		await manager.setEnabled('consumer', true);
		expect(sandbox.isRunning('consumer')).toBe(true);

		writeCodePlugin('demo', { version: '1.0.1' });
		await manager.refresh();
		forkMock.mock.results[1].value.emit('exit', 1);
		forkMock.mock.results[0].value.emit('exit', 0);
		finishCleanup();

		await vi.waitFor(() => expect(sandbox.isRunning('demo')).toBe(true));
		expect(sandbox.isRunning('consumer')).toBe(false);
		expect(forkMock).toHaveBeenCalledTimes(3);

		servicesReady = false;
		manager.reconcileServiceDependencies();
		servicesReady = true;
		manager.reconcileServiceDependencies();
		expect(sandbox.isRunning('consumer')).toBe(false);

		// Explicit discovery retains the host's deliberate restart behavior.
		await manager.refresh();
		expect(sandbox.isRunning('consumer')).toBe(true);
		expect(forkMock).toHaveBeenCalledTimes(4);
	});

	it('resumes a dependency-stopped consumer after its own resource drain', async () => {
		writeCodePlugin('consumer', { requires: [mandatoryRequirement] });
		await manager.refresh();
		await manager.setEnabled('consumer', true);

		servicesReady = false;
		manager.reconcileServiceDependencies();
		forkMock.mock.results[1].value.emit('exit', 0);
		servicesReady = true;
		manager.reconcileServiceDependencies();
		expect(sandbox.isRunning('consumer')).toBe(false);
		expect(captureException).not.toHaveBeenCalled();

		finishCleanup();
		await vi.waitFor(() => expect(sandbox.isRunning('consumer')).toBe(true));
		expect(forkMock).toHaveBeenCalledTimes(3);
		expect(captureException).not.toHaveBeenCalled();
	});

	it('does not resume a waiting consumer after all sandboxes are stopped', async () => {
		servicesReady = false;
		writeCodePlugin('consumer', { requires: [mandatoryRequirement] });
		await manager.refresh();
		await manager.setEnabled('consumer', true);
		expect(sandbox.isRunning('consumer')).toBe(false);

		manager.stopAllSandboxes();
		servicesReady = true;
		manager.reconcileServiceDependencies();

		expect(sandbox.isRunning('consumer')).toBe(false);
		expect(forkMock).toHaveBeenCalledTimes(1);
	});

	it('does not replace an unrelated record when the reloaded manifest changes identity', async () => {
		writeCodePlugin('other');
		await manager.refresh();
		await manager.setEnabled('other', true);

		writeCodePlugin('demo', { version: '1.0.1' });
		await manager.refresh();
		const pluginDir = path.join(pluginsDir(), 'demo');
		const manifestPath = path.join(pluginDir, 'plugin.json');
		const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
		manifest.id = 'other';
		fs.writeFileSync(manifestPath, JSON.stringify(manifest));
		signPluginDir(pluginDir, keys);
		forkMock.mock.results[0].value.emit('exit', 0);
		finishCleanup();

		await vi.waitFor(() => expect(manager.getRegistry().records).toHaveLength(1));
		expect(manager.getRegistry().records[0]).toMatchObject({
			id: 'other',
			source: path.join(pluginsDir(), 'other'),
			manifest: { version: '1.0.0' },
		});
		expect(sandbox.isRunning('demo')).toBe(false);
		expect(sandbox.isRunning('other')).toBe(true);
		expect(forkMock).toHaveBeenCalledTimes(2);
	});

	it('does not restart a plugin disabled during the drain', async () => {
		writeCodePlugin('demo', { version: '1.0.1' });
		await manager.refresh();
		await manager.setEnabled('demo', false);
		forkMock.mock.results[0].value.emit('exit', 0);
		finishCleanup();
		await manager.stopAndDrain('demo');
		await Promise.resolve();
		expect(sandbox.isRunning('demo')).toBe(false);
		expect(forkMock).toHaveBeenCalledTimes(1);
	});

	it('does not restart a plugin whose bytes were tampered with during the drain', async () => {
		writeCodePlugin('demo', { version: '1.0.1' });
		await manager.refresh();
		fs.writeFileSync(path.join(pluginsDir(), 'demo', 'main.js'), 'unsigned edit');
		forkMock.mock.results[0].value.emit('exit', 0);
		finishCleanup();
		await vi.waitFor(() =>
			expect(manager.getRegistry().records[0].signature?.status).toBe('invalid')
		);
		expect(sandbox.isRunning('demo')).toBe(false);
		expect(forkMock).toHaveBeenCalledTimes(1);
	});

	it('does not restart a plugin being uninstalled during the drain', async () => {
		writeCodePlugin('demo', { version: '1.0.1' });
		await manager.refresh();
		const removal = manager.uninstall('demo');
		forkMock.mock.results[0].value.emit('exit', 0);
		finishCleanup();
		await removal;
		expect(manager.getRegistry().records).toEqual([]);
		expect(sandbox.isRunning('demo')).toBe(false);
		expect(forkMock).toHaveBeenCalledTimes(1);
	});

	it('retires cached admission even when asynchronous uninstall cleanup rejects', async () => {
		const target = manager as unknown as {
			deps: { purgePluginData?: (id: string) => Promise<void> };
		};
		target.deps.purgePluginData = async () => {
			await Promise.resolve();
			writeCodePlugin('demo');
			throw Error('receipt cleanup failed');
		};
		const removal = manager.uninstall('demo');
		const rejected = expect(removal).rejects.toThrow(/receipt cleanup failed/);
		forkMock.mock.results[0].value.emit('exit', 0);
		finishCleanup();
		await rejected;
		expect(manager.getRegistry().records).toEqual([]);
		expect(sandbox.isRunning('demo')).toBe(false);
		expect(forkMock).toHaveBeenCalledTimes(1);
	});
	it('does not restart while the plugins feature is disabled during the drain', async () => {
		writeCodePlugin('demo', { version: '1.0.1' });
		await manager.refresh();
		pluginsEnabled = false;
		forkMock.mock.results[0].value.emit('exit', 0);
		finishCleanup();
		await vi.waitFor(() => expect(manager.getRegistry().records).toEqual([]));
		expect(sandbox.isRunning('demo')).toBe(false);
		expect(forkMock).toHaveBeenCalledTimes(1);
	});

	it('cancels a pending reload when all sandboxes are stopped', async () => {
		writeCodePlugin('demo', { version: '1.0.1' });
		await manager.refresh();
		manager.stopAllSandboxes();
		forkMock.mock.results[0].value.emit('exit', 0);
		finishCleanup();
		await manager.stopAndDrain('demo');
		await Promise.resolve();
		expect(sandbox.isRunning('demo')).toBe(false);
		expect(forkMock).toHaveBeenCalledTimes(1);
	});

	it('keeps a failed resource drain stopped and reports the reload failure', async () => {
		const error = new Error('cleanup failed');
		writeCodePlugin('demo', { version: '1.0.1' });
		await manager.refresh();
		forkMock.mock.results[0].value.emit('exit', 0);
		rejectCleanup(error);
		await vi.waitFor(() =>
			expect(logger.warn).toHaveBeenCalledWith(
				'Could not reload plugin "demo": Error: cleanup failed',
				'Plugins'
			)
		);
		expect(captureException).toHaveBeenCalledWith(error, {
			operation: 'plugins:reload',
			pluginId: 'demo',
		});
		expect(sandbox.isRunning('demo')).toBe(false);
		expect(forkMock).toHaveBeenCalledTimes(1);
	});

	it('reports a replacement child that cannot start', async () => {
		const error = new Error('fork failed');
		writeCodePlugin('demo', { version: '1.0.1' });
		await manager.refresh();
		forkMock.mockImplementationOnce(() => {
			throw error;
		});
		forkMock.mock.results[0].value.emit('exit', 0);
		finishCleanup();
		await vi.waitFor(() =>
			expect(logger.warn).toHaveBeenCalledWith(
				'Could not start plugin "demo": Error: fork failed',
				'Plugins'
			)
		);
		expect(captureException).toHaveBeenCalledWith(error, {
			operation: 'plugins:start',
			pluginId: 'demo',
		});
		expect(sandbox.isRunning('demo')).toBe(false);
	});

	it('reports unexpected registry change callback errors after reload', async () => {
		const error = new Error('change callback failed');
		writeCodePlugin('demo', { version: '1.0.1' });
		await manager.refresh();
		vi.spyOn(manager, 'reconcileServiceDependencies').mockImplementationOnce(() => {
			throw error;
		});
		forkMock.mock.results[0].value.emit('exit', 0);
		finishCleanup();

		await vi.waitFor(() =>
			expect(captureException).toHaveBeenCalledWith(error, {
				operation: 'plugins:reload',
				pluginId: 'demo',
			})
		);
	});
});
