/**
 * @file open-local-path.test.ts
 * @description The launch guard for local files the OS is asked to open. App
 * bundles, scripts, installers, symlinks to them and (on POSIX) any regular
 * file with an executable bit are revealed in the file manager, never opened;
 * a plugin's `file:` URL goes through the same guard. Real files in a temp
 * folder; Electron's shell is a mock.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';

vi.mock('electron', () => ({
	shell: {
		openPath: vi.fn(),
		openExternal: vi.fn(),
		showItemInFolder: vi.fn(),
	},
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// shell.openPath never settles on Linux (MAESTRO-QH). Default to "not Linux" so
// every CI leg awaits it; the Linux case flips it.
const { mockIsLinux } = vi.hoisted(() => ({ mockIsLinux: vi.fn(() => false) }));
vi.mock('../../../shared/platformDetection', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../shared/platformDetection')>()),
	isLinux: mockIsLinux,
}));

import { shell } from 'electron';
import { logger } from '../../../main/utils/logger';
import {
	isLaunchableLocalPath,
	openExternalUrl,
	openLocalPath,
} from '../../../main/utils/open-local-path';

/** Executable bits and symlinks are POSIX behavior. */
const posixOnly = it.skipIf(process.platform === 'win32');

let dir: string;

beforeEach(() => {
	vi.clearAllMocks();
	mockIsLinux.mockReturnValue(false);
	vi.mocked(shell.openPath).mockResolvedValue('');
	vi.mocked(shell.openExternal).mockResolvedValue(undefined);
	// realpath so macOS /var -> /private/var and Windows 8.3 names match what the guard sees.
	dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-open-local-')));
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

/** A regular file in the temp folder, with the given mode. */
function file(name: string, mode = 0o644): string {
	const target = path.join(dir, name);
	fs.writeFileSync(target, 'x');
	fs.chmodSync(target, mode);
	return target;
}

/** A folder in the temp folder (an `.app` bundle is one). */
function folder(name: string): string {
	const target = path.join(dir, name);
	fs.mkdirSync(target);
	return target;
}

function expectNothingOpened(): void {
	expect(shell.openPath).not.toHaveBeenCalled();
	expect(shell.openExternal).not.toHaveBeenCalled();
	expect(shell.showItemInFolder).not.toHaveBeenCalled();
}

describe('isLaunchableLocalPath', () => {
	it('counts an app bundle, which is a folder, by its name', () => {
		expect(isLaunchableLocalPath(folder('Calculator.app'))).toBe(true);
	});

	it('counts scripts and installers by their names', () => {
		for (const name of ['run.command', 'install.sh', 'Installer.pkg', 'Disk.dmg', 'setup.exe']) {
			expect(isLaunchableLocalPath(file(name))).toBe(true);
		}
	});

	it('does not count a document or a plain folder', () => {
		expect(isLaunchableLocalPath(file('report.pdf'))).toBe(false);
		expect(isLaunchableLocalPath(folder('Reports'))).toBe(false);
	});

	posixOnly('counts a regular file with any executable bit, whatever its name', () => {
		expect(isLaunchableLocalPath(file('build', 0o755))).toBe(true);
		expect(isLaunchableLocalPath(file('owner-only', 0o700))).toBe(true);
		expect(isLaunchableLocalPath(file('others-only', 0o601))).toBe(true);
		expect(isLaunchableLocalPath(file('notes.md', 0o755))).toBe(true);
		expect(isLaunchableLocalPath(file('plain', 0o644))).toBe(false);
	});

	posixOnly('does not count a folder for its search bit', () => {
		const reports = folder('Reports');
		fs.chmodSync(reports, 0o755);
		expect(isLaunchableLocalPath(reports)).toBe(false);
	});

	posixOnly('judges what a symlink resolves to', () => {
		const app = folder('Calculator.app');
		const appLink = path.join(dir, 'report.pdf');
		fs.symlinkSync(app, appLink);
		expect(isLaunchableLocalPath(appLink)).toBe(true);

		const script = file('payload', 0o755);
		const scriptLink = path.join(dir, 'notes.txt');
		fs.symlinkSync(script, scriptLink);
		expect(isLaunchableLocalPath(scriptLink)).toBe(true);
	});

	it('sees an app bundle named through a trailing separator or a dot segment', () => {
		const app = folder('Calculator.app');
		expect(isLaunchableLocalPath(`${app}${path.sep}`)).toBe(true);
		expect(isLaunchableLocalPath(`${app}${path.sep}.`)).toBe(true);
	});

	it('counts a path it cannot inspect, since a reveal is always safe', () => {
		expect(isLaunchableLocalPath(path.join(dir, 'missing.pdf'))).toBe(true);
	});

	it.skipIf(process.platform !== 'win32')('counts a .js file on Windows', () => {
		expect(isLaunchableLocalPath(file('run.js'))).toBe(true);
	});

	posixOnly('does not count a .js file outside Windows', () => {
		expect(isLaunchableLocalPath(file('run.js'))).toBe(false);
	});
});

describe('openLocalPath', () => {
	it('reveals a launchable target and never opens it', async () => {
		const app = folder('Calculator.app');
		await expect(openLocalPath(app)).resolves.toBe('');
		expect(shell.showItemInFolder).toHaveBeenCalledWith(app);
		expect(shell.openPath).not.toHaveBeenCalled();
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(app), 'Shell');
	});

	posixOnly('reveals an executable file with no telling extension', async () => {
		const script = file('build', 0o755);
		await openLocalPath(script);
		expect(shell.showItemInFolder).toHaveBeenCalledWith(script);
		expect(shell.openPath).not.toHaveBeenCalled();
	});

	it('opens anything else and returns the error message from shell.openPath', async () => {
		const pdf = file('report.pdf');
		await expect(openLocalPath(pdf)).resolves.toBe('');
		expect(shell.openPath).toHaveBeenCalledWith(pdf);
		expect(shell.showItemInFolder).not.toHaveBeenCalled();

		vi.mocked(shell.openPath).mockResolvedValueOnce('No application found');
		await expect(openLocalPath(pdf)).resolves.toBe('No application found');
	});

	it('opens a plain folder rather than revealing it', async () => {
		const reports = folder('Reports');
		await openLocalPath(reports);
		expect(shell.openPath).toHaveBeenCalledWith(reports);
		expect(shell.showItemInFolder).not.toHaveBeenCalled();
	});

	it('settles on Linux, where shell.openPath never does (MAESTRO-QH)', async () => {
		mockIsLinux.mockReturnValue(true);
		vi.mocked(shell.openPath).mockReturnValueOnce(new Promise<string>(() => {}));
		const pdf = file('report.pdf');
		await expect(openLocalPath(pdf)).resolves.toBe('');
		expect(shell.openPath).toHaveBeenCalledWith(pdf);
	});
});

describe('openExternalUrl', () => {
	it('hands a web URL to shell.openExternal in the form it was checked in', async () => {
		await openExternalUrl('HTTPS://Example.com/a b', { activate: false });
		expect(shell.openExternal).toHaveBeenCalledWith('https://example.com/a%20b', {
			activate: false,
		});
		expect(shell.openPath).not.toHaveBeenCalled();
	});

	it('opens a file: URL through the launch guard, never through shell.openExternal', async () => {
		const pdf = file('report.pdf');
		await openExternalUrl(pathToFileURL(pdf).href);
		expect(shell.openPath).toHaveBeenCalledWith(pdf);

		const app = folder('Calculator.app');
		await openExternalUrl(pathToFileURL(app).href);
		expect(shell.showItemInFolder).toHaveBeenCalledWith(app);
		expect(shell.openPath).toHaveBeenCalledTimes(1);
		expect(shell.openExternal).not.toHaveBeenCalled();
	});

	it('throws the error from shell.openPath for a file: URL', async () => {
		vi.mocked(shell.openPath).mockResolvedValueOnce('No application found');
		await expect(openExternalUrl(pathToFileURL(file('report.xyz')).href)).rejects.toThrow(
			'No application found'
		);
	});

	it('refuses a file: URL on another host and opens nothing', async () => {
		await expect(openExternalUrl('file://fileserver/share/setup.exe')).rejects.toThrow(
			'another host'
		);
		expectNothingOpened();
	});

	it('refuses a file: URL with an encoded separator and opens nothing', async () => {
		await expect(openExternalUrl('file:///tmp/a%2F..%2Fsetup.exe')).rejects.toThrow();
		expectNothingOpened();
	});

	it('refuses a URL that does not parse and opens nothing', async () => {
		await expect(openExternalUrl('/Applications/Calculator.app')).rejects.toThrow('does not parse');
		await expect(openExternalUrl('not a url')).rejects.toThrow('does not parse');
		expectNothingOpened();
	});
});
