import type { AgentConfig, SessionInfo } from '../../shared/types';
import type { Session } from '../../renderer/types';
import type { AgentCapabilities } from '../../renderer/hooks/agent/useAgentCapabilities';
import type { AgentSession } from '../../renderer/hooks/agent/useSessionViewer';

export const OPENCLAW_FIXTURE_AGENT_NAME = 'main';
export const OPENCLAW_FIXTURE_RAW_SESSION_ID = '1234-uuid';
export const OPENCLAW_FIXTURE_CANONICAL_SESSION_ID = `${OPENCLAW_FIXTURE_AGENT_NAME}:${OPENCLAW_FIXTURE_RAW_SESSION_ID}`;
export const OPENCLAW_FIXTURE_PROJECT_PATH = '/tmp/openclaw-regression-project';
export const OPENCLAW_FIXTURE_USER_MESSAGE = 'First message for OpenClaw';
export const OPENCLAW_FIXTURE_ASSISTANT_MESSAGE = 'Reply from OpenClaw';

const OPENCLAW_DEFAULT_CAPABILITIES: AgentCapabilities = {
	supportsResume: true,
	supportsReadOnlyMode: true,
	supportsJsonOutput: true,
	supportsSessionId: true,
	supportsImageInput: true,
	supportsImageInputOnResume: true,
	supportsSlashCommands: true,
	supportsSessionStorage: true,
	supportsCostTracking: true,
	supportsUsageStats: true,
	supportsBatchMode: true,
	requiresPromptToStart: false,
	supportsStreaming: false,
	supportsResultMessages: true,
	supportsModelSelection: false,
	supportsStreamJsonInput: false,
	supportsThinkingDisplay: false,
	supportsContextMerge: false,
	supportsContextExport: false,
	supportsWizard: false,
	supportsGroupChatModeration: false,
	usesJsonLineOutput: false,
	usesCombinedContextWindow: true,
};

export function createOpenClawCapabilities(
	overrides: Partial<AgentCapabilities> = {}
): AgentCapabilities {
	return {
		...OPENCLAW_DEFAULT_CAPABILITIES,
		...overrides,
	};
}

export function createOpenClawAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		id: 'openclaw',
		name: 'OpenClaw',
		available: true,
		path: '/usr/local/bin/openclaw',
		binaryName: 'openclaw',
		command: 'openclaw',
		args: [],
		hidden: false,
		...overrides,
	};
}

export function createOpenClawSessionInfo(overrides: Partial<SessionInfo> = {}): SessionInfo {
	return {
		id: 'session-openclaw-1',
		name: 'OpenClaw Test Session',
		toolType: 'openclaw',
		cwd: OPENCLAW_FIXTURE_PROJECT_PATH,
		projectRoot: OPENCLAW_FIXTURE_PROJECT_PATH,
		groupId: 'group-openclaw',
		...overrides,
	};
}

export function createOpenClawRendererSession(overrides: Partial<Session> = {}): Session {
	return {
		id: 'renderer-openclaw-session-1',
		name: 'OpenClaw Test Session',
		toolType: 'openclaw',
		state: 'idle',
		cwd: OPENCLAW_FIXTURE_PROJECT_PATH,
		fullPath: OPENCLAW_FIXTURE_PROJECT_PATH,
		projectRoot: OPENCLAW_FIXTURE_PROJECT_PATH,
		aiLogs: [],
		shellLogs: [],
		workLog: [],
		contextUsage: 0,
		inputMode: 'ai',
		aiPid: 0,
		terminalPid: 0,
		port: 0,
		isLive: false,
		changedFiles: [],
		isGitRepo: false,
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		activeTimeMs: 0,
		executionQueue: [],
		aiTabs: [],
		activeTabId: '',
		closedTabHistory: [],
		filePreviewTabs: [],
		activeFileTabId: null,
		unifiedTabOrder: [],
		unifiedClosedTabHistory: [],
		...overrides,
	} as Session;
}

export function createOpenClawAgentSession(overrides: Partial<AgentSession> = {}): AgentSession {
	return {
		sessionId: OPENCLAW_FIXTURE_CANONICAL_SESSION_ID,
		projectPath: OPENCLAW_FIXTURE_PROJECT_PATH,
		timestamp: '2026-04-03T00:00:00.000Z',
		modifiedAt: '2026-04-03T00:00:00.000Z',
		firstMessage: OPENCLAW_FIXTURE_USER_MESSAGE,
		messageCount: 3,
		sizeBytes: 2048,
		inputTokens: 10,
		outputTokens: 20,
		cacheReadTokens: 0,
		cacheCreationTokens: 0,
		durationSeconds: 15,
		...overrides,
	};
}

export function createOpenClawJsonResult(
	overrides: Record<string, unknown> = {}
): Record<string, unknown> {
	return {
		payloads: [{ text: 'Hello', mediaUrl: null }],
		meta: {
			durationMs: 123,
			agentMeta: {
				sessionId: OPENCLAW_FIXTURE_RAW_SESSION_ID,
				provider: 'anthropic',
				model: 'claude-sonnet-4-6',
				usage: { input: 1, output: 2, cacheWrite: 3, total: 6 },
				lastCallUsage: { input: 1, output: 2, cacheRead: 4, cacheWrite: 3, total: 6 },
			},
		},
		...overrides,
	};
}

export function createOpenClawSessionJsonl(
	overrides: {
		agentName?: string;
		rawSessionId?: string;
		initSessionId?: string;
		projectPath?: string;
		userMessage?: string;
		assistantMessage?: string;
	} = {}
): string {
	const agentName = overrides.agentName ?? OPENCLAW_FIXTURE_AGENT_NAME;
	const rawSessionId = overrides.rawSessionId ?? OPENCLAW_FIXTURE_RAW_SESSION_ID;
	const initSessionId = overrides.initSessionId ?? rawSessionId;
	const projectPath = overrides.projectPath ?? OPENCLAW_FIXTURE_PROJECT_PATH;
	const userMessage = overrides.userMessage ?? OPENCLAW_FIXTURE_USER_MESSAGE;
	const assistantMessage = overrides.assistantMessage ?? OPENCLAW_FIXTURE_ASSISTANT_MESSAGE;

	return `
${JSON.stringify({
	type: 'session',
	version: 3,
	id: initSessionId,
	timestamp: '2026-04-01T10:00:00.000Z',
	cwd: projectPath,
})}
${JSON.stringify({
	type: 'message',
	id: `${agentName}-msg-1`,
	parentId: 'parent-1',
	timestamp: '2026-04-01T10:00:01.000Z',
	message: {
		role: 'user',
		content: [{ type: 'text', text: userMessage }],
	},
})}
${JSON.stringify({
	type: 'message',
	id: `${agentName}-msg-2`,
	parentId: `${agentName}-msg-1`,
	timestamp: '2026-04-01T10:00:02.000Z',
	message: {
		role: 'assistant',
		content: [{ type: 'text', text: assistantMessage }],
	},
})}
`;
}
