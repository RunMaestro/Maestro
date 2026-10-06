/**
 * BlockView design tokens - the fixed, mandated styling vocabulary. Agents pick
 * from these semantic names; the app resolves them to concrete theme values so
 * agent-authored views always match the active Maestro theme and never carry raw
 * CSS.
 */

import type { Theme } from '../../types';
import type { BlockAlign, BlockColor, BlockGap } from './types';

/** Fallback orange - no theme slot defines it (matches Center Flash / cadenzas). */
export const ORANGE_HEX = '#f97316';

/** Resolve a semantic block color to a concrete theme color. */
export function resolveBlockColor(
	color: BlockColor | undefined,
	theme: Theme,
	fallback?: string
): string {
	switch (color) {
		case 'success':
			return theme.colors.success;
		case 'warning':
			return theme.colors.warning;
		case 'error':
			return theme.colors.error;
		case 'orange':
			return ORANGE_HEX;
		case 'neutral':
			return theme.colors.textDim;
		case 'accent':
			return theme.colors.accent;
		default:
			return fallback ?? theme.colors.accent;
	}
}

/** One type role: size + weight + line-height, spread onto a block's style. */
export interface TypeRole {
	fontSize: number;
	fontWeight: number;
	lineHeight: number | string;
	letterSpacing?: string;
}

/**
 * The BlockView type scale - "presentation" readability. Every block reads its
 * size from one of these roles instead of a hardcoded literal, so readability is
 * a single lever and the hierarchy stays consistent across all block kinds.
 */
export const TYPE = {
	/** Hero numbers / big stat values. */
	display: { fontSize: 28, fontWeight: 700, lineHeight: 1.1 } as TypeRole,
	/** Top-level heading (level 1) and group titles. */
	title: { fontSize: 22, fontWeight: 700, lineHeight: 1.2, letterSpacing: '0.01em' } as TypeRole,
	/** Section heading (level 2). */
	heading: { fontSize: 18, fontWeight: 700, lineHeight: 1.25 } as TypeRole,
	/** Sub-heading (level 3) / emphasized row header. */
	subheading: { fontSize: 16, fontWeight: 700, lineHeight: 1.3 } as TypeRole,
	/** Keys, table headers, muted labels. */
	label: { fontSize: 14, fontWeight: 500, lineHeight: 1.4 } as TypeRole,
	/** Default reading text - callout/table/paragraph body. */
	body: { fontSize: 15, fontWeight: 400, lineHeight: 1.5 } as TypeRole,
	/** Emphasized value paired with a label. */
	value: { fontSize: 15, fontWeight: 600, lineHeight: 1.4 } as TypeRole,
	/** Small meta - badges, progress %, filenames. */
	caption: { fontSize: 13, fontWeight: 500, lineHeight: 1.4 } as TypeRole,
} as const;

/** Mandated spacing scale (px) - roomy by default for legibility. */
export const GAP_PX: Record<BlockGap, number> = {
	none: 0,
	sm: 10,
	md: 18,
	lg: 28,
};

/** Resolve a gap name to px, defaulting to `md`. */
export function resolveGap(gap: BlockGap | undefined): number {
	return GAP_PX[gap ?? 'md'] ?? GAP_PX.md;
}

/** Map a cross-axis alignment name to a CSS `align-items` value. */
export function resolveAlign(align: BlockAlign | undefined): string {
	switch (align) {
		case 'center':
			return 'center';
		case 'end':
			return 'flex-end';
		case 'start':
			return 'flex-start';
		case 'stretch':
		default:
			return 'stretch';
	}
}
