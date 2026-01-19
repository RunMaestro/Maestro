/**
 * Input and TextArea components for Maestro web interface
 *
 * Reusable input components that support multiple variants, sizes, and states.
 * Uses theme colors via CSS custom properties for consistent styling.
 */

import React, {
	forwardRef,
	type InputHTMLAttributes,
	type TextareaHTMLAttributes,
	type ReactNode,
} from 'react';
import { useTheme } from './ThemeProvider';

/**
 * Input variant types
 * - default: Standard input with border
 * - filled: Input with filled background
 * - ghost: Minimal input with no border until focused
 */
export type InputVariant = 'default' | 'filled' | 'ghost';

/**
 * Input size options
 */
export type InputSize = 'sm' | 'md' | 'lg';

/**
 * Base props shared between Input and TextArea
 */
interface BaseInputProps {
	/** Visual variant of the input */
	variant?: InputVariant;
	/** Size of the input */
	size?: InputSize;
	/** Whether the input has an error */
	error?: boolean;
	/** Whether the input should take full width */
	fullWidth?: boolean;
	/** Icon to display at the start of the input */
	leftIcon?: ReactNode;
	/** Icon to display at the end of the input */
	rightIcon?: ReactNode;
}

export interface InputProps
	extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'>, BaseInputProps {}

export interface TextAreaProps
	extends
		Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'size'>,
		Omit<BaseInputProps, 'leftIcon' | 'rightIcon'> {
	/** Minimum number of rows */
	minRows?: number;
	/** Maximum number of rows before scrolling */
	maxRows?: number;
	/** Whether to auto-resize based on content */
	autoResize?: boolean;
}

/**
 * Size-based style configurations
 */
const sizeStyles: Record<InputSize, { className: string; borderRadius: string; iconSize: number }> =
	{
		sm: {
			className: 'px-2 py-1 text-xs',
			borderRadius: '4px',
			iconSize: 14,
		},
		md: {
			className: 'px-3 py-1.5 text-sm',
			borderRadius: '6px',
			iconSize: 16,
		},
		lg: {
			className: 'px-4 py-2 text-base',
			borderRadius: '8px',
			iconSize: 18,
		},
	};

/**
 * Icon padding adjustments based on size
 */
const iconPadding: Record<InputSize, { left: string; right: string }> = {
	sm: { left: 'pl-7', right: 'pr-7' },
	md: { left: 'pl-9', right: 'pr-9' },
	lg: { left: 'pl-11', right: 'pr-11' },
};

/**
 * Input component for the Maestro web interface
 *
 * @example
 * ```tsx
 * // Basic input
 * <Input placeholder="Enter text..." />
 *
 * // Input with error state
 * <Input error placeholder="Invalid input" />
 *
 * // Input with icons
 * <Input
 *   leftIcon={<Search className="w-4 h-4" />}
 *   placeholder="Search..."
 * />
 *
 * // Filled variant
 * <Input variant="filled" placeholder="Filled input" />
 * ```
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
	{
		variant = 'default',
		size = 'md',
		error = false,
		fullWidth = false,
		leftIcon,
		rightIcon,
		disabled,
		className = '',
		style,
		...props
	},
	ref
) {
	const { theme } = useTheme();
	const colors = theme.colors;

	const sizeConfig = sizeStyles[size];

	/**
	 * Get variant-specific styles
	 */
	const getVariantStyles = (): React.CSSProperties => {
		const baseTransition =
			'background-color 150ms ease, border-color 150ms ease, box-shadow 150ms ease';

		switch (variant) {
			case 'default':
				return {
					backgroundColor: colors.bgMain,
					color: colors.textMain,
					border: `1px solid ${error ? colors.error : colors.border}`,
					transition: baseTransition,
				};
			case 'filled':
				return {
					backgroundColor: colors.bgActivity,
					color: colors.textMain,
					border: `1px solid ${error ? colors.error : 'transparent'}`,
					transition: baseTransition,
				};
			case 'ghost':
				return {
					backgroundColor: 'transparent',
					color: colors.textMain,
					border: `1px solid ${error ? colors.error : 'transparent'}`,
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
		if (!disabled) return {};
		return {
			opacity: 0.5,
			cursor: 'not-allowed',
		};
	};

	const variantStyles = getVariantStyles();
	const disabledStyles = getDisabledStyles();

	const combinedStyles: React.CSSProperties = {
		...variantStyles,
		...disabledStyles,
		borderRadius: sizeConfig.borderRadius,
		outline: 'none',
		width: fullWidth ? '100%' : undefined,
		...style,
	};

	// Construct class names
	const baseClasses = [
		sizeConfig.className,
		'font-normal',
		'placeholder:text-opacity-50',
		'focus:ring-2 focus:ring-offset-1',
		'transition-colors',
		fullWidth ? 'w-full' : '',
		leftIcon ? iconPadding[size].left : '',
		rightIcon ? iconPadding[size].right : '',
		className,
	]
		.filter(Boolean)
		.join(' ');

	// If we have icons, wrap in a container
	if (leftIcon || rightIcon) {
		return (
			<div className={`relative inline-flex items-center ${fullWidth ? 'w-full' : ''}`}>
				{leftIcon && (
					<span
						className="absolute left-2 flex items-center pointer-events-none"
						style={{ color: colors.textDim }}
					>
						{leftIcon}
					</span>
				)}
				<input
					ref={ref}
					className={baseClasses}
					style={
						{
							...combinedStyles,
							// Override placeholder color using CSS variable
							'--placeholder-color': colors.textDim,
						} as React.CSSProperties
					}
					disabled={disabled}
					aria-invalid={error}
					{...props}
				/>
				{rightIcon && (
					<span
						className="absolute right-2 flex items-center pointer-events-none"
						style={{ color: colors.textDim }}
					>
						{rightIcon}
					</span>
				)}
			</div>
		);
	}

	return (
		<input
			ref={ref}
			className={baseClasses}
			style={
				{
					...combinedStyles,
					'--placeholder-color': colors.textDim,
				} as React.CSSProperties
			}
			disabled={disabled}
			aria-invalid={error}
			{...props}
		/>
	);
});

/**
 * TextArea component for the Maestro web interface
 *
 * @example
 * ```tsx
 * // Basic textarea
 * <TextArea placeholder="Enter message..." />
 *
 * // Auto-resizing textarea
 * <TextArea
 *   autoResize
 *   minRows={2}
 *   maxRows={8}
 *   placeholder="Type here..."
 * />
 *
 * // Textarea with error
 * <TextArea error placeholder="Required field" />
 * ```
 */
export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
	{
		variant = 'default',
		size = 'md',
		error = false,
		fullWidth = false,
		minRows = 3,
		maxRows,
		autoResize = false,
		disabled,
		className = '',
		style,
		onInput,
		...props
	},
	ref
) {
	const { theme } = useTheme();
	const colors = theme.colors;

	const sizeConfig = sizeStyles[size];

	// Internal ref for auto-resize functionality
	const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);

	/**
	 * Get variant-specific styles
	 */
	const getVariantStyles = (): React.CSSProperties => {
		const baseTransition =
			'background-color 150ms ease, border-color 150ms ease, box-shadow 150ms ease';

		switch (variant) {
			case 'default':
				return {
					backgroundColor: colors.bgMain,
					color: colors.textMain,
					border: `1px solid ${error ? colors.error : colors.border}`,
					transition: baseTransition,
				};
			case 'filled':
				return {
					backgroundColor: colors.bgActivity,
					color: colors.textMain,
					border: `1px solid ${error ? colors.error : 'transparent'}`,
					transition: baseTransition,
				};
			case 'ghost':
				return {
					backgroundColor: 'transparent',
					color: colors.textMain,
					border: `1px solid ${error ? colors.error : 'transparent'}`,
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
		if (!disabled) return {};
		return {
			opacity: 0.5,
			cursor: 'not-allowed',
		};
	};

	/**
	 * Handle auto-resize on input
	 */
	const handleInput = (e: React.FormEvent<HTMLTextAreaElement>) => {
		if (autoResize && textareaRef.current) {
			const textarea = textareaRef.current;
			// Reset height to auto to get the correct scrollHeight
			textarea.style.height = 'auto';

			// Calculate line height (approximate based on font size)
			const lineHeight = size === 'sm' ? 16 : size === 'md' ? 20 : 24;
			const minHeight = minRows * lineHeight;
			const maxHeight = maxRows ? maxRows * lineHeight : undefined;

			// Set the new height
			let newHeight = Math.max(textarea.scrollHeight, minHeight);
			if (maxHeight && newHeight > maxHeight) {
				newHeight = maxHeight;
				textarea.style.overflowY = 'auto';
			} else {
				textarea.style.overflowY = 'hidden';
			}
			textarea.style.height = `${newHeight}px`;
		}

		// Call the original onInput handler if provided
		onInput?.(e);
	};

	/**
	 * Set up ref forwarding with internal ref
	 */
	const setRefs = React.useCallback(
		(element: HTMLTextAreaElement | null) => {
			textareaRef.current = element;
			if (typeof ref === 'function') {
				ref(element);
			} else if (ref) {
				ref.current = element;
			}
		},
		[ref]
	);

	const variantStyles = getVariantStyles();
	const disabledStyles = getDisabledStyles();

	// Calculate min-height based on minRows
	const lineHeight = size === 'sm' ? 16 : size === 'md' ? 20 : 24;
	const minHeight = minRows * lineHeight;

	const combinedStyles: React.CSSProperties = {
		...variantStyles,
		...disabledStyles,
		borderRadius: sizeConfig.borderRadius,
		outline: 'none',
		width: fullWidth ? '100%' : undefined,
		minHeight: `${minHeight}px`,
		resize: autoResize ? 'none' : 'vertical',
		...style,
	};

	// Construct class names
	const classNames = [
		sizeConfig.className,
		'font-normal',
		'placeholder:text-opacity-50',
		'focus:ring-2 focus:ring-offset-1',
		'transition-colors',
		fullWidth ? 'w-full' : '',
		className,
	]
		.filter(Boolean)
		.join(' ');

	return (
		<textarea
			ref={setRefs}
			className={classNames}
			style={
				{
					...combinedStyles,
					'--placeholder-color': colors.textDim,
				} as React.CSSProperties
			}
			disabled={disabled}
			aria-invalid={error}
			onInput={handleInput}
			rows={minRows}
			{...props}
		/>
	);
});

/**
 * InputGroup component for grouping label, input, and helper text
 *
 * @example
 * ```tsx
 * <InputGroup
 *   label="Email"
 *   helperText="We'll never share your email"
 *   error={errors.email}
 * >
 *   <Input type="email" placeholder="john@example.com" />
 * </InputGroup>
 * ```
 */
export interface InputGroupProps {
	/** Label text for the input */
	label?: string;
	/** Helper text shown below the input */
	helperText?: string;
	/** Error message (overrides helperText when present) */
	error?: string;
	/** Whether the field is required */
	required?: boolean;
	/** Children (typically Input or TextArea) */
	children: ReactNode;
	/** Additional class names for the container */
	className?: string;
}

export function InputGroup({
	label,
	helperText,
	error,
	required,
	children,
	className = '',
}: InputGroupProps) {
	const { theme } = useTheme();
	const colors = theme.colors;

	return (
		<div className={`flex flex-col gap-1 ${className}`}>
			{label && (
				<label className="text-sm font-medium" style={{ color: colors.textMain }}>
					{label}
					{required && (
						<span style={{ color: colors.error }} className="ml-1">
							*
						</span>
					)}
				</label>
			)}
			{children}
			{(error || helperText) && (
				<span className="text-xs" style={{ color: error ? colors.error : colors.textDim }}>
					{error || helperText}
				</span>
			)}
		</div>
	);
}

export default Input;
