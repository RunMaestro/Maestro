/**
 * Tests for WakaTimeManager.
 * Verifies CLI detection, heartbeat sending, debouncing, session cleanup,
 * and auto-installation of the WakaTime CLI.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WakaTimeManager } from '../../main/wakatime-manager';

// Mock electron
vi.mock('electron', () => ({
	app: {
		getVersion: vi.fn(() => '1.0.0'),
	},
}));

// Mock execFileNoThrow
vi.mock('../../main/utils/execFile', () => ({
	execFileNoThrow: vi.fn(),
}));

// Mock logger
vi.mock('../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

// Mock fs
vi.mock('fs', () => ({
	default: {
		existsSync: vi.fn(() => false),
		mkdirSync: vi.fn(),
		chmodSync: vi.fn(),
		createWriteStream: vi.fn(),
		unlinkSync: vi.fn(),
		unlink: vi.fn(),
	},
	existsSync: vi.fn(() => false),
	mkdirSync: vi.fn(),
	chmodSync: vi.fn(),
	createWriteStream: vi.fn(),
	unlinkSync: vi.fn(),
	unlink: vi.fn(),
}));

// Mock https
vi.mock('https', () => ({
	default: {
		get: vi.fn(),
	},
	get: vi.fn(),
}));

import { execFileNoThrow } from '../../main/utils/execFile';
import { logger } from '../../main/utils/logger';
import fs from 'fs';
import https from 'https';

describe('WakaTimeManager', () => {
	let mockStore: { get: ReturnType<typeof vi.fn> };
	let manager: WakaTimeManager;

	beforeEach(() => {
		vi.clearAllMocks();
		mockStore = {
			get: vi.fn(),
		};
		manager = new WakaTimeManager(mockStore as never);
	});

	describe('detectCli', () => {
		it('should detect wakatime-cli when available', async () => {
			vi.mocked(execFileNoThrow).mockResolvedValueOnce({
				exitCode: 0,
				stdout: 'wakatime-cli 1.73.1\n',
				stderr: '',
			});

			const result = await manager.detectCli();

			expect(result).toBe(true);
			expect(execFileNoThrow).toHaveBeenCalledWith('wakatime-cli', ['--version']);
			expect(logger.info).toHaveBeenCalledWith(
				expect.stringContaining('Found WakaTime CLI: wakatime-cli'),
				'[WakaTime]'
			);
		});

		it('should fall back to wakatime binary', async () => {
			vi.mocked(execFileNoThrow)
				.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'not found' })
				.mockResolvedValueOnce({ exitCode: 0, stdout: 'wakatime 1.73.1\n', stderr: '' });

			const result = await manager.detectCli();

			expect(result).toBe(true);
			expect(execFileNoThrow).toHaveBeenCalledTimes(2);
			expect(execFileNoThrow).toHaveBeenCalledWith('wakatime', ['--version']);
		});

		it('should check ~/.wakatime/ local install path when PATH lookups fail', async () => {
			// Both PATH lookups fail
			vi.mocked(execFileNoThrow)
				.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'not found' })
				.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'not found' });
			// Local path doesn't exist
			vi.mocked(fs.existsSync).mockReturnValue(false);

			const result = await manager.detectCli();

			expect(result).toBe(false);
			expect(logger.debug).toHaveBeenCalledWith(
				'WakaTime CLI not found on PATH or in ~/.wakatime/',
				'[WakaTime]'
			);
		});

		it('should find CLI in ~/.wakatime/ when PATH lookups fail', async () => {
			// Both PATH lookups fail
			vi.mocked(execFileNoThrow)
				.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'not found' })
				.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'not found' })
				// Local binary check succeeds
				.mockResolvedValueOnce({ exitCode: 0, stdout: 'wakatime-cli 1.73.1\n', stderr: '' });
			vi.mocked(fs.existsSync).mockReturnValue(true);

			const result = await manager.detectCli();

			expect(result).toBe(true);
			expect(execFileNoThrow).toHaveBeenCalledTimes(3);
			expect(logger.info).toHaveBeenCalledWith(
				expect.stringContaining('Found WakaTime CLI:'),
				'[WakaTime]'
			);
		});

		it('should return false when no CLI is found', async () => {
			vi.mocked(execFileNoThrow)
				.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'not found' })
				.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'not found' });
			vi.mocked(fs.existsSync).mockReturnValue(false);

			const result = await manager.detectCli();

			expect(result).toBe(false);
			expect(logger.debug).toHaveBeenCalledWith(
				'WakaTime CLI not found on PATH or in ~/.wakatime/',
				'[WakaTime]'
			);
		});

		it('should cache CLI detection result', async () => {
			vi.mocked(execFileNoThrow).mockResolvedValueOnce({
				exitCode: 0,
				stdout: 'wakatime-cli 1.73.1\n',
				stderr: '',
			});

			await manager.detectCli();
			const result = await manager.detectCli();

			expect(result).toBe(true);
			// Should only call execFileNoThrow once due to caching
			expect(execFileNoThrow).toHaveBeenCalledTimes(1);
		});

		it('should cache negative CLI detection result', async () => {
			vi.mocked(execFileNoThrow)
				.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' })
				.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' });
			vi.mocked(fs.existsSync).mockReturnValue(false);

			await manager.detectCli();
			const result = await manager.detectCli();

			expect(result).toBe(false);
			// Should only call execFileNoThrow twice (for two binary names) on first call, then cache
			expect(execFileNoThrow).toHaveBeenCalledTimes(2);
		});
	});

	describe('ensureCliInstalled', () => {
		it('should return true early if CLI is already detected', async () => {
			vi.mocked(execFileNoThrow).mockResolvedValueOnce({
				exitCode: 0,
				stdout: 'wakatime-cli 1.73.1\n',
				stderr: '',
			});

			const result = await manager.ensureCliInstalled();

			expect(result).toBe(true);
			// Only detectCli calls, no download
			expect(logger.info).toHaveBeenCalledWith(
				expect.stringContaining('Found WakaTime CLI'),
				'[WakaTime]'
			);
		});

		it('should attempt download when CLI is not found', async () => {
			// detectCli fails (PATH + local)
			vi.mocked(execFileNoThrow)
				.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' })
				.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' });
			vi.mocked(fs.existsSync).mockReturnValue(false);

			// Mock https.get to simulate a download error (to test graceful failure)
			vi.mocked(https.get).mockImplementation((_url: any, _cb: any) => {
				const req = {
					on: vi.fn((_event: string, cb: (err: Error) => void) => {
						// Simulate network error
						setTimeout(() => cb(new Error('Network error')), 0);
						return req;
					}),
				};
				return req as any;
			});

			const result = await manager.ensureCliInstalled();

			expect(result).toBe(false);
			expect(logger.info).toHaveBeenCalledWith(
				expect.stringContaining('Downloading WakaTime CLI'),
				'[WakaTime]'
			);
			expect(logger.warn).toHaveBeenCalledWith(
				expect.stringContaining('Failed to auto-install WakaTime CLI'),
				'[WakaTime]'
			);
		});

		it('should guard against concurrent installations', async () => {
			// detectCli fails
			vi.mocked(execFileNoThrow)
				.mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' });
			vi.mocked(fs.existsSync).mockReturnValue(false);

			// Mock download to fail (but slowly, to test concurrency)
			vi.mocked(https.get).mockImplementation((_url: any, _cb: any) => {
				const req = {
					on: vi.fn((_event: string, cb: (err: Error) => void) => {
						setTimeout(() => cb(new Error('Network error')), 10);
						return req;
					}),
				};
				return req as any;
			});

			// Call ensureCliInstalled twice concurrently
			const [result1, result2] = await Promise.all([
				manager.ensureCliInstalled(),
				manager.ensureCliInstalled(),
			]);

			// Both should return false (download failed)
			expect(result1).toBe(false);
			expect(result2).toBe(false);

			// https.get should only be called once (concurrent guard)
			expect(https.get).toHaveBeenCalledTimes(1);
		});
	});

	describe('sendHeartbeat', () => {
		beforeEach(() => {
			// Set up store to return enabled and API key
			mockStore.get.mockImplementation((key: string, defaultVal: unknown) => {
				if (key === 'wakatimeEnabled') return true;
				if (key === 'wakatimeApiKey') return 'test-api-key-123';
				return defaultVal;
			});
		});

		it('should skip when disabled', async () => {
			mockStore.get.mockImplementation((key: string, defaultVal: unknown) => {
				if (key === 'wakatimeEnabled') return false;
				return defaultVal;
			});

			await manager.sendHeartbeat('session-1', '/project', 'My Project');

			expect(execFileNoThrow).not.toHaveBeenCalled();
		});

		it('should skip when API key is empty', async () => {
			mockStore.get.mockImplementation((key: string, defaultVal: unknown) => {
				if (key === 'wakatimeEnabled') return true;
				if (key === 'wakatimeApiKey') return '';
				return defaultVal;
			});

			await manager.sendHeartbeat('session-1', '/project', 'My Project');

			expect(execFileNoThrow).not.toHaveBeenCalled();
		});

		it('should skip when CLI is not available and cannot be installed', async () => {
			vi.mocked(execFileNoThrow)
				.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' })
				.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' });
			vi.mocked(fs.existsSync).mockReturnValue(false);

			// Mock download failure
			vi.mocked(https.get).mockImplementation((_url: any, _cb: any) => {
				const req = {
					on: vi.fn((_event: string, cb: (err: Error) => void) => {
						setTimeout(() => cb(new Error('Network error')), 0);
						return req;
					}),
				};
				return req as any;
			});

			await manager.sendHeartbeat('session-1', '/project', 'My Project');

			expect(logger.warn).toHaveBeenCalledWith(
				'WakaTime CLI not available — skipping heartbeat',
				'[WakaTime]'
			);
		});

		it('should send heartbeat with correct arguments', async () => {
			// First call to detectCli
			vi.mocked(execFileNoThrow).mockResolvedValueOnce({
				exitCode: 0,
				stdout: 'wakatime-cli 1.73.1\n',
				stderr: '',
			});
			// Second call is the actual heartbeat
			vi.mocked(execFileNoThrow).mockResolvedValueOnce({
				exitCode: 0,
				stdout: '',
				stderr: '',
			});

			await manager.sendHeartbeat('session-1', '/project/path', 'My Project');

			expect(execFileNoThrow).toHaveBeenCalledWith('wakatime-cli', [
				'--key', 'test-api-key-123',
				'--entity', '/project/path',
				'--entity-type', 'app',
				'--project', 'My Project',
				'--plugin', 'maestro/1.0.0 maestro-wakatime/1.0.0',
				'--category', 'coding',
			]);
			expect(logger.debug).toHaveBeenCalledWith(
				expect.stringContaining('Heartbeat sent for session session-1'),
				'[WakaTime]'
			);
		});

		it('should log warning on heartbeat failure', async () => {
			vi.mocked(execFileNoThrow)
				.mockResolvedValueOnce({ exitCode: 0, stdout: 'wakatime-cli 1.73.1\n', stderr: '' })
				.mockResolvedValueOnce({ exitCode: 102, stdout: '', stderr: 'API key invalid' });

			await manager.sendHeartbeat('session-1', '/project', 'My Project');

			expect(logger.warn).toHaveBeenCalledWith(
				expect.stringContaining('Heartbeat failed for session-1'),
				'[WakaTime]'
			);
		});

		it('should debounce heartbeats per session (within 2 minutes)', async () => {
			vi.mocked(execFileNoThrow)
				.mockResolvedValueOnce({ exitCode: 0, stdout: 'wakatime-cli 1.73.1\n', stderr: '' })
				.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });

			await manager.sendHeartbeat('session-1', '/project', 'My Project');
			await manager.sendHeartbeat('session-1', '/project', 'My Project');

			// detectCli (1 call) + heartbeat (1 call) = 2 total, second heartbeat was debounced
			expect(execFileNoThrow).toHaveBeenCalledTimes(2);
		});

		it('should not debounce different sessions', async () => {
			vi.mocked(execFileNoThrow)
				.mockResolvedValueOnce({ exitCode: 0, stdout: 'wakatime-cli 1.73.1\n', stderr: '' })
				.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
				.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });

			await manager.sendHeartbeat('session-1', '/project1', 'Project 1');
			await manager.sendHeartbeat('session-2', '/project2', 'Project 2');

			// detectCli (1 call, cached) + heartbeat session-1 (1 call) + heartbeat session-2 (1 call) = 3
			expect(execFileNoThrow).toHaveBeenCalledTimes(3);
		});
	});

	describe('removeSession', () => {
		it('should remove session from debounce tracking', async () => {
			mockStore.get.mockImplementation((key: string, defaultVal: unknown) => {
				if (key === 'wakatimeEnabled') return true;
				if (key === 'wakatimeApiKey') return 'test-api-key-123';
				return defaultVal;
			});

			// Set up CLI detection
			vi.mocked(execFileNoThrow)
				.mockResolvedValueOnce({ exitCode: 0, stdout: 'wakatime-cli 1.73.1\n', stderr: '' })
				.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
				.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });

			// Send first heartbeat
			await manager.sendHeartbeat('session-1', '/project', 'My Project');
			// Remove session (resets debounce)
			manager.removeSession('session-1');
			// Send again — should NOT be debounced since session was removed
			await manager.sendHeartbeat('session-1', '/project', 'My Project');

			// detectCli (1, cached) + first heartbeat (1) + second heartbeat (1) = 3
			expect(execFileNoThrow).toHaveBeenCalledTimes(3);
		});
	});
});
