import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	collectSystemInfo: vi.fn(),
	collectSettings: vi.fn(),
	collectAgents: vi.fn(),
	collectExternalTools: vi.fn(),
	collectSessions: vi.fn(),
	collectProcesses: vi.fn(),
	collectLogs: vi.fn(),
	collectErrors: vi.fn(),
	collectWebServer: vi.fn(),
	collectStorage: vi.fn(),
	collectGroupChats: vi.fn(),
	collectBatchState: vi.fn(),
	collectWindowsDiagnostics: vi.fn(),
	createZipPackage: vi.fn(),
	logger: {
		info: vi.fn(),
		error: vi.fn(),
	},
}));

vi.mock('../../../main/debug-package/collectors/system', () => ({
	collectSystemInfo: mocks.collectSystemInfo,
}));

vi.mock('../../../main/debug-package/collectors/settings', () => ({
	collectSettings: mocks.collectSettings,
}));

vi.mock('../../../main/debug-package/collectors/agents', () => ({
	collectAgents: mocks.collectAgents,
}));

vi.mock('../../../main/debug-package/collectors/external-tools', () => ({
	collectExternalTools: mocks.collectExternalTools,
}));

vi.mock('../../../main/debug-package/collectors/sessions', () => ({
	collectSessions: mocks.collectSessions,
}));

vi.mock('../../../main/debug-package/collectors/processes', () => ({
	collectProcesses: mocks.collectProcesses,
}));

vi.mock('../../../main/debug-package/collectors/logs', () => ({
	collectLogs: mocks.collectLogs,
}));

vi.mock('../../../main/debug-package/collectors/errors', () => ({
	collectErrors: mocks.collectErrors,
}));

vi.mock('../../../main/debug-package/collectors/web-server', () => ({
	collectWebServer: mocks.collectWebServer,
}));

vi.mock('../../../main/debug-package/collectors/storage', () => ({
	collectStorage: mocks.collectStorage,
}));

vi.mock('../../../main/debug-package/collectors/group-chats', () => ({
	collectGroupChats: mocks.collectGroupChats,
}));

vi.mock('../../../main/debug-package/collectors/batch-state', () => ({
	collectBatchState: mocks.collectBatchState,
}));

vi.mock('../../../main/debug-package/collectors/windows-diagnostics', () => ({
	collectWindowsDiagnostics: mocks.collectWindowsDiagnostics,
}));

vi.mock('../../../main/debug-package/packager', () => ({
	createZipPackage: mocks.createZipPackage,
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: mocks.logger,
}));

const deps = {
	getAgentDetector: vi.fn(() => ({ name: 'agent-detector' })),
	getProcessManager: vi.fn(() => ({ name: 'process-manager' })),
	getWebServer: vi.fn(() => ({ name: 'web-server' })),
	settingsStore: { get: vi.fn() },
	sessionsStore: { get: vi.fn() },
	groupsStore: { get: vi.fn(() => [{ id: 'group-1' }]) },
	bootstrapStore: { get: vi.fn() },
} as any;

function resetCollectorDefaults() {
	mocks.collectSystemInfo.mockReturnValue({ platform: 'darwin' });
	mocks.collectSettings.mockResolvedValue({ theme: 'dark' });
	mocks.collectAgents.mockResolvedValue({ agents: [] });
	mocks.collectExternalTools.mockResolvedValue({ tools: [] });
	mocks.collectWindowsDiagnostics.mockResolvedValue({ platform: 'darwin' });
	mocks.collectSessions.mockResolvedValue([{ id: 'session-1' }]);
	mocks.collectProcesses.mockResolvedValue([{ pid: 123 }]);
	mocks.collectLogs.mockReturnValue({ entries: [] });
	mocks.collectErrors.mockReturnValue({ sessions: [] });
	mocks.collectWebServer.mockResolvedValue({ running: false });
	mocks.collectStorage.mockResolvedValue({ mode: 'local' });
	mocks.collectGroupChats.mockResolvedValue([{ id: 'group-chat-1' }]);
	mocks.collectBatchState.mockReturnValue({ batches: [] });
	mocks.createZipPackage.mockResolvedValue({ path: '/tmp/debug.zip', sizeBytes: 4096 });
	deps.groupsStore.get.mockReturnValue([{ id: 'group-1' }]);
}

describe('debug-package index', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		resetCollectorDefaults();
	});

	it('generates a package with all default diagnostic categories', async () => {
		const { generateDebugPackage } = await import('../../../main/debug-package');

		const result = await generateDebugPackage('/tmp/out', deps);

		expect(result).toEqual({
			success: true,
			path: '/tmp/debug.zip',
			filesIncluded: [
				'system-info.json',
				'settings.json',
				'agents.json',
				'external-tools.json',
				'windows-diagnostics.json',
				'groups.json',
				'sessions.json',
				'processes.json',
				'logs.json',
				'errors.json',
				'web-server.json',
				'storage-info.json',
				'group-chats.json',
				'batch-state.json',
			],
			totalSizeBytes: 4096,
		});
		expect(mocks.collectSettings).toHaveBeenCalledWith(deps.settingsStore, deps.bootstrapStore);
		expect(mocks.collectAgents).toHaveBeenCalledWith({ name: 'agent-detector' });
		expect(mocks.collectProcesses).toHaveBeenCalledWith({ name: 'process-manager' });
		expect(mocks.collectLogs).toHaveBeenCalledWith(500);
		expect(mocks.collectErrors).toHaveBeenCalledWith(deps.sessionsStore);
		expect(mocks.collectWebServer).toHaveBeenCalledWith({ name: 'web-server' });
		expect(mocks.collectStorage).toHaveBeenCalledWith(deps.bootstrapStore);
		expect(mocks.createZipPackage).toHaveBeenCalledWith(
			'/tmp/out',
			expect.objectContaining({
				'system-info.json': { platform: 'darwin' },
				'groups.json': [{ id: 'group-1' }],
				'batch-state.json': { batches: [] },
			})
		);
		expect(mocks.logger.info).toHaveBeenCalledWith(
			'Debug package created: /tmp/debug.zip (4096 bytes)',
			'DebugPackage'
		);
	});

	it('skips optional categories when disabled', async () => {
		const { generateDebugPackage } = await import('../../../main/debug-package');

		await generateDebugPackage('/tmp/out', deps, {
			includeLogs: false,
			includeErrors: false,
			includeSessions: false,
			includeGroupChats: false,
			includeBatchState: false,
		});

		expect(mocks.collectSessions).not.toHaveBeenCalled();
		expect(mocks.collectLogs).not.toHaveBeenCalled();
		expect(mocks.collectErrors).not.toHaveBeenCalled();
		expect(mocks.collectGroupChats).not.toHaveBeenCalled();
		expect(mocks.collectBatchState).not.toHaveBeenCalled();
		expect(mocks.createZipPackage).toHaveBeenCalledWith(
			'/tmp/out',
			expect.not.objectContaining({
				'sessions.json': expect.anything(),
				'logs.json': expect.anything(),
				'errors.json': expect.anything(),
				'group-chats.json': expect.anything(),
				'batch-state.json': expect.anything(),
			})
		);
	});

	it('keeps generating when collectors fail and includes collection errors', async () => {
		const { generateDebugPackage } = await import('../../../main/debug-package');
		mocks.collectSystemInfo.mockImplementation(() => {
			throw new Error('system failed');
		});
		mocks.collectSettings.mockRejectedValue('settings failed');
		mocks.collectAgents.mockRejectedValue(new Error('agents failed'));
		mocks.collectExternalTools.mockRejectedValue('tools failed');
		mocks.collectWindowsDiagnostics.mockRejectedValue(new Error('windows failed'));
		deps.groupsStore.get.mockImplementation(() => {
			throw new Error('groups failed');
		});
		mocks.collectSessions.mockRejectedValue('sessions failed');
		mocks.collectProcesses.mockRejectedValue(new Error('processes failed'));
		mocks.collectLogs.mockImplementation(() => {
			throw 'logs failed';
		});
		mocks.collectErrors.mockImplementation(() => {
			throw new Error('errors failed');
		});
		mocks.collectWebServer.mockRejectedValue('web failed');
		mocks.collectStorage.mockRejectedValue(new Error('storage failed'));
		mocks.collectGroupChats.mockRejectedValue('group chats failed');
		mocks.collectBatchState.mockImplementation(() => {
			throw new Error('batch failed');
		});

		const result = await generateDebugPackage('/tmp/out', deps);

		expect(result.success).toBe(true);
		expect(result.filesIncluded).toEqual(['collection-errors.json']);
		expect(mocks.createZipPackage).toHaveBeenCalledWith('/tmp/out', {
			'collection-errors.json': {
				timestamp: expect.any(Number),
				errors: [
					'system-info: system failed',
					'settings: settings failed',
					'agents: agents failed',
					'external-tools: tools failed',
					'windows-diagnostics: windows failed',
					'groups: groups failed',
					'sessions: sessions failed',
					'processes: processes failed',
					'logs: logs failed',
					'errors: errors failed',
					'web-server: web failed',
					'storage-info: storage failed',
					'group-chats: group chats failed',
					'batch-state: batch failed',
				],
			},
		});
		expect(mocks.logger.error).toHaveBeenCalledWith(
			'Failed to collect system info',
			'DebugPackage',
			expect.any(Error)
		);
		expect(mocks.logger.error).toHaveBeenCalledWith(
			'Failed to collect settings',
			'DebugPackage',
			'settings failed'
		);
	});

	it('normalizes alternate collector failure types', async () => {
		const { generateDebugPackage } = await import('../../../main/debug-package');
		mocks.collectSystemInfo.mockImplementation(() => {
			throw 'system failed';
		});
		mocks.collectSettings.mockRejectedValue(new Error('settings failed'));
		mocks.collectAgents.mockRejectedValue('agents failed');
		mocks.collectExternalTools.mockRejectedValue(new Error('tools failed'));
		mocks.collectWindowsDiagnostics.mockRejectedValue('windows failed');
		deps.groupsStore.get.mockImplementation(() => {
			throw 'groups failed';
		});
		mocks.collectSessions.mockRejectedValue(new Error('sessions failed'));
		mocks.collectProcesses.mockRejectedValue('processes failed');
		mocks.collectLogs.mockImplementation(() => {
			throw new Error('logs failed');
		});
		mocks.collectErrors.mockImplementation(() => {
			throw 'errors failed';
		});
		mocks.collectWebServer.mockRejectedValue(new Error('web failed'));
		mocks.collectStorage.mockRejectedValue('storage failed');
		mocks.collectGroupChats.mockRejectedValue(new Error('group chats failed'));
		mocks.collectBatchState.mockImplementation(() => {
			throw 'batch failed';
		});

		await generateDebugPackage('/tmp/out', deps);

		const packageContents = mocks.createZipPackage.mock.calls.at(-1)?.[1];
		expect(packageContents['collection-errors.json'].errors).toEqual([
			'system-info: system failed',
			'settings: settings failed',
			'agents: agents failed',
			'external-tools: tools failed',
			'windows-diagnostics: windows failed',
			'groups: groups failed',
			'sessions: sessions failed',
			'processes: processes failed',
			'logs: logs failed',
			'errors: errors failed',
			'web-server: web failed',
			'storage-info: storage failed',
			'group-chats: group chats failed',
			'batch-state: batch failed',
		]);
	});

	it('returns a failed result when zip creation fails', async () => {
		const { generateDebugPackage } = await import('../../../main/debug-package');
		mocks.createZipPackage.mockRejectedValue(new Error('zip failed'));

		await expect(generateDebugPackage('/tmp/out', deps)).resolves.toEqual({
			success: false,
			error: 'zip failed',
			filesIncluded: [],
			totalSizeBytes: 0,
		});
		expect(mocks.logger.error).toHaveBeenCalledWith(
			'Failed to create debug package',
			'DebugPackage',
			expect.any(Error)
		);
	});

	it('normalizes non-Error zip creation failures', async () => {
		const { generateDebugPackage } = await import('../../../main/debug-package');
		mocks.createZipPackage.mockRejectedValue('zip failed');

		await expect(generateDebugPackage('/tmp/out', deps)).resolves.toEqual({
			success: false,
			error: 'zip failed',
			filesIncluded: [],
			totalSizeBytes: 0,
		});
	});

	it('previews the diagnostic categories included in debug packages', async () => {
		const { previewDebugPackage } = await import('../../../main/debug-package');

		const preview = previewDebugPackage();

		expect(preview.categories.map((category) => category.id)).toEqual([
			'system',
			'settings',
			'agents',
			'externalTools',
			'windowsDiagnostics',
			'sessions',
			'logs',
			'errors',
			'webServer',
			'storage',
			'groupChats',
			'batchState',
		]);
		expect(preview.categories.every((category) => category.included)).toBe(true);
	});
});
