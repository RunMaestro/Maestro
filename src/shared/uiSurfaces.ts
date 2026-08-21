/**
 * Registry of Maestro's openable UI surfaces (modals and dashboards).
 *
 * One list, three consumers:
 *   - `maestro-cli open <surface> [--tab <tab>]` validates its argument here
 *     and prints the "you can also reach it by ..." hint from the same entry.
 *   - The main process validates the `open_modal` bridge message against it.
 *   - The renderer maps a surface id to a `ModalId` + optional tab payload.
 *
 * Keeping the discovery hints (`shortcutId`, `commandPalette`, `click`) beside
 * the routing data is the point: an agent that opens a surface for the user
 * should be able to explain, in the same breath, how to open it by hand next
 * time. Adding a modal means adding one entry here, not touching four files.
 */

/** A deep-linkable tab inside a surface. */
export interface UiSurfaceTab {
	/** Value passed to `--tab`, matching the renderer's tab id. */
	id: string;
	/** Label as it reads in the app. */
	label: string;
}

/** Encore Feature flag that must be on for a surface to exist. */
export type UiSurfaceEncoreFlag =
	| 'directorNotes'
	| 'usageStats'
	| 'symphony'
	| 'maestroCue'
	| 'concerto';

export interface UiSurface {
	/** CLI name (kebab-case), and the wire value on the `open_modal` message. */
	id: string;
	/** Human label as shown in the app. */
	label: string;
	/** Alternate names accepted by the CLI. */
	aliases?: string[];
	/** `ModalId` the renderer opens. */
	modal: string;
	/** One-line description for `open --list` and CLI help. */
	description: string;
	/** Deep-linkable tabs, when the surface has them. */
	tabs?: UiSurfaceTab[];
	/** Key into `DEFAULT_SHORTCUTS` / `FIXED_SHORTCUTS` for the hotkey hint. */
	shortcutId?: string;
	/** What to type in the command palette (Cmd+K) to reach it. */
	commandPalette?: string;
	/** Where to click to reach it. */
	click?: string;
	/** Encore Feature that gates the surface. */
	encore?: UiSurfaceEncoreFlag;
}

export const CUE_MODAL_TABS: UiSurfaceTab[] = [
	{ id: 'dashboard', label: 'Dashboard' },
	{ id: 'scheduled', label: 'Scheduled Tasks' },
	{ id: 'pipeline', label: 'Pipeline Editor' },
	{ id: 'activity', label: 'Activity Log' },
	{ id: 'backup', label: 'Backup' },
];

export const UI_SURFACES: UiSurface[] = [
	{
		id: 'concerto',
		label: 'Concerto',
		aliases: ['concerto-stage', 'stage', 'movement'],
		modal: 'concertoStage',
		description: 'The Concerto stage: agent-composed interactive views in one resizable window.',
		shortcutId: 'toggleConcerto',
		commandPalette: 'Show Concerto Stage',
		click: 'Concerto in the Left Bar hamburger menu',
		encore: 'concerto',
	},
	{
		id: 'cue',
		label: 'Maestro Cue',
		aliases: ['maestro-cue', 'cue-modal'],
		modal: 'cueModal',
		description: 'Event-driven automation: pipelines, scheduled tasks, run history.',
		tabs: CUE_MODAL_TABS,
		shortcutId: 'openCue',
		commandPalette: 'Maestro Cue',
		click: 'the lightning-bolt icon in the Left Bar footer',
		encore: 'maestroCue',
	},
	{
		id: 'settings',
		label: 'Settings',
		modal: 'settings',
		description: 'Application settings, themes, shortcuts, and Maestro Prompts.',
		tabs: [
			{ id: 'general', label: 'General' },
			{ id: 'shortcuts', label: 'Shortcuts' },
			{ id: 'theme', label: 'Theme' },
			{ id: 'notifications', label: 'Notifications' },
			{ id: 'aicommands', label: 'AI Commands' },
			{ id: 'prompts', label: 'Maestro Prompts' },
		],
		shortcutId: 'settings',
		commandPalette: 'Settings',
		click: 'the gear icon in the Left Bar footer',
	},
	{
		id: 'usage-dashboard',
		label: 'Usage Dashboard',
		aliases: ['usage', 'stats', 'dashboard'],
		modal: 'usageDashboard',
		description: 'Token, cost, and activity analytics across every agent.',
		tabs: [
			{ id: 'overview', label: 'Overview' },
			{ id: 'agent-overview', label: 'Agent Overview' },
			{ id: 'agents', label: 'Agents' },
			{ id: 'activity', label: 'Activity' },
			{ id: 'autorun', label: 'Auto Run' },
			{ id: 'cue', label: 'Cue' },
			{ id: 'shortcuts', label: 'Shortcuts' },
		],
		shortcutId: 'usageDashboard',
		commandPalette: 'Usage Dashboard',
		click: 'the chart icon in the Left Bar footer',
		encore: 'usageStats',
	},
	{
		id: 'director-notes',
		label: "Director's Notes",
		aliases: ['notes', 'directors-notes'],
		modal: 'directorNotes',
		description: 'Cross-agent history browser and AI synopsis of recent work.',
		shortcutId: 'directorNotes',
		commandPalette: "Director's Notes",
		encore: 'directorNotes',
	},
	{
		id: 'symphony',
		label: 'Maestro Symphony',
		modal: 'symphony',
		description: 'Group chat across multiple agents with a moderator.',
		shortcutId: 'openSymphony',
		commandPalette: 'Symphony',
		encore: 'symphony',
	},
	{
		id: 'shortcuts',
		label: 'Keyboard Shortcuts',
		aliases: ['keys', 'help'],
		modal: 'shortcutsHelp',
		description: 'Every keyboard shortcut, searchable.',
		shortcutId: 'help',
		commandPalette: 'Shortcuts',
	},
	{
		id: 'agent-sessions',
		label: 'Agent Sessions',
		aliases: ['sessions'],
		modal: 'agentSessions',
		description: 'Browse and resume past provider sessions for the active agent.',
		shortcutId: 'agentSessions',
		commandPalette: 'Agent Sessions',
	},
	{
		id: 'batch-runner',
		label: 'Batch Runner',
		aliases: ['batch'],
		modal: 'batchRunner',
		description: 'Run one prompt or playbook across many agents.',
		shortcutId: 'openBatchRunner',
		commandPalette: 'Batch Runner',
	},
	{
		id: 'queue-browser',
		label: 'Execution Queue',
		aliases: ['queue'],
		modal: 'queueBrowser',
		description: 'Inspect and reorder queued messages for the active agent.',
		shortcutId: 'executionQueue',
		commandPalette: 'Execution Queue',
	},
	{
		id: 'prompt-composer',
		label: 'Prompt Composer',
		aliases: ['composer'],
		modal: 'promptComposer',
		description: 'Full-screen editor for composing a long prompt.',
		shortcutId: 'openPromptComposer',
		commandPalette: 'Prompt Composer',
	},
	{
		id: 'memory-viewer',
		label: 'Memory Viewer',
		aliases: ['memory'],
		modal: 'memoryViewer',
		description: "The active agent's CLAUDE.md / AGENTS.md memory files.",
		shortcutId: 'openMemoryViewer',
		commandPalette: 'Memory',
	},
	{
		id: 'marketplace',
		label: 'Playbook Marketplace',
		aliases: ['playbooks'],
		modal: 'marketplace',
		description: 'Browse and import Auto Run playbooks from GitHub.',
		commandPalette: 'Marketplace',
		click: 'the Auto Run tab in the Right Bar, then the marketplace icon',
	},
	{
		id: 'process-monitor',
		label: 'Process Monitor',
		aliases: ['processes'],
		modal: 'processMonitor',
		description: 'Live view of every process Maestro has spawned.',
		shortcutId: 'processMonitor',
		commandPalette: 'Process Monitor',
	},
	{
		id: 'logs',
		label: 'System Log Viewer',
		aliases: ['log-viewer', 'system-logs'],
		modal: 'logViewer',
		description: "Maestro's own application logs.",
		shortcutId: 'systemLogs',
		commandPalette: 'System Logs',
	},
	{
		id: 'snoozed-tabs',
		label: 'Snoozed Tabs',
		aliases: ['snoozed'],
		modal: 'snoozedTabs',
		description: 'Tabs hidden until a chosen time, with the option to wake them now.',
		commandPalette: 'Snoozed Tabs',
	},
	{
		id: 'quick-actions',
		label: 'Quick Actions',
		aliases: ['command-palette', 'palette'],
		modal: 'quickAction',
		description: 'The command palette itself.',
		shortcutId: 'quickAction',
	},
	{
		id: 'about',
		label: 'About Maestro',
		modal: 'about',
		description: 'Version, build info, and lifetime stats.',
		commandPalette: 'About',
		click: 'the Maestro menu → About Maestro',
	},
];

/** Every valid `--tab` value for a surface, or an empty array when it has none. */
export function surfaceTabIds(surface: UiSurface): string[] {
	return (surface.tabs ?? []).map((tab) => tab.id);
}

/**
 * Resolve a CLI name (id or alias, case-insensitive) to a surface.
 * Returns `null` when nothing matches - callers print the valid list.
 */
export function resolveUiSurface(name: string): UiSurface | null {
	const needle = name.trim().toLowerCase();
	if (needle.length === 0) return null;
	return (
		UI_SURFACES.find(
			(surface) =>
				surface.id === needle || (surface.aliases ?? []).some((alias) => alias === needle)
		) ?? null
	);
}

/**
 * Resolve a `--tab` value against a surface. Matches the tab id first, then
 * the label case-insensitively so `--tab "Scheduled Tasks"` works too.
 */
export function resolveUiSurfaceTab(surface: UiSurface, tab: string): UiSurfaceTab | null {
	const needle = tab.trim().toLowerCase();
	if (needle.length === 0) return null;
	return (
		(surface.tabs ?? []).find(
			(entry) => entry.id.toLowerCase() === needle || entry.label.toLowerCase() === needle
		) ?? null
	);
}

/**
 * Build the "you can also get there by ..." sentence for a surface. The CLI
 * prints this after opening so the agent relaying the result can teach the
 * user the manual paths. `shortcut` is the already-formatted hotkey (the
 * caller owns platform detection); omit it when the surface has none.
 */
export function describeSurfaceAccess(surface: UiSurface, shortcut?: string): string {
	const paths: string[] = [];
	if (shortcut) paths.push(`press ${shortcut}`);
	if (surface.commandPalette) {
		paths.push(`open the command palette and search "${surface.commandPalette}"`);
	}
	if (surface.click) paths.push(`click ${surface.click}`);
	if (paths.length === 0) return '';
	return `You can also reach ${surface.label} yourself: ${paths.join(', or ')}.`;
}
