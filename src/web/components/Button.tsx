/**
 * Button component for Maestro web interface
 *
 * A reusable button component that supports multiple variants, sizes, and states.
 * Color, border, and radius tokens come from Tailwind utilities backed by the
 * `--maestro-*` CSS custom properties (see `tailwind.config.mjs` and
 * `src/web/utils/cssCustomProperties.ts`), so live theme swaps update visuals
 * without re-rendering.
 */

import React, { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

/**
 * Button variant types
 * - primary: Main call-to-action, uses accent color
 * - secondary: Secondary action, uses subtle background
 * - ghost: No background, hover reveals background
 * - danger: Destructive action, uses error color
 * - success: Positive action, uses success color
 */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';

/**
 * Button size options
 */
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
	/** Visual variant of the button */
	variant?: ButtonVariant;
	/** Size of the button */
	size?: ButtonSize;
	/** Whether the button is in a loading state */
	loading?: boolean;
	/** Icon to display before the text */
	leftIcon?: ReactNode;
	/** Icon to display after the text */
	rightIcon?: ReactNode;
	/** Whether the button should take full width */
	fullWidth?: boolean;
	/** Children content */
	children?: ReactNode;
}

/**
 * Variant → Tailwind class string. Color tokens resolve to live `--maestro-*`
 * CSS custom properties via `tailwind.config.mjs`. White text on filled
 * variants matches the legacy hardcoded `#ffffff` foreground.
 */
const variantClasses: Record<ButtonVariant, string> = {
	primary: 'bg-accent text-white',
	secondary: 'bg-bg-activity text-text-main border border-border',
	ghost: 'bg-transparent text-text-main border border-transparent',
	danger: 'bg-error text-white',
	success: 'bg-success text-white',
};

/**
 * Size → padding, type-scale, gap, and corner-radius tuple.
 * Tailwind's default `rounded`/`rounded-md`/`rounded-lg` are 4/6/8px and match
 * the legacy values 1:1.
 */
const sizeClasses: Record<ButtonSize, string> = {
	sm: 'px-2 py-1 text-xs gap-1 rounded',
	md: 'px-3 py-1.5 text-sm gap-1.5 rounded-md',
	lg: 'px-4 py-2 text-base gap-2 rounded-lg',
};

/**
 * Loading spinner component
 */
function LoadingSpinner({ size }: { size: ButtonSize }) {
	const spinnerSize = size === 'sm' ? 12 : size === 'md' ? 14 : 16;
	return (
		<svg
			className="animate-spin"
			width={spinnerSize}
			height={spinnerSize}
			viewBox="0 0 24 24"
			fill="none"
			xmlns="http://www.w3.org/2000/svg"
		>
			<circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
			<path
				className="opacity-75"
				fill="currentColor"
				d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
			/>
		</svg>
	);
}

const baseClasses =
	'inline-flex items-center justify-center font-medium whitespace-nowrap select-none outline-none cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 focus:ring-2 focus:ring-offset-1 transition-colors';

/**
 * Button component for the Maestro web interface
 *
 * @example
 * ```tsx
 * // Primary button
 * <Button variant="primary" onClick={handleClick}>
 *   Save Changes
 * </Button>
 *
 * // Button with loading state
 * <Button variant="primary" loading disabled>
 *   Saving...
 * </Button>
 *
 * // Button with icons
 * <Button variant="secondary" leftIcon={<Plus />}>
 *   Add Item
 * </Button>
 *
 * // Danger button
 * <Button variant="danger" onClick={handleDelete}>
 *   Delete
 * </Button>
 * ```
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
	{
		variant = 'primary',
		size = 'md',
		loading = false,
		leftIcon,
		rightIcon,
		fullWidth = false,
		disabled,
		children,
		className = '',
		style,
		...props
	},
	ref
) {
	const isDisabled = disabled || loading;

	const classNames = [
		baseClasses,
		sizeClasses[size],
		variantClasses[variant] ?? '',
		fullWidth ? 'w-full' : '',
		className,
	]
		.filter(Boolean)
		.join(' ');

	return (
		<button
			ref={ref}
			className={classNames}
			style={style}
			disabled={isDisabled}
			aria-busy={loading}
			{...props}
		>
			{loading && <LoadingSpinner size={size} />}
			{!loading && leftIcon && <span className="flex-shrink-0">{leftIcon}</span>}
			{children && <span>{children}</span>}
			{!loading && rightIcon && <span className="flex-shrink-0">{rightIcon}</span>}
		</button>
	);
});

/**
 * IconButton component for icon-only buttons
 *
 * @example
 * ```tsx
 * <IconButton
 *   variant="ghost"
 *   size="sm"
 *   onClick={handleClose}
 *   aria-label="Close"
 * >
 *   <X className="w-4 h-4" />
 * </IconButton>
 * ```
 */
export interface IconButtonProps extends Omit<ButtonProps, 'leftIcon' | 'rightIcon' | 'fullWidth'> {
	/** Accessible label for the button */
	'aria-label': string;
}

/**
 * Per-size padding + minimum hit-area for square icon buttons.
 * `!p-*` overrides the parent Button's `px-*`/`py-*`. `min-w-[…] min-h-[…]`
 * are class-level (specificity 0,1,0), so they win over the global
 * `button { min-height: 44px }` floor in `src/web/index.css` — preserving the
 * 24/32/40px legacy IconButton sizes called out in the Task 0.10 audit.
 */
const iconButtonSizeClasses: Record<ButtonSize, string> = {
	sm: '!p-1 min-w-[24px] min-h-[24px]',
	md: '!p-1.5 min-w-[32px] min-h-[32px]',
	lg: '!p-2 min-w-[40px] min-h-[40px]',
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
	{ size = 'md', className = '', style, children, ...props },
	ref
) {
	const sizeOverride = iconButtonSizeClasses[size];
	const composedClassName = [sizeOverride, className].filter(Boolean).join(' ');

	return (
		<Button ref={ref} size={size} className={composedClassName} style={style} {...props}>
			{children}
		</Button>
	);
});

export default Button;
