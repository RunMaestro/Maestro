/**
 * Input and TextArea components for Maestro web interface
 *
 * Color, border, and radius tokens come from Tailwind utilities backed by the
 * `--maestro-*` CSS custom properties (see `tailwind.config.mjs` and
 * `src/web/utils/cssCustomProperties.ts`), so live theme swaps update visuals
 * without re-rendering.
 */

import React, {
	forwardRef,
	type InputHTMLAttributes,
	type TextareaHTMLAttributes,
	type ReactNode,
} from 'react';

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
 * Variant → Tailwind class string. Background + text resolve via
 * `--maestro-*`-backed tokens; the error flag swaps the border token so we
 * never emit two conflicting `border-*` utilities at once.
 */
const variantClasses: Record<InputVariant, { base: string; error: string }> = {
	default: {
		base: 'bg-bg-main text-text-main border border-border',
		error: 'bg-bg-main text-text-main border border-error',
	},
	filled: {
		base: 'bg-bg-activity text-text-main border border-transparent',
		error: 'bg-bg-activity text-text-main border border-error',
	},
	ghost: {
		base: 'bg-transparent text-text-main border border-transparent',
		error: 'bg-transparent text-text-main border border-error',
	},
};

/**
 * Size → padding, type-scale, and corner-radius tuple.
 * Tailwind's default `rounded`/`rounded-md`/`rounded-lg` are 4/6/8px and match
 * the legacy values 1:1.
 */
const sizeClasses: Record<InputSize, string> = {
	sm: 'px-2 py-1 text-xs rounded',
	md: 'px-3 py-1.5 text-sm rounded-md',
	lg: 'px-4 py-2 text-base rounded-lg',
};

/**
 * Icon padding adjustments based on size
 */
const iconPaddingClasses: Record<InputSize, { left: string; right: string }> = {
	sm: { left: 'pl-7', right: 'pr-7' },
	md: { left: 'pl-9', right: 'pr-9' },
	lg: { left: 'pl-11', right: 'pr-11' },
};

/**
 * Line heights used for TextArea min-height / auto-resize math.
 * Must stay in sync with the text-* utilities in `sizeClasses`.
 */
const lineHeightBySize: Record<InputSize, number> = {
	sm: 16,
	md: 20,
	lg: 24,
};

const baseInputClasses =
	'font-normal outline-none transition-colors placeholder:text-text-dim focus:ring-2 focus:ring-offset-1 disabled:opacity-50 disabled:cursor-not-allowed';

function getVariantClass(variant: InputVariant, error: boolean): string {
	const config = variantClasses[variant];
	if (!config) return '';
	return error ? config.error : config.base;
}

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
	const classNames = [
		baseInputClasses,
		sizeClasses[size],
		getVariantClass(variant, error),
		fullWidth ? 'w-full' : '',
		leftIcon ? iconPaddingClasses[size].left : '',
		rightIcon ? iconPaddingClasses[size].right : '',
		className,
	]
		.filter(Boolean)
		.join(' ');

	if (leftIcon || rightIcon) {
		return (
			<div className={`relative inline-flex items-center ${fullWidth ? 'w-full' : ''}`}>
				{leftIcon && (
					<span className="absolute left-2 flex items-center pointer-events-none text-text-dim">
						{leftIcon}
					</span>
				)}
				<input
					ref={ref}
					className={classNames}
					style={style}
					disabled={disabled}
					aria-invalid={error}
					{...props}
				/>
				{rightIcon && (
					<span className="absolute right-2 flex items-center pointer-events-none text-text-dim">
						{rightIcon}
					</span>
				)}
			</div>
		);
	}

	return (
		<input
			ref={ref}
			className={classNames}
			style={style}
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
	const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);

	/**
	 * Handle auto-resize on input
	 */
	const handleInput = (e: React.FormEvent<HTMLTextAreaElement>) => {
		if (autoResize && textareaRef.current) {
			const textarea = textareaRef.current;
			textarea.style.height = 'auto';

			const lineHeight = lineHeightBySize[size];
			const minHeight = minRows * lineHeight;
			const maxHeight = maxRows ? maxRows * lineHeight : undefined;

			let newHeight = Math.max(textarea.scrollHeight, minHeight);
			if (maxHeight && newHeight > maxHeight) {
				newHeight = maxHeight;
				textarea.style.overflowY = 'auto';
			} else {
				textarea.style.overflowY = 'hidden';
			}
			textarea.style.height = `${newHeight}px`;
		}

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

	const classNames = [
		baseInputClasses,
		sizeClasses[size],
		getVariantClass(variant, error),
		fullWidth ? 'w-full' : '',
		autoResize ? 'resize-none' : 'resize-y',
		className,
	]
		.filter(Boolean)
		.join(' ');

	// minHeight depends on the minRows prop, so it has to be inline —
	// Tailwind's arbitrary-value classes require compile-time strings.
	const minHeight = minRows * lineHeightBySize[size];
	const combinedStyle: React.CSSProperties = {
		minHeight: `${minHeight}px`,
		...style,
	};

	return (
		<textarea
			ref={setRefs}
			className={classNames}
			style={combinedStyle}
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
	return (
		<div className={`flex flex-col gap-1 ${className}`}>
			{label && (
				<label className="text-sm font-medium text-text-main">
					{label}
					{required && <span className="ml-1 text-error">*</span>}
				</label>
			)}
			{children}
			{(error || helperText) && (
				<span className={`text-xs ${error ? 'text-error' : 'text-text-dim'}`}>
					{error || helperText}
				</span>
			)}
		</div>
	);
}

export default Input;
