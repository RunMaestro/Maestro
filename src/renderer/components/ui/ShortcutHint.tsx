/**
 * ShortcutHint - the small key-cap chip that advertises a keyboard shortcut
 * next to the control it fires.
 *
 * Maestro is keyboard-first, so every clickable route to an action that also
 * has a chord should show that chord where the user is already looking. This
 * is the one component that draws it, in two shapes:
 *
 * - `chip` (default): a rounded key-cap for a menu row or a dropdown option
 *   list. Pushes itself to the end of a flex row with `ml-auto`, which is what
 *   the tab overlay menus want.
 * - `row`: a full-width, non-interactive header pinned above a dropdown's
 *   option list. It is a plain div - no button, no tabIndex - so it can never
 *   be reached by keyboard or clicked into the selection, and it sits OUTSIDE
 *   the scroll container so it stays put while the list scrolls.
 *
 * Both shapes carry `data-shortcut-hint`, which is how the phone stylesheet
 * and the phone action sheet retire every chord badge at once - a phone has no
 * keyboard, so a badge there advertises a dead key.
 *
 * Pass `keys` and the chord is formatted for the current platform; pass
 * `label` to prefix it ("Try:"). Rendering nothing when `keys` is empty is
 * deliberate: an action can ship unbound, and a blank key-cap advertises a
 * combo that does nothing.
 */

import type { Theme } from '../../types';
import { formatShortcutKeys } from '../../utils/shortcutFormatter';

export interface ShortcutHintProps {
	theme: Theme;
	/** Chord to display, e.g. `['Meta', 'Shift', 'r']`. Empty renders nothing. */
	keys: string[];
	/** Optional text before the chord, e.g. `"Try:"`. */
	label?: string;
	/** `chip` for an inline key-cap, `row` for a pinned dropdown header. */
	variant?: 'chip' | 'row';
	/** Extra classes merged onto the root. */
	className?: string;
}

export function ShortcutHint({
	theme,
	keys,
	label,
	variant = 'chip',
	className = '',
}: ShortcutHintProps) {
	if (!keys || keys.length === 0) return null;

	const text = label ? `${label} ${formatShortcutKeys(keys)}` : formatShortcutKeys(keys);

	if (variant === 'row') {
		return (
			<div
				className={`px-3 py-1 text-2xs font-mono whitespace-nowrap border-b select-none ${className}`}
				// Lets the phone action sheet (TabOverlayPortal) and the phone
				// stylesheet retire every chord badge at once: a phone has no
				// keyboard, so a badge there advertises a dead key.
				data-shortcut-hint=""
				style={{
					backgroundColor: theme.colors.bgActivity,
					color: theme.colors.textDim,
					borderColor: theme.colors.border,
				}}
			>
				{text}
			</div>
		);
	}

	return (
		<span
			className={`ml-auto text-2xs font-mono px-1.5 py-0.5 rounded ${className}`}
			// See the note on the `row` variant above - the phone stylesheet
			// hides every element carrying this attribute.
			data-shortcut-hint=""
			style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}
		>
			{text}
		</span>
	);
}

/**
 * Tooltip-safe suffix for a `title=` attribute, e.g. `" (⇧⌘R)"`. Returns an
 * empty string when the action is unbound so callers can concatenate blindly:
 * `title={`Close tab${shortcutSuffix(keys)}`}`.
 */
export function shortcutSuffix(keys?: string[]): string {
	if (!keys || keys.length === 0) return '';
	return ` (${formatShortcutKeys(keys)})`;
}

export default ShortcutHint;
