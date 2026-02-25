/**
 * Tests for WakaTimeManager.
 * Verifies CLI detection, heartbeat sending, debouncing, session cleanup,
 * and auto-installation of the WakaTime CLI.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WakaTimeManager, detectLanguageFromPath, WRITE_TOOL_NAMES, extractFilePathFromToolExecution } from '../../main/wakatime-manager';

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
		readFileSync: vi.fn(() => ''),
		mkdirSync: vi.fn(),
		chmodSync: vi.fn(),
		createWriteStream: vi.fn(),
		unlinkSync: vi.fn(),
		unlink: vi.fn(),
	},
	existsSync: vi.fn(() => false),
	readFileSync: vi.fn(() => ''),
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
			vi.mocked(execFileNoThrow).mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' });
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

			await manager.sendHeartbeat('session-1', 'My Project');

			expect(execFileNoThrow).not.toHaveBeenCalled();
		});

		it('should skip when API key is empty and no cfg file exists', async () => {
			mockStore.get.mockImplementation((key: string, defaultVal: unknown) => {
				if (key === 'wakatimeEnabled') return true;
				if (key === 'wakatimeApiKey') return '';
				return defaultVal;
			});
			vi.mocked(fs.existsSync).mockReturnValue(false);

			await manager.sendHeartbeat('session-1', 'My Project');

			expect(execFileNoThrow).not.toHaveBeenCalled();
		});

		it('should fall back to ~/.wakatime.cfg when settings API key is empty', async () => {
			mockStore.get.mockImplementation((key: string, defaultVal: unknown) => {
				if (key === 'wakatimeEnabled') return true;
				if (key === 'wakatimeApiKey') return '';
				return defaultVal;
			});

			// ~/.wakatime.cfg exists and contains an api_key
			vi.mocked(fs.existsSync).mockImplementation((p: any) => {
				return String(p).endsWith('.wakatime.cfg');
			});
			vi.mocked(fs.readFileSync).mockReturnValue('[settings]\napi_key = cfg-api-key-456\n');

			// CLI detection + heartbeat
			vi.mocked(execFileNoThrow)
				.mockResolvedValueOnce({ exitCode: 0, stdout: 'wakatime-cli 1.73.1\n', stderr: '' })
				.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });

			await manager.sendHeartbeat('session-1', 'My Project');

			expect(execFileNoThrow).toHaveBeenCalledWith('wakatime-cli', [
				'--key',
				'cfg-api-key-456',
				'--entity',
				'Maestro',
				'--entity-type',
				'app',
				'--project',
				'My Project',
				'--plugin',
				'maestro/1.0.0 maestro-wakatime/1.0.0',
				'--category',
				'building',
			]);
		});

		it('should prefer settings API key over ~/.wakatime.cfg', async () => {
			// Settings has an API key
			mockStore.get.mockImplementation((key: string, defaultVal: unknown) => {
				if (key === 'wakatimeEnabled') return true;
				if (key === 'wakatimeApiKey') return 'settings-key-789';
				return defaultVal;
			});

			// CLI detection + heartbeat
			vi.mocked(execFileNoThrow)
				.mockResolvedValueOnce({ exitCode: 0, stdout: 'wakatime-cli 1.73.1\n', stderr: '' })
				.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });

			await manager.sendHeartbeat('session-1', 'My Project');

			// Should use the settings key, not read from cfg
			expect(fs.readFileSync).not.toHaveBeenCalled();
			expect(execFileNoThrow).toHaveBeenCalledWith(
				'wakatime-cli',
				expect.arrayContaining(['--key', 'settings-key-789'])
			);
		});

		it('should handle malformed ~/.wakatime.cfg gracefully', async () => {
			mockStore.get.mockImplementation((key: string, defaultVal: unknown) => {
				if (key === 'wakatimeEnabled') return true;
				if (key === 'wakatimeApiKey') return '';
				return defaultVal;
			});

			vi.mocked(fs.existsSync).mockImplementation((p: any) => {
				return String(p).endsWith('.wakatime.cfg');
			});
			vi.mocked(fs.readFileSync).mockReturnValue('garbage content without api_key');

			await manager.sendHeartbeat('session-1', 'My Project');

			// No API key found in cfg either — should skip
			expect(execFileNoThrow).not.toHaveBeenCalled();
		});

		it('should handle read error on ~/.wakatime.cfg gracefully', async () => {
			mockStore.get.mockImplementation((key: string, defaultVal: unknown) => {
				if (key === 'wakatimeEnabled') return true;
				if (key === 'wakatimeApiKey') return '';
				return defaultVal;
			});

			vi.mocked(fs.existsSync).mockImplementation((p: any) => {
				return String(p).endsWith('.wakatime.cfg');
			});
			vi.mocked(fs.readFileSync).mockImplementation(() => {
				throw new Error('Permission denied');
			});

			await manager.sendHeartbeat('session-1', 'My Project');

			// Read error — should skip gracefully
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

			await manager.sendHeartbeat('session-1', 'My Project');

			expect(logger.warn).toHaveBeenCalledWith(
				'WakaTime CLI not available — skipping heartbeat',
				'[WakaTime]'
			);
		});

		it('should send heartbeat with building category by default', async () => {
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

			await manager.sendHeartbeat('session-1', 'My Project');

			expect(execFileNoThrow).toHaveBeenCalledWith('wakatime-cli', [
				'--key',
				'test-api-key-123',
				'--entity',
				'Maestro',
				'--entity-type',
				'app',
				'--project',
				'My Project',
				'--plugin',
				'maestro/1.0.0 maestro-wakatime/1.0.0',
				'--category',
				'building',
			]);
			expect(logger.debug).toHaveBeenCalledWith(
				expect.stringContaining('Heartbeat sent for session session-1'),
				'[WakaTime]'
			);
		});

		it('should send ai coding category for auto source', async () => {
			vi.mocked(execFileNoThrow)
				.mockResolvedValueOnce({ exitCode: 0, stdout: 'wakatime-cli 1.73.1\n', stderr: '' })
				.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });

			await manager.sendHeartbeat('session-1', 'My Project', undefined, 'auto');

			expect(execFileNoThrow).toHaveBeenCalledWith('wakatime-cli',
				expect.arrayContaining(['--category', 'ai coding'])
			);
		});

		it('should send building category for user source', async () => {
			vi.mocked(execFileNoThrow)
				.mockResolvedValueOnce({ exitCode: 0, stdout: 'wakatime-cli 1.73.1\n', stderr: '' })
				.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });

			await manager.sendHeartbeat('session-1', 'My Project', undefined, 'user');

			expect(execFileNoThrow).toHaveBeenCalledWith('wakatime-cli',
				expect.arrayContaining(['--category', 'building'])
			);
		});

		it('should log warning on heartbeat failure', async () => {
			vi.mocked(execFileNoThrow)
				.mockResolvedValueOnce({ exitCode: 0, stdout: 'wakatime-cli 1.73.1\n', stderr: '' })
				.mockResolvedValueOnce({ exitCode: 102, stdout: '', stderr: 'API key invalid' });

			await manager.sendHeartbeat('session-1', 'My Project');

			expect(logger.warn).toHaveBeenCalledWith(
				expect.stringContaining('Heartbeat failed for session-1'),
				'[WakaTime]'
			);
		});

		it('should debounce heartbeats per session (within 2 minutes)', async () => {
			vi.mocked(execFileNoThrow)
				.mockResolvedValueOnce({ exitCode: 0, stdout: 'wakatime-cli 1.73.1\n', stderr: '' })
				.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });

			await manager.sendHeartbeat('session-1', 'My Project');
			await manager.sendHeartbeat('session-1', 'My Project');

			// detectCli (1 call) + heartbeat (1 call) = 2 total, second heartbeat was debounced
			expect(execFileNoThrow).toHaveBeenCalledTimes(2);
		});

		it('should not debounce different sessions', async () => {
			vi.mocked(execFileNoThrow)
				.mockResolvedValueOnce({ exitCode: 0, stdout: 'wakatime-cli 1.73.1\n', stderr: '' })
				.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
				.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });

			await manager.sendHeartbeat('session-1', 'Project 1');
			await manager.sendHeartbeat('session-2', 'Project 2');

			// detectCli (1 call, cached) + heartbeat session-1 (1 call) + heartbeat session-2 (1 call) = 3
			expect(execFileNoThrow).toHaveBeenCalledTimes(3);
		});
	});

	describe('checkForUpdate (via ensureCliInstalled)', () => {
		/** Helper: mock https.get to return a JSON response for fetchJson */
		function mockGithubApiResponse(body: object) {
			vi.mocked(https.get).mockImplementation((_opts: any, cb: any) => {
				const json = JSON.stringify(body);
				const response = {
					statusCode: 200,
					headers: {},
					on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
						if (event === 'data') handler(Buffer.from(json));
						if (event === 'end') handler();
						return response;
					}),
					resume: vi.fn(),
				};
				cb(response);
				const req = { on: vi.fn().mockReturnThis() };
				return req as any;
			});
		}

		/** Helper: mock https.get to simulate a network error */
		function mockGithubApiError() {
			vi.mocked(https.get).mockImplementation((_opts: any, _cb: any) => {
				const req = {
					on: vi.fn((_event: string, cb: (err: Error) => void) => {
						setTimeout(() => cb(new Error('Network error')), 0);
						return req;
					}),
				};
				return req as any;
			});
		}

		it('should trigger update check on first ensureCliInstalled when CLI is detected', async () => {
			// CLI detected on PATH
			vi.mocked(execFileNoThrow)
				.mockResolvedValueOnce({ exitCode: 0, stdout: 'wakatime-cli 1.73.1\n', stderr: '' }) // detectCli
				.mockResolvedValueOnce({ exitCode: 0, stdout: 'wakatime-cli 1.73.1\n', stderr: '' }); // --version in checkForUpdate

			// GitHub returns the same version
			mockGithubApiResponse({ tag_name: 'v1.73.1' });

			const result = await manager.ensureCliInstalled();

			expect(result).toBe(true);

			// Wait for the fire-and-forget checkForUpdate to complete
			await vi.waitFor(() => {
				expect(logger.debug).toHaveBeenCalledWith(
					expect.stringContaining('WakaTime CLI is up to date'),
					'[WakaTime]'
				);
			});
		});

		it('should not trigger update check again within 24 hours', async () => {
			// CLI detected on PATH
			vi.mocked(execFileNoThrow)
				.mockResolvedValueOnce({ exitCode: 0, stdout: 'wakatime-cli 1.73.1\n', stderr: '' }) // detectCli
				.mockResolvedValueOnce({ exitCode: 0, stdout: 'wakatime-cli 1.73.1\n', stderr: '' }); // --version in checkForUpdate

			mockGithubApiResponse({ tag_name: 'v1.73.1' });

			// First call: triggers update check
			await manager.ensureCliInstalled();

			// Wait for fire-and-forget to complete
			await vi.waitFor(() => {
				expect(https.get).toHaveBeenCalledTimes(1);
			});

			vi.mocked(https.get).mockClear();

			// Second call: should NOT trigger another update check (within 24h interval)
			await manager.ensureCliInstalled();

			// Allow any pending microtasks
			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(https.get).not.toHaveBeenCalled();
		});

		it('should re-install CLI when version differs from latest', async () => {
			// CLI detected on PATH
			vi.mocked(execFileNoThrow)
				.mockResolvedValueOnce({ exitCode: 0, stdout: 'wakatime-cli 1.72.0\n', stderr: '' }) // detectCli
				.mockResolvedValueOnce({ exitCode: 0, stdout: 'wakatime-cli 1.72.0\n', stderr: '' }); // --version in checkForUpdate

			// GitHub returns a newer version
			mockGithubApiResponse({ tag_name: 'v1.73.1' });

			// Mock the download that doInstall will trigger (network error is fine, we just check it tries)
			// https.get is already mocked for the API call — doInstall calls downloadFile which also uses https.get
			// Since the mock returns JSON for all calls, the download will fail, which is expected

			await manager.ensureCliInstalled();

			// Wait for the fire-and-forget checkForUpdate to trigger re-install
			await vi.waitFor(() => {
				expect(logger.info).toHaveBeenCalledWith(
					expect.stringContaining('WakaTime CLI update available: 1.72.0'),
					'[WakaTime]'
				);
			});
		});

		it('should handle GitHub API failure gracefully', async () => {
			// CLI detected on PATH
			vi.mocked(execFileNoThrow).mockResolvedValueOnce({
				exitCode: 0,
				stdout: 'wakatime-cli 1.73.1\n',
				stderr: '',
			});

			mockGithubApiError();

			const result = await manager.ensureCliInstalled();
			expect(result).toBe(true);

			// Wait for the fire-and-forget checkForUpdate to complete with error
			await vi.waitFor(() => {
				expect(logger.debug).toHaveBeenCalledWith(
					expect.stringContaining('WakaTime CLI update check failed'),
					'[WakaTime]'
				);
			});
		});

		it('should handle missing tag_name in GitHub response gracefully', async () => {
			// CLI detected on PATH
			vi.mocked(execFileNoThrow).mockResolvedValueOnce({
				exitCode: 0,
				stdout: 'wakatime-cli 1.73.1\n',
				stderr: '',
			});

			// GitHub returns an unexpected format (no tag_name)
			mockGithubApiResponse({ name: 'Latest Release' });

			await manager.ensureCliInstalled();

			await vi.waitFor(() => {
				expect(logger.debug).toHaveBeenCalledWith(
					expect.stringContaining('Could not determine latest WakaTime CLI version'),
					'[WakaTime]'
				);
			});
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
			await manager.sendHeartbeat('session-1', 'My Project');
			// Remove session (resets debounce)
			manager.removeSession('session-1');
			// Send again — should NOT be debounced since session was removed
			await manager.sendHeartbeat('session-1', 'My Project');

			// detectCli (1, cached) + first heartbeat (1) + second heartbeat (1) = 3
			expect(execFileNoThrow).toHaveBeenCalledTimes(3);
		});
	});

	describe('WRITE_TOOL_NAMES', () => {
		it('should contain all expected write tool names', () => {
			const expected = [
				'Write', 'Edit', 'write_to_file', 'str_replace_based_edit_tool',
				'create_file', 'write', 'patch', 'NotebookEdit',
			];
			for (const name of expected) {
				expect(WRITE_TOOL_NAMES.has(name)).toBe(true);
			}
			expect(WRITE_TOOL_NAMES.size).toBe(expected.length);
		});

		it('should not contain non-write tool names', () => {
			expect(WRITE_TOOL_NAMES.has('Read')).toBe(false);
			expect(WRITE_TOOL_NAMES.has('search')).toBe(false);
			expect(WRITE_TOOL_NAMES.has('Bash')).toBe(false);
		});
	});

	describe('extractFilePathFromToolExecution', () => {
		it('should extract file_path from a Write tool execution', () => {
			const result = extractFilePathFromToolExecution({
				toolName: 'Write',
				state: { input: { file_path: '/project/src/index.ts' } },
				timestamp: Date.now(),
			});
			expect(result).toBe('/project/src/index.ts');
		});

		it('should extract path from a Codex write_to_file tool execution', () => {
			const result = extractFilePathFromToolExecution({
				toolName: 'write_to_file',
				state: { input: { path: '/project/src/main.py' } },
				timestamp: Date.now(),
			});
			expect(result).toBe('/project/src/main.py');
		});

		it('should prefer file_path over path when both are present', () => {
			const result = extractFilePathFromToolExecution({
				toolName: 'Edit',
				state: { input: { file_path: '/preferred.ts', path: '/fallback.ts' } },
				timestamp: Date.now(),
			});
			expect(result).toBe('/preferred.ts');
		});

		it('should return null for non-write tool names', () => {
			const result = extractFilePathFromToolExecution({
				toolName: 'Read',
				state: { input: { file_path: '/project/src/index.ts' } },
				timestamp: Date.now(),
			});
			expect(result).toBeNull();
		});

		it('should return null when state has no input', () => {
			const result = extractFilePathFromToolExecution({
				toolName: 'Write',
				state: { status: 'completed' },
				timestamp: Date.now(),
			});
			expect(result).toBeNull();
		});

		it('should return null when state is null', () => {
			const result = extractFilePathFromToolExecution({
				toolName: 'Write',
				state: null,
				timestamp: Date.now(),
			});
			expect(result).toBeNull();
		});

		it('should return null when input has no file path fields', () => {
			const result = extractFilePathFromToolExecution({
				toolName: 'Edit',
				state: { input: { content: 'some code' } },
				timestamp: Date.now(),
			});
			expect(result).toBeNull();
		});

		it('should return null when file_path is empty string', () => {
			const result = extractFilePathFromToolExecution({
				toolName: 'Write',
				state: { input: { file_path: '' } },
				timestamp: Date.now(),
			});
			expect(result).toBeNull();
		});

		it('should return null when path value is not a string', () => {
			const result = extractFilePathFromToolExecution({
				toolName: 'Write',
				state: { input: { file_path: 123 } },
				timestamp: Date.now(),
			});
			expect(result).toBeNull();
		});

		it('should work for all write tool names', () => {
			for (const toolName of WRITE_TOOL_NAMES) {
				const result = extractFilePathFromToolExecution({
					toolName,
					state: { input: { file_path: `/project/${toolName}.ts` } },
					timestamp: Date.now(),
				});
				expect(result).toBe(`/project/${toolName}.ts`);
			}
		});

		it('should handle input being a non-object value', () => {
			const result = extractFilePathFromToolExecution({
				toolName: 'Write',
				state: { input: 'not an object' },
				timestamp: Date.now(),
			});
			expect(result).toBeNull();
		});
	});

	describe('detectLanguageFromPath', () => {
		it('should detect TypeScript from .ts extension', () => {
			expect(detectLanguageFromPath('/project/src/index.ts')).toBe('TypeScript');
		});

		it('should detect TypeScript from .tsx extension', () => {
			expect(detectLanguageFromPath('/project/src/App.tsx')).toBe('TypeScript');
		});

		it('should detect JavaScript from .js extension', () => {
			expect(detectLanguageFromPath('/project/src/index.js')).toBe('JavaScript');
		});

		it('should detect JavaScript from .mjs extension', () => {
			expect(detectLanguageFromPath('/project/src/config.mjs')).toBe('JavaScript');
		});

		it('should detect JavaScript from .cjs extension', () => {
			expect(detectLanguageFromPath('/project/src/config.cjs')).toBe('JavaScript');
		});

		it('should detect Python from .py extension', () => {
			expect(detectLanguageFromPath('/project/main.py')).toBe('Python');
		});

		it('should detect Rust from .rs extension', () => {
			expect(detectLanguageFromPath('/project/src/main.rs')).toBe('Rust');
		});

		it('should detect Go from .go extension', () => {
			expect(detectLanguageFromPath('/project/main.go')).toBe('Go');
		});

		it('should detect C++ from .cpp extension', () => {
			expect(detectLanguageFromPath('/project/src/main.cpp')).toBe('C++');
		});

		it('should detect C from .h extension', () => {
			expect(detectLanguageFromPath('/project/include/header.h')).toBe('C');
		});

		it('should detect Shell Script from .sh extension', () => {
			expect(detectLanguageFromPath('/project/scripts/build.sh')).toBe('Shell Script');
		});

		it('should detect Markdown from .md extension', () => {
			expect(detectLanguageFromPath('/project/README.md')).toBe('Markdown');
		});

		it('should detect JSON from .json extension', () => {
			expect(detectLanguageFromPath('/project/package.json')).toBe('JSON');
		});

		it('should detect YAML from .yml extension', () => {
			expect(detectLanguageFromPath('/project/.github/workflows/ci.yml')).toBe('YAML');
		});

		it('should detect HCL from .tf extension', () => {
			expect(detectLanguageFromPath('/infra/main.tf')).toBe('HCL');
		});

		it('should detect Protocol Buffer from .proto extension', () => {
			expect(detectLanguageFromPath('/proto/service.proto')).toBe('Protocol Buffer');
		});

		it('should return undefined for unknown extensions', () => {
			expect(detectLanguageFromPath('/project/data.xyz')).toBeUndefined();
		});

		it('should return undefined for files without extension', () => {
			expect(detectLanguageFromPath('/project/Makefile')).toBeUndefined();
		});

		it('should handle case-insensitive extensions', () => {
			expect(detectLanguageFromPath('/project/main.PY')).toBe('Python');
			expect(detectLanguageFromPath('/project/app.TSX')).toBe('TypeScript');
		});

		it('should handle paths with multiple dots', () => {
			expect(detectLanguageFromPath('/project/config.test.ts')).toBe('TypeScript');
			expect(detectLanguageFromPath('/project/styles.module.css')).toBe('CSS');
		});
	});

	describe('sendFileHeartbeats', () => {
		beforeEach(() => {
			mockStore.get.mockImplementation((key: string, defaultVal: unknown) => {
				if (key === 'wakatimeEnabled') return true;
				if (key === 'wakatimeApiKey') return 'test-api-key-123';
				if (key === 'wakatimeDetailedTracking') return true;
				return defaultVal;
			});
			// CLI detected on PATH
			vi.mocked(execFileNoThrow).mockResolvedValueOnce({
				exitCode: 0,
				stdout: 'wakatime-cli 1.73.1\n',
				stderr: '',
			});
		});

		it('should early return when files array is empty', async () => {
			await manager.sendFileHeartbeats([], 'My Project');
			// Only the detectCli mock is set up; no calls should have been made
			expect(execFileNoThrow).not.toHaveBeenCalled();
		});

		it('should skip when wakatimeEnabled is false', async () => {
			mockStore.get.mockImplementation((key: string, defaultVal: unknown) => {
				if (key === 'wakatimeEnabled') return false;
				return defaultVal;
			});

			await manager.sendFileHeartbeats(
				[{ filePath: '/project/src/index.ts', timestamp: 1708700000000 }],
				'My Project'
			);

			expect(execFileNoThrow).not.toHaveBeenCalled();
		});

		it('should skip when wakatimeDetailedTracking is false', async () => {
			mockStore.get.mockImplementation((key: string, defaultVal: unknown) => {
				if (key === 'wakatimeEnabled') return true;
				if (key === 'wakatimeApiKey') return 'test-api-key-123';
				if (key === 'wakatimeDetailedTracking') return false;
				return defaultVal;
			});

			await manager.sendFileHeartbeats(
				[{ filePath: '/project/src/index.ts', timestamp: 1708700000000 }],
				'My Project'
			);

			expect(execFileNoThrow).not.toHaveBeenCalled();
		});

		it('should skip when no API key is available', async () => {
			mockStore.get.mockImplementation((key: string, defaultVal: unknown) => {
				if (key === 'wakatimeEnabled') return true;
				if (key === 'wakatimeApiKey') return '';
				if (key === 'wakatimeDetailedTracking') return true;
				return defaultVal;
			});
			vi.mocked(fs.existsSync).mockReturnValue(false);

			await manager.sendFileHeartbeats(
				[{ filePath: '/project/src/index.ts', timestamp: 1708700000000 }],
				'My Project'
			);

			// No heartbeat call should have been made (only the pre-set detectCli mock exists)
			expect(execFileNoThrow).not.toHaveBeenCalled();
		});

		it('should send a single file heartbeat with building category by default', async () => {
			// The heartbeat exec call
			vi.mocked(execFileNoThrow).mockResolvedValueOnce({
				exitCode: 0,
				stdout: '',
				stderr: '',
			});

			await manager.sendFileHeartbeats(
				[{ filePath: '/project/src/index.ts', timestamp: 1708700000000 }],
				'My Project'
			);

			// Second call (after detectCli) is the heartbeat
			const calls = vi.mocked(execFileNoThrow).mock.calls;
			const heartbeatCall = calls[calls.length - 1];
			expect(heartbeatCall[1]).toEqual([
				'--key', 'test-api-key-123',
				'--entity', '/project/src/index.ts',
				'--entity-type', 'file',
				'--write',
				'--project', 'My Project',
				'--plugin', 'maestro/1.0.0 maestro-wakatime/1.0.0',
				'--category', 'building',
				'--time', String(1708700000000 / 1000),
				'--language', 'TypeScript',
			]);
			// No --extra-heartbeats for single file
			expect(heartbeatCall[1]).not.toContain('--extra-heartbeats');
			// No stdin input for single file
			expect(heartbeatCall[3]).toBeUndefined();
		});

		it('should send ai coding category for file heartbeats with auto source', async () => {
			vi.mocked(execFileNoThrow).mockResolvedValueOnce({
				exitCode: 0,
				stdout: '',
				stderr: '',
			});

			await manager.sendFileHeartbeats(
				[{ filePath: '/project/src/index.ts', timestamp: 1708700000000 }],
				'My Project',
				undefined,
				'auto'
			);

			const calls = vi.mocked(execFileNoThrow).mock.calls;
			const heartbeatCall = calls[calls.length - 1];
			const args = heartbeatCall[1] as string[];
			expect(args[args.indexOf('--category') + 1]).toBe('ai coding');
		});

		it('should send building category for file heartbeats with user source', async () => {
			vi.mocked(execFileNoThrow).mockResolvedValueOnce({
				exitCode: 0,
				stdout: '',
				stderr: '',
			});

			await manager.sendFileHeartbeats(
				[{ filePath: '/project/src/index.ts', timestamp: 1708700000000 }],
				'My Project',
				undefined,
				'user'
			);

			const calls = vi.mocked(execFileNoThrow).mock.calls;
			const heartbeatCall = calls[calls.length - 1];
			const args = heartbeatCall[1] as string[];
			expect(args[args.indexOf('--category') + 1]).toBe('building');
		});

		it('should send multiple files with --extra-heartbeats via stdin', async () => {
			// The heartbeat exec call
			vi.mocked(execFileNoThrow).mockResolvedValueOnce({
				exitCode: 0,
				stdout: '',
				stderr: '',
			});

			const files = [
				{ filePath: '/project/src/index.ts', timestamp: 1708700000000 },
				{ filePath: '/project/src/utils.py', timestamp: 1708700001000 },
				{ filePath: '/project/src/main.go', timestamp: 1708700002000 },
			];

			await manager.sendFileHeartbeats(files, 'My Project');

			const calls = vi.mocked(execFileNoThrow).mock.calls;
			const heartbeatCall = calls[calls.length - 1];
			const args = heartbeatCall[1] as string[];

			// Primary file is index.ts
			expect(args).toContain('--entity');
			expect(args[args.indexOf('--entity') + 1]).toBe('/project/src/index.ts');
			expect(args).toContain('--extra-heartbeats');
			expect(args).toContain('--language');
			expect(args[args.indexOf('--language') + 1]).toBe('TypeScript');

			// stdin should contain extra heartbeats JSON
			const stdinOpts = heartbeatCall[3] as { input: string };
			expect(stdinOpts).toBeDefined();
			const extraArray = JSON.parse(stdinOpts.input);
			expect(extraArray).toHaveLength(2);
			expect(extraArray[0].entity).toBe('/project/src/utils.py');
			expect(extraArray[0].language).toBe('Python');
			expect(extraArray[0].type).toBe('file');
			expect(extraArray[0].is_write).toBe(true);
			expect(extraArray[0].category).toBe('building');
			expect(extraArray[0].project).toBe('My Project');
			expect(extraArray[0].time).toBe(1708700001000 / 1000);
			expect(extraArray[1].entity).toBe('/project/src/main.go');
			expect(extraArray[1].language).toBe('Go');
		});

		it('should use ai coding category in extra heartbeats for auto source', async () => {
			vi.mocked(execFileNoThrow).mockResolvedValueOnce({
				exitCode: 0,
				stdout: '',
				stderr: '',
			});

			const files = [
				{ filePath: '/project/src/index.ts', timestamp: 1708700000000 },
				{ filePath: '/project/src/utils.py', timestamp: 1708700001000 },
			];

			await manager.sendFileHeartbeats(files, 'My Project', undefined, 'auto');

			const calls = vi.mocked(execFileNoThrow).mock.calls;
			const heartbeatCall = calls[calls.length - 1];
			const args = heartbeatCall[1] as string[];
			expect(args[args.indexOf('--category') + 1]).toBe('ai coding');

			const stdinOpts = heartbeatCall[3] as { input: string };
			const extraArray = JSON.parse(stdinOpts.input);
			expect(extraArray[0].category).toBe('ai coding');
		});

		it('should include branch info when projectCwd is provided', async () => {
			// Use mockImplementation to avoid mock ordering issues with fire-and-forget checkForUpdate
			vi.mocked(execFileNoThrow).mockReset().mockImplementation(async (cmd: any, args: any) => {
				if (args?.[0] === '--version') {
					return { exitCode: 0, stdout: 'wakatime-cli 1.73.1\n', stderr: '' };
				}
				if (cmd === 'git') {
					return { exitCode: 0, stdout: 'feat/my-branch\n', stderr: '' };
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			});

			await manager.sendFileHeartbeats(
				[{ filePath: '/project/src/index.ts', timestamp: 1708700000000 }],
				'My Project',
				'/project'
			);

			const calls = vi.mocked(execFileNoThrow).mock.calls;
			const heartbeatCall = calls[calls.length - 1];
			const args = heartbeatCall[1] as string[];
			expect(args).toContain('--alternate-branch');
			expect(args[args.indexOf('--alternate-branch') + 1]).toBe('feat/my-branch');
		});

		it('should include branch in extra heartbeats when available', async () => {
			// Use mockImplementation to avoid mock ordering issues with fire-and-forget checkForUpdate
			vi.mocked(execFileNoThrow).mockReset().mockImplementation(async (cmd: any, args: any) => {
				if (args?.[0] === '--version') {
					return { exitCode: 0, stdout: 'wakatime-cli 1.73.1\n', stderr: '' };
				}
				if (cmd === 'git') {
					return { exitCode: 0, stdout: 'main\n', stderr: '' };
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			});

			const files = [
				{ filePath: '/project/src/index.ts', timestamp: 1708700000000 },
				{ filePath: '/project/src/utils.ts', timestamp: 1708700001000 },
			];

			await manager.sendFileHeartbeats(files, 'My Project', '/project');

			const calls = vi.mocked(execFileNoThrow).mock.calls;
			const heartbeatCall = calls[calls.length - 1];
			const stdinOpts = heartbeatCall[3] as { input: string };
			const extraArray = JSON.parse(stdinOpts.input);
			expect(extraArray[0].branch).toBe('main');
		});

		it('should omit language for files with unknown extensions', async () => {
			// The heartbeat exec call
			vi.mocked(execFileNoThrow).mockResolvedValueOnce({
				exitCode: 0,
				stdout: '',
				stderr: '',
			});

			await manager.sendFileHeartbeats(
				[{ filePath: '/project/data.xyz', timestamp: 1708700000000 }],
				'My Project'
			);

			const calls = vi.mocked(execFileNoThrow).mock.calls;
			const heartbeatCall = calls[calls.length - 1];
			const args = heartbeatCall[1] as string[];
			expect(args).not.toContain('--language');
		});

		it('should log success with file count', async () => {
			// The heartbeat exec call
			vi.mocked(execFileNoThrow).mockResolvedValueOnce({
				exitCode: 0,
				stdout: '',
				stderr: '',
			});

			await manager.sendFileHeartbeats(
				[
					{ filePath: '/project/src/a.ts', timestamp: 1708700000000 },
					{ filePath: '/project/src/b.ts', timestamp: 1708700001000 },
				],
				'My Project'
			);

			expect(logger.info).toHaveBeenCalledWith(
				'Sent file heartbeats',
				'[WakaTime]',
				{ count: 2 }
			);
		});

		it('should convert timestamps to seconds for WakaTime CLI', async () => {
			// The heartbeat exec call
			vi.mocked(execFileNoThrow).mockResolvedValueOnce({
				exitCode: 0,
				stdout: '',
				stderr: '',
			});

			const timestamp = 1708700000000; // milliseconds
			await manager.sendFileHeartbeats(
				[{ filePath: '/project/src/index.ts', timestamp }],
				'My Project'
			);

			const calls = vi.mocked(execFileNoThrow).mock.calls;
			const heartbeatCall = calls[calls.length - 1];
			const args = heartbeatCall[1] as string[];
			const timeIndex = args.indexOf('--time');
			expect(args[timeIndex + 1]).toBe(String(timestamp / 1000));
		});

		it('should fall back to ~/.wakatime.cfg for API key', async () => {
			mockStore.get.mockImplementation((key: string, defaultVal: unknown) => {
				if (key === 'wakatimeEnabled') return true;
				if (key === 'wakatimeApiKey') return '';
				if (key === 'wakatimeDetailedTracking') return true;
				return defaultVal;
			});

			vi.mocked(fs.existsSync).mockImplementation((p: any) => {
				return String(p).endsWith('.wakatime.cfg');
			});
			vi.mocked(fs.readFileSync).mockReturnValue('[settings]\napi_key = cfg-key-456\n');

			// The heartbeat exec call
			vi.mocked(execFileNoThrow).mockResolvedValueOnce({
				exitCode: 0,
				stdout: '',
				stderr: '',
			});

			await manager.sendFileHeartbeats(
				[{ filePath: '/project/src/index.ts', timestamp: 1708700000000 }],
				'My Project'
			);

			const calls = vi.mocked(execFileNoThrow).mock.calls;
			const heartbeatCall = calls[calls.length - 1];
			const args = heartbeatCall[1] as string[];
			expect(args).toContain('cfg-key-456');
		});
	});
});
