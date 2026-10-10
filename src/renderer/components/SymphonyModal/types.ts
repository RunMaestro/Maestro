import type { Theme } from '../../types';
import type { RegisteredRepository, SymphonyIssue } from '../../../shared/symphony-types';

export interface SymphonyContributionData {
	contributionId: string;
	localPath: string;
	autoRunPath?: string;
	branchName?: string;
	draftPrNumber?: number;
	draftPrUrl?: string;
	agentType: string;
	sessionName: string;
	repo: RegisteredRepository;
	issue: SymphonyIssue;
	customPath?: string;
	customArgs?: string;
	customEnvVars?: Record<string, string>;
}

export interface SymphonyModalProps {
	theme: Theme;
	isOpen: boolean;
	onClose: () => void;
	onStartContribution: (data: SymphonyContributionData) => void;
	onSelectSession: (sessionId: string) => void;
}

export type ModalTab = 'projects' | 'active' | 'history' | 'stats';

export const SYMPHONY_TABS: readonly ModalTab[] = ['projects', 'active', 'history', 'stats'];
