import { useCallback, useState } from 'react';
import { PLAYBOOKS_DIR } from '../../../../../../shared/maestro-paths';
import { gitService } from '../../../../../services/git';
import { logger } from '../../../../../utils/logger';
import { captureException } from '../../../../../utils/sentry';
import { isRecoverableAutoRunDocsError } from '../utils/existingDocs';

interface UseDirectoryActionsParams {
	directoryPath: string;
	existingDocsChoice: 'continue' | 'fresh' | null;
	isValidating: boolean;
	canProceedToNext: () => boolean;
	nextStep: () => void;
	setDirectoryPath: (path: string) => void;
	setIsGitRepo: (isGitRepo: boolean) => void;
	setDirectoryError: (error: string | null) => void;
	setHasExistingAutoRunDocs: (hasExisting: boolean, count: number) => void;
	setExistingDocsChoice: (choice: 'continue' | 'fresh' | null) => void;
	setInitRepoError: (error: string | null) => void;
	getSshRemoteId: () => string | undefined;
	validateDirectory: (path: string) => Promise<void>;
	focusInput: () => void;
	focusContinue: () => void;
	announce: (message: string) => void;
}

export function useDirectoryActions({
	directoryPath,
	existingDocsChoice,
	isValidating,
	canProceedToNext,
	nextStep,
	setDirectoryPath,
	setIsGitRepo,
	setDirectoryError,
	setHasExistingAutoRunDocs,
	setExistingDocsChoice,
	setInitRepoError,
	getSshRemoteId,
	validateDirectory,
	focusInput,
	focusContinue,
	announce,
}: UseDirectoryActionsParams) {
	const [isBrowsing, setIsBrowsing] = useState(false);
	const [showExistingDocsModal, setShowExistingDocsModal] = useState(false);
	const [isInitializingRepo, setIsInitializingRepo] = useState(false);

	const handleBrowse = useCallback(async () => {
		setIsBrowsing(true);

		try {
			const selectedPath = await window.maestro.dialog.selectFolder();
			if (selectedPath) {
				setDirectoryPath(selectedPath);
				await validateDirectory(selectedPath);
				setTimeout(focusContinue, 150);
			}
		} catch (error) {
			logger.error('Browse failed:', undefined, error);
			setDirectoryError('Failed to open folder picker');
		}

		setIsBrowsing(false);
	}, [focusContinue, setDirectoryError, setDirectoryPath, validateDirectory]);

	const handleInitRepo = useCallback(async () => {
		if (!directoryPath.trim() || isInitializingRepo || isValidating) return;

		setIsInitializingRepo(true);
		setInitRepoError(null);
		try {
			const result = await gitService.init(directoryPath, getSshRemoteId());
			if (!result.success) {
				setInitRepoError(result.error || 'Failed to initialize git repository');
				return;
			}
			setIsGitRepo(true);
			announce('Git repository initialized.');
		} finally {
			setIsInitializingRepo(false);
		}
	}, [announce, directoryPath, getSshRemoteId, isInitializingRepo, isValidating, setIsGitRepo]);

	const attemptNextStep = useCallback(async () => {
		if (!canProceedToNext()) return;

		if (existingDocsChoice) {
			nextStep();
			return;
		}

		const autoRunPath = `${directoryPath}/${PLAYBOOKS_DIR}`;
		const sshRemoteId = getSshRemoteId();
		let result: Awaited<ReturnType<typeof window.maestro.autorun.listDocs>>;

		try {
			result = await window.maestro.autorun.listDocs(autoRunPath, sshRemoteId);
		} catch (error) {
			if (isRecoverableAutoRunDocsError(error)) {
				nextStep();
				return;
			}

			setDirectoryError('Unable to check existing Auto Run docs. Please try again.');
			captureException(error, {
				extra: {
					context: 'useDirectoryActions.attemptNextStep',
					directoryPath,
					autoRunPath,
					sshRemoteId,
				},
			});
			throw error;
		}

		if (!result.success) {
			if (isRecoverableAutoRunDocsError(result.error)) {
				nextStep();
				return;
			}

			const error = new Error(`Auto Run docs lookup failed: ${result.error || 'unknown error'}`);
			setDirectoryError('Unable to check existing Auto Run docs. Please try again.');
			captureException(error, {
				extra: {
					context: 'useDirectoryActions.attemptNextStep',
					directoryPath,
					autoRunPath,
					sshRemoteId,
					listDocsError: result.error,
				},
			});
			throw error;
		}

		const docs = result.files;
		if (docs && docs.length > 0) {
			setHasExistingAutoRunDocs(true, docs.length);
			setShowExistingDocsModal(true);
			return;
		}

		nextStep();
	}, [
		canProceedToNext,
		directoryPath,
		existingDocsChoice,
		getSshRemoteId,
		nextStep,
		setDirectoryError,
		setHasExistingAutoRunDocs,
	]);

	const handleStartFresh = useCallback(() => {
		setShowExistingDocsModal(false);
		setExistingDocsChoice('fresh');
		setHasExistingAutoRunDocs(false, 0);
		nextStep();
	}, [nextStep, setExistingDocsChoice, setHasExistingAutoRunDocs]);

	const handleContinueWithDocs = useCallback(() => {
		setShowExistingDocsModal(false);
		setExistingDocsChoice('continue');
		nextStep();
	}, [nextStep, setExistingDocsChoice]);

	const handleModalCancel = useCallback(() => {
		setShowExistingDocsModal(false);
		setDirectoryPath('');
		setHasExistingAutoRunDocs(false, 0);
		focusInput();
	}, [focusInput, setDirectoryPath, setHasExistingAutoRunDocs]);

	const handleContinue = useCallback(() => {
		if (canProceedToNext()) {
			attemptNextStep();
		}
	}, [attemptNextStep, canProceedToNext]);

	return {
		isBrowsing,
		showExistingDocsModal,
		isInitializingRepo,
		handleBrowse,
		handleInitRepo,
		attemptNextStep,
		handleStartFresh,
		handleContinueWithDocs,
		handleModalCancel,
		handleContinue,
	};
}
