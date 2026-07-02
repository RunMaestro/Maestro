/**
 * Mobile Pairing IPC Handlers
 *
 * Provides IPC handlers for mobile device pairing:
 * - Generate pairing code for QR display
 * - List paired devices
 * - Revoke paired devices
 */

import { ipcMain } from 'electron';
import { generatePairingCode, listPairedDevices, revokeDevice } from '../../mobile-pairing';
import { createIpcHandler, CreateHandlerOptions } from '../../utils/ipcHandler';
import { logger } from '../../utils/logger';
import { WebServer } from '../../web-server';

const LOG_CONTEXT = '[MobilePairing]';

/**
 * Helper to create handler options with consistent context
 */
const handlerOpts = (operation: string, logSuccess = true): CreateHandlerOptions => ({
	context: LOG_CONTEXT,
	operation,
	logSuccess,
});

/**
 * Dependencies required for mobile pairing handler registration
 */
export interface MobilePairingHandlerDependencies {
	/** Function to get the WebServer instance */
	getWebServer: () => WebServer | null;
}

/**
 * Register all mobile pairing IPC handlers.
 *
 * Handlers:
 * - mobile-pairing:generate-code - Generate a new pairing code with host/port info
 * - mobile-pairing:list-devices - Get all paired devices (no tokens)
 * - mobile-pairing:revoke-device - Revoke a paired device by ID
 */
export function registerMobilePairingHandlers(deps: MobilePairingHandlerDependencies): void {
	const { getWebServer } = deps;

	/**
	 * Generate a new pairing code for QR display.
	 *
	 * Returns the code, host, port, and expiration time.
	 * Requires the web server to be running to get host/port info.
	 */
	ipcMain.handle(
		'mobile-pairing:generate-code',
		createIpcHandler(
			handlerOpts('generate-code'),
			async (): Promise<{
				code: string;
				host: string;
				port: number;
				expiresAt: number;
			}> => {
				const webServer = getWebServer();
				if (!webServer || !webServer.isActive()) {
					throw new Error('Web server is not running. Enable web interface first.');
				}

				// Generate the pairing code
				const pairing = generatePairingCode();

				// Get host and port from the running web server
				const url = webServer.getUrl();
				const port = webServer.getPort();

				// Extract host from URL (format: http://192.168.x.x:port)
				const urlMatch = url.match(/^https?:\/\/([^:]+)/);
				const host = urlMatch ? urlMatch[1] : 'localhost';

				logger.info(`Generated pairing code (expires in 5 minutes)`, LOG_CONTEXT);

				return {
					code: pairing.code,
					host,
					port,
					expiresAt: pairing.expiresAt,
				};
			}
		)
	);

	/**
	 * List all paired devices.
	 *
	 * Returns device records without token hashes.
	 */
	ipcMain.handle(
		'mobile-pairing:list-devices',
		createIpcHandler(
			handlerOpts('list-devices', false),
			async (): Promise<{
				devices: Array<{
					id: string;
					deviceName: string;
					createdAt: number;
					lastUsedAt: number;
					expiresAt: number;
				}>;
			}> => {
				const devices = await listPairedDevices();
				return { devices };
			}
		)
	);

	/**
	 * Revoke a paired device by ID.
	 *
	 * Removes the device from the paired devices list and closes any open
	 * WebSocket connections that already authenticated with this device's
	 * token. Without the second step, a live mobile socket would keep
	 * authority until it reconnected on its own.
	 */
	ipcMain.handle(
		'mobile-pairing:revoke-device',
		createIpcHandler(
			handlerOpts('revoke-device'),
			async (id: string): Promise<{ revoked: boolean; disconnected: number }> => {
				const revoked = await revokeDevice(id);
				let disconnected = 0;
				if (revoked) {
					logger.info(`Revoked paired device: ${id}`, LOG_CONTEXT);
					const webServer = getWebServer();
					if (webServer && webServer.isActive()) {
						disconnected = webServer.disconnectMobileDevice(id);
					}
				} else {
					logger.warn(`Device not found for revocation: ${id}`, LOG_CONTEXT);
				}
				return { revoked, disconnected };
			}
		)
	);

	logger.debug(`${LOG_CONTEXT} Mobile pairing IPC handlers registered`);
}
