/**
 * Tests for src/shared/cli-server-discovery.ts
 *
 * This module publishes the Electron app's CLI IPC server discovery file.
 * Tests mock Node.js fs, os, and process APIs to isolate behavior.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('fs', () => ({
	readFileSync: vi.fn(),
	writeFileSync: vi.fn(),
	existsSync: vi.fn(),
	mkdirSync: vi.fn(),
	statSync: vi.fn(),
	chmodSync: vi.fn(),
	renameSync: vi.fn(),
	unlinkSync: vi.fn(),
}));

vi.mock('os', () => ({
	platform: vi.fn(),
	homedir: vi.fn(),
}));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
	CliServerInfo,
	deleteCliServerInfo,
	isCliServerRunning,
	readCliServerInfo,
	writeCliServerInfo,
} from '../../shared/cli-server-discovery';

const mockFs = {
	readFileSync: fs.readFileSync as ReturnType<typeof vi.fn>,
	writeFileSync: fs.writeFileSync as ReturnType<typeof vi.fn>,
	existsSync: fs.existsSync as ReturnType<typeof vi.fn>,
	mkdirSync: fs.mkdirSync as ReturnType<typeof vi.fn>,
	statSync: fs.statSync as ReturnType<typeof vi.fn>,
	chmodSync: fs.chmodSync as ReturnType<typeof vi.fn>,
	renameSync: fs.renameSync as ReturnType<typeof vi.fn>,
	unlinkSync: fs.unlinkSync as ReturnType<typeof vi.fn>,
};

const mockOs = {
	platform: os.platform as ReturnType<typeof vi.fn>,
	homedir: os.homedir as ReturnType<typeof vi.fn>,
};

describe('cli-server-discovery', () => {
	const configDir = path.join('/Users/testuser', 'Library', 'Application Support', 'maestro');
	const serverFile = path.join(configDir, 'cli-server.json');
	const sampleInfo: CliServerInfo = {
		port: 54321,
		token: 'test-token',
		pid: 12345,
		startedAt: 1710000000000,
	};

	beforeEach(() => {
		vi.clearAllMocks();

		mockOs.platform.mockReturnValue('darwin');
		mockOs.homedir.mockReturnValue('/Users/testuser');
		mockFs.existsSync.mockReturnValue(true);
		mockFs.readFileSync.mockReturnValue(JSON.stringify(sampleInfo));
		mockFs.writeFileSync.mockReturnValue(undefined);
		mockFs.mkdirSync.mockReturnValue(undefined);
		mockFs.statSync.mockReturnValue({ mode: 0o700 } as fs.Stats);
		mockFs.chmodSync.mockReturnValue(undefined);
		mockFs.renameSync.mockReturnValue(undefined);
		mockFs.unlinkSync.mockReturnValue(undefined);

		vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('writeCliServerInfo', () => {
		it('creates the discovery file with correct content using an atomic rename', () => {
			mockFs.existsSync.mockReturnValue(false);

			writeCliServerInfo(sampleInfo);

			expect(mockFs.mkdirSync).toHaveBeenCalledWith(configDir, { recursive: true, mode: 0o700 });
			expect(mockFs.writeFileSync).toHaveBeenCalledWith(
				`${serverFile}.tmp`,
				JSON.stringify(sampleInfo, null, 2),
				{ encoding: 'utf-8', mode: 0o600 }
			);
			expect(mockFs.chmodSync).toHaveBeenCalledWith(`${serverFile}.tmp`, 0o600);
			expect(mockFs.renameSync).toHaveBeenCalledWith(`${serverFile}.tmp`, serverFile);
			expect(mockFs.chmodSync).toHaveBeenCalledWith(serverFile, 0o600);
		});

		it('restricts an existing config directory when it is group or world accessible', () => {
			mockFs.statSync.mockReturnValue({ mode: 0o755 } as fs.Stats);

			writeCliServerInfo(sampleInfo);

			expect(mockFs.chmodSync).toHaveBeenCalledWith(configDir, 0o700);
		});
	});

	describe('readCliServerInfo', () => {
		it('returns null for a missing file', () => {
			mockFs.readFileSync.mockImplementation(() => {
				throw new Error('ENOENT: no such file or directory');
			});

			expect(readCliServerInfo()).toBeNull();
		});

		it('returns parsed data for a valid file', () => {
			mockFs.readFileSync.mockReturnValue(JSON.stringify(sampleInfo));

			expect(readCliServerInfo()).toEqual(sampleInfo);
			expect(mockFs.readFileSync).toHaveBeenCalledWith(serverFile, 'utf-8');
		});

		it('returns null for invalid discovery data', () => {
			mockFs.readFileSync.mockReturnValue(JSON.stringify({ port: 54321, token: '' }));

			expect(readCliServerInfo()).toBeNull();
		});

		it('returns null for non-integer or out-of-range discovery data', () => {
			mockFs.readFileSync.mockReturnValue(
				JSON.stringify({ ...sampleInfo, port: 70000, pid: 0, startedAt: 1.5 })
			);

			expect(readCliServerInfo()).toBeNull();
		});
	});

	describe('deleteCliServerInfo', () => {
		it('removes the discovery file when it exists', () => {
			deleteCliServerInfo();

			expect(mockFs.unlinkSync).toHaveBeenCalledWith(serverFile);
		});

		it('does not remove the discovery file when it is missing', () => {
			mockFs.existsSync.mockReturnValue(false);

			deleteCliServerInfo();

			expect(mockFs.unlinkSync).not.toHaveBeenCalled();
		});
	});

	describe('isCliServerRunning', () => {
		it('returns true for the current PID', () => {
			mockFs.readFileSync.mockReturnValue(JSON.stringify({ ...sampleInfo, pid: process.pid }));
			const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

			expect(isCliServerRunning()).toBe(true);
			expect(killSpy).toHaveBeenCalledWith(process.pid, 0);
			expect(mockFs.unlinkSync).not.toHaveBeenCalled();
		});

		it('returns false and removes stale discovery info for a non-existent PID', () => {
			const missingPid = 999999;
			mockFs.readFileSync.mockReturnValue(JSON.stringify({ ...sampleInfo, pid: missingPid }));
			const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
				throw new Error('ESRCH');
			});

			expect(isCliServerRunning()).toBe(false);
			expect(killSpy).toHaveBeenCalledWith(missingPid, 0);
			expect(mockFs.unlinkSync).toHaveBeenCalledWith(serverFile);
		});
	});
});
