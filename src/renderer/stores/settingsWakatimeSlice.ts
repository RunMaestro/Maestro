/**
 * Wakatime settings slice for settingsStore.
 *
 * Part of the same domain-slice decomposition as settingsAnnotatorSlice.ts -
 * see that file for the pattern this follows.
 */

import type { StateCreator } from 'zustand';
import type { SettingsStore } from './settingsStore';

export interface WakatimeState {
	wakatimeApiKey: string;
	wakatimeEnabled: boolean;
	wakatimeDetailedTracking: boolean;
}

export interface WakatimeActions {
	setWakatimeApiKey: (value: string) => void;
	setWakatimeEnabled: (value: boolean) => void;
	setWakatimeDetailedTracking: (value: boolean) => void;
}

export type WakatimeSlice = WakatimeState & WakatimeActions;

export const createWakatimeSlice: StateCreator<SettingsStore, [], [], WakatimeSlice> = (set) => ({
	wakatimeApiKey: '',
	wakatimeEnabled: false,
	wakatimeDetailedTracking: false,

	setWakatimeApiKey: (value) => {
		set({ wakatimeApiKey: value });
		window.maestro.settings.set('wakatimeApiKey', value);
	},

	setWakatimeEnabled: (value) => {
		set({ wakatimeEnabled: value });
		window.maestro.settings.set('wakatimeEnabled', value);
	},

	setWakatimeDetailedTracking: (value) => {
		set({ wakatimeDetailedTracking: value });
		window.maestro.settings.set('wakatimeDetailedTracking', value);
	},
});

/** Mutates `patch` in place with any persisted Wakatime fields found in `allSettings`. */
export function hydrateWakatimeSettings(
	allSettings: Record<string, unknown>,
	patch: Partial<WakatimeState>
): void {
	if (allSettings['wakatimeApiKey'] !== undefined)
		patch.wakatimeApiKey = allSettings['wakatimeApiKey'] as string;

	if (allSettings['wakatimeEnabled'] !== undefined)
		patch.wakatimeEnabled = allSettings['wakatimeEnabled'] as boolean;

	if (allSettings['wakatimeDetailedTracking'] !== undefined)
		patch.wakatimeDetailedTracking = allSettings['wakatimeDetailedTracking'] as boolean;
}
