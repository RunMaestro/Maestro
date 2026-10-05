/**
 * Who writes each stored key of an agent, a tab, and a group (DG5, DM5).
 *
 * The runtime owns a closed list of DOMAIN keys: what an agent, an AI tab, or a group IS. Every key
 * not on a list is desktop-owned: view state, workspace state the library does not model, and the
 * turn state the desktop's own turn path produces. Desktop-owned keys round-trip through the runtime
 * untouched (DD-5), so a field the desktop adds later is desktop-owned by default and needs no change
 * here. The renderer imports these same lists to split a session into the part it sends as a command
 * and the part it folds.
 *
 * Design: `Plans/maestro-tui-desktop-migration.md` section 2.2.
 */

import { PROVIDER_OVERRIDE_KEYS } from './providerSwap';

/** The agent keys a runtime command writes. */
export const AGENT_DOMAIN_KEYS: ReadonlySet<string> = new Set([
	'id',
	'name',
	'toolType',
	'groupId',
	'cwd',
	'fullPath',
	'projectRoot',
	'createdAt',
	'bookmarked',
	'autoRunFolderPath',
	'nudgeMessage',
	'newSessionMessage',
	'sessionSshRemoteConfig',
	'additionalDirectories',
	'retryOnAvailabilityErrors',
	'retryOnTokenExhaustion',
	'codexAutoResetOnExhaustion',
	'parentSessionId',
	'worktreeBranch',
	'worktreeParentPath',
	'worktreeConfig',
	'isPianola',
	'symphonyMetadata',
	// The parked per-provider overrides, and the live ones (`customPath`, `customModel`, ...).
	'providerOverrides',
	...PROVIDER_OVERRIDE_KEYS,
]);

/**
 * The AI tab keys a runtime command writes. `aiTabs` itself (the set and the order of tabs) is
 * domain too, but it is handled structurally (`adoptTabs`, `closeTabs`, `reconcileTabOrder`), not
 * key by key.
 */
export const TAB_DOMAIN_KEYS: ReadonlySet<string> = new Set([
	'id',
	'name',
	'starred',
	'createdAt',
	'hidden',
	'consultOrigin',
	'readOnlyMode',
	'permissionMode',
	'saveToHistory',
	'showThinking',
	'enterToSend',
	'customModel',
	'customEffort',
	'providerSessions',
]);

/**
 * Tab keys that belong to ONE provider (DM9) and are written by the turn path, not by a command. A fold
 * computed before a provider swap must land them on the slot of the provider it was computed under
 * (`updateProviderSlot`), never on the provider the agent runs now. (`providerSessions` itself is
 * domain: a swap command parks and restores it.)
 */
export const PROVIDER_SCOPED_TAB_KEYS: ReadonlySet<string> = new Set([
	'agentSessionId',
	'usageStats',
	'awaitingSessionId',
]);

/** The group keys a runtime command writes. `collapsed` is the renderer's: the runtime never moves it (CO-4). */
export const GROUP_DOMAIN_KEYS: ReadonlySet<string> = new Set([
	'id',
	'name',
	'emoji',
	'icon',
	'color',
	'kind',
	'parentGroupId',
]);

export const isAgentDomainKey = (key: string): boolean => AGENT_DOMAIN_KEYS.has(key);
export const isTabDomainKey = (key: string): boolean => TAB_DOMAIN_KEYS.has(key);
export const isGroupDomainKey = (key: string): boolean => GROUP_DOMAIN_KEYS.has(key);

/** Split a record into its domain keys and its desktop-owned keys. Keys keep their order; nothing is copied deeply. */
export function splitByOwnership(
	record: Record<string, unknown>,
	isDomain: (key: string) => boolean
): { domain: Record<string, unknown>; desktop: Record<string, unknown> } {
	const domain: Record<string, unknown> = {};
	const desktop: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(record)) {
		(isDomain(key) ? domain : desktop)[key] = value;
	}
	return { domain, desktop };
}
