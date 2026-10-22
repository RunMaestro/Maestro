/**
 * Spinner - Animated loading indicator
 *
 * A standard animated loading indicator built on Lucide's Loader2 icon.
 * Encapsulates the common "animate-spin" pattern used across the app.
 *
 * The rotation is on a wrapping <span>, never on the <svg>. Chromium cannot run
 * a transform animation on an <svg> element on the compositor, so a spinning
 * svg forces a main-thread style + paint pass on EVERY frame for as long as it
 * is on screen (measured: ~120 main frames/s from one spinner, vs zero for the
 * same spinner wrapped). A field trace showed one such spinner keeping the
 * renderer awake for the whole capture. Use this component (with `icon` for a
 * different glyph) rather than putting `animate-spin` on an icon directly.
 *
 * Usage:
 * ```tsx
 * <Spinner size={16} />
 * <Spinner size={24} color={theme.colors.accent} />
 * <Spinner className="text-blue-500" size={12} />
 * ```
 */

import { Loader2, type LucideIcon } from 'lucide-react';
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
	/** Glyph to spin. Defaults to Loader2 */
	icon?: LucideIcon;
	/** Hide from assistive tech (no status role) when nearby text already says it */
	decorative?: boolean;
}

export function Spinner({
	size = 16,
	color,
	className = '',
	style,
	ariaLabel = 'Loading',
	testId,
	icon: Icon = Loader2,
	decorative = false,
}: SpinnerProps) {
	return (
		<span
			className={`block shrink-0 animate-spin ${className}`.trim()}
			style={{ width: size, height: size, color, ...style }}
			aria-label={decorative ? undefined : ariaLabel}
			aria-hidden={decorative || undefined}
			role={decorative ? undefined : 'status'}
			data-testid={testId}
		>
			<Icon className="block w-full h-full" aria-hidden="true" />
		</span>
	);
}

export default Spinner;
