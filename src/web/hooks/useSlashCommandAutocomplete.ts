/**
 * useSlashCommandAutocomplete - Slash command autocomplete state management
 *
 * Manages slash command autocomplete state for the command input bar.
 * Detects when user types `/` at the start of input to show autocomplete,
 * handles command selection with auto-submit, and provides close functionality.
 *
 * Features:
 * - Automatic slash detection in input value
 * - Selected index management for keyboard/touch navigation
 * - Auto-submit after command selection
 * - Clears partial slash input on close
 * - Works with both controlled and uncontrolled input modes
 */

import { useState, useCallback, useRef, useEffect } from 'react';

/** Options for configuring slash command autocomplete behavior */
export interface UseSlashCommandAutocompleteOptions {
	/** Current input value (for slash detection) */
	inputValue: string;
	/** Whether using controlled input mode */
	isControlled: boolean;
	/** Callback when input value should change */
	onChange?: (value: string) => void;
	/** Callback when command should be submitted */
	onSubmit?: (command: string) => void;
	/** Ref to the textarea/input element for focus management */
	inputRef?: React.RefObject<HTMLTextAreaElement | HTMLInputElement | null>;
}

/** Return value from useSlashCommandAutocomplete hook */
export interface UseSlashCommandAutocompleteReturn {
	/** Whether slash command autocomplete is open */
	isOpen: boolean;
	/** Currently selected command index */
	selectedIndex: number;
	/** Set selected index (for keyboard navigation) */
	setSelectedIndex: (index: number) => void;
	/** Open the autocomplete popup manually (e.g., via button) */
	openAutocomplete: () => void;
	/** Handle input change - detects slash commands */
	handleInputChange: (newValue: string) => void;
	/** Handle command selection from autocomplete */
	handleSelectCommand: (command: string) => void;
	/** Close autocomplete (clears partial slash input) */
	handleClose: () => void;
}

/** Delay in ms before auto-submitting selected command */
const AUTO_SUBMIT_DELAY = 50;

/**
 * Hook for managing slash command autocomplete state
 *
 * @param options - Configuration options
 * @returns Slash command autocomplete state and handlers
 *
 * @example
 * ```tsx
 * const {
 *   isOpen,
 *   selectedIndex,
 *   setSelectedIndex,
 *   handleInputChange,
 *   handleSelectCommand,
 *   handleClose,
 * } = useSlashCommandAutocomplete({
 *   inputValue: value,
 *   isControlled: controlledValue !== undefined,
 *   onChange: handleChange,
 *   onSubmit: handleSubmit,
 *   inputRef: textareaRef,
 * });
 *
 * return (
 *   <>
 *     <SlashCommandAutocomplete
 *       isOpen={isOpen}
 *       inputValue={value}
 *       onSelectCommand={handleSelectCommand}
 *       onClose={handleClose}
 *       selectedIndex={selectedIndex}
 *       onSelectedIndexChange={setSelectedIndex}
 *     />
 *     <textarea onChange={(e) => handleInputChange(e.target.value)} />
 *   </>
 * );
 * ```
 */
export function useSlashCommandAutocomplete({
	inputValue,
	isControlled: _isControlled,
	onChange,
	onSubmit,
	inputRef,
}: UseSlashCommandAutocompleteOptions): UseSlashCommandAutocompleteReturn {
	// Autocomplete popup state
	const [isOpen, setIsOpen] = useState(false);
	const [selectedIndex, setSelectedIndex] = useState(0);

	// Track latest callbacks to avoid stale closures
	const onChangeRef = useRef(onChange);
	const onSubmitRef = useRef(onSubmit);

	useEffect(() => {
		onChangeRef.current = onChange;
		onSubmitRef.current = onSubmit;
	}, [onChange, onSubmit]);

	/**
	 * Open autocomplete popup manually (e.g., via slash button)
	 */
	const openAutocomplete = useCallback(() => {
		setIsOpen(true);
		setSelectedIndex(0);
	}, []);

	/**
	 * Handle input value change
	 * Detects slash commands at start of input and shows autocomplete
	 */
	const handleInputChange = useCallback((newValue: string) => {
		// Show slash command autocomplete when typing / at the start
		// Only show if input starts with / and doesn't contain spaces (still typing command)
		if (newValue.startsWith('/') && !newValue.includes(' ')) {
			setIsOpen(true);
			setSelectedIndex(0);
		} else {
			setIsOpen(false);
		}
	}, []);

	/**
	 * Handle slash command selection from autocomplete
	 * Updates input value and auto-submits after a brief delay
	 */
	const handleSelectCommand = useCallback(
		(command: string) => {
			// Update input value to the command
			onChangeRef.current?.(command);

			// Close autocomplete
			setIsOpen(false);

			// Focus back on input
			inputRef?.current?.focus();

			// Auto-submit the slash command after a brief delay
			setTimeout(() => {
				onSubmitRef.current?.(command);

				// Clear input after submit
				onChangeRef.current?.('');
			}, AUTO_SUBMIT_DELAY);
		},
		[inputRef]
	);

	/**
	 * Close slash command autocomplete
	 * Also clears the input if it only contains a partial slash command (no spaces)
	 */
	const handleClose = useCallback(() => {
		setIsOpen(false);

		// If input only contains a slash command prefix (no spaces), clear it
		if (inputValue.startsWith('/') && !inputValue.includes(' ')) {
			onChangeRef.current?.('');
		}
	}, [inputValue]);

	return {
		isOpen,
		selectedIndex,
		setSelectedIndex,
		openAutocomplete,
		handleInputChange,
		handleSelectCommand,
		handleClose,
	};
}

export default useSlashCommandAutocomplete;
