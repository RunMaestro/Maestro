import { useCallback, useState } from 'react';
import { captureException } from '../../../../../utils/sentry';
import type { WizardAutoRunMode } from '../../../WizardContext';

interface UseSkipPlaybookLaunchParams {
	directoryPath: string;
	selectedAgent: string | null;
	setAutoRunMode: (mode: WizardAutoRunMode) => void;
	onLaunchSession?: (wantsTour: boolean) => Promise<void>;
}

/**
 * Create the agent now and leave the playbook out of it.
 *
 * `onLaunchSession` already tolerates an empty `generatedDocuments`: no file is
 * preselected and no batch run starts. `autoRunMode: 'none'` is set for a
 * coherent final state, but it is NOT what keeps the Right Bar still -
 * `handleWizardLaunchSession` reads the wizard state its closure captured, so a
 * dispatch made one line earlier is invisible to it. That is why the Right Bar
 * switch is gated on the document count over there rather than on the mode
 * here; it was reaching an empty Auto Run panel until it was.
 *
 * No wizard-run stat is written here. `recordCompletedWizardRun` files anything
 * with zero documents as `outcome: 'abandoned'`, and a deliberate skip is not
 * an abandonment - a wrong row is worse than no row.
 */
export function useSkipPlaybookLaunch({
	directoryPath,
	selectedAgent,
	setAutoRunMode,
	onLaunchSession,
}: UseSkipPlaybookLaunchParams) {
	const [isSkipping, setIsSkipping] = useState(false);
	const [skipError, setSkipError] = useState<string | null>(null);

	const handleSkipPlaybook = useCallback(async () => {
		if (isSkipping || !onLaunchSession || !directoryPath.trim() || !selectedAgent) return;

		setIsSkipping(true);
		setSkipError(null);
		setAutoRunMode('none');

		try {
			await onLaunchSession(false);
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Failed to create the agent';
			setSkipError(message);
			setIsSkipping(false);
			captureException(error, {
				extra: {
					context: 'useSkipPlaybookLaunch.handleSkipPlaybook',
					directoryPath,
					selectedAgent,
				},
			});
		}
	}, [directoryPath, isSkipping, onLaunchSession, selectedAgent, setAutoRunMode]);

	return { isSkipping, skipError, handleSkipPlaybook };
}
