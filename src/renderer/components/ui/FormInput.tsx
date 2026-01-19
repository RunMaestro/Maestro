/**
 * FormInput - Reusable themed form input component
 *
 * This component encapsulates common form input patterns used throughout
 * the application, providing consistent styling, keyboard handling, and
 * accessibility features.
 *
 * Features:
 * - Consistent themed styling (borders, colors, padding)
 * - Built-in Enter key handling for form submission
 * - Optional label with consistent formatting
 * - Optional helper text below input
 * - Optional error display with error styling
 * - Ref forwarding for focus management
 * - Optional addon content (icons, buttons) on the right
 *
 * Usage:
 * ```tsx
 * <FormInput
 *   theme={theme}
 *   label="Agent Name"
 *   value={name}
 *   onChange={setName}
 *   onSubmit={handleSave}
 *   placeholder="Enter name..."
 *   error={validation.error}
 * />
 * ```
 */

import React, { forwardRef, useId } from 'react';
import type { Theme } from '../../types';

export interface FormInputProps {
	/** Theme object for styling */
	theme: Theme;
	/** Current input value */
	value: string;
	/** Callback when value changes */
	onChange: (value: string) => void;
	/** Optional callback when Enter is pressed (and input is valid) */
	onSubmit?: () => void;
	/** Optional label text displayed above the input */
	label?: string;
	/** Input placeholder text */
	placeholder?: string;
	/** Error message to display (also affects border color) */
	error?: string;
	/** Helper text displayed below the input */
	helperText?: string;
	/** Whether the input is disabled */
	disabled?: boolean;
	/** Input type (text, password, email, etc.). Defaults to 'text' */
	type?: string;
	/** Whether to use monospace font. Defaults to false */
	monospace?: boolean;
	/** Additional className for the input element */
	className?: string;
	/** Custom input height class. Defaults to standard padding */
	heightClass?: string;
	/** Content to render on the right side of the input (icons, buttons) */
	addon?: React.ReactNode;
	/** Whether the input should auto-focus on mount */
	autoFocus?: boolean;
	/** Custom onKeyDown handler (called before Enter handling) */
	onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
	/** Additional validation before allowing submit. Defaults to true */
	submitEnabled?: boolean;
	/** ID for the input element (auto-generated if not provided) */
	id?: string;
	/** Test ID for the input container */
	testId?: string;
	/** Whether to select all text when focused */
	selectOnFocus?: boolean;
}

/**
 * Reusable form input component with consistent styling and behavior
 */
export const FormInput = forwardRef<HTMLInputElement, FormInputProps>(
	(
		{
			theme,
			value,
			onChange,
			onSubmit,
			label,
			placeholder,
			error,
			helperText,
			disabled = false,
			type = 'text',
			monospace = false,
			className = '',
			heightClass = '',
			addon,
			autoFocus = false,
			onKeyDown,
			submitEnabled = true,
			id: providedId,
			testId,
			selectOnFocus = false,
		},
		ref
	) => {
		const generatedId = useId();
		const inputId = providedId || generatedId;

		const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
			// Call custom handler first
			onKeyDown?.(e);

			// If not prevented and Enter was pressed, submit
			if (e.key === 'Enter' && !e.defaultPrevented && onSubmit && submitEnabled) {
				e.preventDefault();
				e.stopPropagation(); // Prevent Enter from propagating to parent listeners after modal closes
				onSubmit();
			}
		};

		const handleFocus = (e: React.FocusEvent<HTMLInputElement>) => {
			if (selectOnFocus) {
				e.target.select();
			}
		};

		const hasError = Boolean(error);

		return (
			<div className="w-full" data-testid={testId}>
				{label && (
					<label
						htmlFor={inputId}
						className="block text-xs font-bold opacity-70 uppercase mb-2"
						style={{ color: theme.colors.textMain }}
					>
						{label}
					</label>
				)}

				<div className={addon ? 'flex gap-2' : ''}>
					<input
						ref={ref}
						id={inputId}
						type={type}
						value={value}
						onChange={(e) => onChange(e.target.value)}
						onKeyDown={handleKeyDown}
						onFocus={handleFocus}
						placeholder={placeholder}
						disabled={disabled}
						autoFocus={autoFocus}
						className={`
              ${addon ? 'flex-1' : 'w-full'}
              p-3 rounded border bg-transparent outline-none
              ${monospace ? 'font-mono text-sm' : ''}
              ${heightClass}
              ${disabled ? 'opacity-50 cursor-not-allowed' : ''}
              ${className}
            `
							.trim()
							.replace(/\s+/g, ' ')}
						style={{
							borderColor: hasError ? theme.colors.error : theme.colors.border,
							color: theme.colors.textMain,
						}}
					/>
					{addon}
				</div>

				{error && (
					<p className="mt-1 text-xs" style={{ color: theme.colors.error }}>
						{error}
					</p>
				)}

				{helperText && !error && (
					<p className="mt-2 text-xs" style={{ color: theme.colors.textDim }}>
						{helperText}
					</p>
				)}
			</div>
		);
	}
);

FormInput.displayName = 'FormInput';

export default FormInput;
