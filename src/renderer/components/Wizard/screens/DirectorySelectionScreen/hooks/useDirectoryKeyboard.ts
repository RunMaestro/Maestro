import { useCallback, type KeyboardEvent, type RefObject } from 'react';

interface UseDirectoryKeyboardParams {
	browseButtonRef: RefObject<HTMLButtonElement | null>;
	isBrowsing: boolean;
	isValidating: boolean;
	canProceedToNext: () => boolean;
	handleBrowse: () => void;
	attemptNextStep: () => void;
	previousStep: () => void;
}

export function useDirectoryKeyboard({
	browseButtonRef,
	isBrowsing,
	isValidating,
	canProceedToNext,
	handleBrowse,
	attemptNextStep,
	previousStep,
}: UseDirectoryKeyboardParams) {
	return useCallback(
		(e: KeyboardEvent) => {
			// An open dropdown on this screen (the peer picker) owns its own Enter
			// and Escape: they choose an option and close the menu. Without this,
			// the same keystroke also continues the wizard or steps it back.
			if ((e.target as Element | null)?.closest?.('[role="listbox"]')) return;

			switch (e.key) {
				case 'Enter':
					if (document.activeElement === browseButtonRef.current) {
						e.preventDefault();
						if (!isBrowsing) {
							handleBrowse();
						}
						return;
					}
					e.preventDefault();
					if (canProceedToNext() && !isValidating) {
						attemptNextStep();
					}
					break;
				case 'Escape':
					e.preventDefault();
					previousStep();
					break;
			}
		},
		[
			attemptNextStep,
			browseButtonRef,
			canProceedToNext,
			handleBrowse,
			isBrowsing,
			isValidating,
			previousStep,
		]
	);
}
