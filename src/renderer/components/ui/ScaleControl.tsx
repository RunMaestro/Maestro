/**
 * ScaleControl - decrease / reset / increase for any zoomable surface.
 *
 * Pair it with `useScalePreference`; the hook owns the value and the
 * persistence, this component only draws it. The icons and the noun in the
 * tooltips are the caller's, so a font zoom reads "Decrease preview font size"
 * with A-arrows while a thumbnail zoom reads "Decrease thumbnail size" with
 * magnifiers. `FontScaleControl` is the font preset over it.
 *
 * Three looks:
 *   - `inline`   bordered square buttons for a toolbar or stats bar
 *   - `floating` opaque pill for overlaying a scrolling pane, matching the
 *                floating Table of Contents button in the file preview
 *   - `ghost`    borderless icons for a row of other borderless icon buttons
 *                (the Quick Chat composer), so the zoom reads as one of them
 *
 * The floating pill is fully opaque on purpose: it sits directly over running
 * text, and any transparency lets the words underneath read straight through
 * the icons. The Table of Contents button it sits beside is opaque too.
 *
 * A floating control can also be `collapsible`: it rests as a circle the size
 * of that Table of Contents button and expands to the full pill on hover or
 * keyboard focus. The buttons stay mounted while collapsed (they are only
 * clipped), so tabbing into them opens the pill rather than skipping it.
 *
 * The percentage in the middle only appears once the user has zoomed, and
 * clicking it snaps back to 100%. A surface whose zoom is a size rather than a
 * magnification (the dashboard's tile grids) passes `showReset={false}`: "130%"
 * of a tile width means nothing to the reader, and the buttons should not shift
 * sideways the moment they are first pressed.
 */

import React from 'react';
import type { LucideIcon } from 'lucide-react';
import type { Theme } from '../../constants/themes';
import type { UseScalePreferenceReturn } from '../../hooks/ui/useScalePreference';
import { HoverTooltip } from './HoverTooltip';
import { shortcutText, type ShortcutChords } from './ShortcutHint';

export interface ScaleControlProps {
	theme: Theme;
	/** State from `useScalePreference`. */
	control: UseScalePreferenceReturn;
	/** Icon for the decrease button. */
	decreaseIcon: LucideIcon;
	/** Icon for the increase button. */
	increaseIcon: LucideIcon;
	/**
	 * What the zoom applies to, completing each tooltip
	 * (e.g. `preview font size` -> "Increase preview font size").
	 */
	subject: string;
	/**
	 * Keys the surface has bound to this control (see `useScaleShortcuts`),
	 * appended to the tooltips: "Increase thumbnail size (+)". A shortcut the
	 * button never names is one nobody finds.
	 */
	shortcutHint?: {
		decrease?: string | ShortcutChords;
		increase?: string | ShortcutChords;
		reset?: string | ShortcutChords;
	};
	/** Visual treatment. Defaults to `inline`. */
	variant?: 'inline' | 'floating' | 'ghost';
	/**
	 * How the buttons explain themselves. `native` (the default) is the
	 * browser's `title`. `overlay` is a `HoverTooltip` with the shortcut drawn
	 * as a key hint, for a surface where a native title does not show (a
	 * non-activating panel such as Quick Chat) or that styles its own.
	 */
	tooltips?: 'native' | 'overlay';
	/**
	 * Button size. `sm` is for a dense button row whose own controls are
	 * `text-xs` - the default squares stand a couple of pixels taller than such
	 * a row and read heavier than the buttons beside them. Defaults to `md`.
	 */
	size?: 'sm' | 'md';
	/**
	 * Rest as a circle and expand on hover/focus. `floating` only - the inline
	 * variant sits in a toolbar where there is nothing to stay out of the way of.
	 */
	collapsible?: boolean;
	/** Icon shown in the collapsed circle. Required when `collapsible`. */
	collapsedIcon?: LucideIcon;
	/**
	 * Show the clickable percentage between the buttons once zoomed. Defaults to
	 * true. The reset key still works when this is off; only the readout goes.
	 */
	showReset?: boolean;
	/** Extra classes on the wrapper (positioning is the caller's business). */
	className?: string;
	testId?: string;
}

export const ScaleControl = React.memo(function ScaleControl({
	theme,
	control,
	decreaseIcon: DecreaseIcon,
	increaseIcon: IncreaseIcon,
	subject,
	shortcutHint,
	variant = 'inline',
	tooltips = 'native',
	size = 'md',
	collapsible = false,
	collapsedIcon: CollapsedIcon,
	showReset = true,
	className = '',
	testId,
}: ScaleControlProps) {
	const { scale, adjustScale, resetScale, canDecrease, canIncrease } = control;
	const floating = variant === 'floating';
	const ghost = variant === 'ghost';
	const collapsed = floating && collapsible && !!CollapsedIcon;
	const percent = Math.round(scale * 100);
	const withKey = (label: string, key?: string | ShortcutChords) =>
		key ? `${label} (${shortcutText(key)})` : label;

	const small = size === 'sm';
	const boxClass = small ? 'w-6 h-6' : 'w-7 h-7';
	const iconClass = small ? 'w-3.5 h-3.5' : 'w-4 h-4';
	const buttonClass = `focus-ring flex items-center justify-center ${boxClass} shrink-0 ${
		floating ? 'rounded-full' : ghost ? 'rounded-md' : 'rounded'
	} transition-colors`;

	const buttonStyle = (enabled: boolean): React.CSSProperties => ({
		// A ghost button matches the icon buttons beside it: the main text color,
		// dimmed at rest, full on hover (the hover class).
		color: ghost ? theme.colors.textMain : theme.colors.textDim,
		border: floating || ghost ? 'none' : `1px solid ${theme.colors.border}`,
		opacity: enabled ? (ghost ? 0.7 : 0.8) : ghost ? 0.3 : 0.4,
		cursor: enabled ? 'pointer' : 'default',
	});

	// One label per button, drawn either as a native title or as an overlay with
	// the key as a hint. `aria-label` stays the plain action in both.
	const overlay = tooltips === 'overlay';
	const tip = (
		label: string,
		key: string | ShortcutChords | undefined,
		button: React.ReactElement
	) =>
		overlay ? (
			<HoverTooltip theme={theme} label={label} shortcut={key}>
				{button}
			</HoverTooltip>
		) : (
			button
		);
	const titleFor = (label: string, key?: string | ShortcutChords) =>
		overlay ? undefined : withKey(label, key);

	// Collapsed rests as a circle and opens on hover or keyboard focus. The
	// buttons are clipped rather than unmounted so a Tab into them expands the
	// pill, and the whole thing is anchored right by its caller so it grows
	// leftward - the cursor never falls outside the element it just opened.
	const groupClass = collapsed ? 'group gap-0' : `${floating ? 'group' : ''} gap-1`;
	const revealClass =
		'flex items-center gap-1 pl-1 overflow-hidden max-w-0 opacity-0 transition-all duration-200 ' +
		'group-hover:max-w-[10rem] group-hover:opacity-100 ' +
		'group-focus-within:max-w-[10rem] group-focus-within:opacity-100';

	return (
		<div
			data-testid={testId}
			className={`flex items-center ${groupClass} ${
				floating ? 'self-start shrink-0 px-1 py-1 rounded-full shadow-lg' : ''
			} ${className}`.trim()}
			style={
				floating
					? {
							backgroundColor: theme.colors.bgSidebar,
							border: `1px solid ${theme.colors.border}`,
						}
					: undefined
			}
		>
			{collapsed && CollapsedIcon && (
				<span
					aria-hidden="true"
					data-testid={testId ? `${testId}-handle` : undefined}
					title={`Adjust ${subject}`}
					className={`flex items-center justify-center ${boxClass} shrink-0 overflow-hidden transition-all duration-200 group-hover:w-0 group-hover:opacity-0 group-focus-within:w-0 group-focus-within:opacity-0`}
					style={{
						// A zoom that is no longer 100% tints the resting circle, so the
						// collapsed state still says the pane is scaled.
						color: scale === 1 ? theme.colors.textDim : theme.colors.accent,
					}}
				>
					<CollapsedIcon className={`${iconClass} shrink-0`} />
				</span>
			)}
			<div className={collapsed ? revealClass : 'contents'}>
				{tip(
					`Decrease ${subject}`,
					shortcutHint?.decrease,
					<button
						type="button"
						onClick={() => adjustScale(-1)}
						disabled={!canDecrease}
						aria-label={`Decrease ${subject}`}
						title={titleFor(`Decrease ${subject}`, shortcutHint?.decrease)}
						className={`${buttonClass} hover:opacity-100`}
						style={buttonStyle(canDecrease)}
					>
						<DecreaseIcon className={iconClass} />
					</button>
				)}
				{showReset &&
					scale !== 1 &&
					tip(
						`Reset ${subject} to 100%`,
						shortcutHint?.reset,
						<button
							type="button"
							onClick={resetScale}
							aria-label={`Reset ${subject}`}
							title={titleFor(`Reset ${subject} to 100%`, shortcutHint?.reset)}
							className="focus-ring px-1 text-2xs font-medium tabular-nums rounded transition-colors hover:opacity-100"
							style={{ color: theme.colors.textDim, opacity: 0.8 }}
						>
							{percent}%
						</button>
					)}
				{tip(
					`Increase ${subject}`,
					shortcutHint?.increase,
					<button
						type="button"
						onClick={() => adjustScale(1)}
						disabled={!canIncrease}
						aria-label={`Increase ${subject}`}
						title={titleFor(`Increase ${subject}`, shortcutHint?.increase)}
						className={`${buttonClass} hover:opacity-100`}
						style={buttonStyle(canIncrease)}
					>
						<IncreaseIcon className={iconClass} />
					</button>
				)}
			</div>
		</div>
	);
});

export default ScaleControl;
