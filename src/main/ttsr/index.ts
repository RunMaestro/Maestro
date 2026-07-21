/**
 * Time-Traveling Stream Rules - main-process entry point.
 *
 * One call from `src/main/index.ts` builds the runtime and injects the stream
 * observer into the process manager. Everything else about TTSR stays behind
 * this module; the process manager never imports it.
 */

import type { ParsedEventObserver } from '../process-manager/types';
import type {
	TtsrAbortPendingPayload,
	TtsrMatchedPayload,
	TtsrTriggeredPayload,
} from '../../shared/ttsr-types';
import type { TtsrInterruptTarget } from './ttsr-interrupt-driver';
import { emitTtsrTriggeredToast } from './ttsr-notify';
import { TtsrRuntime } from './ttsr-runtime';
import { createTtsrStatePersistence, type TtsrStatePersistence } from './ttsr-state-persistence';
import type { TtsrProcessEventSource } from './ttsr-spawn-registry';

export { TtsrRuntime } from './ttsr-runtime';
export { TtsrManager } from './ttsr-manager';
export { TtsrInterruptDriver } from './ttsr-interrupt-driver';
export { TtsrSpawnRegistry } from './ttsr-spawn-registry';
export { buildTtsrToast, emitTtsrTriggeredToast, type TtsrToastParams } from './ttsr-notify';
export { TtsrStateStore } from './ttsr-state-store';
export {
	createTtsrStatePersistence,
	type TtsrStatePersistence,
	type TtsrStateBackend,
} from './ttsr-state-persistence';
export * from './config/ttsr-config-loader';

/** The process-manager surface TTSR needs. */
export interface TtsrProcessManagerLike extends TtsrProcessEventSource, TtsrInterruptTarget {
	setParsedEventObserver(observer: ParsedEventObserver | null): void;
}

export interface InstallTtsrOptions {
	/**
	 * Live read of the gate: `settings.ttsrEnabled && encoreFeatures.ttsr`.
	 * Read on every event so toggling the Encore feature takes effect without
	 * an app restart, mirroring the OpenCode-server plugin gate.
	 */
	isGloballyEnabled(): boolean;
	/** Live read of the `ttsrDisabledRules` setting. */
	getDisabledRules?(): string[];
	/** Renderer push channel, used for the `ttsr:matched` observability event. */
	safeSend?: (channel: string, ...args: unknown[]) => void;
	/**
	 * Override the repeat-state persistence layer. Defaults to the electron-store
	 * backed one; pass `null` for an in-memory runtime (tests, headless CLI) where
	 * `once`/`after-gap` resetting with the process is acceptable.
	 */
	persistence?: TtsrStatePersistence | null;
	/**
	 * Raise a toast when a turn is interrupted (default on). Off only for
	 * headless hosts with no renderer to notify.
	 */
	notifyOnInterrupt?: boolean;
}

/**
 * Build the TTSR runtime and attach it to a process manager. While the gate is
 * off the observer returns before doing any work, so the tap is a true no-op.
 */
export function installTtsrRuntime(
	processManager: TtsrProcessManagerLike,
	options: InstallTtsrOptions
): TtsrRuntime {
	const safeSend = options.safeSend;
	const runtime = new TtsrRuntime({
		isGloballyEnabled: options.isGloballyEnabled,
		getDisabledRules: options.getDisabledRules,
		persistence:
			options.persistence === null
				? undefined
				: (options.persistence ?? createTtsrStatePersistence()),
		onMatched: safeSend
			? (payload: TtsrMatchedPayload) => safeSend('ttsr:matched', payload)
			: undefined,
		// Aborting without a way to tell the renderer to respawn would strand the
		// turn, so the interrupt surface is wired only when a push channel exists.
		interruptTarget: safeSend ? processManager : undefined,
		onTriggered: safeSend
			? (payload: TtsrTriggeredPayload) => {
					// The corrective respawn comes first: the toast is advisory, and the
					// renderer should be reinjecting before the user is told about it.
					safeSend('ttsr:triggered', payload);
					if (options.notifyOnInterrupt !== false) emitTtsrTriggeredToast(safeSend, payload);
				}
			: undefined,
		onAbortPending: safeSend
			? (payload: TtsrAbortPendingPayload) => safeSend('ttsr:abortPending', payload)
			: undefined,
	});

	runtime.attach(processManager);
	processManager.setParsedEventObserver((sessionId, event) => {
		runtime.observe(sessionId, event);
	});

	return runtime;
}
