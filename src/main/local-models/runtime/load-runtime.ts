/**
 * The one way a local-model consumer reaches a native runtime.
 *
 * `native-loader.ts` already owns the dynamic imports, the classification, and
 * the memory of what has failed. What it does NOT do is throw: it returns a
 * `NativeRuntimeUnavailable`. A consumer that just wants the module or a
 * classified failure calls this instead, and gets a {@link LocalModelError}
 * carrying the code and the recovery sentence, which it maps onto its own error
 * vocabulary at its boundary.
 *
 * Doing it once keeps one property true by construction: **a consumer that
 * cannot load its runtime fails as itself and never reaches for another
 * engine.** There is no branch in here that could.
 *
 * The failure stays remembered inside the loader, which is what a readiness
 * check (A Cappella's capability gate, for one) reads to explain the blocked
 * capability afterwards.
 */

import type { NativeRuntimeId } from '../../../shared/local-models/native-runtimes';
import { LocalModelError } from '../errors';
import { tryLoadNativeRuntime } from './native-loader';

/**
 * Load a native runtime for a consumer, or throw a classified failure.
 *
 * @param runtimeId The runtime, as named in `shared/local-models/native-runtimes.ts`.
 * @param consumerId Who is asking (a provider id, a feature id), so the error can name it.
 */
export async function loadLocalRuntime<T>(
	runtimeId: NativeRuntimeId,
	consumerId: string
): Promise<T> {
	const result = await tryLoadNativeRuntime<T>(runtimeId);
	if (result.ok) return result.module;

	throw new LocalModelError(result.error.message, {
		code: 'runtime-unavailable',
		recovery: result.error.suggestedAction,
		consumerId,
		cause: result.error,
	});
}
