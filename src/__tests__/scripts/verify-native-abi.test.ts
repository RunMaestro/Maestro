/**
 * The native-ABI package guard refuses an app whose addons target the wrong
 * runtime (a better_sqlite3.node rebuilt for plain Node by `npm test`). These
 * tests pin how it reads the ABI out of a binary, which folders count as
 * shipped, and what the afterPack hook refuses. Fixtures are byte strings that
 * carry the same export names a real Mach-O, ELF or PE addon does.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const guard = require('../../../scripts/verify-native-abi.js') as {
	readAddonAbi: (file: string) => number | 'napi' | null;
	shippedModuleDirs: (nodeModules: string, asarUnpack: string[]) => string[];
	electronAbi: (version: string) => number;
	checkAddons: (dirs: string | string[], abi: number) => string[];
	verifyPackagedNativeAbi: (context: unknown) => Promise<void>;
};
const { default: afterPack } = require('../../../scripts/after-pack.js') as {
	default: (context: unknown) => Promise<void>;
};

let tmp: string;

function addon(relative: string, exportName: string): string {
	const file = path.join(tmp, relative);
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, Buffer.from(`\0\0junk_${exportName}\0more\0`, 'latin1'));
	return file;
}

beforeEach(() => {
	tmp = mkdtempSync(path.join(os.tmpdir(), 'native-abi-'));
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

describe('verify-native-abi: readAddonAbi', () => {
	it('reads the ABI a NAN addon was built for', () => {
		expect(guard.readAddonAbi(addon('a.node', 'node_register_module_v145'))).toBe(145);
	});

	it('reports an N-API addon as runtime-independent', () => {
		expect(guard.readAddonAbi(addon('b.node', 'napi_register_module_v1'))).toBe('napi');
	});

	it('returns null for a file that names neither', () => {
		expect(guard.readAddonAbi(addon('c.node', 'something_else'))).toBeNull();
	});
});

describe('verify-native-abi: checkAddons', () => {
	const sqlite = 'node_modules/better-sqlite3/build/Release/better_sqlite3.node';
	const pty = 'node_modules/node-pty/build/Release/pty.node';

	it('passes Electron-built and N-API addons', () => {
		addon(sqlite, 'node_register_module_v145');
		addon(pty, 'napi_register_module_v1');
		expect(guard.checkAddons(path.join(tmp, 'node_modules'), 145)).toEqual([]);
	});

	it('refuses a better_sqlite3.node built for plain Node, and says how to fix it', () => {
		addon(sqlite, 'node_register_module_v147');
		const [problem] = guard.checkAddons(path.join(tmp, 'node_modules'), 145);
		expect(problem).toMatch(/better_sqlite3\.node targets NODE_MODULE_VERSION 147/);
		expect(problem).toMatch(/Electron needs 145/);
	});

	it('refuses a package with no better_sqlite3.node at all', () => {
		addon(pty, 'napi_register_module_v1');
		expect(guard.checkAddons(path.join(tmp, 'node_modules'), 145)).toEqual([
			expect.stringMatching(/better_sqlite3\.node is missing/),
		]);
	});
});

describe('verify-native-abi: shippedModuleDirs', () => {
	it('expands asarUnpack patterns to the module folders that exist, scoped and globbed', () => {
		const nm = path.join(tmp, 'node_modules');
		for (const dir of ['better-sqlite3', '@napi-rs/keyring', '@napi-rs/keyring-darwin-arm64']) {
			mkdirSync(path.join(nm, dir), { recursive: true });
		}
		const dirs = guard.shippedModuleDirs(nm, [
			'node_modules/better-sqlite3/**/*',
			'node_modules/@napi-rs/keyring/**/*',
			'node_modules/@napi-rs/keyring-*/*',
			'node_modules/not-installed/**/*',
			'resources/other/**',
		]);
		expect(dirs.map((d) => path.relative(nm, d)).sort()).toEqual([
			'@napi-rs/keyring',
			'@napi-rs/keyring-darwin-arm64',
			'better-sqlite3',
		]);
	});

	it('names every native module the real package unpacks', () => {
		const pkg = require('../../../package.json') as { build: { asarUnpack: string[] } };
		expect(pkg.build.asarUnpack).toEqual(
			expect.arrayContaining(['node_modules/better-sqlite3/**/*'])
		);
	});
});

describe('verify-native-abi: electronAbi', () => {
	it('knows the installed Electron', () => {
		const version = (require('electron/package.json') as { version: string }).version;
		expect(guard.electronAbi(version)).toBeGreaterThan(100);
	});
});

describe('after-pack hook', () => {
	const electronVersion = (require('electron/package.json') as { version: string }).version;

	function linuxContext(addonExport: string) {
		const resources = path.join(tmp, 'linux-unpacked', 'resources');
		addon(
			path.relative(
				tmp,
				path.join(
					resources,
					'app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node'
				)
			),
			addonExport
		);
		mkdirSync(path.join(resources, 'native'), { recursive: true });
		writeFileSync(path.join(resources, 'native', 'maestro-computer-history'), '');
		return {
			electronPlatformName: 'linux',
			appOutDir: path.join(tmp, 'linux-unpacked'),
			packager: { appInfo: { productFilename: 'Maestro' }, config: { electronVersion } },
		};
	}

	it('passes a package whose addons match Electron', async () => {
		const abi = guard.electronAbi(electronVersion);
		await expect(afterPack(linuxContext(`node_register_module_v${abi}`))).resolves.toBeUndefined();
	});

	it('fails the package when better_sqlite3.node targets another runtime', async () => {
		const abi = guard.electronAbi(electronVersion);
		await expect(afterPack(linuxContext(`node_register_module_v${abi + 2}`))).rejects.toThrow(
			/do not match Electron .*ensure-native-runtime\.mjs electron/s
		);
	});
});
