/**
 * Button component for Maestro web interface
 *
 * A reusable button component that supports multiple variants, sizes, and states.
 * Uses theme colors via CSS custom properties for consistent styling.
 */

import React, { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { useTheme } from './ThemeProvider';

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
 * Size-based style configurations
 */
const sizeStyles: Record<ButtonSize, React.CSSProperties & { className: string }> = {
	sm: {
		className: 'px-2 py-1 text-xs gap-1',
		borderRadius: '4px',
	},
	md: {
		className: 'px-3 py-1.5 text-sm gap-1.5',
		borderRadius: '6px',
	},
	lg: {
		className: 'px-4 py-2 text-base gap-2',
		borderRadius: '8px',
	},
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
	const { theme } = useTheme();
	const colors = theme.colors;

	const isDisabled = disabled || loading;

	/**
	 * Get variant-specific styles
	 */
	const getVariantStyles = (): React.CSSProperties => {
		const baseTransition =
			'background-color 150ms ease, border-color 150ms ease, opacity 150ms ease';

		switch (variant) {
			case 'primary':
				return {
					backgroundColor: colors.accent,
					color: '#ffffff',
					border: 'none',
					transition: baseTransition,
				};
			case 'secondary':
				return {
					backgroundColor: colors.bgActivity,
					color: colors.textMain,
					border: `1px solid ${colors.border}`,
					transition: baseTransition,
				};
			case 'ghost':
				return {
					backgroundColor: 'transparent',
					color: colors.textMain,
					border: '1px solid transparent',
					transition: baseTransition,
				};
			case 'danger':
				return {
					backgroundColor: colors.error,
					color: '#ffffff',
					border: 'none',
					transition: baseTransition,
				};
			case 'success':
				return {
					backgroundColor: colors.success,
					color: '#ffffff',
					border: 'none',
					transition: baseTransition,
				};
			default:
				return {};
		}
	};

	/**
	 * Get disabled styles
	 */
	const getDisabledStyles = (): React.CSSProperties => {
		if (!isDisabled) return {};
		return {
			opacity: 0.5,
			cursor: 'not-allowed',
		};
	};

	const sizeConfig = sizeStyles[size];
	const variantStyles = getVariantStyles();
	const disabledStyles = getDisabledStyles();

	const combinedStyles: React.CSSProperties = {
		...variantStyles,
		...disabledStyles,
		borderRadius: sizeConfig.borderRadius,
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'center',
		fontWeight: 500,
		cursor: isDisabled ? 'not-allowed' : 'pointer',
		outline: 'none',
		userSelect: 'none',
		width: fullWidth ? '100%' : undefined,
		...style,
	};

	// Construct class names
	const classNames = [
		sizeConfig.className,
		'font-medium whitespace-nowrap',
		'focus:ring-2 focus:ring-offset-1',
		'transition-colors',
		fullWidth ? 'w-full' : '',
		className,
	]
		.filter(Boolean)
		.join(' ');

	return (
		<button
			ref={ref}
			className={classNames}
			style={combinedStyles}
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

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
	{ size = 'md', className = '', style, children, ...props },
	ref
) {
	// Square padding for icon buttons
	const iconSizeStyles: Record<ButtonSize, { padding: string; minSize: string }> = {
		sm: { padding: '4px', minSize: '24px' },
		md: { padding: '6px', minSize: '32px' },
		lg: { padding: '8px', minSize: '40px' },
	};

	const sizeConfig = iconSizeStyles[size];

	return (
		<Button
			ref={ref}
			size={size}
			className={`!p-0 ${className}`}
			style={{
				padding: sizeConfig.padding,
				minWidth: sizeConfig.minSize,
				minHeight: sizeConfig.minSize,
				...style,
			}}
			{...props}
		>
			{children}
		</Button>
	);
});

export default Button;
