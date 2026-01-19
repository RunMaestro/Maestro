/**
 * Badge component for Maestro web interface
 *
 * A reusable badge/status indicator component that supports multiple variants
 * and sizes. Ideal for showing session states, labels, and status information.
 * Uses theme colors via CSS custom properties for consistent styling.
 */

import React, { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import { useTheme } from './ThemeProvider';

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
 * Size-based style configurations
 */
const sizeStyles: Record<BadgeSize, { className: string; borderRadius: string; dotSize: string }> =
	{
		sm: {
			className: 'px-1.5 py-0.5 text-xs gap-1',
			borderRadius: '4px',
			dotSize: '6px',
		},
		md: {
			className: 'px-2 py-0.5 text-sm gap-1.5',
			borderRadius: '6px',
			dotSize: '8px',
		},
		lg: {
			className: 'px-2.5 py-1 text-base gap-2',
			borderRadius: '8px',
			dotSize: '10px',
		},
	};

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
	const { theme } = useTheme();
	const colors = theme.colors;

	const sizeConfig = sizeStyles[size];
	const shouldPulse = pulse || variant === 'connecting';

	/**
	 * Get the primary color for the variant
	 */
	const getVariantColor = (): string => {
		switch (variant) {
			case 'success':
				return colors.success;
			case 'warning':
				return colors.warning;
			case 'error':
				return colors.error;
			case 'info':
				return colors.accent;
			case 'connecting':
				// Orange color for connecting state
				return '#f97316';
			case 'default':
			default:
				return colors.textDim;
		}
	};

	/**
	 * Get variant-specific styles based on badgeStyle
	 */
	const getStyles = (): React.CSSProperties => {
		const primaryColor = getVariantColor();

		switch (badgeStyle) {
			case 'solid':
				return {
					backgroundColor: primaryColor,
					color: '#ffffff',
					border: 'none',
				};
			case 'outline':
				return {
					backgroundColor: 'transparent',
					color: primaryColor,
					border: `1px solid ${primaryColor}`,
				};
			case 'subtle':
				return {
					backgroundColor: `${primaryColor}20`, // 20 = ~12% opacity in hex
					color: primaryColor,
					border: 'none',
				};
			case 'dot':
				return {
					backgroundColor: primaryColor,
					border: 'none',
				};
			default:
				return {};
		}
	};

	// Render dot-only badge
	if (badgeStyle === 'dot') {
		return (
			<span
				ref={ref}
				className={`inline-block rounded-full ${shouldPulse ? 'animate-pulse' : ''} ${className}`}
				style={{
					width: sizeConfig.dotSize,
					height: sizeConfig.dotSize,
					...getStyles(),
					...style,
				}}
				role="status"
				aria-label={variant !== 'default' ? variant : undefined}
				{...props}
			/>
		);
	}

	const combinedStyles: React.CSSProperties = {
		...getStyles(),
		borderRadius: sizeConfig.borderRadius,
		display: 'inline-flex',
		alignItems: 'center',
		fontWeight: 500,
		whiteSpace: 'nowrap',
		lineHeight: 1,
		...style,
	};

	return (
		<span
			ref={ref}
			className={`${sizeConfig.className} ${shouldPulse ? 'animate-pulse' : ''} ${className}`}
			style={combinedStyles}
			role="status"
			{...props}
		>
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
