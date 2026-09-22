/**
 * The standalone runner and the desktop app must land in the SAME data
 * directory, so each branch of the app's own rule is pinned here.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { assertUserDataDirExists, resolveUserDataDir } from '../../shared/userDataDir';

const home = '/home/tester';

describe('resolveUserDataDir', () => {
	it('honors MAESTRO_USER_DATA, which the app publishes at startup', () => {
		expect(
			resolveUserDataDir({ env: { MAESTRO_USER_DATA: '/tmp/somewhere' }, homedir: home })
		).toBe('/tmp/somewhere');
	});

	it('uses the capitalized name for a packaged install', () => {
		expect(
			resolveUserDataDir({ env: {}, platform: 'darwin', homedir: home, isPackaged: true })
		).toBe(path.join(home, 'Library', 'Application Support', 'Maestro'));
	});

	it('uses the lowercase name when unpackaged, as Electron derives it from package.json name', () => {
		expect(
			resolveUserDataDir({
				env: {},
				platform: 'darwin',
				homedir: home,
				isPackaged: false,
				isDevelopment: false,
			})
		).toBe(path.join(home, 'Library', 'Application Support', 'maestro'));
	});

	it('redirects to the sibling dev directory in development', () => {
		expect(
			resolveUserDataDir({
				env: {},
				platform: 'darwin',
				homedir: home,
				isPackaged: false,
				isDevelopment: true,
			})
		).toBe(path.join(home, 'Library', 'Application Support', 'maestro-dev'));
	});

	it('stays on the production directory when USE_PROD_DATA is set', () => {
		expect(
			resolveUserDataDir({
				env: { USE_PROD_DATA: '1' },
				platform: 'darwin',
				homedir: home,
				isPackaged: false,
				isDevelopment: true,
			})
		).toBe(path.join(home, 'Library', 'Application Support', 'maestro'));
	});

	it('follows APPDATA on Windows and XDG_CONFIG_HOME on Linux', () => {
		expect(
			resolveUserDataDir({
				env: { APPDATA: 'C:\\Users\\t\\AppData\\Roaming' },
				platform: 'win32',
				homedir: home,
				isPackaged: true,
			})
		).toBe(path.join('C:\\Users\\t\\AppData\\Roaming', 'Maestro'));

		expect(
			resolveUserDataDir({
				env: { XDG_CONFIG_HOME: '/home/tester/.config-custom' },
				platform: 'linux',
				homedir: home,
				isPackaged: true,
			})
		).toBe(path.join('/home/tester/.config-custom', 'Maestro'));
	});

	it('falls back to the platform default when the env var is absent', () => {
		expect(
			resolveUserDataDir({ env: {}, platform: 'linux', homedir: home, isPackaged: true })
		).toBe(path.join(home, '.config', 'Maestro'));
	});
});

describe('assertUserDataDirExists', () => {
	const scratch: string[] = [];

	afterEach(() => {
		while (scratch.length) fs.rmSync(scratch.pop() as string, { recursive: true, force: true });
	});

	it('returns the directory when it exists', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-userdata-'));
		scratch.push(dir);
		expect(assertUserDataDirExists(dir)).toBe(dir);
	});

	it('throws rather than letting a runner open an empty database beside the real one', () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-root-'));
		scratch.push(root);

		// Note: `Maestro` vs `maestro` is only a real distinction on a
		// case-sensitive filesystem (Linux, where a headless runner lives);
		// macOS folds them together. The dev directory differs by more than
		// case, so it is what this asserts on.
		expect(() =>
			assertUserDataDirExists(path.join(root, 'Maestro'), {
				env: { XDG_CONFIG_HOME: root },
				platform: 'linux',
				homedir: root,
			})
		).toThrow(/not found/);
	});

	it('names the directory it did find, so the fix is obvious', () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-root-'));
		scratch.push(root);
		fs.mkdirSync(path.join(root, 'maestro-dev'));

		expect(() =>
			assertUserDataDirExists(path.join(root, 'Maestro'), {
				env: { XDG_CONFIG_HOME: root },
				platform: 'linux',
				homedir: root,
			})
		).toThrow(/maestro-dev.*MAESTRO_USER_DATA/s);
	});
});
