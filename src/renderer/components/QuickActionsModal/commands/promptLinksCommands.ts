import type { QuickAction } from '../types';
import type { PromptLinksModalData } from '../../../stores/modalStore';

interface BuildPromptLinksCommandsArgs {
	/** Prompt Links Encore Feature state - with it off, the palette offers nothing. */
	promptLinksEnabled: boolean;
	/** Agent a new link should target, when there is one in view. */
	activeAgent?: { id: string; name: string };
	/** The active AI tab's unsent draft, offered as the link's prompt. */
	activeDraft?: string;
	openPromptLinks: (data?: PromptLinksModalData) => void;
	setQuickActionOpen: (open: boolean) => void;
	shortcuts: {
		openPromptLinks?: QuickAction['shortcut'];
	};
}

/**
 * Palette entries for the Prompt Links window: one to open it, and one that
 * opens it ready to make a link for the agent in view.
 */
export function buildPromptLinksCommands({
	promptLinksEnabled,
	activeAgent,
	activeDraft,
	openPromptLinks,
	setQuickActionOpen,
	shortcuts,
}: BuildPromptLinksCommandsArgs): QuickAction[] {
	if (!promptLinksEnabled) return [];

	const commands: QuickAction[] = [
		{
			id: 'promptLinks',
			label: 'Prompt Links',
			shortcut: shortcuts.openPromptLinks,
			subtext: 'Create, copy, and revoke maestro://run links that send a prompt to an agent',
			action: () => {
				setQuickActionOpen(false);
				openPromptLinks();
			},
		},
	];

	if (activeAgent) {
		const draft = activeDraft?.trim() ? activeDraft : undefined;
		commands.push({
			id: 'createPromptLink',
			label: 'Create Prompt Link',
			subtext: draft
				? `A link that sends this tab's draft to ${activeAgent.name}`
				: `A maestro://run link that sends a prompt to ${activeAgent.name}`,
			action: () => {
				setQuickActionOpen(false);
				openPromptLinks({
					agentId: activeAgent.id,
					compose: true,
					...(draft ? { prompt: draft } : {}),
				});
			},
		});
	}

	return commands;
}
