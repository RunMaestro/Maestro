/**
 * useDirection — Returns RTL-aware direction utilities.
 *
 * Reads the current language from the settings store and provides:
 *   - `isRtl`: whether the UI is in a right-to-left language
 *   - `dir`: the current direction ('ltr' | 'rtl')
 *   - `isForward(key)`: true when a keyboard arrow key points "forward"
 *     (ArrowRight in LTR, ArrowLeft in RTL)
 *   - `isBackward(key)`: true when an arrow key points "backward"
 *
 * Used for RTL-aware keyboard navigation (WCAG 2.1 SC 1.3.2).
 */

import { useMemo } from 'react';
import { useSettingsStore } from '../stores/settingsStore';
import { isRtlLanguage } from '../components/shared/DirectionProvider';

export interface DirectionUtils {
	isRtl: boolean;
	dir: 'ltr' | 'rtl';
	/** True when the arrow key points in the "forward" direction (right in LTR, left in RTL). */
	isForward: (key: string) => boolean;
	/** True when the arrow key points in the "backward" direction (left in LTR, right in RTL). */
	isBackward: (key: string) => boolean;
}

export function useDirection(): DirectionUtils {
	const language = useSettingsStore((s) => s.language);

	return useMemo(() => {
		const rtl = isRtlLanguage(language);
		return {
			isRtl: rtl,
			dir: rtl ? 'rtl' : 'ltr',
			isForward: (key: string) => (rtl ? key === 'ArrowLeft' : key === 'ArrowRight'),
			isBackward: (key: string) => (rtl ? key === 'ArrowRight' : key === 'ArrowLeft'),
		};
	}, [language]);
}
