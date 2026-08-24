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
 *   - `floating` frosted pill for overlaying a scrolling pane, matching the
 *                floating Table of Contents button in the file preview
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
	/** Visual treatment. Defaults to `inline`. */
	variant?: 'inline' | 'floating';
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
	variant = 'inline',
	className = '',
	testId,
}: ScaleControlProps) {
	const { scale, adjustScale, resetScale, canDecrease, canIncrease } = control;
	const floating = variant === 'floating';
	const percent = Math.round(scale * 100);

	const buttonClass = floating
		? 'focus-ring flex items-center justify-center w-7 h-7 shrink-0 rounded-full transition-colors'
		: 'focus-ring flex items-center justify-center w-7 h-7 shrink-0 rounded transition-colors';

	const buttonStyle = (enabled: boolean): React.CSSProperties => ({
		color: theme.colors.textDim,
		border: floating ? 'none' : `1px solid ${theme.colors.border}`,
		opacity: enabled ? 0.8 : 0.4,
		cursor: enabled ? 'pointer' : 'default',
	});

	return (
		<div
			data-testid={testId}
			className={`flex items-center gap-1 ${
				floating
					? 'self-start shrink-0 px-1 py-1 rounded-full shadow-lg opacity-70 hover:opacity-100 transition-opacity'
					: ''
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
			<button
				type="button"
				onClick={() => adjustScale(-1)}
				disabled={!canDecrease}
				aria-label={`Decrease ${subject}`}
				title={`Decrease ${subject}`}
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
					title={`Reset ${subject} to 100%`}
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
				title={`Increase ${subject}`}
				className={`${buttonClass} hover:opacity-100`}
				style={buttonStyle(canIncrease)}
			>
				<IncreaseIcon className="w-4 h-4" />
			</button>
		</div>
	);
});

export default ScaleControl;
