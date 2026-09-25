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
		// Absolute in the platform's own shape, so `path.resolve` leaves it alone.
		// A POSIX literal here becomes `C:\tmp\...` on Windows and fails there only.
		const configured = path.join(os.tmpdir(), 'maestro-somewhere');
		expect(resolveUserDataDir({ env: { MAESTRO_USER_DATA: configured }, homedir: home })).toBe(
			configured
		);
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

	it('rejects a regular file at the path, which existsSync alone would accept', () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-root-'));
		scratch.push(root);
		const asFile = path.join(root, 'Maestro');
		fs.writeFileSync(asFile, '');

		expect(() => assertUserDataDirExists(asFile)).toThrow(/is not a directory/);
	});

	// The real scenario. `chmod` is a no-op on Windows, and a root process ignores
	// the mode, so the stat would succeed and the assertion would invert.
	const canDenyPermission = process.platform !== 'win32' && process.getuid?.() !== 0;

	it.skipIf(!canDenyPermission)('rethrows a permission error, naming it', () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-root-'));
		scratch.push(root);
		const target = path.join(root, 'Maestro');
		fs.mkdirSync(target);

		// Unreadable PARENT: that is what makes the stat of `target` fail.
		fs.chmodSync(root, 0o000);
		try {
			expect(() => assertUserDataDirExists(target)).toThrow(/EACCES/);
		} finally {
			fs.chmodSync(root, 0o700);
		}
	});

	// The same branch on every platform, including the Windows legs the test above
	// cannot run on: a NUL byte is refused by Node's own argument validation.
	const unstattable = 'maestro\0dir';

	it('never reports an unexpected stat error as a missing directory', () => {
		expect(() => assertUserDataDirExists(unstattable)).toThrow();
		expect(() => assertUserDataDirExists(unstattable)).not.toThrow(/Maestro data directory/);
	});

	it('still names the missing directory when a sibling cannot be stat-ed', () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-root-'));
		scratch.push(root);

		// The target resolves normally and is simply absent; only the siblings are
		// unstattable, which is the asymmetry the alternatives probe has to hold.
		expect(() =>
			assertUserDataDirExists(path.join(root, 'Maestro'), {
				env: { XDG_CONFIG_HOME: `${root}\0` },
				platform: 'linux',
				homedir: root,
			})
		).toThrow(/not found at.*MAESTRO_USER_DATA/s);
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
