/**
 * Tests for how generateDebugPackage fills the Auto Run section.
 *
 * A package main builds on its own (`maestro-cli support-package`, Feedback's
 * support package) passes no snapshots, so it must ask the app windows through
 * `deps.requestAutoRunSnapshots`. The desktop's Create Debug Package passes
 * snapshots in and must not trigger that request. Every other collector is
 * stubbed; the real batch-state collector writes what the zip would carry.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AutoRunDebugSnapshot } from '../../../shared/debugPackage';
import type { AutoRunSnapshotResult } from '../../../main/debug-package/autorun-snapshots';

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../main/agents', () => ({}));
vi.mock('../../../main/process-manager', () => ({}));
vi.mock('../../../main/web-server', () => ({}));
vi.mock('electron-store', () => ({ default: class {} }));

vi.mock('../../../main/debug-package/collectors/system', () => ({ collectSystemInfo: () => ({}) }));
vi.mock('../../../main/debug-package/collectors/settings', () => ({
	collectSettings: async () => ({}),
}));
vi.mock('../../../main/debug-package/collectors/agents', () => ({
	collectAgents: async () => ({}),
}));
vi.mock('../../../main/debug-package/collectors/external-tools', () => ({
	collectExternalTools: async () => ({}),
}));
vi.mock('../../../main/debug-package/collectors/windows-diagnostics', () => ({
	collectWindowsDiagnostics: async () => ({}),
}));
vi.mock('../../../main/debug-package/collectors/groups', () => ({ collectGroups: () => [] }));
vi.mock('../../../main/debug-package/collectors/sessions', () => ({
	collectSessions: async () => [],
}));
vi.mock('../../../main/debug-package/collectors/processes', () => ({
	collectProcesses: async () => [],
}));
vi.mock('../../../main/debug-package/collectors/logs', () => ({ collectLogs: () => ({}) }));
vi.mock('../../../main/debug-package/collectors/errors', () => ({ collectErrors: () => ({}) }));
vi.mock('../../../main/debug-package/collectors/web-server', () => ({
	collectWebServer: async () => ({}),
}));
vi.mock('../../../main/debug-package/collectors/storage', () => ({
	collectStorage: async () => ({}),
}));
vi.mock('../../../main/debug-package/collectors/group-chats', () => ({
	collectGroupChats: async () => [],
}));

const createZipPackage = vi.hoisted(() =>
	vi.fn(async (_outputDir: string, _contents: Record<string, unknown>) => ({
		path: '/tmp/maestro-debug.zip',
		sizeBytes: 1,
	}))
);
vi.mock('../../../main/debug-package/packager', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../main/debug-package/packager')>()),
	createZipPackage,
}));

import { generateDebugPackage, type DebugPackageDependencies } from '../../../main/debug-package';
import type { BatchStateInfo } from '../../../main/debug-package/collectors/batch-state';

const running = (sessionId: string): AutoRunDebugSnapshot =>
	({
		sessionId,
		isRunning: true,
		isStopping: false,
		hasError: false,
		errorPaused: false,
		documentCount: 2,
		completedTasksAcrossAllDocs: 1,
		totalTasksAcrossAllDocs: 4,
	}) as AutoRunDebugSnapshot;

const deps = (
	requestAutoRunSnapshots?: () => Promise<AutoRunSnapshotResult>
): DebugPackageDependencies =>
	({
		getAgentDetector: () => null,
		getProcessManager: () => null,
		getWebServer: () => null,
		settingsStore: {},
		sessionsStore: {},
		groupsStore: {},
		requestAutoRunSnapshots,
	}) as unknown as DebugPackageDependencies;

/** The batch state the last build handed to the packager. */
const writtenBatchState = (): BatchStateInfo | undefined => {
	const contents = createZipPackage.mock.calls.at(-1)?.[1] ?? {};
	return contents['batch-state.json'] as BatchStateInfo | undefined;
};

describe('generateDebugPackage Auto Run section', () => {
	beforeEach(() => {
		createZipPackage.mockClear();
	});

	it('fetches snapshots when none are supplied and writes them into the batch state', async () => {
		const request = vi.fn(
			async (): Promise<AutoRunSnapshotResult> => ({
				available: true,
				snapshots: [running('agent-1')],
				windowsAsked: 1,
				windowsAnswered: 1,
			})
		);

		const result = await generateDebugPackage('/tmp', deps(request));

		expect(result.success).toBe(true);
		expect(request).toHaveBeenCalledTimes(1);
		expect(writtenBatchState()).toMatchObject({
			snapshotAvailable: true,
			activeSessions: [expect.objectContaining({ sessionId: 'agent-1', isRunning: true })],
		});
		expect(writtenBatchState()?.unavailableReason).toBeUndefined();
	});

	it('does not make the request when snapshots are supplied', async () => {
		const request = vi.fn();

		await generateDebugPackage('/tmp', deps(request), { autoRunSnapshots: [running('agent-2')] });

		expect(request).not.toHaveBeenCalled();
		expect(writtenBatchState()).toMatchObject({
			snapshotAvailable: true,
			activeSessions: [expect.objectContaining({ sessionId: 'agent-2' })],
		});
	});

	it('does not make the request when the Auto Run section is off', async () => {
		const request = vi.fn();

		await generateDebugPackage('/tmp', deps(request), { includeBatchState: false });

		expect(request).not.toHaveBeenCalled();
		expect(writtenBatchState()).toBeUndefined();
	});

	it('writes the reason when no window can answer', async () => {
		const request = vi.fn(
			async (): Promise<AutoRunSnapshotResult> => ({
				available: false,
				reason: 'timeout',
				detail: 'No Maestro window answered the request for Auto Run state in time.',
				windowsAsked: 1,
			})
		);

		await generateDebugPackage('/tmp', deps(request));

		expect(writtenBatchState()).toEqual({
			snapshotAvailable: false,
			unavailableReason: 'timeout',
			unavailableDetail: 'No Maestro window answered the request for Auto Run state in time.',
			activeSessions: [],
		});
	});

	it('records not-requested for a build with neither snapshots nor a requester', async () => {
		await generateDebugPackage('/tmp', deps());

		expect(writtenBatchState()).toMatchObject({
			snapshotAvailable: false,
			unavailableReason: 'not-requested',
		});
	});
});
