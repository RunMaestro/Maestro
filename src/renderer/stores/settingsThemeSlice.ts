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
import { TYPOGRAPHY_PRESETS, type TypographyPresetId } from '../../shared/typographyPresets';
import { MAESTRO_FONT_STACK } from '../../shared/fontStack';
import type { GlossLevel } from '../../shared/themeGloss';
import { DEFAULT_GLOSS_LEVEL, asGlossLevel } from '../../shared/themeGloss';
import {
	BASE_FONT_SIZE_DEFAULT,
	FONT_ZOOM_DEFAULT,
	SURFACE_FONT_SIZE_MAX,
	SURFACE_FONT_SIZE_MIN,
	TYPOGRAPHY_SURFACE_LIST,
	TYPOGRAPHY_SURFACE_SPECS,
	canInherit,
	clampFontZoom,
	clampSurfaceFontSize,
	type TypographySurface,
} from '../../shared/typography';
import type { SettingsStore } from './settingsStore';

export interface ThemeState {
	fontFamily: string;
	terminalFontFamily: string;
	chatFontFamily: string;
	filePreviewFontFamily: string;
	fileEditorFontFamily: string;
	documentGraphFontFamily: string;
	/**
	 * Interface font size in px, before zoom. The base every other surface
	 * inherits when its own size is 0.
	 */
	fontSize: number;
	chatFontSize: number;
	terminalFontSize: number;
	filePreviewFontSize: number;
	fileEditorFontSize: number;
	documentGraphFontSize: number;
	/**
	 * Cmd+= / Cmd+- multiplier, applied to every surface equally so zooming
	 * preserves whatever proportions the user set between them.
	 */
	fontZoom: number;
	activeThemeId: ThemeId;
	customThemeColors: ThemeColors;
	customThemeBaseId: ThemeId;
	colorBlindMode: boolean;
	themeGloss: GlossLevel;
	/**
	 * Whether the typography chooser has been shown. False on a fresh install
	 * AND on every install that predates the chooser, which is what makes the
	 * same modal reach existing users once after the update.
	 */
	typographyPromptSeen: boolean;
	/** Whether the first-run theme chooser has been shown. See onboardingSeries. */
	themePromptSeen: boolean;
	/** Whether the "your agents can drive Maestro" step has been shown. */
	agentPowersPromptSeen: boolean;
}

export interface ThemeActions {
	setFontFamily: (value: string) => void;
	setTerminalFontFamily: (value: string) => void;
	setChatFontFamily: (value: string) => void;
	setFilePreviewFontFamily: (value: string) => void;
	setFileEditorFontFamily: (value: string) => void;
	setFontSize: (value: number) => void;
	setSurfaceFontFamily: (surface: TypographySurface, value: string) => void;
	setSurfaceFontSize: (surface: TypographySurface, value: number) => void;
	setFontZoom: (value: number) => void;
	/** Restore both fonts and sizes to a preset. The Factory Reset control. */
	resetTypography: (id: TypographyPresetId) => void;
	setActiveThemeId: (value: ThemeId) => void;
	setCustomThemeColors: (value: ThemeColors) => void;
	setCustomThemeBaseId: (value: ThemeId) => void;
	setColorBlindMode: (value: boolean) => void;
	setThemeGloss: (value: GlossLevel) => void;
	setTypographyPromptSeen: (value: boolean) => void;
	setThemePromptSeen: (value: boolean) => void;
	setAgentPowersPromptSeen: (value: boolean) => void;
	/** Write all five font settings at once from a typography preset. */
	applyTypographyPreset: (id: TypographyPresetId) => void;
}

export type ThemeSlice = ThemeState & ThemeActions;

export const createThemeSlice: StateCreator<SettingsStore, [], [], ThemeSlice> = (set) => ({
	fontFamily: MAESTRO_FONT_STACK,
	terminalFontFamily: '',
	chatFontFamily: '',
	filePreviewFontFamily: '',
	fileEditorFontFamily: '',
	documentGraphFontFamily: '',
	fontSize: BASE_FONT_SIZE_DEFAULT,
	chatFontSize: 0,
	terminalFontSize: 0,
	filePreviewFontSize: 0,
	fileEditorFontSize: 0,
	documentGraphFontSize: 0,
	fontZoom: FONT_ZOOM_DEFAULT,
	activeThemeId: 'dracula',
	customThemeColors: DEFAULT_CUSTOM_THEME_COLORS,
	customThemeBaseId: 'dracula',
	colorBlindMode: false,
	themeGloss: DEFAULT_GLOSS_LEVEL,
	typographyPromptSeen: false,
	themePromptSeen: false,
	agentPowersPromptSeen: false,

	setFontFamily: (value) => {
		set({ fontFamily: value });
		window.maestro.settings.set('fontFamily', value);
	},

	setTerminalFontFamily: (value) => {
		set({ terminalFontFamily: value });
		window.maestro.settings.set('terminalFontFamily', value);
	},

	setChatFontFamily: (value) => {
		set({ chatFontFamily: value });
		window.maestro.settings.set('chatFontFamily', value);
	},

	setFilePreviewFontFamily: (value) => {
		set({ filePreviewFontFamily: value });
		window.maestro.settings.set('filePreviewFontFamily', value);
	},

	setFileEditorFontFamily: (value) => {
		set({ fileEditorFontFamily: value });
		window.maestro.settings.set('fileEditorFontFamily', value);
	},

	setFontSize: (value) => {
		set({ fontSize: value });
		window.maestro.settings.set('fontSize', value);
	},

	setSurfaceFontFamily: (surface, value) => {
		// Writes through the registry rather than a switch, so a new surface is
		// settable the moment it is registered.
		const spec = TYPOGRAPHY_SURFACE_SPECS[surface];
		set({ [spec.fontKey]: value } as Partial<ThemeState>);
		window.maestro.settings.set(spec.fontKey, value);
	},

	setSurfaceFontSize: (surface, value) => {
		const spec = TYPOGRAPHY_SURFACE_SPECS[surface];
		// The interface surface is the base of the inheritance chain, so a 0
		// there would mean "inherit from myself". Route it to setFontSize,
		// which clamps against the base bounds instead.
		if (!canInherit(spec)) {
			const clamped = Math.max(
				SURFACE_FONT_SIZE_MIN,
				Math.min(SURFACE_FONT_SIZE_MAX, Math.round(value) || BASE_FONT_SIZE_DEFAULT)
			);
			set({ fontSize: clamped });
			window.maestro.settings.set('fontSize', clamped);
			return;
		}
		const clamped = clampSurfaceFontSize(value);
		set({ [spec.sizeKey]: clamped } as Partial<ThemeState>);
		window.maestro.settings.set(spec.sizeKey, clamped);
	},

	setFontZoom: (value) => {
		const zoom = clampFontZoom(value);
		set({ fontZoom: zoom });
		window.maestro.settings.set('fontZoom', zoom);
	},

	resetTypography: (id) => {
		const preset = TYPOGRAPHY_PRESETS[id];
		// Sizes go back with the fonts: a preset that restored only families
		// would leave a proportional face rendering at a size that was tuned
		// for a monospace one, which is exactly the mismatch Factory Reset
		// exists to undo. Zoom is deliberately NOT reset - it is an
		// accessibility accommodation, not part of the look.
		const patch = { ...preset.fonts, ...preset.sizes };
		// One `set` so the app repaints once instead of flashing through nine
		// intermediate states.
		set(patch);
		for (const [key, value] of Object.entries(patch)) {
			window.maestro.settings.set(key, value);
		}
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

	setThemeGloss: (value) => {
		// Narrow even here. The Settings slider can only produce a valid
		// level, but this setter is also the landing point for the value the
		// CLI wrote, and an unrecognized string on <html data-gloss> matches
		// no rule, so the user sees the control silently do nothing.
		const level = asGlossLevel(value);
		set({ themeGloss: level });
		window.maestro.settings.set('themeGloss', level);
	},

	setTypographyPromptSeen: (value) => {
		set({ typographyPromptSeen: value });
		window.maestro.settings.set('typographyPromptSeen', value);
	},

	setThemePromptSeen: (value) => {
		set({ themePromptSeen: value });
		window.maestro.settings.set('themePromptSeen', value);
	},

	setAgentPowersPromptSeen: (value) => {
		set({ agentPowersPromptSeen: value });
		window.maestro.settings.set('agentPowersPromptSeen', value);
	},

	applyTypographyPreset: (id) => {
		const fonts = TYPOGRAPHY_PRESETS[id].fonts;
		// One `set` for all five so the app repaints once rather than flashing
		// through four intermediate mixes of the old and new preset.
		set(fonts);
		for (const [key, value] of Object.entries(fonts)) {
			window.maestro.settings.set(key, value);
		}
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

	if (allSettings['chatFontFamily'] !== undefined)
		patch.chatFontFamily = allSettings['chatFontFamily'] as string;

	if (allSettings['filePreviewFontFamily'] !== undefined)
		patch.filePreviewFontFamily = allSettings['filePreviewFontFamily'] as string;

	if (allSettings['fileEditorFontFamily'] !== undefined)
		patch.fileEditorFontFamily = allSettings['fileEditorFontFamily'] as string;

	if (allSettings['documentGraphFontFamily'] !== undefined)
		patch.documentGraphFontFamily = allSettings['documentGraphFontFamily'] as string;

	if (allSettings['fontSize'] !== undefined) patch.fontSize = allSettings['fontSize'] as number;

	if (allSettings['activeThemeId'] !== undefined)
		patch.activeThemeId = allSettings['activeThemeId'] as ThemeId;

	if (allSettings['customThemeColors'] !== undefined)
		patch.customThemeColors = allSettings['customThemeColors'] as ThemeColors;

	if (allSettings['customThemeBaseId'] !== undefined)
		patch.customThemeBaseId = allSettings['customThemeBaseId'] as ThemeId;

	for (const spec of TYPOGRAPHY_SURFACE_LIST) {
		if (!canInherit(spec)) continue;
		const raw = allSettings[spec.sizeKey];
		if (raw !== undefined) {
			(patch as Record<string, unknown>)[spec.sizeKey] = clampSurfaceFontSize(Number(raw));
		}
	}

	if (allSettings['fontZoom'] !== undefined)
		patch.fontZoom = clampFontZoom(Number(allSettings['fontZoom']));

	if (allSettings['typographyPromptSeen'] !== undefined)
		patch.typographyPromptSeen = Boolean(allSettings['typographyPromptSeen']);

	if (allSettings['themePromptSeen'] !== undefined)
		patch.themePromptSeen = Boolean(allSettings['themePromptSeen']);

	if (allSettings['agentPowersPromptSeen'] !== undefined)
		patch.agentPowersPromptSeen = Boolean(allSettings['agentPowersPromptSeen']);

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

	// Narrowed rather than cast: this value can arrive from an older build, a
	// hand-edited settings file, or `maestro-cli settings set`, and an
	// unrecognized level would render as permanently-off with no error.
	if (allSettings['themeGloss'] !== undefined)
		patch.themeGloss = asGlossLevel(allSettings['themeGloss']);
}
