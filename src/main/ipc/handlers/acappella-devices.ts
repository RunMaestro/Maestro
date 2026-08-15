/**
 * A Cappella paired-device IPC handlers.
 *
 * The transport in front of `src/main/acappella/transport/` and
 * `src/main/acappella/pairing/`. Thin by the same rule as the rest of the A
 * Cappella IPC layer: every policy that matters - who may pair, what a code
 * buys, what revocation does - lives in those modules, and this file only turns
 * channels into calls.
 *
 * Two things it is careful about.
 *
 * **A pairing payload is a credential.** `acappella:start-pairing` returns the
 * server token, because that is what a device needs to reach the WebSocket at
 * all. It is therefore gated on the Encore Feature and it is only ever rendered
 * as a QR code the user is looking at. Nothing here stores it.
 *
 * **Revocation must work with the feature off.** `revoke-device`,
 * `revoke-all-devices`, and `list-devices` stay callable when the flag is off,
 * following the `stop-session` and `models:remove` precedent: the moment a user
 * turns the feature off is exactly when they may want to cut a phone loose, and
 * a control that disappears then is a control that was never trustworthy.
 */

import { ipcMain } from 'electron';

import { requireACappellaEnabled } from '../../../shared/acappella/feature-flag';
import type { IceProbeResult } from '../../../shared/acappella/webrtc-host';
import { getACappellaTransport } from '../../acappella';
import type { DeviceStatus, PairingPayload } from '../../acappella/transport';
import type { DiscoveryStatus } from '../../acappella/pairing/discovery';
import type { PairingRequest } from '../../acappella/pairing/pairing-service';
import {
	describeIceReach,
	readIceSettings,
	TUNNEL_MEDIA_NOTE,
	type IceTransportSettings,
} from '../../acappella/transport/ice-config';
import { withIpcErrorLogging, type CreateHandlerOptions } from '../../utils/ipcHandler';

const LOG_CONTEXT = '[ACappellaDevices]';

/** Broadcast whenever the device list or a connection state changes. */
export const ACAPPELLA_DEVICES_CHANNEL = 'acappella:devices-changed';

/** Broadcast when a device asks to pair, and again (with null) when it stops asking. */
export const ACAPPELLA_PAIRING_REQUEST_CHANNEL = 'acappella:pairing-request';

const handlerOpts = (operation: string): Pick<CreateHandlerOptions, 'context' | 'operation'> => ({
	context: LOG_CONTEXT,
	operation,
});

export interface ACappellaDeviceHandlerDependencies {
	settingsStore: {
		get: (key: string, defaultValue?: unknown) => unknown;
		set?: (key: string, value: unknown) => void;
	};
}

/** The Encore gate. See `src/shared/acappella/feature-flag.ts`. */
const requireEnabled = requireACappellaEnabled;

/** The ICE section of the A Cappella settings blob, widened. */
export function readStoredIceSettings(
	store: ACappellaDeviceHandlerDependencies['settingsStore']
): IceTransportSettings {
	const blob = (store.get('acappella', {}) ?? {}) as { ice?: unknown };
	return readIceSettings(blob.ice);
}

export function registerACappellaDeviceHandlers(deps: ACappellaDeviceHandlerDependencies): void {
	const { settingsStore } = deps;

	/** Null when the transport has never been built, which a client reads as "no devices". */
	const transport = () => getACappellaTransport();

	ipcMain.handle(
		'acappella:start-pairing',
		withIpcErrorLogging(handlerOpts('startPairing'), async (): Promise<PairingPayload | null> => {
			requireEnabled(settingsStore);
			return transport()?.startPairing() ?? null;
		})
	);

	ipcMain.handle(
		'acappella:pairing-status',
		withIpcErrorLogging(
			handlerOpts('pairingStatus'),
			async (): Promise<{
				payload: PairingPayload | null;
				request: PairingRequest | null;
				discovery: DiscoveryStatus | null;
				manualHint: string;
			}> => {
				const live = transport();
				return {
					payload: live?.currentPairingPayload() ?? null,
					request: live?.pairing.pendingRequest() ?? null,
					discovery: live?.discoveryStatus() ?? null,
					manualHint: live?.manualHint() ?? '',
				};
			}
		)
	);

	ipcMain.handle(
		'acappella:cancel-pairing',
		withIpcErrorLogging(handlerOpts('cancelPairing'), async (): Promise<void> => {
			transport()?.pairing.cancelPairing();
		})
	);

	ipcMain.handle(
		'acappella:approve-device',
		withIpcErrorLogging(
			handlerOpts('approveDevice'),
			// The affirmative action. Without this, knowing a six-character code
			// would be enough to hold somebody's microphone.
			async (_event, payload: unknown): Promise<boolean> => {
				requireEnabled(settingsStore);
				const { requestId, name } = (payload ?? {}) as { requestId?: string; name?: string };
				if (typeof requestId !== 'string' || !requestId) throw new Error('InvalidPairingRequest');
				const device = await transport()?.pairing.approve(requestId, name);
				return !!device;
			}
		)
	);

	ipcMain.handle(
		'acappella:deny-device',
		withIpcErrorLogging(
			handlerOpts('denyDevice'),
			async (_event, requestId: unknown): Promise<void> => {
				if (typeof requestId !== 'string' || !requestId) throw new Error('InvalidPairingRequest');
				transport()?.pairing.deny(requestId);
			}
		)
	);

	// Deliberately ungated: see the module header.
	ipcMain.handle(
		'acappella:list-devices',
		withIpcErrorLogging(
			handlerOpts('listDevices'),
			async (): Promise<DeviceStatus[]> => (await transport()?.listDevices()) ?? []
		)
	);

	ipcMain.handle(
		'acappella:rename-device',
		withIpcErrorLogging(
			handlerOpts('renameDevice'),
			async (_event, payload: unknown): Promise<boolean> => {
				const { deviceId, name } = (payload ?? {}) as { deviceId?: string; name?: string };
				if (typeof deviceId !== 'string' || typeof name !== 'string') {
					throw new Error('InvalidDeviceRename');
				}
				return (await transport()?.pairing.rename(deviceId, name)) ?? false;
			}
		)
	);

	ipcMain.handle(
		'acappella:revoke-device',
		withIpcErrorLogging(
			handlerOpts('revokeDevice'),
			async (_event, deviceId: unknown): Promise<boolean> => {
				if (typeof deviceId !== 'string' || !deviceId) throw new Error('InvalidDeviceId');
				return (await transport()?.revokeDevice(deviceId)) ?? false;
			}
		)
	);

	ipcMain.handle(
		'acappella:forget-device',
		withIpcErrorLogging(
			handlerOpts('forgetDevice'),
			async (_event, deviceId: unknown): Promise<boolean> => {
				if (typeof deviceId !== 'string' || !deviceId) throw new Error('InvalidDeviceId');
				return (await transport()?.pairing.forget(deviceId)) ?? false;
			}
		)
	);

	ipcMain.handle(
		'acappella:revoke-all-devices',
		withIpcErrorLogging(
			handlerOpts('revokeAllDevices'),
			async (): Promise<number> => (await transport()?.revokeAllDevices()) ?? 0
		)
	);

	ipcMain.handle(
		'acappella:disconnect-all-devices',
		withIpcErrorLogging(handlerOpts('disconnectAllDevices'), async (): Promise<void> => {
			transport()?.disconnectAll();
		})
	);

	ipcMain.handle(
		'acappella:ice-settings',
		withIpcErrorLogging(
			handlerOpts('iceSettings'),
			async (): Promise<{
				settings: IceTransportSettings;
				reach: string;
				tunnelNote: string;
				discovery: DiscoveryStatus | null;
			}> => {
				const settings = readStoredIceSettings(settingsStore);
				return {
					settings,
					reach: describeIceReach(settings),
					tunnelNote: TUNNEL_MEDIA_NOTE,
					discovery: transport()?.discoveryStatus() ?? null,
				};
			}
		)
	);

	ipcMain.handle(
		'acappella:test-connection',
		withIpcErrorLogging(handlerOpts('testConnection'), async (): Promise<IceProbeResult> => {
			requireEnabled(settingsStore);
			const live = transport();
			if (!live) {
				return {
					host: false,
					stun: false,
					relay: false,
					best: 'unknown',
					error: 'A Cappella has not started yet. Open a voice session and try again.',
				};
			}
			return live.testConnection();
		})
	);

	ipcMain.handle(
		'acappella:set-discovery',
		withIpcErrorLogging(
			handlerOpts('setDiscovery'),
			async (_event, enabled: unknown): Promise<DiscoveryStatus | null> => {
				const live = transport();
				if (!live) return null;
				if (enabled === true) await live.discovery.start();
				else await live.discovery.stop();
				return live.discoveryStatus();
			}
		)
	);
}
