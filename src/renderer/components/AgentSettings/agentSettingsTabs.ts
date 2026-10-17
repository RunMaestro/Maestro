/**
 * agentSettingsTabs - the tab set of the agent settings form (New Agent, Edit
 * Agent, and the Group Chat moderator config), and the map from a validation
 * field to the tab that holds it.
 *
 * The strip renders a dot on every tab whose panel holds an error, and a Save
 * attempt with errors jumps to `firstTabWithError()`, so a user on the SSH tab
 * with an empty name is never left facing a dead Save button.
 */

import {
	BrainCircuit,
	Cpu,
	ScrollText,
	Server,
	SlidersHorizontal,
	Terminal,
	Users,
} from 'lucide-react';
import type { ModalTab } from '../ui/ModalTabStrip';
import {
	AGENT_SETTINGS_TAB_IDS,
	AGENT_SETTINGS_TAB_LABELS,
	type AgentSettingsTabId as LinkableAgentSettingsTabId,
} from '../../../shared/agentSettingsTabs';

/**
 * The Audit Log tab, the one tab that is NOT in the shared list, on purpose.
 *
 * The shared list is what `maestro-cli open agent-settings --tab` offers and
 * what `open --list` prints, and the feature behind this tab is hidden from
 * agents (read the header of `src/shared/cotExport/types.ts`). So the tab has
 * no deep link and no name outside the renderer. Only Edit Agent draws it, and
 * only where `isCotExportAvailable()` says the desktop app offers the feature.
 * Do not move this id into `src/shared/agentSettingsTabs.ts`.
 */
export const AUDIT_LOG_TAB_ID = 'auditLog';

/** A tab of the form: one the CLI can link to, or the Audit Log tab. */
export type AgentSettingsTabId = LinkableAgentSettingsTabId | typeof AUDIT_LOG_TAB_ID;

const LINKABLE_TAB_ICONS: Readonly<Record<LinkableAgentSettingsTabId, ModalTab['icon']>> = {
	general: SlidersHorizontal,
	provider: Cpu,
	models: BrainCircuit,
	environment: Terminal,
	peers: Users,
	ssh: Server,
};

/**
 * Every tab, in strip order. A surface shows the subset it supports. The ids
 * and labels are the shared list `maestro-cli open agent-settings --tab` reads,
 * then the Audit Log tab, which that list must never hold.
 */
export const AGENT_SETTINGS_TABS: readonly ModalTab<AgentSettingsTabId>[] = [
	...AGENT_SETTINGS_TAB_IDS.map((id) => ({
		id,
		label: AGENT_SETTINGS_TAB_LABELS[id],
		icon: LINKABLE_TAB_ICONS[id],
	})),
	{ id: AUDIT_LOG_TAB_ID, label: 'Audit Log', icon: ScrollText },
];

/** New Agent and Group Settings show every tab the CLI can link to. */
export const AGENT_FORM_TAB_IDS: readonly AgentSettingsTabId[] = AGENT_SETTINGS_TAB_IDS;

/**
 * Edit Agent where the desktop app offers the audit log: the form's tabs, then
 * Audit Log. It needs an agent that exists, so New Agent never shows it.
 */
export const EDIT_AGENT_TAB_IDS: readonly AgentSettingsTabId[] = [
	...AGENT_FORM_TAB_IDS,
	AUDIT_LOG_TAB_ID,
];

/** The moderator has no gateway (no Models tab) and a group chat has no peers. */
export const MODERATOR_TAB_IDS: readonly AgentSettingsTabId[] = [
	'general',
	'provider',
	'environment',
	'ssh',
];

/**
 * The tab each validation field lives on. Keys are the field ids the modals
 * report (`SessionValidationResult.errorField` uses `name` and `directory`).
 * A field missing from this map is ignored by `firstTabWithError()`.
 */
export const AGENT_SETTINGS_FIELD_TAB: Readonly<Record<string, AgentSettingsTabId>> = {
	name: 'general',
	group: 'general',
	// The Group Chat moderator picker sits on General, beside the chat name.
	moderator: 'general',
	directory: 'general',
	workingDir: 'general',
	additionalDirectories: 'general',
	newSessionMessage: 'general',
	nudgeMessage: 'general',
	provider: 'provider',
	customPath: 'provider',
	customArgs: 'provider',
	model: 'provider',
	effort: 'provider',
	contextWindow: 'provider',
	gateway: 'models',
	gatewayUrl: 'models',
	tokenProxyMode: 'models',
	runOn: 'models',
	tierTargets: 'models',
	backgroundRequests: 'models',
	systemOne: 'models',
	envVars: 'environment',
	peers: 'peers',
	sshRemote: 'ssh',
	remoteWorkingDir: 'ssh',
};

/** The tabs, out of `visibleTabs`, whose panels hold at least one of `errorFields`. */
export function tabsWithErrors(
	errorFields: readonly string[],
	visibleTabs: readonly AgentSettingsTabId[]
): Set<AgentSettingsTabId> {
	const visible = new Set(visibleTabs);
	const result = new Set<AgentSettingsTabId>();
	for (const field of errorFields) {
		const tab = AGENT_SETTINGS_FIELD_TAB[field];
		if (tab && visible.has(tab)) result.add(tab);
	}
	return result;
}

/**
 * The first tab, in `visibleTabs` order, that holds an error, or `null` when
 * none does. A Save attempt switches here before showing the error.
 */
export function firstTabWithError(
	errorFields: readonly string[],
	visibleTabs: readonly AgentSettingsTabId[]
): AgentSettingsTabId | null {
	const withErrors = tabsWithErrors(errorFields, visibleTabs);
	return visibleTabs.find((tab) => withErrors.has(tab)) ?? null;
}

/** The strip's tabs for one surface, in strip order, with `hasError` set from `errorFields`. */
export function buildAgentSettingsTabs(
	visibleTabs: readonly AgentSettingsTabId[],
	errorFields: readonly string[] = []
): ModalTab<AgentSettingsTabId>[] {
	const visible = new Set(visibleTabs);
	const withErrors = tabsWithErrors(errorFields, visibleTabs);
	return AGENT_SETTINGS_TABS.filter((tab) => visible.has(tab.id)).map((tab) => ({
		...tab,
		hasError: withErrors.has(tab.id),
	}));
}
