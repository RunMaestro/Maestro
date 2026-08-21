/**
 * usePromptComposerState Hook
 *
 * Extracted from BatchRunnerModal.tsx to manage the agent prompt: its text,
 * the saved/default comparison flags, the template-variables panel, the
 * composer overlay, and focus-on-mount.
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { DEFAULT_BATCH_PROMPT } from './batchUtils';

export interface UsePromptComposerStateDeps {
	initialPrompt?: string;
	showConfirmation: (message: string, onConfirm: () => void) => void;
	onSave: (prompt: string) => void;
}

export interface UsePromptComposerStateReturn {
	prompt: string;
	setPrompt: React.Dispatch<React.SetStateAction<string>>;
	variablesExpanded: boolean;
	setVariablesExpanded: React.Dispatch<React.SetStateAction<boolean>>;
	savedPrompt: string;
	setSavedPrompt: React.Dispatch<React.SetStateAction<string>>;
	promptComposerOpen: boolean;
	setPromptComposerOpen: React.Dispatch<React.SetStateAction<boolean>>;
	textareaRef: React.RefObject<HTMLTextAreaElement>;
	/** Tracks the prompt at the time the modal opened / was last saved, for dirty-checking. */
	initialPromptRef: React.MutableRefObject<string>;
	handleReset: () => void;
	handleSave: () => void;
	isModified: boolean;
	hasUnsavedChanges: boolean;
}

export function usePromptComposerState({
	initialPrompt,
	showConfirmation,
	onSave,
}: UsePromptComposerStateDeps): UsePromptComposerStateReturn {
	const [prompt, setPrompt] = useState(initialPrompt || DEFAULT_BATCH_PROMPT);
	const [variablesExpanded, setVariablesExpanded] = useState(false);
	const [savedPrompt, setSavedPrompt] = useState(initialPrompt || '');
	const [promptComposerOpen, setPromptComposerOpen] = useState(false);
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	// Track initial prompt for dirty checking
	const initialPromptRef = useRef(initialPrompt || DEFAULT_BATCH_PROMPT);

	// Focus textarea on mount
	useEffect(() => {
		setTimeout(() => textareaRef.current?.focus(), 100);
	}, []);

	const handleReset = useCallback(() => {
		showConfirmation('Reset the prompt to the default? Your customizations will be lost.', () => {
			setPrompt(DEFAULT_BATCH_PROMPT);
		});
	}, [showConfirmation]);

	const handleSave = useCallback(() => {
		onSave(prompt);
		setSavedPrompt(prompt);
		// Update initial ref so hasUnsavedConfigChanges doesn't flag a saved prompt as dirty
		initialPromptRef.current = prompt;
	}, [onSave, prompt]);

	const isModified = prompt !== DEFAULT_BATCH_PROMPT;
	const hasUnsavedChanges = prompt !== savedPrompt && prompt !== DEFAULT_BATCH_PROMPT;

	return {
		prompt,
		setPrompt,
		variablesExpanded,
		setVariablesExpanded,
		savedPrompt,
		setSavedPrompt,
		promptComposerOpen,
		setPromptComposerOpen,
		textareaRef,
		initialPromptRef,
		handleReset,
		handleSave,
		isModified,
		hasUnsavedChanges,
	};
}
