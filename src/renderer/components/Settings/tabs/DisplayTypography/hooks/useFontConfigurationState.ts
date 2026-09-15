import { useCallback, useEffect, useRef, useState } from 'react';
import { logger } from '../../../../../utils/logger';
import { detectSystemFonts } from '../../../../../services/fontDetection';
import type { FontConfigurationState } from '../types';

export function useFontConfigurationState(): FontConfigurationState {
	const [systemFonts, setSystemFonts] = useState<string[]>([]);
	const [customFonts, setCustomFonts] = useState<string[]>([]);
	const [fontLoading, setFontLoading] = useState(false);
	const [fontsLoaded, setFontsLoaded] = useState(false);
	const [fontsReliable, setFontsReliable] = useState(true);
	// Guards a write that lands before the initial read resolves, so restoring
	// the saved list can't clobber a font the user just added.
	const customFontsDirty = useRef(false);

	// The saved custom fonts are loaded on mount rather than with the system
	// font sweep: the sweep is lazy (it only runs once the user opens a font
	// dropdown), so gating the pills on it made every added font vanish the
	// next time the Display tab was opened, and left the <select> unable to
	// render the current value when that value was a custom font.
	useEffect(() => {
		let cancelled = false;
		void (async () => {
			try {
				const saved = (await window.maestro.settings.get('customFonts')) as string[] | undefined;
				if (cancelled || customFontsDirty.current || !Array.isArray(saved)) return;
				setCustomFonts(saved);
			} catch (error) {
				logger.error('Failed to load custom fonts:', undefined, error);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	const loadFonts = useCallback(async () => {
		setFontLoading(true);
		try {
			// detectSystemFonts never rejects - a total failure still returns a
			// result flagged unreliable, which is what the picker gates its
			// "(Not Found)" annotations on.
			const detected = await detectSystemFonts();
			setSystemFonts(detected.fonts);
			setFontsReliable(detected.reliable);
			setFontsLoaded(true);
			if (!detected.reliable) {
				logger.info('Font detection degraded; availability will not be annotated', undefined, {
					reason: detected.reason,
				});
			}
		} finally {
			setFontLoading(false);
		}
	}, []);

	const handleFontInteraction = useCallback(() => {
		if (!fontsLoaded && !fontLoading) {
			void loadFonts();
		}
	}, [fontsLoaded, fontLoading, loadFonts]);

	const addCustomFont = useCallback((font: string) => {
		if (!font) return;
		setCustomFonts((prev) => {
			if (prev.includes(font)) return prev;
			const next = [...prev, font];
			customFontsDirty.current = true;
			window.maestro.settings.set('customFonts', next);
			return next;
		});
	}, []);

	const removeCustomFont = useCallback((font: string) => {
		setCustomFonts((prev) => {
			if (!prev.includes(font)) return prev;
			const next = prev.filter((f) => f !== font);
			customFontsDirty.current = true;
			window.maestro.settings.set('customFonts', next);
			return next;
		});
	}, []);

	return {
		systemFonts,
		customFonts,
		fontLoading,
		fontsLoaded,
		fontsReliable,
		handleFontInteraction,
		addCustomFont,
		removeCustomFont,
	};
}
