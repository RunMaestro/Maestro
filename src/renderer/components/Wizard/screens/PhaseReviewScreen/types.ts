import type { Theme } from '../../../../types';

export interface PhaseReviewScreenProps {
	theme: Theme;
	onLaunchSession: (wantsTour: boolean) => Promise<void>;
	onWizardComplete?: (
		durationMs: number,
		conversationExchanges: number,
		phasesGenerated: number,
		tasksGenerated: number
	) => void;
	wizardStartTime?: number;
}

export type LaunchingButton = 'ready' | 'tour' | null;
