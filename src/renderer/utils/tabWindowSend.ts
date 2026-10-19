/**
 * What a message sent from a tab window's composer may not do (Tab Windows).
 *
 * The owner window runs every send through its own `processInput` (D2), but a
 * few things that send path does belong to the app window's own view and cannot
 * be pointed at a popped tab: the inline planning wizard (its panel replaces
 * the app window's composer), and the `/history`, `/wizard`, and `/skills`
 * built-ins (each works on the app window's active tab). A tab window checks
 * this before it sends, so it can tell the user why; the owner checks it again
 * before it runs a send, so nothing reaches the wrong tab either way.
 */

import type { AITab } from '../types';
import type { ToolType } from '../../shared/types';
import type { ComposerCommandMode } from './shellCommandInput';
import { hasActiveWizard } from './tabHelpers';

/** The slash built-ins `processInput` handles itself, all bound to the active tab. */
export const APP_WINDOW_ONLY_SLASH_COMMANDS = ['/history', '/wizard', '/skills'] as const;

/**
 * The built-in a message invokes, matched the way `processInput` matches them:
 * `/history` and `/skills` exactly (`/skills` only for Claude Code, the one
 * provider it lists skills for), `/wizard` alone or with arguments.
 */
export function appWindowOnlySlashCommand(text: string, toolType: ToolType): string | null {
	const command = text.trim();
	if (command === '/history') return '/history';
	if (command === '/wizard' || command.startsWith('/wizard ')) return '/wizard';
	if (command === '/skills' && toolType === 'claude-code') return '/skills';
	return null;
}

/**
 * Why a send from a tab window cannot run on `tab`, or null when it can. The
 * message is shown to the user as is.
 */
export function tabWindowSendRefusal(
	tab: AITab | undefined,
	text: string,
	commandMode: ComposerCommandMode,
	toolType: ToolType
): string | null {
	if (!tab) return 'This tab is no longer open.';
	if (hasActiveWizard(tab)) {
		return 'The planning wizard runs in the main window. Dock this tab to continue it.';
	}
	// A plain message only: a command line goes to the shell, not to a built-in.
	if (commandMode !== 'off') return null;
	const builtIn = appWindowOnlySlashCommand(text, toolType);
	return builtIn ? `${builtIn} runs in the main window. Dock this tab to use it.` : null;
}
