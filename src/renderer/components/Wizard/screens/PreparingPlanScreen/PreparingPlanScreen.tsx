import { useWizard } from '../../WizardContext';
import { ScreenReaderAnnouncement } from '../../ScreenReaderAnnouncement';
import { ErrorDisplay, LoadingIndicator } from './components';
import { usePreparingPlanGeneration } from './hooks';
import type { PreparingPlanScreenProps } from './types';

export function PreparingPlanScreen({ theme }: PreparingPlanScreenProps): JSX.Element {
	const {
		state,
		setGeneratingDocuments,
		setGeneratedDocuments,
		setGenerationError,
		previousStep,
		nextStep,
	} = useWizard();

	const generation = usePreparingPlanGeneration({
		state,
		setGeneratingDocuments,
		setGeneratedDocuments,
		setGenerationError,
		previousStep,
		nextStep,
	});

	const announcementElement = (
		<ScreenReaderAnnouncement
			message={generation.announcement}
			announceKey={generation.announcementKey}
			politeness="polite"
		/>
	);

	if (state.generationError) {
		return (
			<>
				{announcementElement}
				<ErrorDisplay
					error={state.generationError}
					onRetry={generation.handleRetry}
					onSkip={generation.handleGoBack}
					theme={theme}
				/>
			</>
		);
	}

	return (
		<>
			{announcementElement}
			<LoadingIndicator
				message={generation.progressMessage}
				theme={theme}
				createdFiles={generation.createdFiles}
				startTime={generation.generationStartTime}
			/>
		</>
	);
}
