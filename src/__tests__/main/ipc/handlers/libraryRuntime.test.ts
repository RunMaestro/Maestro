/**
 * Tests for the `libraryRuntime` IPC handlers: the status every window asks for, and the runtime's
 * events forwarded to every window.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserWindow, ipcMain } from 'electron';
import { registerLibraryRuntimeHandlers } from '../../../../main/ipc/handlers/libraryRuntime';
import type { LibraryRuntimeHost } from '../../../../main/library-runtime';
import type { DesktopBinding } from '../../../../main/library-runtime/desktop-binding';
import {
	LIBRARY_RUNTIME_COMMAND_CHANNEL,
	LIBRARY_RUNTIME_EVENT_CHANNEL,
	LIBRARY_RUNTIME_FOLD_CHANNEL,
	LIBRARY_RUNTIME_SNAPSHOT_CHANNEL,
	LIBRARY_RUNTIME_STATUS_CHANNEL,
	type LibraryRuntimeEventMessage,
} from '../../../../shared/libraryRuntime';

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
const broadcastBridgeEvent = vi.fn();
vi.mock('../../../../main/web-server/handlers/bridgeHandlers', () => ({
	broadcastBridgeEvent: (...args: unknown[]) => broadcastBridgeEvent(...args),
}));
vi.mock('../../../../main/stores/deferred-session-content', () => ({
	projectWebSession: (session: Record<string, unknown>) => ({ ...session, thin: true }),
}));

function handlerFor(channel: string): (...args: unknown[]) => Promise<unknown> {
	const call = vi.mocked(ipcMain.handle).mock.calls.find(([name]) => name === channel);
	if (!call) throw new Error(`no handler for ${channel}`);
	return call[1] as (...args: unknown[]) => Promise<unknown>;
}

const host = (hosting: boolean): LibraryRuntimeHost => ({
	status: () => (hosting ? { hosting: true } : { hosting: false, reason: 'The setting is off.' }),
	runtime: () => undefined,
	close: async () => undefined,
});

interface FakeBinding extends DesktopBinding {
	emit(message: LibraryRuntimeEventMessage): void;
	unsubscribe: ReturnType<typeof vi.fn>;
}

function binding(): FakeBinding {
	let listener: ((message: LibraryRuntimeEventMessage) => void) | undefined;
	const unsubscribe = vi.fn();
	return {
		onEvent: (next: (message: LibraryRuntimeEventMessage) => void) => {
			listener = next;
			return unsubscribe;
		},
		emit: (message: LibraryRuntimeEventMessage) => listener?.(message),
		unsubscribe,
		snapshot: vi.fn(),
		loadSnapshot: vi.fn(async () => ({
			agents: [{ id: 'a1', name: 'One', toolType: 'claude-code' }],
			groups: [],
			activeSessionId: 'a1',
			revs: { a1: 2 },
			groupsRev: 0,
		})),
		command: vi.fn(async () => ({ result: { ok: true, value: undefined }, changes: [] })),
		fold: vi.fn(async () => ({ ok: true, revs: {}, groupsRev: 0, drift: [] })),
		writeSessions: vi.fn(),
		foldLegacySessions: vi.fn(),
		foldLegacyGroups: vi.fn(),
		setActiveSessionId: vi.fn(),
		flush: vi.fn(),
		dispose: vi.fn(),
	} as unknown as FakeBinding;
}

describe('registerLibraryRuntimeHandlers', () => {
	beforeEach(() => {
		vi.mocked(ipcMain.handle).mockClear();
		broadcastBridgeEvent.mockClear();
		vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([]);
	});

	it('answers status with {hosting: false} and a reason when the setting is off', async () => {
		registerLibraryRuntimeHandlers(host(false));
		await expect(handlerFor(LIBRARY_RUNTIME_STATUS_CHANNEL)({})).resolves.toEqual({
			hosting: false,
			reason: 'The setting is off.',
		});
	});

	it('registers no command, snapshot, or fold channel without a binding', () => {
		const stop = registerLibraryRuntimeHandlers(host(false));
		const channels = vi.mocked(ipcMain.handle).mock.calls.map(([name]) => name);
		expect(channels).toEqual([LIBRARY_RUNTIME_STATUS_CHANNEL]);
		expect(() => stop()).not.toThrow();
	});

	it('answers status with {hosting: true} when a runtime is hosted', async () => {
		registerLibraryRuntimeHandlers(host(true), binding());
		await expect(handlerFor(LIBRARY_RUNTIME_STATUS_CHANNEL)({})).resolves.toEqual({
			hosting: true,
		});
	});

	it('forwards every stamped event to every live window and the bridge, and skips a window that is gone', () => {
		const alive = { webContents: { send: vi.fn() } };
		const gone = { alive: false, webContents: { send: vi.fn() } };
		vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([alive, gone] as never);
		const source = binding();
		registerLibraryRuntimeHandlers(host(true), source);

		const message: LibraryRuntimeEventMessage = {
			event: { type: 'agent.removed', agentId: 'a1' },
			origin: { commandId: 'c-1' },
		};
		source.emit(message);

		expect(alive.webContents.send).toHaveBeenCalledWith(LIBRARY_RUNTIME_EVENT_CHANNEL, message);
		expect(gone.webContents.send).not.toHaveBeenCalled();
		expect(broadcastBridgeEvent).toHaveBeenCalledWith(LIBRARY_RUNTIME_EVENT_CHANNEL, [message]);
	});

	it("returns the binding's own unsubscribe, so quitting can stop the forwarding", () => {
		const source = binding();
		const stop = registerLibraryRuntimeHandlers(host(true), source);
		stop();
		expect(source.unsubscribe).toHaveBeenCalledTimes(1);
	});

	it('runs a command through the binding and answers what it answers', async () => {
		const source = binding();
		registerLibraryRuntimeHandlers(host(true), source);
		const request = {
			commandId: 'c-1',
			command: { method: 'agents.rename', agentId: 'a1', name: 'Two' },
		} as const;
		await expect(handlerFor(LIBRARY_RUNTIME_COMMAND_CHANNEL)({}, request)).resolves.toEqual({
			result: { ok: true, value: undefined },
			changes: [],
		});
		expect(source.command).toHaveBeenCalledWith(request);
	});

	it('lands a fold through the binding', async () => {
		const source = binding();
		registerLibraryRuntimeHandlers(host(true), source);
		const fold = { agents: [] };
		await handlerFor(LIBRARY_RUNTIME_FOLD_CHANNEL)({}, fold);
		expect(source.fold).toHaveBeenCalledWith(fold);
	});

	it('gives a window the full snapshot and a web-desktop client the thin projection', async () => {
		registerLibraryRuntimeHandlers(host(true), binding());
		const snapshot = handlerFor(LIBRARY_RUNTIME_SNAPSHOT_CHANNEL);
		const desktop = (await snapshot({ sender: { id: 1 } })) as {
			agents: Array<Record<string, unknown>>;
		};
		expect(desktop.agents[0]).not.toHaveProperty('thin');
		const web = (await snapshot({})) as { agents: Array<Record<string, unknown>>; revs: unknown };
		expect(web.agents[0]).toMatchObject({ id: 'a1', thin: true });
		expect(web.revs).toEqual({ a1: 2 });
	});
});
