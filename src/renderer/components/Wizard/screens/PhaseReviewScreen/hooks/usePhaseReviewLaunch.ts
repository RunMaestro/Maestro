import { useCallback, useState } from 'react';
import type { GeneratedDocument, WizardState } from '../../../WizardContext';
import { captureException, captureMessage } from '../../../../../utils/sentry';
import type { LaunchingButton } from '../types';
import { buildWizardCompletionMetrics } from '../utils/documentStats';

export function usePhaseReviewLaunch({
	state,
	currentDoc,
	localContent,
	saveNow,
	setWantsTour,
	onLaunchSession,
	onWizardComplete,
	wizardStartTime,
}: {
	state: WizardState;
	currentDoc: GeneratedDocument | undefined;
	localContent: string;
	saveNow: (content?: string) => Promise<void>;
	setWantsTour: (wantsTour: boolean) => void;
	onLaunchSession: (wantsTour: boolean) => Promise<void>;
	onWizardComplete?: (
		durationMs: number,
		conversationExchanges: number,
		phasesGenerated: number,
		tasksGenerated: number
	) => void;
	wizardStartTime?: number;
}) {
	const [launchingButton, setLaunchingButton] = useState<LaunchingButton>(null);
	const [launchError, setLaunchError] = useState<string | null>(null);

	const handleLaunch = useCallback(
		async (wantsTour: boolean) => {
			setLaunchingButton(wantsTour ? 'tour' : 'ready');
			setLaunchError(null);
			setWantsTour(wantsTour);

			try {
				if (currentDoc) {
					await saveNow(localContent);
				}

				if (onWizardComplete) {
					const metrics = buildWizardCompletionMetrics({
						wizardStartTime,
						conversationHistory: state.conversationHistory,
						generatedDocuments: state.generatedDocuments,
					});
					onWizardComplete(
						metrics.durationMs,
						metrics.conversationExchanges,
						metrics.phasesGenerated,
						metrics.tasksGenerated
					);
				}

				await onLaunchSession(wantsTour);
			} catch (err) {
				const errorMessage = err instanceof Error ? err.message : 'Failed to launch session';
				setLaunchError(errorMessage);
				setLaunchingButton(null);
				if (err instanceof Error) {
					captureException(err, {
						extra: {
							context: 'usePhaseReviewLaunch.handleLaunch',
							wantsTour,
							filename: currentDoc?.filename,
						},
					});
					return;
				}

				captureMessage('Phase review launch failed with a non-Error value', {
					level: 'error',
					extra: {
						context: 'usePhaseReviewLaunch.handleLaunch',
						wantsTour,
						filename: currentDoc?.filename,
						error: String(err),
					},
				});
			}
		},
		[
			currentDoc,
			localContent,
			onLaunchSession,
			onWizardComplete,
			saveNow,
			setWantsTour,
			state.conversationHistory,
			state.generatedDocuments,
			wizardStartTime,
		]
	);

	return {
		launchingButton,
		launchError,
		setLaunchError,
		handleLaunch,
	};
}
