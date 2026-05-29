import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	isWindows: vi.fn(),
	execFileNoThrow: vi.fn(),
}));

vi.mock('../../shared/platformDetection', () => ({
	isWindows: mocks.isWindows,
}));

vi.mock('../../main/utils/execFile', () => ({
	execFileNoThrow: mocks.execFileNoThrow,
}));

import { collectWindowsDiagnostics } from '../../main/debug-package/collectors/windows-diagnostics';

const tempRoots: string[] = [];

function makeTempRoot() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-windows-diagnostics-'));
	tempRoots.push(dir);
	return dir;
}

function mkdirp(dir: string) {
	fs.mkdirSync(dir, { recursive: true });
}

function touch(file: string) {
	mkdirp(path.dirname(file));
	fs.writeFileSync(file, '');
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.isWindows.mockReturnValue(false);
	mocks.execFileNoThrow.mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' });
});

afterEach(() => {
	vi.unstubAllEnvs();
	for (const dir of tempRoots.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe('collectWindowsDiagnostics', () => {
	it('returns minimal diagnostics without probing commands on non-Windows platforms', async () => {
		mocks.isWindows.mockReturnValue(false);

		await expect(collectWindowsDiagnostics()).resolves.toEqual({ isWindows: false });

		expect(mocks.execFileNoThrow).not.toHaveBeenCalled();
	});

	it('collects Windows environment, versions, and directory checks without listing paths', async () => {
		const root = makeTempRoot();
		const home = path.join(root, 'home');
		const appData = path.join(root, 'AppData', 'Roaming');
		const localAppData = path.join(root, 'AppData', 'Local');
		const chocolateyInstall = path.join(root, 'Chocolatey');
		mkdirp(path.join(appData, 'npm'));
		touch(path.join(home, '.local', 'bin'));
		mkdirp(path.join(localAppData, 'Microsoft', 'WinGet', 'Links'));
		mkdirp(path.join(chocolateyInstall, 'bin'));

		vi.stubEnv('HOME', home);
		vi.stubEnv('APPDATA', appData);
		vi.stubEnv('LOCALAPPDATA', localAppData);
		vi.stubEnv('ChocolateyInstall', chocolateyInstall);
		vi.stubEnv('PATHEXT', '.EXE;.CMD;;');
		vi.stubEnv('PATH', ['tools-bin', 'node-bin'].join(path.delimiter));
		mocks.isWindows.mockReturnValue(true);
		mocks.execFileNoThrow.mockImplementation(async (command: string) => {
			if (command === 'npm') return { exitCode: 0, stdout: '10.9.0\n', stderr: '' };
			if (command === 'node') return { exitCode: 0, stdout: 'v22.11.0\n', stderr: '' };
			return { exitCode: 1, stdout: '', stderr: 'unknown command' };
		});

		const result = await collectWindowsDiagnostics();

		expect(result).toMatchObject({
			isWindows: true,
			environment: {
				pathext: ['.EXE', '.CMD'],
				pathDirsCount: 2,
			},
			npmInfo: {
				npmVersion: '10.9.0',
				nodeVersion: 'v22.11.0',
			},
			fileSystemChecks: {
				npmGlobalDir: { exists: true, isDirectory: true },
				localBinDir: { exists: true, isDirectory: false },
				wingetLinksDir: { exists: true, isDirectory: true },
				scoopShimsDir: { exists: false, isDirectory: false },
				chocolateyBinDir: { exists: true, isDirectory: true },
				pythonScriptsDir: { exists: false, isDirectory: false },
			},
		});
		expect(mocks.execFileNoThrow).toHaveBeenCalledWith('npm', ['--version']);
		expect(mocks.execFileNoThrow).toHaveBeenCalledWith('node', ['--version']);
	});

	it('uses fallback environment values and keeps versions null when commands fail', async () => {
		const root = makeTempRoot();
		const home = path.join(root, 'home');
		mkdirp(path.join(home, 'AppData', 'Roaming', 'npm'));
		touch(path.join(home, 'AppData', 'Roaming', 'Python', 'Scripts'));

		vi.stubEnv('HOME', home);
		vi.stubEnv('APPDATA', '');
		vi.stubEnv('LOCALAPPDATA', '');
		vi.stubEnv('ChocolateyInstall', '');
		vi.stubEnv('PATHEXT', '');
		vi.stubEnv('PATH', '');
		mocks.isWindows.mockReturnValue(true);
		mocks.execFileNoThrow.mockImplementation(async (command: string) => {
			if (command === 'npm') return { exitCode: 2, stdout: 'ignored', stderr: 'failed' };
			throw new Error(`${command} unavailable`);
		});

		const result = await collectWindowsDiagnostics();

		expect(result.environment).toEqual({
			pathext: ['.COM', '.EXE', '.BAT', '.CMD'],
			pathDirsCount: 0,
		});
		expect(result.npmInfo).toEqual({
			npmVersion: null,
			nodeVersion: null,
		});
		expect(result.fileSystemChecks?.npmGlobalDir).toEqual({
			exists: true,
			isDirectory: true,
		});
		expect(result.fileSystemChecks?.pythonScriptsDir).toEqual({
			exists: true,
			isDirectory: false,
		});
	});

	it('keeps node version null when the node command exits unsuccessfully', async () => {
		const root = makeTempRoot();
		const home = path.join(root, 'home');

		vi.stubEnv('HOME', home);
		vi.stubEnv('APPDATA', path.join(root, 'AppData', 'Roaming'));
		vi.stubEnv('LOCALAPPDATA', path.join(root, 'AppData', 'Local'));
		vi.stubEnv('ChocolateyInstall', path.join(root, 'Chocolatey'));
		mocks.isWindows.mockReturnValue(true);
		mocks.execFileNoThrow.mockImplementation(async (command: string) => {
			if (command === 'npm') throw new Error('npm unavailable');
			return { exitCode: 1, stdout: 'ignored', stderr: 'node failed' };
		});

		const result = await collectWindowsDiagnostics();

		expect(result.npmInfo).toEqual({
			npmVersion: null,
			nodeVersion: null,
		});
		expect(mocks.execFileNoThrow).toHaveBeenCalledWith('node', ['--version']);
	});
});
