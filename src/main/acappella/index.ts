/**
 * A Cappella main-process entry point.
 *
 * Holds the one voice session service instance and nothing else. The service is
 * created lazily by whoever resolves the provider trio (the IPC layer, via the
 * provider registry), never here: this module must not import a concrete
 * provider, or the "no silent cloud substitution" rule would be decided by an
 * import instead of by the registry.
 */

import { VoiceSessionService } from './voice-session-service';
import type { VoiceSessionServiceOptions } from './voice-session-service';

export { VoiceSessionService, VoiceDispatchError } from './voice-session-service';
export {
	buildAgentRoster,
	createRendererVoiceBridge,
	createVoiceRouteExecutor,
	executeRouteDecision,
	readAgentRoster,
} from './dispatch/route-executor';
export type {
	CommandReceipt,
	NewTabWithPromptResult,
	VoiceRendererBridge,
	VoiceRouteExecutorOptions,
} from './dispatch/route-executor';
export type {
	VoiceDispatchResult,
	VoiceEventListener,
	VoiceRouteExecutor,
	VoiceSessionServiceOptions,
	VoiceSessionSnapshot,
	VoiceStopReason,
} from './voice-session-service';

let instance: VoiceSessionService | null = null;

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
