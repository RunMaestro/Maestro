import { useCallback, useEffect, useRef, useState } from 'react';
import { useWizard } from '../../WizardContext';
import { ScreenReaderAnnouncement } from '../../ScreenReaderAnnouncement';
import { ExistingDocsModal } from '../../ExistingDocsModal';
import { AdditionalDirectoriesSection } from '../../../shared/AdditionalDirectoriesSection';
import {
	DirectoryContinueButton,
	DirectoryKeyboardHints,
	DirectoryPathField,
	DirectorySelectionHeader,
	DirectorySelectionLoading,
	DirectoryStatusPanel,
} from './components';
import {
	useDirectoryActions,
	useDirectoryAgentConfig,
	useDirectoryAnnouncements,
	useDirectoryKeyboard,
	useDirectorySshRemoteHost,
	useDirectoryValidation,
} from './hooks';
import type { DirectorySelectionScreenProps } from './types';
import { getWizardYoloFlag } from './utils/yoloFlag';

export function DirectorySelectionScreen({ theme }: DirectorySelectionScreenProps): JSX.Element {
	const {
		state,
		setDirectoryPath,
		setAdditionalDirectories,
		setIsGitRepo,
		setDirectoryError,
		setHasExistingAutoRunDocs,
		setExistingDocsChoice,
		nextStep,
		previousStep,
		canProceedToNext,
	} = useWizard();

	const [isDetecting, setIsDetecting] = useState(true);
	const [initRepoError, setInitRepoError] = useState<string | null>(null);

	const inputRef = useRef<HTMLInputElement>(null);
	const browseButtonRef = useRef<HTMLButtonElement>(null);
	const continueButtonRef = useRef<HTMLButtonElement>(null);
	const containerRef = useRef<HTMLDivElement>(null);

	const { announcement, announcementKey, announce } = useDirectoryAnnouncements();
	const agentConfig = useDirectoryAgentConfig(state.selectedAgent);
	const sshRemoteHost = useDirectorySshRemoteHost(state.sessionSshRemoteConfig);

	const focusInput = useCallback(() => {
		inputRef.current?.focus();
	}, []);

	const focusContinue = useCallback(() => {
		continueButtonRef.current?.focus();
	}, []);

	const validation = useDirectoryValidation({
		existingDocsChoice: state.existingDocsChoice,
		sessionSshRemoteConfig: state.sessionSshRemoteConfig,
		setDirectoryPath,
		setIsGitRepo,
		setDirectoryError,
		setHasExistingAutoRunDocs,
		setInitRepoError,
		announce,
	});

	const actions = useDirectoryActions({
		directoryPath: state.directoryPath,
		existingDocsChoice: state.existingDocsChoice,
		isValidating: validation.isValidating,
		canProceedToNext,
		nextStep,
		setDirectoryPath,
		setIsGitRepo,
		setDirectoryError,
		setHasExistingAutoRunDocs,
		setExistingDocsChoice,
		setInitRepoError,
		getSshRemoteId: validation.getSshRemoteId,
		validateDirectory: validation.validateDirectory,
		focusInput,
		focusContinue,
		announce,
	});

	const handleKeyDown = useDirectoryKeyboard({
		browseButtonRef,
		isBrowsing: actions.isBrowsing,
		isValidating: validation.isValidating,
		canProceedToNext,
		handleBrowse: actions.handleBrowse,
		attemptNextStep: actions.attemptNextStep,
		previousStep,
	});

	useEffect(() => {
		setIsDetecting(false);
	}, []);

	useEffect(() => {
		if (!isDetecting && inputRef.current) {
			inputRef.current.focus();
		}
	}, [isDetecting]);

	if (isDetecting) {
		return <DirectorySelectionLoading theme={theme} />;
	}

	const isValid = canProceedToNext();
	const showContinue = state.directoryPath.trim() !== '';
	const isRemoteSession = !!state.sessionSshRemoteConfig?.enabled;

	return (
		<div
			ref={containerRef}
			className="flex flex-col flex-1 min-h-0 p-8 overflow-y-auto outline-none"
			onKeyDown={handleKeyDown}
			tabIndex={-1}
		>
			<ScreenReaderAnnouncement
				message={announcement}
				announceKey={announcementKey}
				politeness="polite"
			/>

			<DirectorySelectionHeader
				theme={theme}
				agentName={state.agentName}
				yoloFlag={getWizardYoloFlag(agentConfig)}
			/>

			<div className="flex-1" />

			<div className="flex flex-col items-center">
				<div className="w-full max-w-xl">
					<DirectoryPathField
						theme={theme}
						directoryPath={state.directoryPath}
						directoryError={state.directoryError}
						isRemoteSession={isRemoteSession}
						sshRemoteHost={sshRemoteHost}
						isBrowsing={actions.isBrowsing}
						inputRef={inputRef}
						browseButtonRef={browseButtonRef}
						onPathChange={validation.handlePathChange}
						onBrowse={actions.handleBrowse}
					/>

					<DirectoryStatusPanel
						theme={theme}
						directoryPath={state.directoryPath}
						directoryError={state.directoryError}
						isGitRepo={state.isGitRepo}
						isValidating={validation.isValidating}
						isInitializingRepo={actions.isInitializingRepo}
						initRepoError={initRepoError}
						onInitRepo={actions.handleInitRepo}
					/>

					{/* Optional read/write grants outside the project directory */}
					<div className="mt-6">
						<AdditionalDirectoriesSection
							theme={theme}
							directories={state.additionalDirectories}
							onChange={setAdditionalDirectories}
							disableBrowse={isRemoteSession}
							nativelyEnforced={!!agentConfig?.capabilities?.supportsAdditionalDirectories}
						/>
					</div>
				</div>
			</div>

			<div className="flex-1" />

			<DirectoryContinueButton
				theme={theme}
				show={showContinue}
				isValid={isValid}
				isValidating={validation.isValidating}
				buttonRef={continueButtonRef}
				onContinue={actions.handleContinue}
			/>

			<div className="flex-1" />

			<DirectoryKeyboardHints theme={theme} />

			{actions.showExistingDocsModal && (
				<ExistingDocsModal
					theme={theme}
					documentCount={state.existingDocsCount}
					directoryPath={state.directoryPath}
					onStartFresh={actions.handleStartFresh}
					onContinue={actions.handleContinueWithDocs}
					onCancel={actions.handleModalCancel}
				/>
			)}
		</div>
	);
}
