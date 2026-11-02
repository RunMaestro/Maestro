import type React from 'react';
import type { AdditionalDirectory, AgentConfig, Session, ToolType, Theme } from '../../types';
import { PICKABLE_AGENT_IDS } from '../../../shared/agentMetadata';
import type { CodexTransport } from '../../../shared/codexTransport';
import type { RunOnSourceTarget } from '../../../shared/local-models/run-on';
import type { TierTargetAgent, TierTargets } from '../../../shared/modelTiers';
import type { PeerGrants } from '../../../shared/peerAgents';
import type { GroupDefaultsCreateExtras } from '../../../shared/groupAgentDefaults';

// Maximum character length for nudge message and new session message
export const NUDGE_MESSAGE_MAX_LENGTH = 1000;
export const NEW_SESSION_MESSAGE_MAX_LENGTH = 5000;

/**
 * Providers a user may pick in the New Agent modal.
 *
 * Re-exported from the shared picker registry rather than hand-written, so this
 * list cannot drift from the wizard's tile strip or the Group Chat moderator
 * dropdown the way it did while Grok and Qwen3 Coder were listed only here.
 */
export const SUPPORTED_AGENTS: readonly string[] = PICKABLE_AGENT_IDS;

export interface AgentDebugInfo {
	agentId: string;
	available: boolean;
	path: string | null;
	binaryName: string;
	envPath: string;
	homeDir: string;
	platform: string;
	whichCommand: string;
	error: string | null;
}

export interface SessionSshRemoteConfig {
	enabled: boolean;
	remoteId: string | null;
	workingDirOverride?: string;
	syncHistory?: boolean;
	shareHistoryToProjectDir?: boolean;
}

/**
 * What the New Agent form can be pre-filled from: the fields `loadAgents` reads
 * off its source, all optional. An agent being duplicated (`Session`) and a
 * group's defaults (`GroupAgentDefaults`) both satisfy it, so the form has one
 * pre-fill path for both.
 *
 * A seed with no `toolType` selects no provider and fills none of the settings
 * written for one provider's binary or API. A group default's env vars,
 * resilience flags and SSH remote are not among those: `loadAgents` fills them
 * for every provider. A seed with no `name` leaves the name alone. A seed gives
 * its working directory as `cwd` (an agent) or `projectRoot` (a group default,
 * which has no `cwd`).
 */
export type AgentSeed = Partial<
	Pick<
		Session,
		| 'name'
		| 'toolType'
		| 'cwd'
		| 'projectRoot'
		| 'additionalDirectories'
		| 'peerAgents'
		| 'peerDescription'
		| 'groupPeerAccess'
		| 'worktreePeerAccess'
		| 'nudgeMessage'
		| 'newSessionMessage'
		| 'customPath'
		| 'customArgs'
		| 'customEnvVars'
		| 'customModel'
		| 'customEffort'
		| 'customContextWindow'
		| 'customProviderPath'
		| 'enableMaestroP'
		| 'maestroPMode'
		| 'maestroPPath'
		| 'retryOnAvailabilityErrors'
		| 'retryOnTokenExhaustion'
		| 'codexAutoResetOnExhaustion'
		| 'codexTransport'
		| 'gatewayUrl'
		| 'runOn'
		| 'sessionSshRemoteConfig'
	>
>;

export interface NewInstanceModalProps {
	isOpen: boolean;
	onClose: () => void;
	onCreate: (
		agentId: string,
		workingDir: string,
		name: string,
		nudgeMessage?: string,
		newSessionMessage?: string,
		customPath?: string,
		customArgs?: string,
		customEnvVars?: Record<string, string>,
		customModel?: string,
		customContextWindow?: number,
		customProviderPath?: string,
		sessionSshRemoteConfig?: SessionSshRemoteConfig,
		customEffort?: string,
		groupId?: string,
		enableMaestroP?: boolean,
		maestroPPath?: string,
		maestroPMode?: 'interactive' | 'dynamic',
		retryOnAvailabilityErrors?: boolean,
		retryOnTokenExhaustion?: boolean,
		additionalDirectories?: AdditionalDirectory[],
		/** Codex only: spend a reset credit automatically on quota exhaustion. Defaults off. */
		codexAutoResetOnExhaustion?: boolean,
		/** Codex only: which transport chat turns use. `undefined` means `exec`. */
		codexTransport?: CodexTransport,
		/** Local Models gateway URL, already validated; `undefined` sets none. */
		gatewayUrl?: string,
		/** Run on target, already validated; `undefined` means the provider's model. */
		runOn?: RunOnSourceTarget,
		/** Peer Agents: the explicit rows and the two grants. An absent field means that source is off. */
		peerGrants?: PeerGrants,
		/** Group defaults the create form has no control for; stamped onto the new agent. */
		seedExtras?: GroupDefaultsCreateExtras
	) => void;
	theme: Theme;
	existingSessions: Session[];
	sourceSession?: Session; // Optional session to duplicate from
	presetGroupId?: string | null; // Group to place the new agent in (ignored when duplicating - duplicate inherits source's group)
	presetWorkingDir?: string | null; // Working directory to seed, plus a default name from its basename (ignored when duplicating - duplicate inherits source's cwd)
}

export interface EditAgentModalProps {
	isOpen: boolean;
	onClose: () => void;
	onSave: (
		sessionId: string,
		name: string,
		toolType?: ToolType,
		nudgeMessage?: string,
		newSessionMessage?: string,
		customPath?: string,
		customArgs?: string,
		customEnvVars?: Record<string, string>,
		customModel?: string,
		customEffort?: string,
		customContextWindow?: number,
		sessionSshRemoteConfig?: SessionSshRemoteConfig,
		enableMaestroP?: boolean,
		maestroPPath?: string,
		maestroPMode?: 'interactive' | 'dynamic',
		retryOnAvailabilityErrors?: boolean,
		retryOnTokenExhaustion?: boolean,
		additionalDirectories?: AdditionalDirectory[],
		/** Provenance of `customContextWindow` (finding AD1). */
		contextWindowSource?: 'user-edited',
		/** Env vars parked with the eye button: kept, but never handed to a spawn. */
		customEnvVarsDisabled?: Record<string, string>,
		/** New working directory; `undefined` when the user left it unchanged. */
		workingDirectory?: string,
		/** Codex only: spend a reset credit automatically on quota exhaustion. Defaults off. */
		codexAutoResetOnExhaustion?: boolean,
		/** Codex only: which transport chat turns use. `undefined` means `exec`. */
		codexTransport?: CodexTransport,
		/** Local Models gateway URL, already validated; `undefined` clears it. */
		gatewayUrl?: string,
		/** Run on target, already validated; `undefined` means the provider's model. */
		runOn?: RunOnSourceTarget,
		/** Tier targets, already validated; `undefined` means no tier is set on the agent. */
		tierTargets?: TierTargets,
		/** Peer Agents: the explicit rows and the two grants. An absent field clears that source. */
		peerGrants?: PeerGrants,
		acceptTranslationLimitations?: boolean,
		selectedUserResources?: string[],
		migrationPlanId?: string,
		projectResourcesIntoRepo?: boolean,
		/** On a provider change: convert memory and session history (opt-in) or switch plainly. */
		convertProviderHistory?: boolean
	) => void | Promise<void>;
	theme: Theme;
	session: Session | null;
	existingSessions: Session[];
}

export interface RemotePathValidationState {
	checking: boolean;
	valid: boolean;
	isDirectory: boolean;
	error?: string;
}

export interface NudgeMessageFieldProps {
	theme: Theme;
	value: string;
	onChange: (value: string) => void;
	maxLength?: number;
	label?: string;
	labelSuffix?: string;
	description?: React.ReactNode;
	placeholder?: string;
	/** Key the user's dragged textarea height is remembered under. */
	sizeKey?: string;
}

export interface RemotePathStatusProps {
	theme: Theme;
	validation: RemotePathValidationState;
	remoteHost?: string;
}

export interface AgentPickerGridProps {
	theme: Theme;
	loading: boolean;
	sshConnectionError: string | null;
	/** The rows to render - already sorted AND filtered by the availability toggle. */
	visibleAgents: AgentConfig[];
	/** Supported providers detected on the target machine, across the WHOLE list. */
	availableProviderCount: number;
	/** Supported providers in total. Never the length of `visibleAgents`. */
	totalProviderCount: number;
	/** Follows "available" in the summary - "locally" or "on <host>". */
	providerLocationLabel: string;
	showAllProviders: boolean;
	onShowAllProvidersChange: (showAll: boolean) => void;
	selectedAgent: string;
	expandedAgent: string | null;
	refreshingAgent: string | null;
	debugInfo: AgentDebugInfo | null;
	customAgentPaths: Record<string, string>;
	customAgentArgs: Record<string, string>;
	customAgentEnvVars: Record<string, Record<string, string>>;
	enableMaestroPByAgent?: Record<string, boolean>;
	maestroPModeByAgent?: Record<string, 'interactive' | 'dynamic'>;
	maestroPPathByAgent?: Record<string, string>;
	detectedMaestroPPath?: string;
	agentConfigs: Record<string, Record<string, any>>;
	availableModels: Record<string, string[]>;
	loadingModels: Record<string, boolean>;
	onAgentSelect: (agentId: string) => void;
	onAgentExpand: (agentId: string | null) => void;
	onRefreshAgent: (agentId: string) => void;
	onDismissDebug: () => void;
	onCustomPathChange: (agentId: string, value: string) => void;
	onCustomArgsChange: (agentId: string, value: string) => void;
	onEnableMaestroPChange?: (agentId: string, value: boolean) => void;
	onMaestroPModeChange?: (agentId: string, value: 'interactive' | 'dynamic') => void;
	onMaestroPPathChange?: (agentId: string, value: string) => void;
	onEnvVarKeyChange: (agentId: string, oldKey: string, newKey: string, value: string) => void;
	onEnvVarValueChange: (agentId: string, key: string, value: string) => void;
	onEnvVarRemove: (agentId: string, key: string) => void;
	onEnvVarAdd: (agentId: string) => void;
	/** Replace an agent's variables whole (Advanced `.env` mode). */
	onEnvVarsReplace: (agentId: string, vars: Record<string, string>) => void;
	onConfigChange: (agentId: string, key: string, value: any) => void;
	onConfigBlur: (agentId: string, key: string, value: any) => void;
	onRefreshModels: (agentId: string) => void;
	onTransferPendingSshConfig: (agentId: string) => void;
	onLoadModelsForAgent: (agentId: string) => void;
	dynamicOptions?: Record<string, Record<string, string[]>>;
	loadingDynamicOptions?: Record<string, boolean>;
	onLoadDynamicOptionsForAgent?: (agentId: string) => void;
	/** Codex automatic usage resets, per agent id. Defaults off when absent. */
	codexAutoResetByAgent?: Record<string, boolean>;
	onCodexAutoResetChange?: (agentId: string, value: boolean) => void;
	/** Codex transport, per agent id. Defaults to `exec` when absent. */
	codexTransportByAgent?: Record<string, CodexTransport>;
	onCodexTransportChange?: (agentId: string, value: CodexTransport) => void;
	/**
	 * Leave env vars out of each provider's settings panel. The tabbed New Agent
	 * form edits them in its Provider panel instead.
	 */
	hideEnvVars?: boolean;
	/** Offer Auto in each provider's model field (`AgentConfigPanelProps.autoModelFor`). */
	autoModelFor?: Pick<TierTargetAgent, 'tierTargets' | 'runOn'>;
}
