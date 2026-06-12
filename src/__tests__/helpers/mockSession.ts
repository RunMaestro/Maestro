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
		...overrides,
	} as Session;
}
