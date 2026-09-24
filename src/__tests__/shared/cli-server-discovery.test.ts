// @vitest-environment node
/**
 * Tests for src/shared/cli-server-discovery.ts
 *
 * This module manages the CLI server discovery file, written by the Electron
 * main process and read by the CLI to locate the running server. Tests run
 * against a real temp directory (only `os.platform` / `os.homedir` are stubbed
 * to steer the platform-default path), so atomic replacement, ownership-aware
 * deletion, and pid-reuse detection are exercised on real files and processes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

vi.mock('os', async () => {
	const actual = await vi.importActual<typeof import('os')>('os');
	return { ...actual, platform: vi.fn(), homedir: vi.fn() };
});

import * as os from 'os';

import {
	writeCliServerInfo,
	readCliServerInfo,
	deleteCliServerInfo,
	isCliServerRunning,
} from '../../shared/cli-server-discovery';
import { readProcessStartToken } from '../../shared/processIdentity';

// Local type alias mirroring the (now-internal) CliServerInfo shape
// expected by writeCliServerInfo. Kept in sync with shared/cli-server-discovery.ts.
type CliServerInfo = Parameters<typeof writeCliServerInfo>[0];

const mockOs = {
	platform: os.platform as unknown as ReturnType<typeof vi.fn>,
	homedir: os.homedir as unknown as ReturnType<typeof vi.fn>,
};

const tokensSupported = process.platform === 'linux' || process.platform === 'darwin';

describe('cli-server-discovery', () => {
	const realTmp = fs.realpathSync(os.tmpdir());
	let root: string;
	let discoveryFile: string;
	const savedEnv = {
		MAESTRO_USER_DATA: process.env.MAESTRO_USER_DATA,
		XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
		APPDATA: process.env.APPDATA,
	};

	const sampleInfo: CliServerInfo = {
		port: 3456,
		token: 'abc-123-def-456',
		pid: 12345,
		startedAt: 1700000000000,
	};

	const ownInfo = (): CliServerInfo => ({ ...sampleInfo, pid: process.pid });

	function writeRaw(content: unknown): void {
		fs.mkdirSync(path.dirname(discoveryFile), { recursive: true });
		fs.writeFileSync(
			discoveryFile,
			typeof content === 'string' ? content : JSON.stringify(content)
		);
	}

	function restoreEnv(key: keyof typeof savedEnv): void {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(realTmp, 'maestro-discovery-'));
		mockOs.platform.mockReturnValue('linux');
		mockOs.homedir.mockReturnValue(root);
		// Tests steer the location through MAESTRO_USER_DATA unless they are
		// checking the platform defaults.
		process.env.MAESTRO_USER_DATA = path.join(root, 'userData');
		discoveryFile = path.join(root, 'userData', 'cli-server.json');
	});

	afterEach(() => {
		vi.restoreAllMocks();
		restoreEnv('MAESTRO_USER_DATA');
		restoreEnv('XDG_CONFIG_HOME');
		restoreEnv('APPDATA');
		fs.rmSync(root, { recursive: true, force: true });
	});

	describe('getConfigDir (internal via path construction)', () => {
		beforeEach(() => {
			delete process.env.MAESTRO_USER_DATA;
		});

		it('should construct correct config path for macOS', () => {
			mockOs.platform.mockReturnValue('darwin');
			writeCliServerInfo(sampleInfo);
			expect(
				fs.existsSync(
					path.join(root, 'Library', 'Application Support', 'maestro', 'cli-server.json')
				)
			).toBe(true);
		});

		it('should construct correct config path for Windows with APPDATA', () => {
			mockOs.platform.mockReturnValue('win32');
			process.env.APPDATA = path.join(root, 'Roaming');
			writeCliServerInfo(sampleInfo);
			expect(fs.existsSync(path.join(root, 'Roaming', 'maestro', 'cli-server.json'))).toBe(true);
		});

		it('should construct correct config path for Windows without APPDATA', () => {
			mockOs.platform.mockReturnValue('win32');
			delete process.env.APPDATA;
			writeCliServerInfo(sampleInfo);
			expect(
				fs.existsSync(path.join(root, 'AppData', 'Roaming', 'maestro', 'cli-server.json'))
			).toBe(true);
		});

		it('should construct correct config path for Linux with XDG_CONFIG_HOME', () => {
			process.env.XDG_CONFIG_HOME = path.join(root, 'custom-config');
			writeCliServerInfo(sampleInfo);
			expect(fs.existsSync(path.join(root, 'custom-config', 'maestro', 'cli-server.json'))).toBe(
				true
			);
		});

		it('should construct correct config path for Linux without XDG_CONFIG_HOME', () => {
			delete process.env.XDG_CONFIG_HOME;
			writeCliServerInfo(sampleInfo);
			expect(fs.existsSync(path.join(root, '.config', 'maestro', 'cli-server.json'))).toBe(true);
		});

		it('should honor MAESTRO_USER_DATA override over platform default', () => {
			mockOs.platform.mockReturnValue('darwin');
			process.env.MAESTRO_USER_DATA = path.join(root, 'maestro-dev');
			writeCliServerInfo(sampleInfo);
			expect(fs.existsSync(path.join(root, 'maestro-dev', 'cli-server.json'))).toBe(true);
			expect(fs.existsSync(path.join(root, 'Library'))).toBe(false);
		});

		it('should resolve relative MAESTRO_USER_DATA to absolute path', () => {
			const cwd = process.cwd();
			process.chdir(root);
			try {
				process.env.MAESTRO_USER_DATA = './relative-data-dir';
				writeCliServerInfo(sampleInfo);
				expect(fs.existsSync(path.join(root, 'relative-data-dir', 'cli-server.json'))).toBe(true);
			} finally {
				process.chdir(cwd);
			}
		});
	});

	describe('writeCliServerInfo', () => {
		it('should write the file with correct content, creating the directory', () => {
			writeCliServerInfo(sampleInfo);
			expect(JSON.parse(fs.readFileSync(discoveryFile, 'utf-8'))).toEqual(sampleInfo);
		});

		it('replaces an existing file and leaves no temp or lock files behind', () => {
			writeCliServerInfo(sampleInfo);
			writeCliServerInfo({ ...sampleInfo, port: 9999 });
			expect(readCliServerInfo()?.port).toBe(9999);
			expect(fs.readdirSync(path.dirname(discoveryFile))).toEqual(['cli-server.json']);
		});

		it('stamps the start token when the app describes itself', () => {
			writeCliServerInfo(ownInfo());
			expect(readCliServerInfo()?.startToken).toBe(readProcessStartToken(process.pid) ?? undefined);
		});

		it('still writes when the lock is stuck on a frozen holder', () => {
			fs.mkdirSync(path.dirname(discoveryFile), { recursive: true });
			fs.writeFileSync(
				`${discoveryFile}.lock`,
				JSON.stringify({ pid: process.pid, instanceId: 'stuck', acquiredAt: Date.now() })
			);
			writeCliServerInfo(sampleInfo);
			expect(readCliServerInfo()).toEqual(sampleInfo);
		});
	});

	describe('readCliServerInfo', () => {
		it('should return null for missing file', () => {
			expect(readCliServerInfo()).toBeNull();
		});

		it('should return null for invalid JSON', () => {
			writeRaw('invalid json {{{');
			expect(readCliServerInfo()).toBeNull();
		});

		it('should return parsed data for valid file', () => {
			writeRaw(sampleInfo);
			expect(readCliServerInfo()).toEqual(sampleInfo);
		});

		it.each([
			['port is missing', { token: 't', pid: 1, startedAt: 1 }],
			['token is not a string', { port: 1, token: 123, pid: 1, startedAt: 1 }],
			['pid is missing', { port: 1, token: 't', startedAt: 1 }],
			['startedAt is missing', { port: 1, token: 't', pid: 1 }],
		])('should return null when %s', (_label, data) => {
			writeRaw(data);
			expect(readCliServerInfo()).toBeNull();
		});
	});

	describe('deleteCliServerInfo', () => {
		it('should remove a file this process wrote', () => {
			writeCliServerInfo(ownInfo());
			deleteCliServerInfo();
			expect(fs.existsSync(discoveryFile)).toBe(false);
		});

		it('should not throw when file does not exist', () => {
			expect(() => deleteCliServerInfo()).not.toThrow();
		});

		it("keeps another running app's file: quitting must not orphan the survivor", () => {
			// A second app process on the same data dir published its own server.
			writeCliServerInfo(sampleInfo);
			deleteCliServerInfo();
			expect(readCliServerInfo()).toEqual(sampleInfo);
		});

		it('removes an unreadable file, which points nowhere anyway', () => {
			writeRaw('garbage');
			deleteCliServerInfo();
			expect(fs.existsSync(discoveryFile)).toBe(false);
		});
	});

	describe('isCliServerRunning', () => {
		it('should return true for current PID', () => {
			writeCliServerInfo(ownInfo());
			expect(isCliServerRunning()).toBe(true);
		});

		it('should return false for non-existent PID', () => {
			writeRaw(sampleInfo);
			vi.spyOn(process, 'kill').mockImplementation(() => {
				throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
			});
			expect(isCliServerRunning()).toBe(false);
		});

		it('should treat EPERM as alive so the authenticated connection can decide reachability', () => {
			writeRaw(sampleInfo);
			vi.spyOn(process, 'kill').mockImplementation(() => {
				throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
			});
			expect(isCliServerRunning()).toBe(true);
		});

		it.runIf(tokensSupported)(
			'should return false when the pid was recycled by an unrelated process',
			() => {
				const unrelated = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
					stdio: 'ignore',
				});
				try {
					// The app that wrote this crashed; its pid now belongs to someone else.
					writeRaw({ ...sampleInfo, pid: unrelated.pid!, startToken: '1' });
					expect(isCliServerRunning()).toBe(false);
				} finally {
					unrelated.kill('SIGKILL');
				}
			}
		);

		it('should return false when discovery file is missing', () => {
			expect(isCliServerRunning()).toBe(false);
		});

		it('should return false when discovery file has invalid data', () => {
			writeRaw('garbage');
			expect(isCliServerRunning()).toBe(false);
		});
	});
});
