vi.mock('../../../main/plugins/plugin-scan', async () => await import('../../helpers/pluginScan'));
/**
 * @file plugin-manager-update.test.ts
 * @description Version-aware LOCAL update of an installed plugin. A strictly
 * newer version swaps the files on disk and preserves the persisted enable
 * toggle (trust is recomputed from the new bytes by refresh(), but the toggle
 * survives). A downgrade, an equal version, a symlinked source tree, and
 * updating an id that is not installed are all rejected.
 *
 * Uses a real temp dir (os.tmpdir + path.join + real fs) so the on-disk swap is
 * exercised end to end, OS-agnostically. The plugins data dir is redirected via
 * MAESTRO_USER_DATA, which plugin-store-main honors ahead of Electron's
 * app.getPath; electron is mocked so importing the module never touches the
 * (absent) Electron runtime.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('fs', async () => {
	const actual = await vi.importActual<typeof import('fs')>('fs');
	return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

vi.mock('electron', () => ({
	// Never actually called (MAESTRO_USER_DATA wins in dataDir()), but present so
	// the named `app` import resolves cleanly under the test runner.
	app: { getPath: () => os.tmpdir() },
}));

import { packPluginArchive } from '../../../shared/plugins/plugin-archive';
import { PluginManager } from '../../../main/plugins/plugin-manager';
import {
	pluginsDir,
	readPluginState,
	writePluginState,
} from '../../../main/plugins/plugin-store-main';
import { PLUGIN_STATE_FILENAME } from '../../../shared/plugins/storage';
import { PluginKvStore } from '../../../main/plugins/plugin-kv-store';
import { makeSigningKeys, signPluginDir } from './plugin-signing-helper';

const PLUGIN_ID = 'demo-plugin';

interface ManifestOpts {
	version: string;
	tier?: 0 | 1;
	entry?: string;
	permissions?: Array<{ capability: string; reason: string }>;
}

function makeManifest(opts: ManifestOpts): Record<string, unknown> {
	const tier = opts.tier ?? 0;
	return {
		id: PLUGIN_ID,
		name: 'Demo Plugin',
		version: opts.version,
		tier,
		maestro: { minHostApi: '1.0.0' },
		...(tier >= 1 ? { entry: opts.entry ?? 'main.js' } : {}),
		...(opts.permissions ? { permissions: opts.permissions } : {}),
	};
}

/** Materialize a plugin source tree (manifest + arbitrary extra files). */
function writeSource(dir: string, opts: ManifestOpts, files: Record<string, string> = {}): string {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(makeManifest(opts), null, 2));
	for (const [rel, content] of Object.entries(files)) {
		const abs = path.join(dir, rel);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, content);
	}
	return dir;
}

function makeManager(): PluginManager {
	return new PluginManager({ isEnabled: () => true });
}

let workDir: string;
let prevUserData: string | undefined;

beforeEach(() => {
	prevUserData = process.env.MAESTRO_USER_DATA;
	workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-update-'));
	// Point the plugin store at an isolated, fresh data dir for every test.
	process.env.MAESTRO_USER_DATA = path.join(workDir, 'userData');
});

afterEach(() => {
	if (prevUserData === undefined) delete process.env.MAESTRO_USER_DATA;
	else process.env.MAESTRO_USER_DATA = prevUserData;
	fs.rmSync(workDir, { recursive: true, force: true });
});

describe('PluginManager.update', () => {
	it('does not anchor a different alias tree from the cached registry', async () => {
		const keys = makeSigningKeys();
		const aliasKeys = makeSigningKeys();
		const manager = new PluginManager({
			isEnabled: () => true,
			trustedKeys: () => [keys.publicKeyB64, aliasKeys.publicKeyB64],
		});
		const old = writeSource(path.join(workDir, 'old'), { version: '1.0.0' });
		expect((await manager.install(old)).success).toBe(true);
		const canonical = path.join(pluginsDir(), PLUGIN_ID);
		const held = path.join(workDir, 'held');
		fs.renameSync(canonical, held);
		const alias = writeSource(path.join(pluginsDir(), 'alias'), { version: '1.0.0' });
		signPluginDir(alias, aliasKeys);
		await manager.refresh();
		expect(manager.getRegistry().records.find((record) => record.id === PLUGIN_ID)?.source).toBe(
			alias
		);
		expect(readPluginState().plugins[PLUGIN_ID]?.trustedPublisher).toBeUndefined();
		fs.renameSync(held, canonical);
		const next = writeSource(path.join(workDir, 'next'), { version: '2.0.0' });
		signPluginDir(next, keys);
		await manager.update(next, PLUGIN_ID);
		expect(readPluginState().plugins[PLUGIN_ID]?.trustedPublisher).toBe(keys.publicKeyB64);
		expect(JSON.parse(fs.readFileSync(path.join(canonical, 'plugin.json'), 'utf8')).version).toBe(
			'2.0.0'
		);
	});

	it.each([0, 1] as const)(
		'persists the first tier-%s installed publisher until explicit uninstall',
		async (tier) => {
			const keys = makeSigningKeys();
			const nextKeys = makeSigningKeys();
			const manager = new PluginManager({
				isEnabled: () => true,
				trustedKeys: () => [keys.publicKeyB64, nextKeys.publicKeyB64],
			});
			const source = writeSource(
				path.join(workDir, 'source'),
				{ version: '1.0.0', tier },
				{
					'main.js': 'original',
				}
			);
			signPluginDir(source, keys);
			expect((await manager.install(source)).success).toBe(true);
			expect(readPluginState().plugins[PLUGIN_ID]).toEqual({
				enabled: tier === 0,
				trustedPublisher: keys.publicKeyB64,
			});
			await manager.setEnabled(PLUGIN_ID, true);
			await manager.setEnabled(PLUGIN_ID, false);
			expect(readPluginState().plugins[PLUGIN_ID]).toEqual({
				enabled: false,
				trustedPublisher: keys.publicKeyB64,
			});
			await manager.refresh();
			await manager.uninstall(PLUGIN_ID);
			expect(readPluginState().plugins[PLUGIN_ID]).toBeUndefined();
			signPluginDir(source, nextKeys);
			expect((await manager.install(source)).success).toBe(true);
			expect(readPluginState().plugins[PLUGIN_ID]?.trustedPublisher).toBe(nextKeys.publicKeyB64);
		}
	);

	it.each(['unsigned', 'untrusted', 'invalid'])(
		'does not bootstrap a publisher from %s installed bytes',
		async (status) => {
			const keys = makeSigningKeys();
			const other = makeSigningKeys();
			const manager = new PluginManager({
				isEnabled: () => true,
				trustedKeys: () => [keys.publicKeyB64],
			});
			const source = writeSource(
				path.join(workDir, 'source'),
				{ version: '1.0.0' },
				{
					'marker.txt': 'original',
				}
			);
			if (status !== 'unsigned') signPluginDir(source, status === 'untrusted' ? other : keys);
			if (status === 'invalid') fs.writeFileSync(path.join(source, 'marker.txt'), 'tampered');
			expect((await manager.install(source)).success).toBe(true);
			await manager.refresh();
			expect(readPluginState().plugins[PLUGIN_ID]?.trustedPublisher).toBeUndefined();
		}
	);

	it('keeps a malformed-present publisher blocked instead of seeding from discovery', async () => {
		const keys = makeSigningKeys();
		const manager = new PluginManager({
			isEnabled: () => true,
			trustedKeys: () => [keys.publicKeyB64],
		});
		const old = writeSource(path.join(workDir, 'old'), { version: '1.0.0' });
		signPluginDir(old, keys);
		expect((await manager.install(old)).success).toBe(true);
		writePluginState({ plugins: { [PLUGIN_ID]: { enabled: false, trustedPublisher: 42 } } });
		await manager.refresh();
		const source = writeSource(path.join(workDir, 'next'), { version: '2.0.0' });
		signPluginDir(source, keys);
		const stop = vi.spyOn(manager, 'stopAndDrain');
		await expect(manager.update(source, PLUGIN_ID)).rejects.toThrow(/publisher|signature/);
		expect(stop).not.toHaveBeenCalled();
		expect(readPluginState().plugins[PLUGIN_ID]?.trustedPublisher).toBeNull();
	});

	it('fails before stop when recording an installed publisher cannot be committed', async () => {
		const keys = makeSigningKeys();
		const manager = new PluginManager({
			isEnabled: () => true,
			trustedKeys: () => [keys.publicKeyB64],
		});
		const old = writeSource(path.join(workDir, 'old'), { version: '1.0.0' });
		signPluginDir(old, keys);
		expect((await manager.install(old)).success).toBe(true);
		writePluginState({ plugins: { [PLUGIN_ID]: { enabled: false } } }); // Legacy entry.
		const source = writeSource(path.join(workDir, 'next'), { version: '2.0.0' });
		signPluginDir(source, keys);
		const rename = (await vi.importActual<typeof import('fs')>('fs')).renameSync;
		vi.mocked(fs.renameSync).mockImplementation((from, to) => {
			if (String(to) === path.join(workDir, 'userData', PLUGIN_STATE_FILENAME)) {
				throw new Error('synthetic publisher persistence failure');
			}
			return rename(from, to);
		});
		const stop = vi.spyOn(manager, 'stopAndDrain');
		try {
			await expect(manager.update(source, PLUGIN_ID)).rejects.toThrow(
				'publisher persistence failure'
			);
		} finally {
			vi.mocked(fs.renameSync).mockImplementation(rename);
		}
		expect(stop).not.toHaveBeenCalled();
		expect(
			manager.getRegistry().records.find((record) => record.id === PLUGIN_ID)?.manifest?.version
		).toBe('1.0.0');
		expect(fs.readdirSync(pluginsDir())).toEqual([PLUGIN_ID]);
	});

	it.each(
		['tgz', 'tar.gz'].flatMap((extension) =>
			[false, true].flatMap((manifest) =>
				['install', 'update'].map((operation) => ({ extension, manifest, operation }))
			)
		)
	)(
		'uses $operation for an unpacked .$extension folder (selected manifest: $manifest)',
		async ({ extension, manifest, operation }) => {
			const manager = makeManager();
			if (operation === 'update') {
				const original = writeSource(path.join(workDir, 'old'), { version: '1.0.0' });
				expect((await manager.install(original)).success).toBe(true);
			}
			const source = writeSource(path.join(workDir, `release.${extension}`), {
				version: '2.0.0',
			});
			const selected = manifest ? path.join(source, 'plugin.json') : source;
			if (operation === 'install') {
				expect((await manager.install(selected)).success).toBe(true);
			} else {
				await manager.update(selected, PLUGIN_ID);
			}
			expect(manager.getRegistry().records.find((r) => r.id === PLUGIN_ID)?.manifest?.version).toBe(
				'2.0.0'
			);
		}
	);

	it('installs and updates through a selected plugin.json with normal folder validation', async () => {
		const manager = makeManager();
		const old = writeSource(path.join(workDir, 'old'), { version: '1.0.0' });
		expect((await manager.install(path.join(old, 'plugin.json'))).success).toBe(true);
		const next = writeSource(path.join(workDir, 'new'), { version: '1.0.1' });
		const result = await manager.update(path.join(next, 'plugin.json'), PLUGIN_ID);
		expect(result.records.find((r) => r.id === PLUGIN_ID)?.manifest?.version).toBe('1.0.1');
	});

	it.each(['linked manifest', 'linked folder', 'other json', 'malformed manifest'])(
		'rejects an unsafe manifest selection while retaining installed bytes: %s',
		async (kind) => {
			const manager = makeManager();
			const old = writeSource(path.join(workDir, 'old'), { version: '1.0.0' });
			expect((await manager.install(old)).success).toBe(true);
			const next = writeSource(path.join(workDir, 'new'), { version: '1.0.1' });
			let selected = path.join(next, 'plugin.json');
			if (kind === 'linked manifest') {
				fs.renameSync(selected, path.join(next, 'real.json'));
				fs.symlinkSync('real.json', selected);
			} else if (kind === 'linked folder') {
				const alias = path.join(workDir, 'alias');
				fs.symlinkSync(next, alias, 'dir');
				selected = path.join(alias, 'plugin.json');
			} else if (kind === 'other json') {
				selected = path.join(next, 'other.json');
				fs.copyFileSync(path.join(next, 'plugin.json'), selected);
			} else {
				fs.writeFileSync(selected, '{broken');
			}
			await expect(manager.update(selected, PLUGIN_ID)).rejects.toThrow();
			expect(
				JSON.parse(fs.readFileSync(path.join(pluginsDir(), PLUGIN_ID, 'plugin.json'), 'utf8'))
					.version
			).toBe('1.0.0');
		}
	);

	it.each(['tgz', 'tar.gz'])(
		'updates an installed plugin directly from the distributed signed %s',
		async (extension) => {
			const keys = makeSigningKeys();
			const manager = new PluginManager({
				isEnabled: () => true,
				trustedKeys: () => [keys.publicKeyB64],
			});
			const oldSource = writeSource(
				path.join(workDir, 'old'),
				{ version: '1.0.0', tier: 1 },
				{ 'main.js': 'old bytes' }
			);
			signPluginDir(oldSource, keys);
			expect((await manager.install(oldSource)).success).toBe(true);
			const source = writeSource(
				path.join(workDir, 'new'),
				{ version: '1.0.1', tier: 1 },
				{ 'main.js': 'new bytes' }
			);
			signPluginDir(source, keys);
			const archive = path.join(workDir, `distributed.signed.${extension}`);
			await packPluginArchive(source, archive);
			const result = await manager.update(archive, PLUGIN_ID);
			expect(result.records.find((r) => r.id === PLUGIN_ID)).toMatchObject({
				manifest: { version: '1.0.1' },
				signature: { status: 'trusted' },
			});
			expect(fs.readFileSync(path.join(pluginsDir(), PLUGIN_ID, 'main.js'), 'utf8')).toBe(
				'new bytes'
			);
		}
	);
	it.each(['tampered', 'unsigned', 'publisher', 'api', 'id', 'equal', 'older', 'corrupt'])(
		'keeps a trusted installed plugin intact on rejected archive: %s',
		async (failure) => {
			const keys = makeSigningKeys();
			const other = makeSigningKeys();
			const manager = new PluginManager({
				isEnabled: () => true,
				trustedKeys: () => [keys.publicKeyB64, other.publicKeyB64],
			});
			const oldSource = writeSource(
				path.join(workDir, 'old'),
				{ version: '1.0.0', tier: 1 },
				{ 'main.js': 'working' }
			);
			signPluginDir(oldSource, keys);
			expect((await manager.install(oldSource)).success).toBe(true);
			const source = writeSource(
				path.join(workDir, 'next'),
				{
					version: failure === 'equal' ? '1.0.0' : failure === 'older' ? '0.9.0' : '1.0.1',
					tier: 1,
				},
				{ 'main.js': 'replacement' }
			);
			const manifestPath = path.join(source, 'plugin.json');
			const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
			if (failure === 'id') {
				manifest.id = 'other-plugin';
				const otherInstalled = path.join(workDir, 'other-installed');
				fs.mkdirSync(otherInstalled);
				fs.writeFileSync(
					path.join(otherInstalled, 'plugin.json'),
					JSON.stringify({ ...manifest, version: '0.5.0' })
				);
				fs.writeFileSync(path.join(otherInstalled, 'main.js'), 'other working');
				signPluginDir(otherInstalled, keys);
				expect((await manager.install(otherInstalled)).success).toBe(true);
			}
			if (failure === 'api') manifest.maestro.minHostApi = '99.0.0';
			fs.writeFileSync(manifestPath, JSON.stringify(manifest));
			if (failure !== 'unsigned') signPluginDir(source, failure === 'publisher' ? other : keys);
			if (failure === 'tampered') fs.writeFileSync(path.join(source, 'main.js'), 'tampered');
			const archive = path.join(workDir, 'replacement.tar.gz');
			await packPluginArchive(source, archive);
			if (failure === 'corrupt') fs.writeFileSync(archive, 'not gzip');
			const stop = vi.spyOn(manager, 'stopAndDrain');
			await expect(manager.update(archive, PLUGIN_ID)).rejects.toThrow();
			expect(stop).not.toHaveBeenCalled();
			if (failure === 'id')
				expect(fs.readFileSync(path.join(pluginsDir(), 'other-plugin', 'main.js'), 'utf8')).toBe(
					'other working'
				);
			expect(fs.readFileSync(path.join(pluginsDir(), PLUGIN_ID, 'main.js'), 'utf8')).toBe(
				'working'
			);
			expect(
				JSON.parse(fs.readFileSync(path.join(pluginsDir(), PLUGIN_ID, 'plugin.json'), 'utf8'))
					.version
			).toBe('1.0.0');
			expect(manager.getRegistry().records.find((r) => r.id === PLUGIN_ID)?.signature?.status).toBe(
				'trusted'
			);
		}
	);

	it('refreshes the working installation if moving it to backup fails', async () => {
		const onChange = vi.fn();
		const manager = new PluginManager({ isEnabled: () => true, onChange });
		const original = writeSource(path.join(workDir, 'old'), { version: '1.0.0' });
		expect((await manager.install(original)).success).toBe(true);
		const next = writeSource(path.join(workDir, 'next'), { version: '1.0.1' });
		const archive = path.join(workDir, 'next.tgz');
		await packPluginArchive(next, archive);
		onChange.mockClear();
		const rename = (await vi.importActual<typeof import('fs')>('fs')).renameSync;
		vi.mocked(fs.renameSync).mockImplementation((from, to) => {
			if (String(to).endsWith(`${PLUGIN_ID}.old`)) throw new Error('synthetic backup failure');
			return rename(from, to);
		});
		try {
			await expect(manager.update(archive, PLUGIN_ID)).rejects.toThrow('synthetic backup failure');
		} finally {
			vi.mocked(fs.renameSync).mockImplementation(rename);
		}
		expect(onChange).toHaveBeenCalledExactlyOnceWith(manager.getRegistry());
		expect(manager.getRegistry().records.find((r) => r.id === PLUGIN_ID)?.manifest?.version).toBe(
			'1.0.0'
		);
		expect(fs.readdirSync(pluginsDir())).toEqual([PLUGIN_ID]);
	});

	it('restores the working bytes when the staged archive swap fails', async () => {
		const manager = makeManager();
		const original = writeSource(
			path.join(workDir, 'old'),
			{ version: '1.0.0' },
			{ 'marker.txt': 'working' }
		);
		expect((await manager.install(original)).success).toBe(true);
		const source = writeSource(
			path.join(workDir, 'next'),
			{ version: '1.0.1' },
			{ 'marker.txt': 'replacement' }
		);
		const archive = path.join(workDir, 'next.tgz');
		await packPluginArchive(source, archive);
		const rename = (await vi.importActual<typeof import('fs')>('fs')).renameSync;
		const spy = vi.mocked(fs.renameSync).mockImplementation((from, to) => {
			if (String(from).includes('.update-') && !String(from).endsWith('.old'))
				throw new Error('synthetic swap failure');
			return rename(from, to);
		});
		try {
			await expect(manager.update(archive)).rejects.toThrow('synthetic swap failure');
		} finally {
			spy.mockImplementation(rename);
		}
		expect(fs.readFileSync(path.join(pluginsDir(), PLUGIN_ID, 'marker.txt'), 'utf8')).toBe(
			'working'
		);
		expect(manager.getRegistry().records.find((r) => r.id === PLUGIN_ID)?.manifest?.version).toBe(
			'1.0.0'
		);
		expect(fs.readdirSync(pluginsDir())).toEqual([PLUGIN_ID]);
	});

	it('retains the original recovery bytes if both swap and rollback rename fail', async () => {
		const manager = makeManager();
		const original = writeSource(
			path.join(workDir, 'old'),
			{ version: '1.0.0' },
			{ 'marker.txt': 'working' }
		);
		expect((await manager.install(original)).success).toBe(true);
		const source = writeSource(path.join(workDir, 'next'), { version: '1.0.1' });
		const archive = path.join(workDir, 'next.tgz');
		await packPluginArchive(source, archive);
		const rename = (await vi.importActual<typeof import('fs')>('fs')).renameSync;
		vi.mocked(fs.renameSync).mockImplementation((from, to) => {
			if (String(from).includes('.update-')) throw new Error('synthetic filesystem failure');
			return rename(from, to);
		});
		try {
			await expect(manager.update(archive)).rejects.toThrow(/original plugin retained at/);
		} finally {
			vi.mocked(fs.renameSync).mockImplementation(rename);
		}
		const recovery = fs.readdirSync(pluginsDir()).find((name) => name.startsWith('.update-'));
		expect(recovery).toBeDefined();
		expect(
			fs.readFileSync(path.join(pluginsDir(), recovery!, `${PLUGIN_ID}.old`, 'marker.txt'), 'utf8')
		).toBe('working');
	});

	it('preserves KV, SQL, settings, and grants while rechecking the new signature and consent', async () => {
		const keys = makeSigningKeys();
		const kvStore = new PluginKvStore({ baseDir: path.join(workDir, 'userData', 'plugin-data') });
		const sqlFile = path.join(
			workDir,
			'userData',
			'plugin-data',
			'sql',
			PLUGIN_ID,
			'storage.sqlite'
		);
		const settings = new Map([['plugins.demo-plugin.token', 'saved-token']]);
		const grants = [{ capability: 'storage:read' as const }];
		const purgePluginData = vi.fn(() => {
			kvStore.purge(PLUGIN_ID);
			fs.rmSync(path.dirname(sqlFile), { recursive: true, force: true });
			settings.clear();
		});
		const verifyRecord = vi.fn((record: { manifest: { version: string } | null }) => ({
			disable: record.manifest?.version !== '1.0.0',
		}));
		const manager = new PluginManager({
			isEnabled: () => true,
			trustedKeys: () => [keys.publicKeyB64],
			getGrants: () => grants,
			verifyRecord,
			purgePluginData,
		});
		const src1 = writeSource(
			path.join(workDir, 'src-v1'),
			{ version: '1.0.0', tier: 1 },
			{
				'main.js': 'module.exports = "v1";',
			}
		);
		signPluginDir(src1, keys);
		expect(await (await manager.install(src1)).success).toBe(true);
		await manager.setEnabled(PLUGIN_ID, true);
		kvStore.set(PLUGIN_ID, 'token', 'saved-token');
		fs.mkdirSync(path.dirname(sqlFile), { recursive: true });
		fs.writeFileSync(sqlFile, 'saved-sql-data');

		const src2 = writeSource(
			path.join(workDir, 'src-v2'),
			{
				version: '2.0.0',
				tier: 1,
				permissions: [{ capability: 'notifications:toast', reason: 'New permission' }],
			},
			{ 'main.js': 'module.exports = "v2";' }
		);
		signPluginDir(src2, keys);
		const archive = path.join(workDir, 'state-preservation.tgz');
		await packPluginArchive(src2, archive);
		const registry = await manager.update(archive);
		const record = registry.records.find((entry) => entry.id === PLUGIN_ID);

		expect(record?.manifest?.version).toBe('2.0.0');
		expect(record?.signature?.status).toBe('trusted');
		expect(verifyRecord).toHaveBeenCalledWith(
			expect.objectContaining({ manifest: record?.manifest }),
			expect.anything()
		);
		expect(record?.enabled).toBe(false); // new identity requires fresh consent
		expect(grants).toEqual([{ capability: 'storage:read' }]);
		expect(purgePluginData).not.toHaveBeenCalled();
		expect(kvStore.get(PLUGIN_ID, 'token')).toBe('saved-token');
		expect(fs.readFileSync(sqlFile, 'utf-8')).toBe('saved-sql-data');
		expect(settings.get('plugins.demo-plugin.token')).toBe('saved-token');
	});
	it('updates to a higher version, swaps the files on disk, and preserves the enable toggle', async () => {
		const manager = makeManager();
		const src1 = writeSource(
			path.join(workDir, 'src-v1'),
			{ version: '1.0.0', tier: 1 },
			{
				'main.js': 'module.exports = "v1";',
				'marker.txt': 'one',
				'old-only.txt': 'gone-after-update',
			}
		);
		expect(await (await manager.install(src1)).success).toBe(true);

		// tier-1 plugins default to DISABLED; enabling it makes the toggle a
		// non-default value, so a wrongly-reset toggle after update would be caught.
		await manager.setEnabled(PLUGIN_ID, true);
		expect(manager.getRegistry().records.find((r) => r.id === PLUGIN_ID)?.enabled).toBe(true);

		const src2 = writeSource(
			path.join(workDir, 'src-v2'),
			{ version: '2.0.0', tier: 1 },
			{
				'main.js': 'module.exports = "v2";',
				'marker.txt': 'two',
			}
		);
		const registry = await manager.update(src2);

		const record = registry.records.find((r) => r.id === PLUGIN_ID);
		expect(record?.manifest?.version).toBe('2.0.0');
		// Enable toggle preserved across the update (still enabled).
		expect(record?.enabled).toBe(true);

		// Files were replaced (not merged) on disk.
		const installedDir = path.join(pluginsDir(), PLUGIN_ID);
		expect(fs.readFileSync(path.join(installedDir, 'main.js'), 'utf-8')).toBe(
			'module.exports = "v2";'
		);
		expect(fs.readFileSync(path.join(installedDir, 'marker.txt'), 'utf-8')).toBe('two');
		const onDisk = JSON.parse(fs.readFileSync(path.join(installedDir, 'plugin.json'), 'utf-8'));
		expect(onDisk.version).toBe('2.0.0');
		// A file present only in the old version is gone: this is a swap, not a merge.
		expect(fs.existsSync(path.join(installedDir, 'old-only.txt'))).toBe(false);
	});

	it.each([false, true])(
		'awaits stop cleanup before swapping files (cleanup failure=%s)',
		async (fail) => {
			const gate = Promise.withResolvers<void>();
			const stop = vi.fn(() => gate.promise);
			const manager = new PluginManager({
				isEnabled: () => true,
				sandbox: {
					start: vi.fn(),
					stop,
					stopAll: vi.fn(),
					isRunning: () => false,
					runningIds: () => [],
					invokeCommand: () => false,
					invokeTool: vi.fn(),
				},
			});
			const original = writeSource(
				path.join(workDir, 'original'),
				{ version: '1.0.0' },
				{ 'marker.txt': 'original' }
			);
			expect(await (await manager.install(original)).success).toBe(true);
			const replacement = writeSource(
				path.join(workDir, 'replacement'),
				{ version: '2.0.0' },
				{ 'marker.txt': 'replacement' }
			);
			const pending = manager.update(replacement);
			await vi.waitFor(() => expect(stop).toHaveBeenCalledWith(PLUGIN_ID));
			const marker = path.join(pluginsDir(), PLUGIN_ID, 'marker.txt');
			expect(fs.readFileSync(marker, 'utf8')).toBe('original');
			if (fail) {
				const rejected = expect(pending).rejects.toThrow('MediaProcessFailed');
				gate.reject(new Error('MediaProcessFailed'));
				await rejected;
				expect(fs.readFileSync(marker, 'utf8')).toBe('original');
			} else {
				gate.resolve();
				await pending;
				expect(fs.readFileSync(marker, 'utf8')).toBe('replacement');
			}
		}
	);

	it('rejects a downgrade', async () => {
		const manager = makeManager();
		const src2 = writeSource(path.join(workDir, 'src-v2'), { version: '2.0.0' });
		expect(await (await manager.install(src2)).success).toBe(true);

		const src1 = writeSource(path.join(workDir, 'src-v1'), { version: '1.0.0' });
		await expect(manager.update(src1)).rejects.toThrow(/not newer/);
		// The installed version is untouched.
		const installed = JSON.parse(
			fs.readFileSync(path.join(pluginsDir(), PLUGIN_ID, 'plugin.json'), 'utf-8')
		);
		expect(installed.version).toBe('2.0.0');
	});

	it('rejects an equal version', async () => {
		const manager = makeManager();
		const src = writeSource(path.join(workDir, 'src-v1'), { version: '1.0.0' });
		expect(await (await manager.install(src)).success).toBe(true);

		const same = writeSource(path.join(workDir, 'src-v1-again'), { version: '1.0.0' });
		await expect(manager.update(same)).rejects.toThrow(/not newer/);
	});

	it('rejects a source tree containing a symlink', async () => {
		const manager = makeManager();
		const src1 = writeSource(path.join(workDir, 'src-v1'), { version: '1.0.0' });
		expect(await (await manager.install(src1)).success).toBe(true);

		const src2 = writeSource(path.join(workDir, 'src-v2'), { version: '2.0.0' });
		// A real directory the link will point at (absolute target, required for a
		// Windows junction). 'junction' creates an NTFS junction on Windows without
		// elevated privileges and a normal symlink on POSIX (the type is ignored);
		// either is reported by readdir's isSymbolicLink(), so it is OS-agnostic.
		const linkTarget = fs.mkdtempSync(path.join(workDir, 'link-target-'));
		fs.symlinkSync(path.resolve(linkTarget), path.join(src2, 'escape'), 'junction');

		await expect(manager.update(src2)).rejects.toThrow(/symlink/);
		// The installed version is untouched.
		const installed = JSON.parse(
			fs.readFileSync(path.join(pluginsDir(), PLUGIN_ID, 'plugin.json'), 'utf-8')
		);
		expect(installed.version).toBe('1.0.0');
	});

	it('rejects updating an id that is not installed', async () => {
		const manager = makeManager();
		const src = writeSource(path.join(workDir, 'src-v1'), { version: '1.0.0' });
		await expect(manager.update(src)).rejects.toThrow(/not installed/);
	});
});
