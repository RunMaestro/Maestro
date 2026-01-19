import { useState, useCallback, useRef, useEffect } from 'react';
import { TEMPLATE_VARIABLES } from '../../utils/templateVariables';
import { useClickOutside } from '../ui';

export interface AutocompleteState {
	isOpen: boolean;
	position: { top: number; left: number };
	selectedIndex: number;
	searchText: string;
	filteredVariables: typeof TEMPLATE_VARIABLES;
}

interface UseTemplateAutocompleteProps {
	textareaRef: React.RefObject<HTMLTextAreaElement>;
	value: string;
	onChange: (value: string) => void;
}

interface UseTemplateAutocompleteReturn {
	autocompleteState: AutocompleteState;
	handleKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => boolean;
	handleChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
	selectVariable: (variable: string) => void;
	closeAutocomplete: () => void;
	autocompleteRef: React.RefObject<HTMLDivElement>;
}

const INITIAL_STATE: AutocompleteState = {
	isOpen: false,
	position: { top: 0, left: 0 },
	selectedIndex: 0,
	searchText: '',
	filteredVariables: TEMPLATE_VARIABLES,
};

/**
 * Hook for template variable autocomplete functionality.
 * Shows a dropdown when user types "{{" and allows selection of template variables.
 */
export function useTemplateAutocomplete({
	textareaRef,
	value,
	onChange,
}: UseTemplateAutocompleteProps): UseTemplateAutocompleteReturn {
	const [autocompleteState, setAutocompleteState] = useState<AutocompleteState>(INITIAL_STATE);
	const autocompleteRef = useRef<HTMLDivElement>(null);
	const triggerPositionRef = useRef<number | null>(null);

	// Filter variables based on search text
	const filterVariables = useCallback((searchText: string) => {
		if (!searchText) {
			return TEMPLATE_VARIABLES;
		}
		const search = searchText.toLowerCase();
		return TEMPLATE_VARIABLES.filter(
			(v) =>
				v.variable.toLowerCase().includes(search) || v.description.toLowerCase().includes(search)
		);
	}, []);

	// Calculate position for the dropdown
	const calculatePosition = useCallback((textarea: HTMLTextAreaElement, cursorPos: number) => {
		// Create a mirror div to measure text position
		const mirror = document.createElement('div');
		const style = window.getComputedStyle(textarea);

		// Copy relevant styles
		mirror.style.cssText = `
      position: absolute;
      visibility: hidden;
      white-space: pre-wrap;
      word-wrap: break-word;
      font-family: ${style.fontFamily};
      font-size: ${style.fontSize};
      line-height: ${style.lineHeight};
      padding: ${style.padding};
      border: ${style.border};
      width: ${textarea.clientWidth}px;
      box-sizing: border-box;
    `;

		// Get text up to cursor
		const textBeforeCursor = textarea.value.substring(0, cursorPos);
		mirror.textContent = textBeforeCursor;

		// Add a span at the cursor position
		const span = document.createElement('span');
		span.textContent = '|';
		mirror.appendChild(span);

		document.body.appendChild(mirror);

		const _textareaRect = textarea.getBoundingClientRect();
		const spanRect = span.getBoundingClientRect();
		const mirrorRect = mirror.getBoundingClientRect();

		document.body.removeChild(mirror);

		// Calculate position relative to textarea
		const relativeTop = spanRect.top - mirrorRect.top;
		const relativeLeft = spanRect.left - mirrorRect.left;

		// Account for scroll
		const scrollTop = textarea.scrollTop;

		return {
			top: relativeTop - scrollTop + parseInt(style.lineHeight || '20', 10) + 4,
			left: Math.min(relativeLeft, textarea.clientWidth - 250), // Prevent overflow
		};
	}, []);

	// Open autocomplete dropdown
	const openAutocomplete = useCallback(
		(textarea: HTMLTextAreaElement, cursorPos: number) => {
			triggerPositionRef.current = cursorPos - 2; // Position before "{{"
			const position = calculatePosition(textarea, cursorPos);
			setAutocompleteState({
				isOpen: true,
				position,
				selectedIndex: 0,
				searchText: '',
				filteredVariables: TEMPLATE_VARIABLES,
			});
		},
		[calculatePosition]
	);

	// Close autocomplete dropdown
	const closeAutocomplete = useCallback(() => {
		setAutocompleteState(INITIAL_STATE);
		triggerPositionRef.current = null;
	}, []);

	// Select a variable and insert it
	const selectVariable = useCallback(
		(variable: string) => {
			if (!textareaRef.current || triggerPositionRef.current === null) return;

			const textarea = textareaRef.current;
			const triggerPos = triggerPositionRef.current;
			const cursorPos = textarea.selectionStart;

			// Replace from trigger position to current cursor with the variable
			const before = value.substring(0, triggerPos);
			const after = value.substring(cursorPos);
			const newValue = before + variable + after;

			onChange(newValue);

			// Move cursor to after the inserted variable
			const newCursorPos = triggerPos + variable.length;
			requestAnimationFrame(() => {
				if (textareaRef.current) {
					textareaRef.current.focus();
					textareaRef.current.setSelectionRange(newCursorPos, newCursorPos);
				}
			});

			closeAutocomplete();
		},
		[textareaRef, value, onChange, closeAutocomplete]
	);

	// Handle key down events
	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
			if (!autocompleteState.isOpen) return false;

			const { filteredVariables, selectedIndex } = autocompleteState;

			switch (e.key) {
				case 'ArrowDown':
					e.preventDefault();
					setAutocompleteState((prev) => ({
						...prev,
						selectedIndex: Math.min(prev.selectedIndex + 1, filteredVariables.length - 1),
					}));
					return true;

				case 'ArrowUp':
					e.preventDefault();
					setAutocompleteState((prev) => ({
						...prev,
						selectedIndex: Math.max(prev.selectedIndex - 1, 0),
					}));
					return true;

				case 'Enter':
				case 'Tab':
					if (filteredVariables.length > 0) {
						e.preventDefault();
						selectVariable(filteredVariables[selectedIndex].variable);
						return true;
					}
					break;

				case 'Escape':
					e.preventDefault();
					closeAutocomplete();
					return true;
			}

			return false;
		},
		[autocompleteState, selectVariable, closeAutocomplete]
	);

	// Handle text change
	const handleChange = useCallback(
		(e: React.ChangeEvent<HTMLTextAreaElement>) => {
			const textarea = e.target;
			const newValue = textarea.value;
			const cursorPos = textarea.selectionStart;

			onChange(newValue);

			// Check if we should open/update autocomplete
			if (autocompleteState.isOpen && triggerPositionRef.current !== null) {
				// Update search text based on what's typed after "{{"
				const textAfterTrigger = newValue.substring(triggerPositionRef.current + 2, cursorPos);

				// Close if user deleted back past the trigger or typed "}}"
				if (cursorPos <= triggerPositionRef.current + 1 || textAfterTrigger.includes('}}')) {
					closeAutocomplete();
					return;
				}

				const filtered = filterVariables(textAfterTrigger);
				setAutocompleteState((prev) => ({
					...prev,
					searchText: textAfterTrigger,
					filteredVariables: filtered,
					selectedIndex: Math.min(prev.selectedIndex, Math.max(0, filtered.length - 1)),
				}));
			} else {
				// Check if user just typed "{{"
				const textBeforeCursor = newValue.substring(0, cursorPos);
				if (textBeforeCursor.endsWith('{{')) {
					openAutocomplete(textarea, cursorPos);
				}
			}
		},
		[autocompleteState.isOpen, onChange, filterVariables, openAutocomplete, closeAutocomplete]
	);

	// Scroll selected item into view
	useEffect(() => {
		if (autocompleteState.isOpen && autocompleteRef.current) {
			const selectedElement = autocompleteRef.current.querySelector(
				`[data-index="${autocompleteState.selectedIndex}"]`
			);
			if (selectedElement) {
				selectedElement.scrollIntoView({ block: 'nearest' });
			}
		}
	}, [autocompleteState.selectedIndex, autocompleteState.isOpen]);

	// Close on click outside (uses multiple refs to exclude both dropdown and textarea)
	useClickOutside(
		[autocompleteRef, textareaRef] as React.RefObject<HTMLElement | null>[],
		closeAutocomplete,
		autocompleteState.isOpen
	);

	return {
		autocompleteState,
		handleKeyDown,
		handleChange,
		selectVariable,
		closeAutocomplete,
		autocompleteRef,
	};
}
