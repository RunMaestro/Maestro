import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import type { WizardSessionSshRemoteConfig } from '../../../WizardContext';
import { logger } from '../../../../../utils/logger';
import { checkForExistingAutoRunDocs } from '../utils/existingDocs';
import { getWizardSshRemoteId } from '../utils/sshRemote';

interface UseDirectoryValidationParams {
	existingDocsChoice: 'continue' | 'fresh' | null;
	sessionSshRemoteConfig: WizardSessionSshRemoteConfig | undefined;
	setDirectoryPath: (path: string) => void;
	setIsGitRepo: (isGitRepo: boolean) => void;
	setDirectoryError: (error: string | null) => void;
	setHasExistingAutoRunDocs: (hasExisting: boolean, count: number) => void;
	setInitRepoError: (error: string | null) => void;
	announce: (message: string) => void;
}

export function useDirectoryValidation({
	existingDocsChoice,
	sessionSshRemoteConfig,
	setDirectoryPath,
	setIsGitRepo,
	setDirectoryError,
	setHasExistingAutoRunDocs,
	setInitRepoError,
	announce,
}: UseDirectoryValidationParams) {
	const [isValidating, setIsValidating] = useState(false);
	const validationTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const validationRequestIdRef = useRef(0);

	const getSshRemoteId = useCallback(
		() => getWizardSshRemoteId(sessionSshRemoteConfig),
		[sessionSshRemoteConfig]
	);

	const validateDirectory = useCallback(
		async (
			path: string,
			shouldAnnounce: boolean = true,
			skipExistingDocsCheck: boolean = false
		) => {
			const requestId = ++validationRequestIdRef.current;
			const isCurrentRequest = () => validationRequestIdRef.current === requestId;

			if (!path.trim()) {
				setDirectoryError(null);
				setIsGitRepo(false);
				setHasExistingAutoRunDocs(false, 0);
				setIsValidating(false);
				return;
			}

			setIsValidating(true);
			setDirectoryError(null);

			try {
				const sshRemoteId = getSshRemoteId();
				try {
					await window.maestro.fs.readDir(path, sshRemoteId);
				} catch (dirError) {
					if (!isCurrentRequest()) return;
					logger.error('Directory does not exist:', undefined, dirError);
					setDirectoryError('Directory not found. Please check the path exists.');
					setIsGitRepo(false);
					setHasExistingAutoRunDocs(false, 0);

					if (shouldAnnounce) {
						announce('Error: Directory not found. Please check the path exists.');
					}
					return;
				}
				if (!isCurrentRequest()) return;

				const isRepo = await window.maestro.git.isRepo(path, sshRemoteId);
				if (!isCurrentRequest()) return;
				setIsGitRepo(isRepo);
				setDirectoryError(null);

				if (!skipExistingDocsCheck && !existingDocsChoice) {
					const existingDocs = await checkForExistingAutoRunDocs(path, sshRemoteId);
					if (!isCurrentRequest()) return;
					setHasExistingAutoRunDocs(existingDocs.exists, existingDocs.count);
				}

				if (shouldAnnounce) {
					announce(
						isRepo
							? 'Directory validated. Git repository detected.'
							: 'Directory validated. Not a Git repository.'
					);
				}
			} catch (error) {
				if (!isCurrentRequest()) return;
				logger.error('Directory validation error:', undefined, error);
				setDirectoryError('Unable to access this directory. Please check the path exists.');
				setIsGitRepo(false);
				setHasExistingAutoRunDocs(false, 0);

				if (shouldAnnounce) {
					announce('Error: Unable to access this directory. Please check the path exists.');
				}
			} finally {
				if (isCurrentRequest()) {
					setIsValidating(false);
				}
			}
		},
		[
			announce,
			existingDocsChoice,
			getSshRemoteId,
			setDirectoryError,
			setHasExistingAutoRunDocs,
			setIsGitRepo,
		]
	);

	const handlePathChange = useCallback(
		(e: ChangeEvent<HTMLInputElement>) => {
			const newPath = e.target.value;
			validationRequestIdRef.current += 1;
			setDirectoryPath(newPath);

			if (validationTimeoutRef.current) {
				clearTimeout(validationTimeoutRef.current);
				validationTimeoutRef.current = null;
			}

			if (newPath.trim()) {
				setIsValidating(true);
				setInitRepoError(null);
				validationTimeoutRef.current = setTimeout(() => {
					validateDirectory(newPath);
					validationTimeoutRef.current = null;
				}, 800);
			} else {
				setIsValidating(false);
				setDirectoryError(null);
				setIsGitRepo(false);
				setHasExistingAutoRunDocs(false, 0);
			}
		},
		[
			setDirectoryPath,
			setDirectoryError,
			setIsGitRepo,
			setHasExistingAutoRunDocs,
			setInitRepoError,
			validateDirectory,
		]
	);

	useEffect(() => {
		return () => {
			validationRequestIdRef.current += 1;
			if (validationTimeoutRef.current) {
				clearTimeout(validationTimeoutRef.current);
			}
		};
	}, []);

	return {
		isValidating,
		setIsValidating,
		getSshRemoteId,
		validateDirectory,
		handlePathChange,
	};
}
