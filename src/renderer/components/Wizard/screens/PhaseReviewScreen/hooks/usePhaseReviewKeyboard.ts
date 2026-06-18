import { useCallback, type KeyboardEvent, type RefObject } from 'react';
import { useEventListener } from '../../../../../hooks/utils/useEventListener';
import type { GeneratedDocument } from '../../../WizardContext';

export function usePhaseReviewKeyboard({
	mode,
	generatedDocuments,
	currentDocumentIndex,
	isDropdownOpen,
	setIsDropdownOpen,
	handleModeChange,
	handleDocumentSelect,
	readyButtonRef,
	tourButtonRef,
	launchingButton,
	handleLaunch,
}: {
	mode: 'edit' | 'preview';
	generatedDocuments: GeneratedDocument[];
	currentDocumentIndex: number;
	isDropdownOpen: boolean;
	setIsDropdownOpen: (isOpen: boolean) => void;
	handleModeChange: (mode: 'edit' | 'preview') => void;
	handleDocumentSelect: (index: number) => void;
	readyButtonRef: RefObject<HTMLButtonElement | null>;
	tourButtonRef: RefObject<HTMLButtonElement | null>;
	launchingButton: 'ready' | 'tour' | null;
	handleLaunch: (wantsTour: boolean) => void;
}) {
	useEventListener('keydown', (event) => {
		const e = event as globalThis.KeyboardEvent;

		if (e.key === 'Escape' && isDropdownOpen) {
			e.preventDefault();
			e.stopPropagation();
			setIsDropdownOpen(false);
			return;
		}

		if ((e.metaKey || e.ctrlKey) && e.key === 'e' && !e.shiftKey) {
			e.preventDefault();
			e.stopPropagation();
			handleModeChange(mode === 'edit' ? 'preview' : 'edit');
			return;
		}

		if ((e.metaKey || e.ctrlKey) && e.shiftKey && generatedDocuments.length > 1) {
			if (e.key === '[') {
				e.preventDefault();
				e.stopPropagation();
				const newIndex =
					currentDocumentIndex === 0 ? generatedDocuments.length - 1 : currentDocumentIndex - 1;
				handleDocumentSelect(newIndex);
				return;
			}
			if (e.key === ']') {
				e.preventDefault();
				e.stopPropagation();
				const newIndex = (currentDocumentIndex + 1) % generatedDocuments.length;
				handleDocumentSelect(newIndex);
			}
		}
	});

	return useCallback(
		(e: KeyboardEvent) => {
			if (e.key === 'Tab') {
				const focusedElement = document.activeElement;
				if (focusedElement === readyButtonRef.current && !e.shiftKey) {
					e.preventDefault();
					tourButtonRef.current?.focus();
				} else if (focusedElement === tourButtonRef.current && e.shiftKey) {
					e.preventDefault();
					readyButtonRef.current?.focus();
				}
			}

			if (e.key === 'Enter' && !launchingButton) {
				const focusedElement = document.activeElement;
				if (focusedElement === readyButtonRef.current) {
					e.preventDefault();
					e.stopPropagation();
					handleLaunch(false);
				} else if (focusedElement === tourButtonRef.current) {
					e.preventDefault();
					e.stopPropagation();
					handleLaunch(true);
				}
			}
		},
		[handleLaunch, launchingButton, readyButtonRef, tourButtonRef]
	);
}
