/**
 * Time-Traveling Stream Rules - main-process entry point.
 *
 * One call from `src/main/index.ts` builds the runtime and injects the stream
 * observer into the process manager. Everything else about TTSR stays behind
 * this module; the process manager never imports it.
 */

import type { ParsedEventObserver } from '../process-manager/types';
import type { TtsrMatchedPayload } from '../../shared/ttsr-types';
import { TtsrRuntime } from './ttsr-runtime';
import type { TtsrProcessEventSource } from './ttsr-spawn-registry';

export { TtsrRuntime } from './ttsr-runtime';
export { TtsrManager } from './ttsr-manager';
export { TtsrSpawnRegistry } from './ttsr-spawn-registry';
export { TtsrStateStore } from './ttsr-state-store';
export * from './config/ttsr-config-loader';

/** The process-manager surface TTSR needs. */
export interface TtsrProcessManagerLike extends TtsrProcessEventSource {
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
}

/**
 * Build the TTSR runtime and attach it to a process manager. While the gate is
 * off the observer returns before doing any work, so the tap is a true no-op.
 */
export function installTtsrRuntime(
	processManager: TtsrProcessManagerLike,
	options: InstallTtsrOptions
): TtsrRuntime {
	const runtime = new TtsrRuntime({
		isGloballyEnabled: options.isGloballyEnabled,
		getDisabledRules: options.getDisabledRules,
		onMatched: options.safeSend
			? (payload: TtsrMatchedPayload) => options.safeSend?.('ttsr:matched', payload)
			: undefined,
	});

	runtime.attach(processManager);
	processManager.setParsedEventObserver((sessionId, event) => {
		runtime.observe(sessionId, event);
	});

	return runtime;
}
