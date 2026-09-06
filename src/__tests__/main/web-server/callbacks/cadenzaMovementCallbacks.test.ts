/**
 * Movement payloads reach the Electron renderer through a direct
 * `webContents.send`, which bypasses `safeSend` and therefore the web-desktop
 * bridge fanout. Without an explicit broadcast a browser client's Movement
 * store stays empty forever, and every `maestro://concerto/movement/<id>` chip
 * reports the panel as unavailable (#1442).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
	ipcMain: { once: vi.fn(), removeListener: vi.fn() },
}));

vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../../main/utils/safe-send', () => ({
	isWebContentsAvailable: vi.fn(() => true),
}));

vi.mock('../../../../main/web-server/handlers/bridgeHandlers', () => ({
	broadcastBridgeEvent: vi.fn(),
}));

import { registerCadenzaMovementCallbacks } from '../../../../main/web-server/callbacks/cadenzaMovementCallbacks';
import { broadcastBridgeEvent } from '../../../../main/web-server/handlers/bridgeHandlers';
import { clearConcertoHtmlDocumentsForTests } from '../../../../main/concerto-html';
import type { MovementPayload } from '../../../../shared/movement-types';

const mockedBroadcast = vi.mocked(broadcastBridgeEvent);

type MovementCallback = (params: MovementPayload) => Promise<boolean>;

function setup(options: { concerto?: boolean; mainWindow?: unknown } = {}) {
	const { concerto = true, mainWindow = { webContents: { send: vi.fn() } } } = options;
	let movementCallback: MovementCallback | undefined;
	// Auto-stub every setter the registrar reaches for, so adding an unrelated
	// Concerto callback upstream doesn't fail this suite.
	const server = new Proxy(
		{},
		{
			get: (_target, prop: string) =>
				prop === 'setMovementViewCallback'
					? (cb: MovementCallback) => {
							movementCallback = cb;
						}
					: () => {},
		}
	);
	registerCadenzaMovementCallbacks(
		server as never,
		{
			settingsStore: { get: () => ({ concerto }) } as never,
			getMainWindow: () => mainWindow as never,
			deliverCadenza: undefined,
		} as never
	);
	return { movementCallback: movementCallback! };
}

describe('movement view callback', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		clearConcertoHtmlDocumentsForTests();
	});

	it('fans an HTML movement out to web-desktop bridge clients', async () => {
		const { movementCallback } = setup();
		void movementCallback({
			op: 'add',
			id: 'mockup',
			viewType: 'html',
			body: '<button>Buy</button>',
		});
		// The renderer ack is awaited on a timeout; the fanout is synchronous.
		await Promise.resolve();

		expect(mockedBroadcast).toHaveBeenCalledTimes(1);
		const [channel, args] = mockedBroadcast.mock.calls[0];
		expect(channel).toBe('remote:movement');
		expect(args).toHaveLength(1);
		// The broadcast carries the HTML-routed payload, so a browser client sees
		// the same revision the desktop renderer does.
		expect((args[0] as MovementPayload).id).toBe('mockup');
		expect((args[0] as MovementPayload & { revision?: number }).revision).toBe(1);
	});

	it('sends no response channel, which a bridge client could not answer', async () => {
		const { movementCallback } = setup();
		void movementCallback({ op: 'move', id: 'mockup', x: 10, y: 20 });
		await Promise.resolve();

		expect(mockedBroadcast.mock.calls[0][1]).toHaveLength(1);
	});

	it('stays inert while the Concerto Encore Feature is off', async () => {
		const { movementCallback } = setup({ concerto: false });
		await movementCallback({ op: 'add', id: 'mockup', viewType: 'view', body: '{}' });

		expect(mockedBroadcast).not.toHaveBeenCalled();
	});
});
