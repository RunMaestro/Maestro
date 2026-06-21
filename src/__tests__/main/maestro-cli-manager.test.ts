import { beforeEach, describe, expect, it, vi } from 'vitest';

const electronMocks = vi.hoisted(() => ({
	app: {
		getAppPath: vi.fn(() => '/app'),
		getVersion: vi.fn(() => '1.2.3'),
	},
}));

const fsMocks = vi.hoisted(() => ({
	readablePaths: new Set<string>(),
	existingPaths: new Set<string>(),
	access: vi.fn(),
	appendFile: vi.fn(),
	chmod: vi.fn(),
	mkdir: vi.fn(),
	readFile: vi.fn(),
	writeFile: vi.fn(),
	constants: {
		F_OK: 0,
		R_OK: 4,
	},
}));

const osMocks = vi.hoisted(() => ({
	homedir: vi.fn(() => '/Users/test'),
}));

const execMocks = vi.hoisted(() => ({
	whichResults: [] as Array<{ exitCode: number; stdout: string; stderr: string }>,
	versionResults: new Map<string, { exitCode: number; stdout: string; stderr: string }>(),
	powershellResult: { exitCode: 0, stdout: '', stderr: '' },
	execFileNoThrow: vi.fn(),
}));

const platformMocks = vi.hoisted(() => ({
	getWhichCommand: vi.fn(() => 'which'),
	isWindows: vi.fn(() => false),
}));

const cliDetectionMocks = vi.hoisted(() => ({
	getExpandedEnv: vi.fn(() => ({ PATH: '/Users/test/.local/bin:/usr/bin' })),
}));

const loggerMocks = vi.hoisted(() => ({
	debug: vi.fn(),
	error: vi.fn(),
	info: vi.fn(),
	warn: vi.fn(),
}));

vi.mock('electron', () => electronMocks);

vi.mock('fs', () => ({
	default: {
		constants: fsMocks.constants,
		promises: {
			access: fsMocks.access,
			appendFile: fsMocks.appendFile,
			chmod: fsMocks.chmod,
			mkdir: fsMocks.mkdir,
			readFile: fsMocks.readFile,
			writeFile: fsMocks.writeFile,
		},
	},
	constants: fsMocks.constants,
	promises: {
		access: fsMocks.access,
		appendFile: fsMocks.appendFile,
		chmod: fsMocks.chmod,
		mkdir: fsMocks.mkdir,
		readFile: fsMocks.readFile,
		writeFile: fsMocks.writeFile,
	},
}));

vi.mock('os', () => ({
	default: osMocks,
	homedir: osMocks.homedir,
}));

vi.mock('../../main/utils/execFile', () => ({
	execFileNoThrow: execMocks.execFileNoThrow,
}));

vi.mock('../../shared/platformDetection', () => ({
	getWhichCommand: platformMocks.getWhichCommand,
	isWindows: platformMocks.isWindows,
}));

vi.mock('../../main/utils/cliDetection', () => ({
	getExpandedEnv: cliDetectionMocks.getExpandedEnv,
}));

vi.mock('../../main/utils/logger', () => ({
	logger: loggerMocks,
}));

import { MaestroCliManager } from '../../main/maestro-cli-manager';

const bundledCliPath = '/app/dist/cli/maestro-cli.js';
const installDir = '/Users/test/.local/bin';
const unixInstallPath = `${installDir}/maestro-cli`;
const windowsInstallPath = `${installDir}/maestro-cli.cmd`;

function commandResult(stdout: string, exitCode = 0, stderr = '') {
	return { exitCode, stdout, stderr };
}

describe('MaestroCliManager', () => {
	const originalPath = process.env.PATH;
	const originalShell = process.env.SHELL;
	const originalResourcesPathDescriptor = Object.getOwnPropertyDescriptor(process, 'resourcesPath');

	beforeEach(() => {
		vi.clearAllMocks();
		fsMocks.readablePaths.clear();
		fsMocks.existingPaths.clear();
		execMocks.whichResults.length = 0;
		execMocks.versionResults.clear();
		execMocks.powershellResult = commandResult('');
		electronMocks.app.getAppPath.mockReturnValue('/app');
		electronMocks.app.getVersion.mockReturnValue('1.2.3');
		osMocks.homedir.mockReturnValue('/Users/test');
		platformMocks.getWhichCommand.mockReturnValue('which');
		platformMocks.isWindows.mockReturnValue(false);
		cliDetectionMocks.getExpandedEnv.mockReturnValue({ PATH: `${installDir}:/usr/bin` });
		process.env.PATH = '/usr/bin';
		process.env.SHELL = '/bin/zsh';

		Object.defineProperty(process, 'resourcesPath', {
			value: '/resources',
			configurable: true,
		});

		fsMocks.access.mockImplementation(async (filePath: string) => {
			if (fsMocks.readablePaths.has(filePath) || fsMocks.existingPaths.has(filePath)) {
				return;
			}
			throw new Error(`ENOENT: ${filePath}`);
		});
		fsMocks.mkdir.mockResolvedValue(undefined);
		fsMocks.readFile.mockResolvedValue('existing rc\n');
		fsMocks.appendFile.mockResolvedValue(undefined);
		fsMocks.chmod.mockResolvedValue(undefined);
		fsMocks.writeFile.mockImplementation(async (filePath: string) => {
			fsMocks.existingPaths.add(filePath);
		});
		execMocks.execFileNoThrow.mockImplementation(async (command: string, args: string[] = []) => {
			if (args[0] === 'maestro-cli') {
				return execMocks.whichResults.shift() ?? commandResult('', 1, 'not found');
			}
			if (args[0] === '--version') {
				return execMocks.versionResults.get(command) ?? commandResult('', 1, 'version failed');
			}
			if (command === 'powershell') {
				return execMocks.powershellResult;
			}
			return commandResult('', 1, 'unexpected command');
		});
	});

	afterEach(() => {
		process.env.PATH = originalPath;
		process.env.SHELL = originalShell;
		if (originalResourcesPathDescriptor) {
			Object.defineProperty(process, 'resourcesPath', originalResourcesPathDescriptor);
		} else {
			Reflect.deleteProperty(process, 'resourcesPath');
		}
	});

	it('reports not installed when no PATH command or shim is available', async () => {
		fsMocks.readablePaths.add(bundledCliPath);
		execMocks.whichResults.push(
			commandResult('', 1, 'not found'),
			commandResult('', 1, 'not found')
		);

		const status = await new MaestroCliManager().checkStatus();

		expect(status).toMatchObject({
			expectedVersion: '1.2.3',
			installed: false,
			inPath: false,
			inShellPath: false,
			commandPath: null,
			installedVersion: null,
			versionMatch: false,
			needsInstallOrUpdate: true,
			installDir,
			bundledCliPath,
		});
	});

	it('detects the expanded-shell PATH command and normalizes its version', async () => {
		fsMocks.readablePaths.add(bundledCliPath);
		execMocks.whichResults.push(
			commandResult('', 1, 'not found'),
			commandResult(`${unixInstallPath}\n`)
		);
		execMocks.versionResults.set(unixInstallPath, commandResult('maestro-cli v1.2.3\n'));

		const status = await new MaestroCliManager().checkStatus();

		expect(status).toMatchObject({
			installed: true,
			inPath: false,
			inShellPath: true,
			commandPath: unixInstallPath,
			installedVersion: '1.2.3',
			versionMatch: true,
			needsInstallOrUpdate: false,
		});
		expect(execMocks.execFileNoThrow).toHaveBeenCalledWith('which', ['maestro-cli'], undefined, {
			PATH: `${installDir}:/usr/bin`,
		});
	});

	it('installs a POSIX shim and appends the user shell PATH export when needed', async () => {
		fsMocks.readablePaths.add(bundledCliPath);
		execMocks.whichResults.push(
			commandResult('', 1, 'not found'),
			commandResult(`${unixInstallPath}\n`)
		);
		execMocks.versionResults.set(unixInstallPath, commandResult('1.2.3\n'));

		const result = await new MaestroCliManager().installOrUpdate();

		expect(fsMocks.mkdir).toHaveBeenCalledWith(installDir, { recursive: true });
		expect(fsMocks.writeFile).toHaveBeenCalledWith(
			unixInstallPath,
			expect.stringContaining(`ELECTRON_RUN_AS_NODE=1`),
			'utf-8'
		);
		expect(fsMocks.writeFile).toHaveBeenCalledWith(
			unixInstallPath,
			expect.stringContaining(`'${bundledCliPath}' "$@"`),
			'utf-8'
		);
		expect(fsMocks.chmod).toHaveBeenCalledWith(unixInstallPath, 0o755);
		expect(fsMocks.appendFile).toHaveBeenCalledWith(
			'/Users/test/.zshrc',
			expect.stringContaining('export PATH="$HOME/.local/bin:$PATH"'),
			'utf-8'
		);
		expect(result).toMatchObject({
			success: true,
			pathUpdated: true,
			restartRequired: true,
			shellFilesUpdated: ['/Users/test/.zshrc'],
		});
	});

	it('skips shell rc updates when the install directory is already on PATH', async () => {
		process.env.PATH = `${installDir}:/usr/bin`;
		fsMocks.readablePaths.add(bundledCliPath);
		execMocks.whichResults.push(
			commandResult(`${unixInstallPath}\n`),
			commandResult(`${unixInstallPath}\n`)
		);
		execMocks.versionResults.set(unixInstallPath, commandResult('1.2.3\n'));

		const result = await new MaestroCliManager().installOrUpdate();

		expect(fsMocks.appendFile).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			success: true,
			pathUpdated: false,
			restartRequired: false,
			shellFilesUpdated: [],
		});
	});

	it('throws a clear error when no bundled CLI is readable', async () => {
		await expect(new MaestroCliManager().installOrUpdate()).rejects.toThrow(
			/Unable to locate bundled maestro-cli\.js/
		);

		expect(fsMocks.writeFile).not.toHaveBeenCalled();
	});

	it('writes a Windows shim and reports PATH update failure from PowerShell', async () => {
		platformMocks.isWindows.mockReturnValue(true);
		fsMocks.readablePaths.add(bundledCliPath);
		execMocks.powershellResult = commandResult('', 1, 'access denied');
		execMocks.whichResults.push(
			commandResult('', 1, 'not found'),
			commandResult(`${windowsInstallPath}\n`)
		);
		execMocks.versionResults.set(windowsInstallPath, commandResult('1.2.3\n'));

		const result = await new MaestroCliManager().installOrUpdate();

		expect(fsMocks.writeFile).toHaveBeenCalledWith(
			windowsInstallPath,
			expect.stringContaining('@echo off'),
			'utf-8'
		);
		expect(execMocks.execFileNoThrow).toHaveBeenCalledWith(
			'powershell',
			expect.arrayContaining(['-NoProfile', '-NonInteractive', '-Command'])
		);
		expect(result).toMatchObject({
			success: false,
			pathUpdated: false,
			pathUpdateError: 'Failed to update Windows user PATH for maestro-cli',
			restartRequired: false,
		});
	});
});
