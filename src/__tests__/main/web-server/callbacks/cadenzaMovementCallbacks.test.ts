/** Remote Movement writes must honor the host's enabled feature state. */

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

	it('stays inert while the Concerto Encore Feature is off', async () => {
		const { movementCallback } = setup({ concerto: false });
		expect(await movementCallback({ op: 'add', id: 'mockup', viewType: 'view', body: '{}' })).toBe(
			false
		);

		expect(mockedBroadcast).not.toHaveBeenCalled();
	});
});
