import { useEffect, useRef, useState } from 'react';
import { useWizard } from '../../WizardContext';
import { ScreenReaderAnnouncement } from '../../ScreenReaderAnnouncement';
import { DocumentReview } from './DocumentReview';
import type { PhaseReviewScreenProps } from './types';

export function PhaseReviewScreen({
	theme,
	onLaunchSession,
	onWizardComplete,
	wizardStartTime,
}: PhaseReviewScreenProps): JSX.Element {
	const { state, previousStep } = useWizard();
	const [announcement, setAnnouncement] = useState('');
	const [announcementKey, setAnnouncementKey] = useState(0);
	const hasRedirectedRef = useRef(false);

	useEffect(() => {
		if (state.generatedDocuments.length > 0) {
			hasRedirectedRef.current = false;
			const totalTasks = state.generatedDocuments.reduce((sum, doc) => sum + doc.taskCount, 0);
			setAnnouncement(
				`${state.generatedDocuments.length} Playbooks ready with ${totalTasks} tasks total. Review and edit your Playbooks, then choose how to proceed.`
			);
			setAnnouncementKey((prev) => prev + 1);
		}
	}, [state.generatedDocuments]);

	useEffect(() => {
		if (state.generatedDocuments.length === 0 && !hasRedirectedRef.current) {
			hasRedirectedRef.current = true;
			previousStep();
		}
	}, [previousStep, state.generatedDocuments.length]);

	if (state.generatedDocuments.length === 0) {
		return (
			<div className="flex-1 flex items-center justify-center">
				<p style={{ color: theme.colors.textDim }}>Redirecting...</p>
			</div>
		);
	}

	return (
		<>
			<ScreenReaderAnnouncement
				message={announcement}
				announceKey={announcementKey}
				politeness="polite"
			/>
			<DocumentReview
				theme={theme}
				onLaunchSession={onLaunchSession}
				onWizardComplete={onWizardComplete}
				wizardStartTime={wizardStartTime}
			/>
		</>
	);
}
