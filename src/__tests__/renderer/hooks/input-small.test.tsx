// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/renderer/hooks/useInputMode.test.ts
// Source: src/__tests__/renderer/hooks/useInputSync.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook as s1_renderHook, act, cleanup } from '@testing-library/react';
// ============================================================================
// Imports
// ============================================================================
import { useInputMode } from '../../../renderer/hooks/input/useInputMode';
import type { UseInputModeDeps } from '../../../renderer/hooks/input/useInputMode';
import { useSessionStore as s1_useSessionStore } from '../../../renderer/stores/sessionStore';
import { useUIStore } from '../../../renderer/stores/uiStore';
import type { Session as S1_Session, AITab, FilePreviewTab } from '../../../renderer/types';
import { renderHook as s2_renderHook } from '@testing-library/react';
import { useInputSync } from '../../../renderer/hooks/input/useInputSync';
import { useComposerInputStore } from '../../../renderer/stores/composerInputStore';
import { useSessionStore as s2_useSessionStore } from '../../../renderer/stores/sessionStore';
import { createMockSession } from '../../helpers/mockSession';
import { createMockAITab } from '../../helpers/mockTab';
import type { Session as S2_Session } from '../../../renderer/types';
// Source: src/__tests__/renderer/hooks/useInputMode.test.ts
describe('', () => {
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
	function makeSession(overrides: Partial<S1_Session> = {}): S1_Session {
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
			autoRunFolderPath: '/test/project/.maestro/playbooks',
			...overrides,
			// Ensure aiTabs uses proper tab objects
			...(overrides.aiTabs ? { aiTabs: overrides.aiTabs } : {}),
		} as S1_Session;
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
		s1_useSessionStore.setState({
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
			const { result } = s1_renderHook(() => useInputMode(deps));
			expect(result.current.toggleInputMode).toBeDefined();
			expect(typeof result.current.toggleInputMode).toBe('function');
		});
		it('toggles from ai to terminal mode', () => {
			const session = makeSession({ id: 'sess-1', inputMode: 'ai' });
			s1_useSessionStore.setState({ sessions: [session], activeSessionId: 'sess-1' });
			const deps = makeDeps();
			const { result } = s1_renderHook(() => useInputMode(deps));
			act(() => {
				result.current.toggleInputMode();
			});
			const updated = s1_useSessionStore.getState().sessions[0];
			expect(updated.inputMode).toBe('terminal');
		});
		it('toggles from terminal to ai mode', () => {
			const session = makeSession({ id: 'sess-1', inputMode: 'terminal' });
			s1_useSessionStore.setState({ sessions: [session], activeSessionId: 'sess-1' });
			const deps = makeDeps();
			const { result } = s1_renderHook(() => useInputMode(deps));
			act(() => {
				result.current.toggleInputMode();
			});
			const updated = s1_useSessionStore.getState().sessions[0];
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
			s1_useSessionStore.setState({ sessions: [session], activeSessionId: 'sess-1' });
			const deps = makeDeps();
			const { result } = s1_renderHook(() => useInputMode(deps));
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
			s1_useSessionStore.setState({ sessions: [session], activeSessionId: 'sess-1' });
			const deps = makeDeps();
			const { result } = s1_renderHook(() => useInputMode(deps));
			act(() => {
				result.current.toggleInputMode();
			});
			const updated = s1_useSessionStore.getState().sessions[0];
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
			s1_useSessionStore.setState({ sessions: [session], activeSessionId: 'sess-1' });
			useUIStore.setState({ preTerminalFileTabId: 'file-tab-42' });
			const deps = makeDeps();
			const { result } = s1_renderHook(() => useInputMode(deps));
			act(() => {
				result.current.toggleInputMode();
			});
			const updated = s1_useSessionStore.getState().sessions[0];
			expect(updated.activeFileTabId).toBe('file-tab-42');
		});
		it('does not restore file tab if it no longer exists in filePreviewTabs', () => {
			const session = makeSession({
				id: 'sess-1',
				inputMode: 'terminal',
				activeFileTabId: null,
				filePreviewTabs: [], // Tab was removed
			});
			s1_useSessionStore.setState({ sessions: [session], activeSessionId: 'sess-1' });
			useUIStore.setState({ preTerminalFileTabId: 'file-tab-gone' });
			const deps = makeDeps();
			const { result } = s1_renderHook(() => useInputMode(deps));
			act(() => {
				result.current.toggleInputMode();
			});
			const updated = s1_useSessionStore.getState().sessions[0];
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
			s1_useSessionStore.setState({ sessions: [session], activeSessionId: 'sess-1' });
			useUIStore.setState({ preTerminalFileTabId: 'file-tab-42' });
			const deps = makeDeps();
			const { result } = s1_renderHook(() => useInputMode(deps));
			act(() => {
				result.current.toggleInputMode();
			});
			expect(useUIStore.getState().preTerminalFileTabId).toBeNull();
		});
		it('calls setTabCompletionOpen(false) on toggle', () => {
			const session = makeSession({ id: 'sess-1', inputMode: 'ai' });
			s1_useSessionStore.setState({ sessions: [session], activeSessionId: 'sess-1' });
			const deps = makeDeps();
			const { result } = s1_renderHook(() => useInputMode(deps));
			act(() => {
				result.current.toggleInputMode();
			});
			expect(deps.setTabCompletionOpen).toHaveBeenCalledWith(false);
		});
		it('calls setSlashCommandOpen(false) on toggle', () => {
			const session = makeSession({ id: 'sess-1', inputMode: 'ai' });
			s1_useSessionStore.setState({ sessions: [session], activeSessionId: 'sess-1' });
			const deps = makeDeps();
			const { result } = s1_renderHook(() => useInputMode(deps));
			act(() => {
				result.current.toggleInputMode();
			});
			expect(deps.setSlashCommandOpen).toHaveBeenCalledWith(false);
		});
		it('only modifies the active session, other sessions remain unchanged', () => {
			const session1 = makeSession({ id: 'sess-1', inputMode: 'ai' });
			const session2 = makeSession({ id: 'sess-2', inputMode: 'ai', name: 'Other Session' });
			s1_useSessionStore.setState({
				sessions: [session1, session2],
				activeSessionId: 'sess-1',
			});
			const deps = makeDeps();
			const { result } = s1_renderHook(() => useInputMode(deps));
			act(() => {
				result.current.toggleInputMode();
			});
			const sessions = s1_useSessionStore.getState().sessions;
			expect(sessions[0].inputMode).toBe('terminal');
			expect(sessions[1].inputMode).toBe('ai');
			// Verify session2 is the exact same reference (untouched by the map)
			expect(sessions[1]).toBe(session2);
		});
		it('is a no-op when no sessions exist', () => {
			s1_useSessionStore.setState({ sessions: [], activeSessionId: '' });
			const deps = makeDeps();
			const { result } = s1_renderHook(() => useInputMode(deps));
			act(() => {
				result.current.toggleInputMode();
			});
			// Sessions remain empty, no errors thrown
			expect(s1_useSessionStore.getState().sessions).toEqual([]);
			// Dropdowns are still closed (always called regardless)
			expect(deps.setTabCompletionOpen).toHaveBeenCalledWith(false);
			expect(deps.setSlashCommandOpen).toHaveBeenCalledWith(false);
		});
	});
});
// Source: src/__tests__/renderer/hooks/useInputSync.test.ts
describe('', () => {
	const TAB_ID = 'tab-1';
	const OTHER_TAB_ID = 'tab-2';
	const SESSION_ID = 'session-1';
	function makeSession(): S2_Session {
		return createMockSession({
			id: SESSION_ID,
			activeTabId: TAB_ID,
			aiTabs: [
				createMockAITab({ id: TAB_ID, inputValue: '', logs: [] }),
				createMockAITab({ id: OTHER_TAB_ID, inputValue: '', logs: [] }),
			],
		});
	}
	/** Run the setSessions updater the hook produced and return the new state. */
	function applySetSessions(
		setSessions: ReturnType<typeof vi.fn>,
		session: S2_Session
	): S2_Session[] {
		let sessions = [session];
		for (const [updater] of setSessions.mock.calls) {
			sessions = typeof updater === 'function' ? updater(sessions) : updater;
		}
		return sessions;
	}
	beforeEach(() => {
		useComposerInputStore.setState({ aiValue: '', terminalValue: '', aiCommandMode: 'off' });
		// rc's useInputSync resolves the active session from the store at flush time
		// (so App does not re-render on every streaming update), rather than taking
		// it as an argument. Seed the store instead of passing a session in.
		s2_useSessionStore.setState({ sessions: [], activeSessionId: '' });
	});
	function seedActiveSession(session: S2_Session) {
		s2_useSessionStore.setState({ sessions: [session], activeSessionId: session.id });
	}
	describe('useInputSync - syncAiInputToSession', () => {
		it('persists the draft text onto the active tab', () => {
			const setSessions = vi.fn();
			const session = makeSession();
			seedActiveSession(session);
			seedActiveSession(session);
			const { result } = s2_renderHook(() => useInputSync({ setSessions }));
			result.current.syncAiInputToSession('half a thought');
			const [updated] = applySetSessions(setSessions, session);
			expect(updated.aiTabs[0].inputValue).toBe('half a thought');
		});
		it('persists command mode alongside the draft', () => {
			useComposerInputStore.setState({ aiCommandMode: 'shell' });
			const setSessions = vi.fn();
			const session = makeSession();
			seedActiveSession(session);
			seedActiveSession(session);
			const { result } = s2_renderHook(() => useInputSync({ setSessions }));
			result.current.syncAiInputToSession('rm -rf build');
			const [updated] = applySetSessions(setSessions, session);
			expect(updated.aiTabs[0].inputValue).toBe('rm -rf build');
			expect(updated.aiTabs[0].commandMode).toBe('shell');
		});
		it('clears command mode on the tab when the composer is not in it', () => {
			// Explicitly false, not absent: a stale `true` left on the tab would route
			// the next restored draft into a shell.
			useComposerInputStore.setState({ aiCommandMode: 'off' });
			const setSessions = vi.fn();
			const session = makeSession();
			session.aiTabs[0].commandMode = 'shell';
			seedActiveSession(session);
			const { result } = s2_renderHook(() => useInputSync({ setSessions }));
			result.current.syncAiInputToSession('talk to the agent');
			const [updated] = applySetSessions(setSessions, session);
			expect(updated.aiTabs[0].commandMode).toBe('off');
		});
		it('reads the mode at flush time, not from a stale closure', () => {
			const setSessions = vi.fn();
			const session = makeSession();
			seedActiveSession(session);
			seedActiveSession(session);
			const { result } = s2_renderHook(() => useInputSync({ setSessions }));
			// Mode flips after the hook rendered - the flush must still see it.
			useComposerInputStore.setState({ aiCommandMode: 'shell' });
			result.current.syncAiInputToSession('ls');
			const [updated] = applySetSessions(setSessions, session);
			expect(updated.aiTabs[0].commandMode).toBe('shell');
		});
		it('does nothing without an active session', () => {
			const setSessions = vi.fn();
			const { result } = s2_renderHook(() => useInputSync({ setSessions }));
			result.current.syncAiInputToSession('anything');
			expect(setSessions).not.toHaveBeenCalled();
		});
		it('writes to the tab it is given, not the tab that happens to be active', () => {
			// Blur and other async flushes can land after the active tab moved. An
			// unattributed write would stamp this text onto the new tab and wipe the
			// draft that tab was holding.
			const setSessions = vi.fn();
			const session = makeSession();
			session.aiTabs[1].inputValue = 'the other tab draft';
			seedActiveSession(session);
			const { result } = s2_renderHook(() => useInputSync({ setSessions }));
			result.current.syncAiInputToSession('typed on tab-1', { tabId: TAB_ID });
			const [updated] = applySetSessions(setSessions, session);
			expect(updated.aiTabs[0].inputValue).toBe('typed on tab-1');
			expect(updated.aiTabs[1].inputValue).toBe('the other tab draft');
		});
		it('leaves the session reference untouched when nothing actually changed', () => {
			// The write-back runs on a typing timer, so a no-op must not churn
			// session identity - that would re-render the app and re-persist.
			const setSessions = vi.fn();
			const session = makeSession();
			session.aiTabs[0].inputValue = 'already stored';
			session.aiTabs[0].commandMode = 'off';
			seedActiveSession(session);
			const { result } = s2_renderHook(() => useInputSync({ setSessions }));
			result.current.syncAiInputToSession('already stored', { tabId: TAB_ID });
			const [updated] = applySetSessions(setSessions, session);
			expect(updated).toBe(session);
		});
	});
	describe('useInputSync - queueAiDraftFlush', () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});
		afterEach(() => {
			vi.useRealTimers();
		});
		it('writes the live draft back to its tab without any blur or submit', () => {
			// The guarantee: text the user typed reaches session state on its own.
			// No flush point (blur, tab switch, send) is load bearing.
			const setSessions = vi.fn();
			const session = makeSession();
			seedActiveSession(session);
			const { result } = s2_renderHook(() => useInputSync({ setSessions }));
			result.current.queueAiDraftFlush(TAB_ID, 'never blurred', 'off');
			expect(setSessions).not.toHaveBeenCalled();
			vi.advanceTimersByTime(500);
			const [updated] = applySetSessions(setSessions, session);
			expect(updated.aiTabs[0].inputValue).toBe('never blurred');
		});
		it('coalesces a burst of keystrokes into one write', () => {
			const setSessions = vi.fn();
			const session = makeSession();
			seedActiveSession(session);
			const { result } = s2_renderHook(() => useInputSync({ setSessions }));
			for (const text of ['n', 'ne', 'nev', 'neve', 'never']) {
				result.current.queueAiDraftFlush(TAB_ID, text, 'off');
			}
			vi.advanceTimersByTime(500);
			expect(setSessions).toHaveBeenCalledTimes(1);
			const [updated] = applySetSessions(setSessions, session);
			expect(updated.aiTabs[0].inputValue).toBe('never');
		});
		it('flushes the previous tab before queuing for a new one', () => {
			// Switching tabs inside the coalescing window must not drop what was
			// typed in the tab being left.
			const setSessions = vi.fn();
			const session = makeSession();
			seedActiveSession(session);
			const { result } = s2_renderHook(() => useInputSync({ setSessions }));
			result.current.queueAiDraftFlush(TAB_ID, 'first tab text', 'off');
			result.current.queueAiDraftFlush(OTHER_TAB_ID, 'second tab text', 'off');
			vi.advanceTimersByTime(500);
			const [updated] = applySetSessions(setSessions, session);
			expect(updated.aiTabs[0].inputValue).toBe('first tab text');
			expect(updated.aiTabs[1].inputValue).toBe('second tab text');
		});
		it('is superseded by an explicit sync, so sent text cannot come back', () => {
			const setSessions = vi.fn();
			const session = makeSession();
			seedActiveSession(session);
			const { result } = s2_renderHook(() => useInputSync({ setSessions }));
			result.current.queueAiDraftFlush(TAB_ID, 'about to be sent', 'off');
			// Sending clears the composer and syncs the empty value.
			result.current.syncAiInputToSession('', { tabId: TAB_ID });
			vi.advanceTimersByTime(500);
			const [updated] = applySetSessions(setSessions, session);
			expect(updated.aiTabs[0].inputValue).toBe('');
		});
		it('flushes a pending draft on unmount', () => {
			const setSessions = vi.fn();
			const session = makeSession();
			seedActiveSession(session);
			const { result, unmount } = s2_renderHook(() => useInputSync({ setSessions }));
			result.current.queueAiDraftFlush(TAB_ID, 'typed right before teardown', 'off');
			unmount();
			const [updated] = applySetSessions(setSessions, session);
			expect(updated.aiTabs[0].inputValue).toBe('typed right before teardown');
		});
		it('flushes a pending draft when the window loses focus', () => {
			// Stepping away to grab a screenshot is exactly when a user gets
			// interrupted mid-sentence, and it's when the session file gets written.
			const setSessions = vi.fn();
			const session = makeSession();
			seedActiveSession(session);
			const { result } = s2_renderHook(() => useInputSync({ setSessions }));
			result.current.queueAiDraftFlush(TAB_ID, 'stepping away mid-sentence', 'off');
			window.dispatchEvent(new Event('blur'));
			const [updated] = applySetSessions(setSessions, session);
			expect(updated.aiTabs[0].inputValue).toBe('stepping away mid-sentence');
		});
		it('carries command mode with the queued text', () => {
			const setSessions = vi.fn();
			const session = makeSession();
			seedActiveSession(session);
			const { result } = s2_renderHook(() => useInputSync({ setSessions }));
			result.current.queueAiDraftFlush(TAB_ID, 'rm -rf build', 'shell');
			vi.advanceTimersByTime(500);
			const [updated] = applySetSessions(setSessions, session);
			expect(updated.aiTabs[0].commandMode).toBe('shell');
		});
	});
});
