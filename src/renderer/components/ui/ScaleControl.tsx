/**
 * ScaleControl - decrease / reset / increase for any zoomable surface.
 *
 * Pair it with `useScalePreference`; the hook owns the value and the
 * persistence, this component only draws it. The icons and the noun in the
 * tooltips are the caller's, so a font zoom reads "Decrease preview font size"
 * with A-arrows while a thumbnail zoom reads "Decrease thumbnail size" with
 * magnifiers. `FontScaleControl` is the font preset over it.
 *
 * Two looks:
 *   - `inline`   bordered square buttons for a toolbar or stats bar
 *   - `floating` opaque pill for overlaying a scrolling pane, matching the
 *                floating Table of Contents button in the file preview
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
 * clicking it snaps back to 100%.
 */

import React from 'react';
import type { LucideIcon } from 'lucide-react';
import type { Theme } from '../../constants/themes';
import type { UseScalePreferenceReturn } from '../../hooks/ui/useScalePreference';

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
	shortcutHint?: { decrease?: string; increase?: string; reset?: string };
	/** Visual treatment. Defaults to `inline`. */
	variant?: 'inline' | 'floating';
	/**
	 * Rest as a circle and expand on hover/focus. `floating` only - the inline
	 * variant sits in a toolbar where there is nothing to stay out of the way of.
	 */
	collapsible?: boolean;
	/** Icon shown in the collapsed circle. Required when `collapsible`. */
	collapsedIcon?: LucideIcon;
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
	collapsible = false,
	collapsedIcon: CollapsedIcon,
	className = '',
	testId,
}: ScaleControlProps) {
	const { scale, adjustScale, resetScale, canDecrease, canIncrease } = control;
	const floating = variant === 'floating';
	const collapsed = floating && collapsible && !!CollapsedIcon;
	const percent = Math.round(scale * 100);
	const withKey = (label: string, key?: string) => (key ? `${label} (${key})` : label);

	const buttonClass = floating
		? 'focus-ring flex items-center justify-center w-7 h-7 shrink-0 rounded-full transition-colors'
		: 'focus-ring flex items-center justify-center w-7 h-7 shrink-0 rounded transition-colors';

	const buttonStyle = (enabled: boolean): React.CSSProperties => ({
		color: theme.colors.textDim,
		border: floating ? 'none' : `1px solid ${theme.colors.border}`,
		opacity: enabled ? 0.8 : 0.4,
		cursor: enabled ? 'pointer' : 'default',
	});

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
					className="flex items-center justify-center w-7 h-7 shrink-0 overflow-hidden transition-all duration-200 group-hover:w-0 group-hover:opacity-0 group-focus-within:w-0 group-focus-within:opacity-0"
					style={{
						// A zoom that is no longer 100% tints the resting circle, so the
						// collapsed state still says the pane is scaled.
						color: scale === 1 ? theme.colors.textDim : theme.colors.accent,
					}}
				>
					<CollapsedIcon className="w-4 h-4 shrink-0" />
				</span>
			)}
			<div className={collapsed ? revealClass : 'contents'}>
				<button
					type="button"
					onClick={() => adjustScale(-1)}
					disabled={!canDecrease}
					aria-label={`Decrease ${subject}`}
					title={withKey(`Decrease ${subject}`, shortcutHint?.decrease)}
					className={`${buttonClass} hover:opacity-100`}
					style={buttonStyle(canDecrease)}
				>
					<DecreaseIcon className="w-4 h-4" />
				</button>
				{scale !== 1 && (
					<button
						type="button"
						onClick={resetScale}
						aria-label={`Reset ${subject}`}
						title={withKey(`Reset ${subject} to 100%`, shortcutHint?.reset)}
						className="focus-ring px-1 text-[10px] font-medium tabular-nums rounded transition-colors hover:opacity-100"
						style={{ color: theme.colors.textDim, opacity: 0.8 }}
					>
						{percent}%
					</button>
				)}
				<button
					type="button"
					onClick={() => adjustScale(1)}
					disabled={!canIncrease}
					aria-label={`Increase ${subject}`}
					title={withKey(`Increase ${subject}`, shortcutHint?.increase)}
					className={`${buttonClass} hover:opacity-100`}
					style={buttonStyle(canIncrease)}
				>
					<IncreaseIcon className="w-4 h-4" />
				</button>
			</div>
		</div>
	);
});

export default ScaleControl;
