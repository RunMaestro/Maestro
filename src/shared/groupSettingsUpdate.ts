/**
 * The wire shape of a Group Settings write that arrives from outside the
 * Group Settings dialog (`maestro-cli update-group-settings`, the web bridge).
 *
 * The dialog builds a whole profile from its form. A caller that types flags
 * sends a PATCH instead, in the vocabulary `update-agent` already uses
 * (`configPatch`, where `null` clears a field, and `sshPatch`), and the app
 * folds it into the form the dialog would hold for the group, then builds the
 * profile with the dialog's own validator. So a flag and a click cannot store
 * different things, and what a launch would refuse is refused here.
 *
 * Pure and dependency-free: the WebSocket boundary validates the shape with
 * `parseGroupSettingsUpdateRequest`, the app validates the values.
 */

import type { GroupAgentDefaults } from './types';

/**
 * Every key a `configPatch` may carry. Anything else is refused by name rather
 * than ignored, so a typo in a script is an error and not a setting that
 * silently never applied.
 *
 * `contextWindowSource` rides with `customContextWindow` on `update-agent`; a
 * group stores no provenance, so it is accepted and dropped.
 */
export const GROUP_SETTINGS_PATCH_KEYS = [
	'projectRoot',
	'newSessionMessage',
	'nudgeMessage',
	'toolType',
	'customPath',
	'customArgs',
	'customModel',
	'customEffort',
	'customContextWindow',
	'contextWindowSource',
	'enableMaestroP',
	'maestroPMode',
	'maestroPPath',
	'codexTransport',
	'runOn',
	'tierTargets',
	'backgroundRequests',
	'systemOneOptOut',
	'gatewayUrl',
	'tokenProxyMode',
	'customEnvVars',
	'peerAgentEdits',
	'groupPeerAccess',
	'worktreePeerAccess',
] as const;

export type GroupSettingsPatchKey = (typeof GROUP_SETTINGS_PATCH_KEYS)[number];

/** The keys of an SSH patch, as `update-agent --ssh-*` builds it. */
export const GROUP_SETTINGS_SSH_PATCH_KEYS = [
	'enabled',
	'remoteId',
	'workingDirOverride',
	'syncHistory',
] as const;

/** One write to a group's profile. Every field is optional; at least one must be present. */
export interface GroupSettingsUpdateRequest {
	/** Defaults to set, by `update-agent`'s key names. `null` clears one. */
	configPatch?: Record<string, unknown>;
	/** The SSH half of the profile, merged onto the stored one. */
	sshPatch?: Record<string, unknown>;
	/** The pill label. An empty string clears it back to the automatic abbreviation. */
	shortLabel?: string;
	/** Remove the profile entirely. Never touches `shortLabel`. */
	clearDefaults?: boolean;
	/** Also write this save's change into the agents already in the group. */
	publish?: boolean;
}

/** What a publish did, in the names a person reads. */
export interface GroupSettingsPublishReport {
	/** The agents whose record changed. */
	agents: Array<{ id: string; name: string }>;
	/** A change that reached no agent, or one agent, and why. */
	skipped: Array<{ agentName: string; label: string; reason: string }>;
	/** The defaults this save changed that a publish may write. */
	changed: string[];
	/** The defaults this save changed that only a NEW agent receives. */
	unpublished: string[];
	/** Lists the publish replaced outright on each agent. */
	replaced: string[];
	/** Changes that reach only the agents on the profile's provider. */
	providerBound: string[];
}

export interface GroupSettingsUpdateResult {
	success: boolean;
	error?: string;
	/** The group's profile after the write. `null` when it holds none. */
	defaults?: GroupAgentDefaults | null;
	/** The group's pill label after the write. `null` when it holds none. */
	shortLabel?: string | null;
	/** Names of the defaults this write changed, in form order. */
	changed?: string[];
	/** Present only when `publish` was requested. */
	publish?: GroupSettingsPublishReport;
}

export type GroupSettingsUpdateParse =
	| { ok: true; request: GroupSettingsUpdateRequest }
	| { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unknownKeys(record: Record<string, unknown>, allowed: readonly string[]): string[] {
	return Object.keys(record).filter((key) => !allowed.includes(key));
}

/**
 * Read a request that arrived over a wire into a `GroupSettingsUpdateRequest`,
 * or say what is wrong with its shape. Values are not judged here: whether a
 * model, a tier or a gateway is acceptable depends on the profile's provider,
 * which only the app can see.
 */
export function parseGroupSettingsUpdateRequest(raw: unknown): GroupSettingsUpdateParse {
	if (!isRecord(raw)) return { ok: false, error: 'A group settings update must be an object.' };
	const request: GroupSettingsUpdateRequest = {};

	if (raw.configPatch !== undefined) {
		if (!isRecord(raw.configPatch)) {
			return { ok: false, error: 'configPatch must be an object.' };
		}
		const unknown = unknownKeys(raw.configPatch, GROUP_SETTINGS_PATCH_KEYS);
		if (unknown.length > 0) {
			return {
				ok: false,
				error: `Not a group default: ${unknown.join(', ')}. A group holds ${GROUP_SETTINGS_PATCH_KEYS.join(', ')}.`,
			};
		}
		if (Object.keys(raw.configPatch).length > 0) request.configPatch = raw.configPatch;
	}

	if (raw.sshPatch !== undefined) {
		if (!isRecord(raw.sshPatch)) return { ok: false, error: 'sshPatch must be an object.' };
		const unknown = unknownKeys(raw.sshPatch, GROUP_SETTINGS_SSH_PATCH_KEYS);
		if (unknown.length > 0) {
			return { ok: false, error: `Not an SSH setting: ${unknown.join(', ')}.` };
		}
		if (Object.keys(raw.sshPatch).length > 0) request.sshPatch = raw.sshPatch;
	}

	if (raw.shortLabel !== undefined) {
		if (typeof raw.shortLabel !== 'string') {
			return { ok: false, error: 'shortLabel must be a string.' };
		}
		request.shortLabel = raw.shortLabel;
	}

	for (const key of ['clearDefaults', 'publish'] as const) {
		const value = raw[key];
		if (value === undefined) continue;
		if (typeof value !== 'boolean') return { ok: false, error: `${key} must be true or false.` };
		if (value) request[key] = true;
	}

	if (request.clearDefaults && (request.configPatch || request.sshPatch)) {
		return {
			ok: false,
			error:
				'Clearing the defaults and setting some in the same call is ambiguous. Do one, then the other.',
		};
	}
	if (request.clearDefaults && request.publish) {
		return {
			ok: false,
			error:
				'A publish writes values into agents, and clearing the defaults has none to write. Clear on its own.',
		};
	}
	if (
		request.configPatch === undefined &&
		request.sshPatch === undefined &&
		request.shortLabel === undefined &&
		!request.clearDefaults
	) {
		return { ok: false, error: 'Nothing to update' };
	}
	return { ok: true, request };
}
