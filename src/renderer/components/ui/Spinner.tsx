/**
 * Spinner - Animated loading indicator
 *
 * A standard animated loading indicator built on Lucide's Loader2 icon.
 * Encapsulates the common "animate-spin" pattern used across the app.
 *
 * Usage:
 * ```tsx
 * <Spinner size={16} />
 * <Spinner size={24} color={theme.colors.accent} />
 * <Spinner className="text-blue-500" size={12} />
 * ```
 */

import { Loader2 } from 'lucide-react';
import type { CSSProperties } from 'react';

export interface SpinnerProps {
	/** Icon size in pixels. Defaults to 16 */
	size?: number;
	/** Optional color (applied via inline style). */
	color?: string;
	/** Additional class names */
	className?: string;
	/** Inline style overrides */
	style?: CSSProperties;
	/** Accessible label. Defaults to 'Loading' */
	ariaLabel?: string;
	/** Test id for automated tests */
	testId?: string;
}

export function Spinner({
	size = 16,
	color,
	className = '',
	style,
	ariaLabel = 'Loading',
	testId,
}: SpinnerProps) {
	return (
		<Loader2
			className={`animate-spin ${className}`.trim()}
			style={{ width: size, height: size, color, ...style }}
			aria-label={ariaLabel}
			role="status"
			data-testid={testId}
		/>
	);
}

export default Spinner;
