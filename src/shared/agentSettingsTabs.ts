/**
 * The tabs of the agent settings form (New Agent, Edit Agent, Group Settings,
 * and the Group Chat moderator config), as ids and labels.
 *
 * Two readers. The renderer draws the strip from them and adds the icons
 * (`renderer/components/AgentSettings/agentSettingsTabs.ts`). The surface
 * registry (`uiSurfaces.ts`) offers them as the `--tab` values of
 * `maestro-cli open agent-settings`. One list, so a renamed or added tab
 * cannot leave the CLI with a deep link the form does not have.
 */

/** Every tab, in strip order. A surface shows the subset it supports. */
export const AGENT_SETTINGS_TAB_IDS = ['general', 'provider', 'models', 'peers', 'ssh'] as const;

export type AgentSettingsTabId = (typeof AGENT_SETTINGS_TAB_IDS)[number];

/** What each tab is called, on the strip and in a sentence. */
export const AGENT_SETTINGS_TAB_LABELS: Readonly<Record<AgentSettingsTabId, string>> =
	Object.freeze({
		general: 'General',
		provider: 'Provider',
		models: 'Models',
		peers: 'Peers',
		ssh: 'SSH',
	});
