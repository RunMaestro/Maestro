import type { Session, Group, Theme, GroupChat } from '../../types';

export interface ProcessMonitorProps {
	theme: Theme;
	sessions: Session[];
	groups: Group[];
	groupChats?: GroupChat[];
	onClose: () => void;
	onNavigateToSession?: (sessionId: string, tabId?: string, processType?: string) => void;
	onNavigateToGroupChat?: (groupChatId: string) => void;
}

export interface ActiveProcess {
	sessionId: string;
	toolType: string;
	pid: number;
	cwd: string;
	isTerminal: boolean;
	isBatchMode: boolean;
	startTime?: number;
	command?: string;
	args?: string[];
	isCueRun?: boolean;
	cueRunId?: string;
	cueSessionName?: string;
	cueSubscriptionName?: string;
	cueEventType?: string;
	childProcesses?: Array<{ pid: number; command: string }>;
	/** Env vars Maestro is explicitly setting on this process (global + agent + session overrides). */
	maestroEnvVars?: Record<string, string>;
	/** For SSH spawns: the agent invocation running on the remote host. */
	sshRemoteCommand?: string;
}

export type ProcessTypeTag =
	| 'ai'
	| 'terminal'
	| 'batch'
	| 'synopsis'
	| 'moderator'
	| 'participant'
	| 'wizard'
	| 'wizard-gen'
	| 'cue'
	/** An ephemeral `cross-agent-*` consult spawned by an `@mention`. */
	| 'consult';

/** The fields of an agent its mode pill reads. */
export type ModeAgent = Pick<
	Session,
	'id' | 'liftedTo' | 'sessionSshRemoteConfig' | 'sshConnectionFailed'
>;

export interface ProcessNode {
	id: string;
	type: 'group' | 'session' | 'process' | 'groupchat';
	label: string;
	emoji?: string;
	sessionId?: string;
	processSessionId?: string;
	pid?: number;
	processType?: ProcessTypeTag;
	isAlive?: boolean;
	children?: ProcessNode[];
	toolType?: string;
	cwd?: string;
	agentSessionId?: string;
	tabId?: string;
	startTime?: number;
	isAutoRun?: boolean;
	groupChatId?: string;
	participantName?: string;
	command?: string;
	args?: string[];
	/**
	 * A session row's agent, for its mode pill (`AgentModePill`): the one mark of mode, the same
	 * as the Left Bar row. Never a remote's name or a transport badge of its own.
	 */
	modeAgent?: ModeAgent;
	countLabel?: string;
	cueRunId?: string;
	cueSubscriptionName?: string;
	cueEventType?: string;
	cueSessionName?: string;
	tabName?: string;
	childProcesses?: Array<{ pid: number; command: string }>;
	maestroEnvVars?: Record<string, string>;
	/** For SSH spawns: the agent invocation running on the remote host. */
	sshRemoteCommand?: string;
}

export interface ProcessDetailData {
	processSessionId: string;
	pid: number;
	toolType: string;
	cwd: string;
	startTime: number;
	command?: string;
	args?: string[];
	agentSessionId?: string;
	sessionName?: string;
	processType?: string;
	isAutoRun?: boolean;
	cueRunId?: string;
	cueSubscriptionName?: string;
	cueEventType?: string;
	cueSessionName?: string;
	tabName?: string;
	childProcesses?: Array<{ pid: number; command: string }>;
	maestroEnvVars?: Record<string, string>;
	/** For SSH spawns: the agent invocation running on the remote host. */
	sshRemoteCommand?: string;
}
