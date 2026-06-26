import { useState } from 'react';
import { logger } from '../../../../../utils/logger';
import type { FontConfigurationState } from '../types';

export function useFontConfigurationState(): FontConfigurationState {
	const [systemFonts, setSystemFonts] = useState<string[]>([]);
	const [customFonts, setCustomFonts] = useState<string[]>([]);
	const [fontLoading, setFontLoading] = useState(false);
	const [fontsLoaded, setFontsLoaded] = useState(false);

	const loadFonts = async () => {
		if (fontsLoaded) return;

		setFontLoading(true);
		try {
			const detected = await window.maestro.fonts.detect();
			setSystemFonts(detected);

			const savedCustomFonts = (await window.maestro.settings.get('customFonts')) as
				| string[]
				| undefined;
			if (savedCustomFonts && Array.isArray(savedCustomFonts)) {
				setCustomFonts(savedCustomFonts);
			}
			setFontsLoaded(true);
		} catch (error) {
			logger.error('Failed to load fonts:', undefined, error);
		} finally {
			setFontLoading(false);
		}
	};

	const handleFontInteraction = () => {
		if (!fontsLoaded && !fontLoading) {
			loadFonts();
		}
	};

	const addCustomFont = (font: string) => {
		if (font && !customFonts.includes(font)) {
			const newCustomFonts = [...customFonts, font];
			setCustomFonts(newCustomFonts);
			window.maestro.settings.set('customFonts', newCustomFonts);
		}
	};

	const removeCustomFont = (font: string) => {
		const newCustomFonts = customFonts.filter((f) => f !== font);
		setCustomFonts(newCustomFonts);
		window.maestro.settings.set('customFonts', newCustomFonts);
	};

	return {
		systemFonts,
		customFonts,
		fontLoading,
		fontsLoaded,
		handleFontInteraction,
		addCustomFont,
		removeCustomFont,
	};
}
