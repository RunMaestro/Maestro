import { memo } from 'react';
import type { Theme } from '../../types';
import { formatShortcutKeys } from '../../utils/shortcutFormatter';

export interface ShortcutHintProps {
	/** Raw shortcut keys (e.g. `['Meta', 'Shift', 'r']`); formatted per platform. */
	keys: string[];
	theme: Theme;
}

/**
 * The keys badge shown at the right edge of a tab overlay-menu row. Pushed to the
 * right with `ml-auto`, so it only lays out correctly inside a flex row item.
 *
 * The single copy for every tab item's overlay menu (AI, file, terminal, browser,
 * group). It was previously re-declared inline, byte-identical, in four separate
 * components. Platform-correct key glyphs come from `formatShortcutKeys` - never
 * hard-code a Cmd/Ctrl symbol in menu copy.
 */
export const ShortcutHint = memo(function ShortcutHint({ keys, theme }: ShortcutHintProps) {
	return (
		<span
			className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded"
			style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}
		>
			{formatShortcutKeys(keys)}
		</span>
	);
});
