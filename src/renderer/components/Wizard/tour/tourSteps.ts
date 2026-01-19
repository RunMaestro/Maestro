/**
 * tourSteps.ts
 *
 * Defines the tour step sequence and configuration for the onboarding tour.
 * Each step includes selector information for spotlighting elements,
 * title/description content, and UI state requirements.
 *
 * Steps have two description variants:
 * - description: Used when tour is launched from the wizard (Auto Run context)
 * - descriptionGeneric: Used when tour is launched from hamburger menu (general context)
 *
 * Descriptions can include shortcut placeholders like {{shortcutId}} which will be
 * replaced with the user's configured keyboard shortcut at runtime.
 */

import type { TourStepConfig } from './useTour';
import type { Shortcut } from '../../../types';
import { formatShortcutKeys } from '../../../utils/shortcutFormatter';

/**
 * All tour steps in order
 *
 * Tour sequence:
 * 1) Auto Run panel - explain what's running right now
 * 2) Auto Run document selector - show Auto Run documents
 * 3) Files tab - show file explorer
 * 4) History tab - explain auto vs manual entries
 * 5) Left panel hamburger menu - show menu options
 * 6) Left panel session list - explain sessions and groups
 * 7) Main terminal area - explain AI Terminal
 * 8) Agent Sessions button - browse previous conversations
 * 9) Input area - explain messaging the AI
 * 10) Terminal mode - teach Cmd+J shortcut
 * 11) Keyboard shortcuts - mention Cmd+/ for all shortcuts, end tour
 */
export const tourSteps: TourStepConfig[] = [
	{
		id: 'autorun-panel',
		title: 'Auto Run Panel',
		description:
			'This is the Auto Run panel where your Playbook is being executed right now. Each task from your Phase 1 document is being processed automatically by the AI agent. Watch as checkboxes get marked off! Press {{goToAutoRun}} to jump here anytime.',
		descriptionGeneric:
			'This is the Auto Run panel. Place markdown documents with task lists here to have the AI execute them automatically. Tasks are checked off as they complete. Press {{goToAutoRun}} to jump here anytime.',
		selector: '[data-tour="autorun-tab"]',
		position: 'left',
		uiActions: [{ type: 'setRightTab', value: 'autorun' }, { type: 'openRightPanel' }],
	},
	{
		id: 'autorun-documents',
		title: 'Document Selector',
		description:
			'The document selector shows all the Auto Run documents we created together. After the first document completes, you can select the next one and continue building your project.',
		descriptionGeneric:
			'The document selector shows all documents in your Auto Run folder. Select different documents to view or run them. You can organize work into phases or any structure you prefer.',
		selector: '[data-tour="autorun-document-selector"]',
		position: 'left',
		uiActions: [{ type: 'setRightTab', value: 'autorun' }, { type: 'openRightPanel' }],
	},
	{
		id: 'files-tab',
		title: 'File Explorer',
		description:
			"The Files tab shows your project's file structure. As the AI creates and modifies files, you'll see them appear here in real-time. Click any file to preview its contents. Press {{goToFiles}} to jump here.",
		descriptionGeneric:
			"The Files tab shows your project's file structure. As the AI creates and modifies files, you'll see them appear here in real-time. Click any file to preview its contents. Press {{goToFiles}} to jump here.",
		selector: '[data-tour="files-tab"]',
		position: 'left',
		uiActions: [{ type: 'setRightTab', value: 'files' }, { type: 'openRightPanel' }],
	},
	{
		id: 'history-tab',
		title: 'History & Tracking',
		description:
			'The History tab tracks all changes made during your session. Auto Run entries are marked automatically, while manual changes you make are tracked separately. You can toggle history per-message using the "History" bubble (with the clock icon) in the input area. Configure the default behavior in Settings → General. Press {{goToHistory}} to jump here.',
		descriptionGeneric:
			'The History tab tracks all AI interactions in your session. Auto Run entries are marked automatically, while manual changes are tracked separately. You can toggle history per-message using the "History" bubble (with the clock icon) in the input area. Configure the default behavior in Settings → General. Press {{goToHistory}} to jump here.',
		selector: '[data-tour="history-tab"]',
		position: 'left',
		uiActions: [{ type: 'setRightTab', value: 'history' }, { type: 'openRightPanel' }],
	},
	{
		id: 'hamburger-menu',
		title: 'Main Menu',
		description:
			'The hamburger menu gives you access to settings, themes, the project wizard, and more. You can also re-run this tour anytime from here under "Introductory Tour".',
		descriptionGeneric:
			'The hamburger menu gives you access to settings, themes, the New Agent Wizard, and more. You can re-run this tour anytime from here.',
		// Combine hamburger button and menu contents into one spotlight
		selector: '[data-tour="hamburger-menu"], [data-tour="hamburger-menu-contents"]',
		position: 'right',
		uiActions: [{ type: 'openHamburgerMenu' }],
	},
	{
		id: 'session-list',
		title: 'Sessions & Groups',
		description:
			'The session list shows all your AI assistant sessions. You can have multiple projects running simultaneously, organize them into groups, and quickly switch between them. Watch for the pulsing green dot—it indicates unread messages from an agent. Press {{focusSidebar}} to focus the session list.',
		descriptionGeneric:
			'The session list shows all your AI assistant sessions. You can have multiple projects running simultaneously, organize them into groups, and quickly switch between them. A pulsing green dot indicates unread messages. Press {{focusSidebar}} to focus the session list.',
		selector: '[data-tour="session-list"]',
		position: 'right',
		uiActions: [{ type: 'closeHamburgerMenu' }],
	},
	{
		id: 'main-terminal',
		title: 'AI Terminal',
		description:
			'This is the AI Terminal where you communicate with your AI assistant. In "AI" mode (shown now), messages go to the AI. You can also switch to "Terminal" mode for direct shell commands.',
		descriptionGeneric:
			'This is the AI Terminal where you communicate with your AI assistant. In "AI" mode, messages go to the AI. Switch to "Terminal" mode for direct shell commands.',
		selector: '[data-tour="main-terminal"]',
		position: 'center-overlay',
		uiActions: [],
	},
	{
		id: 'agent-sessions',
		title: 'Agent Sessions',
		description:
			'The Agent Sessions button lets you browse previous conversations with your AI agent. Access it via Quick Actions ({{quickAction}}) or the {{agentSessions}} shortcut. Resume past sessions, search through history, and continue where you left off.',
		descriptionGeneric:
			'The Agent Sessions button lets you browse previous conversations with your AI agent. Access it via Quick Actions ({{quickAction}}) or the {{agentSessions}} shortcut. Resume past sessions, search through history, and continue where you left off.',
		selector: '[data-tour="agent-sessions-button"]',
		position: 'left',
		uiActions: [],
	},
	{
		id: 'input-area',
		title: 'Input Area',
		description:
			'Type your messages here to communicate with the AI. During Auto Run, this area may be locked while tasks execute. You can queue messages to send after the current task completes. Press {{focusInput}} to quickly jump here.',
		descriptionGeneric:
			'Type your messages here to communicate with the AI. You can also use slash commands, @ mentions for files, and attach images. Press {{focusInput}} to quickly jump here.',
		selector: '[data-tour="input-area"]',
		position: 'top',
		uiActions: [],
	},
	{
		id: 'terminal-mode',
		title: 'Terminal Mode',
		description:
			'Press {{toggleMode}} to switch between AI mode and Terminal mode. Terminal mode gives you a direct shell for running commands yourself.',
		descriptionGeneric:
			'Press {{toggleMode}} to switch between AI mode and Terminal mode. Terminal mode gives you a direct shell for running commands yourself.',
		selector: '[data-tour="input-area"]',
		position: 'top',
		uiActions: [],
	},
	{
		id: 'keyboard-shortcuts',
		title: 'Keyboard Shortcuts',
		description:
			"Maestro is keyboard-first. Press {{help}} anytime to see all available shortcuts. You're now ready to build amazing things!",
		descriptionGeneric:
			"Maestro is keyboard-first. Press {{help}} anytime to see all available shortcuts. You're ready to go!",
		selector: null, // Center screen, no specific element
		position: 'center',
		uiActions: [],
	},
];

/**
 * Replace shortcut placeholders in a description string with formatted shortcuts.
 *
 * Placeholders are in the format {{shortcutId}} where shortcutId matches
 * a key in the shortcuts record.
 *
 * @param text - The description text with placeholders
 * @param shortcuts - Record of shortcut configurations
 * @returns The text with placeholders replaced by formatted shortcuts
 *
 * @example
 * replaceShortcutPlaceholders(
 *   'Press {{toggleMode}} to switch modes.',
 *   { toggleMode: { id: 'toggleMode', label: 'Switch Mode', keys: ['Meta', 'j'] } }
 * )
 * // Returns: 'Press ⌘ J to switch modes.' (on macOS)
 */
export function replaceShortcutPlaceholders(
	text: string,
	shortcuts: Record<string, Shortcut>
): string {
	return text.replace(/\{\{(\w+)\}\}/g, (match, shortcutId) => {
		const shortcut = shortcuts[shortcutId];
		if (shortcut?.keys) {
			return formatShortcutKeys(shortcut.keys);
		}
		// If shortcut not found, return the placeholder as-is
		return match;
	});
}
