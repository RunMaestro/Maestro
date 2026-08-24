/**
 * FontScaleControl - decrease / reset / increase font zoom for a reading pane.
 *
 * Pair it with `useFontScale(storageKey)`; the hook owns the value and the
 * persistence, this component only draws it. It is the font preset over
 * `ScaleControl`, which owns the layout shared with the staged-image
 * thumbnail zoom.
 *
 * Usage:
 * ```tsx
 * const fontScale = useFontScale('filePreview.fontScale');
 * <FontScaleControl theme={theme} control={fontScale} variant="floating" target="preview" />
 * ```
 */

import React, { useMemo } from 'react';
import { AArrowDown, AArrowUp } from 'lucide-react';
import type { Theme } from '../../constants/themes';
import type { UseFontScaleReturn } from '../../hooks/ui/useFontScale';
import { ScaleControl } from './ScaleControl';

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
	// The font hook names its fields after fonts; ScaleControl speaks the
	// generic vocabulary. Adapt rather than making either side compromise.
	const scaleControl = useMemo(
		() => ({
			scale: control.fontScale,
			adjustScale: control.adjustFontScale,
			resetScale: control.resetFontScale,
			canDecrease: control.canDecrease,
			canIncrease: control.canIncrease,
		}),
		[control]
	);

	return (
		<ScaleControl
			theme={theme}
			control={scaleControl}
			decreaseIcon={AArrowDown}
			increaseIcon={AArrowUp}
			subject={target ? `${target} font size` : 'font size'}
			variant={variant}
			className={className}
			testId={testId}
		/>
	);
});

export default FontScaleControl;
