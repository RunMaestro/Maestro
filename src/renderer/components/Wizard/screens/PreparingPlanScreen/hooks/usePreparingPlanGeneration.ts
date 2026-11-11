import { useCallback, useEffect, useRef, useState } from 'react';
import type { WizardState, GeneratedDocument } from '../../../WizardContext';
import { deriveSshRemoteId, phaseGenerator } from '../../../services/phaseGenerator';
import type { CreatedFileInfo } from '../types';
import { upsertCreatedFile } from '../utils/createdFiles';
import { logger } from '../../../../../utils/logger';
import { captureException, captureMessage } from '../../../../../utils/sentry';
import { projectNameFromPath } from '../../../shared/projectIdentity';
import { getClaudeTokenSourceFields } from '../../../../../../shared/claudeTokenMode';

interface UsePreparingPlanGenerationParams {
	state: WizardState;
	setGeneratingDocuments: (generating: boolean) => void;
	setGeneratedDocuments: (documents: GeneratedDocument[]) => void;
	setGenerationError: (error: string | null) => void;
	previousStep: () => void;
	nextStep: () => void;
}

export function usePreparingPlanGeneration({
	state,
	setGeneratingDocuments,
	setGeneratedDocuments,
	setGenerationError,
	previousStep,
	nextStep,
}: UsePreparingPlanGenerationParams) {
	const [progressMessage, setProgressMessage] = useState('Generating Auto Run Documents...');
	const [createdFiles, setCreatedFiles] = useState<CreatedFileInfo[]>([]);
	const [generationStartTime, setGenerationStartTime] = useState<number | undefined>(undefined);
	const [announcement, setAnnouncement] = useState('');
	const [announcementKey, setAnnouncementKey] = useState(0);

	const generationStartedRef = useRef(false);
	const requestIdRef = useRef(0);
	const nextStepTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
	const seenFilesRef = useRef<Set<string>>(new Set());

	const announce = useCallback((message: string) => {
		setAnnouncement(message);
		setAnnouncementKey((prev) => prev + 1);
	}, []);

	const addCreatedFile = useCallback((file: CreatedFileInfo) => {
		if (!seenFilesRef.current.has(file.filename)) {
			seenFilesRef.current.add(file.filename);
		}
		setCreatedFiles((prev) => upsertCreatedFile(prev, file));
	}, []);

	const handleGenerationSuccess = useCallback(
		async (
			documents: GeneratedDocument[],
			documentsFromDisk: boolean | undefined,
			requestId: number
		) => {
			if (requestIdRef.current !== requestId) return;
			if (documentsFromDisk) {
				logger.info('[PreparingPlanScreen] Documents already on disk, skipping save');
				setGeneratedDocuments(documents);
				setGeneratingDocuments(false);
				const taskCount = documents[0]?.taskCount || 0;
				announce(`Playbooks created successfully with ${taskCount} tasks. Proceeding to review.`);
				nextStepTimeoutRef.current = setTimeout(() => {
					if (requestIdRef.current === requestId) nextStep();
				}, 500);
				return;
			}

			setProgressMessage('Saving documents...');
			const sshRemoteId = deriveSshRemoteId(state.sessionSshRemoteConfig);
			const saveResult = await phaseGenerator.saveDocuments(
				state.directoryPath,
				documents,
				(file) => {
					if (requestIdRef.current === requestId) addCreatedFile(file);
				},
				'Initiation',
				sshRemoteId
			);
			if (requestIdRef.current !== requestId) return;

			if (saveResult.success) {
				setGeneratedDocuments(documents);
				setGeneratingDocuments(false);
				const taskCount = documents[0]?.taskCount || 0;
				announce(`Playbooks created successfully with ${taskCount} tasks. Proceeding to review.`);
				nextStepTimeoutRef.current = setTimeout(() => {
					if (requestIdRef.current === requestId) nextStep();
				}, 500);
			} else {
				setGenerationError(saveResult.error || 'Failed to save documents');
				setGeneratingDocuments(false);
				announce(`Error: Failed to save documents. ${saveResult.error || ''}`);
			}
		},
		[
			addCreatedFile,
			announce,
			nextStep,
			setGeneratedDocuments,
			setGeneratingDocuments,
			setGenerationError,
			state.directoryPath,
			state.sessionSshRemoteConfig,
		]
	);

	const startGeneration = useCallback(async () => {
		if (phaseGenerator.isGenerationInProgress()) {
			return;
		}

		const requestId = ++requestIdRef.current;
		const isCurrentRequest = () => requestIdRef.current === requestId;
		generationStartedRef.current = true;
		clearTimeout(nextStepTimeoutRef.current);
		setGeneratingDocuments(true);
		setGenerationError(null);
		setProgressMessage('Generating Auto Run Documents...');
		setCreatedFiles([]);
		seenFilesRef.current.clear();
		setGenerationStartTime(Date.now());
		announce('Preparing your Playbooks. This may take a while.');

		try {
			const result = await phaseGenerator.generateDocuments(
				{
					agentType: state.selectedAgent!,
					directoryPath: state.directoryPath,
					projectName: projectNameFromPath(state.directoryPath),
					model: state.plannerModel,
					sessionCustomPath: state.customPath,
					sessionCustomArgs: state.customArgs,
					sessionCustomEnvVars: state.customEnvVars,
					conversationHistory: state.conversationHistory,
					subfolder: 'Initiation',
					sshRemoteConfig: state.sessionSshRemoteConfig,
					claudeTokenSource: getClaudeTokenSourceFields(state),
					harnessControlMode: state.harnessControlMode,
				},
				{
					onStart: () => {
						if (!isCurrentRequest()) return;
						setProgressMessage('Starting document generation...');
					},
					onProgress: (message) => {
						if (!isCurrentRequest()) return;
						setProgressMessage(message);
					},
					onChunk: () => {},
					onFileCreated: (file) => {
						if (isCurrentRequest()) addCreatedFile(file);
					},
					onActivity: () => {},
					onComplete: async (genResult) => {
						if (!isCurrentRequest()) return;
						if (genResult.success && genResult.documents) {
							await handleGenerationSuccess(
								genResult.documents,
								genResult.documentsFromDisk,
								requestId
							);
						}
					},
					onError: (error) => {
						if (!isCurrentRequest()) return;
						setGenerationError(error);
						setGeneratingDocuments(false);
						announce(`Error generating Playbooks: ${error}. You can try again or go back.`);
					},
				}
			);

			if (!isCurrentRequest()) return;
			if (!result.success && result.error) {
				setGenerationError(result.error);
				setGeneratingDocuments(false);
			}
		} catch (error) {
			if (!isCurrentRequest()) return;
			const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
			setGenerationError(errorMessage);
			setGeneratingDocuments(false);
			if (error instanceof Error) {
				captureException(error, {
					extra: {
						context: 'usePreparingPlanGeneration.startGeneration',
						agentType: state.selectedAgent,
						directoryPath: state.directoryPath,
					},
				});
				throw error;
			}

			captureMessage('Preparing plan generation failed with a non-Error value', {
				level: 'error',
				extra: {
					context: 'usePreparingPlanGeneration.startGeneration',
					agentType: state.selectedAgent,
					directoryPath: state.directoryPath,
					error: String(error),
				},
			});
			throw new Error(errorMessage);
		}
	}, [
		addCreatedFile,
		announce,
		handleGenerationSuccess,
		setGeneratingDocuments,
		setGenerationError,
		state.selectedAgent,
		state.directoryPath,
		state.plannerModel,
		state.customPath,
		state.customArgs,
		state.customEnvVars,
		state.enableMaestroP,
		state.maestroPMode,
		state.maestroPPath,
		state.conversationHistory,
		state.sessionSshRemoteConfig,
	]);

	const handleRetry = useCallback(() => {
		setGenerationError(null);
		generationStartedRef.current = false;
		startGeneration();
	}, [setGenerationError, startGeneration]);

	const handleGoBack = useCallback(() => {
		requestIdRef.current += 1;
		clearTimeout(nextStepTimeoutRef.current);
		phaseGenerator.abort();
		setGeneratingDocuments(false);
		setGenerationError(null);
		previousStep();
	}, [previousStep, setGeneratingDocuments, setGenerationError]);

	useEffect(() => {
		if (!generationStartedRef.current && state.generatedDocuments.length === 0) {
			generationStartedRef.current = true;
			startGeneration();
		} else if (state.generatedDocuments.length > 0) {
			nextStep();
		}
	}, [nextStep, startGeneration, state.generatedDocuments.length]);

	useEffect(() => {
		return () => {
			generationStartedRef.current = false;
			requestIdRef.current += 1;
			clearTimeout(nextStepTimeoutRef.current);
			phaseGenerator.abort();
		};
	}, []);

	return {
		progressMessage,
		createdFiles,
		generationStartTime,
		announcement,
		announcementKey,
		startGeneration,
		handleRetry,
		handleGoBack,
	};
}
