import type { Session } from '../../renderer/types';

/**
 * Shared test factory for the `Session` interface.
 *
 * Produces a fully-populated `Session` with sensible defaults for every
 * required field. Tests should override only the fields they care about via
 * the `overrides` parameter.
 *
 * Phase 03A of the dedup effort: this replaces ~66 per-file copies of the
 * same factory. Prefer extending this helper over creating a new local copy.
 * If a single test needs a thin wrapper (pre-populated AI tabs, a different
 * positional signature, etc.) the wrapper should still delegate to this
 * factory rather than duplicating the defaults.
 */
export function createMockSession(overrides: Partial<Session> = {}): Session {
	return {
		id: 'session-1',
		name: 'Test Session',
		toolType: 'claude-code',
		state: 'idle',
		cwd: '/test/project',
		fullPath: '/test/project',
		projectRoot: '/test/project',
		createdAt: 0,
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
		executionQueue: [],
		activeTimeMs: 0,
		aiTabs: [],
		activeTabId: '',
		closedTabHistory: [],
		filePreviewTabs: [],
		activeFileTabId: null,
		browserTabs: [],
		activeBrowserTabId: null,
		terminalTabs: [],
		activeTerminalTabId: null,
		unifiedTabOrder: [],
		unifiedClosedTabHistory: [],
		// Tab tiling (split panes). Persistence is forward-compatible: the main-process
		// StoredSession uses a `[key: string]: any` index signature, so these fields
		// persist with no migration.
		tabGroups: [],
		activeGroupId: null,
		...overrides,
	} as Session;
}

/** The three agent modes a parity test renders a surface in. */
export const AGENT_MODES = ['local', 'ssh', 'hosted'] as const;
export type AgentMode = (typeof AGENT_MODES)[number];

/**
 * The same agent as a local, an SSH, or a hosted SSH agent. SSH sets the remote config
 * and the spawned `sshRemoteId`; hosted is that SSH agent once lifted onto its remote's
 * host (`liftedTo`). Parity tests (docs/parity/agent-ux-parity.md) render a surface with
 * each and assert the same output.
 */
export function createModeSession(mode: AgentMode, overrides: Partial<Session> = {}): Session {
	return createMockSession({ ...agentModeFields(mode), ...overrides } as Partial<Session>);
}

/**
 * Only the fields that make an agent local, SSH, or hosted, for a suite that builds its
 * sessions with its own factory (spread them into that factory's overrides).
 */
export function agentModeFields(mode: AgentMode): Partial<Session> {
	if (mode === 'local') return {};
	return {
		sshRemoteId: 'r1',
		sessionSshRemoteConfig: { enabled: true, remoteId: 'r1' },
		...(mode === 'hosted' ? { liftedTo: { peer: 'box', agentId: 'h1', at: 1 } } : {}),
	} as Partial<Session>;
}
