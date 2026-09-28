/**
 * Annotator settings slice for settingsStore.
 *
 * Pulled out of settingsStore.ts (which was hitting frequent main/rc merge
 * conflicts from being one large file every feature added lines to) as the
 * first of a series of domain slices. This is a template for the pattern:
 * state fields, action signatures, action implementations, and hydration for
 * one self-contained settings domain, composed into the main store rather
 * than declared inline there.
 */

import type { StateCreator } from 'zustand';
import type { SettingsStore } from './settingsStore';

export interface AnnotatorState {
	annotatorPenColor: string;
	annotatorPenSize: number;
	annotatorThinning: number;
	annotatorSmoothing: number;
	annotatorStreamline: number;
	annotatorTaperStart: number;
	annotatorTaperEnd: number;
	annotatorTextColor: string;
	annotatorTextSize: number;
	annotatorTextFont: string;
	annotatorTextBgColor: string;
}

export interface AnnotatorActions {
	setAnnotatorPenColor: (value: string) => void;
	setAnnotatorPenSize: (value: number) => void;
	setAnnotatorThinning: (value: number) => void;
	setAnnotatorSmoothing: (value: number) => void;
	setAnnotatorStreamline: (value: number) => void;
	setAnnotatorTaperStart: (value: number) => void;
	setAnnotatorTaperEnd: (value: number) => void;
	setAnnotatorTextColor: (value: string) => void;
	setAnnotatorTextSize: (value: number) => void;
	setAnnotatorTextFont: (value: string) => void;
	setAnnotatorTextBgColor: (value: string) => void;
}

export type AnnotatorSlice = AnnotatorState & AnnotatorActions;

export const createAnnotatorSlice: StateCreator<SettingsStore, [], [], AnnotatorSlice> = (set) => ({
	annotatorPenColor: '#9146FF',
	annotatorPenSize: 10,
	annotatorThinning: 0.5,
	annotatorSmoothing: 0.5,
	annotatorStreamline: 0.5,
	annotatorTaperStart: 0,
	annotatorTaperEnd: 0,
	annotatorTextColor: '#9146FF',
	annotatorTextSize: 24,
	annotatorTextFont: 'sans-serif',
	annotatorTextBgColor: '',

	setAnnotatorPenColor: (value) => {
		set({ annotatorPenColor: value });
		window.maestro.settings.set('annotatorPenColor', value);
	},

	setAnnotatorPenSize: (value) => {
		set({ annotatorPenSize: value });
		window.maestro.settings.set('annotatorPenSize', value);
	},

	setAnnotatorThinning: (value) => {
		set({ annotatorThinning: value });
		window.maestro.settings.set('annotatorThinning', value);
	},

	setAnnotatorSmoothing: (value) => {
		set({ annotatorSmoothing: value });
		window.maestro.settings.set('annotatorSmoothing', value);
	},

	setAnnotatorStreamline: (value) => {
		set({ annotatorStreamline: value });
		window.maestro.settings.set('annotatorStreamline', value);
	},

	setAnnotatorTaperStart: (value) => {
		set({ annotatorTaperStart: value });
		window.maestro.settings.set('annotatorTaperStart', value);
	},

	setAnnotatorTaperEnd: (value) => {
		set({ annotatorTaperEnd: value });
		window.maestro.settings.set('annotatorTaperEnd', value);
	},

	setAnnotatorTextColor: (value) => {
		set({ annotatorTextColor: value });
		window.maestro.settings.set('annotatorTextColor', value);
	},

	setAnnotatorTextSize: (value) => {
		set({ annotatorTextSize: value });
		window.maestro.settings.set('annotatorTextSize', value);
	},

	setAnnotatorTextFont: (value) => {
		set({ annotatorTextFont: value });
		window.maestro.settings.set('annotatorTextFont', value);
	},

	setAnnotatorTextBgColor: (value) => {
		set({ annotatorTextBgColor: value });
		window.maestro.settings.set('annotatorTextBgColor', value);
	},
});

/** Mutates `patch` in place with any persisted annotator fields found in `allSettings`. */
export function hydrateAnnotatorSettings(
	allSettings: Record<string, unknown>,
	patch: Partial<AnnotatorState>
): void {
	if (allSettings['annotatorPenColor'] !== undefined)
		patch.annotatorPenColor = allSettings['annotatorPenColor'] as string;

	if (allSettings['annotatorPenSize'] !== undefined)
		patch.annotatorPenSize = allSettings['annotatorPenSize'] as number;

	if (allSettings['annotatorThinning'] !== undefined)
		patch.annotatorThinning = allSettings['annotatorThinning'] as number;

	if (allSettings['annotatorSmoothing'] !== undefined)
		patch.annotatorSmoothing = allSettings['annotatorSmoothing'] as number;

	if (allSettings['annotatorStreamline'] !== undefined)
		patch.annotatorStreamline = allSettings['annotatorStreamline'] as number;

	if (allSettings['annotatorTaperStart'] !== undefined)
		patch.annotatorTaperStart = allSettings['annotatorTaperStart'] as number;

	if (allSettings['annotatorTaperEnd'] !== undefined)
		patch.annotatorTaperEnd = allSettings['annotatorTaperEnd'] as number;

	if (allSettings['annotatorTextColor'] !== undefined)
		patch.annotatorTextColor = allSettings['annotatorTextColor'] as string;

	if (allSettings['annotatorTextSize'] !== undefined)
		patch.annotatorTextSize = allSettings['annotatorTextSize'] as number;

	if (allSettings['annotatorTextFont'] !== undefined)
		patch.annotatorTextFont = allSettings['annotatorTextFont'] as string;

	if (allSettings['annotatorTextBgColor'] !== undefined)
		patch.annotatorTextBgColor = allSettings['annotatorTextBgColor'] as string;
}
