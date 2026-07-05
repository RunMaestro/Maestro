/**
 * Tests for the browser-session IPC handler (browser:clearSessionData).
 *
 * Contracts defended:
 * - Only the two FULL minted partition shapes may be cleared; a bare prefix or
 *   any foreign partition is rejected so a misbehaving caller cannot wipe
 *   unrelated storage (including Maestro's own default session).
 * - Only a top-level window webContents may invoke the handler; webview guests
 *   are rejected outright.
 * - A valid request clears BOTH storage data and the HTTP cache.
 * - Electron failures surface as { ok:false, error } instead of throwing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ipcMain, session } from 'electron';
import { registerBrowserSessionHandlers } from '../../../../main/ipc/handlers/browser-session';

vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn(),
	},
	session: {
		fromPartition: vi.fn(),
	},
}));

vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

interface FakeIpcEvent {
	sender: { getType: () => string };
}

type ClearSessionDataHandler = (
	event: FakeIpcEvent,
	partition: unknown
) => Promise<{ ok: boolean; error?: string }>;

const windowEvent: FakeIpcEvent = { sender: { getType: () => 'window' } };

describe('browser-session IPC handlers', () => {
	let handler: ClearSessionDataHandler;
	let mockTabSession: {
		clearStorageData: ReturnType<typeof vi.fn>;
		clearCache: ReturnType<typeof vi.fn>;
	};

	beforeEach(() => {
		vi.clearAllMocks();

		mockTabSession = {
			clearStorageData: vi.fn(async () => undefined),
			clearCache: vi.fn(async () => undefined),
		};
		vi.mocked(session.fromPartition).mockReturnValue(
			// Minimal structural stand-in for Electron's Session; the handler only
			// touches these two methods.
			mockTabSession as unknown as Electron.Session
		);

		registerBrowserSessionHandlers();

		const registration = vi
			.mocked(ipcMain.handle)
			.mock.calls.find(([channel]) => channel === 'browser:clearSessionData');
		expect(registration).toBeDefined();
		// Electron types the registered listener loosely; this suite drives it
		// with the handler's actual (event, partition) signature.
		handler = registration?.[1] as unknown as ClearSessionDataHandler;
	});

	it('clears storage data AND cache for a valid persistent browser-tab partition', async () => {
		const res = await handler(windowEvent, 'persist:maestro-browser-session-sess-1');
		expect(res).toEqual({ ok: true });
		expect(session.fromPartition).toHaveBeenCalledWith('persist:maestro-browser-session-sess-1');
		expect(mockTabSession.clearStorageData).toHaveBeenCalled();
		expect(mockTabSession.clearCache).toHaveBeenCalled();
	});

	it('accepts a fully-minted ephemeral partition', async () => {
		const res = await handler(windowEvent, 'maestro-ephemeral-sess-1-a1b2c3d4');
		expect(res).toEqual({ ok: true });
		expect(session.fromPartition).toHaveBeenCalledWith('maestro-ephemeral-sess-1-a1b2c3d4');
	});

	it('rejects partitions that do not match the FULL minted shapes', async () => {
		const rejected: Array<{ name: string; partition: unknown }> = [
			{ name: 'bare ephemeral prefix', partition: 'maestro-ephemeral-x' },
			{ name: 'ephemeral without random suffix', partition: 'maestro-ephemeral-sess-1-' },
			{ name: 'ephemeral with uppercase suffix', partition: 'maestro-ephemeral-sess-1-A1B2C3D4' },
			{ name: 'foreign persist partition', partition: 'persist:evil' },
			{ name: 'bare persistent prefix', partition: 'persist:maestro-browser-session-' },
			{
				name: 'persistent with illegal characters',
				partition: 'persist:maestro-browser-session-a/b',
			},
			{ name: 'empty string (default session)', partition: '' },
			{ name: 'non-string payload', partition: 42 },
		];
		for (const c of rejected) {
			const res = await handler(windowEvent, c.partition);
			expect(res, c.name).toEqual({ ok: false, error: 'Invalid browser tab partition' });
		}
		expect(session.fromPartition).not.toHaveBeenCalled();
		expect(mockTabSession.clearStorageData).not.toHaveBeenCalled();
	});

	it('rejects senders that are not a top-level window', async () => {
		const guestEvent: FakeIpcEvent = { sender: { getType: () => 'webview' } };
		const res = await handler(guestEvent, 'persist:maestro-browser-session-sess-1');
		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/not allowed/i);
		expect(session.fromPartition).not.toHaveBeenCalled();
	});

	it('surfaces Electron failures as ok:false with the error message', async () => {
		mockTabSession.clearStorageData.mockRejectedValueOnce(new Error('disk on fire'));
		const res = await handler(windowEvent, 'persist:maestro-browser-session-sess-1');
		expect(res).toEqual({ ok: false, error: 'disk on fire' });
		// The cache clear never ran: storage clearing failed first.
		expect(mockTabSession.clearCache).not.toHaveBeenCalled();
	});
});
