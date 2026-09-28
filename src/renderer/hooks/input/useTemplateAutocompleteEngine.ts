/**
 * The `{{` template-variable autocomplete, minus the text surface.
 *
 * Two editors offer this popup and they share nothing at the DOM level: a plain
 * `<textarea>` (Auto Run, the command panels, the prompt composers) and the
 * CodeMirror `MarkdownEditor` (Maestro Prompts). Everything ABOVE the DOM is
 * identical though - when to open, what the query is, which key does what, and
 * what text replaces what - so that half lives here and each surface supplies a
 * small `TemplateAutocompleteTarget` binding.
 *
 * Do NOT hand-roll a second `{{`-detector against a new editor. Write a target
 * for it: three methods, all of them about caret positions.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { TEMPLATE_VARIABLES } from '../../utils/templateVariables';

export interface AutocompleteState {
	isOpen: boolean;
	position: { top: number; left: number };
	selectedIndex: number;
	searchText: string;
	filteredVariables: typeof TEMPLATE_VARIABLES;
}

/** The editor-specific half: how to read the caret and how to write text. */
export interface TemplateAutocompleteTarget {
	/** Character offset of the cursor right now. */
	getCaret(): number;
	/**
	 * Where to draw the popup for a caret at `caret`, in the coordinate space of
	 * the dropdown's positioned ancestor.
	 */
	getCaretPosition(caret: number): { top: number; left: number };
	/** Replace [from, to) with `text`, leaving the caret after the insert. */
	replaceRange(from: number, to: number, text: string): void;
}

export interface TemplateAutocompleteEngine {
	autocompleteState: AutocompleteState;
	autocompleteRef: React.RefObject<HTMLDivElement>;
	/**
	 * Report the document after an edit. `caret` is the offset AFTER the change,
	 * which is what decides whether the user just typed `{{`, refined the query,
	 * or backed out past the trigger.
	 */
	syncToInput: (value: string, caret: number) => void;
	/** Returns true when the popup consumed the key. */
	handleKey: (key: string, preventDefault: () => void) => boolean;
	selectVariable: (variable: string) => void;
	closeAutocomplete: () => void;
}

export const INITIAL_AUTOCOMPLETE_STATE: AutocompleteState = {
	isOpen: false,
	position: { top: 0, left: 0 },
	selectedIndex: 0,
	searchText: '',
	filteredVariables: TEMPLATE_VARIABLES,
};

function filterVariables(searchText: string): typeof TEMPLATE_VARIABLES {
	if (!searchText) return TEMPLATE_VARIABLES;
	const search = searchText.toLowerCase();
	return TEMPLATE_VARIABLES.filter(
		(v) => v.variable.toLowerCase().includes(search) || v.description.toLowerCase().includes(search)
	);
}

export function useTemplateAutocompleteEngine(
	target: TemplateAutocompleteTarget
): TemplateAutocompleteEngine {
	const [autocompleteState, setAutocompleteState] = useState<AutocompleteState>(
		INITIAL_AUTOCOMPLETE_STATE
	);
	const autocompleteRef = useRef<HTMLDivElement>(null);
	// Offset of the `{` that opened the popup, so a selection knows how much of
	// what the user typed to swallow.
	const triggerPositionRef = useRef<number | null>(null);

	// The target is rebuilt on every render by its host (it closes over live
	// state), so it is read through a ref rather than listed as a dependency -
	// otherwise every callback below would churn identity on each keystroke.
	const targetRef = useRef(target);
	targetRef.current = target;

	const closeAutocomplete = useCallback(() => {
		setAutocompleteState(INITIAL_AUTOCOMPLETE_STATE);
		triggerPositionRef.current = null;
	}, []);

	const selectVariable = useCallback(
		(variable: string) => {
			const triggerPos = triggerPositionRef.current;
			if (triggerPos === null) return;
			targetRef.current.replaceRange(triggerPos, targetRef.current.getCaret(), variable);
			closeAutocomplete();
		},
		[closeAutocomplete]
	);

	const syncToInput = useCallback(
		(value: string, caret: number) => {
			const triggerPos = triggerPositionRef.current;
			if (triggerPos !== null) {
				const textAfterTrigger = value.substring(triggerPos + 2, caret);
				// Backed out past the trigger, or closed the braces by hand.
				if (caret <= triggerPos + 1 || textAfterTrigger.includes('}}')) {
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
				return;
			}
			if (!value.substring(0, caret).endsWith('{{')) return;
			triggerPositionRef.current = caret - 2;
			setAutocompleteState({
				isOpen: true,
				position: targetRef.current.getCaretPosition(caret),
				selectedIndex: 0,
				searchText: '',
				filteredVariables: TEMPLATE_VARIABLES,
			});
		},
		[closeAutocomplete]
	);

	const handleKey = useCallback(
		(key: string, preventDefault: () => void): boolean => {
			if (!autocompleteState.isOpen) return false;
			const { filteredVariables, selectedIndex } = autocompleteState;

			switch (key) {
				case 'ArrowDown':
					preventDefault();
					setAutocompleteState((prev) => ({
						...prev,
						selectedIndex: Math.min(prev.selectedIndex + 1, filteredVariables.length - 1),
					}));
					return true;

				case 'ArrowUp':
					preventDefault();
					setAutocompleteState((prev) => ({
						...prev,
						selectedIndex: Math.max(prev.selectedIndex - 1, 0),
					}));
					return true;

				case 'Enter':
				case 'Tab':
					if (filteredVariables.length > 0) {
						preventDefault();
						selectVariable(filteredVariables[selectedIndex].variable);
						return true;
					}
					break;

				case 'Escape':
					preventDefault();
					closeAutocomplete();
					return true;
			}

			return false;
		},
		[autocompleteState, selectVariable, closeAutocomplete]
	);

	// Keep the highlighted row on screen while the arrows walk the list.
	useEffect(() => {
		if (!autocompleteState.isOpen || !autocompleteRef.current) return;
		const selectedElement = autocompleteRef.current.querySelector(
			`[data-index="${autocompleteState.selectedIndex}"]`
		);
		selectedElement?.scrollIntoView({ block: 'nearest' });
	}, [autocompleteState.selectedIndex, autocompleteState.isOpen]);

	return {
		autocompleteState,
		autocompleteRef,
		syncToInput,
		handleKey,
		selectVariable,
		closeAutocomplete,
	};
}
