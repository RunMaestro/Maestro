/**
 * The one way a voice provider reaches a native runtime.
 *
 * The core loader (`local-models/runtime/load-runtime.ts`) throws a
 * `LocalModelError`, which is the core's vocabulary. A provider needs a
 * `VoiceProviderError` so the session can announce the failure with the right
 * code and the right recovery. This is that translation, written once rather
 * than once per provider with slightly different wording for the same event.
 *
 * It keeps the core's property true on the voice side too: **a local provider
 * that cannot load its runtime fails as itself and never reaches for another
 * provider.** There is no branch in here that could.
 */

import type { NativeRuntimeId } from '../../../../shared/local-models/native-runtimes';
import { VoiceProviderError } from '../../../../shared/acappella/provider-errors';
import { isLocalModelError, type LocalModelError } from '../../../local-models/errors';
import { loadLocalRuntime } from '../../../local-models/runtime/load-runtime';

/** A core Local Models failure, restated as the voice provider that hit it. */
export function voiceErrorFromLocalModel(
	error: LocalModelError,
	providerId: string
): VoiceProviderError {
	return new VoiceProviderError(error.message, {
		// Every core code today means "this engine cannot run here", which is what
		// `unavailable` says: fixed in Voice Setup, not by pressing Retry.
		kind: 'unavailable',
		providerId,
		cause: (error as { cause?: unknown }).cause ?? error,
	});
}

/**
 * Load a native runtime for a voice provider, or throw a classified provider failure.
 *
 * @param runtimeId The runtime, as named in `shared/local-models/native-runtimes.ts`.
 * @param providerId The provider asking, so the error can name the engine.
 */
export async function loadVoiceRuntime<T>(
	runtimeId: NativeRuntimeId,
	providerId: string
): Promise<T> {
	try {
		return await loadLocalRuntime<T>(runtimeId, providerId);
	} catch (error) {
		if (isLocalModelError(error)) throw voiceErrorFromLocalModel(error, providerId);
		throw error;
	}
}
