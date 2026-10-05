/**
 * Tests for the `libraryRuntime` IPC handlers: the status every window asks for, and the runtime's
 * events forwarded to every window.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserWindow, ipcMain } from 'electron';
import { registerLibraryRuntimeHandlers } from '../../../../main/ipc/handlers/libraryRuntime';
import type { LibraryRuntimeHost } from '../../../../main/library-runtime';
import {
	LIBRARY_RUNTIME_EVENT_CHANNEL,
	LIBRARY_RUNTIME_STATUS_CHANNEL,
} from '../../../../shared/libraryRuntime';
import type { MaestroEvent } from '../../../../shared/maestro-lib/client/types';

vi.mock('electron', () => ({
	ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn() },
	BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));
vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../../main/utils/safe-send', () => ({
	isWebContentsAvailable: (window: { alive?: boolean }) => window.alive !== false,
}));

function handlerFor(channel: string): (...args: unknown[]) => Promise<unknown> {
	const call = vi.mocked(ipcMain.handle).mock.calls.find(([name]) => name === channel);
	if (!call) throw new Error(`no handler for ${channel}`);
	return call[1] as (...args: unknown[]) => Promise<unknown>;
}

interface EventSource {
	listener?: (event: MaestroEvent) => void;
	unsubscribe: ReturnType<typeof vi.fn>;
}

const eventSource = (): EventSource => ({ unsubscribe: vi.fn() });

function host(runtime: EventSource | null): LibraryRuntimeHost {
	return {
		status: () => (runtime ? { hosting: true } : { hosting: false, reason: 'The setting is off.' }),
		runtime: () =>
			runtime
				? ({
						events: {
							subscribe: (listener: (event: MaestroEvent) => void) => {
								runtime.listener = listener;
								return runtime.unsubscribe;
							},
						},
					} as never)
				: undefined,
		close: async () => undefined,
	};
}

describe('registerLibraryRuntimeHandlers', () => {
	beforeEach(() => {
		vi.mocked(ipcMain.handle).mockClear();
		vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([]);
	});

	it('answers status with {hosting: false} and a reason when the setting is off', async () => {
		registerLibraryRuntimeHandlers(host(null));
		await expect(handlerFor(LIBRARY_RUNTIME_STATUS_CHANNEL)({})).resolves.toEqual({
			hosting: false,
			reason: 'The setting is off.',
		});
	});

	it('answers status with {hosting: true} when a runtime is hosted', async () => {
		registerLibraryRuntimeHandlers(host(eventSource()));
		await expect(handlerFor(LIBRARY_RUNTIME_STATUS_CHANNEL)({})).resolves.toEqual({
			hosting: true,
		});
	});

	it('subscribes to nothing when no runtime is hosted', () => {
		const stop = registerLibraryRuntimeHandlers(host(null));
		expect(stop).toBeTypeOf('function');
		expect(() => stop()).not.toThrow();
	});

	it('forwards every runtime event to every live window, and skips a window that is gone', () => {
		const alive = { webContents: { send: vi.fn() } };
		const gone = { alive: false, webContents: { send: vi.fn() } };
		vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([alive, gone] as never);
		const source = eventSource();
		registerLibraryRuntimeHandlers(host(source));

		const event: MaestroEvent = { type: 'agent.removed', agentId: 'a1' };
		source.listener?.(event);

		expect(alive.webContents.send).toHaveBeenCalledWith(LIBRARY_RUNTIME_EVENT_CHANNEL, { event });
		expect(gone.webContents.send).not.toHaveBeenCalled();
	});

	it("returns the runtime's own unsubscribe, so quitting can stop the forwarding", () => {
		const source = eventSource();
		const stop = registerLibraryRuntimeHandlers(host(source));
		stop();
		expect(source.unsubscribe).toHaveBeenCalledTimes(1);
	});
});
