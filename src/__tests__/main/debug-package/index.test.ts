import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	collectSystemInfo: vi.fn(),
	collectSettings: vi.fn(),
	collectAgents: vi.fn(),
	collectExternalTools: vi.fn(),
	collectWindowsDiagnostics: vi.fn(),
	collectSessions: vi.fn(),
	collectProcesses: vi.fn(),
	collectLogs: vi.fn(),
	collectErrors: vi.fn(),
	collectWebServer: vi.fn(),
	collectStorage: vi.fn(),
	collectGroupChats: vi.fn(),
	collectBatchState: vi.fn(),
	createZipPackage: vi.fn(),
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
vi.mock('../../../main/debug-package/collectors/windows-diagnostics', () => ({
	collectWindowsDiagnostics: mocks.collectWindowsDiagnostics,
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
vi.mock('../../../main/debug-package/packager', () => ({
	createZipPackage: mocks.createZipPackage,
}));
vi.mock('../../../main/utils/logger', () => ({
	logger: { error: vi.fn(), info: vi.fn() },
}));

import { generateDebugPackage } from '../../../main/debug-package';

const dependencies = {
	getAgentDetector: () => null,
	getProcessManager: () => null,
	getWebServer: () => null,
	settingsStore: {} as never,
	sessionsStore: {} as never,
	groupsStore: { get: vi.fn(() => []) } as never,
};

function configureSuccessfulCollectors(): void {
	mocks.collectSystemInfo.mockReturnValue({});
	mocks.collectSettings.mockResolvedValue({});
	mocks.collectAgents.mockResolvedValue([]);
	mocks.collectExternalTools.mockResolvedValue({});
	mocks.collectWindowsDiagnostics.mockResolvedValue({});
	mocks.collectSessions.mockResolvedValue([]);
	mocks.collectProcesses.mockResolvedValue([]);
	mocks.collectLogs.mockReturnValue([]);
	mocks.collectErrors.mockReturnValue([]);
	mocks.collectWebServer.mockResolvedValue({});
	mocks.collectStorage.mockResolvedValue({});
	mocks.collectGroupChats.mockResolvedValue([]);
	mocks.collectBatchState.mockReturnValue([]);
}

describe('generateDebugPackage collection orchestration', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		configureSuccessfulCollectors();
		mocks.createZipPackage.mockResolvedValue({
			path: '/tmp/maestro-debug.zip',
			sizeBytes: 123,
		});
	});

	it('keeps later categories and records a partial collector failure in the manifest', async () => {
		mocks.collectSettings.mockRejectedValue(new Error('settings unavailable'));

		const result = await generateDebugPackage('/tmp', dependencies);
		const contents = mocks.createZipPackage.mock.calls[0][1];

		expect(result).toMatchObject({
			success: true,
			filesIncluded: expect.arrayContaining(['system-info.json', 'processes.json']),
		});
		expect(contents).toMatchObject({
			'system-info.json': {},
			'processes.json': [],
			'collection-errors.json': {
				errors: ['settings: settings unavailable'],
			},
		});
		expect(result.filesIncluded).not.toContain('settings.json');
	});

	it('keeps explicit collector order and includes empty categories', async () => {
		const result = await generateDebugPackage('/tmp', dependencies);
		const contents = mocks.createZipPackage.mock.calls[0][1];

		expect(Object.keys(contents)).toEqual([
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
		]);
		expect(result.filesIncluded).toEqual(Object.keys(contents));
		expect(contents).toMatchObject({
			'sessions.json': [],
			'group-chats.json': [],
			'batch-state.json': [],
		});
	});

	it('skips disabled optional collectors without changing the remaining manifest order', async () => {
		await generateDebugPackage('/tmp', dependencies, {
			includeSessions: false,
			includeLogs: false,
			includeErrors: false,
			includeGroupChats: false,
			includeBatchState: false,
		});
		const contents = mocks.createZipPackage.mock.calls[0][1];

		expect(mocks.collectSessions).not.toHaveBeenCalled();
		expect(mocks.collectLogs).not.toHaveBeenCalled();
		expect(mocks.collectErrors).not.toHaveBeenCalled();
		expect(mocks.collectGroupChats).not.toHaveBeenCalled();
		expect(mocks.collectBatchState).not.toHaveBeenCalled();
		expect(Object.keys(contents)).toEqual([
			'system-info.json',
			'settings.json',
			'agents.json',
			'external-tools.json',
			'windows-diagnostics.json',
			'groups.json',
			'processes.json',
			'web-server.json',
			'storage-info.json',
		]);
	});
});
