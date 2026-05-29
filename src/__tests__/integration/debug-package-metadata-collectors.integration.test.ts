import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Store from 'electron-store';

const mocks = vi.hoisted(() => ({
	getVersion: vi.fn(),
	getLogs: vi.fn(),
}));

vi.mock('electron', () => ({
	app: {
		getVersion: mocks.getVersion,
	},
}));

vi.mock('../../main/utils/logger', () => ({
	logger: {
		getLogs: mocks.getLogs,
	},
}));

import { collectAgents } from '../../main/debug-package/collectors/agents';
import { collectBatchState } from '../../main/debug-package/collectors/batch-state';
import { collectErrors } from '../../main/debug-package/collectors/errors';
import { collectLogs } from '../../main/debug-package/collectors/logs';
import { collectProcesses } from '../../main/debug-package/collectors/processes';
import { collectSessions } from '../../main/debug-package/collectors/sessions';
import { collectSystemInfo } from '../../main/debug-package/collectors/system';

function storeWithSessions(sessions: unknown[]): Store<any> {
	return {
		get: (key: string, fallback: unknown) => (key === 'sessions' ? sessions : fallback),
	} as Store<any>;
}

describe('debug package metadata collectors integration', () => {
	beforeEach(() => {
		vi.setSystemTime(new Date('2026-05-27T08:00:00Z'));
		mocks.getVersion.mockReturnValue('9.8.7');
		mocks.getLogs.mockReturnValue([]);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	it('collects system metadata without user-specific paths', () => {
		const result = collectSystemInfo();

		expect(result.os).toMatchObject({
			platform: os.platform(),
			release: os.release(),
			arch: os.arch(),
			version: os.version(),
		});
		expect(result.hardware.cpus).toBe(os.cpus().length);
		expect(result.hardware.totalMemoryMB).toBeGreaterThan(0);
		expect(result.hardware.freeMemoryMB).toBeGreaterThan(0);
		expect(result.app.version).toBe('9.8.7');
		expect(result.app.nodeVersion).toBe(process.versions.node);
		expect(result.runtime.uptimeSeconds).toBeGreaterThanOrEqual(0);
		expect(result.runtime.appUptimeSeconds).toBeGreaterThanOrEqual(0);
		expect(JSON.stringify(result)).not.toContain(os.homedir());
	});

	it('collects agent metadata without binary paths or option values', async () => {
		await expect(collectAgents(null)).resolves.toEqual({
			detectedAgents: [],
			customArgsSet: [],
			customEnvVarsSet: [],
		});

		const home = os.homedir();
		const agentDetector = {
			detectAgents: vi.fn().mockResolvedValue([
				{
					id: 'codex',
					name: 'Codex',
					available: true,
					path: `${home}/bin/codex`,
					binaryName: 'codex',
					customPath: `${home}/custom/codex`,
					capabilities: { supportsResume: true },
					hidden: true,
					configOptions: [
						{ key: 'model', type: 'string' },
						{ key: 'maxTokens', type: 'number' },
					],
				},
				{
					id: 'minimal',
					name: 'Minimal',
					available: false,
				},
			]),
		};

		const result = await collectAgents(agentDetector as any);

		expect(result.detectedAgents).toEqual([
			{
				id: 'codex',
				name: 'Codex',
				available: true,
				customPath: '[SET]',
				customArgs: '[NOT SET]',
				hasCustomEnvVars: false,
				customEnvVarCount: 0,
				capabilities: { supportsResume: true },
				hidden: true,
				configOptionsState: {
					model: '[STRING]',
					maxTokens: '[NUMBER]',
				},
			},
			{
				id: 'minimal',
				name: 'Minimal',
				available: false,
				customPath: '[NOT SET]',
				customArgs: '[NOT SET]',
				hasCustomEnvVars: false,
				customEnvVarCount: 0,
				capabilities: {},
				hidden: undefined,
			},
		]);
		expect(JSON.stringify(result)).not.toContain(home);
		expect(JSON.stringify(result)).not.toContain('binaryName');
	});

	it('collects session metadata without conversation content', async () => {
		const home = os.homedir();
		const result = await collectSessions(
			storeWithSessions([
				{
					id: 'session-1',
					groupId: 'group-1',
					toolType: 'codex',
					state: 'running',
					inputMode: 'chat',
					cwd: `${home}/project`,
					projectRoot: `${home}/project`,
					isGitRepo: true,
					isLive: true,
					aiTabs: [{ id: 'tab-1', logs: [{ content: 'secret prompt' }] }],
					activeTabId: 'tab-1',
					executionQueue: [{ content: 'hidden command' }],
					contextUsage: 42,
					usageStats: { tokens: 1000 },
					agentError: { type: 'rate_limit', message: 'hidden' },
					createdAt: 123,
					bookmarked: true,
					autoRunFolderPath: `${home}/docs`,
					autoRunMode: 'edit',
					changedFiles: [{ path: 'a.ts' }, { path: 'b.ts' }],
				},
				{},
			])
		);

		expect(result).toEqual([
			{
				id: 'session-1',
				groupId: 'group-1',
				toolType: 'codex',
				state: 'running',
				inputMode: 'chat',
				cwd: '~/project',
				projectRoot: '~/project',
				isGitRepo: true,
				isLive: true,
				tabCount: 1,
				activeTabId: 'tab-1',
				executionQueueLength: 1,
				contextUsage: 42,
				hasUsageStats: true,
				hasError: true,
				errorType: 'rate_limit',
				createdAt: 123,
				bookmarked: true,
				hasAutoRunFolder: true,
				autoRunMode: 'edit',
				changedFilesCount: 2,
			},
			{
				id: 'unknown',
				groupId: undefined,
				toolType: 'unknown',
				state: 'unknown',
				inputMode: 'ai',
				cwd: '',
				projectRoot: '',
				isGitRepo: false,
				isLive: false,
				tabCount: 0,
				activeTabId: '',
				executionQueueLength: 0,
				contextUsage: 0,
				hasUsageStats: false,
				hasError: false,
				errorType: undefined,
				createdAt: undefined,
				bookmarked: false,
				hasAutoRunFolder: false,
				autoRunMode: undefined,
				changedFilesCount: 0,
			},
		]);
		expect(JSON.stringify(result)).not.toContain('secret prompt');
		expect(JSON.stringify(result)).not.toContain('hidden command');
		expect(JSON.stringify(result)).not.toContain(home);
	});

	it('collects active process metadata with sanitized working directories', async () => {
		const home = os.homedir();

		await expect(collectProcesses(null)).resolves.toEqual([]);
		await expect(
			collectProcesses({
				getAll: vi.fn().mockReturnValue([
					{
						sessionId: 'session-1',
						toolType: 'codex',
						pid: 1234,
						cwd: `${home}/project`,
						isTerminal: true,
						isBatchMode: true,
						startTime: Date.now() - 2500,
						outputParser: {},
					},
					{},
				]),
			} as any)
		).resolves.toEqual([
			{
				sessionId: 'session-1',
				toolType: 'codex',
				pid: 1234,
				cwd: '~/project',
				isTerminal: true,
				isBatchMode: true,
				uptimeMs: 2500,
				hasParser: true,
			},
			{
				sessionId: 'unknown',
				toolType: 'unknown',
				pid: 0,
				cwd: '',
				isTerminal: false,
				isBatchMode: false,
				uptimeMs: 0,
				hasParser: false,
			},
		]);
	});

	it('collects bounded sanitized logs and drops raw log data', () => {
		const home = os.homedir();
		const longMessage = `${home}/project/secret ${'x'.repeat(520)}`;
		mocks.getLogs.mockReturnValue([
			{ timestamp: 1, level: 'info', message: 'first', data: { token: 'hidden' } },
			{ timestamp: 2, level: 'warn', message: `${home}/warn`, context: 'WarnCtx' },
			{ timestamp: 3, level: 'error', message: longMessage, context: 'ErrCtx' },
		]);

		const result = collectLogs(2);

		expect(result.totalEntries).toBe(3);
		expect(result.includedEntries).toBe(2);
		expect(result.byLevel).toEqual({ info: 1, warn: 1, error: 1 });
		expect(result.entries).toEqual([
			{ timestamp: 2, level: 'warn', message: '~/warn', context: 'WarnCtx' },
			expect.objectContaining({
				timestamp: 3,
				level: 'error',
				context: 'ErrCtx',
			}),
		]);
		expect(result.entries[1].message).toContain('[TRUNCATED]');
		expect(JSON.stringify(result)).not.toContain(home);
		expect(JSON.stringify(result)).not.toContain('hidden');
	});

	it('collects sanitized session errors and recent error logs', () => {
		const home = os.homedir();
		const now = Date.now();
		const oldError = { timestamp: now - 25 * 60 * 60 * 1000, level: 'error', message: 'old' };
		const recentErrors = Array.from({ length: 101 }, (_, index) => ({
			timestamp: now - index,
			level: 'error',
			message: `${home}/error-${index}`,
			context: 'ErrCtx',
			data: { secret: `secret-${index}` },
		}));
		mocks.getLogs.mockReturnValue([
			{ timestamp: now, level: 'info', message: 'ignore me' },
			oldError,
			...recentErrors,
		]);

		const result = collectErrors(
			storeWithSessions([
				{
					id: 'session-1',
					toolType: 'codex',
					agentError: {
						type: 'auth_error',
						recoverable: true,
						timestamp: 111,
					},
				},
				{
					agentError: {},
				},
				{},
			])
		);

		expect(result.currentSessionErrors).toEqual([
			{
				sessionId: 'session-1',
				errorType: 'auth_error',
				recoverable: true,
				timestamp: 111,
				agentId: 'codex',
			},
			{
				sessionId: 'unknown',
				errorType: 'unknown',
				recoverable: false,
				timestamp: now,
				agentId: 'unknown',
			},
		]);
		expect(result.recentErrorLogs).toHaveLength(100);
		expect(result.recentErrorLogs[0].message).toBe('~/error-1');
		expect(result.errorCount24h).toBe(101);
		expect(JSON.stringify(result)).not.toContain(home);
		expect(JSON.stringify(result)).not.toContain('secret-');
	});

	it('collects active batch state without document content', () => {
		const startTime = Date.now() - 7500;
		const result = collectBatchState(
			storeWithSessions([
				{
					id: 'session-1',
					batchRunState: {
						isRunning: true,
						isStopping: true,
						documentCount: 5,
						currentDocumentIndex: 2,
						loopEnabled: true,
						loopIteration: 3,
						worktreeActive: true,
						error: { type: 'document_error', message: 'hidden content' },
						startTime,
						documents: [{ prompt: 'secret prompt' }],
					},
				},
				{
					id: 'session-2',
				},
				{
					batchRunState: {},
				},
			])
		);

		expect(result).toEqual({
			activeSessions: [
				{
					sessionId: 'session-1',
					isRunning: true,
					isStopping: true,
					documentCount: 5,
					currentDocumentIndex: 2,
					loopEnabled: true,
					loopIteration: 3,
					worktreeActive: true,
					hasError: true,
					errorType: 'document_error',
					startTime,
					elapsedMs: 7500,
				},
				{
					sessionId: 'unknown',
					isRunning: false,
					isStopping: false,
					documentCount: 0,
					currentDocumentIndex: 0,
					loopEnabled: false,
					loopIteration: 0,
					worktreeActive: false,
					hasError: false,
					errorType: undefined,
					startTime: undefined,
					elapsedMs: undefined,
				},
			],
		});
		expect(JSON.stringify(result)).not.toContain('secret prompt');
		expect(JSON.stringify(result)).not.toContain('hidden content');
	});
});
