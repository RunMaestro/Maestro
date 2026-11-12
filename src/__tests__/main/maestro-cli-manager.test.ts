import fs from 'fs';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockExecFileNoThrow } = vi.hoisted(() => ({
	mockExecFileNoThrow: vi.fn(),
}));

vi.mock('electron', () => ({
	app: {
		getAppPath: vi.fn().mockReturnValue('/mock/app'),
		getVersion: vi.fn().mockReturnValue('0.17.4'),
	},
}));

vi.mock('../../main/utils/execFile', () => ({
	execFileNoThrow: mockExecFileNoThrow,
}));

vi.mock('../../shared/platformDetection', () => ({
	getWhichCommand: vi.fn().mockReturnValue('where'),
	isWindows: vi.fn().mockReturnValue(true),
}));

vi.mock('../../main/utils/logger', () => ({
	logger: {
		debug: vi.fn(),
		error: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
	},
}));

import { isWindows } from '../../shared/platformDetection';
import { MaestroCliManager, normalizeVersion } from '../../main/maestro-cli-manager';

const APPIMAGE_MARKER = '# Maestro CLI shim for the Linux AppImage build.';
const TEST_APPIMAGE = '/home/tester/Applications/maestro.AppImage';

describe('MaestroCliManager', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.restoreAllMocks();
		mockExecFileNoThrow.mockResolvedValue({
			exitCode: 0,
			stderr: '',
			stdout: '',
		});
	});

	describe('normalizeVersion', () => {
		it('finds a version line after incidental logger output', () => {
			expect(
				normalizeVersion(
					'[Logger] File logging enabled: C:\\logs\\maestro-debug-2026-09-10.log\r\n0.17.4\r\n'
				)
			).toBe('0.17.4');
		});

		it('normalizes an exact v-prefixed prerelease', () => {
			expect(normalizeVersion('v0.18.0-rc.1\n')).toBe('0.18.0-rc.1');
		});
	});

	it('updates the Windows user PATH with PowerShell directly and valid block syntax', async () => {
		const manager = new MaestroCliManager();
		const ensureWindowsUserPath = (
			manager as unknown as {
				ensureWindowsUserPath(installDir: string): Promise<boolean>;
			}
		).ensureWindowsUserPath.bind(manager);

		await expect(ensureWindowsUserPath("C:\\Users\\O'Brien\\.local\\bin")).resolves.toBe(true);

		expect(mockExecFileNoThrow).toHaveBeenCalledOnce();
		const [command, args] = mockExecFileNoThrow.mock.calls[0] as [string, string[]];
		expect(command).toBe('powershell.exe');
		expect(args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command']);

		const script = args[3];
		expect(script).toContain("$installDir = 'C:\\Users\\O''Brien\\.local\\bin'");
		expect(script).toContain('if ($parts -notcontains $installDir) {\n');
		expect(script).not.toContain('{;');
	});

	describe('ensurePosixPathExport', () => {
		const callEnsure = (manager: MaestroCliManager, installDir: string) =>
			(
				manager as unknown as {
					ensurePosixPathExport(
						installDir: string
					): Promise<{ updated: boolean; files: string[]; error?: string }>;
				}
			).ensurePosixPathExport(installDir);

		const withShell = async (shell: string, run: () => Promise<void>) => {
			const previous = process.env.SHELL;
			process.env.SHELL = shell;
			try {
				await run();
			} finally {
				if (previous === undefined) delete process.env.SHELL;
				else process.env.SHELL = previous;
			}
		};

		it('reports an unwritable rc file as a PATH error instead of throwing (MAESTRO-177, MAESTRO-15Z)', async () => {
			vi.spyOn(os, 'homedir').mockReturnValue('/home/tester');
			vi.spyOn(fs.promises, 'readFile').mockResolvedValue('');
			vi.spyOn(fs.promises, 'appendFile').mockRejectedValue(
				Object.assign(new Error("EPERM: operation not permitted, open '/home/tester/.zshrc'"), {
					code: 'EPERM',
				})
			);

			await withShell('/bin/zsh', async () => {
				const result = await callEnsure(new MaestroCliManager(), '/home/tester/.local/bin');
				expect(result.updated).toBe(false);
				expect(result.files).toEqual([]);
				expect(result.error).toContain(path.join('/home/tester', '.zshrc'));
				expect(result.error).toContain('export PATH="$HOME/.local/bin:$PATH"');
			});
		});

		it('still throws an rc write failure that is not a permission problem', async () => {
			vi.spyOn(os, 'homedir').mockReturnValue('/home/tester');
			vi.spyOn(fs.promises, 'readFile').mockResolvedValue('');
			vi.spyOn(fs.promises, 'appendFile').mockRejectedValue(
				Object.assign(new Error('EIO: i/o error, write'), { code: 'EIO' })
			);

			await withShell('/bin/zsh', async () => {
				await expect(
					callEnsure(new MaestroCliManager(), '/home/tester/.local/bin')
				).rejects.toThrow('EIO');
			});
		});
	});

	// Creating a symlink needs elevated rights on Windows CI; the bug is POSIX-only.
	it.skipIf(process.platform === 'win32')(
		'replaces a symlinked install path instead of writing through it into the bundled CLI',
		async () => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-cli-shim-'));
			try {
				const bundledCliPath = path.join(dir, 'maestro-cli.js');
				const bundledContents = '// bundled maestro-cli.js\n';
				fs.writeFileSync(bundledCliPath, bundledContents);
				const installPath = path.join(dir, 'maestro-cli');
				fs.symlinkSync(bundledCliPath, installPath);

				const manager = new MaestroCliManager();
				const writeUnixShim = (
					manager as unknown as {
						writeUnixShim(installPath: string, bundledCliPath: string): Promise<void>;
					}
				).writeUnixShim.bind(manager);
				await writeUnixShim(installPath, bundledCliPath);

				expect(fs.readFileSync(bundledCliPath, 'utf-8')).toBe(bundledContents);
				expect(fs.lstatSync(installPath).isSymbolicLink()).toBe(false);
				expect(fs.readFileSync(installPath, 'utf-8')).toContain(`'${bundledCliPath}' "$@"`);
				expect(fs.statSync(installPath).mode & 0o777).toBe(0o755);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		}
	);

	describe('AppImage shim', () => {
		beforeEach(() => {
			vi.mocked(isWindows).mockReturnValue(true);
		});

		const withAppImage = async (value: string | undefined, run: () => Promise<void>) => {
			const previousImage = process.env.APPIMAGE;
			const previousDir = process.env.APPDIR;
			if (value === undefined) delete process.env.APPIMAGE;
			else process.env.APPIMAGE = value;
			// The manager trusts APPIMAGE only when the running binary sits in APPDIR.
			process.env.APPDIR = path.dirname(process.execPath);
			try {
				await run();
			} finally {
				if (previousImage === undefined) delete process.env.APPIMAGE;
				else process.env.APPIMAGE = previousImage;
				if (previousDir === undefined) delete process.env.APPDIR;
				else process.env.APPDIR = previousDir;
			}
		};

		/** Point the manager's install paths at a scratch directory. */
		const bindInstallDir = (manager: MaestroCliManager, dir: string) => {
			const internal = manager as unknown as {
				getInstallDir(): string;
				getInstallPath(): string;
				writeUnixShim(installPath: string, bundledCliPath: string): Promise<void>;
			};
			internal.getInstallDir = () => dir;
			internal.getInstallPath = () => path.join(dir, 'maestro-cli');
			return internal;
		};

		it.skipIf(process.platform === 'win32')(
			'writes a shim that re-enters the AppImage instead of recording a mount path',
			async () => {
				const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-cli-appimage-'));
				try {
					const installPath = path.join(dir, 'maestro-cli');
					const internal = bindInstallDir(new MaestroCliManager(), dir);

					await withAppImage(TEST_APPIMAGE, async () => {
						await internal.writeUnixShim(installPath, path.join(dir, 'maestro-cli.js'));
					});

					const shim = fs.readFileSync(installPath, 'utf-8');
					expect(shim).toContain(APPIMAGE_MARKER);
					expect(shim).toContain(`appimage='${TEST_APPIMAGE}'`);
					expect(shim).toContain('ELECTRON_RUN_AS_NODE=1 exec "$appimage" "$bootstrap" "$@"');
					expect(shim).not.toMatch(/appimage='\/tmp\/\.mount_/);
					expect(fs.statSync(installPath).mode & 0o777).toBe(0o755);

					const bootstrap = fs.readFileSync(path.join(dir, 'maestro-cli-bootstrap.js'), 'utf-8');
					expect(bootstrap).toContain(`'resources'`);
					expect(bootstrap).toContain(
						'process.argv = [process.execPath, cli, ...process.argv.slice(2)]'
					);
				} finally {
					fs.rmSync(dir, { recursive: true, force: true });
				}
			}
		);

		it.skipIf(process.platform === 'win32')(
			'ignores an APPIMAGE inherited from a parent process',
			async () => {
				const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-cli-inherited-'));
				const previousImage = process.env.APPIMAGE;
				const previousDir = process.env.APPDIR;
				try {
					process.env.APPIMAGE = TEST_APPIMAGE;
					process.env.APPDIR = '/tmp/.mount_anotherprocess';
					const installPath = path.join(dir, 'maestro-cli');
					const bundledCliPath = path.join(dir, 'maestro-cli.js');
					const internal = bindInstallDir(new MaestroCliManager(), dir);

					await internal.writeUnixShim(installPath, bundledCliPath);

					const shim = fs.readFileSync(installPath, 'utf-8');
					expect(shim).not.toContain(APPIMAGE_MARKER);
					expect(shim).toContain(`'${bundledCliPath}' "$@"`);
				} finally {
					if (previousImage === undefined) delete process.env.APPIMAGE;
					else process.env.APPIMAGE = previousImage;
					if (previousDir === undefined) delete process.env.APPDIR;
					else process.env.APPDIR = previousDir;
					fs.rmSync(dir, { recursive: true, force: true });
				}
			}
		);

		it.skipIf(process.platform === 'win32')(
			'repairs an older shim that recorded a /tmp/.mount_* path',
			async () => {
				const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-cli-heal-'));
				try {
					const installPath = path.join(dir, 'maestro-cli');
					fs.writeFileSync(
						installPath,
						'#!/usr/bin/env bash\n' +
							`ELECTRON_RUN_AS_NODE=1 '/tmp/.mount_maestrOLD/maestro' '/tmp/.mount_maestrOLD/resources/maestro-cli.js' "$@"\n`
					);
					const manager = new MaestroCliManager();
					bindInstallDir(manager, dir);
					vi.mocked(isWindows).mockReturnValue(false);

					await withAppImage(TEST_APPIMAGE, async () => {
						await expect(manager.healAppImageShim()).resolves.toBe(true);
					});

					const shim = fs.readFileSync(installPath, 'utf-8');
					expect(shim).toContain(`appimage='${TEST_APPIMAGE}'`);
					expect(shim).not.toMatch(/appimage='\/tmp\/\.mount_/);
				} finally {
					vi.mocked(isWindows).mockReturnValue(true);
					fs.rmSync(dir, { recursive: true, force: true });
				}
			}
		);

		it.skipIf(process.platform === 'win32')(
			'repairs its own shim when an AppImage update renamed the file',
			async () => {
				const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-cli-rename-'));
				try {
					const installPath = path.join(dir, 'maestro-cli');
					fs.writeFileSync(
						installPath,
						'#!/usr/bin/env bash\n' +
							`${APPIMAGE_MARKER}\n` +
							"appimage='/home/tester/Applications/maestro-1.1.0-RC.AppImage'\n" +
							'ELECTRON_RUN_AS_NODE=1 exec "$appimage" "$bootstrap" "$@"\n'
					);
					const manager = new MaestroCliManager();
					bindInstallDir(manager, dir);
					vi.mocked(isWindows).mockReturnValue(false);

					await withAppImage('/home/tester/Applications/maestro-1.2.0-AppImage', async () => {
						await expect(manager.healAppImageShim()).resolves.toBe(true);
					});

					expect(fs.readFileSync(installPath, 'utf-8')).toContain(
						"appimage='/home/tester/Applications/maestro-1.2.0-AppImage'"
					);
				} finally {
					vi.mocked(isWindows).mockReturnValue(true);
					fs.rmSync(dir, { recursive: true, force: true });
				}
			}
		);

		it.skipIf(process.platform === 'win32')(
			'leaves a custom wrapper that mentions the installer strings untouched',
			async () => {
				const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-cli-custom-'));
				try {
					const installPath = path.join(dir, 'maestro-cli');
					const custom =
						'#!/usr/bin/env bash\n' +
						'# Avoid /tmp/.mount_* because the mount name changes.\n' +
						'ELECTRON_RUN_AS_NODE=1 /opt/Maestro/maestro /opt/Maestro/resources/maestro-cli.js "$@"\n';
					fs.writeFileSync(installPath, custom);
					const manager = new MaestroCliManager();
					bindInstallDir(manager, dir);
					vi.mocked(isWindows).mockReturnValue(false);

					await withAppImage(TEST_APPIMAGE, async () => {
						await expect(manager.healAppImageShim()).resolves.toBe(false);
					});

					expect(fs.readFileSync(installPath, 'utf-8')).toBe(custom);
				} finally {
					vi.mocked(isWindows).mockReturnValue(true);
					fs.rmSync(dir, { recursive: true, force: true });
				}
			}
		);

		it.skipIf(process.platform === 'win32')(
			'leaves a deb or rpm legacy shim alone when the AppImage starts',
			async () => {
				const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-cli-opt-'));
				try {
					const installPath = path.join(dir, 'maestro-cli');
					const packageShim =
						'#!/usr/bin/env bash\n' +
						"ELECTRON_RUN_AS_NODE=1 '/opt/Maestro/maestro' '/opt/Maestro/resources/maestro-cli.js' \"$@\"\n";
					fs.writeFileSync(installPath, packageShim);
					const manager = new MaestroCliManager();
					bindInstallDir(manager, dir);
					vi.mocked(isWindows).mockReturnValue(false);

					await withAppImage(TEST_APPIMAGE, async () => {
						await expect(manager.healAppImageShim()).resolves.toBe(false);
					});

					expect(fs.readFileSync(installPath, 'utf-8')).toBe(packageShim);
				} finally {
					vi.mocked(isWindows).mockReturnValue(true);
					fs.rmSync(dir, { recursive: true, force: true });
				}
			}
		);

		it.skipIf(process.platform === 'win32')(
			'leaves a shim it did not write untouched',
			async () => {
				const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-cli-foreign-'));
				try {
					const installPath = path.join(dir, 'maestro-cli');
					const foreign = '#!/usr/bin/env bash\necho my own wrapper\n';
					fs.writeFileSync(installPath, foreign);
					const manager = new MaestroCliManager();
					bindInstallDir(manager, dir);
					vi.mocked(isWindows).mockReturnValue(false);

					await withAppImage(TEST_APPIMAGE, async () => {
						await expect(manager.healAppImageShim()).resolves.toBe(false);
					});

					expect(fs.readFileSync(installPath, 'utf-8')).toBe(foreign);
				} finally {
					vi.mocked(isWindows).mockReturnValue(true);
					fs.rmSync(dir, { recursive: true, force: true });
				}
			}
		);
	});
});
