import type { QuickAction } from '../types';

interface BuildPlaybookConfigureCommandsArgs {
	/** The agent in view; playbooks belong to an agent, so with none the palette offers nothing. */
	activeAgentId?: string;
	openPlaybookConfigure: (data?: { sessionId?: string }) => void;
	setQuickActionOpen: (open: boolean) => void;
	shortcuts: {
		openPlaybookConfigure?: QuickAction['shortcut'];
	};
}

/**
 * The palette entry for the Playbook Configure modal: a picker of the active
 * agent's playbooks, then the chosen playbook's parameter form.
 */
export function buildPlaybookConfigureCommands({
	activeAgentId,
	openPlaybookConfigure,
	setQuickActionOpen,
	shortcuts,
}: BuildPlaybookConfigureCommandsArgs): QuickAction[] {
	if (!activeAgentId) return [];
	return [
		{
			id: 'playbookConfigure',
			label: 'Configure Playbook',
			shortcut: shortcuts.openPlaybookConfigure,
			subtext: "Answer a saved playbook's parameters before it runs",
			action: () => {
				setQuickActionOpen(false);
				openPlaybookConfigure({ sessionId: activeAgentId });
			},
		},
	];
}
