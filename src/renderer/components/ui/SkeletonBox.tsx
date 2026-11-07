/**
 * SkeletonBox - one pulsing placeholder bar, for a surface whose content is still loading.
 *
 * Shared by the Usage Dashboard chart skeletons and the Dataview loading state. The pulse is the
 * `skeleton-shimmer` keyframes in `index.css`, and the reduced-motion block there stops it by matching
 * `data-testid="skeleton-box"`, so keep that attribute.
 */

import React from 'react';
import type { Theme } from '../../types';

export interface SkeletonBoxProps {
	theme: Theme;
	className?: string;
	style?: React.CSSProperties;
}

export function SkeletonBox({ theme, className = '', style = {} }: SkeletonBoxProps) {
	return (
		<div
			className={`rounded ${className}`}
			style={{
				backgroundColor: theme.colors.border,
				opacity: 0.3,
				animation: 'skeleton-shimmer 1.5s ease-in-out infinite',
				...style,
			}}
			data-testid="skeleton-box"
		/>
	);
}
