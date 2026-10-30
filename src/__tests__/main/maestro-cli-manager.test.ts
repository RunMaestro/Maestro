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

import { MaestroCliManager, normalizeVersion } from '../../main/maestro-cli-manager';

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
});
