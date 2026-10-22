import type { QuickAction } from '../types';

interface BuildQuickChatCommandsArgs {
	/** Quick Chat Encore Feature on, in a renderer that has the window (not web-desktop). */
	quickChatAvailable: boolean;
	/** The system-wide hotkey from Quick Chat's settings; empty when unbound. */
	hotkey: string[];
	openQuickChat: () => void;
	setQuickActionOpen: (open: boolean) => void;
}

/**
 * Palette entry for the Quick Chat window.
 *
 * Its hotkey is system-wide and lives in Quick Chat's own settings rather than
 * in `DEFAULT_SHORTCUTS`, so the chord shown here is read from that setting:
 * a user who rebinds it, or clears it, sees their own binding.
 */
export function buildQuickChatCommands({
	quickChatAvailable,
	hotkey,
	openQuickChat,
	setQuickActionOpen,
}: BuildQuickChatCommandsArgs): QuickAction[] {
	if (!quickChatAvailable) return [];
	return [
		{
			id: 'open-quick-chat',
			label: 'Open Quick Chat',
			shortcut:
				hotkey.length > 0 ? { id: 'quickChat', label: 'Quick Chat', keys: hotkey } : undefined,
			subtext: 'A floating chat with one agent, reachable from any app',
			action: () => {
				openQuickChat();
				setQuickActionOpen(false);
			},
		},
	];
}
