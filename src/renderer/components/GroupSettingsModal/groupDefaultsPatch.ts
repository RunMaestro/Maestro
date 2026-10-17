/**
 * groupDefaultsPatch - a typed edit to a group's defaults, applied the way the
 * Group Settings dialog applies a click.
 *
 * `update-group-settings` (and any bridge client) sends a patch in
 * `update-agent`'s vocabulary. This folds it into the FORM the dialog would hold
 * for the group (`groupDefaultsToForm`) and builds the profile with the dialog's
 * own validator (`buildGroupDefaults`), so the two cannot store different
 * things, and a default no launch would accept is refused here by name.
 *
 * Pure, so the rules are tested without a DOM or a store. What the app knows
 * (saved sources, SSH remotes, live agents) comes in through the context.
 *
 * The builder drops a provider-bound value when the form names no provider and
 * a Claude or Codex value on another provider. A dialog cannot send one of
 * those (the control is not there), but a typed patch can, and a default that
 * silently never stored is worse than an error, so each is refused by name
 * before the builder runs.
 */

import { AGENT_IDS } from '../../../shared/agentIds';
import { AUTO_MODEL, isAutoModel } from '../../../shared/autoModel';
import { autoModelProblem } from '../../../shared/autoTurn';
import { isCodexTransport } from '../../../shared/codexTransport';
import {
	BACKGROUND_REQUESTS_NEEDS_PROXY,
	parseBackgroundRequestsEdit,
} from '../../../shared/local-models/background-requests';
import type { LocalModelEndpoint } from '../../../shared/local-models/endpoints';
import { parseGatewayUrlEdit } from '../../../shared/local-models/gateway';
import {
	agentRunOnSupport,
	parseRunOnEdit,
	runOnGatewayEditProblem,
} from '../../../shared/local-models/run-on';
import { parseSystemOneOptOutEdit } from '../../../shared/local-models/system-one-agent';
import { asTokenProxyMode, TOKEN_PROXY_MODES } from '../../../shared/local-models/token-proxy';
import { parseTierTargetsEdit, type HarnessTierDefaults } from '../../../shared/modelTiers';
import {
	applyPeerAgentEdits,
	parsePeerAgentEdits,
	parsePeerGrantValue,
	peerAgentEditsProblem,
} from '../../../shared/peerAgents';
import { GROUP_SETTINGS_SSH_PATCH_KEYS } from '../../../shared/groupSettingsUpdate';
import type { GroupAgentDefaults, ToolType } from '../../../shared/types';
import { tokenProxyModeBlocker } from '../shared/TokenProxyModeField';
import {
	buildGroupDefaults,
	groupDefaultsToForm,
	PROVIDER_BOUND_DEFAULTS,
	type GroupDefaultsForm,
} from './groupDefaultsForm';

/** What a patch is judged against besides the stored profile. */
export interface GroupDefaultsPatchContext {
	/** Expands `~` in an additional directory the profile already holds. */
	homeDir?: string;
	/** The saved sources, so a Run on or tier target that names none is refused. */
	endpoints?: readonly LocalModelEndpoint[];
	/** The harness tier defaults, so `auto` is refused where it would change nothing. */
	harnessTierDefaults?: HarnessTierDefaults | null;
	/** The SSH remotes that exist: `remoteId` must name one (by id or by name). */
	sshRemotes?: ReadonlyArray<{ id: string; name: string }>;
	/** The ids of the agents that exist, so a peer row for none is refused. */
	liveAgentIds?: readonly string[];
}

export interface GroupDefaultsPatchInput {
	configPatch?: Record<string, unknown>;
	sshPatch?: Record<string, unknown>;
}

export type GroupDefaultsPatchResult =
	/** `defaults` is `undefined` when the patch leaves the profile with no opinion. */
	{ ok: true; defaults: GroupAgentDefaults | undefined } | { ok: false; error: string };

/** The provider a patch key needs the profile to name, for the refusal text. */
const PROVIDER_BOUND_KEYS: Readonly<Record<string, string>> = {
	customPath: '--custom-path',
	customArgs: '--custom-args',
	customModel: '--model',
	customEffort: '--effort',
	customContextWindow: '--context-window',
	enableMaestroP: '--token-source',
	maestroPMode: '--token-source',
	maestroPPath: '--maestro-p-path',
	codexTransport: '--codex-transport',
	runOn: '--run-on',
	tierTargets: '--tier',
	backgroundRequests: '--background-requests',
	gatewayUrl: '--gateway-url',
	tokenProxyMode: '--proxy-mode',
};

const PICKABLE_PROVIDERS: ReadonlySet<string> = new Set(
	AGENT_IDS.filter((id) => id !== 'terminal')
);

type ReadResult<Value> = { ok: true; value: Value } | { ok: false; error: string };

function readString(key: string, value: unknown): ReadResult<string> {
	if (value === null) return { ok: true, value: '' };
	if (typeof value === 'string') return { ok: true, value };
	return { ok: false, error: `${key} must be a string or null.` };
}

function readBoolean(key: string, value: unknown): ReadResult<boolean | undefined> {
	if (value === null) return { ok: true, value: undefined };
	if (typeof value === 'boolean') return { ok: true, value };
	return { ok: false, error: `${key} must be true, false or null.` };
}

function recordOfStrings(value: unknown): value is Record<string, string> {
	return (
		typeof value === 'object' &&
		value !== null &&
		!Array.isArray(value) &&
		Object.values(value).every((entry) => typeof entry === 'string')
	);
}

function fail(error: string): GroupDefaultsPatchResult {
	return { ok: false, error };
}

/**
 * Apply `input` to `current`, the group's stored defaults, and return the
 * profile the dialog would have saved for the same edit.
 *
 * A key is processed in a fixed order (provider, SSH, then the rest), so a
 * blocker that depends on the provider or the remote sees where the profile
 * ends up and not where it started. Switching the provider resets the
 * provider-bound values the way the dialog's provider picker does, before the
 * patch's own values are applied, so `--provider codex --model gpt-5` is the
 * model on Codex and not a model the reset then wipes.
 */
export function applyGroupDefaultsPatch(
	current: GroupAgentDefaults | undefined,
	input: GroupDefaultsPatchInput,
	context: GroupDefaultsPatchContext = {}
): GroupDefaultsPatchResult {
	const patch = input.configPatch ?? {};
	const form: GroupDefaultsForm = groupDefaultsToForm(current);
	const endpoints = context.endpoints ?? [];

	// --- Provider ---
	if ('toolType' in patch) {
		const raw = patch.toolType;
		let next: ToolType | null;
		if (raw === null) {
			next = null;
		} else if (typeof raw === 'string' && PICKABLE_PROVIDERS.has(raw)) {
			next = raw as ToolType;
		} else {
			return fail(
				`toolType must be one of: ${[...PICKABLE_PROVIDERS].join(', ')}, or null for no default provider.`
			);
		}
		if (next !== form.toolType) {
			// The env vars stay: they are not tied to a provider (the dialog's rule).
			Object.assign(form, PROVIDER_BOUND_DEFAULTS, {
				customPath: '',
				customArgs: '',
				runOn: next && agentRunOnSupport(next).supported ? form.runOn : { type: 'provider' },
			});
			form.toolType = next;
		}
	}

	// --- Working directory ---
	if ('projectRoot' in patch) {
		const read = readString('projectRoot', patch.projectRoot);
		if (!read.ok) return fail(read.error);
		form.projectRoot = read.value;
	}

	// --- SSH ---
	const ssh = input.sshPatch;
	if (ssh) {
		for (const key of Object.keys(ssh)) {
			if (!(GROUP_SETTINGS_SSH_PATCH_KEYS as readonly string[]).includes(key)) {
				return fail(`Not an SSH setting: ${key}.`);
			}
		}
		const merged = {
			enabled: form.sshRemoteConfig?.enabled ?? false,
			remoteId: form.sshRemoteConfig?.remoteId ?? null,
			workingDirOverride: form.sshRemoteConfig?.workingDirOverride,
			syncHistory: form.sshRemoteConfig?.syncHistory,
			shareHistoryToProjectDir: form.sshRemoteConfig?.shareHistoryToProjectDir,
		};
		if ('enabled' in ssh) {
			if (typeof ssh.enabled !== 'boolean') return fail('enabled must be true or false.');
			merged.enabled = ssh.enabled;
		}
		if ('remoteId' in ssh) {
			if (ssh.remoteId !== null && typeof ssh.remoteId !== 'string') {
				return fail('remoteId must be a remote id, a remote name, or null.');
			}
			const named = typeof ssh.remoteId === 'string' ? ssh.remoteId.trim() : null;
			if (named && context.sshRemotes) {
				const remote =
					context.sshRemotes.find((candidate) => candidate.id === named) ??
					context.sshRemotes.find((candidate) => candidate.name === named);
				if (!remote) {
					const known = context.sshRemotes.map(
						(candidate) => `${candidate.id} (${candidate.name})`
					);
					return fail(
						`No SSH remote is named "${named}".${known.length > 0 ? ` Saved remotes: ${known.join(', ')}.` : ' None is saved.'}`
					);
				}
				merged.remoteId = remote.id;
			} else {
				merged.remoteId = named || null;
			}
		}
		if ('workingDirOverride' in ssh) {
			const read = readString('workingDirOverride', ssh.workingDirOverride);
			if (!read.ok) return fail(read.error);
			merged.workingDirOverride = read.value.trim() || undefined;
		}
		if ('syncHistory' in ssh) {
			const read = readBoolean('syncHistory', ssh.syncHistory);
			if (!read.ok) return fail(read.error);
			merged.syncHistory = read.value;
		}
		form.sshRemoteConfig =
			merged.enabled || merged.remoteId || merged.shareHistoryToProjectDir
				? {
						enabled: merged.enabled,
						remoteId: merged.remoteId,
						...(merged.workingDirOverride ? { workingDirOverride: merged.workingDirOverride } : {}),
						...(merged.syncHistory ? { syncHistory: true } : {}),
						...(merged.shareHistoryToProjectDir ? { shareHistoryToProjectDir: true } : {}),
					}
				: undefined;
	}
	const sshRemoteId =
		form.sshRemoteConfig?.enabled && form.sshRemoteConfig.remoteId
			? form.sshRemoteConfig.remoteId
			: undefined;
	const sshRemoteName = sshRemoteId
		? (context.sshRemotes?.find((remote) => remote.id === sshRemoteId)?.name ?? sshRemoteId)
		: undefined;

	// --- A value that needs a provider, or a particular one ---
	const toolType = form.toolType;
	for (const [key, flag] of Object.entries(PROVIDER_BOUND_KEYS)) {
		if (!(key in patch) || patch[key] === null) continue;
		if (!toolType) {
			return fail(
				`${flag} belongs to one provider's binary, models or API, and this group has no default provider. Set one with --provider, in this call or before it.`
			);
		}
	}
	for (const key of ['enableMaestroP', 'maestroPMode', 'maestroPPath'] as const) {
		if (key in patch && patch[key] !== null && toolType !== 'claude-code') {
			return fail(
				`${PROVIDER_BOUND_KEYS[key]} only applies to Claude Code, and this group's default provider is ${toolType ?? 'not set'}.`
			);
		}
	}
	if ('codexTransport' in patch && patch.codexTransport !== null && toolType !== 'codex') {
		return fail(
			`--codex-transport only applies to Codex, and this group's default provider is ${toolType ?? 'not set'}.`
		);
	}

	// --- Plain strings ---
	for (const [key, field] of [
		['newSessionMessage', 'newSessionMessage'],
		['nudgeMessage', 'nudgeMessage'],
		['customPath', 'customPath'],
		['customArgs', 'customArgs'],
		['maestroPPath', 'maestroPPath'],
	] as const) {
		if (!(key in patch)) continue;
		const read = readString(key, patch[key]);
		if (!read.ok) return fail(read.error);
		form[field] = read.value;
	}

	for (const [key, field] of [
		['customModel', 'customModel'],
		['customEffort', 'customEffort'],
	] as const) {
		if (!(key in patch)) continue;
		const read = readString(key, patch[key]);
		if (!read.ok) return fail(read.error);
		form[field] = read.value.trim() || undefined;
	}

	if ('customContextWindow' in patch) {
		const value = patch.customContextWindow;
		if (value === null) {
			form.customContextWindow = undefined;
		} else if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
			form.customContextWindow = Math.floor(value);
		} else {
			return fail('customContextWindow must be a positive number or null.');
		}
	}

	// --- Claude token source ---
	if ('enableMaestroP' in patch) {
		const read = readBoolean('enableMaestroP', patch.enableMaestroP);
		if (!read.ok) return fail(read.error);
		form.enableMaestroP = read.value;
	}
	if ('maestroPMode' in patch) {
		const value = patch.maestroPMode;
		if (value === null) form.maestroPMode = 'dynamic';
		else if (value === 'interactive' || value === 'dynamic') form.maestroPMode = value;
		else return fail('maestroPMode must be interactive, dynamic or null.');
	}

	// --- Codex transport ---
	if ('codexTransport' in patch) {
		const value = patch.codexTransport;
		if (value !== null && !isCodexTransport(value)) {
			return fail(`Invalid value for field 'codexTransport'`);
		}
		form.codexTransport = value === 'app-server' ? 'app-server' : 'exec';
	}

	// --- Models ---
	if ('runOn' in patch) {
		const edit = parseRunOnEdit(toolType ?? 'claude-code', patch.runOn, endpoints);
		if (!edit.ok) return fail(edit.error);
		form.runOn = edit.target ?? { type: 'provider' };
	}

	if ('tierTargets' in patch && toolType) {
		const edit = parseTierTargetsEdit(toolType, patch.tierTargets, {
			base: form.tierTargets,
			endpoints,
		});
		if (!edit.ok) return fail(edit.error);
		form.tierTargets = edit.tierTargets ?? {};
	}

	if ('systemOneOptOut' in patch) {
		const edit = parseSystemOneOptOutEdit(patch.systemOneOptOut);
		if (!edit.ok) return fail(edit.error);
		form.systemOneOptOut = edit.optOut === true;
	}

	// A default holds the proxy mode OR a gateway URL, never both (the builder's
	// rule): the mode stands in for the gateway. Naming both is refused. Naming
	// one takes the other off, as `update-agent` does.
	const setsGateway = 'gatewayUrl' in patch;
	const setsMode = 'tokenProxyMode' in patch;
	if (setsGateway && setsMode) {
		return fail(
			'Set the gateway URL or the proxy mode, not both: the proxy mode chooses the gateway URL.'
		);
	}
	if (setsGateway) {
		const raw = patch.gatewayUrl;
		if (raw !== null && typeof raw !== 'string') return fail('gatewayUrl must be a URL or null.');
		const edit = toolType
			? parseGatewayUrlEdit(toolType, raw ?? '')
			: ({ ok: true, gatewayUrl: null } as const);
		if (!edit.ok) return fail(edit.error);
		form.gatewayUrl = edit.gatewayUrl ?? '';
		// A proxy mode and its background requests belong to the gateway they were chosen for.
		form.tokenProxyMode = 'off';
		form.backgroundRequests = undefined;
	}
	if (setsMode) {
		const mode = asTokenProxyMode(patch.tokenProxyMode);
		if (!mode) return fail(`tokenProxyMode must be one of: ${TOKEN_PROXY_MODES.join(', ')}.`);
		if (mode !== 'off' && toolType) {
			const blocker = tokenProxyModeBlocker(toolType, sshRemoteName);
			if (blocker) return fail(blocker);
		}
		form.tokenProxyMode = mode;
		form.gatewayUrl = '';
		if (mode === 'off') form.backgroundRequests = undefined;
	}

	if ('backgroundRequests' in patch) {
		const edit = toolType
			? parseBackgroundRequestsEdit(toolType, patch.backgroundRequests, endpoints)
			: ({ ok: true, backgroundRequests: undefined } as const);
		if (!edit.ok) return fail(edit.error);
		if (edit.backgroundRequests && form.tokenProxyMode === 'off') {
			return fail(BACKGROUND_REQUESTS_NEEDS_PROXY);
		}
		form.backgroundRequests = edit.backgroundRequests;
	}

	// A gateway is not applied to an agent on a source: refused rather than
	// stored as a default that no launch would use.
	if (setsGateway || setsMode) {
		const problem = runOnGatewayEditProblem(form.runOn, {
			gatewayUrl: form.gatewayUrl,
			tokenProxyMode: form.tokenProxyMode,
		});
		if (problem) return fail(problem);
	}

	// `auto` is stored as the word, and only where it can act, judged against
	// the tiers and Run on target this patch leaves the profile with.
	if (isAutoModel(form.customModel) && toolType) {
		const problem = autoModelProblem(
			{ toolType, tierTargets: form.tierTargets, runOn: form.runOn },
			context.harnessTierDefaults
		);
		if (problem) return fail(`customModel: ${problem}`);
		form.customModel = AUTO_MODEL;
	}

	// --- Environment ---
	if ('customEnvVars' in patch) {
		const value = patch.customEnvVars;
		if (value === null) {
			form.customEnvVars = {};
		} else if (recordOfStrings(value)) {
			form.customEnvVars = { ...value };
			// A variable lives in one of the two env records (`parkedRecords.ts`).
			for (const key of Object.keys(value)) delete form.customEnvVarsDisabled[key];
		} else {
			return fail('customEnvVars must be an object of strings, or null.');
		}
	}

	// --- Peers ---
	for (const key of ['groupPeerAccess', 'worktreePeerAccess'] as const) {
		if (!(key in patch)) continue;
		const grant = parsePeerGrantValue(patch[key]);
		if (!grant.ok) return fail(`${key}: ${grant.error}`);
		form[key] = grant.access ?? undefined;
	}
	if ('peerAgentEdits' in patch) {
		const parsed = parsePeerAgentEdits(patch.peerAgentEdits);
		if (!parsed.ok) return fail(parsed.error);
		if (context.liveAgentIds) {
			const problem = peerAgentEditsProblem(parsed.edits, new Set(context.liveAgentIds));
			if (problem) return fail(problem);
		}
		const applied = applyPeerAgentEdits(form.peerAgents, parsed.edits);
		if (!applied.ok) return fail(applied.error);
		form.peerAgents = applied.peerAgents ?? [];
	}

	const built = buildGroupDefaults(form, {
		homeDir: context.homeDir,
		sshRemoteName,
		endpoints,
	});
	if (!built.ok) return fail(`${built.field}: ${built.error}`);
	return { ok: true, defaults: built.defaults };
}
