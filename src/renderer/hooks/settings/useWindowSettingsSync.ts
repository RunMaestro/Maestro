/**
 * The settings side effects every renderer window needs, whatever it renders.
 *
 * The main window gets these through `useSettings`. A secondary window that
 * boots its own renderer and mounts a single view (Quick Chat) does not run
 * `useSettings`, and before these were pulled out of it that window loaded the
 * settings once and then ignored them: its text came out in the store-default
 * monospace face whatever typography the user had picked, and a theme or font
 * changed in the main window never reached it.
 */

import { useEffect } from 'react';
import { useStoreWithEqualityFn } from 'zustand/traditional';
import { shallow } from 'zustand/shallow';
import { loadAllSettings, useSettingsStore, type SettingsStore } from '../../stores/settingsStore';
import { useVoiceUiStore } from '../../stores/voiceUiStore';
import { applyTypographyVars } from '../../utils/applyTypographyVars';
import { logger } from '../../utils/logger';

const selectTypography = (s: SettingsStore) => ({
	settingsLoaded: s.settingsLoaded,
	fontFamily: s.fontFamily,
	chatFontFamily: s.chatFontFamily,
	terminalFontFamily: s.terminalFontFamily,
	filePreviewFontFamily: s.filePreviewFontFamily,
	fileEditorFontFamily: s.fileEditorFontFamily,
	documentGraphFontFamily: s.documentGraphFontFamily,
	fontSize: s.fontSize,
	chatFontSize: s.chatFontSize,
	terminalFontSize: s.terminalFontSize,
	filePreviewFontSize: s.filePreviewFontSize,
	fileEditorFontSize: s.fileEditorFontSize,
	documentGraphFontSize: s.documentGraphFontSize,
	fontZoom: s.fontZoom,
});

/**
 * Publish the resolved typography as CSS custom properties on the document
 * root, and set the root font-size so rem-based Tailwind spacing scales.
 *
 * The custom properties are how a font setting reaches surfaces no prop can
 * carry: everything that portals to document.body and every `font-mono`
 * utility. See applyTypographyVars.
 *
 * Gated on settingsLoaded so the window does not paint at the default size and
 * then jump to the saved one.
 */
export function usePublishTypographyVars(): void {
	const t = useStoreWithEqualityFn(useSettingsStore, selectTypography, shallow);
	useEffect(() => {
		if (!t.settingsLoaded) return;
		applyTypographyVars({
			fonts: {
				interface: t.fontFamily,
				chat: t.chatFontFamily,
				terminal: t.terminalFontFamily,
				filePreview: t.filePreviewFontFamily,
				fileEditor: t.fileEditorFontFamily,
				documentGraph: t.documentGraphFontFamily,
			},
			sizes: {
				interface: t.fontSize,
				chat: t.chatFontSize,
				terminal: t.terminalFontSize,
				filePreview: t.filePreviewFontSize,
				fileEditor: t.fileEditorFontSize,
				documentGraph: t.documentGraphFontSize,
			},
			baseSize: t.fontSize,
			zoom: t.fontZoom,
		});
	}, [t]);
}

/**
 * Reload settings when they change outside this window: `maestro-cli settings
 * set`, a hand edit of the file, or a write from another window (main notifies
 * every peer window, never the writer itself).
 */
export function useReloadSettingsOnExternalChange(): void {
	useEffect(() => {
		if (!window.maestro?.settings?.onExternalChange) {
			return;
		}
		const cleanup = window.maestro.settings.onExternalChange(() => {
			logger.info('[Settings] External settings change detected, reloading');
			loadAllSettings();
			// The Left Bar draws a wake-phrase badge per agent from a mirror of the
			// A Cappella blob, which is not in the settings store. `maestro-cli voice
			// wake-phrase` writes that blob, so the mirror is re-read here. Only once
			// it has loaded: a window that never showed voice has nothing to refresh.
			const voiceUi = useVoiceUiStore.getState();
			if (voiceUi.loaded) void voiceUi.refreshWakePhrases();
		});
		return cleanup;
	}, []);
}

/**
 * Everything a secondary renderer window needs to honor the user's settings:
 * load them once, follow changes made elsewhere, and publish the typography.
 */
export function useWindowSettingsSync(): void {
	useEffect(() => {
		void loadAllSettings();
	}, []);
	useReloadSettingsOnExternalChange();
	usePublishTypographyVars();
}
