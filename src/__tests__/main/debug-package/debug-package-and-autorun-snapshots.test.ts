// Source: src/__tests__/main/debug-package/generate.test.ts
// Source: src/__tests__/main/debug-package/autorun-snapshots.test.ts
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { beforeEach } from 'vitest';
import { vi } from 'vitest';
import type { AutoRunDebugSnapshot } from '../../../shared/debugPackage';
import type { AutoRunSnapshotResult } from '../../../main/debug-package/autorun-snapshots';
import { generateDebugPackage } from '../../../main/debug-package';
import type { DebugPackageDependencies } from '../../../main/debug-package';
import type { BatchStateInfo } from '../../../main/debug-package/collectors/batch-state';
import { afterEach } from 'vitest';
import type { BrowserWindow } from 'electron';
import type { AutoRunSnapshotReply } from '../../../shared/debugPackage';
import { requestAutoRunSnapshots } from '../../../main/debug-package/autorun-snapshots';
import { AUTO_RUN_SNAPSHOT_TIMEOUT_MS } from '../../../main/debug-package/autorun-snapshots';
import type { AutoRunSnapshotWindow } from '../../../main/debug-package/autorun-snapshots';
import { AUTO_RUN_SNAPSHOT_REQUEST_CHANNEL } from '../../../shared/debugPackage';
const createZipPackage = vi.hoisted(() =>
	vi.fn(async (_outputDir: string, _contents: Record<string, unknown>) => ({
		path: '/tmp/maestro-debug.zip',
		sizeBytes: 1,
	}))
);
const listeners = vi.hoisted(
	() => new Map<string, (event: { sender: unknown }, raw: unknown) => void>()
);
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
vi.mock('../../../main/debug-package/packager', () => ({ createZipPackage }));
vi.mock('electron', () => ({
	ipcMain: {
		on: vi.fn((channel: string, listener: (event: { sender: unknown }, raw: unknown) => void) => {
			listeners.set(channel, listener);
		}),
		removeListener: vi.fn((channel: string) => {
			listeners.delete(channel);
		}),
	},
}));
vi.mock('../../../main/utils/safe-send', () => ({
	isWebContentsAvailable: (win: BrowserWindow | null | undefined) =>
		!!(win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()),
}));
describe('generate', () => {
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
});
describe('autorun-snapshots', () => {
	const snapshot = (
		sessionId: string,
		overrides: Partial<AutoRunDebugSnapshot> = {}
	): AutoRunDebugSnapshot =>
		({
			sessionId,
			isRunning: false,
			isStopping: false,
			hasError: false,
			errorPaused: false,
			documentCount: 1,
			...overrides,
		}) as AutoRunDebugSnapshot;

	/**
	 * A fake app window. `answer` decides what it does with a request: reply at
	 * once, stay silent, or tear itself down. `destroyed` makes it a dead window.
	 */
	function fakeWindow(
		id: string,
		answer: AutoRunSnapshotReply | 'silent' | 'destroy-on-send' | unknown,
		{ destroyed = false } = {}
	): AutoRunSnapshotWindow & { send: ReturnType<typeof vi.fn> } {
		let isDestroyed = destroyed;
		const webContents = {
			isDestroyed: () => isDestroyed,
			send: vi.fn(),
		};
		webContents.send.mockImplementation((channel: string, responseChannel: string) => {
			expect(channel).toBe(AUTO_RUN_SNAPSHOT_REQUEST_CHANNEL);
			if (answer === 'silent') return;
			if (answer === 'destroy-on-send') {
				isDestroyed = true;
				throw new Error('Object has been destroyed');
			}
			listeners.get(responseChannel)?.({ sender: webContents }, answer);
		});
		const browserWindow = {
			isDestroyed: () => isDestroyed,
			webContents,
		} as unknown as BrowserWindow;
		return { id, browserWindow, send: webContents.send };
	}

	describe('requestAutoRunSnapshots', () => {
		beforeEach(() => {
			listeners.clear();
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it('resolves with the renderer reply', async () => {
			const win = fakeWindow('w1', {
				ok: true,
				snapshots: [snapshot('agent-1', { isRunning: true })],
			});

			const result = await requestAutoRunSnapshots([win]);

			expect(result).toEqual({
				available: true,
				snapshots: [expect.objectContaining({ sessionId: 'agent-1', isRunning: true })],
				windowsAsked: 1,
				windowsAnswered: 1,
			});
			expect(win.send).toHaveBeenCalledTimes(1);
			expect(listeners.size).toBe(0);
		});

		it('reports no-window without waiting when no window exists', async () => {
			const result = await requestAutoRunSnapshots([]);

			expect(result).toMatchObject({ available: false, reason: 'no-window', windowsAsked: 0 });
		});

		it('reports no-window for a destroyed window without sending', async () => {
			const win = fakeWindow('w1', 'silent', { destroyed: true });

			const result = await requestAutoRunSnapshots([win]);

			expect(result).toMatchObject({ available: false, reason: 'no-window', windowsAsked: 1 });
			expect(win.send).not.toHaveBeenCalled();
		});

		it('reports no-window when the window is torn down mid-request', async () => {
			const win = fakeWindow('w1', 'destroy-on-send');

			const result = await requestAutoRunSnapshots([win]);

			expect(result).toMatchObject({ available: false, reason: 'no-window' });
		});

		it('times out to an unavailable result with reason timeout', async () => {
			vi.useFakeTimers();
			const win = fakeWindow('w1', 'silent');

			const pending = requestAutoRunSnapshots([win]);
			await vi.advanceTimersByTimeAsync(AUTO_RUN_SNAPSHOT_TIMEOUT_MS);
			const result = await pending;

			expect(result).toMatchObject({ available: false, reason: 'timeout', windowsAsked: 1 });
			if (!result.available) expect(result.detail).toMatch(/in time/);
			expect(listeners.size).toBe(0);
		});

		it('honors a custom timeout', async () => {
			vi.useFakeTimers();
			const pending = requestAutoRunSnapshots([fakeWindow('w1', 'silent')], { timeoutMs: 50 });
			await vi.advanceTimersByTimeAsync(50);

			await expect(pending).resolves.toMatchObject({ reason: 'timeout' });
		});

		it('reports a renderer error with its sanitized text', async () => {
			const win = fakeWindow('w1', { ok: false, error: 'capture failed' });

			const result = await requestAutoRunSnapshots([win]);

			expect(result).toMatchObject({ available: false, reason: 'renderer-error' });
			if (!result.available) expect(result.detail).toContain('capture failed');
		});

		it('treats a malformed reply as a renderer error', async () => {
			const result = await requestAutoRunSnapshots([fakeWindow('w1', { nope: true })]);

			expect(result).toMatchObject({ available: false, reason: 'renderer-error' });
			if (!result.available) expect(result.detail).toMatch(/malformed/);
		});

		it('uses the windows that answered and counts the ones that did not', async () => {
			vi.useFakeTimers();
			const pending = requestAutoRunSnapshots([
				fakeWindow('w1', { ok: true, snapshots: [snapshot('agent-1')] }),
				fakeWindow('w2', 'silent'),
			]);
			await vi.advanceTimersByTimeAsync(AUTO_RUN_SNAPSHOT_TIMEOUT_MS);

			await expect(pending).resolves.toMatchObject({
				available: true,
				windowsAsked: 2,
				windowsAnswered: 1,
				snapshots: [expect.objectContaining({ sessionId: 'agent-1' })],
			});
		});

		describe('merging two windows that hold the same agent', () => {
			it('prefers the active entry', async () => {
				const result = await requestAutoRunSnapshots([
					fakeWindow('w1', {
						ok: true,
						snapshots: [snapshot('agent-1', { lastActiveTimestamp: 9 })],
					}),
					fakeWindow('w2', {
						ok: true,
						snapshots: [snapshot('agent-1', { isRunning: true, lastActiveTimestamp: 1 })],
					}),
				]);

				expect(result.available && result.snapshots).toEqual([
					expect.objectContaining({ sessionId: 'agent-1', isRunning: true }),
				]);
			});

			it('prefers the owning window when both are equally active', async () => {
				const result = await requestAutoRunSnapshots(
					[
						fakeWindow('w1', {
							ok: true,
							snapshots: [snapshot('agent-1', { documentCount: 1, lastActiveTimestamp: 9 })],
						}),
						fakeWindow('w2', {
							ok: true,
							snapshots: [snapshot('agent-1', { documentCount: 2, lastActiveTimestamp: 1 })],
						}),
					],
					{ ownerOf: () => 'w2' }
				);

				expect(result.available && result.snapshots).toEqual([
					expect.objectContaining({ documentCount: 2 }),
				]);
			});

			it('falls back to the newer lastActiveTimestamp', async () => {
				const result = await requestAutoRunSnapshots([
					fakeWindow('w1', {
						ok: true,
						snapshots: [snapshot('agent-1', { documentCount: 1, lastActiveTimestamp: 1 })],
					}),
					fakeWindow('w2', {
						ok: true,
						snapshots: [snapshot('agent-1', { documentCount: 2, lastActiveTimestamp: 9 })],
					}),
				]);

				expect(result.available && result.snapshots).toEqual([
					expect.objectContaining({ documentCount: 2 }),
				]);
			});
		});
	});
});
