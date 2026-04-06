import React from 'react';
import { Loader2 } from 'lucide-react';

export type SpinnerSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

export interface SpinnerProps {
	/** Spinner size: xs=w-3 h-3, sm=w-4 h-4, md=w-5 h-5, lg=w-6 h-6, xl=w-8 h-8 */
	size?: SpinnerSize;
	/** Additional CSS classes (e.g., color, margin) */
	className?: string;
	/** Inline styles (e.g., theme-based color) */
	style?: React.CSSProperties;
}

const SIZE_CLASSES: Record<SpinnerSize, string> = {
	xs: 'w-3 h-3',
	sm: 'w-4 h-4',
	md: 'w-5 h-5',
	lg: 'w-6 h-6',
	xl: 'w-8 h-8',
};

/**
 * Spinning loader indicator. Wraps Lucide's Loader2 icon with
 * `animate-spin` and a predefined size class.
 *
 * Replaces the common pattern:
 *   `<Loader2 className="w-4 h-4 animate-spin" />`
 */
export function Spinner({ size = 'sm', className = '', style }: SpinnerProps) {
	const sizeClass = SIZE_CLASSES[size];
	return <Loader2 className={`${sizeClass} animate-spin ${className}`.trim()} style={style} />;
}
