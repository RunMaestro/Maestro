// Source: src/__tests__/main/web-server/callbacks/autoRunControlCallbacks.test.ts
// Source: src/__tests__/main/web-server/callbacks/cadenzaMovementCallbacks.test.ts
import { beforeEach } from 'vitest';
import { describe } from 'vitest';
import { expect } from 'vitest';
import { it } from 'vitest';
import { vi } from 'vitest';
import { ipcMain } from 'electron';
import type { BrowserWindow } from 'electron';
import type { ControlAutoRunCallback } from '../../../../shared/autoRunRemote';
import type { StartAutoRunCallback } from '../../../../shared/autoRunRemote';
import type { BatchRunConfig } from '../../../../shared/types';
import { registerAutoRunControlCallbacks } from '../../../../main/web-server/callbacks/autoRunControlCallbacks';
import { registerCadenzaMovementCallbacks } from '../../../../main/web-server/callbacks/cadenzaMovementCallbacks';
import { broadcastBridgeEvent } from '../../../../main/web-server/handlers/bridgeHandlers';
import { clearConcertoHtmlDocumentsForTests } from '../../../../main/concerto-html';
import type { MovementPayload } from '../../../../shared/movement-types';
vi.mock('electron', () => ({
	ipcMain: { on: vi.fn(), once: vi.fn(), removeListener: vi.fn() },
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
describe('autoRunControlCallbacks', () => {
	const config: BatchRunConfig = {
		documents: [{ id: 'task', filename: 'task', resetOnCompletion: false, isDuplicate: false }],
		prompt: 'Complete the tasks',
		loopEnabled: false,
	};

	function renderer(ownsRun: boolean) {
		const webContents = {
			send: vi.fn((...args: unknown[]) => {
				const channel = args.at(-1);
				const listener = vi.mocked(ipcMain.on).mock.calls.find(([name]) => name === channel)?.[1];
				if (!listener) throw new Error('Missing response listener');
				listener(
					{ sender: webContents } as never,
					ownsRun ? { success: true } : { success: false, error: 'No host-owned Auto Run' }
				);
			}),
		};
		return { webContents } as unknown as BrowserWindow;
	}

	function setup(resolveOwner = true) {
		let start!: StartAutoRunCallback;
		let control!: ControlAutoRunCallback;
		const server = new Proxy(
			{},
			{
				get: (_target, name) => {
					if (name === 'setStartAutoRunCallback')
						return (callback: StartAutoRunCallback) => {
							start = callback;
						};
					if (name === 'setControlAutoRunCallback')
						return (callback: ControlAutoRunCallback) => {
							control = callback;
						};
					return () => {};
				},
			}
		);
		const primary = renderer(!resolveOwner);
		const owner = renderer(true);
		const getWindowForSession = vi.fn(() => owner);
		registerAutoRunControlCallbacks(server as never, {
			getMainWindow: () => primary,
			...(resolveOwner ? { getWindowForSession } : {}),
		});
		return { start, control, primary, owner, getWindowForSession };
	}

	describe('remote Auto Run window ownership', () => {
		beforeEach(() => vi.clearAllMocks());

		it('starts an agent in its owning secondary window', async () => {
			const { start, primary, owner, getWindowForSession } = setup();
			await expect(start('detached-agent', config, '/docs')).resolves.toEqual({ success: true });
			expect(getWindowForSession).toHaveBeenCalledWith('detached-agent');
			expect(primary.webContents.send).not.toHaveBeenCalled();
			expect(owner.webContents.send).toHaveBeenCalledWith(
				'remote:startAutoRun',
				'detached-agent',
				config,
				'/docs',
				expect.any(String)
			);
		});

		it('starts existing worktree runs in the execution target window while preserving source documents', async () => {
			const { start, owner, getWindowForSession } = setup();
			const worktreeConfig: BatchRunConfig = {
				...config,
				worktreeTarget: { mode: 'existing-open', sessionId: 'worktree-agent' },
			};
			await expect(start('source-agent', worktreeConfig, '/source/docs')).resolves.toEqual({
				success: true,
			});
			expect(getWindowForSession).toHaveBeenCalledWith('worktree-agent');
			expect(owner.webContents.send).toHaveBeenCalledWith(
				'remote:startAutoRun',
				'source-agent',
				worktreeConfig,
				'/source/docs',
				expect.any(String)
			);
		});

		it('controls the running agent in its owning secondary window', async () => {
			const { control, primary, owner, getWindowForSession } = setup();
			await expect(control('detached-agent', { action: 'stop' })).resolves.toEqual({
				success: true,
			});
			expect(getWindowForSession).toHaveBeenCalledWith('detached-agent');
			expect(primary.webContents.send).not.toHaveBeenCalled();
			expect(owner.webContents.send).toHaveBeenCalledWith(
				'remote:controlAutoRun',
				'detached-agent',
				{ action: 'stop' },
				expect.any(String)
			);
		});

		it('preserves primary-window routing without a session-window resolver', async () => {
			const { start, control, primary, owner } = setup(false);
			await expect(start('primary-agent', config, '/docs')).resolves.toEqual({ success: true });
			await expect(control('primary-agent', { action: 'resume' })).resolves.toEqual({
				success: true,
			});
			expect(primary.webContents.send).toHaveBeenCalledTimes(2);
			expect(owner.webContents.send).not.toHaveBeenCalled();
		});
	});
});
describe('cadenzaMovementCallbacks', () => {
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
			expect(
				await movementCallback({ op: 'add', id: 'mockup', viewType: 'view', body: '{}' })
			).toBe(false);

			expect(mockedBroadcast).not.toHaveBeenCalled();
		});
	});
});
