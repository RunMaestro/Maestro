/**
 * Badge component for Maestro web interface
 *
 * A reusable badge/status indicator with multiple variants, sizes, and styles.
 * Color, border, and radius tokens come from Tailwind utilities backed by the
 * `--maestro-*` CSS custom properties (see `tailwind.config.mjs` and
 * `src/web/utils/cssCustomProperties.ts`), so live theme swaps update visuals
 * without re-rendering.
 */

import React, { forwardRef, type HTMLAttributes, type ReactNode } from 'react';

/**
 * Badge variant types
 * - default: Neutral badge using subtle colors
 * - success: Positive state (green) - Ready/idle sessions
 * - warning: Warning state (yellow) - Agent thinking/busy
 * - error: Error state (red) - No connection/error
 * - info: Informational (accent color)
 * - connecting: Orange pulsing state for connecting sessions
 */
export type BadgeVariant = 'default' | 'success' | 'warning' | 'error' | 'info' | 'connecting';

/**
 * Badge size options
 */
export type BadgeSize = 'sm' | 'md' | 'lg';

/**
 * Badge style options
 * - solid: Filled background with contrasting text
 * - outline: Transparent background with colored border
 * - subtle: Soft colored background with matching text
 * - dot: Minimal dot indicator (no text shown)
 */
export type BadgeStyle = 'solid' | 'outline' | 'subtle' | 'dot';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
	/** Visual variant of the badge */
	variant?: BadgeVariant;
	/** Size of the badge */
	size?: BadgeSize;
	/** Visual style of the badge */
	badgeStyle?: BadgeStyle;
	/** Optional icon to display before the text */
	icon?: ReactNode;
	/** Whether to show a pulsing animation (useful for "connecting" states) */
	pulse?: boolean;
	/** Children content (text or elements) */
	children?: ReactNode;
}

/**
 * Variant → Tailwind class fragments for each surface. Color tokens resolve
 * via `--maestro-*` CSS custom properties (see `tailwind.config.mjs`);
 * `connecting` is a non-theme literal hex.
 *
 * `subtleBg` uses `color-mix()` to fake 12% opacity because Tailwind's
 * opacity modifiers (`bg-success/10`) don't work on `var()` tokens — they
 * require rgb-channel colors. `color-mix(in srgb, <color> 12%, transparent)`
 * preserves the exact legacy opacity of the old `${hex}20` trick. For
 * `connecting` the color is a literal hex so Tailwind's `/[0.125]` modifier
 * does work, but we use `color-mix` uniformly for consistency.
 */
const variantColorClasses: Record<
	BadgeVariant,
	{ bg: string; text: string; border: string; subtleBg: string }
> = {
	default: {
		bg: 'bg-text-dim',
		text: 'text-text-dim',
		border: 'border-text-dim',
		subtleBg: 'bg-[color-mix(in_srgb,var(--maestro-text-dim)_12%,transparent)]',
	},
	success: {
		bg: 'bg-success',
		text: 'text-success',
		border: 'border-success',
		subtleBg: 'bg-[color-mix(in_srgb,var(--maestro-success)_12%,transparent)]',
	},
	warning: {
		bg: 'bg-warning',
		text: 'text-warning',
		border: 'border-warning',
		subtleBg: 'bg-[color-mix(in_srgb,var(--maestro-warning)_12%,transparent)]',
	},
	error: {
		bg: 'bg-error',
		text: 'text-error',
		border: 'border-error',
		subtleBg: 'bg-[color-mix(in_srgb,var(--maestro-error)_12%,transparent)]',
	},
	info: {
		bg: 'bg-accent',
		text: 'text-accent',
		border: 'border-accent',
		subtleBg: 'bg-[color-mix(in_srgb,var(--maestro-accent)_12%,transparent)]',
	},
	connecting: {
		bg: 'bg-connecting',
		text: 'text-connecting',
		border: 'border-connecting',
		subtleBg: 'bg-[color-mix(in_srgb,#f97316_12%,transparent)]',
	},
};

/**
 * Size → padding / type-scale / gap / border-radius for non-dot badges.
 * Tailwind's default `rounded`/`rounded-md`/`rounded-lg` are 4/6/8px and
 * match the legacy `borderRadius` values 1:1.
 */
const sizeClasses: Record<BadgeSize, string> = {
	sm: 'px-1.5 py-0.5 text-xs gap-1 rounded',
	md: 'px-2 py-0.5 text-sm gap-1.5 rounded-md',
	lg: 'px-2.5 py-1 text-base gap-2 rounded-lg',
};

/**
 * Size → dot diameter. Tailwind spacing: 1.5 = 6px, 2 = 8px, 2.5 = 10px,
 * matching the legacy `dotSize` values 1:1.
 */
const dotSizeClasses: Record<BadgeSize, string> = {
	sm: 'w-1.5 h-1.5',
	md: 'w-2 h-2',
	lg: 'w-2.5 h-2.5',
};

/**
 * Resolve the badgeStyle → color-class string for a given variant. Returns
 * an empty string for unknown badgeStyles so the component still renders.
 */
function getStyleClasses(variant: BadgeVariant, badgeStyle: BadgeStyle): string {
	const colors = variantColorClasses[variant] ?? variantColorClasses.default;
	switch (badgeStyle) {
		case 'solid':
			return `${colors.bg} text-white`;
		case 'outline':
			return `bg-transparent ${colors.text} border ${colors.border}`;
		case 'subtle':
			return `${colors.subtleBg} ${colors.text}`;
		case 'dot':
			return colors.bg;
		default:
			return '';
	}
}

const baseNonDotClasses = 'inline-flex items-center font-medium whitespace-nowrap leading-none';

const baseDotClasses = 'inline-block rounded-full';

/**
 * Badge component for the Maestro web interface
 *
 * @example
 * ```tsx
 * // Status badges
 * <Badge variant="success">Ready</Badge>
 * <Badge variant="warning">Processing</Badge>
 * <Badge variant="error">Disconnected</Badge>
 *
 * // Connecting state with pulse
 * <Badge variant="connecting" pulse>Connecting</Badge>
 *
 * // Dot-only indicator
 * <Badge variant="success" badgeStyle="dot" />
 *
 * // Outline style
 * <Badge variant="info" badgeStyle="outline">AI Mode</Badge>
 *
 * // With icon
 * <Badge variant="success" icon={<CheckIcon />}>
 *   Complete
 * </Badge>
 * ```
 */
export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
	{
		variant = 'default',
		size = 'md',
		badgeStyle = 'subtle',
		icon,
		pulse = false,
		children,
		className = '',
		style,
		...props
	},
	ref
) {
	const shouldPulse = pulse || variant === 'connecting';
	const styleClasses = getStyleClasses(variant, badgeStyle);

	// Render dot-only badge
	if (badgeStyle === 'dot') {
		const dotClassName = [
			baseDotClasses,
			dotSizeClasses[size],
			styleClasses,
			shouldPulse ? 'animate-pulse' : '',
			className,
		]
			.filter(Boolean)
			.join(' ');

		return (
			<span
				ref={ref}
				className={dotClassName}
				style={style}
				role="status"
				aria-label={variant !== 'default' ? variant : undefined}
				{...props}
			/>
		);
	}

	const badgeClassName = [
		baseNonDotClasses,
		sizeClasses[size],
		styleClasses,
		shouldPulse ? 'animate-pulse' : '',
		className,
	]
		.filter(Boolean)
		.join(' ');

	return (
		<span ref={ref} className={badgeClassName} style={style} role="status" {...props}>
			{icon && <span className="flex-shrink-0">{icon}</span>}
			{children && <span>{children}</span>}
		</span>
	);
});

/**
 * StatusDot component - A simple circular status indicator
 *
 * Convenience component for dot-only badges commonly used in session lists.
 *
 * @example
 * ```tsx
 * // In a session list item
 * <StatusDot status="idle" />
 * <StatusDot status="busy" />
 * <StatusDot status="error" />
 * <StatusDot status="connecting" />
 * ```
 */
export type SessionStatus = 'idle' | 'busy' | 'error' | 'connecting';

export interface StatusDotProps extends Omit<
	BadgeProps,
	'variant' | 'badgeStyle' | 'children' | 'icon'
> {
	/** Session status to display */
	status: SessionStatus;
}

/**
 * Map session status to badge variant
 */
const statusToVariant: Record<SessionStatus, BadgeVariant> = {
	idle: 'success',
	busy: 'warning',
	error: 'error',
	connecting: 'connecting',
};

export const StatusDot = forwardRef<HTMLSpanElement, StatusDotProps>(function StatusDot(
	{ status, size = 'sm', ...props },
	ref
) {
	return (
		<Badge
			ref={ref}
			variant={statusToVariant[status]}
			badgeStyle="dot"
			size={size}
			pulse={status === 'connecting'}
			{...props}
		/>
	);
});

/**
 * ModeBadge component - Shows AI or Terminal mode indicator
 *
 * @example
 * ```tsx
 * <ModeBadge mode="ai" />
 * <ModeBadge mode="terminal" />
 * ```
 */
export type InputMode = 'ai' | 'terminal';

export interface ModeBadgeProps extends Omit<BadgeProps, 'variant' | 'children'> {
	/** Current input mode */
	mode: InputMode;
}

export const ModeBadge = forwardRef<HTMLSpanElement, ModeBadgeProps>(function ModeBadge(
	{ mode, size = 'sm', badgeStyle = 'outline', ...props },
	ref
) {
	return (
		<Badge
			ref={ref}
			variant={mode === 'ai' ? 'info' : 'default'}
			badgeStyle={badgeStyle}
			size={size}
			{...props}
		>
			{mode === 'ai' ? 'AI' : 'Terminal'}
		</Badge>
	);
});

export default Badge;
