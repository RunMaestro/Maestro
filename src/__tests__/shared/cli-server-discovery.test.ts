/**
 * Tests for src/shared/cli-server-discovery.ts
 *
 * This module provides functions for managing the CLI server discovery file,
 * used by the Electron main process and CLI to locate the running server.
 * Tests mock Node.js fs and os modules to isolate behavior.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the Node.js modules before importing the module under test
vi.mock('fs', () => ({
	readFileSync: vi.fn(),
	writeFileSync: vi.fn(),
	existsSync: vi.fn(),
	mkdirSync: vi.fn(),
	renameSync: vi.fn(),
	unlinkSync: vi.fn(),
}));

vi.mock('os', () => ({
	platform: vi.fn(),
	homedir: vi.fn(),
}));

// Now import after mocks are set up
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
	CliServerInfo,
	writeCliServerInfo,
	readCliServerInfo,
	deleteCliServerInfo,
	isCliServerRunning,
} from '../../shared/cli-server-discovery';

// Type assertions for mocked modules
const mockFs = {
	readFileSync: fs.readFileSync as ReturnType<typeof vi.fn>,
	writeFileSync: fs.writeFileSync as ReturnType<typeof vi.fn>,
	existsSync: fs.existsSync as ReturnType<typeof vi.fn>,
	mkdirSync: fs.mkdirSync as ReturnType<typeof vi.fn>,
	renameSync: fs.renameSync as ReturnType<typeof vi.fn>,
	unlinkSync: fs.unlinkSync as ReturnType<typeof vi.fn>,
};

const mockOs = {
	platform: os.platform as ReturnType<typeof vi.fn>,
	homedir: os.homedir as ReturnType<typeof vi.fn>,
};

describe('cli-server-discovery', () => {
	const sampleInfo: CliServerInfo = {
		port: 3456,
		token: 'abc-123-def-456',
		pid: 12345,
		startedAt: 1700000000000,
	};

	beforeEach(() => {
		vi.clearAllMocks();

		// Default mock implementations
		mockOs.platform.mockReturnValue('darwin');
		mockOs.homedir.mockReturnValue('/Users/testuser');
		mockFs.existsSync.mockReturnValue(true);
		mockFs.readFileSync.mockReturnValue(JSON.stringify(sampleInfo));
		mockFs.writeFileSync.mockReturnValue(undefined);
		mockFs.mkdirSync.mockReturnValue(undefined);
		mockFs.renameSync.mockReturnValue(undefined);
		mockFs.unlinkSync.mockReturnValue(undefined);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('getConfigDir (internal via path construction)', () => {
		it('should construct correct config path for macOS', () => {
			mockOs.platform.mockReturnValue('darwin');
			mockOs.homedir.mockReturnValue('/Users/testuser');

			readCliServerInfo();

			expect(mockFs.readFileSync).toHaveBeenCalledWith(
				path.join(
					'/Users/testuser',
					'Library',
					'Application Support',
					'maestro',
					'cli-server.json'
				),
				'utf-8'
			);
		});

		it('should construct correct config path for Windows with APPDATA', () => {
			mockOs.platform.mockReturnValue('win32');
			mockOs.homedir.mockReturnValue('C:\\Users\\testuser');
			const originalAppdata = process.env.APPDATA;
			process.env.APPDATA = 'C:\\Users\\testuser\\AppData\\Roaming';

			try {
				readCliServerInfo();

				expect(mockFs.readFileSync).toHaveBeenCalledWith(
					path.join('C:\\Users\\testuser\\AppData\\Roaming', 'maestro', 'cli-server.json'),
					'utf-8'
				);
			} finally {
				if (originalAppdata === undefined) {
					delete process.env.APPDATA;
				} else {
					process.env.APPDATA = originalAppdata;
				}
			}
		});

		it('should construct correct config path for Windows without APPDATA', () => {
			mockOs.platform.mockReturnValue('win32');
			mockOs.homedir.mockReturnValue('C:\\Users\\testuser');
			const originalAppdata = process.env.APPDATA;
			delete process.env.APPDATA;

			try {
				readCliServerInfo();

				expect(mockFs.readFileSync).toHaveBeenCalledWith(
					path.join('C:\\Users\\testuser', 'AppData', 'Roaming', 'maestro', 'cli-server.json'),
					'utf-8'
				);
			} finally {
				if (originalAppdata === undefined) {
					delete process.env.APPDATA;
				} else {
					process.env.APPDATA = originalAppdata;
				}
			}
		});

		it('should construct correct config path for Linux with XDG_CONFIG_HOME', () => {
			mockOs.platform.mockReturnValue('linux');
			mockOs.homedir.mockReturnValue('/home/testuser');
			const originalXdg = process.env.XDG_CONFIG_HOME;
			process.env.XDG_CONFIG_HOME = '/home/testuser/.custom-config';

			try {
				readCliServerInfo();

				expect(mockFs.readFileSync).toHaveBeenCalledWith(
					path.join('/home/testuser/.custom-config', 'maestro', 'cli-server.json'),
					'utf-8'
				);
			} finally {
				if (originalXdg === undefined) {
					delete process.env.XDG_CONFIG_HOME;
				} else {
					process.env.XDG_CONFIG_HOME = originalXdg;
				}
			}
		});

		it('should construct correct config path for Linux without XDG_CONFIG_HOME', () => {
			mockOs.platform.mockReturnValue('linux');
			mockOs.homedir.mockReturnValue('/home/testuser');
			const originalXdg = process.env.XDG_CONFIG_HOME;
			delete process.env.XDG_CONFIG_HOME;

			try {
				readCliServerInfo();

				expect(mockFs.readFileSync).toHaveBeenCalledWith(
					path.join('/home/testuser', '.config', 'maestro', 'cli-server.json'),
					'utf-8'
				);
			} finally {
				if (originalXdg === undefined) {
					delete process.env.XDG_CONFIG_HOME;
				} else {
					process.env.XDG_CONFIG_HOME = originalXdg;
				}
			}
		});
	});

	describe('writeCliServerInfo', () => {
		it('should write the file with correct content via atomic rename', () => {
			writeCliServerInfo(sampleInfo);

			const expectedDir = path.join('/Users/testuser', 'Library', 'Application Support', 'maestro');
			const expectedFile = path.join(expectedDir, 'cli-server.json');
			const expectedTmp = expectedFile + '.tmp';

			expect(mockFs.writeFileSync).toHaveBeenCalledWith(
				expectedTmp,
				JSON.stringify(sampleInfo, null, 2),
				'utf-8'
			);
			expect(mockFs.renameSync).toHaveBeenCalledWith(expectedTmp, expectedFile);
		});

		it('should create directory if it does not exist', () => {
			mockFs.existsSync.mockReturnValue(false);

			writeCliServerInfo(sampleInfo);

			expect(mockFs.mkdirSync).toHaveBeenCalledWith(
				path.join('/Users/testuser', 'Library', 'Application Support', 'maestro'),
				{ recursive: true }
			);
		});

		it('should not create directory if it already exists', () => {
			mockFs.existsSync.mockReturnValue(true);

			writeCliServerInfo(sampleInfo);

			expect(mockFs.mkdirSync).not.toHaveBeenCalled();
		});
	});

	describe('readCliServerInfo', () => {
		it('should return null for missing file', () => {
			mockFs.readFileSync.mockImplementation(() => {
				throw new Error('ENOENT: no such file or directory');
			});

			const result = readCliServerInfo();
			expect(result).toBeNull();
		});

		it('should return null for invalid JSON', () => {
			mockFs.readFileSync.mockReturnValue('not valid json');

			const result = readCliServerInfo();
			expect(result).toBeNull();
		});

		it('should return parsed data for valid file', () => {
			mockFs.readFileSync.mockReturnValue(JSON.stringify(sampleInfo));

			const result = readCliServerInfo();
			expect(result).toEqual(sampleInfo);
			expect(result!.port).toBe(3456);
			expect(result!.token).toBe('abc-123-def-456');
			expect(result!.pid).toBe(12345);
			expect(result!.startedAt).toBe(1700000000000);
		});

		it('should return null when port is missing', () => {
			mockFs.readFileSync.mockReturnValue(
				JSON.stringify({
					token: 'abc',
					pid: 123,
					startedAt: 1000,
				})
			);

			const result = readCliServerInfo();
			expect(result).toBeNull();
		});

		it('should return null when token is not a string', () => {
			mockFs.readFileSync.mockReturnValue(
				JSON.stringify({
					port: 3456,
					token: 123,
					pid: 123,
					startedAt: 1000,
				})
			);

			const result = readCliServerInfo();
			expect(result).toBeNull();
		});

		it('should return null when pid is missing', () => {
			mockFs.readFileSync.mockReturnValue(
				JSON.stringify({
					port: 3456,
					token: 'abc',
					startedAt: 1000,
				})
			);

			const result = readCliServerInfo();
			expect(result).toBeNull();
		});

		it('should return null when startedAt is missing', () => {
			mockFs.readFileSync.mockReturnValue(
				JSON.stringify({
					port: 3456,
					token: 'abc',
					pid: 123,
				})
			);

			const result = readCliServerInfo();
			expect(result).toBeNull();
		});
	});

	describe('deleteCliServerInfo', () => {
		it('should remove the file', () => {
			deleteCliServerInfo();

			const expectedFile = path.join(
				'/Users/testuser',
				'Library',
				'Application Support',
				'maestro',
				'cli-server.json'
			);
			expect(mockFs.unlinkSync).toHaveBeenCalledWith(expectedFile);
		});

		it('should not throw when file does not exist', () => {
			mockFs.unlinkSync.mockImplementation(() => {
				throw new Error('ENOENT: no such file or directory');
			});

			expect(() => deleteCliServerInfo()).not.toThrow();
		});
	});

	describe('isCliServerRunning', () => {
		it('should return true for current PID', () => {
			mockFs.readFileSync.mockReturnValue(JSON.stringify(sampleInfo));

			const originalKill = process.kill;
			process.kill = vi.fn().mockReturnValue(true) as unknown as typeof process.kill;

			try {
				const result = isCliServerRunning();

				expect(result).toBe(true);
				expect(process.kill).toHaveBeenCalledWith(12345, 0);
			} finally {
				process.kill = originalKill;
			}
		});

		it('should return false for non-existent PID', () => {
			mockFs.readFileSync.mockReturnValue(JSON.stringify(sampleInfo));

			const originalKill = process.kill;
			process.kill = vi.fn().mockImplementation(() => {
				throw new Error('ESRCH: No such process');
			}) as unknown as typeof process.kill;

			try {
				const result = isCliServerRunning();

				expect(result).toBe(false);
			} finally {
				process.kill = originalKill;
			}
		});

		it('should return false when discovery file is missing', () => {
			mockFs.readFileSync.mockImplementation(() => {
				throw new Error('ENOENT: no such file or directory');
			});

			const result = isCliServerRunning();

			expect(result).toBe(false);
		});

		it('should return false when discovery file has invalid data', () => {
			mockFs.readFileSync.mockReturnValue('not json');

			const result = isCliServerRunning();

			expect(result).toBe(false);
		});
	});
});
