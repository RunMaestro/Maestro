/**
 * The one way a local provider reaches a native runtime.
 *
 * `native-loader.ts` already owns the dynamic imports, the classification, and
 * the memory of what has failed. What it does NOT do is speak the providers'
 * language: it returns a `NativeRuntimeUnavailable`, and a provider needs a
 * `VoiceProviderError` so the session can announce the failure with the right
 * code and the right recovery.
 *
 * That translation is three lines and it was about to be written three times, in
 * three providers, each with slightly different wording for the same event. Doing
 * it once also keeps one property true by construction: **a local provider that
 * cannot load its runtime fails as itself and never reaches for another
 * provider.** There is no branch in here that could.
 *
 * The failure stays remembered inside the loader, which is what the capability
 * gate reads to explain the blocked slot afterwards.
 */

import type { NativeRuntimeId } from '../../../../shared/acappella/native-runtimes';
import { VoiceProviderError } from '../../../../shared/acappella/provider-errors';
import { tryLoadNativeRuntime } from '../../runtime/native-loader';

/**
 * Load a native runtime for a provider, or throw a classified provider failure.
 *
 * @param runtimeId The runtime, as named in `shared/acappella/native-runtimes.ts`.
 * @param providerId The provider asking, so the error can name the engine.
 */
export async function loadLocalRuntime<T>(
	runtimeId: NativeRuntimeId,
	providerId: string
): Promise<T> {
	const result = await tryLoadNativeRuntime<T>(runtimeId);
	if (result.ok) return result.module;

	throw new VoiceProviderError(result.error.message, {
		kind: 'unavailable',
		providerId,
		cause: result.error,
	});
}
