import type { PluginCategory } from '../plugins/plugin-manifest';
import type { PermissionRequest } from '../plugins/permissions';

/** Stable first-party plugin identity for Pianola's plugin-backed Encore surface. */
export const PIANOLA_FIRST_PARTY_PLUGIN_ID = 'com.maestro.pianola';

/** Broker capabilities Pianola's supervised manager flow actually depends on. */
export const PIANOLA_FIRST_PARTY_PLUGIN_PERMISSIONS: readonly PermissionRequest[] = [
	{
		capability: 'settings:read',
		reason: 'Re-read the Pianola Encore consent flag before every supervised action.',
	},
	{
		capability: 'agents:read',
		reason: 'List agent sessions and status so Pianola can detect who is awaiting input.',
	},
	{
		capability: 'transcripts:read',
		reason: 'Read projected agent transcript content to classify waiting prompts and risk.',
	},
	{
		capability: 'agents:dispatch',
		reason: 'Send an approved low-risk answer to the waiting agent after an audit record exists.',
	},
	{
		capability: 'decisions:write',
		reason: 'Record Pianola decisions before any dispatch and record the dispatch outcome.',
	},
	{
		capability: 'notifications:toast',
		reason: 'Escalate uncovered, failed, timed-out, or high-risk prompts to the user.',
	},
	{
		capability: 'background:service',
		reason:
			'Run supervised watch/orchestrate and scheduled re-learn work with host lifecycle control.',
	},
] as const;

export interface PianolaFirstPartyPluginMetadata {
	id: typeof PIANOLA_FIRST_PARTY_PLUGIN_ID;
	name: 'Pianola';
	description: string;
	firstParty: true;
	category: PluginCategory;
	permissions: readonly PermissionRequest[];
	settings: {
		/** Existing Encore feature flag that authorizes the first-party surface. */
		encoreFlag: 'pianola';
		/** Namespace used by Pianola-specific settings/storage surfaces. */
		namespace: 'pianola';
	};
	backgroundService: {
		id: 'pianola.supervisor';
		kind: 'supervised';
		description: string;
	};
}

/**
 * First-party plugin-backed manifest for the built-in Pianola Encore feature.
 *
 * This is intentionally metadata, not an installed third-party plugin.json: the
 * code still runs through Pianola's host-owned supervisor and brokered IPC
 * seams, while the marketplace can expose the same category/permissions/service
 * shape users expect from plugin-backed features.
 */
export const PIANOLA_FIRST_PARTY_PLUGIN_METADATA: PianolaFirstPartyPluginMetadata = {
	id: PIANOLA_FIRST_PARTY_PLUGIN_ID,
	name: 'Pianola',
	description:
		'Autonomous manager agent that watches your agents and auto-answers or escalates prompts.',
	firstParty: true,
	category: 'agents',
	permissions: PIANOLA_FIRST_PARTY_PLUGIN_PERMISSIONS,
	settings: { encoreFlag: 'pianola', namespace: 'pianola' },
	backgroundService: {
		id: 'pianola.supervisor',
		kind: 'supervised',
		description: 'Supervises Pianola watch/orchestrate targets and stops them when consent is off.',
	},
};
