import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import {
	extractDisplayTextFromChunk,
	generateInlineDocuments,
	type DocumentGenerationCallbacks,
} from '../../../services/inlineWizardDocumentGeneration';
import { logger } from '../../../utils/logger';
import { resolveAutoRunFolderPath } from './documents';
import type { GenerationProgress, InlineWizardState, SetInlineWizardTabState } from './types';
import type { ToolType } from '../../../types';

interface UseInlineWizardGenerationActionsParams {
	currentTabId: string | null;
	setCurrentTabId: Dispatch<SetStateAction<string | null>>;
	tabStatesRef: MutableRefObject<Map<string, InlineWizardState>>;
	setTabState: SetInlineWizardTabState;
}

export function parseGenerationProgress(message: string): GenerationProgress | null {
	const progressMatch = message.match(/(\d+)\s+(?:of|\/)\s+(\d+)/);
	if (!progressMatch) return null;

	return {
		current: parseInt(progressMatch[1], 10),
		total: parseInt(progressMatch[2], 10),
	};
}

export function getProjectNameForGeneration(state: InlineWizardState): string {
	return state.extractedProjectName?.trim() || state.sessionName || 'Project';
}

export function useInlineWizardGenerationActions({
	currentTabId,
	setCurrentTabId,
	tabStatesRef,
	setTabState,
}: UseInlineWizardGenerationActionsParams) {
	const generateDocuments = useCallback(
		async (callbacks?: DocumentGenerationCallbacks, explicitTabId?: string): Promise<void> => {
			const tabId = explicitTabId || currentTabId || 'default';
			const currentState = tabStatesRef.current.get(tabId);

			logger.info('Starting Playbook document generation', '[InlineWizard]', {
				tabId,
				agentType: currentState?.agentType,
				mode: currentState?.mode,
				conversationLength: currentState?.conversationHistory?.length || 0,
			});

			if (tabId !== currentTabId) {
				setCurrentTabId(tabId);
			}

			const effectiveAutoRunFolderPath = resolveAutoRunFolderPath(
				currentState?.projectPath || undefined,
				currentState?.autoRunFolderPath || undefined
			);

			if (!currentState?.agentType || !effectiveAutoRunFolderPath) {
				const errorMsg = 'Cannot generate documents: missing agent type or Auto Run folder path';
				logger.error('[useInlineWizard]', undefined, errorMsg);
				setTabState(tabId, (prev) => ({ ...prev, error: errorMsg }));
				callbacks?.onError?.(errorMsg);
				return;
			}

			setTabState(tabId, (prev) => ({
				...prev,
				isGeneratingDocs: true,
				docGenerationStartedAt: Date.now(),
				generatedDocuments: [],
				error: null,
				streamingContent: '',
				generationProgress: null,
				currentDocumentIndex: 0,
			}));

			try {
				const projectNameForGeneration = getProjectNameForGeneration(currentState);
				const result = await generateInlineDocuments({
					agentType: currentState.agentType,
					directoryPath: currentState.projectPath || effectiveAutoRunFolderPath,
					projectName: projectNameForGeneration,
					conversationHistory: currentState.conversationHistory,
					existingDocuments: currentState.existingDocuments,
					mode: currentState.mode === 'iterate' ? 'iterate' : 'new',
					goal: currentState.goal || undefined,
					autoRunFolderPath: effectiveAutoRunFolderPath,
					sessionId: currentState.sessionId || undefined,
					sessionSshRemoteConfig: currentState.sessionSshRemoteConfig,
					sessionCustomPath: currentState.sessionCustomPath,
					sessionCustomArgs: currentState.sessionCustomArgs,
					sessionCustomEnvVars: currentState.sessionCustomEnvVars,
					sessionCustomModel: currentState.sessionCustomModel,
					conductorProfile: currentState.conductorProfile,
					callbacks: {
						onStart: () => {
							logger.info('[useInlineWizard] Document generation started');
							callbacks?.onStart?.();
						},
						onProgress: (message) => {
							logger.info('[useInlineWizard] Progress:', undefined, message);
							const progress = parseGenerationProgress(message);
							if (progress) {
								setTabState(tabId, (prev) => ({
									...prev,
									generationProgress: progress,
								}));
							}
							callbacks?.onProgress?.(message);
						},
						onChunk: (chunk) => {
							const displayText = extractDisplayTextFromChunk(
								chunk,
								currentState.agentType as ToolType
							);

							if (displayText) {
								setTabState(tabId, (prev) => ({
									...prev,
									streamingContent: prev.streamingContent + displayText,
								}));
							}
							callbacks?.onChunk?.(chunk);
						},
						onDocumentComplete: (doc) => {
							logger.info('[useInlineWizard] Document saved:', undefined, doc.filename);
							setTabState(tabId, (prev) => {
								const newDocs = [...prev.generatedDocuments, doc];
								const newTotal = prev.generationProgress?.total || newDocs.length;
								return {
									...prev,
									generatedDocuments: newDocs,
									currentDocumentIndex: newDocs.length - 1,
									generationProgress: {
										current: newDocs.length,
										total: newTotal,
									},
								};
							});
							callbacks?.onDocumentComplete?.(doc);
						},
						onComplete: (allDocs) => {
							logger.info('[useInlineWizard] All documents complete:', undefined, allDocs.length);
							setTabState(tabId, (prev) => ({
								...prev,
								isGeneratingDocs: false,
								generatedDocuments: allDocs,
								generationProgress: {
									current: allDocs.length,
									total: allDocs.length,
								},
							}));
							callbacks?.onComplete?.(allDocs);
						},
						onError: (error) => {
							logger.error('[useInlineWizard] Generation error:', undefined, error);
							callbacks?.onError?.(error);
						},
					},
				});

				if (result.success) {
					const finalDocs = result.documents || [];
					setTabState(tabId, (prev) => ({
						...prev,
						isGeneratingDocs: false,
						generatedDocuments: finalDocs,
						generationProgress: {
							current: finalDocs.length,
							total: finalDocs.length,
						},
						subfolderName: result.subfolderName || null,
						subfolderPath: result.subfolderPath || null,
					}));

					logger.info(
						`Playbook generation complete - ${finalDocs.length} document(s) created`,
						'[InlineWizard]',
						{
							documentCount: finalDocs.length,
							subfolderName: result.subfolderName,
							filenames: finalDocs.map((d) => d.filename),
						}
					);
				} else {
					setTabState(tabId, (prev) => ({
						...prev,
						isGeneratingDocs: false,
						error: result.error || 'Document generation failed',
						streamingContent: '',
						generationProgress: null,
					}));
				}
			} catch (error) {
				const errorMessage =
					error instanceof Error ? error.message : 'Unknown error during document generation';
				logger.error('[useInlineWizard] generateDocuments error:', undefined, error);

				setTabState(tabId, (prev) => ({
					...prev,
					isGeneratingDocs: false,
					error: errorMessage,
					streamingContent: '',
					generationProgress: null,
				}));

				callbacks?.onError?.(errorMessage);
			}
		},
		[currentTabId, setCurrentTabId, setTabState, tabStatesRef]
	);

	return {
		generateDocuments,
	};
}
