/**
 * A Cappella main-process entry point.
 *
 * Holds the one voice session service instance and nothing else. The service is
 * created lazily by whoever resolves the provider trio (the IPC layer, via the
 * provider registry), never here: this module must not import a concrete
 * provider, or the "no silent cloud substitution" rule would be decided by an
 * import instead of by the registry.
 */

import { ACappellaTransport } from './transport';
import type { ACappellaTransportDeps as ACappellaTransportOptions } from './transport';
import { VoiceSessionService } from './voice-session-service';
import type { VoiceSessionServiceOptions } from './voice-session-service';

export { VoiceSessionService, VoiceDispatchError } from './voice-session-service';
export {
	closeAcappellaAudioHostWindow,
	ensureAcappellaAudioHostWindow,
	getAcappellaAudioHostWindow,
	isAcappellaAudioHostContents,
	type AudioHostWindowDeps,
} from './audio-host-window';
export {
	VoiceAudioBridge,
	createVoiceAudioBridge,
	type AudioBridgeSession,
	type VoiceAudioBridgeOptions,
} from './audio/audio-bridge';
export {
	buildAgentRoster,
	createRendererVoiceBridge,
	createVoiceRouteExecutor,
	executeRouteDecision,
	readAgentRoster,
} from './dispatch/route-executor';
export type {
	CommandReceipt,
	DispatchReplayCache,
	FocusTabResult,
	NewTabWithPromptResult,
	VoiceRendererBridge,
	VoiceRouteExecutorOptions,
} from './dispatch/route-executor';
export * from './router';
export * from './speech';
export type {
	VoiceDispatchResult,
	VoiceEventListener,
	VoiceRouteExecutor,
	VoiceSessionServiceOptions,
	VoiceSessionSnapshot,
	VoiceStopReason,
} from './voice-session-service';

export { ACappellaTransport } from './transport';
export type { ACappellaTransportDeps, DeviceStatus, PairingPayload } from './transport';
export { PairingService } from './pairing/pairing-service';
export type { PairedDeviceView, PairingOffer, PairingRequest } from './pairing/pairing-service';

let instance: VoiceSessionService | null = null;

/**
 * The paired-device transport, or null when nothing has ever paired a device.
 *
 * Held here alongside the session service, and for the same reason: it owns real
 * resources (a Bonjour advert, live signaling sessions, peer connections in the
 * audio host) that outlive any one voice session.
 */
let transport: ACappellaTransport | null = null;

/** Create the transport, replacing any existing one. */
export function initACappellaTransport(options: ACappellaTransportOptions): ACappellaTransport {
	disposeACappellaTransport();
	transport = new ACappellaTransport(options);
	return transport;
}

/**
 * The live transport, or null.
 *
 * Callers must handle null: A Cappella is an Encore Feature that is off by
 * default, and the WebSocket route asks for this on every inbound signaling
 * message including ones that arrive before anything has been set up.
 */
export function getACappellaTransport(): ACappellaTransport | null {
	return transport;
}

export function disposeACappellaTransport(): void {
	if (!transport) return;
	const previous = transport;
	transport = null;
	previous.dispose();
}

/**
 * Create the singleton, replacing any existing one. Calling this again is how a
 * provider change takes effect, so the previous instance is disposed first.
 */
export async function initVoiceSessionService(
	options: VoiceSessionServiceOptions
): Promise<VoiceSessionService> {
	await disposeVoiceSessionService();
	instance = new VoiceSessionService(options);
	return instance;
}

/**
 * The live service, or `null` when A Cappella has never been started. Callers
 * must handle null: the Encore Feature is off by default, and nothing here runs
 * until a session is explicitly started.
 */
export function getVoiceSessionService(): VoiceSessionService | null {
	return instance;
}

/** Tear down the singleton. Safe to call when nothing was ever created. */
export async function disposeVoiceSessionService(): Promise<void> {
	if (!instance) return;
	const previous = instance;
	instance = null;
	await previous.dispose();
}
