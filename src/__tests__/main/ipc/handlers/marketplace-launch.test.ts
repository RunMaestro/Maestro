/**
 * The Playbook Launch IPC channels in src/main/ipc/handlers/marketplace.ts: each one hands its
 * arguments, as they came, to the marketplace service function the web bridge calls too, with the
 * launch host the app built, and answers in the `{ success, ... }` shape of the other marketplace
 * channels. The service itself is tested in src/__tests__/main/services/marketplace-service.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ipcMain, type App } from 'electron';

const { service } = vi.hoisted(() => ({
	service: {
		getMarketplaceManifest: vi.fn(),
		refreshMarketplaceManifest: vi.fn(),
		getMarketplaceDocument: vi.fn(),
		getMarketplaceReadme: vi.fn(),
		importMarketplacePlaybook: vi.fn(),
		createLocalManifestWatcher: vi.fn(() => ({ stop: vi.fn() })),
		launchMarketplacePlaybook: vi.fn(),
		completeMarketplaceLaunch: vi.fn(),
		getMarketplaceLaunch: vi.fn(),
		listMarketplaceLaunches: vi.fn(),
	},
}));

vi.mock('electron', () => ({
	ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
	app: { getPath: vi.fn(), on: vi.fn() },
}));
vi.mock('electron-store', () => ({ default: vi.fn() }));
vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../../main/services/marketplace-service', () => service);

import { registerMarketplaceHandlers } from '../../../../main/ipc/handlers/marketplace';
import type { MarketplaceLaunchHost } from '../../../../main/services/marketplace-service';
import {
	MarketplaceImportError,
	MarketplaceLaunchBusyError,
	type PlaybookLaunchCompletion,
	type PlaybookLaunchRecord,
	type PlaybookLaunchRequest,
} from '../../../../shared/marketplace-types';

describe('Playbook Launch IPC handlers', () => {
	let handlers: Map<string, (...args: unknown[]) => Promise<any>>;
	let app: App;
	let launchHost: MarketplaceLaunchHost;

	/** Call a registered channel as ipcMain would, with an IPC event first. */
	const invoke = (channel: string, ...args: unknown[]) => {
		const handler = handlers.get(channel);
		if (!handler) throw new Error(`No handler registered for ${channel}`);
		return handler({}, ...args);
	};

	const record = {
		launchId: 'launch-1',
		playbookId: 'research-market',
		playbookTitle: 'Market Research',
		sessionId: 'agent-1',
		folderRelativePath: 'market-research-launch-20261111-093000',
		autoRunFolderPath: '/projects/app/.maestro/playbooks',
		status: 'completed',
		startedAt: 1_000,
		finishedAt: 2_000,
		cleanup: 'done',
	} as PlaybookLaunchRecord;

	const completion: PlaybookLaunchCompletion = {
		completedTasks: 3,
		totalTasks: 3,
		elapsedTimeMs: 90_000,
		totalCostUsd: 0.5,
		wasStopped: false,
	};

	beforeEach(() => {
		vi.clearAllMocks();
		handlers = new Map();
		vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
			handlers.set(channel, handler as (...args: unknown[]) => Promise<any>);
		});
		app = { getPath: vi.fn(() => '/mock/userData'), on: vi.fn() } as unknown as App;
		launchHost = {
			app,
			startAutoRun: vi.fn(),
			isMaestroCliInstalled: vi.fn(),
			onLaunchChanged: vi.fn(),
		};
		registerMarketplaceHandlers({ app, launchHost });
	});

	it('registers the four launch channels beside the import channels', () => {
		for (const channel of [
			'marketplace:importPlaybook',
			'marketplace:launch',
			'marketplace:completeLaunch',
			'marketplace:getLaunch',
			'marketplace:listLaunches',
		]) {
			expect(handlers.has(channel)).toBe(true);
		}
	});

	describe('marketplace:launch', () => {
		const request: PlaybookLaunchRequest = {
			playbookId: 'research-market',
			values: { MARKET_TOPIC: 'EV chargers' },
			sessionId: 'agent-1',
			autoRunFolderPath: '/projects/app/.maestro/playbooks',
			keepSavedPlaybook: true,
		};

		it('launches with the request as sent and the app launch host', async () => {
			service.launchMarketplacePlaybook.mockResolvedValue({
				launchId: 'launch-1',
				folderRelativePath: 'market-research-launch-20261111-093000',
			});

			await expect(invoke('marketplace:launch', request)).resolves.toEqual({
				success: true,
				launchId: 'launch-1',
				folderRelativePath: 'market-research-launch-20261111-093000',
			});
			expect(service.launchMarketplacePlaybook).toHaveBeenCalledWith(request, launchHost);
		});

		it('answers a refused launch with its message', async () => {
			service.launchMarketplacePlaybook.mockRejectedValue(
				new MarketplaceLaunchBusyError({ launchId: 'launch-0', playbookTitle: 'Market Research' })
			);

			const result = await invoke('marketplace:launch', request);

			expect(result.success).toBe(false);
			expect(result.error).toContain(
				'This agent is already running the "Market Research" launch (launch-0).'
			);
		});
	});

	describe('marketplace:completeLaunch', () => {
		it('ends the launch through the service with the app launch host, which broadcasts it', async () => {
			service.completeMarketplaceLaunch.mockResolvedValue(record);

			await expect(invoke('marketplace:completeLaunch', 'launch-1', completion)).resolves.toEqual({
				success: true,
				launch: record,
			});
			expect(service.completeMarketplaceLaunch).toHaveBeenCalledWith(
				'launch-1',
				completion,
				launchHost
			);
			// The broadcast is the service's, through the host, so the web bridge path sends it too.
			expect(launchHost.onLaunchChanged).not.toHaveBeenCalled();
		});

		it('answers a refusal with its message', async () => {
			service.completeMarketplaceLaunch.mockRejectedValue(
				new MarketplaceImportError('Launch not found: launch-9')
			);

			const result = await invoke('marketplace:completeLaunch', 'launch-9', completion);

			expect(result.success).toBe(false);
			expect(result.error).toContain('Launch not found: launch-9');
		});
	});

	describe('marketplace:getLaunch', () => {
		it('reads one launch record', async () => {
			service.getMarketplaceLaunch.mockResolvedValue(record);

			await expect(invoke('marketplace:getLaunch', 'launch-1')).resolves.toEqual({
				success: true,
				launch: record,
			});
			expect(service.getMarketplaceLaunch).toHaveBeenCalledWith(app, 'launch-1');
		});

		it('answers an unknown launch with its message', async () => {
			service.getMarketplaceLaunch.mockRejectedValue(
				new MarketplaceImportError('Launch not found: nope')
			);

			const result = await invoke('marketplace:getLaunch', 'nope');

			expect(result).toMatchObject({ success: false });
			expect(result.error).toContain('Launch not found: nope');
		});
	});

	describe('marketplace:listLaunches', () => {
		it('lists launch records with the options as sent', async () => {
			service.listMarketplaceLaunches.mockResolvedValue([record]);

			await expect(
				invoke('marketplace:listLaunches', { sessionId: 'agent-1', limit: 5 })
			).resolves.toEqual({ success: true, launches: [record] });
			expect(service.listMarketplaceLaunches).toHaveBeenCalledWith(app, {
				sessionId: 'agent-1',
				limit: 5,
			});
		});

		it('lists every launch when called without options', async () => {
			service.listMarketplaceLaunches.mockResolvedValue([]);

			await expect(invoke('marketplace:listLaunches')).resolves.toEqual({
				success: true,
				launches: [],
			});
			expect(service.listMarketplaceLaunches).toHaveBeenCalledWith(app, undefined);
		});

		it('answers bad options with their message', async () => {
			service.listMarketplaceLaunches.mockRejectedValue(
				new MarketplaceImportError('limit must be a positive whole number, not 0')
			);

			const result = await invoke('marketplace:listLaunches', { limit: 0 });

			expect(result.success).toBe(false);
			expect(result.error).toContain('limit must be a positive whole number, not 0');
		});
	});
});
