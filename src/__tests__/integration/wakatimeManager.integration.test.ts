import fs from 'fs';
import https from 'https';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	WakaTimeManager,
	detectLanguageFromPath,
	extractFilePathFromToolExecution,
	WRITE_TOOL_NAMES,
} from '../../main/wakatime-manager';
import { execFileNoThrow } from '../../main/utils/execFile';
import { logger } from '../../main/utils/logger';

const mocks = vi.hoisted(() => ({
	execFileNoThrow: vi.fn(),
	logger: {
		info: vi.fn(),
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

vi.mock('electron', () => ({
	app: {
		getVersion: vi.fn(() => '9.8.7'),
	},
}));

vi.mock('../../main/utils/execFile', () => ({
	execFileNoThrow: mocks.execFileNoThrow,
}));

vi.mock('../../main/utils/logger', () => ({
	logger: mocks.logger,
}));

function settingsStore(values: Record<string, unknown>) {
	return {
		get: vi.fn((key: string, fallback?: unknown) =>
			Object.prototype.hasOwnProperty.call(values, key) ? values[key] : fallback
		),
	};
}

function createManager(values: Record<string, unknown>) {
	const manager = new WakaTimeManager(settingsStore(values) as never);
	(manager as any).cliDetected = true;
	(manager as any).cliPath = 'wakatime-cli';
	(manager as any).lastUpdateCheck = Date.now();
	return manager;
}

function setPlatform(platform: NodeJS.Platform | string, arch: NodeJS.Architecture | string) {
	Object.defineProperty(process, 'platform', { value: platform, configurable: true });
	Object.defineProperty(process, 'arch', { value: arch, configurable: true });
}

function mockHttpsGet(
	responses: Array<{
		statusCode?: number;
		headers?: Record<string, string>;
		body?: string;
		requestError?: Error;
	}>
) {
	return vi.spyOn(https, 'get').mockImplementation(((_options: unknown, callback: unknown) => {
		const request = new EventEmitter() as EventEmitter & { on: typeof EventEmitter.prototype.on };
		const response = responses.shift();
		if (!response) {
			throw new Error('Unexpected https.get call');
		}

		queueMicrotask(() => {
			if (response.requestError) {
				request.emit('error', response.requestError);
				return;
			}

			const stream = new PassThrough() as PassThrough & {
				statusCode?: number;
				headers: Record<string, string>;
			};
			stream.statusCode = response.statusCode ?? 200;
			stream.headers = response.headers ?? {};
			(callback as (value: typeof stream) => void)(stream);
			stream.end(response.body ?? '');
		});

		return request;
	}) as typeof https.get);
}

describe('WakaTimeManager integration', () => {
	const originalPlatform = process.platform;
	const originalArch = process.arch;
	let tempDir: string;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.useRealTimers();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-wakatime-integration-'));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
		Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
		Object.defineProperty(process, 'arch', { value: originalArch, configurable: true });
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it('maps write tools and file extensions into WakaTime file heartbeat metadata', () => {
		expect(WRITE_TOOL_NAMES.has('Write')).toBe(true);
		expect(WRITE_TOOL_NAMES.has('str_replace_based_edit_tool')).toBe(true);
		expect(detectLanguageFromPath('/repo/src/App.tsx')).toBe('TypeScript');
		expect(detectLanguageFromPath('/repo/script.py')).toBe('Python');
		expect(detectLanguageFromPath('/repo/Makefile')).toBeUndefined();
		expect(detectLanguageFromPath('/repo/unknown.nope')).toBeUndefined();

		expect(
			extractFilePathFromToolExecution({
				toolName: 'Edit',
				state: { input: { file_path: '/repo/src/App.tsx' } },
				timestamp: 1,
			})
		).toBe('/repo/src/App.tsx');
		expect(
			extractFilePathFromToolExecution({
				toolName: 'write_to_file',
				state: { input: { path: '/repo/README.md' } },
				timestamp: 1,
			})
		).toBe('/repo/README.md');
		expect(
			extractFilePathFromToolExecution({
				toolName: 'Read',
				state: { input: { path: '/repo/README.md' } },
				timestamp: 1,
			})
		).toBeNull();
		expect(
			extractFilePathFromToolExecution({
				toolName: 'Write',
				state: { input: { file_path: '' } },
				timestamp: 1,
			})
		).toBeNull();
		expect(
			extractFilePathFromToolExecution({
				toolName: 'Write',
				state: { input: null },
				timestamp: 1,
			})
		).toBeNull();
	});

	it('detects CLI availability from PATH and handles unsupported auto-install platforms', async () => {
		mocks.execFileNoThrow.mockResolvedValueOnce({
			exitCode: 0,
			stdout: 'wakatime-cli 1.73.1\n',
			stderr: '',
		});

		const detected = await new WakaTimeManager(settingsStore({}) as never).detectCli();

		expect(detected).toBe(true);
		expect(execFileNoThrow).toHaveBeenCalledWith('wakatime-cli', ['--version']);
		expect(logger.info).toHaveBeenCalledWith(
			expect.stringContaining('Found WakaTime CLI: wakatime-cli'),
			'[WakaTime]'
		);

		Object.defineProperty(process, 'platform', { value: 'freebsd', configurable: true });
		Object.defineProperty(process, 'arch', { value: 'arm64', configurable: true });
		mocks.execFileNoThrow
			.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'missing' })
			.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'missing' });

		const unsupported = await new WakaTimeManager(settingsStore({}) as never).ensureCliInstalled();

		expect(unsupported).toBe(false);
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining('Unsupported platform/arch'),
			'[WakaTime]'
		);

		setPlatform('darwin', 'mips');
		mocks.execFileNoThrow
			.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'missing' })
			.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'missing' });
		await expect(
			new WakaTimeManager(settingsStore({}) as never).ensureCliInstalled()
		).resolves.toBe(false);
	});

	it('detects an auto-installed local CLI and reports the resolved path', async () => {
		vi.spyOn(os, 'homedir').mockReturnValue(tempDir);
		setPlatform('darwin', 'arm64');
		const localPath = path.join(tempDir, '.wakatime', 'wakatime-cli-darwin-arm64');
		fs.mkdirSync(path.dirname(localPath), { recursive: true });
		fs.writeFileSync(localPath, '#!/bin/sh\n');
		mocks.execFileNoThrow
			.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'missing' })
			.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'missing' })
			.mockResolvedValueOnce({ exitCode: 0, stdout: 'wakatime-cli 1.73.1\n', stderr: '' });

		const manager = new WakaTimeManager(settingsStore({}) as never);

		await expect(manager.detectCli()).resolves.toBe(true);
		expect(manager.getCliPath()).toBe(localPath);
		expect(execFileNoThrow).toHaveBeenLastCalledWith(localPath, ['--version']);
	});

	it('auto-installs the CLI from a redirected release download and reuses an in-flight install', async () => {
		vi.spyOn(os, 'homedir').mockReturnValue(tempDir);
		setPlatform('linux', 'x64');
		mockHttpsGet([
			{
				statusCode: 302,
				headers: { location: 'https://downloads.example/wakatime-cli-linux-amd64.zip' },
			},
			{ statusCode: 200, body: 'zip-bytes' },
		]);
		const binaryPath = path.join(tempDir, '.wakatime', 'wakatime-cli-linux-amd64');
		mocks.execFileNoThrow.mockImplementation(async (cmd: string) => {
			if (cmd === 'unzip') {
				fs.writeFileSync(binaryPath, '#!/bin/sh\n');
				return { exitCode: 0, stdout: '', stderr: '' };
			}
			return { exitCode: 1, stdout: '', stderr: 'missing' };
		});

		const manager = new WakaTimeManager(settingsStore({}) as never);

		await expect(manager.ensureCliInstalled()).resolves.toBe(true);
		expect(manager.getCliPath()).toBe(binaryPath);
		expect(execFileNoThrow).toHaveBeenCalledWith('unzip', [
			'-o',
			path.join(os.tmpdir(), 'wakatime-cli-linux-amd64.zip'),
			'-d',
			path.join(tempDir, '.wakatime'),
		]);

		(manager as any).installing = Promise.resolve(true);
		(manager as any).cliDetected = true;
		(manager as any).cliPath = null;
		await expect(manager.ensureCliInstalled()).resolves.toBe(true);
	});

	it('handles CLI install extraction failures, download failures, and redirect loops', async () => {
		vi.spyOn(os, 'homedir').mockReturnValue(tempDir);

		setPlatform('win32', 'ia32');
		mockHttpsGet([{ statusCode: 200, body: 'zip-bytes' }]);
		mocks.execFileNoThrow
			.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'missing' })
			.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'missing' })
			.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'extract failed' });

		await expect(
			new WakaTimeManager(settingsStore({}) as never).ensureCliInstalled()
		).resolves.toBe(false);
		expect(logger.warn).toHaveBeenCalledWith(
			'Failed to extract WakaTime CLI: extract failed',
			'[WakaTime]'
		);

		vi.restoreAllMocks();
		vi.spyOn(os, 'homedir').mockReturnValue(tempDir);
		setPlatform('linux', 'x64');
		mockHttpsGet([{ statusCode: 200, body: 'zip-bytes' }]);
		mocks.execFileNoThrow
			.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'missing' })
			.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'missing' })
			.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'unzip failed' });

		await expect(
			new WakaTimeManager(settingsStore({}) as never).ensureCliInstalled()
		).resolves.toBe(false);
		expect(logger.warn).toHaveBeenCalledWith(
			'Failed to extract WakaTime CLI: unzip failed',
			'[WakaTime]'
		);

		vi.restoreAllMocks();
		vi.spyOn(os, 'homedir').mockReturnValue(tempDir);
		setPlatform('linux', 'x64');
		mockHttpsGet([{ statusCode: 200, body: 'zip-bytes' }]);
		const fileStream = new EventEmitter() as EventEmitter & {
			write: () => boolean;
			end: () => void;
			close: () => void;
		};
		fileStream.write = () => true;
		fileStream.end = () => queueMicrotask(() => fileStream.emit('error', new Error('disk full')));
		fileStream.close = vi.fn();
		(vi.spyOn(fs, 'createWriteStream') as any).mockReturnValue(fileStream);
		mocks.execFileNoThrow
			.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'missing' })
			.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'missing' });

		await expect(
			new WakaTimeManager(settingsStore({}) as never).ensureCliInstalled()
		).resolves.toBe(false);
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining('Failed to auto-install WakaTime CLI: disk full'),
			'[WakaTime]'
		);

		vi.restoreAllMocks();
		vi.spyOn(os, 'homedir').mockReturnValue(tempDir);
		setPlatform('linux', 'x64');
		mockHttpsGet([{ statusCode: 500, body: 'nope' }]);
		mocks.execFileNoThrow
			.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'missing' })
			.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'missing' });

		await expect(
			new WakaTimeManager(settingsStore({}) as never).ensureCliInstalled()
		).resolves.toBe(false);
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining('Download failed with status 500'),
			'[WakaTime]'
		);

		vi.restoreAllMocks();
		vi.spyOn(os, 'homedir').mockReturnValue(tempDir);
		setPlatform('linux', 'x64');
		mockHttpsGet(
			Array.from({ length: 6 }, () => ({
				statusCode: 302,
				headers: { location: 'https://downloads.example/loop.zip' },
			}))
		);
		mocks.execFileNoThrow
			.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'missing' })
			.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'missing' });

		await expect(
			new WakaTimeManager(settingsStore({}) as never).ensureCliInstalled()
		).resolves.toBe(false);
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining('Too many redirects'),
			'[WakaTime]'
		);
	});

	it('checks for CLI updates, handles version states, and ignores update request failures', async () => {
		const manager = createManager({});

		mockHttpsGet([
			{
				statusCode: 302,
				headers: { location: 'https://api.example/releases/latest' },
			},
			{ statusCode: 200, body: '{}' },
		]);
		await (manager as any).checkForUpdate();
		expect(logger.debug).toHaveBeenCalledWith(
			'Could not determine latest WakaTime CLI version from GitHub',
			'[WakaTime]'
		);

		vi.restoreAllMocks();
		mockHttpsGet([{ statusCode: 200, body: '{"tag_name":"v1.73.1"}' }]);
		mocks.execFileNoThrow.mockResolvedValueOnce({
			exitCode: 0,
			stdout: 'wakatime-cli 1.73.1\n',
			stderr: '',
		});
		await (manager as any).checkForUpdate();
		expect(logger.debug).toHaveBeenCalledWith('WakaTime CLI is up to date (1.73.1)', '[WakaTime]');

		vi.restoreAllMocks();
		mockHttpsGet([{ statusCode: 200, body: '{"tag_name":"v1.74.0"}' }]);
		(manager as any).doInstall = vi.fn(async () => true);
		mocks.execFileNoThrow.mockResolvedValueOnce({
			exitCode: 0,
			stdout: 'v1.73.1\n',
			stderr: '',
		});
		await (manager as any).checkForUpdate();
		expect(logger.info).toHaveBeenCalledWith(
			'WakaTime CLI update available: 1.73.1 → 1.74.0',
			'[WakaTime]'
		);
		expect((manager as any).doInstall).toHaveBeenCalledOnce();

		vi.restoreAllMocks();
		(manager as any).cliPath = 'wakatime-cli';
		mockHttpsGet([{ statusCode: 200, body: '{"tag_name":"v1.74.0"}' }]);
		mocks.execFileNoThrow.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'bad version' });
		await (manager as any).checkForUpdate();

		vi.restoreAllMocks();
		(manager as any).cliPath = null;
		mockHttpsGet([{ statusCode: 200, body: '{"tag_name":"v1.74.0"}' }]);
		await (manager as any).checkForUpdate();

		vi.restoreAllMocks();
		(manager as any).cliPath = 'wakatime-cli';
		mockHttpsGet([{ statusCode: 500, body: 'nope' }]);
		await (manager as any).checkForUpdate();
		expect(logger.debug).toHaveBeenCalledWith(
			'WakaTime CLI update check failed: HTTP 500',
			'[WakaTime]'
		);

		vi.restoreAllMocks();
		mockHttpsGet([{ statusCode: 200, body: 'not-json' }]);
		await (manager as any).checkForUpdate();
		expect(logger.debug).toHaveBeenCalledWith(
			expect.stringContaining('update check failed'),
			'[WakaTime]'
		);

		vi.restoreAllMocks();
		mockHttpsGet(
			Array.from({ length: 6 }, () => ({
				statusCode: 302,
				headers: { location: 'https://api.example/loop' },
			}))
		);
		await (manager as any).checkForUpdate();
		expect(logger.debug).toHaveBeenCalledWith(
			'WakaTime CLI update check failed: Too many redirects',
			'[WakaTime]'
		);

		vi.restoreAllMocks();
		mockHttpsGet([{ requestError: new Error('network down') }]);
		await (manager as any).checkForUpdate();
		expect(logger.debug).toHaveBeenCalledWith(
			'WakaTime CLI update check failed: network down',
			'[WakaTime]'
		);
	});

	it('reads API keys from config files and tolerates malformed config reads', async () => {
		vi.spyOn(os, 'homedir').mockReturnValue(tempDir);
		expect((new WakaTimeManager(settingsStore({}) as never) as any).readApiKeyFromConfig()).toBe(
			''
		);
		fs.writeFileSync(path.join(tempDir, '.wakatime.cfg'), '[settings]\napi_key = config-key\n');
		mocks.execFileNoThrow.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
		const manager = createManager({ wakatimeEnabled: true, wakatimeApiKey: '' });

		await manager.sendHeartbeat('config-session', 'Maestro');

		expect(mocks.execFileNoThrow.mock.calls[0][1]).toContain('config-key');

		const brokenManager = new WakaTimeManager(settingsStore({}) as never);
		vi.spyOn(fs, 'existsSync').mockReturnValue(true);
		vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
			throw new Error('bad config');
		});

		expect((brokenManager as any).readApiKeyFromConfig()).toBe('');
	});

	it('detects project languages from marker fallbacks and caches missing languages', () => {
		const manager = createManager({});
		fs.writeFileSync(path.join(tempDir, 'project.csproj'), '<Project />');
		expect((manager as any).detectLanguage('cs-session', tempDir)).toBe('C#');

		const emptyDir = path.join(tempDir, 'empty');
		fs.mkdirSync(emptyDir);
		expect((manager as any).detectLanguage('empty-session', emptyDir)).toBeNull();
		fs.writeFileSync(path.join(emptyDir, 'package.json'), '{}');
		expect((manager as any).detectLanguage('empty-session', emptyDir)).toBeNull();

		expect(
			(manager as any).detectLanguage('missing-dir-session', path.join(tempDir, 'missing'))
		).toBeNull();
	});

	it('sends debounced app heartbeats with project language, branch, plugin, and source category', async () => {
		fs.writeFileSync(path.join(tempDir, 'tsconfig.json'), '{}');
		const now = Date.UTC(2026, 4, 25, 16, 0, 0);
		vi.useFakeTimers({ now });
		mocks.execFileNoThrow
			.mockResolvedValueOnce({ exitCode: 0, stdout: 'main\n', stderr: '' })
			.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });

		const manager = createManager({ wakatimeEnabled: true, wakatimeApiKey: 'waka-key' });

		await manager.sendHeartbeat('session-1', 'Maestro', tempDir, 'auto');
		await manager.sendHeartbeat('session-1', 'Maestro', tempDir, 'auto');

		expect(execFileNoThrow).toHaveBeenCalledTimes(2);
		expect(execFileNoThrow).toHaveBeenNthCalledWith(
			1,
			'git',
			['rev-parse', '--abbrev-ref', 'HEAD'],
			tempDir
		);
		const heartbeatArgs = mocks.execFileNoThrow.mock.calls[1][1] as string[];
		expect(heartbeatArgs).toEqual(
			expect.arrayContaining([
				'--key',
				'waka-key',
				'--entity',
				'Maestro',
				'--entity-type',
				'app',
				'--project',
				'Maestro',
				'--plugin',
				'maestro/9.8.7 maestro-wakatime/9.8.7',
				'--category',
				'ai coding',
				'--language',
				'TypeScript',
				'--alternate-branch',
				'main',
			])
		);

		vi.setSystemTime(now + 120_001);
		mocks.execFileNoThrow.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
		await manager.sendHeartbeat('session-1', 'Maestro', tempDir, 'user');

		expect(execFileNoThrow).toHaveBeenCalledTimes(3);
		const secondHeartbeatArgs = mocks.execFileNoThrow.mock.calls[2][1] as string[];
		expect(secondHeartbeatArgs).toContain('building');
		expect(secondHeartbeatArgs).toContain('main');
	});

	it('skips app heartbeats when settings, API key, or CLI availability block them', async () => {
		await new WakaTimeManager(settingsStore({ wakatimeEnabled: false }) as never).sendHeartbeat(
			'session-1',
			'Maestro',
			tempDir
		);
		const noKeyManager = new WakaTimeManager(
			settingsStore({ wakatimeEnabled: true, wakatimeApiKey: '' }) as never
		);
		(noKeyManager as any).readApiKeyFromConfig = () => '';
		await noKeyManager.sendHeartbeat('session-2', 'Maestro', tempDir);

		Object.defineProperty(process, 'platform', { value: 'freebsd', configurable: true });
		Object.defineProperty(process, 'arch', { value: 'arm64', configurable: true });
		mocks.execFileNoThrow
			.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'missing' })
			.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'missing' });
		const manager = new WakaTimeManager(
			settingsStore({ wakatimeEnabled: true, wakatimeApiKey: 'waka-key' }) as never
		);

		await manager.sendHeartbeat('session-3', 'Maestro', tempDir);

		expect(execFileNoThrow).toHaveBeenCalledTimes(2);
		expect(logger.warn).toHaveBeenCalledWith(
			'WakaTime CLI not available - skipping heartbeat',
			'[WakaTime]'
		);
	});

	it('retries failed branch detection, logs failed app heartbeats, and skips update-check errors', async () => {
		const now = Date.UTC(2026, 4, 25, 16, 0, 0);
		vi.useFakeTimers({ now });
		const manager = createManager({ wakatimeEnabled: true, wakatimeApiKey: 'waka-key' });
		(manager as any).lastUpdateCheck = 0;
		(manager as any).checkForUpdate = vi.fn(async () => {
			throw new Error('ignored');
		});
		mocks.execFileNoThrow
			.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'not a repo' })
			.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'heartbeat failed' });

		await manager.sendHeartbeat('failed-session', 'Maestro', tempDir, 'user');

		expect(logger.warn).toHaveBeenCalledWith(
			'Heartbeat failed for failed-session: heartbeat failed',
			'[WakaTime]'
		);
		expect((manager as any).checkForUpdate).toHaveBeenCalledOnce();
	});

	it('sends detailed file heartbeats with primary CLI args and extra heartbeat JSON payloads', async () => {
		mocks.execFileNoThrow
			.mockResolvedValueOnce({ exitCode: 0, stdout: 'feature/waka\n', stderr: '' })
			.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
		const manager = createManager({
			wakatimeEnabled: true,
			wakatimeDetailedTracking: true,
			wakatimeApiKey: 'waka-key',
		});

		await manager.sendFileHeartbeats(
			[
				{ filePath: path.join(tempDir, 'src/App.tsx'), timestamp: 1_700_000_000_000 },
				{ filePath: path.join(tempDir, 'README.md'), timestamp: 1_700_000_030_000 },
				{ filePath: path.join(tempDir, 'data.unknown'), timestamp: 1_700_000_060_000 },
			],
			'Maestro',
			tempDir,
			'auto'
		);

		expect(execFileNoThrow).toHaveBeenCalledTimes(2);
		const [, args, cwd, options] = mocks.execFileNoThrow.mock.calls[1] as [
			string,
			string[],
			string,
			{ input: string },
		];
		expect(cwd).toBe(tempDir);
		expect(args).toEqual(
			expect.arrayContaining([
				'--entity',
				path.join(tempDir, 'src/App.tsx'),
				'--entity-type',
				'file',
				'--write',
				'--language',
				'TypeScript',
				'--alternate-branch',
				'feature/waka',
				'--extra-heartbeats',
			])
		);
		const extra = JSON.parse(options.input) as Array<Record<string, unknown>>;
		expect(extra).toEqual([
			expect.objectContaining({
				entity: path.join(tempDir, 'README.md'),
				type: 'file',
				is_write: true,
				category: 'ai coding',
				project: 'Maestro',
				language: 'Markdown',
				branch: 'feature/waka',
			}),
			expect.objectContaining({
				entity: path.join(tempDir, 'data.unknown'),
				type: 'file',
				is_write: true,
				category: 'ai coding',
				project: 'Maestro',
				branch: 'feature/waka',
			}),
		]);
		expect(extra[1]).not.toHaveProperty('language');
		expect(logger.info).toHaveBeenCalledWith('Sent file heartbeats', '[WakaTime]', { count: 3 });
	});

	it('skips detailed file heartbeats for empty input, disabled settings, missing key, or disabled detail tracking', async () => {
		await createManager({
			wakatimeEnabled: true,
			wakatimeDetailedTracking: true,
			wakatimeApiKey: 'waka-key',
		}).sendFileHeartbeats([], 'Maestro', tempDir);
		await createManager({
			wakatimeEnabled: false,
			wakatimeDetailedTracking: true,
			wakatimeApiKey: 'waka-key',
		}).sendFileHeartbeats([{ filePath: '/tmp/a.ts', timestamp: 1 }], 'Maestro', tempDir);
		await createManager({
			wakatimeEnabled: true,
			wakatimeDetailedTracking: false,
			wakatimeApiKey: 'waka-key',
		}).sendFileHeartbeats([{ filePath: '/tmp/a.ts', timestamp: 1 }], 'Maestro', tempDir);
		const noFileKeyManager = createManager({
			wakatimeEnabled: true,
			wakatimeDetailedTracking: true,
			wakatimeApiKey: '',
		});
		(noFileKeyManager as any).readApiKeyFromConfig = () => '';
		await noFileKeyManager.sendFileHeartbeats(
			[{ filePath: '/tmp/a.ts', timestamp: 1 }],
			'Maestro',
			tempDir
		);

		expect(execFileNoThrow).not.toHaveBeenCalled();
	});

	it('logs unavailable CLI and failed detailed file heartbeat paths', async () => {
		setPlatform('freebsd', 'arm64');
		mocks.execFileNoThrow
			.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'missing' })
			.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'missing' });

		await new WakaTimeManager(
			settingsStore({
				wakatimeEnabled: true,
				wakatimeDetailedTracking: true,
				wakatimeApiKey: 'waka-key',
			}) as never
		).sendFileHeartbeats([{ filePath: '/tmp/a.ts', timestamp: 1 }], 'Maestro', tempDir);

		expect(logger.warn).toHaveBeenCalledWith(
			'WakaTime CLI not available - skipping file heartbeats',
			'[WakaTime]'
		);

		Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
		Object.defineProperty(process, 'arch', { value: originalArch, configurable: true });
		mocks.execFileNoThrow.mockReset();
		const manager = createManager({
			wakatimeEnabled: true,
			wakatimeDetailedTracking: true,
			wakatimeApiKey: 'waka-key',
		});
		mocks.execFileNoThrow.mockResolvedValueOnce({
			exitCode: 1,
			stdout: '',
			stderr: 'file heartbeat failed',
		});

		await manager.sendFileHeartbeats(
			[{ filePath: path.join(tempDir, 'script.js'), timestamp: 1_700_000_000_000 }],
			'Maestro'
		);

		expect(logger.warn).toHaveBeenCalledWith(
			'File heartbeats failed: file heartbeat failed',
			'[WakaTime]',
			{ count: 1 }
		);
	});

	it('clears heartbeat, branch, and language caches for removed sessions', async () => {
		fs.writeFileSync(path.join(tempDir, 'package.json'), '{}');
		vi.useFakeTimers({ now: Date.UTC(2026, 4, 25, 16, 0, 0) });
		mocks.execFileNoThrow
			.mockResolvedValueOnce({ exitCode: 0, stdout: 'main\n', stderr: '' })
			.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
			.mockResolvedValueOnce({ exitCode: 0, stdout: 'develop\n', stderr: '' })
			.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
		const manager = createManager({ wakatimeEnabled: true, wakatimeApiKey: 'waka-key' });

		await manager.sendHeartbeat('session-1', 'Maestro', tempDir);
		manager.removeSession('session-1');
		vi.setSystemTime(Date.UTC(2026, 4, 25, 16, 0, 1));
		await manager.sendHeartbeat('session-1', 'Maestro', tempDir);

		expect(execFileNoThrow).toHaveBeenCalledTimes(4);
		expect(mocks.execFileNoThrow.mock.calls[1][1] as string[]).toContain('main');
		expect(mocks.execFileNoThrow.mock.calls[3][1] as string[]).toContain('develop');
	});
});
