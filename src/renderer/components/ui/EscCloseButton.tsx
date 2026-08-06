/**
 * EscCloseButton - the little "ESC" pill that closes a modal or a search bar.
 *
 * Every modal needs a graphical way out: keyboard shortcuts are unavailable
 * over remote desktop, on a tablet driving the web interface, or any time the
 * user is on a pointer-only surface. The ESC pill was previously copy-pasted as
 * an inert `<div>` in nine places, so it *looked* like the exit and did
 * nothing. This is the one implementation, and it is always a real button.
 *
 * Variants:
 *   - `inline` (default) sits in a flex row next to the search input.
 *   - `adornment` is absolutely positioned inside a `relative` input wrapper,
 *     matching the in-panel filter bars.
 *
 * Usage:
 * ```tsx
 * <EscCloseButton theme={theme} onClose={onClose} />
 * <EscCloseButton theme={theme} onClose={clearFilter} variant="adornment" label="Clear filter (Esc)" />
 * ```
 */

import { useState } from 'react';
import type { CSSProperties, MouseEvent } from 'react';
import type { Theme } from '../../types';

export interface EscCloseButtonProps {
	theme: Theme;
	/** Invoked on click. Should do exactly what pressing Escape does. */
	onClose: () => void;
	/** Layout variant. Defaults to 'inline'. */
	variant?: 'inline' | 'adornment';
	/** Tooltip and accessible label. Defaults to 'Close (Esc)'. */
	label?: string;
	/** Extra class names appended after the variant classes. */
	className?: string;
	/** Inline style overrides. */
	style?: CSSProperties;
	/** Test id for automated tests. */
	testId?: string;
}

const VARIANT_CLASSES: Record<NonNullable<EscCloseButtonProps['variant']>, string> = {
	inline: '',
	adornment: 'absolute right-2 top-1/2 -translate-y-1/2',
};

export function EscCloseButton({
	theme,
	onClose,
	variant = 'inline',
	label = 'Close (Esc)',
	className = '',
	style,
	testId,
}: EscCloseButtonProps) {
	const [hovered, setHovered] = useState(false);

	const handleClick = (e: MouseEvent<HTMLButtonElement>) => {
		// Search bars live inside clickable rows and draggable headers; the pill
		// must not double as a click on whatever is underneath it.
		e.stopPropagation();
		onClose();
	};

	return (
		<button
			type="button"
			onClick={handleClick}
			onMouseDown={(e) => e.stopPropagation()}
			onMouseEnter={() => setHovered(true)}
			onMouseLeave={() => setHovered(false)}
			title={label}
			aria-label={label}
			data-testid={testId}
			className={`${VARIANT_CLASSES[variant]} px-2 py-0.5 rounded text-xs font-bold shrink-0 transition-colors cursor-pointer ${className}`.trim()}
			style={{
				backgroundColor: hovered ? theme.colors.border : theme.colors.bgMain,
				color: hovered ? theme.colors.textMain : theme.colors.textDim,
				...style,
			}}
		>
			ESC
		</button>
	);
}

export default EscCloseButton;
