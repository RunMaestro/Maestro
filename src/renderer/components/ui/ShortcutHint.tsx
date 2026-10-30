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
 *
 * Both shapes draw the chord with `ShortcutKeys`, also exported here: one
 * accent-tinted cap per key, held on one line. It is the one look a chord has
 * anywhere it is drawn as UI (menu rows, tooltips, the command palette), so a
 * user learns to spot a shortcut by its color. Reach for it directly wherever
 * a chord is shown without a ShortcutHint around it, e.g. HoverTooltip.
 */

import { Fragment } from 'react';
import type { Theme } from '../../types';
import { formatShortcutKeys } from '../../utils/shortcutFormatter';

/**
 * One chord (`['Meta', 'k']`), or several chords that do the same thing
 * (`[['Escape'], ['Meta', 'w']]`), drawn "esc or ⌘ W".
 */
export type ShortcutChords = string[] | string[][];

/** The chords in `keys`, without empty ones. */
export function toShortcutChords(keys: ShortcutChords | undefined): string[][] {
	if (!keys || keys.length === 0) return [];
	const chords = Array.isArray(keys[0]) ? (keys as string[][]) : [keys as string[]];
	return chords.filter((chord) => chord.length > 0);
}

/**
 * macOS cap faces that read better as a word than as the formatter's glyph.
 * The escape glyph (⎋) and the visible-space glyph (␣) are correct but few
 * people recognize them on a key. Other platforms already spell them out.
 */
const MAC_CAP_WORDS: Record<string, string> = { Escape: 'esc', Esc: 'esc', Space: 'space' };

function capFace(key: string, mac: boolean): string {
	// One key at a time through the chord formatter, so a cap reads exactly as
	// that key does in a formatted chord.
	return (mac && MAC_CAP_WORDS[key]) || formatShortcutKeys([key]);
}

export interface ShortcutKeysProps {
	theme: Theme;
	/** Raw key names, as in the shortcut maps. Empty renders nothing. */
	keys: ShortcutChords;
	/** `sm` for menu rows and tooltips, `md` for a reference list. */
	size?: 'sm' | 'md';
	/**
	 * The caps sit on an accent-filled surface (a selected palette row): draw
	 * them in the accent's foreground color, or accent caps vanish into it.
	 */
	onAccent?: boolean;
	className?: string;
}

/**
 * A chord as a cluster of small accent-tinted key caps that never wraps.
 *
 * The text content is still the formatted chord (`⌘ ⇧ K`, `Ctrl+Shift+K`):
 * macOS separates caps with an invisible no-break space, Windows and Linux
 * with a visible `+`. Copying or reading the text gives what a user would type.
 */
export function ShortcutKeys({
	theme,
	keys,
	size = 'sm',
	onAccent = false,
	className = '',
}: ShortcutKeysProps) {
	const chords = toShortcutChords(keys);
	if (chords.length === 0) return null;
	// Follow the formatter's convention rather than probing the platform a
	// second way: it is the one source of how a chord reads (`⌘` and spaces on
	// macOS, `Ctrl` and `+` elsewhere), so the caps always match it.
	const mac = formatShortcutKeys(['Meta']) === '⌘';
	const ink = onAccent ? theme.colors.accentForeground : theme.colors.accent;
	const dim = onAccent ? theme.colors.accentForeground : theme.colors.textDim;
	const capSize =
		size === 'md'
			? 'min-w-[22px] h-[22px] px-1.5 text-xs rounded-[5px]'
			: 'min-w-[18px] h-[18px] px-1 text-[11px] rounded-[4px]';
	return (
		<span
			className={`inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 select-none ${className}`.trim()}
			data-shortcut-hint=""
			// The raw chord(s), platform-independent: what tests and tooling key on.
			data-shortcut-keys={chords.map((chord) => chord.join('+')).join(' | ')}
		>
			{chords.map((chord, chordIndex) => (
				// Chords and keys are fixed, caller-authored lists: index is stable.
				<Fragment key={chordIndex}>
					{chordIndex > 0 && (
						<span className="text-2xs" style={{ color: dim }}>
							{' or '}
						</span>
					)}
					<span className="inline-flex items-center gap-[3px]">
						{chord.map((key, keyIndex) => (
							<Fragment key={keyIndex}>
								{keyIndex > 0 &&
									(mac ? (
										<span className="sr-only">{'\u00A0'}</span>
									) : (
										<span className="text-2xs" style={{ color: dim }}>
											+
										</span>
									))}
								<kbd
									className={`inline-flex shrink-0 items-center justify-center font-sans font-semibold leading-none ${capSize}`}
									style={{
										color: ink,
										backgroundColor: `${ink}1a`,
										border: `1px solid ${ink}55`,
										// A lip along the bottom edge reads as a key, not a badge.
										boxShadow: `0 1px 0 ${ink}55`,
									}}
								>
									{capFace(key, mac)}
								</kbd>
							</Fragment>
						))}
					</span>
				</Fragment>
			))}
		</span>
	);
}

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

	const labelText = label ? (
		<span className="text-2xs" style={{ color: theme.colors.textDim }}>
			{label}{' '}
		</span>
	) : null;

	if (variant === 'row') {
		return (
			<div
				className={`flex items-center gap-1.5 px-3 py-1 whitespace-nowrap border-b select-none ${className}`}
				// Lets the phone action sheet (TabOverlayPortal) and the phone
				// stylesheet retire every chord badge at once: a phone has no
				// keyboard, so a badge there advertises a dead key.
				data-shortcut-hint=""
				style={{ backgroundColor: theme.colors.bgActivity, borderColor: theme.colors.border }}
			>
				{labelText}
				<ShortcutKeys theme={theme} keys={keys} />
			</div>
		);
	}

	return (
		<span
			className={`ml-auto inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 ${className}`}
			// See the note on the `row` variant above - the phone stylesheet
			// hides every element carrying this attribute.
			data-shortcut-hint=""
		>
			{labelText}
			<ShortcutKeys theme={theme} keys={keys} />
		</span>
	);
}

/**
 * A shortcut as plain text, for a native `title=` where caps cannot be drawn:
 * a string as given, chords formatted and joined with "or".
 */
export function shortcutText(shortcut: string | ShortcutChords | undefined): string {
	if (!shortcut) return '';
	if (typeof shortcut === 'string') return shortcut;
	return toShortcutChords(shortcut)
		.map((chord) => formatShortcutKeys(chord))
		.join(' or ');
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
