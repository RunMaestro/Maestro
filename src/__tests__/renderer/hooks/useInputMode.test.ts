/**
 * Tests for useInputMode hook (Tier 3A extraction from App.tsx)
 *
 * Tests:
 *   - Returns toggleInputMode function
 *   - Toggles from ai to terminal mode
 *   - Toggles from terminal to ai mode
 *   - Saves activeFileTabId when switching to terminal
 *   - Clears activeFileTabId when switching to terminal
 *   - Restores saved file tab when switching to AI (if tab still exists)
 *   - Does not restore file tab if it no longer exists in filePreviewTabs
 *   - Clears preTerminalFileTabId when switching to AI
 *   - Calls setTabCompletionOpen(false) on toggle
 *   - Calls setSlashCommandOpen(false) on toggle
 *   - Only modifies the active session (other sessions unchanged)
 *   - No-op when no sessions exist
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

// ============================================================================
// Imports
// ============================================================================

import { useInputMode } from '../../../renderer/hooks/input/useInputMode';
import type { UseInputModeDeps } from '../../../renderer/hooks/input/useInputMode';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useUIStore } from '../../../renderer/stores/uiStore';
import type { Session, AITab, FilePreviewTab } from '../../../renderer/types';

// ============================================================================
// Helpers
// ============================================================================

function makeTab(overrides: Partial<AITab> = {}): AITab {
	return {
		id: 'tab-1',
		agentSessionId: null,
		name: null,
		starred: false,
		logs: [],
		inputValue: '',
		stagedImages: [],
		createdAt: Date.now(),
		state: 'idle',
		saveToHistory: false,
		showThinking: false,
		...overrides,
	} as AITab;
}

function makeFilePreviewTab(overrides: Partial<FilePreviewTab> = {}): FilePreviewTab {
	return {
		id: 'file-tab-1',
		path: '/test/file.ts',
		name: 'file',
		extension: '.ts',
		content: 'content',
		scrollTop: 0,
		searchQuery: '',
		editMode: false,
		editContent: undefined,
		createdAt: Date.now(),
		lastModified: Date.now(),
		...overrides,
	};
}

function makeSession(overrides: Partial<Session> = {}): Session {
	const tab = makeTab(overrides.aiTabs?.[0] ? overrides.aiTabs[0] : {});
	return {
		id: 'sess-1',
		name: 'Test Session',
		toolType: 'claude-code' as any,
		state: 'idle',
		cwd: '/test/project',
		fullPath: '/test/project',
		projectRoot: '/test/project',
		isGitRepo: false,
		aiLogs: [],
		shellLogs: [],
		workLog: [],
		contextUsage: 0,
		inputMode: 'ai',
		aiPid: 1234,
		terminalPid: 0,
		port: 3001,
		isLive: false,
		changedFiles: [],
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		fileTreeAutoRefreshInterval: 180,
		shellCwd: '/test/project',
		aiCommandHistory: [],
		shellCommandHistory: [],
		executionQueue: [],
		activeTimeMs: 0,
		aiTabs: [tab],
		activeTabId: tab.id,
		closedTabHistory: [],
		filePreviewTabs: [],
		activeFileTabId: null,
		unifiedTabOrder: [{ type: 'ai' as const, id: tab.id }],
		unifiedClosedTabHistory: [],
		autoRunFolderPath: '/test/project/Auto Run Docs',
		...overrides,
		// Ensure aiTabs uses proper tab objects
		...(overrides.aiTabs ? { aiTabs: overrides.aiTabs } : {}),
	} as Session;
}

function makeDeps(overrides: Partial<UseInputModeDeps> = {}): UseInputModeDeps {
	return {
		setTabCompletionOpen: vi.fn(),
		setSlashCommandOpen: vi.fn(),
		...overrides,
	};
}

// ============================================================================
// Setup / Teardown
// ============================================================================

beforeEach(() => {
	vi.clearAllMocks();

	useSessionStore.setState({
		sessions: [],
		groups: [],
		activeSessionId: '',
		sessionsLoaded: false,
		initialLoadComplete: false,
		removedWorktreePaths: new Set(),
		cyclePosition: -1,
	});

	useUIStore.setState({
		preTerminalFileTabId: null,
	});
});

afterEach(() => {
	cleanup();
});

// ============================================================================
// Tests
// ============================================================================

describe('useInputMode', () => {
	it('returns toggleInputMode function', () => {
		const deps = makeDeps();
		const { result } = renderHook(() => useInputMode(deps));

		expect(result.current.toggleInputMode).toBeDefined();
		expect(typeof result.current.toggleInputMode).toBe('function');
	});

	it('toggles from ai to terminal mode', () => {
		const session = makeSession({ id: 'sess-1', inputMode: 'ai' });
		useSessionStore.setState({ sessions: [session], activeSessionId: 'sess-1' });
		const deps = makeDeps();

		const { result } = renderHook(() => useInputMode(deps));

		act(() => {
			result.current.toggleInputMode();
		});

		const updated = useSessionStore.getState().sessions[0];
		expect(updated.inputMode).toBe('terminal');
	});

	it('toggles from terminal to ai mode', () => {
		const session = makeSession({ id: 'sess-1', inputMode: 'terminal' });
		useSessionStore.setState({ sessions: [session], activeSessionId: 'sess-1' });
		const deps = makeDeps();

		const { result } = renderHook(() => useInputMode(deps));

		act(() => {
			result.current.toggleInputMode();
		});

		const updated = useSessionStore.getState().sessions[0];
		expect(updated.inputMode).toBe('ai');
	});

	it('saves activeFileTabId when switching to terminal via setPreTerminalFileTabId', () => {
		const fileTab = makeFilePreviewTab({ id: 'file-tab-42' });
		const session = makeSession({
			id: 'sess-1',
			inputMode: 'ai',
			activeFileTabId: 'file-tab-42',
			filePreviewTabs: [fileTab],
		});
		useSessionStore.setState({ sessions: [session], activeSessionId: 'sess-1' });
		const deps = makeDeps();

		const { result } = renderHook(() => useInputMode(deps));

		act(() => {
			result.current.toggleInputMode();
		});

		expect(useUIStore.getState().preTerminalFileTabId).toBe('file-tab-42');
	});

	it('clears activeFileTabId when switching to terminal', () => {
		const fileTab = makeFilePreviewTab({ id: 'file-tab-42' });
		const session = makeSession({
			id: 'sess-1',
			inputMode: 'ai',
			activeFileTabId: 'file-tab-42',
			filePreviewTabs: [fileTab],
		});
		useSessionStore.setState({ sessions: [session], activeSessionId: 'sess-1' });
		const deps = makeDeps();

		const { result } = renderHook(() => useInputMode(deps));

		act(() => {
			result.current.toggleInputMode();
		});

		const updated = useSessionStore.getState().sessions[0];
		expect(updated.activeFileTabId).toBeNull();
	});

	it('restores saved file tab when switching to AI if tab still exists in filePreviewTabs', () => {
		const fileTab = makeFilePreviewTab({ id: 'file-tab-42' });
		const session = makeSession({
			id: 'sess-1',
			inputMode: 'terminal',
			activeFileTabId: null,
			filePreviewTabs: [fileTab],
		});
		useSessionStore.setState({ sessions: [session], activeSessionId: 'sess-1' });
		useUIStore.setState({ preTerminalFileTabId: 'file-tab-42' });
		const deps = makeDeps();

		const { result } = renderHook(() => useInputMode(deps));

		act(() => {
			result.current.toggleInputMode();
		});

		const updated = useSessionStore.getState().sessions[0];
		expect(updated.activeFileTabId).toBe('file-tab-42');
	});

	it('does not restore file tab if it no longer exists in filePreviewTabs', () => {
		const session = makeSession({
			id: 'sess-1',
			inputMode: 'terminal',
			activeFileTabId: null,
			filePreviewTabs: [], // Tab was removed
		});
		useSessionStore.setState({ sessions: [session], activeSessionId: 'sess-1' });
		useUIStore.setState({ preTerminalFileTabId: 'file-tab-gone' });
		const deps = makeDeps();

		const { result } = renderHook(() => useInputMode(deps));

		act(() => {
			result.current.toggleInputMode();
		});

		const updated = useSessionStore.getState().sessions[0];
		// activeFileTabId should remain null since the saved tab no longer exists
		expect(updated.activeFileTabId).toBeNull();
	});

	it('clears preTerminalFileTabId when switching to AI', () => {
		const fileTab = makeFilePreviewTab({ id: 'file-tab-42' });
		const session = makeSession({
			id: 'sess-1',
			inputMode: 'terminal',
			activeFileTabId: null,
			filePreviewTabs: [fileTab],
		});
		useSessionStore.setState({ sessions: [session], activeSessionId: 'sess-1' });
		useUIStore.setState({ preTerminalFileTabId: 'file-tab-42' });
		const deps = makeDeps();

		const { result } = renderHook(() => useInputMode(deps));

		act(() => {
			result.current.toggleInputMode();
		});

		expect(useUIStore.getState().preTerminalFileTabId).toBeNull();
	});

	it('calls setTabCompletionOpen(false) on toggle', () => {
		const session = makeSession({ id: 'sess-1', inputMode: 'ai' });
		useSessionStore.setState({ sessions: [session], activeSessionId: 'sess-1' });
		const deps = makeDeps();

		const { result } = renderHook(() => useInputMode(deps));

		act(() => {
			result.current.toggleInputMode();
		});

		expect(deps.setTabCompletionOpen).toHaveBeenCalledWith(false);
	});

	it('calls setSlashCommandOpen(false) on toggle', () => {
		const session = makeSession({ id: 'sess-1', inputMode: 'ai' });
		useSessionStore.setState({ sessions: [session], activeSessionId: 'sess-1' });
		const deps = makeDeps();

		const { result } = renderHook(() => useInputMode(deps));

		act(() => {
			result.current.toggleInputMode();
		});

		expect(deps.setSlashCommandOpen).toHaveBeenCalledWith(false);
	});

	it('only modifies the active session, other sessions remain unchanged', () => {
		const session1 = makeSession({ id: 'sess-1', inputMode: 'ai' });
		const session2 = makeSession({ id: 'sess-2', inputMode: 'ai', name: 'Other Session' });
		useSessionStore.setState({
			sessions: [session1, session2],
			activeSessionId: 'sess-1',
		});
		const deps = makeDeps();

		const { result } = renderHook(() => useInputMode(deps));

		act(() => {
			result.current.toggleInputMode();
		});

		const sessions = useSessionStore.getState().sessions;
		expect(sessions[0].inputMode).toBe('terminal');
		expect(sessions[1].inputMode).toBe('ai');
		// Verify session2 is the exact same reference (untouched by the map)
		expect(sessions[1]).toBe(session2);
	});

	it('is a no-op when no sessions exist', () => {
		useSessionStore.setState({ sessions: [], activeSessionId: '' });
		const deps = makeDeps();

		const { result } = renderHook(() => useInputMode(deps));

		act(() => {
			result.current.toggleInputMode();
		});

		// Sessions remain empty, no errors thrown
		expect(useSessionStore.getState().sessions).toEqual([]);
		// Dropdowns are still closed (always called regardless)
		expect(deps.setTabCompletionOpen).toHaveBeenCalledWith(false);
		expect(deps.setSlashCommandOpen).toHaveBeenCalledWith(false);
	});
});
