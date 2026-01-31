import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
	useDebouncedPersistence,
	DEFAULT_DEBOUNCE_DELAY,
} from '../../../../renderer/hooks/utils/useDebouncedPersistence';
import type { Session, AITab, LogEntry } from '../../../../renderer/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal LogEntry */
const makeLog = (id: string): LogEntry => ({
	id,
	timestamp: Date.now(),
	source: 'ai',
	text: `log-${id}`,
});

/** Create a minimal AITab with sensible defaults */
const makeTab = (overrides: Partial<AITab> = {}): AITab => ({
	id: overrides.id ?? `tab-${Math.random().toString(36).slice(2, 8)}`,
	agentSessionId: null,
	name: null,
	starred: false,
	logs: [],
	inputValue: '',
	stagedImages: [],
	createdAt: Date.now(),
	state: 'idle',
	...overrides,
});

/** Create a minimal Session with sensible defaults */
const makeSession = (overrides: Partial<Session> = {}): Session => {
	const defaultTab = makeTab({ id: 'default-tab' });
	return {
		id: overrides.id ?? `session-${Math.random().toString(36).slice(2, 8)}`,
		name: 'Test Session',
		toolType: 'claude-code',
		state: 'idle',
		cwd: '/test',
		fullPath: '/test',
		projectRoot: '/test',
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
		aiTabs: [defaultTab],
		activeTabId: defaultTab.id,
		closedTabHistory: [],
		...overrides,
	} as Session;
};

/** Create a ref that renderHook can use for initialLoadComplete */
const makeInitialLoadRef = (value: boolean) => ({ current: value });

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('useDebouncedPersistence', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	// -----------------------------------------------------------------------
	// DEFAULT_DEBOUNCE_DELAY export
	// -----------------------------------------------------------------------
	describe('DEFAULT_DEBOUNCE_DELAY', () => {
		it('should be 2000ms', () => {
			expect(DEFAULT_DEBOUNCE_DELAY).toBe(2000);
		});
	});

	// -----------------------------------------------------------------------
	// prepareSessionForPersistence (tested indirectly through hook flush)
	// -----------------------------------------------------------------------
	describe('prepareSessionForPersistence (via hook flush)', () => {
		describe('wizard tab filtering', () => {
			it('should filter out tabs with active wizard state', () => {
				const regularTab = makeTab({ id: 'regular' });
				const wizardTab = makeTab({
					id: 'wizard',
					wizardState: {
						isActive: true,
						mode: 'new',
						confidence: 0,
						conversationHistory: [],
						previousUIState: {
							readOnlyMode: false,
							saveToHistory: false,
							showThinking: 'off',
						},
					},
				});
				const session = makeSession({
					aiTabs: [regularTab, wizardTab],
					activeTabId: 'regular',
				});

				const initialLoadRef = makeInitialLoadRef(true);
				const { result } = renderHook(() =>
					useDebouncedPersistence([session], initialLoadRef)
				);

				// Force flush
				act(() => {
					result.current.flushNow();
				});

				const calls = vi.mocked(window.maestro.sessions.setAll).mock.calls;
				expect(calls.length).toBe(1);
				const persisted = calls[0][0] as Session[];
				expect(persisted[0].aiTabs).toHaveLength(1);
				expect(persisted[0].aiTabs[0].id).toBe('regular');
			});

			it('should keep tabs with inactive wizard state (wizardState.isActive = false)', () => {
				const tab = makeTab({
					id: 'completed-wizard',
					wizardState: {
						isActive: false,
						mode: null,
						confidence: 100,
						conversationHistory: [],
						previousUIState: {
							readOnlyMode: false,
							saveToHistory: false,
							showThinking: 'off',
						},
					},
				});
				const session = makeSession({
					aiTabs: [tab],
					activeTabId: 'completed-wizard',
				});

				const initialLoadRef = makeInitialLoadRef(true);
				const { result } = renderHook(() =>
					useDebouncedPersistence([session], initialLoadRef)
				);

				act(() => {
					result.current.flushNow();
				});

				const persisted = vi.mocked(window.maestro.sessions.setAll).mock.calls[0][0] as Session[];
				expect(persisted[0].aiTabs).toHaveLength(1);
				expect(persisted[0].aiTabs[0].id).toBe('completed-wizard');
			});

			it('should keep tabs with no wizard state', () => {
				const tab = makeTab({ id: 'plain' });
				const session = makeSession({
					aiTabs: [tab],
					activeTabId: 'plain',
				});

				const initialLoadRef = makeInitialLoadRef(true);
				const { result } = renderHook(() =>
					useDebouncedPersistence([session], initialLoadRef)
				);

				act(() => {
					result.current.flushNow();
				});

				const persisted = vi.mocked(window.maestro.sessions.setAll).mock.calls[0][0] as Session[];
				expect(persisted[0].aiTabs).toHaveLength(1);
				expect(persisted[0].aiTabs[0].id).toBe('plain');
			});

			it('should create a fresh empty tab when all tabs are active wizard tabs', () => {
				const wizardTab1 = makeTab({
					id: 'w1',
					wizardState: {
						isActive: true,
						mode: 'new',
						confidence: 0,
						conversationHistory: [],
						previousUIState: {
							readOnlyMode: false,
							saveToHistory: false,
							showThinking: 'off',
						},
					},
				});
				const wizardTab2 = makeTab({
					id: 'w2',
					wizardState: {
						isActive: true,
						mode: 'iterate',
						confidence: 50,
						conversationHistory: [],
						previousUIState: {
							readOnlyMode: false,
							saveToHistory: false,
							showThinking: 'off',
						},
					},
				});
				const session = makeSession({
					aiTabs: [wizardTab1, wizardTab2],
					activeTabId: 'w1',
				});

				const initialLoadRef = makeInitialLoadRef(true);
				const { result } = renderHook(() =>
					useDebouncedPersistence([session], initialLoadRef)
				);

				act(() => {
					result.current.flushNow();
				});

				const persisted = vi.mocked(window.maestro.sessions.setAll).mock.calls[0][0] as Session[];
				expect(persisted[0].aiTabs).toHaveLength(1);
				// Fresh tab keeps the first tab's ID for consistency
				expect(persisted[0].aiTabs[0].id).toBe('w1');
				expect(persisted[0].aiTabs[0].agentSessionId).toBeNull();
				expect(persisted[0].aiTabs[0].logs).toEqual([]);
				expect(persisted[0].aiTabs[0].state).toBe('idle');
				expect(persisted[0].aiTabs[0].inputValue).toBe('');
				expect(persisted[0].aiTabs[0].starred).toBe(false);
			});
		});

		describe('log truncation', () => {
			it('should truncate tab logs to 100 entries (MAX_PERSISTED_LOGS_PER_TAB)', () => {
				const logs = Array.from({ length: 200 }, (_, i) => makeLog(`log-${i}`));
				const tab = makeTab({ id: 'big-logs', logs });
				const session = makeSession({
					aiTabs: [tab],
					activeTabId: 'big-logs',
				});

				const initialLoadRef = makeInitialLoadRef(true);
				const { result } = renderHook(() =>
					useDebouncedPersistence([session], initialLoadRef)
				);

				act(() => {
					result.current.flushNow();
				});

				const persisted = vi.mocked(window.maestro.sessions.setAll).mock.calls[0][0] as Session[];
				expect(persisted[0].aiTabs[0].logs).toHaveLength(100);
			});

			it('should keep the last 100 entries (tail of the log array)', () => {
				const logs = Array.from({ length: 150 }, (_, i) => makeLog(`log-${i}`));
				const tab = makeTab({ id: 't', logs });
				const session = makeSession({
					aiTabs: [tab],
					activeTabId: 't',
				});

				const initialLoadRef = makeInitialLoadRef(true);
				const { result } = renderHook(() =>
					useDebouncedPersistence([session], initialLoadRef)
				);

				act(() => {
					result.current.flushNow();
				});

				const persisted = vi.mocked(window.maestro.sessions.setAll).mock.calls[0][0] as Session[];
				// The last entry should be log-149
				expect(persisted[0].aiTabs[0].logs[99].id).toBe('log-149');
				// The first entry should be log-50 (150 - 100 = 50)
				expect(persisted[0].aiTabs[0].logs[0].id).toBe('log-50');
			});

			it('should not truncate logs with 100 or fewer entries', () => {
				const logs = Array.from({ length: 100 }, (_, i) => makeLog(`log-${i}`));
				const tab = makeTab({ id: 't', logs });
				const session = makeSession({
					aiTabs: [tab],
					activeTabId: 't',
				});

				const initialLoadRef = makeInitialLoadRef(true);
				const { result } = renderHook(() =>
					useDebouncedPersistence([session], initialLoadRef)
				);

				act(() => {
					result.current.flushNow();
				});

				const persisted = vi.mocked(window.maestro.sessions.setAll).mock.calls[0][0] as Session[];
				expect(persisted[0].aiTabs[0].logs).toHaveLength(100);
				expect(persisted[0].aiTabs[0].logs[0].id).toBe('log-0');
			});

			it('should not truncate logs with fewer than 100 entries', () => {
				const logs = Array.from({ length: 50 }, (_, i) => makeLog(`log-${i}`));
				const tab = makeTab({ id: 't', logs });
				const session = makeSession({
					aiTabs: [tab],
					activeTabId: 't',
				});

				const initialLoadRef = makeInitialLoadRef(true);
				const { result } = renderHook(() =>
					useDebouncedPersistence([session], initialLoadRef)
				);

				act(() => {
					result.current.flushNow();
				});

				const persisted = vi.mocked(window.maestro.sessions.setAll).mock.calls[0][0] as Session[];
				expect(persisted[0].aiTabs[0].logs).toHaveLength(50);
			});
		});

		describe('tab runtime state reset', () => {
			it('should reset tab state to idle', () => {
				const tab = makeTab({ id: 't', state: 'busy' });
				const session = makeSession({
					aiTabs: [tab],
					activeTabId: 't',
				});

				const initialLoadRef = makeInitialLoadRef(true);
				const { result } = renderHook(() =>
					useDebouncedPersistence([session], initialLoadRef)
				);

				act(() => {
					result.current.flushNow();
				});

				const persisted = vi.mocked(window.maestro.sessions.setAll).mock.calls[0][0] as Session[];
				expect(persisted[0].aiTabs[0].state).toBe('idle');
			});

			it('should clear tab thinkingStartTime', () => {
				const tab = makeTab({ id: 't', thinkingStartTime: 123456 });
				const session = makeSession({
					aiTabs: [tab],
					activeTabId: 't',
				});

				const initialLoadRef = makeInitialLoadRef(true);
				const { result } = renderHook(() =>
					useDebouncedPersistence([session], initialLoadRef)
				);

				act(() => {
					result.current.flushNow();
				});

				const persisted = vi.mocked(window.maestro.sessions.setAll).mock.calls[0][0] as Session[];
				expect(persisted[0].aiTabs[0].thinkingStartTime).toBeUndefined();
			});

			it('should clear tab agentError', () => {
				const tab = makeTab({
					id: 't',
					agentError: {
						type: 'overloaded',
						message: 'API overloaded',
						timestamp: Date.now(),
						recovery: { type: 'retry' },
					},
				});
				const session = makeSession({
					aiTabs: [tab],
					activeTabId: 't',
				});

				const initialLoadRef = makeInitialLoadRef(true);
				const { result } = renderHook(() =>
					useDebouncedPersistence([session], initialLoadRef)
				);

				act(() => {
					result.current.flushNow();
				});

				const persisted = vi.mocked(window.maestro.sessions.setAll).mock.calls[0][0] as Session[];
				expect(persisted[0].aiTabs[0].agentError).toBeUndefined();
			});

			it('should clear tab wizardState entirely from persisted data', () => {
				// Even inactive wizard state should be cleared from persisted tabs
				const tab = makeTab({
					id: 't',
					wizardState: {
						isActive: false,
						mode: null,
						confidence: 100,
						conversationHistory: [],
						previousUIState: {
							readOnlyMode: false,
							saveToHistory: false,
							showThinking: 'off',
						},
					},
				});
				const session = makeSession({
					aiTabs: [tab],
					activeTabId: 't',
				});

				const initialLoadRef = makeInitialLoadRef(true);
				const { result } = renderHook(() =>
					useDebouncedPersistence([session], initialLoadRef)
				);

				act(() => {
					result.current.flushNow();
				});

				const persisted = vi.mocked(window.maestro.sessions.setAll).mock.calls[0][0] as Session[];
				expect(persisted[0].aiTabs[0].wizardState).toBeUndefined();
			});
		});

		describe('session runtime fields removal', () => {
			it('should remove closedTabHistory', () => {
				const closedTab = makeTab({ id: 'closed' });
				const session = makeSession({
					closedTabHistory: [{ tab: closedTab, index: 0, closedAt: Date.now() }],
				});

				const initialLoadRef = makeInitialLoadRef(true);
				const { result } = renderHook(() =>
					useDebouncedPersistence([session], initialLoadRef)
				);

				act(() => {
					result.current.flushNow();
				});

				const persisted = vi.mocked(window.maestro.sessions.setAll).mock.calls[0][0] as Session[];
				expect(persisted[0].closedTabHistory).toBeUndefined();
			});

			it('should remove session-level agentError', () => {
				const session = makeSession({
					agentError: {
						type: 'overloaded',
						message: 'API overloaded',
						timestamp: Date.now(),
						recovery: { type: 'retry' },
					},
				});

				const initialLoadRef = makeInitialLoadRef(true);
				const { result } = renderHook(() =>
					useDebouncedPersistence([session], initialLoadRef)
				);

				act(() => {
					result.current.flushNow();
				});

				const persisted = vi.mocked(window.maestro.sessions.setAll).mock.calls[0][0] as Session[];
				expect(persisted[0].agentError).toBeUndefined();
			});

			it('should remove agentErrorPaused', () => {
				const session = makeSession({
					agentErrorPaused: true,
				});

				const initialLoadRef = makeInitialLoadRef(true);
				const { result } = renderHook(() =>
					useDebouncedPersistence([session], initialLoadRef)
				);

				act(() => {
					result.current.flushNow();
				});

				const persisted = vi.mocked(window.maestro.sessions.setAll).mock.calls[0][0] as Session[];
				expect(persisted[0].agentErrorPaused).toBeUndefined();
			});

			it('should remove agentErrorTabId', () => {
				const session = makeSession({
					agentErrorTabId: 'some-tab-id',
				});

				const initialLoadRef = makeInitialLoadRef(true);
				const { result } = renderHook(() =>
					useDebouncedPersistence([session], initialLoadRef)
				);

				act(() => {
					result.current.flushNow();
				});

				const persisted = vi.mocked(window.maestro.sessions.setAll).mock.calls[0][0] as Session[];
				expect(persisted[0].agentErrorTabId).toBeUndefined();
			});

			it('should remove sshConnectionFailed', () => {
				const session = makeSession({
					sshConnectionFailed: true,
				});

				const initialLoadRef = makeInitialLoadRef(true);
				const { result } = renderHook(() =>
					useDebouncedPersistence([session], initialLoadRef)
				);

				act(() => {
					result.current.flushNow();
				});

				const persisted = vi.mocked(window.maestro.sessions.setAll).mock.calls[0][0] as Session[];
				expect(persisted[0].sshConnectionFailed).toBeUndefined();
			});
		});

		describe('session runtime state reset', () => {
			it('should reset session state to idle', () => {
				const session = makeSession({ state: 'busy' });

				const initialLoadRef = makeInitialLoadRef(true);
				const { result } = renderHook(() =>
					useDebouncedPersistence([session], initialLoadRef)
				);

				act(() => {
					result.current.flushNow();
				});

				const persisted = vi.mocked(window.maestro.sessions.setAll).mock.calls[0][0] as Session[];
				expect(persisted[0].state).toBe('idle');
			});

			it('should clear busySource', () => {
				const session = makeSession({ busySource: 'ai' });

				const initialLoadRef = makeInitialLoadRef(true);
				const { result } = renderHook(() =>
					useDebouncedPersistence([session], initialLoadRef)
				);

				act(() => {
					result.current.flushNow();
				});

				const persisted = vi.mocked(window.maestro.sessions.setAll).mock.calls[0][0] as Session[];
				expect(persisted[0].busySource).toBeUndefined();
			});

			it('should clear thinkingStartTime', () => {
				const session = makeSession({ thinkingStartTime: Date.now() });

				const initialLoadRef = makeInitialLoadRef(true);
				const { result } = renderHook(() =>
					useDebouncedPersistence([session], initialLoadRef)
				);

				act(() => {
					result.current.flushNow();
				});

				const persisted = vi.mocked(window.maestro.sessions.setAll).mock.calls[0][0] as Session[];
				expect(persisted[0].thinkingStartTime).toBeUndefined();
			});

			it('should clear currentCycleTokens', () => {
				const session = makeSession({ currentCycleTokens: 5000 });

				const initialLoadRef = makeInitialLoadRef(true);
				const { result } = renderHook(() =>
					useDebouncedPersistence([session], initialLoadRef)
				);

				act(() => {
					result.current.flushNow();
				});

				const persisted = vi.mocked(window.maestro.sessions.setAll).mock.calls[0][0] as Session[];
				expect(persisted[0].currentCycleTokens).toBeUndefined();
			});

			it('should clear currentCycleBytes', () => {
				const session = makeSession({ currentCycleBytes: 128000 });

				const initialLoadRef = makeInitialLoadRef(true);
				const { result } = renderHook(() =>
					useDebouncedPersistence([session], initialLoadRef)
				);

				act(() => {
					result.current.flushNow();
				});

				const persisted = vi.mocked(window.maestro.sessions.setAll).mock.calls[0][0] as Session[];
				expect(persisted[0].currentCycleBytes).toBeUndefined();
			});

			it('should clear statusMessage', () => {
				const session = makeSession({ statusMessage: 'Agent is thinking...' });

				const initialLoadRef = makeInitialLoadRef(true);
				const { result } = renderHook(() =>
					useDebouncedPersistence([session], initialLoadRef)
				);

				act(() => {
					result.current.flushNow();
				});

				const persisted = vi.mocked(window.maestro.sessions.setAll).mock.calls[0][0] as Session[];
				expect(persisted[0].statusMessage).toBeUndefined();
			});
		});

		describe('SSH runtime state clearing', () => {
			it('should clear sshRemote', () => {
				const session = makeSession({
					sshRemote: { id: 'remote-1', name: 'My Server', host: 'server.example.com' },
				});

				const initialLoadRef = makeInitialLoadRef(true);
				const { result } = renderHook(() =>
					useDebouncedPersistence([session], initialLoadRef)
				);

				act(() => {
					result.current.flushNow();
				});

				const persisted = vi.mocked(window.maestro.sessions.setAll).mock.calls[0][0] as Session[];
				expect(persisted[0].sshRemote).toBeUndefined();
			});

			it('should clear sshRemoteId', () => {
				const session = makeSession({ sshRemoteId: 'remote-1' });

				const initialLoadRef = makeInitialLoadRef(true);
				const { result } = renderHook(() =>
					useDebouncedPersistence([session], initialLoadRef)
				);

				act(() => {
					result.current.flushNow();
				});

				const persisted = vi.mocked(window.maestro.sessions.setAll).mock.calls[0][0] as Session[];
				expect(persisted[0].sshRemoteId).toBeUndefined();
			});

			it('should clear remoteCwd', () => {
				const session = makeSession({ remoteCwd: '/remote/home/user/project' });

				const initialLoadRef = makeInitialLoadRef(true);
				const { result } = renderHook(() =>
					useDebouncedPersistence([session], initialLoadRef)
				);

				act(() => {
					result.current.flushNow();
				});

				const persisted = vi.mocked(window.maestro.sessions.setAll).mock.calls[0][0] as Session[];
				expect(persisted[0].remoteCwd).toBeUndefined();
			});
		});

		describe('activeTabId fix-up', () => {
			it('should fix activeTabId when it pointed to a filtered wizard tab', () => {
				const regularTab = makeTab({ id: 'regular' });
				const wizardTab = makeTab({
					id: 'active-wizard',
					wizardState: {
						isActive: true,
						mode: 'new',
						confidence: 0,
						conversationHistory: [],
						previousUIState: {
							readOnlyMode: false,
							saveToHistory: false,
							showThinking: 'off',
						},
					},
				});
				const session = makeSession({
					aiTabs: [regularTab, wizardTab],
					activeTabId: 'active-wizard', // points to wizard tab that will be filtered
				});

				const initialLoadRef = makeInitialLoadRef(true);
				const { result } = renderHook(() =>
					useDebouncedPersistence([session], initialLoadRef)
				);

				act(() => {
					result.current.flushNow();
				});

				const persisted = vi.mocked(window.maestro.sessions.setAll).mock.calls[0][0] as Session[];
				// activeTabId should now point to the first remaining tab
				expect(persisted[0].activeTabId).toBe('regular');
			});

			it('should keep activeTabId when it points to a valid non-wizard tab', () => {
				const tab1 = makeTab({ id: 'tab-1' });
				const tab2 = makeTab({ id: 'tab-2' });
				const session = makeSession({
					aiTabs: [tab1, tab2],
					activeTabId: 'tab-2',
				});

				const initialLoadRef = makeInitialLoadRef(true);
				const { result } = renderHook(() =>
					useDebouncedPersistence([session], initialLoadRef)
				);

				act(() => {
					result.current.flushNow();
				});

				const persisted = vi.mocked(window.maestro.sessions.setAll).mock.calls[0][0] as Session[];
				expect(persisted[0].activeTabId).toBe('tab-2');
			});

			it('should set activeTabId to fresh tab id when all tabs were wizard tabs', () => {
				const wizardTab = makeTab({
					id: 'wizard-only',
					wizardState: {
						isActive: true,
						mode: 'new',
						confidence: 0,
						conversationHistory: [],
						previousUIState: {
							readOnlyMode: false,
							saveToHistory: false,
							showThinking: 'off',
						},
					},
				});
				const session = makeSession({
					aiTabs: [wizardTab],
					activeTabId: 'wizard-only',
				});

				const initialLoadRef = makeInitialLoadRef(true);
				const { result } = renderHook(() =>
					useDebouncedPersistence([session], initialLoadRef)
				);

				act(() => {
					result.current.flushNow();
				});

				const persisted = vi.mocked(window.maestro.sessions.setAll).mock.calls[0][0] as Session[];
				// The fresh tab reuses the first tab's ID
				expect(persisted[0].activeTabId).toBe('wizard-only');
				expect(persisted[0].aiTabs[0].id).toBe('wizard-only');
			});
		});

		describe('session with no aiTabs', () => {
			it('should return session as-is when aiTabs is empty', () => {
				const session = makeSession({
					aiTabs: [],
					activeTabId: '',
					state: 'busy',
					busySource: 'ai',
				});

				const initialLoadRef = makeInitialLoadRef(true);
				const { result } = renderHook(() =>
					useDebouncedPersistence([session], initialLoadRef)
				);

				act(() => {
					result.current.flushNow();
				});

				const persisted = vi.mocked(window.maestro.sessions.setAll).mock.calls[0][0] as Session[];
				// When aiTabs is empty, the session is returned as-is
				expect(persisted[0].aiTabs).toEqual([]);
				expect(persisted[0].state).toBe('busy');
			});
		});

		describe('preserves non-runtime fields', () => {
			it('should preserve session name, cwd, and other persistent fields', () => {
				const session = makeSession({
					id: 'my-session',
					name: 'Important Session',
					cwd: '/projects/test',
					fullPath: '/projects/test',
					projectRoot: '/projects/test',
					autoRunFolderPath: '/path/to/docs',
					bookmarked: true,
				});

				const initialLoadRef = makeInitialLoadRef(true);
				const { result } = renderHook(() =>
					useDebouncedPersistence([session], initialLoadRef)
				);

				act(() => {
					result.current.flushNow();
				});

				const persisted = vi.mocked(window.maestro.sessions.setAll).mock.calls[0][0] as Session[];
				expect(persisted[0].id).toBe('my-session');
				expect(persisted[0].name).toBe('Important Session');
				expect(persisted[0].cwd).toBe('/projects/test');
				expect(persisted[0].autoRunFolderPath).toBe('/path/to/docs');
				expect(persisted[0].bookmarked).toBe(true);
			});

			it('should preserve tab fields like inputValue, starred, agentSessionId', () => {
				const tab = makeTab({
					id: 'important-tab',
					agentSessionId: 'session-uuid-123',
					name: 'My Conversation',
					starred: true,
					inputValue: 'draft message',
					stagedImages: ['base64img'],
				});
				const session = makeSession({
					aiTabs: [tab],
					activeTabId: 'important-tab',
				});

				const initialLoadRef = makeInitialLoadRef(true);
				const { result } = renderHook(() =>
					useDebouncedPersistence([session], initialLoadRef)
				);

				act(() => {
					result.current.flushNow();
				});

				const persisted = vi.mocked(window.maestro.sessions.setAll).mock.calls[0][0] as Session[];
				const persistedTab = persisted[0].aiTabs[0];
				expect(persistedTab.agentSessionId).toBe('session-uuid-123');
				expect(persistedTab.name).toBe('My Conversation');
				expect(persistedTab.starred).toBe(true);
				expect(persistedTab.inputValue).toBe('draft message');
				expect(persistedTab.stagedImages).toEqual(['base64img']);
			});
		});

		describe('multiple sessions', () => {
			it('should prepare all sessions for persistence', () => {
				const session1 = makeSession({
					id: 's1',
					state: 'busy',
					busySource: 'ai',
					thinkingStartTime: 1000,
				});
				const session2 = makeSession({
					id: 's2',
					state: 'connecting',
					statusMessage: 'Connecting...',
					sshRemote: { id: 'r1', name: 'Server', host: 'host' },
				});

				const initialLoadRef = makeInitialLoadRef(true);
				const { result } = renderHook(() =>
					useDebouncedPersistence([session1, session2], initialLoadRef)
				);

				act(() => {
					result.current.flushNow();
				});

				const persisted = vi.mocked(window.maestro.sessions.setAll).mock.calls[0][0] as Session[];
				expect(persisted).toHaveLength(2);

				// Session 1 should be reset
				expect(persisted[0].state).toBe('idle');
				expect(persisted[0].busySource).toBeUndefined();
				expect(persisted[0].thinkingStartTime).toBeUndefined();

				// Session 2 should be reset
				expect(persisted[1].state).toBe('idle');
				expect(persisted[1].statusMessage).toBeUndefined();
				expect(persisted[1].sshRemote).toBeUndefined();
			});
		});
	});

	// -----------------------------------------------------------------------
	// Hook behavior
	// -----------------------------------------------------------------------
	describe('hook behavior', () => {
		describe('initialLoadComplete gate', () => {
			it('should not persist before initialLoadComplete is true', () => {
				const session = makeSession();
				const initialLoadRef = makeInitialLoadRef(false);

				renderHook(() => useDebouncedPersistence([session], initialLoadRef));

				// Advance well past the debounce delay
				act(() => {
					vi.advanceTimersByTime(5000);
				});

				expect(window.maestro.sessions.setAll).not.toHaveBeenCalled();
			});

			it('should persist after initialLoadComplete becomes true', () => {
				const session = makeSession();
				const initialLoadRef = makeInitialLoadRef(false);

				const { rerender } = renderHook(
					({ sessions, ref }) => useDebouncedPersistence(sessions, ref),
					{
						initialProps: { sessions: [session], ref: initialLoadRef },
					}
				);

				// Initially should not persist
				act(() => {
					vi.advanceTimersByTime(3000);
				});
				expect(window.maestro.sessions.setAll).not.toHaveBeenCalled();

				// Mark initial load as complete and trigger re-render with new sessions array
				initialLoadRef.current = true;
				const updatedSession = makeSession({ id: session.id, name: 'Updated' });
				rerender({ sessions: [updatedSession], ref: initialLoadRef });

				// Advance past the debounce delay
				act(() => {
					vi.advanceTimersByTime(2000);
				});

				expect(window.maestro.sessions.setAll).toHaveBeenCalled();
			});
		});

		describe('debounce behavior', () => {
			it('should not call setAll immediately when sessions change', () => {
				const session = makeSession();
				const initialLoadRef = makeInitialLoadRef(true);

				renderHook(() => useDebouncedPersistence([session], initialLoadRef));

				// Don't advance timers - it should not have been called yet
				expect(window.maestro.sessions.setAll).not.toHaveBeenCalled();
			});

			it('should call setAll after debounce delay', () => {
				const session = makeSession();
				const initialLoadRef = makeInitialLoadRef(true);

				renderHook(() => useDebouncedPersistence([session], initialLoadRef));

				act(() => {
					vi.advanceTimersByTime(2000);
				});

				expect(window.maestro.sessions.setAll).toHaveBeenCalledTimes(1);
			});

			it('should reset debounce timer on rapid session changes', () => {
				const session1 = makeSession({ id: 's1', name: 'First' });
				const initialLoadRef = makeInitialLoadRef(true);

				const { rerender } = renderHook(
					({ sessions }) => useDebouncedPersistence(sessions, initialLoadRef),
					{ initialProps: { sessions: [session1] } }
				);

				// Advance 1500ms (not enough for debounce)
				act(() => {
					vi.advanceTimersByTime(1500);
				});
				expect(window.maestro.sessions.setAll).not.toHaveBeenCalled();

				// Trigger a new session change which resets the timer
				const session2 = makeSession({ id: 's1', name: 'Second' });
				rerender({ sessions: [session2] });

				// Advance another 1500ms (total 3000ms from start, but only 1500ms from last change)
				act(() => {
					vi.advanceTimersByTime(1500);
				});
				expect(window.maestro.sessions.setAll).not.toHaveBeenCalled();

				// Advance the remaining 500ms
				act(() => {
					vi.advanceTimersByTime(500);
				});
				expect(window.maestro.sessions.setAll).toHaveBeenCalledTimes(1);
			});

			it('should respect custom delay parameter', () => {
				const session = makeSession();
				const initialLoadRef = makeInitialLoadRef(true);

				renderHook(() => useDebouncedPersistence([session], initialLoadRef, 500));

				act(() => {
					vi.advanceTimersByTime(499);
				});
				expect(window.maestro.sessions.setAll).not.toHaveBeenCalled();

				act(() => {
					vi.advanceTimersByTime(1);
				});
				expect(window.maestro.sessions.setAll).toHaveBeenCalledTimes(1);
			});
		});

		describe('flushNow()', () => {
			it('should persist immediately when called with pending changes', () => {
				const session = makeSession();
				const initialLoadRef = makeInitialLoadRef(true);

				const { result } = renderHook(() =>
					useDebouncedPersistence([session], initialLoadRef)
				);

				// The hook sets isPending in a useEffect, need to flush effects
				// isPending won't be true until after the effect runs
				// We need to advance to allow the effect to set isPending
				act(() => {
					// trigger the effect by advancing minimally (not the full debounce)
					vi.advanceTimersByTime(0);
				});

				act(() => {
					result.current.flushNow();
				});

				expect(window.maestro.sessions.setAll).toHaveBeenCalledTimes(1);
			});

			it('should cancel pending debounce timer when flushing', () => {
				const sessions = [makeSession()];
				const initialLoadRef = makeInitialLoadRef(true);

				// Use a stable sessions reference via initialProps to avoid
				// creating a new array on each render (which would re-trigger
				// the debounce effect)
				const { result } = renderHook(
					({ s }) => useDebouncedPersistence(s, initialLoadRef),
					{ initialProps: { s: sessions } }
				);

				// Allow effect to set isPending
				act(() => {
					vi.advanceTimersByTime(0);
				});

				vi.clearAllMocks();

				// Flush immediately - should clear the pending debounce timer
				act(() => {
					result.current.flushNow();
				});

				expect(window.maestro.sessions.setAll).toHaveBeenCalledTimes(1);
				vi.clearAllMocks();

				// Advance past the original debounce delay - the timer was cleared
				// by flushNow, so no additional call should occur
				act(() => {
					vi.advanceTimersByTime(3000);
				});

				expect(window.maestro.sessions.setAll).not.toHaveBeenCalled();
			});
		});

		describe('isPending state', () => {
			it('should be false initially (before initialLoadComplete)', () => {
				const session = makeSession();
				const initialLoadRef = makeInitialLoadRef(false);

				const { result } = renderHook(() =>
					useDebouncedPersistence([session], initialLoadRef)
				);

				expect(result.current.isPending).toBe(false);
			});

			it('should become true when sessions change after initial load', () => {
				const session = makeSession();
				const initialLoadRef = makeInitialLoadRef(true);

				const { result } = renderHook(() =>
					useDebouncedPersistence([session], initialLoadRef)
				);

				// The useEffect sets isPending to true
				// It runs asynchronously after render
				expect(result.current.isPending).toBe(true);
			});

			it('should become false after debounce timer fires', () => {
				const sessions = [makeSession()];
				const initialLoadRef = makeInitialLoadRef(true);

				// Use stable sessions reference via initialProps
				const { result } = renderHook(
					({ s }) => useDebouncedPersistence(s, initialLoadRef),
					{ initialProps: { s: sessions } }
				);

				expect(result.current.isPending).toBe(true);

				act(() => {
					vi.advanceTimersByTime(2000);
				});

				expect(result.current.isPending).toBe(false);
			});

			it('should become false after flushNow', () => {
				const sessions = [makeSession()];
				const initialLoadRef = makeInitialLoadRef(true);

				// Use stable sessions reference via initialProps
				const { result } = renderHook(
					({ s }) => useDebouncedPersistence(s, initialLoadRef),
					{ initialProps: { s: sessions } }
				);

				expect(result.current.isPending).toBe(true);

				act(() => {
					result.current.flushNow();
				});

				expect(result.current.isPending).toBe(false);
			});
		});

		describe('flush on unmount', () => {
			it('should persist on unmount when initialLoadComplete is true', () => {
				const session = makeSession();
				const initialLoadRef = makeInitialLoadRef(true);

				const { unmount } = renderHook(() =>
					useDebouncedPersistence([session], initialLoadRef)
				);

				unmount();

				// Should have called setAll on unmount
				expect(window.maestro.sessions.setAll).toHaveBeenCalled();
			});

			it('should not persist on unmount when initialLoadComplete is false', () => {
				const session = makeSession();
				const initialLoadRef = makeInitialLoadRef(false);

				const { unmount } = renderHook(() =>
					useDebouncedPersistence([session], initialLoadRef)
				);

				unmount();

				expect(window.maestro.sessions.setAll).not.toHaveBeenCalled();
			});
		});
	});
});
