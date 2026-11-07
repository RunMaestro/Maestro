/**
 * useVoiceRuntimes - A Cappella's view of the native runtimes.
 *
 * The runtime counterpart of `useVoiceModels`, and like it a thin wrapper over
 * the core hook (`useLocalRuntimes`), which owns the listing, the live progress
 * map, and the install action. The voice part is only which channels it calls:
 * the Encore-gated `window.maestro.voice.runtimes`, whose listing also names the
 * voice slots each runtime serves, and the `ACappellaDisabled` rejection those
 * channels return while the feature is off is not shown as an error.
 *
 * Mounting it issues exactly ONE call, `runtimes:list`, a disk read against a
 * frozen table, so Voice Setup can show the full bill of materials before the
 * user agrees to fetch anything.
 */

import type { VoiceRuntimeListing } from '../../../../main/ipc/handlers/acappella-models';
import { useLocalRuntimes, type LocalRuntimesState } from '../../../hooks/localModels';
import { isACappellaDisabledError } from './useVoiceModels';

export type VoiceRuntimesState = LocalRuntimesState<VoiceRuntimeListing>;

/**
 * @param enabled Mirror of the A Cappella Encore flag. When false the listing is
 *                skipped, because the channel would reject.
 */
export function useVoiceRuntimes(enabled: boolean): VoiceRuntimesState {
	return useLocalRuntimes<VoiceRuntimeListing>({
		source: window.maestro.voice.runtimes,
		listEnabled: enabled,
		isQuietError: isACappellaDisabledError,
	});
}
