/**
 * Preload API for mobile pairing operations
 *
 * Provides the window.maestro.mobilePairing namespace for:
 * - Generating pairing codes for QR display
 * - Listing paired devices
 * - Revoking paired devices
 */

import { ipcRenderer } from 'electron';

/**
 * Paired device record (without token hash)
 */
export interface PairedDevice {
	id: string;
	deviceName: string;
	createdAt: number;
	lastUsedAt: number;
	expiresAt: number;
}

/**
 * Pairing code response
 */
export interface PairingCodeResponse {
	success: boolean;
	code?: string;
	host?: string;
	port?: number;
	expiresAt?: number;
	error?: string;
}

/**
 * Device list response
 */
export interface DeviceListResponse {
	success: boolean;
	devices?: PairedDevice[];
	error?: string;
}

/**
 * Revoke device response
 */
export interface RevokeDeviceResponse {
	success: boolean;
	revoked?: boolean;
	/** Number of active mobile WebSocket connections that were closed for the revoked device. */
	disconnected?: number;
	error?: string;
}

/**
 * Creates the mobile pairing API object for preload exposure
 */
export function createMobilePairingApi() {
	return {
		/**
		 * Generate a new pairing code for QR display.
		 * Returns the code, host, port, and expiration time.
		 * Requires the web server to be running.
		 */
		generateCode: (): Promise<PairingCodeResponse> =>
			ipcRenderer.invoke('mobile-pairing:generate-code'),

		/**
		 * List all paired devices (without tokens).
		 */
		listDevices: (): Promise<DeviceListResponse> =>
			ipcRenderer.invoke('mobile-pairing:list-devices'),

		/**
		 * Revoke a paired device by ID.
		 */
		revokeDevice: (id: string): Promise<RevokeDeviceResponse> =>
			ipcRenderer.invoke('mobile-pairing:revoke-device', id),
	};
}

export type MobilePairingApi = ReturnType<typeof createMobilePairingApi>;
