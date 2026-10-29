/**
 * The standalone runner and the desktop app must land in the SAME data
 * directory, so each branch of the app's own rule is pinned here.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	assertUserDataDirExists,
	resolveProductionDataDir,
	resolveUserDataDir,
	resolveUserDataDirRule,
	userDataDirCandidates,
} from '../userDataDir';

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
		).toBe(path.join('/home/tester/.config-custom', 'maestro'));
	});

	it('falls back to the platform default when the env var is absent', () => {
		expect(
			resolveUserDataDir({ env: {}, platform: 'linux', homedir: home, isPackaged: true })
		).toBe(path.join(home, '.config', 'maestro'));
	});

	it('keeps the capitalized guess for a packaged Windows install', () => {
		expect(
			resolveUserDataDir({ env: {}, platform: 'win32', homedir: home, isPackaged: true })
		).toBe(path.join(home, 'AppData', 'Roaming', 'Maestro'));
	});

	describe('checks the guessed spelling against the disk', () => {
		const scratch: string[] = [];

		afterEach(() => {
			while (scratch.length) fs.rmSync(scratch.pop() as string, { recursive: true, force: true });
		});

		function linuxRoot(...existing: string[]): string {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-xdg-'));
			scratch.push(root);
			for (const name of existing) fs.mkdirSync(path.join(root, name));
			return root;
		}

		/** Put a file only the desktop app writes into `root/name`. */
		function writeAppState(root: string, name: string, marker = 'maestro-sessions.json'): void {
			fs.writeFileSync(path.join(root, name, marker), '{"sessions":[]}');
		}

		/**
		 * Both spellings as two directories. Only a case-sensitive volume can hold
		 * them; elsewhere this returns null and the caller skips.
		 */
		function bothSpellings(): string | null {
			const root = linuxRoot('maestro');
			if (fs.existsSync(path.join(root, 'Maestro'))) return null;
			fs.mkdirSync(path.join(root, 'Maestro'));
			return root;
		}

		function resolveIn(root: string, isPackaged: boolean): string {
			return resolveUserDataDir({
				env: { XDG_CONFIG_HOME: root },
				platform: 'linux',
				homedir: home,
				isPackaged,
				isDevelopment: false,
			});
		}

		// A case-insensitive volume (macOS, Windows) answers for both spellings, so
		// compare what the result opens on disk rather than the string.
		const onDisk = (candidate: string) => fs.realpathSync.native(candidate);

		it('takes the lowercase directory a packaged Linux app actually wrote (#1813)', () => {
			const root = linuxRoot('maestro');
			expect(onDisk(resolveIn(root, true))).toBe(onDisk(path.join(root, 'maestro')));
		});

		it('takes the capitalized directory when only that one exists', () => {
			const root = linuxRoot('Maestro');
			expect(onDisk(resolveIn(root, true))).toBe(onDisk(path.join(root, 'Maestro')));
		});

		it('resolves to lowercase on Linux when neither spelling exists yet', () => {
			// So a CLI write before the app's first launch creates the directory the
			// app will use, not a capitalized twin.
			const root = linuxRoot();
			expect(resolveIn(root, true)).toBe(path.join(root, 'maestro'));
		});

		it('ignores a regular file with the other spelling', () => {
			const root = linuxRoot();
			fs.writeFileSync(path.join(root, 'Maestro'), '');
			if (!fs.existsSync(path.join(root, 'maestro'))) {
				expect(resolveIn(root, true)).toBe(path.join(root, 'maestro'));
			}
		});

		describe('with both spellings present', () => {
			// The #1813 shape: the app wrote one spelling, a CLI write created the
			// other. Skipped where the volume folds the two names together.
			const caseSensitive = (() => {
				const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-case-'));
				try {
					fs.mkdirSync(path.join(probe, 'maestro'));
					return !fs.existsSync(path.join(probe, 'Maestro'));
				} finally {
					fs.rmSync(probe, { recursive: true, force: true });
				}
			})();

			it.skipIf(!caseSensitive)('takes lowercase when only it holds the app state', () => {
				const root = bothSpellings() as string;
				writeAppState(root, 'maestro');
				expect(resolveIn(root, true)).toBe(path.join(root, 'maestro'));
			});

			it.skipIf(!caseSensitive)(
				'takes the capitalized directory when only it holds the app state',
				() => {
					const root = bothSpellings() as string;
					writeAppState(root, 'Maestro');
					expect(resolveIn(root, true)).toBe(path.join(root, 'Maestro'));
				}
			);

			it.skipIf(!caseSensitive)(
				'recognizes the window state left behind by a custom Storage Location',
				() => {
					const root = bothSpellings() as string;
					writeAppState(root, 'Maestro', 'maestro-window-state.json');
					expect(resolveIn(root, true)).toBe(path.join(root, 'Maestro'));
				}
			);

			it.skipIf(!caseSensitive)('keeps the guess when both hold the app state', () => {
				const root = bothSpellings() as string;
				writeAppState(root, 'maestro');
				writeAppState(root, 'Maestro');
				expect(resolveIn(root, true)).toBe(path.join(root, 'maestro'));
			});

			it.skipIf(!caseSensitive)('keeps the guess when neither holds the app state', () => {
				const root = bothSpellings() as string;
				expect(resolveIn(root, true)).toBe(path.join(root, 'maestro'));
			});

			it.skipIf(!caseSensitive)(
				'does not count settings or agent configs, which the CLI writes too',
				() => {
					const root = bothSpellings() as string;
					writeAppState(root, 'Maestro', 'maestro-settings.json');
					writeAppState(root, 'Maestro', 'maestro-agent-configs.json');
					expect(resolveIn(root, true)).toBe(path.join(root, 'maestro'));
				}
			);
		});
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

		expect(() => assertUserDataDirExists(asFile)).toThrow(
			`${asFile} exists but is not a directory`
		);
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

describe('resolveProductionDataDir', () => {
	it('maps the dev redirect back to the unpackaged directory it came from', () => {
		const root = path.join(os.tmpdir(), 'app-support');
		expect(resolveProductionDataDir(path.join(root, 'maestro-dev'))).toBe(
			path.join(root, 'maestro')
		);
	});

	it('returns any other directory unchanged', () => {
		const installed = path.join(os.tmpdir(), 'app-support', 'Maestro');
		expect(resolveProductionDataDir(installed)).toBe(installed);
	});
});

describe('resolveUserDataDirRule and userDataDirCandidates', () => {
	const linux = { platform: 'linux', homedir: '/home/u', env: {} } as const;

	it('names the rule that chose the directory', () => {
		expect(resolveUserDataDirRule({ ...linux, env: { MAESTRO_USER_DATA: '/x' } })).toBe(
			'MAESTRO_USER_DATA'
		);
		expect(resolveUserDataDirRule({ ...linux, isPackaged: true })).toBe('packaged default');
		expect(resolveUserDataDirRule({ ...linux, isPackaged: false })).toBe('unpackaged default');
		expect(resolveUserDataDirRule({ ...linux, isPackaged: false, isDevelopment: true })).toBe(
			'development redirect'
		);
	});

	it('lists the chosen directory first, then the other spellings', () => {
		const candidates = userDataDirCandidates({ ...linux, isPackaged: true });
		expect(candidates).toEqual([
			// A packaged Linux app writes the lowercase name (#1813).
			path.join('/home/u', '.config', 'maestro'),
			path.join('/home/u', '.config', 'Maestro'),
			path.join('/home/u', '.config', 'maestro-dev'),
		]);
	});

	it('lists only MAESTRO_USER_DATA when it is set', () => {
		expect(userDataDirCandidates({ ...linux, env: { MAESTRO_USER_DATA: '/x' } })).toEqual([
			path.resolve('/x'),
		]);
	});
});
