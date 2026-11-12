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

vi.mock('electron', () => ({
	// Never actually called (MAESTRO_USER_DATA wins in dataDir()), but present so
	// the named `app` import resolves cleanly under the test runner.
	app: { getPath: () => os.tmpdir() },
}));

import { PluginManager } from '../../../main/plugins/plugin-manager';
import { pluginsDir } from '../../../main/plugins/plugin-store-main';

const PLUGIN_ID = 'demo-plugin';

interface ManifestOpts {
	version: string;
	tier?: 0 | 1;
	entry?: string;
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
		expect(manager.install(src1).success).toBe(true);

		// tier-1 plugins default to DISABLED; enabling it makes the toggle a
		// non-default value, so a wrongly-reset toggle after update would be caught.
		manager.setEnabled(PLUGIN_ID, true);
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

	it('rejects a downgrade', async () => {
		const manager = makeManager();
		const src2 = writeSource(path.join(workDir, 'src-v2'), { version: '2.0.0' });
		expect(manager.install(src2).success).toBe(true);

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
		expect(manager.install(src).success).toBe(true);

		const same = writeSource(path.join(workDir, 'src-v1-again'), { version: '1.0.0' });
		await expect(manager.update(same)).rejects.toThrow(/not newer/);
	});

	it('rejects a source tree containing a symlink', async () => {
		const manager = makeManager();
		const src1 = writeSource(path.join(workDir, 'src-v1'), { version: '1.0.0' });
		expect(manager.install(src1).success).toBe(true);

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
