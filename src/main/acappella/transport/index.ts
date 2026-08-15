/**
 * The A Cappella transport, assembled.
 *
 * Five objects that each know one thing, wired together here so none of them has
 * to know about Electron:
 *
 *   - `../pairing/pairing-service.ts` - who is allowed to connect.
 *   - `../pairing/discovery.ts` - how they find this machine.
 *   - `./signaling.ts` - the offer/answer/candidate exchange, on the existing
 *     authenticated WebSocket.
 *   - `./remote-session.ts` - what it means for a device to hold the microphone.
 *   - `../../../renderer/acappella-audio/peer-connection.ts` - the peer itself,
 *     in the hidden audio window, reached from here over IPC.
 *
 * This module is the only one that knows the audio host is a `BrowserWindow` and
 * that settings come from an electron-store. Everything below it is testable
 * with a fake socket and a fake clock.
 */

import * as path from 'path';

import type { DeviceMessage } from '../../../shared/acappella/device-protocol';
import { isACappellaEnabled } from '../../../shared/acappella/feature-flag';
import type { VoiceOrigin, VoiceScope } from '../../../shared/acappella/protocol';
import {
	ACAPPELLA_WEBRTC_COMMAND_CHANNEL,
	DEFAULT_REMOTE_AUDIO_CONFIG,
	type IceProbeResult,
	type PeerQualityStats,
	type RemoteAudioConfig,
	type WebRtcHostCommand,
	type WebRtcHostEvent,
} from '../../../shared/acappella/webrtc-host';
import { logger } from '../../utils/logger';
import { generateUUID } from '../../../shared/uuid';
import { DiscoveryService, manualEntryHint, type DiscoveryStatus } from '../pairing/discovery';
import {
	PairingService,
	type PairedDeviceView,
	type PairingOffer,
	type PairingRequest,
} from '../pairing/pairing-service';
import {
	buildIceServers,
	listHostCandidates,
	readIceSettings,
	type IceTransportSettings,
} from './ice-config';
import { RemoteSessionCoordinator, type RemoteFloor } from './remote-session';
import { SignalingService, type SignalingServerMessage } from './signaling';

const LOG_CONTEXT = 'ACappella';

/** Settings blob key A Cappella keeps everything under. Mirrors the other readers. */
const ACAPPELLA_SETTINGS_KEY = 'acappella';

/** How long a Test Connection run waits for candidates before reporting. */
const ICE_PROBE_TIMEOUT_MS = 5000;

/** What a device sees in the pairing QR code. */
export interface PairingPayload {
	/** Always `maestro-acappella`, so a scanner can reject an unrelated QR code. */
	kind: 'maestro-acappella';
	/** Wire protocol version, so an old client fails with a sentence. */
	v: number;
	/** Addresses to try, best first: LAN, then any overlay network. */
	hosts: string[];
	port: number;
	/** The server token, which is what gets the device onto the WebSocket at all. */
	token: string;
	code: string;
	expiresAt: number;
	fingerprint: string;
}

export interface ACappellaTransportDeps {
	settingsStore: {
		get: (key: string, defaultValue?: unknown) => unknown;
		onDidChange?: (key: string, callback: (value: unknown) => void) => void;
	};
	/** Where `devices.json` lives. Usually `app.getPath('userData')`. */
	userDataPath: string;
	/** The audio host's webContents, or null when the window is not open. */
	sendToAudioHost: (command: WebRtcHostCommand) => void;
	/** The one floor controller, from the hotkey installation. */
	acquireFloor: (scope: VoiceScope, origin?: VoiceOrigin) => RemoteFloor;
	/** The live voice session, or null before one has ever been built. */
	getSession: () => import('./remote-session').RemoteVoiceSession | null;
	/** The web server's security token and port, for the QR code and the fingerprint. */
	getServerToken: () => string | null;
	getServerPort: () => number | null;
	getAppVersion: () => string;
	getMachineName: () => string;
	/** The device list changed. Pushed to every window so the panel repaints. */
	onDevicesChanged?: () => void;
	/** A device is asking to pair, or the request went away. */
	onPairingRequest?: (request: PairingRequest | null) => void;
}

/** How a device is doing right now, joined onto its stored record for the UI. */
export interface DeviceStatus extends PairedDeviceView {
	online: boolean;
	holdsFloor: boolean;
	quality: PeerQualityStats | null;
}

export class ACappellaTransport {
	readonly pairing: PairingService;
	readonly signaling: SignalingService;
	readonly discovery: DiscoveryService;
	private readonly remote: RemoteSessionCoordinator | null = null;
	private readonly deps: ACappellaTransportDeps;
	private readonly quality = new Map<string, PeerQualityStats>();
	private readonly probes = new Map<string, (result: IceProbeResult) => void>();
	private readonly names = new Map<string, string>();

	constructor(deps: ACappellaTransportDeps) {
		this.deps = deps;
		this.pairing = new PairingService({
			filePath: path.join(deps.userDataPath, 'acappella', 'devices.json'),
			hostSecret: deps.getServerToken() ?? undefined,
		});
		this.pairing.onChange(() => {
			void this.refreshNames();
			deps.onDevicesChanged?.();
		});
		this.pairing.onPairingRequest((request) => deps.onPairingRequest?.(request));

		this.signaling = new SignalingService({
			pairing: this.pairing,
			peerHost: {
				acceptOffer: (params) => this.send({ kind: 'accept-offer', ...params }),
				addIceCandidate: (deviceId, candidate) =>
					this.send({ kind: 'add-ice-candidate', deviceId, candidate }),
				closePeer: (deviceId, reason) => this.send({ kind: 'close-peer', deviceId, reason }),
			},
			getIceSettings: () => this.iceSettings(),
			getAudioConfig: () => this.audioConfig(),
			onDeviceOnline: (deviceId) => {
				deps.onDevicesChanged?.();
				logger.debug(`Device ${deviceId} online`, LOG_CONTEXT);
			},
			onDeviceOffline: (deviceId, reason) => {
				this.quality.delete(deviceId);
				this.remote?.handleDisconnected(deviceId, reason);
				deps.onDevicesChanged?.();
			},
		});

		const session = deps.getSession();
		if (session) {
			this.remote = new RemoteSessionCoordinator({
				session,
				acquireFloor: (scope, origin) => deps.acquireFloor(scope, origin),
				sink: {
					send: (deviceId, message) => this.send({ kind: 'send', deviceId, message }),
					broadcast: (message) => this.send({ kind: 'broadcast', message }),
				},
				getDeviceName: (deviceId) => this.names.get(deviceId) ?? '',
				onFloorChange: (holder) => {
					// The audio host gates which remote track reaches the capture
					// pipeline, so it needs to be told before the next frame arrives.
					this.send({ kind: 'set-floor-holder', deviceId: holder === 'local' ? null : holder });
					deps.onDevicesChanged?.();
				},
			});
		}

		this.discovery = new DiscoveryService({
			getPort: deps.getServerPort,
			getName: deps.getMachineName,
			getAppVersion: deps.getAppVersion,
			getFingerprint: () => this.pairing.fingerprint(),
		});

		void this.refreshNames();
	}

	dispose(): void {
		this.signaling.dispose();
		this.remote?.dispose();
		void this.discovery.stop();
	}

	/**
	 * Stand down because the Encore Feature was switched off.
	 *
	 * Not `dispose()`, and the difference matters: the transport is constructed
	 * once per process (see `initACappellaTransport`, called from handler
	 * registration at boot), so disposing it here would mean switching the feature
	 * back on did nothing until the next restart. This releases every resource the
	 * flag actually promises are gone - the advert, the live connections, and any
	 * half-finished pairing - while leaving the object able to serve again.
	 *
	 * Devices are disconnected rather than revoked. A user switching the feature
	 * off is saying "stop", not "forget my phone", and re-pairing a phone because
	 * a checkbox was toggled is a punishment for reading the settings screen.
	 */
	standDown(): void {
		void this.discovery.stop();
		this.pairing.cancelPairing();
		this.disconnectAll('A Cappella was switched off on the desktop');
	}

	/**
	 * Whether the Encore Feature is on right now.
	 *
	 * Read straight from settings on every call so the signaling adapter and the
	 * IPC handlers cannot disagree about it, and so a device that was mid-handshake
	 * when the flag flipped is refused rather than served.
	 */
	featureEnabled(): boolean {
		return isACappellaEnabled(this.deps.settingsStore);
	}

	// -- Pairing -------------------------------------------------------------

	/** Open a pairing window and build the payload the QR code encodes. */
	startPairing(): PairingPayload | null {
		const token = this.deps.getServerToken();
		const port = this.deps.getServerPort();
		if (!token || !port) return null;
		const offer = this.pairing.startPairing();
		return this.payloadFor(offer, token, port);
	}

	currentPairingPayload(): PairingPayload | null {
		const offer = this.pairing.currentOffer();
		const token = this.deps.getServerToken();
		const port = this.deps.getServerPort();
		if (!offer || !token || !port) return null;
		return this.payloadFor(offer, token, port);
	}

	private payloadFor(offer: PairingOffer, token: string, port: number): PairingPayload {
		return {
			kind: 'maestro-acappella',
			v: 1,
			hosts: listHostCandidates(),
			port,
			token,
			code: offer.code,
			expiresAt: offer.expiresAt,
			fingerprint: offer.fingerprint,
		};
	}

	/** The sentence to show when discovery is off or unavailable. */
	manualHint(): string {
		return manualEntryHint(listHostCandidates(), this.deps.getServerPort());
	}

	discoveryStatus(): DiscoveryStatus {
		return this.discovery.status;
	}

	// -- Device list ---------------------------------------------------------

	async listDevices(): Promise<DeviceStatus[]> {
		const devices = await this.pairing.list();
		return devices.map((device) => ({
			...device,
			online: this.signaling.isOnline(device.id),
			holdsFloor: this.remote?.floorHolder === device.id,
			quality: this.quality.get(device.id) ?? null,
		}));
	}

	/** Revoke and tear down. The signaling service is subscribed to the event. */
	async revokeDevice(deviceId: string): Promise<boolean> {
		return this.pairing.revoke(deviceId);
	}

	async revokeAllDevices(): Promise<number> {
		return this.pairing.revokeAll();
	}

	/** Drop every live connection without revoking anything. */
	disconnectAll(reason = 'the desktop disconnected all devices'): void {
		for (const deviceId of this.signaling.onlineDeviceIds()) {
			this.signaling.closeDevice(deviceId, reason);
		}
	}

	// -- Peer events ----------------------------------------------------------

	/** One event from the audio host's peer registry. */
	handleHostEvent(event: WebRtcHostEvent): void {
		switch (event.kind) {
			case 'answer':
				this.signaling.deliverAnswer(event.deviceId, event.answer);
				return;
			case 'ice-candidate':
				this.signaling.deliverIceCandidate(event.deviceId, event.candidate);
				return;
			case 'connection-state':
				this.remote?.handlePeerState(event.deviceId, event.state);
				if (event.state === 'connected') {
					void this.pairing.noteConnected(
						event.deviceId,
						this.quality.get(event.deviceId)?.candidateType ?? 'unknown'
					);
				}
				this.deps.onDevicesChanged?.();
				return;
			case 'stats':
				this.quality.set(event.stats.deviceId, event.stats);
				this.deps.onDevicesChanged?.();
				return;
			case 'message':
				this.handleDeviceMessage(event.deviceId, event.message);
				return;
			case 'peer-error':
				this.signaling.deliverPeerError(event.deviceId, event.message);
				return;
			case 'ice-probe-result': {
				const resolve = this.probes.get(event.probeId);
				this.probes.delete(event.probeId);
				resolve?.(event.result);
				return;
			}
		}
	}

	private handleDeviceMessage(deviceId: string, message: DeviceMessage): void {
		if (message.type === 'hello') {
			// The name a device calls itself is only ever a display string, so it is
			// taken as the device says it - but the identity that matters was settled
			// at authentication, and nothing here can change it.
			this.names.set(deviceId, message.identity.name);
			this.deps.onDevicesChanged?.();
		}
		this.remote?.handleDeviceMessage(deviceId, message);
	}

	// -- Test Connection ------------------------------------------------------

	/**
	 * Gather candidates against the configured servers and report what actually
	 * came back.
	 *
	 * Resolves `unknown` if the audio host never answers, rather than hanging: the
	 * button has to give a verdict, and "no answer" is one.
	 */
	testConnection(): Promise<IceProbeResult> {
		const probeId = generateUUID();
		const settings = this.iceSettings();
		return new Promise<IceProbeResult>((resolve) => {
			const timer = setTimeout(() => {
				this.probes.delete(probeId);
				resolve({
					host: false,
					stun: false,
					relay: false,
					best: 'unknown',
					error: 'The audio engine did not answer. Start a voice session and try again.',
				});
			}, ICE_PROBE_TIMEOUT_MS * 2);
			this.probes.set(probeId, (result) => {
				clearTimeout(timer);
				resolve(result);
			});
			this.send({
				kind: 'probe-ice',
				probeId,
				iceServers: buildIceServers(settings),
				timeoutMs: ICE_PROBE_TIMEOUT_MS,
			});
		});
	}

	// -- Signaling plumbing ---------------------------------------------------

	registerClient(params: {
		clientId: string;
		send: (message: SignalingServerMessage) => void;
		remoteAddress?: string;
	}): void {
		this.signaling.register(params);
	}

	handleSignalMessage(clientId: string, payload: unknown): Promise<void> {
		return this.signaling.handleMessage(clientId, payload);
	}

	handleClientDisconnect(clientId: string): void {
		this.signaling.handleDisconnect(clientId);
	}

	// -- Internals ------------------------------------------------------------

	private iceSettings(): IceTransportSettings {
		const blob = (this.deps.settingsStore.get(ACAPPELLA_SETTINGS_KEY, {}) ?? {}) as {
			ice?: unknown;
		};
		return readIceSettings(blob.ice);
	}

	private audioConfig(): RemoteAudioConfig {
		const blob = (this.deps.settingsStore.get(ACAPPELLA_SETTINGS_KEY, {}) ?? {}) as {
			remoteAudio?: Partial<RemoteAudioConfig>;
		};
		return { ...DEFAULT_REMOTE_AUDIO_CONFIG, ...(blob.remoteAudio ?? {}) };
	}

	private send(command: WebRtcHostCommand): void {
		this.deps.sendToAudioHost(command);
	}

	private async refreshNames(): Promise<void> {
		for (const device of await this.pairing.list()) this.names.set(device.id, device.name);
	}
}

export { ACAPPELLA_WEBRTC_COMMAND_CHANNEL };
export * from './ice-config';
export * from './remote-session';
export * from './signaling';
