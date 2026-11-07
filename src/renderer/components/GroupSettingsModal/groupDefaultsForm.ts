/**
 * groupDefaultsForm - the two ends of the Group Settings form: a group's stored
 * defaults read into form values, and form values written back as defaults.
 *
 * Pure, so the rules are tested without a DOM. The rule that matters most is in
 * `buildGroupDefaults`: a field the form leaves blank or at its default is
 * OMITTED from the result. An absent key means "no opinion", and a profile that
 * pins one env var and nothing else is the whole point of the feature. A key
 * written with a default value would become an opinion the user never had, and
 * a publish would then stamp it onto every agent in the group.
 */

import type {
	AdditionalDirectory,
	AgentSshRemoteConfig,
	GroupAgentDefaults,
	PeerAccess,
	PeerAgent,
	ToolType,
} from '../../../shared/types';
import { normalizeAdditionalDirectories } from '../../../shared/additionalDirectories';
import { resilienceEnabled } from '../../../shared/agentConstants';
import type { CodexTransport } from '../../../shared/codexTransport';
import { isAbsolutePath } from '../../../shared/formatters';
import {
	backgroundRequestsSupport,
	parseBackgroundRequests,
	parseBackgroundRequestsEdit,
	type BackgroundRequests,
} from '../../../shared/local-models/background-requests';
import type { LocalModelEndpoint } from '../../../shared/local-models/endpoints';
import { parseGatewayUrlEdit } from '../../../shared/local-models/gateway';
import {
	parseRunOnEdit,
	parseRunOnTarget,
	type RunOnTarget,
} from '../../../shared/local-models/run-on';
import type { TokenProxyMode } from '../../../shared/local-models/token-proxy';
import { parseTierTargetsEdit, type TierTargets } from '../../../shared/modelTiers';
import { normalizePeerAgents } from '../../../shared/peerAgents';
import { tokenProxyModeBlocker } from '../shared/TokenProxyModeField';

/** Every value the Group Settings form holds, in the shape its controls edit. */
export interface GroupDefaultsForm {
	// General
	projectRoot: string;
	additionalDirectories: AdditionalDirectory[];
	newSessionMessage: string;
	nudgeMessage: string;

	// Provider. `null` is "no default provider": the user picks one at create.
	toolType: ToolType | null;
	customPath: string;
	customArgs: string;
	/**
	 * Model, effort and context window are `undefined` until the group has an
	 * opinion: seeded from the stored defaults, or set in the form. The config
	 * panel shows the provider's own value in the meantime, and that value must
	 * not be written back as a group default just because the form was saved.
	 */
	customModel: string | undefined;
	customEffort: string | undefined;
	customContextWindow: number | undefined;
	/**
	 * Tri-state, as on an agent: `undefined` is never configured, which over SSH
	 * means the TUI and locally means the API. An explicit `false` is kept apart
	 * from it for that reason.
	 */
	enableMaestroP: boolean | undefined;
	maestroPMode: 'interactive' | 'dynamic';
	maestroPPath: string;
	codexTransport: CodexTransport;
	retryOnAvailabilityErrors: boolean;
	retryOnTokenExhaustion: boolean;
	codexAutoResetOnExhaustion: boolean;

	// Models
	runOn: RunOnTarget;
	tierTargets: TierTargets;
	/** `off` is the absence of the stored field. */
	tokenProxyMode: TokenProxyMode;
	backgroundRequests: BackgroundRequests | undefined;
	gatewayUrl: string;
	systemOneOptOut: boolean;

	// Environment
	customEnvVars: Record<string, string>;
	customEnvVarsDisabled: Record<string, string>;

	// Peers. A grant that is off is `undefined`, never a pair of false bits.
	peerAgents: PeerAgent[];
	groupPeerAccess: PeerAccess | undefined;
	worktreePeerAccess: PeerAccess | undefined;

	// SSH
	sshRemoteConfig: AgentSshRemoteConfig | undefined;
}

/**
 * The SSH config a form edits, from the one a record stores. `undefined` when
 * the record names no remote and no mirror flag. Shared with the create form,
 * which seeds its SSH tab from a group's defaults.
 */
export function sshRemoteConfigToForm(
	stored: GroupAgentDefaults['sessionSshRemoteConfig']
): AgentSshRemoteConfig | undefined {
	if (stored?.enabled && stored.remoteId) {
		return {
			enabled: true,
			remoteId: stored.remoteId,
			workingDirOverride: stored.workingDirOverride,
			syncHistory: stored.syncHistory,
			shareHistoryToProjectDir: stored.shareHistoryToProjectDir,
		};
	}
	// The mirror flag stands without a remote: it marks an agent that runs here
	// and is controlled from another machine.
	if (stored?.shareHistoryToProjectDir) {
		return { enabled: false, remoteId: null, shareHistoryToProjectDir: true };
	}
	return undefined;
}

/**
 * Form values for a group's stored defaults. Arrays and records are cloned, so
 * editing a row never mutates the group in the store before Save.
 *
 * A stored Run on or Background requests value that cannot be read is shown as
 * its default. Saving then drops it, which is the only thing a form can do with
 * a value it cannot draw.
 */
export function groupDefaultsToForm(defaults: GroupAgentDefaults | undefined): GroupDefaultsForm {
	const stored = defaults ?? {};
	const runOn = parseRunOnTarget(stored.runOn);
	const backgroundRequests = parseBackgroundRequests(stored.backgroundRequests);
	return {
		projectRoot: stored.projectRoot ?? '',
		additionalDirectories: (stored.additionalDirectories ?? []).map((dir) => ({ ...dir })),
		newSessionMessage: stored.newSessionMessage ?? '',
		nudgeMessage: stored.nudgeMessage ?? '',

		toolType: stored.toolType ?? null,
		customPath: stored.customPath ?? '',
		customArgs: stored.customArgs ?? '',
		customModel: stored.customModel,
		customEffort: stored.customEffort,
		customContextWindow: stored.customContextWindow,
		enableMaestroP: stored.enableMaestroP,
		maestroPMode: stored.maestroPMode ?? 'dynamic',
		maestroPPath: stored.maestroPPath ?? '',
		codexTransport: stored.codexTransport === 'app-server' ? 'app-server' : 'exec',
		retryOnAvailabilityErrors: resilienceEnabled(stored.retryOnAvailabilityErrors),
		retryOnTokenExhaustion: resilienceEnabled(stored.retryOnTokenExhaustion),
		codexAutoResetOnExhaustion: stored.codexAutoResetOnExhaustion === true,

		runOn: runOn.ok ? runOn.target : { type: 'provider' },
		tierTargets: { ...stored.tierTargets },
		tokenProxyMode: stored.tokenProxyMode ?? 'off',
		backgroundRequests: backgroundRequests.ok ? backgroundRequests.backgroundRequests : undefined,
		gatewayUrl: stored.gatewayUrl ?? '',
		systemOneOptOut: stored.systemOneOptOut === true,

		customEnvVars: { ...stored.customEnvVars },
		customEnvVarsDisabled: { ...stored.customEnvVarsDisabled },

		peerAgents: (stored.peerAgents ?? []).map((peer) => ({ ...peer })),
		groupPeerAccess: stored.groupPeerAccess && { ...stored.groupPeerAccess },
		worktreePeerAccess: stored.worktreePeerAccess && { ...stored.worktreePeerAccess },

		sshRemoteConfig: sshRemoteConfigToForm(stored.sessionSshRemoteConfig),
	};
}

/**
 * The provider-bound values of a form that just changed provider. A path, a
 * model, a tier or a gateway names one provider's binary, models or API, so
 * none of them carries across. Spread over the form by the modal. The path and
 * the args are not here: `useAgentConfiguration().handleAgentChange` holds them
 * and resets them itself.
 *
 * Not reset: env vars (they are not tied to a provider, which is what lets a
 * group pin `CLAUDE_CONFIG_DIR` and nothing else), the Run on target (it names
 * a source and a model; the modal drops it only for a provider whose harness
 * cannot use one), resilience, peers, SSH, and everything on General.
 */
export const PROVIDER_BOUND_DEFAULTS: Pick<
	GroupDefaultsForm,
	| 'customModel'
	| 'customEffort'
	| 'customContextWindow'
	| 'enableMaestroP'
	| 'maestroPMode'
	| 'maestroPPath'
	| 'codexTransport'
	| 'codexAutoResetOnExhaustion'
	| 'tierTargets'
	| 'tokenProxyMode'
	| 'backgroundRequests'
	| 'gatewayUrl'
> = Object.freeze({
	customModel: undefined,
	customEffort: undefined,
	customContextWindow: undefined,
	enableMaestroP: undefined,
	maestroPMode: 'dynamic',
	maestroPPath: '',
	codexTransport: 'exec',
	codexAutoResetOnExhaustion: false,
	tierTargets: {},
	tokenProxyMode: 'off',
	backgroundRequests: undefined,
	gatewayUrl: '',
});

/** What `buildGroupDefaults` needs besides the form. */
export interface BuildGroupDefaultsContext {
	/** Expands `~` in an additional directory. */
	homeDir?: string;
	/** Name of the SSH remote the form has chosen, when it has chosen one. */
	sshRemoteName?: string;
	/** The saved sources, so a Background requests target that names none is refused. */
	endpoints?: readonly Pick<LocalModelEndpoint, 'id' | 'name' | 'kind'>[];
}

export type BuildGroupDefaultsResult =
	/** `undefined` when the form holds no opinion: the group stores no `defaults` at all. */
	| { ok: true; defaults: GroupAgentDefaults | undefined }
	/** `field` is a key of `AGENT_SETTINGS_FIELD_TAB`, so the modal can show the tab. */
	| { ok: false; field: string; error: string };

function nonEmptyRecord(record: Record<string, string>): Record<string, string> | undefined {
	return Object.keys(record).length > 0 ? { ...record } : undefined;
}

/** Whether the form's SSH config sends the agent to a remote. */
export function isSshRemoteChosen(config: AgentSshRemoteConfig | undefined): boolean {
	return !!config?.enabled && !!config.remoteId;
}

/** Why a default working directory cannot be stored, or undefined when it can. */
export function groupDefaultWorkingDirProblem(
	projectRoot: string,
	sshRemoteChosen: boolean
): string | undefined {
	const path = projectRoot.trim();
	// Blank is no default. A remote path may start with `~`, which only the
	// remote shell can expand, so its shape is left to the create form's check
	// against the remote. A local `~` path is expanded by the create form.
	if (!path || sshRemoteChosen) return undefined;
	if (path === '~' || path.startsWith('~/') || isAbsolutePath(path)) return undefined;
	return 'Enter an absolute path';
}

/**
 * The defaults a form stands for, with every blank or default-valued field
 * omitted, or the first value a new agent could not be created with.
 *
 * Provider-bound fields are written only when the form names a provider: with
 * none there is no binary for a path, and no harness for a tier. Each Models
 * value goes through the validator every other writer of it shares, so a group
 * cannot hold a default a launch would refuse.
 */
export function buildGroupDefaults(
	form: GroupDefaultsForm,
	context: BuildGroupDefaultsContext = {}
): BuildGroupDefaultsResult {
	const sshRemoteChosen = isSshRemoteChosen(form.sshRemoteConfig);
	const defaults: GroupAgentDefaults = {};

	// --- General ---
	const workingDirProblem = groupDefaultWorkingDirProblem(form.projectRoot, sshRemoteChosen);
	if (workingDirProblem) return { ok: false, field: 'workingDir', error: workingDirProblem };
	const projectRoot = form.projectRoot.trim();
	if (projectRoot) defaults.projectRoot = projectRoot;
	const additionalDirectories = normalizeAdditionalDirectories(
		form.additionalDirectories,
		context.homeDir
	);
	if (additionalDirectories) defaults.additionalDirectories = additionalDirectories;
	const newSessionMessage = form.newSessionMessage.trim();
	if (newSessionMessage) defaults.newSessionMessage = newSessionMessage;
	const nudgeMessage = form.nudgeMessage.trim();
	if (nudgeMessage) defaults.nudgeMessage = nudgeMessage;

	// --- Provider ---
	const toolType = form.toolType;
	if (toolType) {
		defaults.toolType = toolType;
		const customPath = form.customPath.trim();
		if (customPath) defaults.customPath = customPath;
		const customArgs = form.customArgs.trim();
		if (customArgs) defaults.customArgs = customArgs;
		const customModel = form.customModel?.trim();
		if (customModel) defaults.customModel = customModel;
		const customEffort = form.customEffort?.trim();
		if (customEffort) defaults.customEffort = customEffort;
		if (typeof form.customContextWindow === 'number' && form.customContextWindow > 0) {
			defaults.customContextWindow = form.customContextWindow;
		}

		if (toolType === 'claude-code') {
			// Locally an explicit API choice is the same as never configured, so it
			// is a default value and is omitted. Over SSH the unset default is the
			// TUI, so the explicit `false` is the opinion and must be kept.
			if (form.enableMaestroP === true || (form.enableMaestroP === false && sshRemoteChosen)) {
				defaults.enableMaestroP = form.enableMaestroP;
			}
			if (form.enableMaestroP === true) {
				defaults.maestroPMode = form.maestroPMode;
				const maestroPPath = form.maestroPPath.trim();
				if (maestroPPath) defaults.maestroPPath = maestroPPath;
			}
		}
		if (toolType === 'codex') {
			if (form.codexTransport === 'app-server') defaults.codexTransport = 'app-server';
			if (form.codexAutoResetOnExhaustion) defaults.codexAutoResetOnExhaustion = true;
		}

		// --- Models (the part that names a provider's harness or API) ---
		const runOn = parseRunOnEdit(toolType, form.runOn);
		if (!runOn.ok) return { ok: false, field: 'runOn', error: runOn.error };
		if (runOn.target) defaults.runOn = runOn.target;

		const tiers = parseTierTargetsEdit(toolType, form.tierTargets);
		if (!tiers.ok) return { ok: false, field: 'tierTargets', error: tiers.error };
		if (tiers.tierTargets) defaults.tierTargets = tiers.tierTargets;

		// The proxy mode stands in for the gateway: an agent on the proxy has the
		// proxy's address as its gateway, and that address is worked out when the
		// agent is created (the route depends on its credentials). So a default
		// holds the mode OR a gateway URL, never both.
		// A provider or a remote that cannot use the proxy is off it whatever the
		// form still holds: the control is disabled with the reason.
		const proxyMode = tokenProxyModeBlocker(toolType, context.sshRemoteName)
			? 'off'
			: form.tokenProxyMode;
		if (proxyMode !== 'off') {
			defaults.tokenProxyMode = proxyMode;
			if (form.backgroundRequests && backgroundRequestsSupport(toolType).supported) {
				const background = parseBackgroundRequestsEdit(
					toolType,
					form.backgroundRequests,
					context.endpoints
				);
				if (!background.ok) {
					return { ok: false, field: 'backgroundRequests', error: background.error };
				}
				if (background.backgroundRequests) {
					defaults.backgroundRequests = background.backgroundRequests;
				}
			}
		} else {
			const gateway = parseGatewayUrlEdit(toolType, form.gatewayUrl);
			if (!gateway.ok) return { ok: false, field: 'gatewayUrl', error: gateway.error };
			if (gateway.gatewayUrl) defaults.gatewayUrl = gateway.gatewayUrl;
		}
	}

	// Both resilience flags default ON, so only a flag switched off is an opinion.
	if (!form.retryOnAvailabilityErrors) defaults.retryOnAvailabilityErrors = false;
	if (!form.retryOnTokenExhaustion) defaults.retryOnTokenExhaustion = false;

	// --- Models (the part no provider is needed for) ---
	if (form.systemOneOptOut) defaults.systemOneOptOut = true;

	// --- Environment ---
	const customEnvVars = nonEmptyRecord(form.customEnvVars);
	if (customEnvVars) defaults.customEnvVars = customEnvVars;
	const customEnvVarsDisabled = nonEmptyRecord(form.customEnvVarsDisabled);
	if (customEnvVarsDisabled) defaults.customEnvVarsDisabled = customEnvVarsDisabled;

	// --- Peers ---
	// A row with neither square lit is kept: it is an exclusion.
	const peerAgents = normalizePeerAgents(form.peerAgents);
	if (peerAgents) defaults.peerAgents = peerAgents;
	if (form.groupPeerAccess) defaults.groupPeerAccess = { ...form.groupPeerAccess };
	if (form.worktreePeerAccess) defaults.worktreePeerAccess = { ...form.worktreePeerAccess };

	// --- SSH ---
	const ssh = form.sshRemoteConfig;
	if (ssh?.enabled && ssh.remoteId) {
		const workingDirOverride = ssh.workingDirOverride?.trim();
		defaults.sessionSshRemoteConfig = {
			enabled: true,
			remoteId: ssh.remoteId,
			...(workingDirOverride ? { workingDirOverride } : {}),
			...(ssh.syncHistory ? { syncHistory: true } : {}),
			...(ssh.shareHistoryToProjectDir ? { shareHistoryToProjectDir: true } : {}),
		};
	} else if (ssh?.shareHistoryToProjectDir) {
		defaults.sessionSshRemoteConfig = {
			enabled: false,
			remoteId: null,
			shareHistoryToProjectDir: true,
		};
	}

	return { ok: true, defaults: Object.keys(defaults).length > 0 ? defaults : undefined };
}
