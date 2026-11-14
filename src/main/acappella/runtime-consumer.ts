/**
 * A Cappella as a Local Models runtime consumer.
 *
 * The core loader only calls a downloadable runtime "not downloaded yet" when
 * some feature can actually run on it, and it names the place to fetch it from
 * the consumer's own registration. This is voice's registration: the runtimes
 * its listed providers (and the wake word) ride, and where the engines and the
 * self-test live.
 *
 * Registered at startup whether or not the Encore Feature is on, because the
 * debug package runs the self-test regardless, and an unregistered runtime would
 * read as "not part of this build" there.
 */

import { isNativeRuntimeUsedByVoice } from '../../shared/acappella/provider-catalog';
import { modelsSettingsLocation } from '../../shared/local-models/settings-location';
import { registerNativeRuntimeConsumer } from '../local-models/runtime/runtime-consumers';

export const ACAPPELLA_RUNTIME_CONSUMER_ID = 'acappella';

export function registerACappellaRuntimeConsumer(): () => void {
	return registerNativeRuntimeConsumer({
		id: ACAPPELLA_RUNTIME_CONSUMER_ID,
		usesRuntime: isNativeRuntimeUsedByVoice,
		downloadLocation: modelsSettingsLocation('library', 'engines'),
		selfTestLocation: 'Settings > Plugins > A Cappella > Voice self-test',
	});
}
