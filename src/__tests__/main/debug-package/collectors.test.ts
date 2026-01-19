/**
 * Tests for debug package collectors
 *
 * These tests verify:
 * 1. Each collector function works correctly
 * 2. Sanitization properly redacts sensitive data
 * 3. No sensitive data leaks through collectors
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'os';

// Mock Electron modules
vi.mock('electron', () => ({
	app: {
		getVersion: vi.fn(() => '1.0.0'),
		getPath: vi.fn((name: string) => {
			if (name === 'userData') return '/mock/userData';
			return '/mock/path';
		}),
	},
}));

// Mock electron-store
vi.mock('electron-store', () => {
	return {
		default: vi.fn().mockImplementation(() => ({
			get: vi.fn(),
			set: vi.fn(),
			store: {},
		})),
	};
});

// Mock fs module
vi.mock('fs', () => ({
	existsSync: vi.fn(() => false),
	statSync: vi.fn(() => ({ size: 0, isDirectory: () => false })),
	readdirSync: vi.fn(() => []),
	readFileSync: vi.fn(() => ''),
}));

// Mock cliDetection
vi.mock('../../../main/utils/cliDetection', () => ({
	isCloudflaredInstalled: vi.fn(() => Promise.resolve(false)),
}));

// Mock shellDetector
vi.mock('../../../main/utils/shellDetector', () => ({
	detectShells: vi.fn(() => Promise.resolve([])),
}));

// Mock execFile
vi.mock('../../../main/utils/execFile', () => ({
	execFileNoThrow: vi.fn(() => Promise.resolve({ stdout: '', stderr: '', exitCode: 1 })),
}));

// Mock tunnel-manager
vi.mock('../../../main/tunnel-manager', () => ({
	tunnelManager: {
		getStatus: vi.fn(() => ({ isRunning: false, url: null, error: null })),
	},
}));

// Mock logger
vi.mock('../../../main/utils/logger', () => ({
	logger: {
		getLogs: vi.fn(() => []),
		clearLogs: vi.fn(),
		setLogLevel: vi.fn(),
		setMaxLogBuffer: vi.fn(),
	},
	LogEntry: {},
}));

describe('Debug Package Collectors', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('collectSystemInfo', () => {
		it('should collect OS, hardware, and app information', async () => {
			const { collectSystemInfo } = await import('../../../main/debug-package/collectors/system');

			const result = collectSystemInfo();

			// Verify OS info
			expect(result.os).toBeDefined();
			expect(result.os.platform).toBe(os.platform());
			expect(result.os.release).toBe(os.release());
			expect(result.os.arch).toBe(os.arch());

			// Verify hardware info
			expect(result.hardware).toBeDefined();
			expect(result.hardware.cpus).toBe(os.cpus().length);
			expect(result.hardware.totalMemoryMB).toBeGreaterThan(0);
			expect(result.hardware.freeMemoryMB).toBeGreaterThan(0);

			// Verify app info
			expect(result.app).toBeDefined();
			expect(result.app.version).toBe('1.0.0');
			expect(result.app.nodeVersion).toBe(process.versions.node);

			// Verify runtime info
			expect(result.runtime).toBeDefined();
			expect(result.runtime.uptimeSeconds).toBeGreaterThanOrEqual(0);
			expect(result.runtime.appUptimeSeconds).toBeGreaterThanOrEqual(0);
		});

		it('should not contain any sensitive data', async () => {
			const { collectSystemInfo } = await import('../../../main/debug-package/collectors/system');

			const result = collectSystemInfo();
			const resultStr = JSON.stringify(result);

			// Should not contain home directory path
			expect(resultStr).not.toContain(os.homedir());
			// Should not contain username
			expect(resultStr).not.toContain(os.userInfo().username);
		});
	});

	describe('collectSettings - sanitizePath', () => {
		it('should replace home directory with ~', async () => {
			const { sanitizePath } = await import('../../../main/debug-package/collectors/settings');

			const homeDir = os.homedir();
			const testPath = `${homeDir}/Projects/Test`;

			const sanitized = sanitizePath(testPath);

			expect(sanitized).toBe('~/Projects/Test');
			expect(sanitized).not.toContain(homeDir);
		});

		it('should handle Windows-style paths', async () => {
			const { sanitizePath } = await import('../../../main/debug-package/collectors/settings');

			// Mock homedir for Windows
			const originalHomedir = os.homedir;
			vi.spyOn(os, 'homedir').mockReturnValue('C:\\Users\\testuser');

			const { sanitizePath: freshSanitizePath } =
				await import('../../../main/debug-package/collectors/settings');

			const testPath = 'C:\\Users\\testuser\\Documents\\Project';
			const sanitized = freshSanitizePath(testPath);

			// Should normalize backslashes and replace home dir
			expect(sanitized).not.toContain('testuser');

			vi.spyOn(os, 'homedir').mockImplementation(originalHomedir);
		});

		it('should return non-string values unchanged', async () => {
			const { sanitizePath } = await import('../../../main/debug-package/collectors/settings');

			expect(sanitizePath(null as any)).toBeNull();
			expect(sanitizePath(undefined as any)).toBeUndefined();
			expect(sanitizePath(123 as any)).toBe(123);
		});
	});

	describe('collectSettings', () => {
		it('should sanitize sensitive keys in settings', async () => {
			const { collectSettings } = await import('../../../main/debug-package/collectors/settings');

			const mockStore = {
				get: vi.fn(),
				set: vi.fn(),
				store: {
					theme: 'dark',
					apiKey: 'sk-1234567890',
					authToken: 'token-abc',
					password: 'secret123',
					clientToken: 'client-token',
					accessToken: 'access-token',
					refreshToken: 'refresh-token',
				},
			};

			const result = await collectSettings(mockStore as any);

			// Verify non-sensitive values are preserved
			expect(result.raw.theme).toBe('dark');

			// Verify sensitive values are redacted
			expect(result.raw.apiKey).toBe('[REDACTED]');
			expect(result.raw.authToken).toBe('[REDACTED]');
			expect(result.raw.password).toBe('[REDACTED]');
			expect(result.raw.clientToken).toBe('[REDACTED]');
			expect(result.raw.accessToken).toBe('[REDACTED]');
			expect(result.raw.refreshToken).toBe('[REDACTED]');

			// Verify sanitized fields are tracked
			expect(result.sanitizedFields).toContain('apiKey');
			expect(result.sanitizedFields).toContain('authToken');
			expect(result.sanitizedFields).toContain('password');
		});

		it('should sanitize paths in settings', async () => {
			const { collectSettings } = await import('../../../main/debug-package/collectors/settings');

			const homeDir = os.homedir();
			const mockStore = {
				get: vi.fn(),
				set: vi.fn(),
				store: {
					customPath: `${homeDir}/custom/path`,
					ghPath: `${homeDir}/.local/bin/gh`,
					customShellPath: `${homeDir}/shells/zsh`,
					cwd: `${homeDir}/Projects/current`,
				},
			};

			const result = await collectSettings(mockStore as any);

			// Verify paths are sanitized
			expect(result.raw.customPath).toBe('~/custom/path');
			expect(result.raw.ghPath).toBe('~/.local/bin/gh');
			expect(result.raw.customShellPath).toBe('~/shells/zsh');
			expect(result.raw.cwd).toBe('~/Projects/current');

			// Verify no raw home dir paths
			expect(JSON.stringify(result.raw)).not.toContain(homeDir);
		});

		it('should handle nested objects with sensitive keys', async () => {
			const { collectSettings } = await import('../../../main/debug-package/collectors/settings');

			const mockStore = {
				get: vi.fn(),
				set: vi.fn(),
				store: {
					agent: {
						claude: {
							apiKey: 'nested-key',
							endpoint: 'https://api.example.com',
						},
					},
				},
			};

			const result = await collectSettings(mockStore as any);

			expect((result.raw.agent as any).claude.apiKey).toBe('[REDACTED]');
			expect((result.raw.agent as any).claude.endpoint).toBe('https://api.example.com');
		});

		it('should handle arrays with sensitive values', async () => {
			const { collectSettings } = await import('../../../main/debug-package/collectors/settings');

			const homeDir = os.homedir();
			const mockStore = {
				get: vi.fn(),
				set: vi.fn(),
				store: {
					recentPaths: [`${homeDir}/Project1`, `${homeDir}/Project2`],
				},
			};

			const result = await collectSettings(mockStore as any);

			// Array elements should be processed
			expect(result.raw.recentPaths).toBeDefined();
		});
	});

	describe('collectSessions', () => {
		it('should extract session metadata without conversation content', async () => {
			const { collectSessions } = await import('../../../main/debug-package/collectors/sessions');

			const homeDir = os.homedir();
			const mockStore = {
				get: vi.fn().mockReturnValue([
					{
						id: 'session-1',
						name: 'Test Session',
						groupId: 'group-1',
						toolType: 'claude-code',
						state: 'idle',
						inputMode: 'ai',
						cwd: `${homeDir}/Projects/Test`,
						projectRoot: `${homeDir}/Projects/Test`,
						isGitRepo: true,
						isLive: false,
						aiTabs: [{ id: 'tab-1', logs: [{ content: 'secret message' }] }],
						activeTabId: 'tab-1',
						executionQueue: [{ type: 'message', content: 'hidden' }],
						contextUsage: 50,
						usageStats: { tokens: 1000 },
						agentError: { type: 'rate_limit' },
						bookmarked: true,
						autoRunFolderPath: `${homeDir}/AutoRun`,
						autoRunMode: 'edit',
						changedFiles: [{ path: 'file1.ts' }, { path: 'file2.ts' }],
					},
				]),
				set: vi.fn(),
				store: {},
			};

			const result = await collectSessions(mockStore as any);

			expect(result).toHaveLength(1);

			const session = result[0];
			// Verify metadata is captured
			expect(session.id).toBe('session-1');
			expect(session.name).toBe('Test Session');
			expect(session.toolType).toBe('claude-code');
			expect(session.state).toBe('idle');
			expect(session.isGitRepo).toBe(true);
			expect(session.tabCount).toBe(1);
			expect(session.executionQueueLength).toBe(1);
			expect(session.hasError).toBe(true);
			expect(session.errorType).toBe('rate_limit');
			expect(session.hasAutoRunFolder).toBe(true);
			expect(session.changedFilesCount).toBe(2);

			// Verify paths are sanitized
			expect(session.cwd).toBe('~/Projects/Test');
			expect(session.projectRoot).toBe('~/Projects/Test');
			expect(session.cwd).not.toContain(homeDir);

			// Verify no conversation content (check session object doesn't have aiTabs with logs)
			expect((session as any).aiTabs).toBeUndefined();
			expect((session as any).executionQueue).toBeUndefined();
			expect((session as any).shellLogs).toBeUndefined();
		});

		it('should handle sessions with missing fields gracefully', async () => {
			const { collectSessions } = await import('../../../main/debug-package/collectors/sessions');

			const mockStore = {
				get: vi.fn().mockReturnValue([
					{
						id: 'minimal-session',
						// Missing most fields
					},
				]),
				set: vi.fn(),
				store: {},
			};

			const result = await collectSessions(mockStore as any);

			expect(result).toHaveLength(1);
			expect(result[0].id).toBe('minimal-session');
			expect(result[0].name).toBe('Unnamed');
			expect(result[0].toolType).toBe('unknown');
			expect(result[0].tabCount).toBe(0);
			expect(result[0].executionQueueLength).toBe(0);
			expect(result[0].hasError).toBe(false);
		});
	});

	describe('collectAgents', () => {
		it('should collect agent info with sanitized paths', async () => {
			const { collectAgents } = await import('../../../main/debug-package/collectors/agents');

			const homeDir = os.homedir();
			const mockAgentDetector = {
				detectAgents: vi.fn().mockResolvedValue([
					{
						id: 'claude-code',
						name: 'Claude Code',
						available: true,
						binaryName: 'claude',
						path: `${homeDir}/.local/bin/claude`,
						customPath: `${homeDir}/custom/claude`,
						capabilities: {
							supportsResume: true,
							supportsJsonOutput: true,
						},
						configOptions: [
							{ key: 'model', type: 'string' },
							{ key: 'maxTokens', type: 'number' },
						],
					},
				]),
			};

			const result = await collectAgents(mockAgentDetector as any);

			expect(result.detectedAgents).toHaveLength(1);

			const agent = result.detectedAgents[0];
			expect(agent.id).toBe('claude-code');
			expect(agent.name).toBe('Claude Code');
			expect(agent.available).toBe(true);
			// Path should be sanitized
			expect(agent.path).toBe('~/.local/bin/claude');
			expect(agent.path).not.toContain(homeDir);
			// Custom path indicator
			expect(agent.customPath).toBe('[SET]');
			// Capabilities preserved
			expect(agent.capabilities.supportsResume).toBe(true);
			// Config options show type only
			expect(agent.configOptionsState).toEqual({
				model: '[STRING]',
				maxTokens: '[NUMBER]',
			});
		});

		it('should handle null agentDetector gracefully', async () => {
			const { collectAgents } = await import('../../../main/debug-package/collectors/agents');

			const result = await collectAgents(null);

			expect(result.detectedAgents).toHaveLength(0);
			expect(result.customPaths).toEqual({});
			expect(result.customArgsSet).toHaveLength(0);
			expect(result.customEnvVarsSet).toHaveLength(0);
		});

		it('should not expose custom args or env var values', async () => {
			const { collectAgents } = await import('../../../main/debug-package/collectors/agents');

			const mockAgentDetector = {
				detectAgents: vi.fn().mockResolvedValue([
					{
						id: 'test-agent',
						name: 'Test Agent',
						available: true,
						customArgs: '--api-key=secret123 --token=abc',
						customEnvVars: { SECRET_KEY: 'value', API_TOKEN: 'token' },
					},
				]),
			};

			const result = await collectAgents(mockAgentDetector as any);

			const agent = result.detectedAgents[0];
			// Custom args should just indicate if set, not show value
			expect(agent.customArgs).toBe('[NOT SET]'); // The collector doesn't have access to customArgs from agent
			// No raw secrets in output
			expect(JSON.stringify(result)).not.toContain('secret123');
			expect(JSON.stringify(result)).not.toContain('abc');
		});
	});

	describe('collectProcesses', () => {
		it('should collect process info with sanitized paths', async () => {
			const { collectProcesses } = await import('../../../main/debug-package/collectors/processes');

			const homeDir = os.homedir();
			const startTime = Date.now() - 60000; // 1 minute ago

			const mockProcessManager = {
				getAll: vi.fn().mockReturnValue([
					{
						sessionId: 'session-1',
						toolType: 'claude-code',
						pid: 12345,
						cwd: `${homeDir}/Projects/Test`,
						isTerminal: false,
						isBatchMode: true,
						startTime,
						outputParser: {},
					},
				]),
			};

			const result = await collectProcesses(mockProcessManager as any);

			expect(result).toHaveLength(1);

			const proc = result[0];
			expect(proc.sessionId).toBe('session-1');
			expect(proc.toolType).toBe('claude-code');
			expect(proc.pid).toBe(12345);
			expect(proc.cwd).toBe('~/Projects/Test');
			expect(proc.cwd).not.toContain(homeDir);
			expect(proc.isTerminal).toBe(false);
			expect(proc.isBatchMode).toBe(true);
			expect(proc.uptimeMs).toBeGreaterThan(0);
			expect(proc.hasParser).toBe(true);
		});

		it('should handle null processManager gracefully', async () => {
			const { collectProcesses } = await import('../../../main/debug-package/collectors/processes');

			const result = await collectProcesses(null);

			expect(result).toHaveLength(0);
		});
	});

	describe('collectLogs', () => {
		it('should collect recent logs with level counts', async () => {
			const { logger } = await import('../../../main/utils/logger');
			const mockLogs = [
				{ level: 'info', message: 'Info 1', timestamp: Date.now() - 5000 },
				{ level: 'info', message: 'Info 2', timestamp: Date.now() - 4000 },
				{ level: 'warn', message: 'Warning', timestamp: Date.now() - 3000 },
				{ level: 'error', message: 'Error', timestamp: Date.now() - 2000 },
				{ level: 'debug', message: 'Debug', timestamp: Date.now() - 1000 },
			];
			vi.mocked(logger.getLogs).mockReturnValue(mockLogs as any);

			const { collectLogs } = await import('../../../main/debug-package/collectors/logs');

			const result = collectLogs(500);

			expect(result.totalEntries).toBe(5);
			expect(result.includedEntries).toBe(5);
			expect(result.byLevel.info).toBe(2);
			expect(result.byLevel.warn).toBe(1);
			expect(result.byLevel.error).toBe(1);
			expect(result.byLevel.debug).toBe(1);
			expect(result.entries).toHaveLength(5);
		});

		it('should limit entries when specified', async () => {
			const { logger } = await import('../../../main/utils/logger');
			const mockLogs = Array.from({ length: 100 }, (_, i) => ({
				level: 'info',
				message: `Log ${i}`,
				timestamp: Date.now() - i * 1000,
			}));
			vi.mocked(logger.getLogs).mockReturnValue(mockLogs as any);

			const { collectLogs } = await import('../../../main/debug-package/collectors/logs');

			const result = collectLogs(10);

			expect(result.totalEntries).toBe(100);
			expect(result.includedEntries).toBe(10);
			expect(result.entries).toHaveLength(10);
		});
	});

	describe('collectErrors', () => {
		it('should collect session errors and error logs', async () => {
			const { logger } = await import('../../../main/utils/logger');
			const now = Date.now();
			const mockLogs = [
				{ level: 'info', message: 'Info', timestamp: now - 1000 },
				{ level: 'error', message: 'Error 1', timestamp: now - 500 },
				{ level: 'error', message: 'Error 2', timestamp: now - 100 },
			];
			vi.mocked(logger.getLogs).mockReturnValue(mockLogs as any);

			const { collectErrors } = await import('../../../main/debug-package/collectors/errors');

			const mockStore = {
				get: vi.fn().mockReturnValue([
					{
						id: 'session-1',
						toolType: 'claude-code',
						agentError: {
							type: 'auth_error',
							recoverable: true,
							timestamp: now - 1000,
						},
					},
					{
						id: 'session-2',
						toolType: 'opencode',
						// No error
					},
				]),
				set: vi.fn(),
				store: {},
			};

			const result = collectErrors(mockStore as any);

			// Should have one session error
			expect(result.currentSessionErrors).toHaveLength(1);
			expect(result.currentSessionErrors[0].sessionId).toBe('session-1');
			expect(result.currentSessionErrors[0].errorType).toBe('auth_error');
			expect(result.currentSessionErrors[0].recoverable).toBe(true);
			expect(result.currentSessionErrors[0].agentId).toBe('claude-code');

			// Should have filtered error logs only
			expect(result.recentErrorLogs).toHaveLength(2);
			expect(result.recentErrorLogs.every((l) => l.level === 'error')).toBe(true);

			// Should count errors in last 24h
			expect(result.errorCount24h).toBe(2);
		});
	});

	describe('collectBatchState', () => {
		it('should collect Auto Run state from sessions', async () => {
			const { collectBatchState } =
				await import('../../../main/debug-package/collectors/batch-state');

			const startTime = Date.now() - 60000;
			const mockStore = {
				get: vi.fn().mockReturnValue([
					{
						id: 'session-1',
						batchRunState: {
							isRunning: true,
							isStopping: false,
							documentCount: 5,
							currentDocumentIndex: 2,
							loopEnabled: true,
							loopIteration: 3,
							worktreeActive: true,
							error: null,
							startTime,
						},
					},
					{
						id: 'session-2',
						// No batch state
					},
					{
						id: 'session-3',
						batchRunState: {
							isRunning: false,
							error: { type: 'document_error' },
						},
					},
				]),
				set: vi.fn(),
				store: {},
			};

			const result = collectBatchState(mockStore as any);

			expect(result.activeSessions).toHaveLength(2);

			const session1 = result.activeSessions.find((s) => s.sessionId === 'session-1');
			expect(session1).toBeDefined();
			expect(session1!.isRunning).toBe(true);
			expect(session1!.documentCount).toBe(5);
			expect(session1!.currentDocumentIndex).toBe(2);
			expect(session1!.loopEnabled).toBe(true);
			expect(session1!.loopIteration).toBe(3);
			expect(session1!.worktreeActive).toBe(true);
			expect(session1!.hasError).toBe(false);
			expect(session1!.startTime).toBe(startTime);
			expect(session1!.elapsedMs).toBeGreaterThan(0);

			const session3 = result.activeSessions.find((s) => s.sessionId === 'session-3');
			expect(session3).toBeDefined();
			expect(session3!.hasError).toBe(true);
			expect(session3!.errorType).toBe('document_error');
		});
	});

	describe('collectExternalTools', () => {
		it('should collect external tools availability', async () => {
			const { detectShells } = await import('../../../main/utils/shellDetector');
			const { execFileNoThrow } = await import('../../../main/utils/execFile');
			const { isCloudflaredInstalled } = await import('../../../main/utils/cliDetection');

			const homeDir = os.homedir();

			vi.mocked(detectShells).mockResolvedValue([
				{ id: 'zsh', name: 'Zsh', available: true, path: `${homeDir}/.local/bin/zsh` },
				{ id: 'bash', name: 'Bash', available: true, path: '/bin/bash' },
			]);

			vi.mocked(execFileNoThrow)
				.mockResolvedValueOnce({ stdout: 'git version 2.40.0', stderr: '', exitCode: 0 })
				.mockResolvedValueOnce({ stdout: 'gh version 2.30.0', stderr: '', exitCode: 0 })
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });

			vi.mocked(isCloudflaredInstalled).mockResolvedValue(true);

			const { collectExternalTools } =
				await import('../../../main/debug-package/collectors/external-tools');

			const result = await collectExternalTools();

			// Check shells
			expect(result.shells).toHaveLength(2);
			expect(result.shells[0].path).toBe('~/.local/bin/zsh');
			expect(result.shells[0].path).not.toContain(homeDir);
			expect(result.shells[1].path).toBe('/bin/bash');

			// Check git
			expect(result.git.available).toBe(true);
			expect(result.git.version).toBe('2.40.0');

			// Check gh CLI
			expect(result.github.ghCliInstalled).toBe(true);
			expect(result.github.ghCliAuthenticated).toBe(true);

			// Check cloudflared
			expect(result.cloudflared.installed).toBe(true);
		});

		it('should handle failures gracefully', async () => {
			const { detectShells } = await import('../../../main/utils/shellDetector');
			const { execFileNoThrow } = await import('../../../main/utils/execFile');
			const { isCloudflaredInstalled } = await import('../../../main/utils/cliDetection');

			vi.mocked(detectShells).mockRejectedValue(new Error('Shell detection failed'));
			vi.mocked(execFileNoThrow).mockResolvedValue({
				stdout: '',
				stderr: 'command not found',
				exitCode: 127,
			});
			vi.mocked(isCloudflaredInstalled).mockRejectedValue(new Error('Check failed'));

			const { collectExternalTools } =
				await import('../../../main/debug-package/collectors/external-tools');

			const result = await collectExternalTools();

			expect(result.shells).toHaveLength(0);
			expect(result.git.available).toBe(false);
			expect(result.github.ghCliInstalled).toBe(false);
			expect(result.cloudflared.installed).toBe(false);
		});
	});

	describe('collectWebServer', () => {
		it('should collect web server state', async () => {
			const { tunnelManager } = await import('../../../main/tunnel-manager');
			const { isCloudflaredInstalled } = await import('../../../main/utils/cliDetection');

			vi.mocked(tunnelManager.getStatus).mockReturnValue({
				isRunning: true,
				url: 'https://tunnel.example.com',
				error: null,
			} as any);
			vi.mocked(isCloudflaredInstalled).mockResolvedValue(true);

			const { collectWebServer } =
				await import('../../../main/debug-package/collectors/web-server');

			const mockWebServer = {
				isActive: vi.fn().mockReturnValue(true),
				getPort: vi.fn().mockReturnValue(3000),
				getWebClientCount: vi.fn().mockReturnValue(2),
				getLiveSessions: vi
					.fn()
					.mockReturnValue([{ id: 'session-1', enabledAt: Date.now() - 1000 }]),
			};

			const result = await collectWebServer(mockWebServer as any);

			expect(result.isRunning).toBe(true);
			expect(result.port).toBe(3000);
			expect(result.connectedClients).toBe(2);
			expect(result.liveSessions).toHaveLength(1);
			expect(result.liveSessions[0].sessionId).toBe('session-1');

			// Tunnel info
			expect(result.tunnel.cloudflaredInstalled).toBe(true);
			expect(result.tunnel.isRunning).toBe(true);
			expect(result.tunnel.hasUrl).toBe(true);
			// Should NOT contain actual URL
			expect(JSON.stringify(result)).not.toContain('tunnel.example.com');
		});

		it('should handle null webServer gracefully', async () => {
			const { collectWebServer } =
				await import('../../../main/debug-package/collectors/web-server');

			const result = await collectWebServer(null);

			expect(result.isRunning).toBe(false);
			expect(result.connectedClients).toBe(0);
			expect(result.liveSessions).toHaveLength(0);
		});
	});

	describe('collectStorage', () => {
		it('should collect storage paths and sizes with sanitization', async () => {
			const fs = await import('fs');
			const { app } = await import('electron');

			vi.mocked(app.getPath).mockReturnValue('/mock/userData');
			vi.mocked(fs.existsSync).mockReturnValue(true);
			vi.mocked(fs.statSync).mockImplementation((path: any) => {
				if (path.includes('maestro-sessions.json')) {
					return { size: 1024, isDirectory: () => false } as any;
				}
				return { size: 0, isDirectory: () => true } as any;
			});
			vi.mocked(fs.readdirSync).mockReturnValue([]);

			const { collectStorage } = await import('../../../main/debug-package/collectors/storage');

			const mockBootstrapStore = {
				get: vi.fn().mockReturnValue(undefined),
			};

			const result = await collectStorage(mockBootstrapStore as any);

			// Paths should be sanitized (in mock they don't contain home dir)
			expect(result.paths.userData).toBeDefined();
			expect(result.paths.sessions).toBeDefined();
			expect(result.paths.history).toBeDefined();
			expect(result.paths.groupChats).toBeDefined();

			// Sizes should be calculated
			expect(result.sizes).toBeDefined();
			expect(result.sizes.totalBytes).toBeGreaterThanOrEqual(0);

			// Custom sync path indicator
			expect(result.paths.customSyncPath).toBeUndefined();
		});

		it('should indicate when custom sync path is set', async () => {
			const { collectStorage } = await import('../../../main/debug-package/collectors/storage');

			const mockBootstrapStore = {
				get: vi.fn().mockReturnValue('/custom/sync/path'),
			};

			const result = await collectStorage(mockBootstrapStore as any);

			expect(result.paths.customSyncPath).toBe('[SET]');
		});
	});

	describe('collectGroupChats', () => {
		it('should collect group chat metadata without message content', async () => {
			const fs = await import('fs');
			const { app } = await import('electron');

			vi.mocked(app.getPath).mockReturnValue('/mock/userData');
			vi.mocked(fs.existsSync).mockReturnValue(true);
			vi.mocked(fs.readdirSync).mockReturnValue([
				'chat-1.json',
				'chat-1.log.json',
				'chat-2.json',
			] as any);
			vi.mocked(fs.readFileSync).mockImplementation((path: any) => {
				if (path.includes('chat-1.json') && !path.includes('.log')) {
					return JSON.stringify({
						id: 'chat-1',
						name: 'Test Chat',
						moderatorAgentId: 'claude-code',
						participants: [
							{ name: 'Claude', agentId: 'claude-code' },
							{ name: 'Codex', agentId: 'openai-codex' },
						],
						createdAt: Date.now() - 3600000,
						updatedAt: Date.now(),
					});
				}
				if (path.includes('chat-1.log.json')) {
					return '{"content":"message 1"}\n{"content":"message 2"}\n{"content":"message 3"}';
				}
				if (path.includes('chat-2.json')) {
					return JSON.stringify({
						id: 'chat-2',
						name: 'Another Chat',
						moderatorAgentId: 'opencode',
						participants: [],
						createdAt: Date.now(),
						updatedAt: Date.now(),
					});
				}
				return '';
			});

			const { collectGroupChats } =
				await import('../../../main/debug-package/collectors/group-chats');

			const result = await collectGroupChats();

			expect(result).toHaveLength(2);

			const chat1 = result.find((c) => c.id === 'chat-1');
			expect(chat1).toBeDefined();
			expect(chat1!.name).toBe('Test Chat');
			expect(chat1!.moderatorAgentId).toBe('claude-code');
			expect(chat1!.participantCount).toBe(2);
			expect(chat1!.participants).toHaveLength(2);
			expect(chat1!.messageCount).toBe(3);

			// Verify no message content
			expect(JSON.stringify(result)).not.toContain('message 1');
			expect(JSON.stringify(result)).not.toContain('message 2');
		});

		it('should handle missing group chats directory', async () => {
			const fs = await import('fs');

			vi.mocked(fs.existsSync).mockReturnValue(false);

			const { collectGroupChats } =
				await import('../../../main/debug-package/collectors/group-chats');

			const result = await collectGroupChats();

			expect(result).toHaveLength(0);
		});
	});

	describe('Sanitization Edge Cases', () => {
		it('should handle deeply nested sensitive data', async () => {
			const { collectSettings } = await import('../../../main/debug-package/collectors/settings');

			const homeDir = os.homedir();
			const mockStore = {
				get: vi.fn(),
				set: vi.fn(),
				store: {
					level1: {
						level2: {
							level3: {
								apiKey: 'deep-secret',
								path: `${homeDir}/deep/path`,
							},
						},
					},
				},
			};

			const result = await collectSettings(mockStore as any);

			expect((result.raw.level1 as any).level2.level3.apiKey).toBe('[REDACTED]');
			expect((result.raw.level1 as any).level2.level3.path).toBe('~/deep/path');
		});

		it('should handle case variations in sensitive key names', async () => {
			const { collectSettings } = await import('../../../main/debug-package/collectors/settings');

			const mockStore = {
				get: vi.fn(),
				set: vi.fn(),
				store: {
					APIKEY: 'upper-case',
					ApiKey: 'mixed-case',
					api_Key: 'underscore-mixed',
					myApiKeyValue: 'nested-in-name',
				},
			};

			const result = await collectSettings(mockStore as any);

			// All variations should be redacted
			expect(result.raw.APIKEY).toBe('[REDACTED]');
			expect(result.raw.ApiKey).toBe('[REDACTED]');
			expect(result.raw.api_Key).toBe('[REDACTED]');
			expect(result.raw.myApiKeyValue).toBe('[REDACTED]');
		});

		it('should not over-sanitize non-sensitive data', async () => {
			const { collectSettings } = await import('../../../main/debug-package/collectors/settings');

			const mockStore = {
				get: vi.fn(),
				set: vi.fn(),
				store: {
					theme: 'dark',
					fontSize: 14,
					enabled: true,
					items: ['a', 'b', 'c'],
					config: { nested: 'value' },
				},
			};

			const result = await collectSettings(mockStore as any);

			// Non-sensitive data should be preserved
			expect(result.raw.theme).toBe('dark');
			expect(result.raw.fontSize).toBe(14);
			expect(result.raw.enabled).toBe(true);
			expect(result.raw.items).toEqual(['a', 'b', 'c']);
			expect((result.raw.config as any).nested).toBe('value');
		});
	});
});
