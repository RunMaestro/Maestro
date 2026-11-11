vi.mock('../../../main/plugins/plugin-scan', async () => {
	const actual = await import('../../helpers/pluginScan');
	return { scanPluginFiles: vi.fn(actual.scanPluginFiles) };
});
/**
 * FC1 Option-B trusted-to-run gate (`isRunnable` requires `trusted`).
 *
 * Contract under test:
 * - Code executes ONLY when the plugin's signature verifies as `trusted`
 *   (valid ed25519 signature from a key in the trusted set).
 * - `unsigned`, `untrusted` (valid signature, unknown key), and `invalid`
 *   (tampered) plugins NEVER start a sandbox - even when enabled.
 * - The gate is about CODE, not data: unsigned/untrusted plugins remain
 *   installable + enableable and their DECLARATIVE contributions (themes,
 *   prompts, commands metadata) still aggregate.
 *
 * Real temp dir + real fs; MAESTRO_USER_DATA redirects plugin storage.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('fs', async (importOriginal) => {
	const actual = await importOriginal<typeof import('fs')>();
	return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

vi.mock('electron', () => ({
	app: { getPath: () => os.tmpdir() },
}));

import { PluginManager, type PluginSandboxLifecycle } from '../../../main/plugins/plugin-manager';
import {
	pluginsDir,
	readPluginState,
	writePluginState,
} from '../../../main/plugins/plugin-store-main';
import { makeSigningKeys, signPluginDir } from './plugin-signing-helper';
import { packPluginArchive } from '../../../shared/plugins/plugin-archive';
import { SIGNATURE_FILENAME } from '../../../shared/plugins/signing';
import { PluginKvStore } from '../../../main/plugins/plugin-kv-store';
import { scanPluginFiles } from '../../../main/plugins/plugin-scan';

const trustedSigner = makeSigningKeys();
const strangerSigner = makeSigningKeys();

function writeCodePlugin(
	id: string,
	opts: {
		theme?: boolean;
		settings?: boolean;
		requires?: import('../../../shared/plugins/services').RequiredService[];
	} = {}
): string {
	const dir = path.join(pluginsDir(), id);
	fs.mkdirSync(dir, { recursive: true });
	const manifest = {
		id,
		name: id,
		version: '1.0.0',
		tier: 1,
		entry: 'main.js',
		maestro: { minHostApi: '1.0.0' },
		...(opts.requires ? { requires: opts.requires } : {}),
		...(opts.settings
			? {
					permissions: [{ capability: 'ui:panel' }],
					contributes: {
						panels: [
							{ id: 'config', title: 'Configuration', entry: 'panel.html', placement: 'settings' },
						],
					},
				}
			: {}),
		...(opts.theme
			? {
					contributes: {
						themes: [
							{
								id: 'gate-theme',
								name: 'Gate Theme',
								mode: 'dark',
								colors: { accent: '#123456' },
							},
						],
					},
				}
			: {}),
	};
	fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(manifest));
	fs.writeFileSync(path.join(dir, 'panel.html'), '<html>settings</html>');
	fs.writeFileSync(path.join(dir, 'main.js'), 'module.exports = { activate() {} };');
	return dir;
}

function makeSandbox(): PluginSandboxLifecycle {
	const running = new Set<string>();
	return {
		start: vi.fn((id: string) => {
			running.add(id);
		}),
		stop: vi.fn((id: string) => {
			running.delete(id);
		}),
		stopAll: vi.fn(() => running.clear()),
		isRunning: vi.fn((id: string) => running.has(id)),
		runningIds: vi.fn(() => [...running]),
		invokeCommand: vi.fn(() => false),
		invokeTool: vi.fn(async () => undefined),
	};
}

function makeManager(sandbox: PluginSandboxLifecycle): PluginManager {
	return new PluginManager({
		isEnabled: () => true,
		sandbox,
		trustedKeys: () => [trustedSigner.publicKeyB64],
	});
}

let workDir: string;
let prevUserData: string | undefined;

beforeEach(() => {
	prevUserData = process.env.MAESTRO_USER_DATA;
	workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-trust-gate-'));
	process.env.MAESTRO_USER_DATA = path.join(workDir, 'userData');
});

afterEach(() => {
	if (prevUserData === undefined) delete process.env.MAESTRO_USER_DATA;
	else process.env.MAESTRO_USER_DATA = prevUserData;
	fs.rmSync(workDir, { recursive: true, force: true });
});

describe('signed update publisher continuity and runtime recovery', () => {
	it.each(
		['backup', 'swap', 'committed'].flatMap((failure) =>
			['superseded', 'rejected'].map((recheck) => ({ failure, recheck }))
		)
	)(
		'keeps admission retired when $failure reconciliation is $recheck',
		async ({ failure, recheck }) => {
			const id = 'recovery.consumer';
			const sandbox = makeSandbox();
			let rejectRecheck = false;
			const manager = new PluginManager({
				isEnabled: () => true,
				sandbox,
				trustedKeys: () => [trustedSigner.publicKeyB64],
				verifyRecord: () => {
					if (rejectRecheck) throw new Error('authorization check failed');
					return { disable: false };
				},
			});
			const installed = writeCodePlugin(id);
			signPluginDir(installed, trustedSigner);
			await manager.refresh();
			await manager.setEnabled(id, true);
			const admitted = manager.getRegistry().records.find((record) => record.id === id)!;
			vi.mocked(sandbox.start).mockClear();
			const replacement = path.join(workDir, 'replacement');
			fs.cpSync(installed, replacement, { recursive: true });
			const manifestPath = path.join(replacement, 'plugin.json');
			const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
			fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, version: '2.0.0' }));
			signPluginDir(replacement, trustedSigner);
			const scanned = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			let recovering = false;
			const actual = await import('../../helpers/pluginScan');
			vi.mocked(scanPluginFiles).mockImplementation(async (dir, trustedKeys) => {
				const result = await actual.scanPluginFiles(dir, trustedKeys);
				if (
					dir === installed &&
					(recovering ||
						JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8')).version === '2.0.0')
				) {
					scanned.resolve();
					await release.promise;
				}
				return result;
			});
			const rename = (await vi.importActual<typeof import('fs')>('fs')).renameSync;
			vi.mocked(fs.renameSync).mockImplementation((from, to) => {
				if (
					(failure === 'backup' && String(from) === installed) ||
					(failure === 'swap' && String(to) === installed && path.basename(String(from)) === id)
				) {
					recovering = true;
					throw new Error(`synthetic ${failure} failure`);
				}
				return rename(from, to);
			});
			const outcome = manager.update(replacement, id).catch((error: unknown) => error);
			try {
				await scanned.promise;
				expect(sandbox.isRunning(id)).toBe(false);
				expect(sandbox.start).not.toHaveBeenCalled();
				if (recheck === 'superseded') await manager.setEnabled(id, false);
				else rejectRecheck = true;
				release.resolve();
				const result = await outcome;
				expect(result).toBeInstanceOf(Error);
				expect(String(result)).toMatch(
					recheck === 'superseded' ? /superseded/ : /authorization check failed/
				);
				expect(manager.getRegistry().records.find((record) => record.id === id)).toBeUndefined();
				expect(() => manager.assertToolRecordCurrent(admitted)).toThrow();
				expect(sandbox.start).not.toHaveBeenCalled();
				expect(sandbox.isRunning(id)).toBe(false);
				expect(
					JSON.parse(fs.readFileSync(path.join(installed, 'plugin.json'), 'utf8')).version
				).toBe(failure === 'committed' ? '2.0.0' : '1.0.0');
				expect(readPluginState().plugins[id]).toEqual({
					enabled: recheck !== 'superseded',
					trustedPublisher: trustedSigner.publicKeyB64,
				});
			} finally {
				release.resolve();
				await outcome;
				vi.mocked(fs.renameSync).mockImplementation(rename);
				vi.mocked(scanPluginFiles).mockImplementation(actual.scanPluginFiles);
			}
		}
	);

	it.each(
		['refresh', 'restart'].flatMap((roundTrip) =>
			['missing', 'invalid', 'untrusted', 'conflicting'].flatMap((live) =>
				['unsigned', 'different', 'recorded'].map((candidate) => ({ roundTrip, live, candidate }))
			)
		)
	)(
		'preserves publisher across $roundTrip with live=$live and candidate=$candidate',
		async ({ roundTrip, live, candidate }) => {
			const deps = {
				isEnabled: () => true,
				trustedKeys: () =>
					live === 'untrusted'
						? [trustedSigner.publicKeyB64]
						: [trustedSigner.publicKeyB64, strangerSigner.publicKeyB64],
			};
			let manager = new PluginManager(deps);
			const id = 'durable.publisher';
			const installed = writeCodePlugin(id);
			signPluginDir(installed, trustedSigner);
			await manager.refresh();
			const replacement = path.join(workDir, 'replacement');
			fs.cpSync(installed, replacement, { recursive: true });
			const manifestPath = path.join(replacement, 'plugin.json');
			const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
			fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, version: '2.0.0' }));
			if (candidate === 'unsigned') {
				fs.rmSync(path.join(replacement, SIGNATURE_FILENAME));
			} else {
				signPluginDir(replacement, candidate === 'recorded' ? trustedSigner : strangerSigner);
			}
			const archive = path.join(workDir, 'replacement.tgz');
			await packPluginArchive(replacement, archive);
			if (live === 'missing') fs.rmSync(path.join(installed, SIGNATURE_FILENAME));
			else if (live === 'invalid')
				fs.writeFileSync(path.join(installed, SIGNATURE_FILENAME), '{broken');
			else signPluginDir(installed, strangerSigner);
			await manager.refresh();
			if (roundTrip === 'restart') {
				manager = new PluginManager(deps);
				await manager.refresh();
			}
			if (candidate === 'recorded' && (live === 'missing' || live === 'invalid')) {
				const registry = await manager.update(archive, id);
				expect(registry.records.find((record) => record.id === id)).toMatchObject({
					manifest: { version: '2.0.0' },
					signature: { status: 'trusted', signerKey: trustedSigner.publicKeyB64 },
				});
			} else {
				const stop = vi.spyOn(manager, 'stopAndDrain');
				await expect(manager.update(archive, id)).rejects.toThrow(/signature|publisher/);
				expect(stop).not.toHaveBeenCalled();
				expect(
					JSON.parse(fs.readFileSync(path.join(installed, 'plugin.json'), 'utf8')).version
				).toBe('1.0.0');
			}
		}
	);

	it.each([trustedSigner, strangerSigner])(
		'anchors a legacy entry to its recorded publisher before rejecting a live conflict',
		async (candidateSigner) => {
			const manager = new PluginManager({
				isEnabled: () => true,
				trustedKeys: () => [trustedSigner.publicKeyB64, strangerSigner.publicKeyB64],
			});
			const id = 'legacy.publisher';
			const installed = writeCodePlugin(id);
			signPluginDir(installed, trustedSigner);
			await manager.refresh();
			writePluginState({ plugins: { [id]: { enabled: false } } });
			const replacement = path.join(workDir, 'replacement');
			fs.cpSync(installed, replacement, { recursive: true });
			const manifestPath = path.join(replacement, 'plugin.json');
			const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
			fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, version: '2.0.0' }));
			signPluginDir(replacement, candidateSigner);
			signPluginDir(installed, strangerSigner);
			await expect(manager.update(replacement, id)).rejects.toThrow(/publisher|signature/);
			expect(readPluginState().plugins[id]?.trustedPublisher).toBe(trustedSigner.publicKeyB64);
		}
	);

	it.each([
		{ live: 'missing', candidate: 'unsigned', recorded: true, accept: false },
		{ live: 'missing', candidate: 'different', recorded: true, accept: false },
		{ live: 'missing', candidate: 'recorded', recorded: true, accept: true },
		{ live: 'invalid', candidate: 'unsigned', recorded: true, accept: false },
		{ live: 'invalid', candidate: 'recorded', recorded: true, accept: true },
		{ live: 'conflicting', candidate: 'different', recorded: true, accept: false },
		{ live: 'conflicting', candidate: 'recorded', recorded: true, accept: false },
		{ live: 'invalid', candidate: 'recorded', recorded: false, accept: false },
	])(
		'uses authenticated anchors for live=$live candidate=$candidate recorded=$recorded',
		async ({ live, candidate, recorded, accept }) => {
			const sandbox = makeSandbox();
			const manager = new PluginManager({
				isEnabled: () => true,
				sandbox,
				trustedKeys: () => [trustedSigner.publicKeyB64, strangerSigner.publicKeyB64],
			});
			const id = 'publisher.consumer';
			const installed = writeCodePlugin(id);
			if (recorded) signPluginDir(installed, trustedSigner);
			await manager.refresh();
			if (recorded) await manager.setEnabled(id, true);
			const replacement = path.join(workDir, 'replacement');
			fs.cpSync(installed, replacement, { recursive: true });
			const manifestPath = path.join(replacement, 'plugin.json');
			const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
			fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, version: '2.0.0' }));
			fs.writeFileSync(path.join(replacement, 'main.js'), 'replacement bytes');
			if (candidate === 'unsigned') {
				fs.rmSync(path.join(replacement, SIGNATURE_FILENAME), { force: true });
			} else {
				signPluginDir(replacement, candidate === 'different' ? strangerSigner : trustedSigner);
			}
			const archive = path.join(workDir, 'replacement.tgz');
			await packPluginArchive(replacement, archive);
			if (live === 'missing') {
				fs.rmSync(path.join(installed, SIGNATURE_FILENAME));
			} else if (live === 'invalid') {
				fs.writeFileSync(path.join(installed, SIGNATURE_FILENAME), '{broken signature');
			} else {
				signPluginDir(installed, strangerSigner);
			}
			const before = fs.readFileSync(path.join(installed, 'main.js'), 'utf8');
			const stop = vi.spyOn(manager, 'stopAndDrain');
			if (accept) {
				const result = await manager.update(archive, id);
				expect(result.records.find((record) => record.id === id)).toMatchObject({
					manifest: { version: '2.0.0' },
					signature: { status: 'trusted', signerKey: trustedSigner.publicKeyB64 },
				});
			} else {
				await expect(manager.update(archive, id)).rejects.toThrow(/signature|publisher/);
				expect(stop).not.toHaveBeenCalled();
				expect(fs.readFileSync(path.join(installed, 'main.js'), 'utf8')).toBe(before);
				expect(
					JSON.parse(fs.readFileSync(path.join(installed, 'plugin.json'), 'utf8')).version
				).toBe('1.0.0');
			}
		}
	);

	it.each(['backup', 'swap', 'restore'])(
		'reconciles signed tier-1 runtime admission after a %s failure',
		async (failure) => {
			const id = 'recovery.consumer';
			const sandbox = makeSandbox();
			const drained = Promise.withResolvers<void>();
			const stop = sandbox.stop;
			sandbox.stop = vi.fn((pluginId) => drained.promise.then(() => stop(pluginId)));
			const data = new PluginKvStore({ baseDir: path.join(workDir, 'plugin-data') });
			const grants = [{ capability: 'storage:read' as const }];
			const settings = new Map([[`plugins.${id}.token`, 'saved-setting']]);
			const purgePluginData = vi.fn(() => {
				data.purge(id);
				grants.length = 0;
				settings.clear();
			});
			const manager = new PluginManager({
				isEnabled: () => true,
				sandbox,
				trustedKeys: () => [trustedSigner.publicKeyB64],
				getGrants: () => grants,
				purgePluginData,
			});
			const installed = writeCodePlugin(id);
			signPluginDir(installed, trustedSigner);
			await manager.refresh();
			await manager.setEnabled(id, true);
			expect(sandbox.isRunning(id)).toBe(true);
			data.set(id, 'token', 'saved-data');
			const replacement = path.join(workDir, 'replacement');
			fs.cpSync(installed, replacement, { recursive: true });
			const manifestPath = path.join(replacement, 'plugin.json');
			const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
			fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, version: '2.0.0' }));
			signPluginDir(replacement, trustedSigner);
			const archive = path.join(workDir, 'replacement.tgz');
			await packPluginArchive(replacement, archive);
			const start = sandbox.start;
			const startedVersions: string[] = [];
			sandbox.start = vi.fn((pluginId, dir, entry) => {
				const record = manager.getRegistry().records.find((item) => item.id === pluginId)!;
				// The restored child may start only after the mutation admission barrier clears.
				expect(() => manager.assertToolRecordCurrent(record)).not.toThrow();
				startedVersions.push(
					JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8')).version
				);
				start(pluginId, dir, entry);
			});
			const rename = (await vi.importActual<typeof import('fs')>('fs')).renameSync;
			const renameSpy = vi
				.mocked(fs.renameSync)
				.mockClear()
				.mockImplementation((from, to) => {
					if (
						(failure === 'restore' && String(from).includes('.update-')) ||
						(failure === 'backup' && String(from) === installed) ||
						(failure === 'swap' && String(to) === installed && path.basename(String(from)) === id)
					) {
						throw new Error(`synthetic ${failure} failure`);
					}
					return rename(from, to);
				});
			const update = manager.update(archive, id);
			const outcome = update.catch((error: unknown) => error);
			try {
				await vi.waitFor(() => expect(sandbox.stop).toHaveBeenCalledWith(id));
				await manager.refresh();
				expect(sandbox.isRunning(id)).toBe(true); // The old child has not exited yet.
				expect(sandbox.start).not.toHaveBeenCalled();
				expect(renameSpy).not.toHaveBeenCalled();
				drained.resolve();
				const result = await outcome;
				expect(result).toBeInstanceOf(Error);
				if (failure === 'restore') expect(String(result)).toMatch(/original plugin retained at/);
				else expect(result).toMatchObject({ message: `synthetic ${failure} failure` });
			} finally {
				drained.resolve();
				await outcome;
				renameSpy.mockImplementation(rename);
			}
			if (failure === 'restore') {
				expect(sandbox.start).not.toHaveBeenCalled();
				expect(sandbox.isRunning(id)).toBe(false);
				expect(manager.getRegistry().records.find((record) => record.id === id)).toBeUndefined();
				expect(fs.existsSync(installed)).toBe(false);
				const recovery = fs.readdirSync(pluginsDir()).find((name) => name.startsWith('.update-'))!;
				expect(
					JSON.parse(
						fs.readFileSync(path.join(pluginsDir(), recovery, `${id}.old`, 'plugin.json'), 'utf8')
					).version
				).toBe('1.0.0');
			} else {
				expect(sandbox.start).toHaveBeenCalledExactlyOnceWith(id, installed, 'main.js');
				expect(startedVersions).toEqual(['1.0.0']);
				expect(sandbox.isRunning(id)).toBe(true);
				expect(manager.getRegistry().records.find((record) => record.id === id)).toMatchObject({
					manifest: { version: '1.0.0' },
					signature: { status: 'trusted', signerKey: trustedSigner.publicKeyB64 },
				});
			}
			expect(data.get(id, 'token')).toBe('saved-data');
			expect(grants).toEqual([{ capability: 'storage:read' }]);
			expect(settings.get(`plugins.${id}.token`)).toBe('saved-setting');
			expect(purgePluginData).not.toHaveBeenCalled();
			if (failure !== 'restore') expect(fs.readdirSync(pluginsDir())).toEqual([id]);
		}
	);
});

describe('FC1 trusted-to-run gate', () => {
	it('starts a sandbox for an enabled plugin signed by a trusted key', async () => {
		const sandbox = makeSandbox();
		const manager = makeManager(sandbox);
		const dir = writeCodePlugin('trusted.plugin');
		signPluginDir(dir, trustedSigner);
		await manager.refresh();
		await manager.setEnabled('trusted.plugin', true);
		expect(sandbox.start).toHaveBeenCalledTimes(1);
		expect(sandbox.isRunning('trusted.plugin')).toBe(true);
	});

	it('never starts an UNSIGNED plugin, even when enabled', async () => {
		const sandbox = makeSandbox();
		const manager = makeManager(sandbox);
		writeCodePlugin('unsigned.plugin');
		await manager.refresh();
		await manager.setEnabled('unsigned.plugin', true);
		expect(sandbox.start).not.toHaveBeenCalled();
		expect(
			manager.getRegistry().records.find((r) => r.id === 'unsigned.plugin')?.signature?.status ??
				'unsigned'
		).toBe('unsigned');
	});

	it('never starts an UNTRUSTED plugin (valid signature, unknown key)', async () => {
		const sandbox = makeSandbox();
		const manager = makeManager(sandbox);
		const dir = writeCodePlugin('untrusted.plugin');
		signPluginDir(dir, strangerSigner);
		await manager.refresh();
		await manager.setEnabled('untrusted.plugin', true);
		expect(sandbox.start).not.toHaveBeenCalled();
		expect(
			manager.getRegistry().records.find((r) => r.id === 'untrusted.plugin')?.signature?.status
		).toBe('untrusted');
	});

	it('never starts an INVALID plugin (tampered after signing)', async () => {
		const sandbox = makeSandbox();
		const manager = makeManager(sandbox);
		const dir = writeCodePlugin('tampered.plugin');
		signPluginDir(dir, trustedSigner);
		fs.writeFileSync(path.join(dir, 'main.js'), 'module.exports = { evil: true };');
		await manager.refresh();
		await manager.setEnabled('tampered.plugin', true);
		expect(sandbox.start).not.toHaveBeenCalled();
		expect(
			manager.getRegistry().records.find((r) => r.id === 'tampered.plugin')?.signature?.status
		).toBe('invalid');
	});

	it('a trusted plugin whose signer key is REMOVED from the trusted set stops running on refresh', async () => {
		const sandbox = makeSandbox();
		let trusted: string[] = [trustedSigner.publicKeyB64];
		const manager = new PluginManager({
			isEnabled: () => true,
			sandbox,
			trustedKeys: () => trusted,
		});
		const dir = writeCodePlugin('rotating.plugin');
		signPluginDir(dir, trustedSigner);
		await manager.refresh();
		await manager.setEnabled('rotating.plugin', true);
		expect(sandbox.isRunning('rotating.plugin')).toBe(true);

		trusted = []; // key rotation / revocation
		await manager.refresh();
		expect(sandbox.stop).toHaveBeenCalledWith('rotating.plugin');
		expect(sandbox.isRunning('rotating.plugin')).toBe(false);
	});

	it('declarative contributions still aggregate for an enabled UNTRUSTED plugin (code-only gate)', async () => {
		const sandbox = makeSandbox();
		const manager = makeManager(sandbox);
		const dir = writeCodePlugin('declarative.plugin', { theme: true });
		signPluginDir(dir, strangerSigner);
		await manager.refresh();
		await manager.setEnabled('declarative.plugin', true);
		expect(sandbox.start).not.toHaveBeenCalled();
		const themes = manager.getContributions().themes;
		expect(themes.some((t) => t.id === 'declarative.plugin/gate-theme')).toBe(true);
	});

	it('tampered (invalid) plugins contribute NOTHING - declarative surface included', async () => {
		const sandbox = makeSandbox();
		const manager = makeManager(sandbox);
		const dir = writeCodePlugin('tampered.data', { theme: true });
		signPluginDir(dir, trustedSigner);
		fs.writeFileSync(path.join(dir, 'main.js'), 'module.exports = { evil: true };');
		await manager.refresh();
		await manager.setEnabled('tampered.data', true);
		const themes = manager.getContributions().themes;
		expect(themes.some((t) => t.pluginId === 'tampered.data')).toBe(false);
	});
});

describe('settings panel activation boundary', () => {
	it('requires trust, enable and live ui:panel consent and removes HTML on disable/uninstall', async () => {
		let grants = [{ capability: 'ui:panel' as const }];
		const manager = new PluginManager({
			isEnabled: () => true,
			sandbox: makeSandbox(),
			trustedKeys: () => [trustedSigner.publicKeyB64],
			getGrants: () => grants,
		});
		const trusted = writeCodePlugin('settings.trusted', { settings: true });
		signPluginDir(trusted, trustedSigner);
		writeCodePlugin('settings.unsigned', { settings: true });
		await manager.refresh();
		await manager.setEnabled('settings.trusted', true);
		await manager.setEnabled('settings.unsigned', true);
		expect(manager.getContributions().panels.map((p) => p.id)).toEqual(['settings.trusted/config']);
		expect(manager.getPanelHtml('settings.trusted/config')).toContain('settings');
		grants = [];
		expect(manager.getContributions().panels).toEqual([]);
		expect(manager.getPanelHtml('settings.trusted/config')).toBeNull();
		grants = [{ capability: 'ui:panel' }];
		await manager.setEnabled('settings.trusted', false);
		expect(manager.getContributions().panels).toEqual([]);
		await manager.setEnabled('settings.trusted', true);
		await manager.uninstall('settings.trusted');
		expect(manager.getPanelHtml('settings.trusted/config')).toBeNull();
	});
});

describe('explicit service startup dependencies', () => {
	it.each(['before-exit', 'during-cleanup', 'failed-cleanup'] as const)(
		'rechecks a mandatory consumer after drain (%s)',
		async (phase) => {
			let available = true;
			let draining = false;
			const cleanup = Promise.withResolvers<void>();
			const sandbox = makeSandbox();
			const start = sandbox.start;
			const stop = sandbox.stop;
			sandbox.start = vi.fn((...args) => {
				if (draining) throw new Error('PluginDrainPending');
				start(...args);
			});
			sandbox.stop = vi.fn((id) => {
				draining = true;
				if (phase !== 'before-exit') stop(id);
				return cleanup.promise.then(() => {
					stop(id);
					draining = false;
				});
			});
			const manager = new PluginManager({
				isEnabled: () => true,
				sandbox,
				trustedKeys: () => [trustedSigner.publicKeyB64],
				serviceAvailable: () => available,
			});
			const requirement = {
				id: 'voice',
				provider: 'example.media',
				service: 'transcription',
				contract: 'maestro.audio.transcribe' as const,
				version: '^1.0.0',
			};
			signPluginDir(
				writeCodePlugin('mandatory.consumer', { requires: [requirement] }),
				trustedSigner
			);
			await manager.refresh();
			await manager.setEnabled('mandatory.consumer', true);
			expect(sandbox.isRunning('mandatory.consumer')).toBe(true);
			available = false;
			manager.reconcileServiceDependencies();
			available = true;
			manager.reconcileServiceDependencies();
			if (phase === 'failed-cleanup') {
				cleanup.reject(new Error('MediaProcessFailed'));
				await Promise.resolve();
				await Promise.resolve();
				expect(sandbox.isRunning('mandatory.consumer')).toBe(false);
			} else {
				cleanup.resolve();
				await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(2));
				expect(sandbox.isRunning('mandatory.consumer')).toBe(true);
			}
		}
	);

	it.each(['update', 'uninstall', 'update-then-uninstall'] as const)(
		'does not restart old code while %s waits for a dependency drain',
		async (operation) => {
			let available = true;
			const gate = Promise.withResolvers<void>();
			const sandbox = makeSandbox();
			const start = sandbox.start;
			const stop = sandbox.stop;
			sandbox.stop = vi.fn((id) => {
				stop(id);
				return gate.promise;
			});
			const requirement = {
				id: 'voice',
				provider: 'example.media',
				service: 'transcription',
				contract: 'maestro.audio.transcribe' as const,
				version: '^1.0.0',
			};
			const source = writeCodePlugin('mandatory.consumer', { requires: [requirement] });
			signPluginDir(source, trustedSigner);
			const replacement = path.join(workDir, 'replacement');
			fs.cpSync(source, replacement, { recursive: true });
			const manifest = JSON.parse(fs.readFileSync(path.join(replacement, 'plugin.json'), 'utf8'));
			manifest.version = '2.0.0';
			fs.writeFileSync(path.join(replacement, 'plugin.json'), JSON.stringify(manifest));
			fs.writeFileSync(
				path.join(replacement, 'main.js'),
				'module.exports = { activate() { /* new */ } };'
			);
			signPluginDir(replacement, trustedSigner);
			const manager = new PluginManager({
				isEnabled: () => true,
				sandbox,
				trustedKeys: () => [trustedSigner.publicKeyB64],
				serviceAvailable: () => available,
			});
			await manager.refresh();
			await manager.setEnabled('mandatory.consumer', true);
			const startImpl = vi.mocked(start).getMockImplementation()!;
			const startedVersions: string[] = [];
			vi.mocked(start).mockImplementation((id, dir, entry) => {
				const version = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8')).version;
				startedVersions.push(version);
				startImpl(id, dir, entry);
			});
			available = false;
			manager.reconcileServiceDependencies();
			const pending =
				operation === 'update-then-uninstall'
					? Promise.all([manager.update(replacement), manager.uninstall('mandatory.consumer')])
					: operation === 'update'
						? manager.update(replacement)
						: manager.uninstall('mandatory.consumer');
			await Promise.resolve();
			if (operation !== 'update') expect(fs.existsSync(source)).toBe(true);
			available = true;
			manager.reconcileServiceDependencies();
			expect(start).toHaveBeenCalledTimes(1);
			gate.resolve();
			await pending;
			await Promise.resolve();
			await Promise.resolve();
			if (operation === 'update') {
				expect(start).toHaveBeenCalledTimes(2);
				expect(startedVersions).toEqual(['2.0.0']);
				expect(manager.getRegistry().records[0].manifest?.version).toBe('2.0.0');
			} else {
				expect(start).toHaveBeenCalledTimes(1);
				expect(fs.existsSync(source)).toBe(false);
			}
		}
	);

	it('does not restart a retained old record when the feature is disabled during a failed update', async () => {
		let enabled = true;
		const gate = Promise.withResolvers<void>();
		const sandbox = makeSandbox();
		const stop = sandbox.stop;
		sandbox.stop = vi.fn((id) => {
			stop(id);
			return gate.promise;
		});
		const source = writeCodePlugin('feature.consumer');
		signPluginDir(source, trustedSigner);
		const replacement = path.join(workDir, 'replacement');
		fs.cpSync(source, replacement, { recursive: true });
		const manifest = JSON.parse(fs.readFileSync(path.join(replacement, 'plugin.json'), 'utf8'));
		manifest.version = '2.0.0';
		fs.writeFileSync(path.join(replacement, 'plugin.json'), JSON.stringify(manifest));
		signPluginDir(replacement, trustedSigner);
		const manager = new PluginManager({
			isEnabled: () => enabled,
			sandbox,
			trustedKeys: () => [trustedSigner.publicKeyB64],
		});
		await manager.refresh();
		await manager.setEnabled('feature.consumer', true);
		const pending = manager.update(replacement);
		await vi.waitFor(() => expect(sandbox.stop).toHaveBeenCalledWith('feature.consumer'));
		enabled = false;
		manager.stopAllSandboxes();
		const rename = vi.mocked(fs.renameSync).mockImplementation(() => {
			throw new Error('swap failed');
		});
		try {
			const rejected = expect(pending).rejects.toThrow('swap failed');
			gate.resolve();
			await rejected;
			expect(fs.existsSync(source)).toBe(true);
			expect(sandbox.start).toHaveBeenCalledTimes(1);
			expect(sandbox.isRunning('feature.consumer')).toBe(false);
		} finally {
			rename.mockReset();
		}
	});

	it('starts/stops mandatory consumers with availability while optional denial leaves text plugins running', async () => {
		let available = false;
		const sandbox = makeSandbox();
		const manager = new PluginManager({
			isEnabled: () => true,
			sandbox,
			trustedKeys: () => [trustedSigner.publicKeyB64],
			serviceAvailable: () => available,
		});
		const requirement = {
			id: 'voice',
			provider: 'example.media',
			service: 'transcription',
			contract: 'maestro.audio.transcribe' as const,
			version: '^1.0.0',
		};
		signPluginDir(
			writeCodePlugin('mandatory.consumer', { requires: [requirement] }),
			trustedSigner
		);
		signPluginDir(
			writeCodePlugin('optional.consumer', { requires: [{ ...requirement, optional: true }] }),
			trustedSigner
		);
		await manager.refresh();
		await manager.setEnabled('mandatory.consumer', true);
		await manager.setEnabled('optional.consumer', true);
		expect(sandbox.isRunning('mandatory.consumer')).toBe(false);
		expect(sandbox.isRunning('optional.consumer')).toBe(true);
		available = true;
		manager.reconcileServiceDependencies();
		expect(sandbox.isRunning('mandatory.consumer')).toBe(true);
		available = false;
		manager.reconcileServiceDependencies();
		expect(sandbox.isRunning('mandatory.consumer')).toBe(false);
		expect(sandbox.isRunning('optional.consumer')).toBe(true);
	});
});
