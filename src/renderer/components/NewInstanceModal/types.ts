import type React from 'react';
import type {
	AdditionalDirectory,
	AgentConfig,
	AITab,
	Session,
	ToolType,
	Theme,
} from '../../types';
import { PICKABLE_AGENT_IDS } from '../../../shared/agentMetadata';
import type { CodexTransport } from '../../../shared/codexTransport';
import type { HarnessControlMode } from '../../../shared/maestro-lib/providers/native-control';

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
 * The settings of one new agent, as the New Agent modal hands them over
 * (to `onCreate`, or to `onCapture` in capture mode).
 *
 * `createNewSession()` (`useSessionCrud.ts`) creates the agent from a draft,
 * and the CLI / web `create_session` handler turns its request into one, so
 * both build the agent with `buildNewAgentSession()`
 * (`utils/newAgentSession.ts`). Values arrive resolved: trimmed, defaults
 * applied, an unset field `undefined`.
 */
export interface NewAgentDraft {
	/** Provider id; the agent's `toolType`. */
	agentId: string;
	/** The agent's `cwd`. With SSH on, a path on the remote host. */
	workingDir: string;
	name: string;
	nudgeMessage?: string;
	newSessionMessage?: string;
	customPath?: string;
	customArgs?: string;
	customEnvVars?: Record<string, string>;
	customModel?: string;
	customContextWindow?: number;
	customProviderPath?: string;
	sessionSshRemoteConfig?: SessionSshRemoteConfig;
	customEffort?: string;
	groupId?: string;
	enableMaestroP?: boolean;
	maestroPPath?: string;
	maestroPMode?: 'interactive' | 'dynamic';
	retryOnAvailabilityErrors?: boolean;
	retryOnTokenExhaustion?: boolean;
	additionalDirectories?: AdditionalDirectory[];
	/** Codex only: spend a reset credit automatically on quota exhaustion. Defaults off. */
	codexAutoResetOnExhaustion?: boolean;
	/** Codex only: which transport chat turns use. `undefined` means `exec`. */
	codexTransport?: CodexTransport;
	harnessControlMode?: HarnessControlMode;
	/** Permission mode for the fresh initial tab; omitted for ordinary new agents. */
	permissionMode?: AITab['permissionMode'];
}

interface NewInstanceModalBaseProps {
	isOpen: boolean;
	onClose: () => void;
	theme: Theme;
	existingSessions: Session[];
	sourceSession?: Session; // Optional session to duplicate from
	presetGroupId?: string | null; // Group to place the new agent in (ignored when duplicating - duplicate inherits source's group)
	presetWorkingDir?: string | null; // Working directory to seed, plus a default name from its basename (ignored when duplicating - duplicate inherits source's cwd)
	/**
	 * Settings to prefill, read once each time the modal opens (later changes
	 * wait for the next open). A key the draft holds sets that field, an
	 * `undefined` value included: it clears what the modal would otherwise
	 * show, such as the provider's default model. A key the draft leaves out
	 * keeps that default. So a draft from `onCapture`, passed back, reopens the
	 * form as it was captured. Per-agent fields apply to `agentId`, or to the
	 * agent the modal picks when the draft names none. Wins over
	 * `presetGroupId` and `presetWorkingDir`; ignored when duplicating.
	 */
	initialDraft?: Partial<NewAgentDraft>;
}

/**
 * `'create'` (the default) hands the draft to `onCreate`, which creates the
 * agent. `'capture'` runs the same form and validation but hands the draft to
 * `onCapture` and creates nothing, for a caller that creates the agent later
 * (Playbook Launch). Each mode takes only its own callback.
 */
export type NewInstanceModalProps = NewInstanceModalBaseProps &
	(
		| { mode?: 'create'; onCreate: (draft: NewAgentDraft) => void; onCapture?: never }
		| { mode: 'capture'; onCapture: (draft: NewAgentDraft) => void; onCreate?: never }
	);

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
		harnessControlMode?: HarnessControlMode,
		acceptTranslationLimitations?: boolean,
		selectedUserResources?: string[],
		migrationPlanId?: string,
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
	/** Native protocol mode, per agent id. Defaults to current. */
	harnessControlModeByAgent?: Record<string, HarnessControlMode>;
	onHarnessControlModeChange?: (agentId: string, value: HarnessControlMode) => void;
}
