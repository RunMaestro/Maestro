/**
 * Card component for Maestro web interface
 *
 * Reusable card containers and header/body/footer slots. Color, border, radius,
 * and shadow tokens come from Tailwind utilities backed by the `--maestro-*`
 * CSS custom properties (see `tailwind.config.mjs` and
 * `src/web/utils/cssCustomProperties.ts`), so live theme swaps update visuals
 * without re-rendering.
 */

import React, { forwardRef, type HTMLAttributes, type ReactNode } from 'react';

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
 * Padding → Tailwind class. `none` emits no class so `Card padding="none"`
 * leaves child `CardBody` padding untouched in the final className output.
 */
const paddingClasses: Record<CardPadding, string> = {
	none: '',
	sm: 'p-2',
	md: 'p-3',
	lg: 'p-4',
};

/**
 * Radius → Tailwind class. Values match the legacy px tuple 1:1:
 * `rounded` = 4px, `rounded-lg` = 8px, `rounded-xl` = 12px.
 */
const radiusClasses: Record<CardRadius, string> = {
	none: 'rounded-none',
	sm: 'rounded',
	md: 'rounded-lg',
	lg: 'rounded-xl',
	full: 'rounded-full',
};

/**
 * Variant → Tailwind class string. Color tokens resolve via `--maestro-*`
 * CSS custom properties (see `tailwind.config.mjs`). `elevated` uses the
 * project-local `shadow-card-elevated` so the exact legacy box-shadow is
 * preserved (Tailwind's stock `shadow-md` differs in the second layer).
 */
const variantClasses: Record<CardVariant, string> = {
	default: 'bg-bg-activity text-text-main',
	elevated: 'bg-bg-activity text-text-main shadow-card-elevated',
	outlined: 'bg-transparent text-text-main border border-border',
	filled: 'bg-bg-sidebar text-text-main',
	ghost: 'bg-transparent text-text-main border border-transparent',
};

/**
 * Selected overlay → Tailwind classes. Applied on top of the variant classes.
 *
 * All variants gain an accent ring (`ring-1 ring-accent`), which renders as
 * the `box-shadow: 0 0 0 1px accent` outline from the legacy implementation.
 * Background and border tokens use `!` so the override wins regardless of the
 * alphabetical class-ordering Tailwind bakes into the final stylesheet.
 *
 * - outlined: swap the border token and fill with `accent-dim` — matches the
 *   legacy behavior where outlined+selected shows both an accent border and
 *   an accent-tinted fill.
 * - ghost: border token was transparent; swap to accent so selection is
 *   visible. Fill with `bg-activity` to match the legacy non-outlined path.
 * - default / elevated / filled: only add the ring + `bg-activity`. Legacy
 *   code set a `borderColor` too but the variants have no border-width, so
 *   it was a no-op — we don't emit a border-color utility here either.
 */
function getSelectedClasses(variant: CardVariant): string {
	switch (variant) {
		case 'outlined':
			return '!bg-accent-dim !border-accent ring-1 ring-accent';
		case 'ghost':
			return '!bg-bg-activity !border-accent ring-1 ring-accent';
		default:
			return '!bg-bg-activity ring-1 ring-accent';
	}
}

/**
 * Base classes shared across every Card. `transition-all duration-150`
 * replaces the legacy inline `transition: 'background-color 150ms ease, …'`
 * and covers the same four properties (background, border, shadow, transform).
 */
const baseClasses =
	'transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1';

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
	const variantClassName = variantClasses[variant] ?? '';
	const selectedClassName = selected ? getSelectedClasses(variant) : '';
	const interactiveClassName =
		interactive && !disabled ? 'cursor-pointer hover:brightness-110 active:scale-[0.99]' : '';
	const disabledClassName = disabled ? 'opacity-50 cursor-not-allowed pointer-events-none' : '';

	const classNames = [
		baseClasses,
		variantClassName,
		paddingClasses[padding],
		radiusClasses[radius],
		selectedClassName,
		interactiveClassName,
		disabledClassName,
		fullWidth ? 'w-full' : '',
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
			style={style}
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
	const containerClassName = ['flex items-center justify-between', className]
		.filter(Boolean)
		.join(' ');

	// If children are provided, render them directly
	if (children) {
		return (
			<div ref={ref} className={containerClassName} style={style} {...props}>
				{children}
			</div>
		);
	}

	return (
		<div ref={ref} className={containerClassName} style={style} {...props}>
			<div className="flex flex-col gap-0.5 min-w-0 flex-1">
				{title && <div className="font-medium text-sm truncate text-text-main">{title}</div>}
				{subtitle && <div className="text-xs truncate text-text-dim">{subtitle}</div>}
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
	const classNames = [paddingClasses[padding], className].filter(Boolean).join(' ');
	return (
		<div ref={ref} className={classNames} {...props}>
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
	const classNames = [
		'flex items-center gap-2 pt-2 mt-2',
		bordered ? 'border-t border-border' : '',
		className,
	]
		.filter(Boolean)
		.join(' ');

	return (
		<div ref={ref} className={classNames} style={style} {...props}>
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
 * Map session status → Tailwind background class for the dot indicator.
 * `connecting` uses the non-theme `connecting` token (literal hex) so its
 * orange color is stable across user themes, mirroring the legacy hardcode.
 */
const statusBgClasses: Record<SessionStatus, string> = {
	idle: 'bg-success',
	busy: 'bg-warning',
	error: 'bg-error',
	connecting: 'bg-connecting',
};

export const SessionCard = forwardRef<HTMLDivElement, SessionCardProps>(function SessionCard(
	{ name, status, mode, cwd, statusIndicator, info, actions, variant = 'outlined', ...props },
	ref
) {
	const statusBg = statusBgClasses[status] ?? statusBgClasses.idle;

	// Truncate cwd for display
	const displayCwd = cwd ? (cwd.length > 30 ? '...' + cwd.slice(-27) : cwd) : undefined;

	// Terminal-mode badge wants a subtle text-dim-tinted background. `var()`
	// tokens don't compose with Tailwind's opacity modifiers, so use
	// `color-mix` — same trick as Badge.tsx's `subtle` style.
	const modeBadgeClassName =
		mode === 'ai'
			? 'bg-accent-dim text-accent'
			: 'bg-[color-mix(in_srgb,var(--maestro-text-dim)_12%,transparent)] text-text-dim';

	return (
		<Card ref={ref} variant={variant} interactive {...props}>
			<div className="flex items-center gap-3">
				{/* Status indicator */}
				{statusIndicator || (
					<span
						className={`w-2 h-2 rounded-full flex-shrink-0 ${statusBg}${
							status === 'connecting' ? ' animate-pulse' : ''
						}`}
						role="status"
						aria-label={status}
					/>
				)}

				{/* Main content */}
				<div className="flex flex-col gap-0.5 min-w-0 flex-1">
					<div className="flex items-center gap-2">
						<span className="font-medium text-sm truncate text-text-main">{name}</span>
						<span className={`text-xs px-1.5 py-0.5 rounded ${modeBadgeClassName}`}>
							{mode === 'ai' ? 'AI' : 'Terminal'}
						</span>
					</div>
					{(displayCwd || info) && (
						<div className="text-xs truncate text-text-dim">{info || displayCwd}</div>
					)}
				</div>

				{/* Actions */}
				{actions && <div className="flex-shrink-0">{actions}</div>}
			</div>
		</Card>
	);
});

export default Card;
