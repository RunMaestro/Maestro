import { useCallback } from 'react';
import type { ExistingDocument } from '../../../utils/existingDocsDetector';
import type { InlineGeneratedDocument, SetInlineWizardTabState } from './types';

interface UseInlineWizardSimpleActionsParams {
	getEffectiveTabId: () => string;
	setTabState: SetInlineWizardTabState;
}

export function clampConfidence(value: number): number {
	return Math.max(0, Math.min(100, value));
}

export function useInlineWizardSimpleActions({
	getEffectiveTabId,
	setTabState,
}: UseInlineWizardSimpleActionsParams) {
	const setConfidence = useCallback(
		(value: number) => {
			const tabId = getEffectiveTabId();
			setTabState(tabId, (prev) => ({
				...prev,
				confidence: clampConfidence(value),
			}));
		},
		[getEffectiveTabId, setTabState]
	);

	const setGoal = useCallback(
		(goal: string | null) => {
			const tabId = getEffectiveTabId();
			setTabState(tabId, (prev) => ({
				...prev,
				goal,
			}));
		},
		[getEffectiveTabId, setTabState]
	);

	const setGeneratingDocs = useCallback(
		(generating: boolean) => {
			const tabId = getEffectiveTabId();
			setTabState(tabId, (prev) => ({
				...prev,
				isGeneratingDocs: generating,
				docGenerationStartedAt: generating
					? (prev.docGenerationStartedAt ?? Date.now())
					: prev.docGenerationStartedAt,
			}));
		},
		[getEffectiveTabId, setTabState]
	);

	const setGeneratedDocuments = useCallback(
		(docs: InlineGeneratedDocument[]) => {
			const tabId = getEffectiveTabId();
			setTabState(tabId, (prev) => ({
				...prev,
				generatedDocuments: docs,
				isGeneratingDocs: false,
			}));
		},
		[getEffectiveTabId, setTabState]
	);

	const setExistingDocuments = useCallback(
		(docs: ExistingDocument[]) => {
			const tabId = getEffectiveTabId();
			setTabState(tabId, (prev) => ({
				...prev,
				existingDocuments: docs,
			}));
		},
		[getEffectiveTabId, setTabState]
	);

	const setError = useCallback(
		(error: string | null) => {
			const tabId = getEffectiveTabId();
			setTabState(tabId, (prev) => ({
				...prev,
				error,
			}));
		},
		[getEffectiveTabId, setTabState]
	);

	const clearError = useCallback(() => {
		const tabId = getEffectiveTabId();
		setTabState(tabId, (prev) => ({
			...prev,
			error: null,
		}));
	}, [getEffectiveTabId, setTabState]);

	return {
		setConfidence,
		setGoal,
		setGeneratingDocs,
		setGeneratedDocuments,
		setExistingDocuments,
		setError,
		clearError,
	};
}
