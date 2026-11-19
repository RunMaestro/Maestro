import type { QuickAction } from '../types';

interface BuildPlaybookReportCommandsArgs {
	/** The agent in view; with none there is no saved report to open. */
	activeAgentId?: string;
	/** Reports waiting in the completion queue; with any, the entry shows them. */
	waitingCount: number;
	openPlaybookReport: () => void;
	setQuickActionOpen: (open: boolean) => void;
}

/**
 * The palette entry for the `playbook-report` surface: the reports of
 * finished playbook runs still waiting to be read, or the active agent's most
 * recent one from `.maestro-reports/`.
 */
export function buildPlaybookReportCommands({
	activeAgentId,
	waitingCount,
	openPlaybookReport,
	setQuickActionOpen,
}: BuildPlaybookReportCommandsArgs): QuickAction[] {
	if (!activeAgentId && waitingCount === 0) return [];
	return [
		{
			id: 'playbookReport',
			label: 'Open Last Playbook Report',
			subtext:
				waitingCount > 0
					? `${waitingCount} finished run${waitingCount === 1 ? '' : 's'} waiting to be read`
					: "What the active agent's last playbook run did, and how to use it",
			action: () => {
				setQuickActionOpen(false);
				openPlaybookReport();
			},
		},
	];
}
