/**
 * DeckModeKeyList - the Deck table as a wrapping row of key-cap chips.
 *
 * ONE renderer for the one table, shared by the two surfaces that show it: the
 * {@link DeckModeHintBar} that appears while the mode is armed, and the Deck
 * Mode section of the shortcuts help sheet. Both read `DECK_MODE_HINT_ROWS`
 * through this component rather than mapping it themselves, because the moment
 * there are two copies of the markup one of them drifts - and a surface showing
 * a key that no longer fires is worse than a surface showing nothing.
 *
 * Every row is READ from the array, label and cap alike: a row's label is the
 * canonical label of the action its `id` names, so this list, Settings >
 * Shortcuts and the hint bar cannot disagree about what `x` does. Add a key to
 * `DECK_MODE_KEYS` and it appears on both surfaces with no edit here.
 *
 * Chips rather than one row per key, deliberately. The table is eighteen rows;
 * as full-width rows it is eighteen lines tall, which runs past the fold in the
 * hint bar on a short window and buries the prose around it in the help sheet.
 * Wrapped chips keep the whole table inside three lines.
 */

import { ShortcutKeys } from './ui/ShortcutHint';
import { DECK_MODE_HINT_ROWS } from '../constants/deckMode';
import type { Theme } from '../types';

interface DeckModeKeyListProps {
	theme: Theme;
	/**
	 * Cap size, which also sets the label size: `sm` for the hint bar, which is
	 * an overlay that has to stay small, `md` for the help sheet, where the caps
	 * sit beside the `md` caps of the shortcut list above them.
	 */
	size?: 'sm' | 'md';
	/**
	 * Hide the whole table from the accessibility tree. The hint bar passes this:
	 * it is a `role=status` live region, and eighteen rows read aloud would still
	 * be playing long after a mode that lives for a second has ended. The help
	 * sheet does NOT pass it - that is the surface a screen reader user can take
	 * their time with, and it is where the announcement sends them.
	 */
	ariaHidden?: boolean;
	className?: string;
}

export function DeckModeKeyList({
	theme,
	size = 'sm',
	ariaHidden = false,
	className = '',
}: DeckModeKeyListProps): JSX.Element {
	const labelClass = size === 'md' ? 'text-xs leading-none' : 'text-2xs leading-none';
	return (
		<div
			className={`flex flex-wrap gap-x-3 gap-y-1.5 ${className}`.trim()}
			aria-hidden={ariaHidden ? 'true' : undefined}
		>
			{DECK_MODE_HINT_ROWS.map((row) => (
				<span
					key={row.id}
					data-deck-row={row.id}
					className="inline-flex items-center gap-1.5 whitespace-nowrap"
				>
					<ShortcutKeys theme={theme} keys={row.keys} size={size} />
					<span className={labelClass} style={{ color: theme.colors.textDim }}>
						{row.label}
					</span>
				</span>
			))}
		</div>
	);
}

export default DeckModeKeyList;
