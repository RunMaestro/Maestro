import React from 'react';
import { Play, Pause, CheckCircle, GitPullRequest, AlertCircle, X } from 'lucide-react';
import { Spinner } from '../../ui/Spinner';
import { COLORBLIND_AGENT_PALETTE } from '../../../constants/colorblindPalettes';
import type { ContributionStatus } from '../../../../shared/symphony-types';

export const STATUS_COLORS: Record<ContributionStatus, string> = {
	cloning: COLORBLIND_AGENT_PALETTE[0],
	creating_pr: COLORBLIND_AGENT_PALETTE[0],
	running: COLORBLIND_AGENT_PALETTE[2],
	paused: COLORBLIND_AGENT_PALETTE[1],
	completed: COLORBLIND_AGENT_PALETTE[2],
	completing: COLORBLIND_AGENT_PALETTE[0],
	ready_for_review: COLORBLIND_AGENT_PALETTE[8],
	failed: COLORBLIND_AGENT_PALETTE[3],
	cancelled: COLORBLIND_AGENT_PALETTE[6],
};

export interface StatusInfo {
	label: string;
	color: string;
	icon: React.ReactNode;
}

export function getStatusInfo(status: ContributionStatus | string): StatusInfo {
	const icons: Record<ContributionStatus, React.ReactNode> = {
		cloning: <Spinner size={12} />,
		creating_pr: <Spinner size={12} />,
		running: <Play className="w-3 h-3" />,
		paused: <Pause className="w-3 h-3" />,
		completed: <CheckCircle className="w-3 h-3" />,
		completing: <Spinner size={12} />,
		ready_for_review: <GitPullRequest className="w-3 h-3" />,
		failed: <AlertCircle className="w-3 h-3" />,
		cancelled: <X className="w-3 h-3" />,
	};
	const labels: Record<ContributionStatus, string> = {
		cloning: 'Cloning',
		creating_pr: 'Creating PR',
		running: 'Running',
		paused: 'Paused',
		completed: 'Completed',
		completing: 'Completing',
		ready_for_review: 'Ready for Review',
		failed: 'Failed',
		cancelled: 'Cancelled',
	};
	if (!Object.prototype.hasOwnProperty.call(labels, status)) {
		return {
			label: status || 'Unknown',
			color: STATUS_COLORS.paused,
			icon: <AlertCircle className="w-3 h-3" />,
		};
	}
	const knownStatus = status as ContributionStatus;
	return {
		label: labels[knownStatus],
		color: STATUS_COLORS[knownStatus],
		icon: icons[knownStatus],
	};
}
