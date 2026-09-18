/**
 * The font a surface should use when what it shows is shell text.
 *
 * Wraps {@link resolveFixedPitchFontFamily} in a memo because resolving costs
 * two canvas measurements, and the surfaces that need it (the command-mode
 * composer, shell command cards) re-render on every keystroke and every chunk
 * of streaming output.
 */

import { useMemo } from 'react';
import { resolveFixedPitchFontFamily } from '../../utils/fixedPitchFont';

/**
 * @param fontFamily - the configured font stack, usually `settings.fontFamily`
 * @param fontSize   - scale to measure at; only affects precision, not the verdict
 */
export function useFixedPitchFont(fontFamily: string, fontSize?: number): string {
	return useMemo(() => resolveFixedPitchFontFamily(fontFamily, fontSize), [fontFamily, fontSize]);
}
