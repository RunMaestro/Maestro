/**
 * Registry of Maestro's openable UI surfaces (modals and dashboards).
 *
 * One list, three consumers:
 *   - `maestro-cli open <surface> [--tab <tab>] [--group <id>] [--agent <id>]`
 *     validates its arguments here and prints the "you can also reach it by
 *     ..." hint from the same entry.
 *   - The main process validates the `open_modal` bridge message against it.
 *   - The renderer maps a surface id to a `ModalId` + optional tab payload.
 *
 * Keeping the discovery hints (`shortcutId`, `commandPalette`, `click`) beside
 * the routing data is the point: an agent that opens a surface for the user
 * should be able to explain, in the same breath, how to open it by hand next
 * time. Adding a modal means adding one entry here, not touching four files.
 */

import { AGENT_SETTINGS_TAB_IDS, AGENT_SETTINGS_TAB_LABELS } from './agentSettingsTabs';
import { resolveEncoreFeatures } from './encoreFeatureDefaults';
import {
	MODELS_SETTINGS_SUB_TAB_PATHS,
	modelsSettingsPlaceLabel,
	parseModelsSettingsSubTab,
} from './local-models/settings-location';

/** A deep-linkable tab inside a surface. */
export interface UiSurfaceTab {
	/** Value passed to `--tab`, matching the renderer's tab id. */
	id: string;
	/** Label as it reads in the app. */
	label: string;
	/** Encore Feature that must be on for this tab to exist. */
	encore?: UiSurfaceEncoreFlag;
	/** Retired or alternate ids that still resolve to this tab (a renamed tab keeps its old deep link). */
	aliases?: string[];
	/** Deep-linkable tabs inside this tab, passed as `--sub-tab`. */
	subTabs?: UiSurfaceTab[];
}

/** What `maestro-cli open` asks the app to open: a surface, and where inside it. */
export interface OpenUiSurfaceRequest {
	surface: string;
	tab?: string;
	subTab?: string;
	/** The agent group to open the surface on. Only a surface with `groupClick` takes one. */
	group?: string;
	/** The agent whose surface this is. Only a surface with `agentClick` takes one. */
	agent?: string;
}

/** Where inside a surface an open request lands, once validated. */
export interface UiSurfaceTarget {
	tab?: UiSurfaceTab;
	subTab?: UiSurfaceTab;
	/** A group id, passed through as given: the registry knows no groups. */
	group?: string;
	/** An agent id, passed through as given: the registry knows no agents. */
	agent?: string;
}

/** Encore Feature flag that must be on for a surface to exist. */
export type UiSurfaceEncoreFlag =
	| 'directorNotes'
	| 'usageStats'
	| 'symphony'
	| 'maestroCue'
	| 'concerto'
	| 'aCappella'
	| 'computerHistory'
	| 'quickChat'
	| 'throughputGauge';

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
	/**
	 * Present when the surface can open on ONE agent group (`--group`): where to
	 * click to get that by hand. Absent, `--group` is refused for the surface.
	 */
	groupClick?: string;
	/**
	 * The surface exists only for one group, so it cannot open without `--group`.
	 * Implies {@link groupClick}.
	 */
	groupRequired?: boolean;
	/**
	 * Present when the surface is ONE agent's (`--agent`): where to click to get
	 * it by hand. Such a surface cannot open without an agent, and the caller
	 * names it: a hotkey acts on the agent the user is looking at, which a CLI
	 * caller cannot see. Absent, `--agent` is refused for the surface.
	 */
	agentClick?: string;
	/** Encore Feature that gates the surface. */
	encore?: UiSurfaceEncoreFlag;
}

/**
 * The places inside Settings > Models, from the one list the tab itself draws:
 * each panel (`gateway`) and each Library section (`library/speech`).
 */
export const MODELS_SETTINGS_SUB_TABS: UiSurfaceTab[] = MODELS_SETTINGS_SUB_TAB_PATHS.map((id) => {
	const place = parseModelsSettingsSubTab(id)!;
	return { id, label: modelsSettingsPlaceLabel(place.panel, place.librarySection) };
});

/** The tabs of the agent settings form, from the one list the form itself draws. */
export const AGENT_SETTINGS_SURFACE_TABS: UiSurfaceTab[] = AGENT_SETTINGS_TAB_IDS.map((id) => ({
	id,
	label: AGENT_SETTINGS_TAB_LABELS[id],
}));

export const CUE_MODAL_TABS: UiSurfaceTab[] = [
	{ id: 'dashboard', label: 'Dashboard' },
	{ id: 'scheduled', label: 'Scheduled Tasks' },
	{ id: 'pipeline', label: 'Pipeline Graph' },
	{ id: 'pipeline-list', label: 'Pipeline List' },
	{ id: 'activity', label: 'Activity Log' },
	{ id: 'backup', label: 'Backup' },
	{ id: 'bundles', label: 'Bundles' },
	{ id: 'readiness', label: 'Readiness' },
];

export const UI_SURFACES: UiSurface[] = [
	{
		id: 'notification-center',
		shortcutId: 'openNotificationCenter',
		label: 'Notification Center',
		aliases: ['inbox'],
		modal: 'notificationCenter',
		description: 'Persistent notification history and unread entries.',
		commandPalette: 'Open Notification Center',
		click: 'the bell in the Left Bar header (Settings → Notifications → Notification center)',
	},
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
		id: 'voice-setup',
		label: 'Voice Setup',
		aliases: ['voice-models', 'acappella-setup', 'a-cappella-setup'],
		modal: 'voiceSetup',
		description:
			'Download the speech recognition and speech synthesis models voice runs on, with every size and licence listed before anything is fetched.',
		commandPalette: 'Set Up Voice Models',
		click: 'Settings -> Plugins -> A Cappella',
		encore: 'aCappella',
	},
	{
		id: 'settings',
		label: 'Settings',
		modal: 'settings',
		description: 'Application settings, themes, shortcuts, and Maestro Prompts.',
		tabs: [
			{ id: 'general', label: 'General' },
			{ id: 'display', label: 'Display' },
			{ id: 'shortcuts', label: 'Shortcuts' },
			{ id: 'theme', label: 'Theme' },
			{ id: 'notifications', label: 'Notifications' },
			{ id: 'aicommands', label: 'AI Commands' },
			{ id: 'prompts', label: 'Maestro Prompts' },
			{
				id: 'models',
				label: 'Models',
				aliases: ['local-models'],
				subTabs: MODELS_SETTINGS_SUB_TABS,
			},
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
			{ id: 'models', label: 'Models' },
			{ id: 'activity', label: 'Activity' },
			{ id: 'autorun', label: 'Auto Run' },
			{ id: 'cue', label: 'Cue', encore: 'maestroCue' },
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
		id: 'computer-history',
		label: 'Computer History',
		aliases: ['history-viewer', 'screen-history'],
		modal: 'computerHistory',
		description:
			'Browse and search what Computer History recorded: app timeline, typed text, selections, digests, and which apps are recorded.',
		shortcutId: 'computerHistory',
		commandPalette: 'Computer History',
		click: 'the hamburger menu > Computer History',
		encore: 'computerHistory',
	},
	{
		id: 'delegation-graph',
		label: 'Delegation Graph',
		aliases: ['delegation', 'delegations', 'peer-graph', 'peers-graph'],
		modal: 'delegationGraph',
		description:
			'Which agent can consult or delegate to which, drawn as a graph. Opens in View; Edit draws, changes and removes an edge. --group opens it on one group.',
		shortcutId: 'openDelegationGraph',
		commandPalette: 'Delegation Graph',
		click: 'the hamburger menu > Delegation Graph',
		groupClick: 'right-click the group in the Left Bar > Delegation Graph',
	},
	{
		id: 'group-settings',
		label: 'Group Settings',
		aliases: ['group-defaults'],
		modal: 'groupSettings',
		description:
			"One group's defaults for new agents, its pill label, and Publish to existing agents. Needs --group. Read and write the same settings with group-settings and update-group-settings.",
		commandPalette: 'Group Settings',
		groupClick: 'right-click the group in the Left Bar > Group Settings',
		groupRequired: true,
	},
	{
		id: 'agent-settings',
		label: 'Edit Agent',
		aliases: ['edit-agent'],
		modal: 'editAgent',
		description:
			"One agent's settings form: General, Provider, Models, Environment, Peers and SSH. Needs --agent. Read and write the same fields with show agent and update-agent.",
		tabs: AGENT_SETTINGS_SURFACE_TABS,
		shortcutId: 'agentSettings',
		commandPalette: 'Edit Agent',
		agentClick: 'right-click the agent in the Left Bar > Edit Agent',
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
		description:
			"The active agent's persistent memory files (Claude Code per project, Codex per account).",
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
		id: 'tab-cleanup',
		label: 'Tab Cleanup Suggestions',
		aliases: ['tab-cleanup-suggestions', 'cleanup'],
		modal: 'tabCleanup',
		description:
			'Tabs a local model suggests closing, snoozing, or waking. Nothing changes until you tick a row and press Apply.',
		shortcutId: 'tabCleanupSuggestions',
		commandPalette: 'Tab Cleanup Suggestions',
		click: 'the hamburger menu at the top of the Left Bar',
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
		// Not a modal: Quick Chat is its own floating window, opened through the
		// main process (see openUiSurface). Its hotkey is system-wide and lives in
		// the Quick Chat settings rather than DEFAULT_SHORTCUTS, so no shortcutId.
		id: 'quick-chat',
		label: 'Quick Chat',
		aliases: ['quickchat'],
		modal: 'quickChat',
		description:
			'The floating chat window with one agent, also summoned from any app by its system-wide hotkey.',
		commandPalette: 'Open Quick Chat',
		click: 'Quick Chat in the Left Bar hamburger menu',
		encore: 'quickChat',
	},
	{
		// Not a modal: the gauge is a floating card owned by its own store, shown
		// through that store (see openUiSurface) so it never takes focus.
		id: 'throughput-gauge',
		label: 'Throughput Gauge',
		aliases: ['gauge', 'tokens-per-second', 'tps'],
		modal: 'throughputGauge',
		description: 'The floating gauge of live tokens per second across your agents.',
		shortcutId: 'toggleThroughputGauge',
		commandPalette: 'Show Throughput Gauge',
		click: 'Throughput Gauge in the Left Bar hamburger menu',
		encore: 'throughputGauge',
	},
	{
		id: 'feedback',
		label: 'Send Feedback',
		aliases: ['send-feedback', 'bug-report'],
		modal: 'feedback',
		description: 'Report a bug or suggest a feature; files a GitHub issue via gh.',
		commandPalette: 'Send Feedback',
		click: 'the Feedback button at the bottom of the Left Bar',
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

function matchUiSurfaceTab(tabs: UiSurfaceTab[] | undefined, name: string): UiSurfaceTab | null {
	const needle = name.trim().toLowerCase();
	if (needle.length === 0) return null;
	return (
		(tabs ?? []).find(
			(entry) =>
				entry.id.toLowerCase() === needle ||
				entry.label.toLowerCase() === needle ||
				(entry.aliases ?? []).some((alias) => alias.toLowerCase() === needle)
		) ?? null
	);
}

/**
 * Resolve a `--tab` value against a surface. Matches the tab id first, then
 * the label case-insensitively so `--tab "Scheduled Tasks"` works too, then
 * any alias so a renamed tab keeps its old deep link.
 */
export function resolveUiSurfaceTab(surface: UiSurface, tab: string): UiSurfaceTab | null {
	return matchUiSurfaceTab(surface.tabs, tab);
}

/** Resolve a `--sub-tab` value against the tab it sits inside, by the same rules as `--tab`. */
export function resolveUiSurfaceSubTab(tab: UiSurfaceTab, subTab: string): UiSurfaceTab | null {
	return matchUiSurfaceTab(tab.subTabs, subTab);
}

/** Every valid `--sub-tab` value for a tab, or an empty array when it has none. */
export function surfaceSubTabIds(tab: UiSurfaceTab): string[] {
	return (tab.subTabs ?? []).map((entry) => entry.id);
}

/**
 * Validate the `tab`, `subTab`, `group` and `agent` of an open request against
 * a surface. One function for the CLI and the main-process handler, so the two
 * cannot disagree about what a valid deep link is. `subTab` without `tab` is
 * refused: a sub-tab only means something inside a tab. `group` is refused on
 * a surface that does not open on a group, and `agent` on one that is not an
 * agent's; whether the group or the agent EXISTS is the caller's question,
 * since the registry knows neither.
 */
export function resolveUiSurfaceTarget(
	surface: UiSurface,
	request: { tab?: string; subTab?: string; group?: string; agent?: string }
): UiSurfaceTarget | { error: string } {
	const { group, agent } = request;
	if (group !== undefined && !surface.groupClick) {
		return { error: `${surface.label} does not open on one group, so --group does not apply.` };
	}
	if (group === undefined && surface.groupRequired) {
		return { error: `${surface.label} opens on one group: pass --group <id>.` };
	}
	if (agent !== undefined && !surface.agentClick) {
		return { error: `${surface.label} is not one agent's, so --agent does not apply.` };
	}
	if (agent === undefined && surface.agentClick) {
		return { error: `${surface.label} opens on one agent: pass --agent <id>.` };
	}
	const target = resolveUiSurfaceTabTarget(surface, request);
	if ('error' in target) return target;
	return {
		...target,
		...(group !== undefined ? { group } : {}),
		...(agent !== undefined ? { agent } : {}),
	};
}

function resolveUiSurfaceTabTarget(
	surface: UiSurface,
	request: { tab?: string; subTab?: string }
): { tab?: UiSurfaceTab; subTab?: UiSurfaceTab } | { error: string } {
	const { tab: tabName, subTab: subTabName } = request;
	if (tabName === undefined) {
		return subTabName === undefined
			? {}
			: { error: '--sub-tab needs --tab: a sub-tab is a tab inside a tab.' };
	}
	const tab = resolveUiSurfaceTab(surface, tabName);
	if (!tab) {
		const valid = surfaceTabIds(surface);
		return {
			error:
				valid.length > 0
					? `Unknown tab "${tabName}" for ${surface.label}. Valid tabs: ${valid.join(', ')}`
					: `${surface.label} has no tabs, so --tab does not apply.`,
		};
	}
	if (subTabName === undefined) return { tab };
	const subTab = resolveUiSurfaceSubTab(tab, subTabName);
	if (!subTab) {
		const valid = surfaceSubTabIds(tab);
		return {
			error:
				valid.length > 0
					? `Unknown sub-tab "${subTabName}" for ${surface.label} > ${tab.label}. Valid sub-tabs: ${valid.join(', ')}`
					: `${surface.label} > ${tab.label} has no sub-tabs, so --sub-tab does not apply.`,
		};
	}
	return { tab, subTab };
}

/** Refuse a surface or tab while its Encore Feature is off. */
export function uiSurfaceRefusal(
	surface: UiSurface,
	tab: UiSurfaceTab | null | undefined,
	encoreFeatures: unknown
): string | null {
	const flags = resolveEncoreFeatures(encoreFeatures);
	if (surface.encore && !flags[surface.encore])
		return `${surface.label} is turned off. Turn it on in Settings → Plugins.`;
	if (tab?.encore && !flags[tab.encore])
		return `The ${tab.label} tab of ${surface.label} is turned off. Turn it on in Settings → Plugins.`;
	return null;
}

/** Surface-only gate for callers without a tab. */
export function surfaceEncoreRefusal(surface: UiSurface, encoreFeatures: unknown): string | null {
	return uiSurfaceRefusal(surface, undefined, encoreFeatures);
}

/**
 * Build the "you can also get there by ..." sentence for a surface. The CLI
 * prints this after opening so the agent relaying the result can teach the
 * user the manual paths. `shortcut` is the already-formatted hotkey (the
 * caller owns platform detection); omit it when the surface has none. A target
 * with a `group` adds the surface's own way to open on one group, and a target
 * with an `agent` the way to open it on an agent other than the selected one.
 */
export function describeSurfaceAccess(
	surface: UiSurface,
	shortcut?: string,
	target?: UiSurfaceTarget
): string {
	const paths: string[] = [];
	if (shortcut) paths.push(`press ${shortcut}`);
	if (surface.commandPalette) {
		paths.push(`open the command palette and search "${surface.commandPalette}"`);
	}
	if (surface.click) paths.push(`click ${surface.click}`);
	if (paths.length === 0) return '';
	const where = [target?.tab?.label, target?.subTab?.label].filter(Boolean).join(' > ');
	const inside = where ? `, then pick ${where}` : '';
	const forGroup =
		target?.group !== undefined && surface.groupClick
			? ` For one group: ${surface.groupClick}.`
			: '';
	const forAgent =
		target?.agent !== undefined && surface.agentClick
			? ` For any agent: ${surface.agentClick}.`
			: '';
	return `You can also reach ${surface.label} yourself: ${paths.join(', or ')}${inside}.${forGroup}${forAgent}`;
}
