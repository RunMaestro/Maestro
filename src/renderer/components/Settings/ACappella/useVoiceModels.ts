/**
 * useVoiceModels - A Cappella's view of the Local Models model store.
 *
 * Both A Cappella surfaces (Voice Setup and the Models page) read from this
 * hook, so they cannot disagree about what is installed. It is a thin wrapper
 * over the core `useLocalModels`, which owns the listing, the live progress map,
 * and the actions. This file only decides three voice things: the calls go
 * through the Encore-gated `window.maestro.voice.models` channels, voice
 * readiness is read in the same refresh as the listing, and the
 * `ACappellaDisabled` rejection every gated channel returns while the feature
 * is off is not shown as an error.
 *
 * Mounting it issues the listing, readiness, and footprint reads and nothing
 * else - opening Voice Setup must not touch the network, which is what
 * `VoiceSetupPanel.test.tsx` asserts.
 */

import { useMemo } from 'react';

import type { VoiceModelListing } from '../../../../main/ipc/handlers/acappella-models';
import type { VoiceReadiness } from '../../../../shared/acappella/readiness';
import { useLocalModels, type LocalModelsState } from '../../../hooks/localModels';

export interface VoiceModelsState extends Omit<LocalModelsState<VoiceModelListing>, 'extra'> {
	readiness: VoiceReadiness | null;
}

/** The feature being off is not an error worth showing; every gated channel rejects with it. */
export function isACappellaDisabledError(message: string): boolean {
	return message.includes('ACappellaDisabled');
}

const readVoiceReadiness = (): Promise<VoiceReadiness> => window.maestro.voice.models.readiness();

/**
 * @param enabled Mirror of the A Cappella Encore flag. When false the catalog
 *                listing is skipped (the channel would reject) but the footprint
 *                is still read, because the reclaim-disk offer exists precisely
 *                for the moment after the feature was switched off.
 */
export function useVoiceModels(enabled: boolean): VoiceModelsState {
	const state = useLocalModels<VoiceModelListing, VoiceReadiness>({
		source: window.maestro.voice.models,
		listEnabled: enabled,
		loadExtra: readVoiceReadiness,
		isQuietError: isACappellaDisabledError,
	});
	// The core state is memoized, so this keeps its identity between commits.
	return useMemo(() => {
		const { extra, ...rest } = state;
		return { ...rest, readiness: extra };
	}, [state]);
}
