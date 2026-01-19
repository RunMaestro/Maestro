/**
 * Card component for Maestro web interface
 *
 * A reusable card container component that supports multiple variants, padding options,
 * and interactive states. Ideal for session cards, information panels, and grouped content.
 * Uses theme colors via CSS custom properties for consistent styling.
 */

import React, { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import { useTheme } from './ThemeProvider';

/**
 * Card variant types
 * - default: Standard card with subtle background
 * - elevated: Card with shadow for emphasis
 * - outlined: Card with border, transparent background
 * - filled: Card with solid activity background
 * - ghost: Minimal card, only visible on hover
 */
export type CardVariant = 'default' | 'elevated' | 'outlined' | 'filled' | 'ghost';

/**
 * Card padding options
 */
export type CardPadding = 'none' | 'sm' | 'md' | 'lg';

/**
 * Card border radius options
 */
export type CardRadius = 'none' | 'sm' | 'md' | 'lg' | 'full';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
	/** Visual variant of the card */
	variant?: CardVariant;
	/** Padding inside the card */
	padding?: CardPadding;
	/** Border radius of the card */
	radius?: CardRadius;
	/** Whether the card is interactive (clickable) */
	interactive?: boolean;
	/** Whether the card is in a selected/active state */
	selected?: boolean;
	/** Whether the card is disabled */
	disabled?: boolean;
	/** Whether the card should take full width */
	fullWidth?: boolean;
	/** Children content */
	children?: ReactNode;
}

/**
 * Padding style configurations
 */
const paddingStyles: Record<CardPadding, string> = {
	none: '',
	sm: 'p-2',
	md: 'p-3',
	lg: 'p-4',
};

/**
 * Border radius style configurations
 */
const radiusStyles: Record<CardRadius, string> = {
	none: '0',
	sm: '4px',
	md: '8px',
	lg: '12px',
	full: '9999px',
};

/**
 * Card component for the Maestro web interface
 *
 * @example
 * ```tsx
 * // Basic card
 * <Card>
 *   <p>Card content here</p>
 * </Card>
 *
 * // Interactive session card
 * <Card variant="outlined" interactive selected={isSelected} onClick={handleSelect}>
 *   <SessionInfo />
 * </Card>
 *
 * // Elevated card for emphasis
 * <Card variant="elevated" padding="lg">
 *   <ImportantContent />
 * </Card>
 *
 * // Card with custom padding and radius
 * <Card padding="sm" radius="lg">
 *   <CompactContent />
 * </Card>
 * ```
 */
export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
	{
		variant = 'default',
		padding = 'md',
		radius = 'md',
		interactive = false,
		selected = false,
		disabled = false,
		fullWidth = false,
		children,
		className = '',
		style,
		onClick,
		...props
	},
	ref
) {
	const { theme } = useTheme();
	const colors = theme.colors;

	/**
	 * Get variant-specific styles
	 */
	const getVariantStyles = (): React.CSSProperties => {
		const baseTransition =
			'background-color 150ms ease, border-color 150ms ease, box-shadow 150ms ease, transform 150ms ease';

		switch (variant) {
			case 'default':
				return {
					backgroundColor: colors.bgActivity,
					color: colors.textMain,
					border: 'none',
					transition: baseTransition,
				};
			case 'elevated':
				return {
					backgroundColor: colors.bgActivity,
					color: colors.textMain,
					border: 'none',
					boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)',
					transition: baseTransition,
				};
			case 'outlined':
				return {
					backgroundColor: 'transparent',
					color: colors.textMain,
					border: `1px solid ${colors.border}`,
					transition: baseTransition,
				};
			case 'filled':
				return {
					backgroundColor: colors.bgSidebar,
					color: colors.textMain,
					border: 'none',
					transition: baseTransition,
				};
			case 'ghost':
				return {
					backgroundColor: 'transparent',
					color: colors.textMain,
					border: '1px solid transparent',
					transition: baseTransition,
				};
			default:
				return {};
		}
	};

	/**
	 * Get interactive/hover styles
	 */
	const getInteractiveStyles = (): React.CSSProperties => {
		if (!interactive || disabled) return {};
		return {
			cursor: 'pointer',
		};
	};

	/**
	 * Get selected state styles
	 */
	const getSelectedStyles = (): React.CSSProperties => {
		if (!selected) return {};
		return {
			borderColor: colors.accent,
			backgroundColor: variant === 'outlined' ? colors.accentDim : colors.bgActivity,
			boxShadow: `0 0 0 1px ${colors.accent}`,
		};
	};

	/**
	 * Get disabled styles
	 */
	const getDisabledStyles = (): React.CSSProperties => {
		if (!disabled) return {};
		return {
			opacity: 0.5,
			cursor: 'not-allowed',
			pointerEvents: 'none',
		};
	};

	const variantStyles = getVariantStyles();
	const interactiveStyles = getInteractiveStyles();
	const selectedStyles = getSelectedStyles();
	const disabledStyles = getDisabledStyles();

	const combinedStyles: React.CSSProperties = {
		...variantStyles,
		...interactiveStyles,
		...selectedStyles,
		...disabledStyles,
		borderRadius: radiusStyles[radius],
		width: fullWidth ? '100%' : undefined,
		...style,
	};

	// Construct class names
	const classNames = [
		paddingStyles[padding],
		interactive && !disabled ? 'hover:brightness-110 active:scale-[0.99]' : '',
		fullWidth ? 'w-full' : '',
		'focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1',
		className,
	]
		.filter(Boolean)
		.join(' ');

	// Handle keyboard interaction for interactive cards
	const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
		if (interactive && !disabled && (e.key === 'Enter' || e.key === ' ')) {
			e.preventDefault();
			onClick?.(e as unknown as React.MouseEvent<HTMLDivElement>);
		}
		props.onKeyDown?.(e);
	};

	return (
		<div
			ref={ref}
			className={classNames}
			style={combinedStyles}
			role={interactive ? 'button' : undefined}
			tabIndex={interactive && !disabled ? 0 : undefined}
			aria-selected={interactive ? selected : undefined}
			aria-disabled={disabled}
			onClick={disabled ? undefined : onClick}
			onKeyDown={handleKeyDown}
			{...props}
		>
			{children}
		</div>
	);
});

/**
 * CardHeader component for consistent card headers
 *
 * @example
 * ```tsx
 * <Card>
 *   <CardHeader title="Session Name" subtitle="Working directory" />
 *   <CardBody>Content</CardBody>
 * </Card>
 * ```
 */
export interface CardHeaderProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
	/** Main title text (overrides HTML title attribute to support ReactNode) */
	title?: ReactNode;
	/** Subtitle or secondary text */
	subtitle?: ReactNode;
	/** Action element (button, icon, etc.) on the right side */
	action?: ReactNode;
}

export const CardHeader = forwardRef<HTMLDivElement, CardHeaderProps>(function CardHeader(
	{ title, subtitle, action, className = '', style, children, ...props },
	ref
) {
	const { theme } = useTheme();
	const colors = theme.colors;

	// If children are provided, render them directly
	if (children) {
		return (
			<div
				ref={ref}
				className={`flex items-center justify-between ${className}`}
				style={style}
				{...props}
			>
				{children}
			</div>
		);
	}

	return (
		<div
			ref={ref}
			className={`flex items-center justify-between ${className}`}
			style={style}
			{...props}
		>
			<div className="flex flex-col gap-0.5 min-w-0 flex-1">
				{title && (
					<div className="font-medium text-sm truncate" style={{ color: colors.textMain }}>
						{title}
					</div>
				)}
				{subtitle && (
					<div className="text-xs truncate" style={{ color: colors.textDim }}>
						{subtitle}
					</div>
				)}
			</div>
			{action && <div className="flex-shrink-0 ml-2">{action}</div>}
		</div>
	);
});

/**
 * CardBody component for main card content
 *
 * @example
 * ```tsx
 * <Card padding="none">
 *   <CardHeader title="Title" />
 *   <CardBody padding="md">
 *     Main content goes here
 *   </CardBody>
 * </Card>
 * ```
 */
export interface CardBodyProps extends HTMLAttributes<HTMLDivElement> {
	/** Padding inside the body */
	padding?: CardPadding;
}

export const CardBody = forwardRef<HTMLDivElement, CardBodyProps>(function CardBody(
	{ padding = 'none', className = '', children, ...props },
	ref
) {
	return (
		<div ref={ref} className={`${paddingStyles[padding]} ${className}`} {...props}>
			{children}
		</div>
	);
});

/**
 * CardFooter component for card footer content
 *
 * @example
 * ```tsx
 * <Card>
 *   <CardBody>Content</CardBody>
 *   <CardFooter>
 *     <Button size="sm">Action</Button>
 *   </CardFooter>
 * </Card>
 * ```
 */
export interface CardFooterProps extends HTMLAttributes<HTMLDivElement> {
	/** Whether to add a border at the top */
	bordered?: boolean;
}

export const CardFooter = forwardRef<HTMLDivElement, CardFooterProps>(function CardFooter(
	{ bordered = false, className = '', style, children, ...props },
	ref
) {
	const { theme } = useTheme();
	const colors = theme.colors;

	return (
		<div
			ref={ref}
			className={`flex items-center gap-2 pt-2 mt-2 ${className}`}
			style={{
				borderTop: bordered ? `1px solid ${colors.border}` : undefined,
				...style,
			}}
			{...props}
		>
			{children}
		</div>
	);
});

/**
 * SessionCard component - A pre-composed card specifically for session items
 *
 * This is a convenience component that combines Card with common session display patterns.
 *
 * @example
 * ```tsx
 * <SessionCard
 *   name="my-project"
 *   status="idle"
 *   mode="ai"
 *   cwd="/path/to/project"
 *   selected={isSelected}
 *   onClick={() => selectSession(id)}
 * />
 * ```
 */
export type SessionStatus = 'idle' | 'busy' | 'error' | 'connecting';
export type InputMode = 'ai' | 'terminal';

export interface SessionCardProps extends Omit<CardProps, 'children'> {
	/** Session name */
	name: string;
	/** Session status */
	status: SessionStatus;
	/** Current input mode */
	mode: InputMode;
	/** Working directory path */
	cwd?: string;
	/** Status indicator element (optional, if you want custom indicator) */
	statusIndicator?: ReactNode;
	/** Additional info shown below the title */
	info?: ReactNode;
	/** Actions shown on the right side */
	actions?: ReactNode;
}

/**
 * Get status color based on session state
 */
const getStatusColor = (
	status: SessionStatus,
	colors: { success: string; warning: string; error: string }
): string => {
	switch (status) {
		case 'idle':
			return colors.success;
		case 'busy':
			return colors.warning;
		case 'error':
			return colors.error;
		case 'connecting':
			return '#f97316'; // Orange
		default:
			return colors.success;
	}
};

export const SessionCard = forwardRef<HTMLDivElement, SessionCardProps>(function SessionCard(
	{ name, status, mode, cwd, statusIndicator, info, actions, variant = 'outlined', ...props },
	ref
) {
	const { theme } = useTheme();
	const colors = theme.colors;
	const statusColor = getStatusColor(status, colors);

	// Truncate cwd for display
	const displayCwd = cwd ? (cwd.length > 30 ? '...' + cwd.slice(-27) : cwd) : undefined;

	return (
		<Card ref={ref} variant={variant} interactive {...props}>
			<div className="flex items-center gap-3">
				{/* Status indicator */}
				{statusIndicator || (
					<span
						className={`w-2 h-2 rounded-full flex-shrink-0 ${status === 'connecting' ? 'animate-pulse' : ''}`}
						style={{ backgroundColor: statusColor }}
						role="status"
						aria-label={status}
					/>
				)}

				{/* Main content */}
				<div className="flex flex-col gap-0.5 min-w-0 flex-1">
					<div className="flex items-center gap-2">
						<span className="font-medium text-sm truncate" style={{ color: colors.textMain }}>
							{name}
						</span>
						<span
							className="text-xs px-1.5 py-0.5 rounded"
							style={{
								backgroundColor: mode === 'ai' ? colors.accentDim : `${colors.textDim}20`,
								color: mode === 'ai' ? colors.accent : colors.textDim,
							}}
						>
							{mode === 'ai' ? 'AI' : 'Terminal'}
						</span>
					</div>
					{(displayCwd || info) && (
						<div className="text-xs truncate" style={{ color: colors.textDim }}>
							{info || displayCwd}
						</div>
					)}
				</div>

				{/* Actions */}
				{actions && <div className="flex-shrink-0">{actions}</div>}
			</div>
		</Card>
	);
});

export default Card;
