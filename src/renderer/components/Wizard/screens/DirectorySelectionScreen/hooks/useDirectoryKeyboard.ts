import { useCallback, type KeyboardEvent, type RefObject } from 'react';
import { isImeComposing } from '../../../../../utils/ime';

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
			switch (e.key) {
				case 'Enter':
					if (document.activeElement === browseButtonRef.current) {
						e.preventDefault();
						if (!isBrowsing) {
							handleBrowse();
						}
						return;
					}
					if (isImeComposing(e)) return;
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
