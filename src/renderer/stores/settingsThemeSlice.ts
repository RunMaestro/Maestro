/**
 * Theme and appearance settings slice for settingsStore (color theme, fonts,
 * colorblind mode).
 *
 * Part of the same domain-slice decomposition as settingsAnnotatorSlice.ts -
 * see that file for the pattern this follows.
 */

import type { StateCreator } from 'zustand';
import type { ThemeId, ThemeColors } from '../types';
import { DEFAULT_CUSTOM_THEME_COLORS } from '../constants/themes';
import type { SettingsStore } from './settingsStore';

export interface ThemeState {
	fontFamily: string;
	terminalFontFamily: string;
	fontSize: number;
	activeThemeId: ThemeId;
	customThemeColors: ThemeColors;
	customThemeBaseId: ThemeId;
	colorBlindMode: boolean;
}

export interface ThemeActions {
	setFontFamily: (value: string) => void;
	setTerminalFontFamily: (value: string) => void;
	setFontSize: (value: number) => void;
	setActiveThemeId: (value: ThemeId) => void;
	setCustomThemeColors: (value: ThemeColors) => void;
	setCustomThemeBaseId: (value: ThemeId) => void;
	setColorBlindMode: (value: boolean) => void;
}

export type ThemeSlice = ThemeState & ThemeActions;

export const createThemeSlice: StateCreator<SettingsStore, [], [], ThemeSlice> = (set) => ({
	fontFamily: 'Roboto Mono, Menlo, "Courier New", monospace',
	terminalFontFamily: '',
	fontSize: 14,
	activeThemeId: 'dracula',
	customThemeColors: DEFAULT_CUSTOM_THEME_COLORS,
	customThemeBaseId: 'dracula',
	colorBlindMode: false,

	setFontFamily: (value) => {
		set({ fontFamily: value });
		window.maestro.settings.set('fontFamily', value);
	},

	setTerminalFontFamily: (value) => {
		set({ terminalFontFamily: value });
		window.maestro.settings.set('terminalFontFamily', value);
	},

	setFontSize: (value) => {
		set({ fontSize: value });
		window.maestro.settings.set('fontSize', value);
	},

	setActiveThemeId: (value) => {
		set({ activeThemeId: value });
		window.maestro.settings.set('activeThemeId', value);
	},

	setCustomThemeColors: (value) => {
		set({ customThemeColors: value });
		window.maestro.settings.set('customThemeColors', value);
	},

	setCustomThemeBaseId: (value) => {
		set({ customThemeBaseId: value });
		window.maestro.settings.set('customThemeBaseId', value);
	},

	setColorBlindMode: (value) => {
		set({ colorBlindMode: value });
		window.maestro.settings.set('colorBlindMode', value);
	},
});

/** Mutates `patch` in place with any persisted Theme/Appearance fields found in `allSettings`. */
export function hydrateThemeSettings(
	allSettings: Record<string, unknown>,
	patch: Partial<ThemeState>
): void {
	if (allSettings['fontFamily'] !== undefined)
		patch.fontFamily = allSettings['fontFamily'] as string;

	if (allSettings['terminalFontFamily'] !== undefined)
		patch.terminalFontFamily = allSettings['terminalFontFamily'] as string;

	if (allSettings['fontSize'] !== undefined) patch.fontSize = allSettings['fontSize'] as number;

	if (allSettings['activeThemeId'] !== undefined)
		patch.activeThemeId = allSettings['activeThemeId'] as ThemeId;

	if (allSettings['customThemeColors'] !== undefined)
		patch.customThemeColors = allSettings['customThemeColors'] as ThemeColors;

	if (allSettings['customThemeBaseId'] !== undefined)
		patch.customThemeBaseId = allSettings['customThemeBaseId'] as ThemeId;

	if (allSettings['colorBlindMode'] !== undefined) {
		// Legacy installs and the mobile/web client persist this as a
		// string ('none', 'enabled', 'deuteranopia', 'protanopia',
		// 'tritanopia', or the literal 'false'). A bare `as boolean` cast
		// leaves any non-empty string truthy, so 'none' silently forced
		// every Usage Dashboard chart onto the colorblind palette and
		// hid the active theme's accent. Coerce explicitly: any string
		// other than 'none'/'false'/'' is treated as "on".
		const raw = allSettings['colorBlindMode'];
		patch.colorBlindMode =
			raw === true || (typeof raw === 'string' && raw !== 'none' && raw !== 'false' && raw !== '');
	}
}
