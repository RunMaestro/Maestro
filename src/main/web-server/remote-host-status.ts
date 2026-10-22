import { app, ipcMain } from 'electron';
import { hostname } from 'node:os';
import { getBootstrapStore } from '../stores/getters';
import { isWebContentsAvailable } from '../utils/safe-send';
import { isBrowserRelayReady } from '../browser/browser-relay';
import { requestFromRenderer } from './callbacks/remoteRequest';
import { getOrCreateHostInstanceId } from './host-identity';
import type { RemoteHostStatus } from './routes/liteRoutes';
import type { WebServerFactoryDependencies } from './web-server-factory';

export function createRemoteHostStatusProvider(
	deps: Pick<WebServerFactoryDependencies, 'getMainWindow' | 'getProcessManager'>
): () => Promise<RemoteHostStatus> {
	return async () => {
		const instanceId = getOrCreateHostInstanceId(getBootstrapStore());
		const win = deps.getMainWindow();
		const processManager = deps.getProcessManager();
		let unavailableReason: string | undefined;
		if (!processManager) unavailableReason = 'Host execution backend is unavailable';
		else if (
			!win ||
			!isWebContentsAvailable(win) ||
			win.webContents.isLoadingMainFrame() ||
			win.webContents.isCrashed()
		) {
			unavailableReason = 'Owning desktop renderer is unavailable';
		} else {
			const ready = await requestFromRenderer(win, 'remote:liteReady', {
				fallback: false,
				parse: (value) => value === true,
				timeoutMs: 1500,
			});
			if (!ready || !isWebContentsAvailable(win)) {
				unavailableReason = 'Owning desktop renderer is not ready to accept remote work';
			}
		}
		const ready = unavailableReason === undefined;
		const handlers =
			'_invokeHandlers' in ipcMain && ipcMain._invokeHandlers instanceof Map
				? ipcMain._invokeHandlers
				: undefined;
		const has = (...channels: string[]) =>
			ready && channels.every((channel) => handlers?.has(channel));
		return {
			instanceId,
			hostName: hostname(),
			appVersion: app.getVersion(),
			platform: process.platform,
			ready,
			...(unavailableReason ? { unavailableReason } : {}),
			capabilities: {
				sessions: has(
					'sessions:getBootstrap',
					'sessions:getDeferredContent',
					'sessions:setMany',
					'agents:detect',
					'process:spawn'
				),
				terminal: has('process:spawnTerminalTab', 'process:write', 'process:resize'),
				files: has(
					'fs:directoryInfo',
					'fs:readDir',
					'fs:readFile',
					'fs:writeFile',
					'attachments:save'
				),
				browserRelay:
					ready &&
					isBrowserRelayReady() &&
					has(
						'browser:relayOpen',
						'browser:relayFrame',
						'browser:relayInput',
						'browser:relayAction',
						'browser:relayClose'
					),
			},
		};
	};
}
