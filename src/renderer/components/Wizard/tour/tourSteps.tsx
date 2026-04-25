/**
 * tourSteps.tsx
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
 *
 * Steps can also include descriptionContent/descriptionContentGeneric for JSX
 * content that renders inline icons matching the actual UI.
 */

import React from 'react';
import { PenLine, ImageIcon, History, Eye, Brain, Search, Sparkles, Gauge } from 'lucide-react';
import type { TourStepConfig } from './useTour';
import type { Shortcut } from '../../../types';
import { formatShortcutKeys } from '../../../utils/shortcutFormatter';

/**
 * Inline icon component for tour descriptions - matches the actual UI icons
 */
function TourIcon({
	icon: Icon,
	label,
}: {
	icon: React.ComponentType<{ className?: string }>;
	label?: string;
}) {
	return (
		<span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-white/10 text-xs whitespace-nowrap">
			<Icon className="w-3 h-3" />
			{label && <span>{label}</span>}
		</span>
	);
}

/**
 * JSX content for the input area tour step showing actual icons
 */
const inputAreaIconsContent = (
	<div className="text-xs leading-relaxed space-y-1.5">
		<div>
			Look for these controls: <TourIcon icon={PenLine} /> opens an expanded prompt editor,{' '}
			<TourIcon icon={ImageIcon} /> lets you attach files (or just paste).
		</div>
	</div>
);

/**
 * JSX content for the model selector tour step
 */
const modelSelectorContent = (
	<div className="text-xs leading-relaxed space-y-1.5">
		<div>
			<TourIcon icon={Sparkles} label="Model" /> Click this pill to switch between available AI
			models (e.g., Sonnet, Opus, Haiku). Different models have different strengths — pick the right
			one for the task.
		</div>
		<div>
			<TourIcon icon={Gauge} label="Effort" /> When available, this pill lets you set the effort
			level (low, medium, high). Lower effort means faster, cheaper responses. Higher effort means
			more thorough work.
		</div>
	</div>
);

/**
 * JSX content for the toolbar toggles tour step
 */
const toolbarTogglesContent = (
	<div className="text-xs leading-relaxed space-y-1.5">
		<div>
			These are <strong>buttons</strong>, not just labels — click them to toggle:
		</div>
		<div>
			<TourIcon icon={History} label="History" /> Controls whether this tab's interactions are saved
			to your history. Toggle per-tab as needed.
		</div>
		<div>
			<TourIcon icon={Eye} label="Plan / Read-only" /> Prevents the agent from modifying files —
			great for asking questions, reviewing code, or planning without risk.
		</div>
		<div>
			<TourIcon icon={Brain} label="Thinking" /> Streams the agent's internal reasoning. Click once
			for temporary, again for sticky (persistent across messages), and once more to turn off.
		</div>
		<div className="opacity-70">
			Defaults for these toggles can be changed in Settings → General.
		</div>
	</div>
);

/**
 * JSX content for the AI Terminal & Tabs tour step showing magnifier icon
 */
const tabSearchIconContent = (
	<div className="text-xs leading-relaxed">
		The <TourIcon icon={Search} /> icon on the left of the tab bar opens a searchable tab overview.
	</div>
);

/**
 * All tour steps in order
 *
 * Tour sequence:
 * 1) Auto Run panel - explain what's running right now
 * 2) Auto Run document selector - show Auto Run documents
 * 3) Files tab - show file explorer
 * 4) History tab - explain auto vs manual entries
 * 5) Left panel hamburger menu - show menu options
 * 6) Remote control - LIVE/OFFLINE toggle, QR code, Cloudflare tunnel
 * 7) Left panel agent list - explain agents and groups
 * 8) Main terminal area + tabs - explain AI Terminal and tab usage
 * 9) Agent Sessions button - browse previous conversations
 * 10) Input area - explain messaging the AI
 * 11) Model & effort selector - choose model and effort level
 * 12) Toolbar toggles - History, Read-only/Plan, Thinking buttons
 * 13) Additional tabs - terminal (Cmd+J), browser (Cmd+B), jump to nearest terminal
 * 14) Keyboard shortcuts - mention Cmd+/ for all shortcuts, end tour
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
			"The Files tab shows your project's file structure. As the AI creates and modifies files, you'll see them appear here. The file tree can be searched. Double click a file to open it in a tab for preview and edit. Right click a file for other options such as opening Markdown documents in a graph view. Press {{goToFiles}} to jump to the file panel from anywhere.",
		descriptionGeneric:
			"The Files tab shows your project's file structure. As the AI creates and modifies files, you'll see them appear here. The file tree can be searched. Double click a file to open it in a tab for preview and edit. Right click a file for other options such as opening Markdown documents in a graph view. Press {{goToFiles}} to jump to the file panel from anywhere.",
		wide: true,
		selector: '[data-tour="files-tab"]',
		position: 'left',
		uiActions: [{ type: 'setRightTab', value: 'files' }, { type: 'openRightPanel' }],
	},
	{
		id: 'history-tab',
		title: 'History & Tracking',
		description:
			'The History tab tracks all AI interactions in your session. Auto Run entries are tracked automatically, and separate from manual interactions. You can toggle history per-message using the "History" bubble (with the clock icon) in the input area. Configure the default value under Settings → General.\n\nSwitch between the list view and the details view to drill into any entry. From the details view you can also resume the session where that entry took place.\n\nHistory also serves as memory for all Maestro agents—they know how to locate and parse the history file, giving them context about prior work. Press {{goToHistory}} to jump here.',
		descriptionGeneric:
			'The History tab tracks all AI interactions in your session. Auto Run entries are tracked automatically, and separate from manual interactions. You can toggle history per-message using the "History" bubble (with the clock icon) in the input area. Configure the default value under Settings → General.\n\nSwitch between the list view and the details view to drill into any entry. From the details view you can also resume the session where that entry took place.\n\nHistory also serves as memory for all Maestro agents—they know how to locate and parse the history file, giving them context about prior work. Press {{goToHistory}} to jump here.',
		wide: true,
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
		id: 'remote-control',
		title: 'Remote Control',
		description:
			'The LIVE/OFFLINE indicator controls a built-in web interface for remote control. Toggle it on to generate a local URL and QR code—scan it with your phone to control Maestro from the couch, the kitchen, or anywhere on your network.\n\nIf you have Cloudflare Tunnel (cloudflared) installed, one click opens a secure tunnel—no API keys, no login, no configuration. Access Maestro from anywhere, even outside your home network.',
		descriptionGeneric:
			'The LIVE/OFFLINE indicator controls a built-in web interface for remote control. Toggle it on to generate a local URL and QR code—scan it with your phone to control Maestro from anywhere on your network.\n\nIf you have Cloudflare Tunnel (cloudflared) installed, one click opens a secure tunnel—no API keys, no login, no configuration. Access Maestro from anywhere, even outside your home network.',
		wide: true,
		selector: '[data-tour="remote-control"]',
		position: 'right',
		uiActions: [{ type: 'closeHamburgerMenu' }],
	},
	{
		id: 'session-list',
		title: 'Agents & Groups',
		description:
			'The agent list shows all your AI coding agents. Each agent is backed by a provider like Claude Code, Codex, or OpenCode. You can run multiple agents simultaneously on different projects and quickly switch between them. A red indicator dot marks unread messages.\n\nOrganize agents into groups, and with two or more agents you can start a group chat—even across different providers. Press {{focusSidebar}} to focus the agent list.',
		descriptionGeneric:
			'The agent list shows all your AI coding agents. Each agent is backed by a provider like Claude Code, Codex, or OpenCode. You can run multiple agents simultaneously on different projects and quickly switch between them. A red indicator dot marks unread messages.\n\nOrganize agents into groups, and with two or more agents you can start a group chat—even across different providers. Press {{focusSidebar}} to focus the agent list.',
		wide: true,
		selector: '[data-tour="session-list"]',
		position: 'right',
		uiActions: [{ type: 'closeHamburgerMenu' }],
	},
	{
		id: 'main-terminal',
		title: 'AI Terminal & Tabs',
		description:
			'This is the AI Terminal where you communicate with your AI assistant. In "AI" mode (shown now), messages go to the AI. You can also switch to "Terminal" mode for direct shell commands.\n\nUse tabs liberally. Create one for every task, bug, question, or whatever. Each tab is a fresh context. Tabs can be closed and later recalled. There\'s tooling available on tabs too, such as export, send to another agent, and publish as Gist.\n\nYour favorite browser shortcuts work here: {{newTab}} for new, {{closeTab}} to close, {{reopenClosedTab}} to reopen the last closed tab.\n\nAny prior session you\'ve had with your provider can be recalled as a tab, even if that session occurred with the provider directly.',
		descriptionGeneric:
			'This is the AI Terminal where you communicate with your AI assistant. In "AI" mode, messages go to the AI. Switch to "Terminal" mode for direct shell commands.\n\nUse tabs liberally. Create one for every task, bug, question, or whatever. Each tab is a fresh context. Tabs can be closed and later recalled. There\'s tooling available on tabs too, such as export, send to another agent, and publish as Gist.\n\nYour favorite browser shortcuts work here: {{newTab}} for new, {{closeTab}} to close, {{reopenClosedTab}} to reopen the last closed tab.\n\nAny prior session you\'ve had with your provider can be recalled as a tab, even if that session occurred with the provider directly.',
		descriptionContent: tabSearchIconContent,
		descriptionContentGeneric: tabSearchIconContent,
		wide: true,
		selector: '[data-tour="tab-bar"], [data-tour="main-terminal"]',
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
			'Type your messages here to communicate with the AI. You can also use slash commands and @ mentions for files. Press {{focusInput}} to quickly jump here.',
		descriptionGeneric:
			'Type your messages here to communicate with the AI. You can also use slash commands and @ mentions for files. Press {{focusInput}} to quickly jump here.',
		descriptionContent: inputAreaIconsContent,
		descriptionContentGeneric: inputAreaIconsContent,
		selector: '[data-tour="input-area"]',
		position: 'top',
		uiActions: [],
	},
	{
		id: 'model-selector',
		title: 'Model & Effort',
		description:
			'These pills let you change your AI model and effort level on the fly — no need to dig through settings.',
		descriptionGeneric:
			'These pills let you change your AI model and effort level on the fly — no need to dig through settings.',
		descriptionContent: modelSelectorContent,
		descriptionContentGeneric: modelSelectorContent,
		wide: true,
		selector: '[data-tour="model-selector"], [data-tour="effort-selector"]',
		position: 'top',
		uiActions: [],
	},
	{
		id: 'toolbar-toggles',
		title: 'Session Controls',
		description:
			"These aren't just status indicators — they're clickable buttons that control your session behavior.",
		descriptionGeneric:
			"These aren't just status indicators — they're clickable buttons that control your session behavior.",
		descriptionContent: toolbarTogglesContent,
		descriptionContentGeneric: toolbarTogglesContent,
		wide: true,
		selector: '[data-tour="toolbar-toggles"]',
		position: 'top',
		uiActions: [],
	},
	{
		id: 'additional-tabs',
		title: 'Additional Tabs',
		description:
			'Beyond AI chat tabs, you can open other tab types right alongside your conversations.\n\nPress {{toggleMode}} to open a Terminal tab — a full shell for running commands yourself. Press {{newBrowserTab}} to open a Browser tab for web previews and research without leaving Maestro.\n\nWorking with multiple terminals? Press {{jumpToTerminal}} to instantly jump to the nearest terminal tab.',
		descriptionGeneric:
			'Beyond AI chat tabs, you can open other tab types right alongside your conversations.\n\nPress {{toggleMode}} to open a Terminal tab — a full shell for running commands yourself. Press {{newBrowserTab}} to open a Browser tab for web previews and research without leaving Maestro.\n\nWorking with multiple terminals? Press {{jumpToTerminal}} to instantly jump to the nearest terminal tab.',
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
