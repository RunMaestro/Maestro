import { useEffect } from 'react';
import { useWizard } from '../../WizardContext';
import { DocumentEditor } from '../../shared/DocumentEditor';
import { LaunchErrorBanner, PhaseReviewFooter } from './components';
import {
	usePhaseReviewAutosave,
	usePhaseReviewDocumentState,
	usePhaseReviewKeyboard,
	usePhaseReviewLaunch,
} from './hooks';
import type { PhaseReviewScreenProps } from './types';
import { buildPhaseReviewStatsText } from './utils/documentStats';

export function DocumentReview({
	theme,
	onLaunchSession,
	onWizardComplete,
	wizardStartTime,
}: PhaseReviewScreenProps): JSX.Element {
	const {
		state,
		setEditedPhase1Content,
		getPhase1Content,
		setWantsTour,
		setCurrentDocumentIndex,
		setAutoRunMode,
	} = useWizard();

	const documentState = usePhaseReviewDocumentState({
		state,
		getPhase1Content,
		setCurrentDocumentIndex,
	});

	const autosave = usePhaseReviewAutosave({
		localContent: documentState.localContent,
		folderPath: documentState.folderPath,
		currentDoc: documentState.currentDoc,
		currentDocumentIndex: state.currentDocumentIndex,
		setEditedPhase1Content,
	});

	const launch = usePhaseReviewLaunch({
		state,
		currentDoc: documentState.currentDoc,
		localContent: documentState.localContent,
		saveNow: autosave.saveNow,
		setWantsTour,
		onLaunchSession,
		onWizardComplete,
		wizardStartTime,
	});

	const handleKeyDown = usePhaseReviewKeyboard({
		mode: documentState.mode,
		generatedDocuments: state.generatedDocuments,
		currentDocumentIndex: state.currentDocumentIndex,
		isDropdownOpen: documentState.isDropdownOpen,
		setIsDropdownOpen: documentState.setIsDropdownOpen,
		handleModeChange: documentState.handleModeChange,
		handleDocumentSelect: documentState.handleDocumentSelect,
		readyButtonRef: documentState.readyButtonRef,
		tourButtonRef: documentState.tourButtonRef,
		launchingButton: launch.launchingButton,
		handleLaunch: launch.handleLaunch,
	});

	useEffect(() => {
		setTimeout(() => {
			documentState.readyButtonRef.current?.focus();
		}, 100);
	}, [documentState.readyButtonRef]);

	if (!documentState.currentDoc) {
		return (
			<div className="flex-1 flex items-center justify-center">
				<p style={{ color: theme.colors.textDim }}>No documents generated</p>
			</div>
		);
	}

	return (
		<div
			ref={documentState.containerRef}
			className="flex flex-col flex-1 min-h-0 outline-none"
			tabIndex={-1}
			onKeyDown={handleKeyDown}
		>
			<div className="flex-1 min-h-0 flex flex-col px-6 py-4">
				<DocumentEditor
					content={documentState.localContent}
					onContentChange={documentState.handleContentChange}
					mode={documentState.mode}
					onModeChange={documentState.handleModeChange}
					folderPath={documentState.folderPath}
					selectedFile={documentState.currentDoc.filename.replace(/\.md$/, '')}
					attachments={documentState.attachments}
					onAddAttachment={documentState.handleAddAttachment}
					onRemoveAttachment={documentState.handleRemoveAttachment}
					theme={theme}
					isLocked={launch.launchingButton !== null}
					textareaRef={documentState.textareaRef}
					previewRef={documentState.previewRef}
					documents={state.generatedDocuments}
					selectedDocIndex={state.currentDocumentIndex}
					onDocumentSelect={documentState.handleDocumentSelect}
					statsText={buildPhaseReviewStatsText(
						state.generatedDocuments,
						documentState.localContent
					)}
					proseClassPrefix="phase-review"
					isDropdownOpen={documentState.isDropdownOpen}
					onDropdownOpenChange={documentState.setIsDropdownOpen}
				/>
			</div>

			<LaunchErrorBanner
				error={launch.launchError}
				theme={theme}
				onDismiss={() => launch.setLaunchError(null)}
			/>

			<PhaseReviewFooter
				theme={theme}
				generatedDocuments={state.generatedDocuments}
				autoRunMode={state.autoRunMode}
				setAutoRunMode={setAutoRunMode}
				launchingButton={launch.launchingButton}
				readyButtonRef={documentState.readyButtonRef}
				tourButtonRef={documentState.tourButtonRef}
				onLaunch={launch.handleLaunch}
			/>
		</div>
	);
}
