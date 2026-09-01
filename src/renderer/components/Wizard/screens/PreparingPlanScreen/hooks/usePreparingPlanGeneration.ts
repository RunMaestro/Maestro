import { useCallback, useEffect, useRef, useState } from 'react';
import type { WizardState, GeneratedDocument } from '../../../WizardContext';
import { deriveSshRemoteId, phaseGenerator } from '../../../services/phaseGenerator';
import type { CreatedFileInfo } from '../types';
import { upsertCreatedFile } from '../utils/createdFiles';
import { logger } from '../../../../../utils/logger';
import { captureException, captureMessage } from '../../../../../utils/sentry';

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
		async (documents: GeneratedDocument[], documentsFromDisk?: boolean) => {
			if (documentsFromDisk) {
				logger.info('[PreparingPlanScreen] Documents already on disk, skipping save');
				setGeneratedDocuments(documents);
				setGeneratingDocuments(false);
				const taskCount = documents[0]?.taskCount || 0;
				announce(`Playbooks created successfully with ${taskCount} tasks. Proceeding to review.`);
				setTimeout(() => nextStep(), 500);
				return;
			}

			setProgressMessage('Saving documents...');
			const sshRemoteId = deriveSshRemoteId(state.sessionSshRemoteConfig);
			const saveResult = await phaseGenerator.saveDocuments(
				state.directoryPath,
				documents,
				addCreatedFile,
				'Initiation',
				sshRemoteId
			);

			if (saveResult.success) {
				setGeneratedDocuments(documents);
				setGeneratingDocuments(false);
				const taskCount = documents[0]?.taskCount || 0;
				announce(`Playbooks created successfully with ${taskCount} tasks. Proceeding to review.`);
				setTimeout(() => nextStep(), 500);
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
					projectName: state.agentName || 'My Project',
					conversationHistory: state.conversationHistory,
					subfolder: 'Initiation',
					sshRemoteConfig: state.sessionSshRemoteConfig,
					customPath: state.customPath,
					customArgs: state.customArgs,
					customEnvVars: state.customEnvVars,
					agentConfigValues: state.agentConfigValues,
				},
				{
					onStart: () => {
						setProgressMessage('Starting document generation...');
					},
					onProgress: (message) => {
						setProgressMessage(message);
					},
					onChunk: () => {},
					onFileCreated: addCreatedFile,
					onActivity: () => {},
					onComplete: async (genResult) => {
						if (genResult.success && genResult.documents) {
							await handleGenerationSuccess(genResult.documents, genResult.documentsFromDisk);
						}
					},
					onError: (error) => {
						setGenerationError(error);
						setGeneratingDocuments(false);
						announce(`Error generating Playbooks: ${error}. You can try again or go back.`);
					},
				}
			);

			if (!result.success && result.error) {
				setGenerationError(result.error);
				setGeneratingDocuments(false);
			}
		} catch (error) {
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
		state.agentName,
		state.conversationHistory,
		state.sessionSshRemoteConfig,
		state.customPath,
		state.customArgs,
		state.customEnvVars,
		state.agentConfigValues,
	]);

	const handleRetry = useCallback(() => {
		setGenerationError(null);
		generationStartedRef.current = false;
		startGeneration();
	}, [setGenerationError, startGeneration]);

	const handleGoBack = useCallback(() => {
		setGenerationError(null);
		previousStep();
	}, [previousStep, setGenerationError]);

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
