import { useCallback, useState } from 'react';
import type { GeneratedDocument, WizardState } from '../../../WizardContext';
import { captureException, captureMessage } from '../../../../../utils/sentry';
import type { LaunchingButton } from '../types';
import { buildWizardCompletionMetrics } from '../utils/documentStats';
import { recordCompletedWizardRun } from '../../../../../services/wizardStats';

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

				const metrics = buildWizardCompletionMetrics({
					wizardStartTime,
					conversationHistory: state.conversationHistory,
					generatedDocuments: state.generatedDocuments,
				});

				// The onboarding wizard reports once, at launch, rather than per
				// milestone like the inline wizard - everything it produced is
				// already in hand here, so one row is the whole run.
				recordCompletedWizardRun({
					sessionId: 'onboarding',
					agentType: state.selectedAgent || 'unknown',
					surface: 'onboarding',
					// 'continue' means the user pointed the wizard at Auto Run docs
					// that already existed, which is the same shape as the inline
					// wizard's 'iterate'.
					mode: state.existingDocsChoice === 'continue' ? 'iterate' : 'new',
					durationMs: metrics.durationMs,
					exchanges: metrics.conversationExchanges,
					documents: metrics.phasesGenerated,
					tasks: metrics.tasksGenerated,
					projectPath: state.directoryPath || undefined,
				});

				if (onWizardComplete) {
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
					throw err;
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
				throw new Error(errorMessage);
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
