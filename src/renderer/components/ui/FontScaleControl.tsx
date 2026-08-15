/**
 * FontScaleControl - decrease / reset / increase font zoom for a reading pane.
 *
 * Pair it with `useFontScale(storageKey)`; the hook owns the value and the
 * persistence, this component only draws it. Two looks:
 *
 *   - `inline`   bordered square buttons for a toolbar or stats bar
 *   - `floating` frosted pill for overlaying a scrolling pane, matching the
 *                floating Table of Contents button in the file preview
 *
 * The percentage in the middle only appears once the user has zoomed, and
 * clicking it snaps back to 100%.
 *
 * Usage:
 * ```tsx
 * const fontScale = useFontScale('filePreview.fontScale');
 * <FontScaleControl theme={theme} control={fontScale} variant="floating" target="preview" />
 * ```
 */

import React from 'react';
import { AArrowDown, AArrowUp } from 'lucide-react';
import type { Theme } from '../../constants/themes';
import type { UseFontScaleReturn } from '../../hooks/ui/useFontScale';

export interface FontScaleControlProps {
	theme: Theme;
	/** State from `useFontScale`. */
	control: UseFontScaleReturn;
	/** Visual treatment. Defaults to `inline`. */
	variant?: 'inline' | 'floating';
	/**
	 * What the zoom applies to, appended to each tooltip
	 * (e.g. `preview` -> "Increase preview font size").
	 */
	target?: string;
	/** Extra classes on the wrapper (positioning is the caller's business). */
	className?: string;
	testId?: string;
}

export const FontScaleControl = React.memo(function FontScaleControl({
	theme,
	control,
	variant = 'inline',
	target,
	className = '',
	testId,
}: FontScaleControlProps) {
	const { fontScale, adjustFontScale, resetFontScale, canDecrease, canIncrease } = control;
	const floating = variant === 'floating';
	const suffix = target ? ` ${target} font size` : ' font size';
	const percent = Math.round(fontScale * 100);

	const buttonClass = floating
		? 'focus-ring flex items-center justify-center w-7 h-7 rounded-full transition-colors'
		: 'focus-ring flex items-center justify-center w-7 h-7 rounded transition-colors';

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
					? 'px-1 py-1 rounded-full shadow-lg opacity-70 hover:opacity-100 transition-opacity'
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
				onClick={() => adjustFontScale(-1)}
				disabled={!canDecrease}
				aria-label={`Decrease${suffix}`}
				title={`Decrease${suffix}`}
				className={`${buttonClass} hover:opacity-100`}
				style={buttonStyle(canDecrease)}
			>
				<AArrowDown className="w-4 h-4" />
			</button>
			{fontScale !== 1 && (
				<button
					type="button"
					onClick={resetFontScale}
					aria-label={`Reset${suffix}`}
					title={`Reset${suffix} to 100%`}
					className="focus-ring px-1 text-[10px] font-medium tabular-nums rounded transition-colors hover:opacity-100"
					style={{ color: theme.colors.textDim, opacity: 0.8 }}
				>
					{percent}%
				</button>
			)}
			<button
				type="button"
				onClick={() => adjustFontScale(1)}
				disabled={!canIncrease}
				aria-label={`Increase${suffix}`}
				title={`Increase${suffix}`}
				className={`${buttonClass} hover:opacity-100`}
				style={buttonStyle(canIncrease)}
			>
				<AArrowUp className="w-4 h-4" />
			</button>
		</div>
	);
});

export default FontScaleControl;
