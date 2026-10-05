/**
 * The runtime command an Edit Agent save becomes (Phase 9, task 4).
 *
 * Edit Agent hands `handleSaveEditAgent` the whole form: every field, set or not. With the library
 * runtime hosted the save is one `agents.update`, so this turns the form into an `AgentPatch` that names
 * only what changed. A patch field that equals what the agent already has would be a no-op the runtime
 * discards, but leaving it out keeps the receipt (`applied`) honest and the write free.
 *
 * The one exception is a provider change. The runtime parks the outgoing provider's overrides and restores
 * the incoming provider's before it applies the config fields, and the form seeded those fields from what
 * the incoming provider parked (`providerOverridesFor`), so they ARE the new provider's configuration: they
 * are all sent, whatever the live fields hold.
 *
 * Blank means unset: a field the form left empty arrives as `undefined`, and the patch says `null` so the
 * runtime clears it, as the renderer's own save does by writing `undefined`.
 */

import { valuesEqual } from '../../shared/maestro-lib/client/mirror';
import type { AgentPatch, AgentSshSettings } from '../../shared/maestro-lib/client/types';
import { providerOverridesFor } from '../../shared/maestro-lib/agents/providerSwap';
import type { AdditionalDirectory, Session } from '../types';
import type { ToolType } from '../../shared/types';

/** What Edit Agent saves, by name. The positional form of `handleSaveEditAgent` maps onto it one to one. */
export interface AgentEditForm {
	name: string;
	/** Present only when the provider changed. */
	toolType?: ToolType;
	nudgeMessage?: string;
	newSessionMessage?: string;
	customPath?: string;
	customArgs?: string;
	customEnvVars?: Record<string, string>;
	customEnvVarsDisabled?: Record<string, string>;
	customModel?: string;
	customEffort?: string;
	customContextWindow?: number;
	/** `'user-edited'` only for a value the person moved off the seed. */
	contextWindowSource?: 'user-edited';
	sessionSshRemoteConfig?: {
		enabled: boolean;
		remoteId: string | null;
		workingDirOverride?: string;
		syncHistory?: boolean;
		shareHistoryToProjectDir?: boolean;
	};
	enableMaestroP?: boolean;
	maestroPPath?: string;
	maestroPMode?: 'interactive' | 'dynamic';
	retryOnAvailabilityErrors?: boolean;
	retryOnTokenExhaustion?: boolean;
	additionalDirectories?: AdditionalDirectory[];
	codexAutoResetOnExhaustion?: boolean;
	/** The new working directory, already vetted; absent when the person left it alone. */
	workingDirectory?: string;
}

const SSH_KEYS = ['workingDirOverride', 'syncHistory', 'shareHistoryToProjectDir'] as const;

/** The ssh patch that makes the stored config equal `next`: keys `next` lacks are cleared, as a replace would. */
function sshPatchFor(
	current: Session['sessionSshRemoteConfig'],
	next: NonNullable<AgentEditForm['sessionSshRemoteConfig']>
): Partial<AgentSshSettings> | undefined {
	const patch: Partial<AgentSshSettings> = { enabled: next.enabled, remoteId: next.remoteId };
	for (const key of SSH_KEYS) {
		const value = next[key];
		const held = (current as Record<string, unknown> | undefined)?.[key];
		if (value !== undefined) (patch as Record<string, unknown>)[key] = value;
		else if (held !== undefined) (patch as Record<string, unknown>)[key] = undefined;
	}
	const same =
		current !== undefined &&
		current.enabled === next.enabled &&
		(current.remoteId ?? null) === next.remoteId &&
		SSH_KEYS.every((key) => (current as Record<string, unknown>)[key] === next[key]);
	return same ? undefined : patch;
}

export function buildAgentEditPatch(current: Session, form: AgentEditForm): AgentPatch {
	const providerChanged = form.toolType !== undefined && form.toolType !== current.toolType;
	// The values the form's override fields were seeded from, and so the ones "unchanged" is measured against.
	const live = current as unknown as Record<string, unknown>;
	const seed: Record<string, unknown> = providerChanged
		? { ...providerOverridesFor(current, form.toolType as ToolType) }
		: live;
	const differs = (key: string, next: unknown): boolean =>
		providerChanged || !valuesEqual(next, seed[key]);

	const patch: AgentPatch = {};

	if (form.name !== current.name) patch.name = form.name;
	if (providerChanged) patch.provider = form.toolType;
	if (form.workingDirectory) patch.cwd = form.workingDirectory;

	if (differs('nudgeMessage', form.nudgeMessage)) patch.nudgeMessage = form.nudgeMessage ?? null;
	if (differs('newSessionMessage', form.newSessionMessage)) {
		patch.newSessionMessage = form.newSessionMessage ?? null;
	}
	// Directory grants, retry flags, and the Codex reset belong to the agent, not to a provider, so the
	// switch leaves them alone and they are measured against the live record.
	if (!valuesEqual(form.additionalDirectories, live.additionalDirectories)) {
		patch.additionalDirectories = form.additionalDirectories?.length
			? form.additionalDirectories.map((grant) => ({ ...grant }))
			: null;
	}
	if (!valuesEqual(form.retryOnAvailabilityErrors, live.retryOnAvailabilityErrors)) {
		patch.retryOnAvailabilityErrors = form.retryOnAvailabilityErrors ?? null;
	}
	if (!valuesEqual(form.retryOnTokenExhaustion, live.retryOnTokenExhaustion)) {
		patch.retryOnTokenExhaustion = form.retryOnTokenExhaustion ?? null;
	}
	if ((form.codexAutoResetOnExhaustion === true) !== (live.codexAutoResetOnExhaustion === true)) {
		patch.codexAutoResetOnExhaustion = form.codexAutoResetOnExhaustion === true ? true : null;
	}

	if (differs('customPath', form.customPath)) patch.customPath = form.customPath ?? null;
	if (differs('customArgs', form.customArgs)) patch.customArgs = form.customArgs ?? null;
	if (differs('customEnvVars', form.customEnvVars)) patch.env = form.customEnvVars ?? null;
	if (differs('customEnvVarsDisabled', form.customEnvVarsDisabled)) {
		patch.envDisabled = form.customEnvVarsDisabled ?? null;
	}
	if (differs('customModel', form.customModel)) patch.model = form.customModel ?? null;
	if (differs('customEffort', form.customEffort)) patch.effort = form.customEffort ?? null;
	if (differs('enableMaestroP', form.enableMaestroP)) {
		patch.enableMaestroP = form.enableMaestroP ?? null;
	}
	if (differs('maestroPPath', form.maestroPPath)) patch.maestroPPath = form.maestroPPath ?? null;
	if (differs('maestroPMode', form.maestroPMode)) patch.maestroPMode = form.maestroPMode ?? null;

	// The context window carries provenance the patch cannot: `contextWindow` always records the value as
	// the person's own. So a value the form merely round-tripped, with the provenance it already had, is
	// left alone, and only a deliberate edit or a cleared field is sent.
	const heldWindow = seed.customContextWindow;
	if (form.customContextWindow === undefined) {
		if (heldWindow !== undefined) patch.contextWindow = null;
	} else if (form.contextWindowSource === 'user-edited') {
		patch.contextWindow = form.customContextWindow;
	}

	if (form.sessionSshRemoteConfig) {
		const ssh = sshPatchFor(current.sessionSshRemoteConfig, form.sessionSshRemoteConfig);
		if (ssh) patch.ssh = ssh;
	}

	return patch;
}
