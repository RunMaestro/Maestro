/**
 * Dispatch callbacks - `maestro-cli dispatch --notify-on-complete <caller>`.
 *
 * See dispatch-callback-registry.ts for the correlation model and
 * dispatch-callback-service.ts for the delivery seam.
 */

export {
	DispatchCallbackRegistry,
	buildProcessSessionId,
	AUTORUN_GRACE_MS,
	DEFAULT_CALLBACK_TIMEOUT_MS,
	MAX_CALLBACK_TIMEOUT_MS,
	MAX_ARMED_CALLBACKS,
	SPAWN_LOOKBACK_MS,
} from './dispatch-callback-registry';
export type { DispatchCallbackRegistryDeps } from './dispatch-callback-registry';
export {
	DEFAULT_CALLBACK_PROMPT,
	DISPATCH_OUTPUT_MAX_CHARS,
	buildDispatchVariables,
	renderCallbackPrompt,
	truncateDispatchOutput,
} from './dispatch-callback-prompt';
export {
	initDispatchCallbacks,
	getDispatchCallbackRegistry,
	disposeDispatchCallbacks,
} from './dispatch-callback-service';
export type { DispatchCallbackServiceDeps } from './dispatch-callback-service';
export type {
	DispatchCallbackEntry,
	DispatchCallbackFire,
	DispatchCallbackRegistration,
	DispatchCallbackState,
	DispatchCallbackStatus,
} from './types';
