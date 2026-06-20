import fs from 'fs/promises';
import * as nodeFs from 'fs';
import * as realOs from 'node:os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	homeDir: '',
	isWindows: vi.fn(() => false),
	getWhichCommand: vi.fn(() => 'which'),
	getShellPath: vi.fn(),
	execFileNoThrow: vi.fn(),
	detectNodeVersionManagerBinPaths: vi.fn((): string[] => []),
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

vi.mock('os', async (importOriginal) => {
	const actual = await importOriginal<typeof import('os')>();
	const mockedOs = {
		...actual,
		homedir: vi.fn(() => mocks.homeDir),
	};
	return {
		...mockedOs,
		default: mockedOs,
	};
});

vi.mock('../../shared/platformDetection', () => ({
	isWindows: mocks.isWindows,
	getWhichCommand: mocks.getWhichCommand,
}));

vi.mock('../../shared/pathUtils', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../shared/pathUtils')>();
	return {
		...actual,
		detectNodeVersionManagerBinPaths: mocks.detectNodeVersionManagerBinPaths,
	};
});

vi.mock('../../main/runtime/getShellPath', () => ({
	getShellPath: mocks.getShellPath,
}));

vi.mock('../../main/utils/execFile', () => ({
	execFileNoThrow: mocks.execFileNoThrow,
}));

vi.mock('../../main/utils/logger', () => ({
	logger: mocks.logger,
}));

import {
	checkBinaryExists,
	checkCustomPath,
	getExpandedEnv,
	getExpandedEnvWithShell,
	probeUnixPaths,
	probeWindowsPaths,
} from '../../main/agents/path-prober';

let originalEnv: NodeJS.ProcessEnv;
let tempRoot: string;

describe('path-prober integration', () => {
	beforeEach(async () => {
		vi.clearAllMocks();
		originalEnv = { ...process.env };
		tempRoot = await fs.mkdtemp(path.join(realOs.tmpdir(), 'maestro-path-prober-'));
		mocks.homeDir = path.join(tempRoot, 'home');
		await fs.mkdir(mocks.homeDir, { recursive: true });

		process.env = {
			...originalEnv,
			PATH: ['/existing/bin', '/usr/bin'].join(path.delimiter),
			APPDATA: path.join(tempRoot, 'AppData', 'Roaming'),
			LOCALAPPDATA: path.join(tempRoot, 'AppData', 'Local'),
			ProgramFiles: path.join(tempRoot, 'Program Files'),
			'ProgramFiles(x86)': path.join(tempRoot, 'Program Files (x86)'),
			ChocolateyInstall: path.join(tempRoot, 'Chocolatey'),
			SystemRoot: path.join(tempRoot, 'Windows'),
		};

		mocks.isWindows.mockReturnValue(false);
		mocks.getWhichCommand.mockImplementation(() => (mocks.isWindows() ? 'where' : 'which'));
		mocks.getShellPath.mockResolvedValue('');
		mocks.execFileNoThrow.mockResolvedValue({ stdout: '', stderr: 'not found', exitCode: 1 });
		mocks.detectNodeVersionManagerBinPaths.mockReturnValue([
			path.join(mocks.homeDir, '.nvm', 'versions', 'node', 'v20.0.0', 'bin'),
			path.join(mocks.homeDir, '.volta', 'bin'),
		]);
	});

	afterEach(async () => {
		process.env = originalEnv;
		vi.restoreAllMocks();
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	it('builds expanded PATH values and falls back when shell PATH probing fails', async () => {
		const unixEnv = getExpandedEnv();
		const unixParts = unixEnv.PATH?.split(path.delimiter) ?? [];
		expect(unixParts).toContain('/opt/homebrew/bin');
		expect(unixParts).toContain(path.join(mocks.homeDir, '.local', 'bin'));
		expect(unixParts).toContain(path.join(mocks.homeDir, '.opencode', 'bin'));
		expect(unixParts.filter((part) => part === '/usr/bin')).toHaveLength(1);

		mocks.getShellPath.mockResolvedValueOnce(
			['/shell/bin', '/usr/bin', path.join(mocks.homeDir, '.local', 'bin')].join(path.delimiter)
		);
		const shellEnv = await getExpandedEnvWithShell();
		const shellParts = shellEnv.PATH?.split(path.delimiter) ?? [];
		expect(shellParts[0]).toBe('/shell/bin');
		expect(shellParts.filter((part) => part === '/usr/bin')).toHaveLength(1);
		expect(
			shellParts.filter((part) => part === path.join(mocks.homeDir, '.local', 'bin'))
		).toHaveLength(1);

		mocks.getShellPath.mockRejectedValueOnce(new Error('shell failed'));
		const fallbackEnv = await getExpandedEnvWithShell();
		expect(fallbackEnv.PATH).toContain('/opt/homebrew/bin');
		expect(mocks.logger.debug).toHaveBeenCalledWith(
			'Shell PATH probe failed; using base expanded env',
			'PathProber',
			expect.objectContaining({ err: expect.any(Error) })
		);

		mocks.getShellPath.mockRejectedValueOnce(new Error('shell failed again'));
		mocks.logger.debug.mockImplementationOnce(() => {
			throw new Error('logger unavailable');
		});
		await getExpandedEnvWithShell();
		expect(mocks.logger.debug).toHaveBeenCalledWith(
			'Shell PATH probe failed; using base expanded env',
			undefined,
			expect.any(Error)
		);

		mocks.isWindows.mockReturnValue(true);
		const windowsEnv = getExpandedEnv();
		expect(windowsEnv.PATH).toContain(path.join(mocks.homeDir, '.local', 'bin'));
		expect(windowsEnv.PATH).toContain(path.join(process.env.APPDATA!, 'npm'));
		expect(windowsEnv.PATH).toContain(
			path.join(process.env.LOCALAPPDATA!, 'Microsoft', 'WinGet', 'Links')
		);
		expect(windowsEnv.PATH).toContain(path.join(process.env.SystemRoot!, 'System32'));
	});

	it('validates custom executable paths with real filesystem checks', async () => {
		const unixTool = path.join(mocks.homeDir, 'bin', 'claude');
		await writeExecutable(unixTool);

		await expect(checkCustomPath('~/bin/claude')).resolves.toEqual({
			exists: true,
			path: unixTool,
		});

		const nonExecutableTool = path.join(mocks.homeDir, 'bin', 'codex');
		await writeFile(nonExecutableTool, '#!/bin/sh\n');
		await fs.chmod(nonExecutableTool, 0o644);
		await expect(checkCustomPath(nonExecutableTool)).resolves.toEqual({ exists: false });
		expect(mocks.logger.warn).toHaveBeenCalledWith(
			`Custom path exists but is not executable: ${nonExecutableTool}`,
			'PathProber'
		);

		mocks.isWindows.mockReturnValue(true);
		const windowsTool = path.join(tempRoot, 'custom', 'opencode');
		await writeFile(`${windowsTool}.exe`, '');
		await expect(checkCustomPath(windowsTool)).resolves.toEqual({
			exists: true,
			path: `${windowsTool}.exe`,
		});

		await fs.rm(`${windowsTool}.exe`);
		await writeFile(`${windowsTool}.cmd`, '');
		await expect(checkCustomPath(windowsTool)).resolves.toEqual({
			exists: true,
			path: `${windowsTool}.cmd`,
		});

		await writeFile(windowsTool, '');
		await expect(checkCustomPath(windowsTool)).resolves.toEqual({
			exists: true,
			path: windowsTool,
		});

		await expect(checkCustomPath(path.join(tempRoot, 'custom', 'missing'))).resolves.toEqual({
			exists: false,
		});

		mocks.isWindows.mockImplementationOnce(() => {
			throw new Error('platform failed');
		});
		await expect(checkCustomPath(unixTool)).resolves.toEqual({ exists: false });
		expect(mocks.logger.debug).toHaveBeenCalledWith(
			`Error checking custom path: ${unixTool}`,
			'PathProber',
			expect.objectContaining({ error: expect.any(Error) })
		);
	});

	it('probes known Unix and Windows installation paths before shell lookup', async () => {
		const unixOpencode = path.join(mocks.homeDir, '.opencode', 'bin', 'opencode');
		await writeExecutable(unixOpencode);

		await expect(probeUnixPaths('opencode')).resolves.toBe(unixOpencode);
		await expect(probeUnixPaths('unknown-binary')).resolves.toBeNull();
		expect(mocks.logger.debug).toHaveBeenCalledWith('Direct probe found opencode', 'PathProber', {
			path: unixOpencode,
		});

		const windowsClaude = path.join(mocks.homeDir, '.local', 'bin', 'claude.exe');
		await writeFile(windowsClaude, '');

		await expect(probeWindowsPaths('claude')).resolves.toBe(windowsClaude);
		await expect(probeWindowsPaths('unknown-binary')).resolves.toBeNull();
		expect(mocks.logger.debug).toHaveBeenCalledWith('Direct probe found claude', 'PathProber', {
			path: windowsClaude,
		});

		const accessSpy = vi.spyOn(nodeFs.promises, 'access').mockRejectedValue(new Error('missing'));
		await expect(probeWindowsPaths('codex')).resolves.toBeNull();
		await expect(probeUnixPaths('gemini')).resolves.toBeNull();
		accessSpy.mockRestore();

		mocks.isWindows.mockReturnValue(true);
		mocks.execFileNoThrow.mockClear();
		await expect(checkBinaryExists('claude')).resolves.toEqual({
			exists: true,
			path: windowsClaude,
		});
		expect(mocks.execFileNoThrow).not.toHaveBeenCalled();
	});

	it('falls back to which on Unix and handles empty or failed command results', async () => {
		const unixCodex = path.join(mocks.homeDir, '.local', 'bin', 'codex');
		await writeExecutable(unixCodex);

		await expect(checkBinaryExists('codex')).resolves.toEqual({
			exists: true,
			path: unixCodex,
		});
		expect(mocks.execFileNoThrow).not.toHaveBeenCalled();

		mocks.execFileNoThrow.mockResolvedValueOnce({
			stdout: ['/mock/bin/tool', '/secondary/bin/tool'].join('\n'),
			stderr: '',
			exitCode: 0,
		});
		await expect(checkBinaryExists('tool')).resolves.toEqual({
			exists: true,
			path: '/mock/bin/tool',
		});
		expect(mocks.execFileNoThrow).toHaveBeenCalledWith(
			'which',
			['tool'],
			undefined,
			expect.objectContaining({ PATH: expect.stringContaining('/opt/homebrew/bin') })
		);

		mocks.execFileNoThrow.mockResolvedValueOnce({ stdout: '   ', stderr: '', exitCode: 0 });
		await expect(checkBinaryExists('missing')).resolves.toEqual({ exists: false });

		mocks.execFileNoThrow.mockRejectedValueOnce(new Error('which failed'));
		await expect(checkBinaryExists('throwing')).resolves.toEqual({ exists: false });
	});

	it('falls back to where on Windows and selects exe, extensionless, or cmd matches', async () => {
		mocks.isWindows.mockReturnValue(true);
		const extensionless = path.join(tempRoot, 'where', 'agent');
		await fs.mkdir(path.dirname(extensionless), { recursive: true });

		mocks.execFileNoThrow.mockResolvedValueOnce({
			stdout: [`${extensionless}.cmd`, extensionless, `${extensionless}.exe`].join('\r\n'),
			stderr: '',
			exitCode: 0,
		});
		await expect(checkBinaryExists('agent')).resolves.toEqual({
			exists: true,
			path: `${extensionless}.exe`,
		});

		await writeFile(`${extensionless}.exe`, '');
		mocks.execFileNoThrow.mockResolvedValueOnce({
			stdout: extensionless,
			stderr: '',
			exitCode: 0,
		});
		await expect(checkBinaryExists('agent')).resolves.toEqual({
			exists: true,
			path: `${extensionless}.exe`,
		});
		expect(mocks.logger.debug).toHaveBeenCalledWith('Found .exe version of agent', 'PathProber', {
			path: `${extensionless}.exe`,
		});

		await fs.rm(`${extensionless}.exe`);
		await writeFile(`${extensionless}.cmd`, '');
		mocks.execFileNoThrow.mockResolvedValueOnce({
			stdout: extensionless,
			stderr: '',
			exitCode: 0,
		});
		await expect(checkBinaryExists('agent')).resolves.toEqual({
			exists: true,
			path: `${extensionless}.cmd`,
		});
		expect(mocks.logger.debug).toHaveBeenCalledWith('Found .cmd version of agent', 'PathProber', {
			path: `${extensionless}.cmd`,
		});

		await fs.rm(`${extensionless}.cmd`);
		mocks.execFileNoThrow.mockResolvedValueOnce({
			stdout: extensionless,
			stderr: '',
			exitCode: 0,
		});
		await expect(checkBinaryExists('agent')).resolves.toEqual({
			exists: true,
			path: extensionless,
		});
		expect(mocks.logger.debug).toHaveBeenCalledWith(
			'Windows binary detection for agent',
			'PathProber',
			expect.objectContaining({
				selectedMatch: extensionless,
				isCmd: false,
				isExe: false,
			})
		);
	});
});

async function writeExecutable(filePath: string): Promise<void> {
	await writeFile(filePath, '#!/bin/sh\nexit 0\n');
	await fs.chmod(filePath, 0o755);
}

async function writeFile(filePath: string, content: string): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, content, 'utf8');
}
