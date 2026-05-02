import type React from 'react';
import type { AgentConfig, AgentDispatchProfile, Session, ToolType, Theme } from '../../types';

// Maximum character length for nudge message and new session message
export const NUDGE_MESSAGE_MAX_LENGTH = 1000;
export const NEW_SESSION_MESSAGE_MAX_LENGTH = 5000;

// Supported agents that are fully implemented
export const SUPPORTED_AGENTS = [
	'claude-code',
	'opencode',
	'codex',
	'factory-droid',
	'copilot-cli',
];

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
		sessionSshRemoteConfig?: SessionSshRemoteConfig
	) => void;
	theme: Theme;
	existingSessions: Session[];
	sourceSession?: Session; // Optional session to duplicate from
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
		customContextWindow?: number,
		sessionSshRemoteConfig?: SessionSshRemoteConfig,
		dispatchProfile?: AgentDispatchProfile
	) => void;
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
	sortedAgents: AgentConfig[];
	selectedAgent: string;
	expandedAgent: string | null;
	refreshingAgent: string | null;
	debugInfo: AgentDebugInfo | null;
	customAgentPaths: Record<string, string>;
	customAgentArgs: Record<string, string>;
	customAgentEnvVars: Record<string, Record<string, string>>;
	agentConfigs: Record<string, Record<string, any>>;
	availableModels: Record<string, string[]>;
	loadingModels: Record<string, boolean>;
	onAgentSelect: (agentId: string) => void;
	onAgentExpand: (agentId: string | null) => void;
	onRefreshAgent: (agentId: string) => void;
	onDismissDebug: () => void;
	onCustomPathChange: (agentId: string, value: string) => void;
	onCustomArgsChange: (agentId: string, value: string) => void;
	onEnvVarKeyChange: (agentId: string, oldKey: string, newKey: string, value: string) => void;
	onEnvVarValueChange: (agentId: string, key: string, value: string) => void;
	onEnvVarRemove: (agentId: string, key: string) => void;
	onEnvVarAdd: (agentId: string) => void;
	onConfigChange: (agentId: string, key: string, value: any) => void;
	onConfigBlur: (agentId: string, key: string, value: any) => void;
	onRefreshModels: (agentId: string) => void;
	onTransferPendingSshConfig: (agentId: string) => void;
	onLoadModelsForAgent: (agentId: string) => void;
	dynamicOptions?: Record<string, Record<string, string[]>>;
	loadingDynamicOptions?: Record<string, boolean>;
	onLoadDynamicOptionsForAgent?: (agentId: string) => void;
}
