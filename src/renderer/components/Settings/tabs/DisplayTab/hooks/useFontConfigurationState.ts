import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { logger } from '../../../../../utils/logger';
import { detectSystemFonts } from '../../../../../services/fontDetection';
import type { FontConfigurationState } from '../types';

/**
 * The custom font list is shared by every mounted picker section (Fonts and
 * Headings sit side by side). Each section holding its own copy let one
 * section's write save a list missing the other's addition, so the list lives
 * here, once, and every instance reads and writes it.
 */
let sharedCustomFonts: string[] = [];
/** Bumped on every write, so a read that started before it cannot clobber it. */
let customFontsWrites = 0;
const customFontsListeners = new Set<() => void>();

function publishCustomFonts(next: string[]): void {
	sharedCustomFonts = next;
	for (const listener of customFontsListeners) listener();
}

function writeCustomFonts(next: string[]): void {
	customFontsWrites += 1;
	window.maestro.settings.set('customFonts', next);
	publishCustomFonts(next);
}

function subscribeCustomFonts(listener: () => void): () => void {
	customFontsListeners.add(listener);
	return () => {
		customFontsListeners.delete(listener);
		// The last picker closing drops the copy; the next mount reads the
		// saved list fresh, as each instance did before the list was shared.
		if (customFontsListeners.size === 0) sharedCustomFonts = [];
	};
}

function getCustomFontsSnapshot(): string[] {
	return sharedCustomFonts;
}

export function useFontConfigurationState(): FontConfigurationState {
	const [systemFonts, setSystemFonts] = useState<string[]>([]);
	const customFonts = useSyncExternalStore(subscribeCustomFonts, getCustomFontsSnapshot);
	const [fontLoading, setFontLoading] = useState(false);
	const [fontsLoaded, setFontsLoaded] = useState(false);
	const [fontsReliable, setFontsReliable] = useState(true);

	// The saved custom fonts are loaded on mount rather than with the system
	// font sweep: the sweep is lazy (it only runs once the user opens a font
	// dropdown), so gating the pills on it made every added font vanish the
	// next time the Display tab was opened, and left the <select> unable to
	// render the current value when that value was a custom font.
	useEffect(() => {
		let cancelled = false;
		// A write that lands before this read resolves wins, so restoring the
		// saved list can't clobber a font the user just added.
		const writesAtStart = customFontsWrites;
		void (async () => {
			try {
				const saved = (await window.maestro.settings.get('customFonts')) as string[] | undefined;
				if (cancelled || customFontsWrites !== writesAtStart || !Array.isArray(saved)) return;
				publishCustomFonts(saved);
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
		if (!font || sharedCustomFonts.includes(font)) return;
		writeCustomFonts([...sharedCustomFonts, font]);
	}, []);

	const removeCustomFont = useCallback((font: string) => {
		if (!sharedCustomFonts.includes(font)) return;
		writeCustomFonts(sharedCustomFonts.filter((f) => f !== font));
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
