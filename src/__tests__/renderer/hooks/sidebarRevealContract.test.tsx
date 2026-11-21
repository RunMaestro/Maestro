import { describe as __maestroMicrobenchDescribe } from 'vitest';
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { vi } from 'vitest';
import { beforeEach } from 'vitest';
import { afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { act } from '@testing-library/react';
import { cleanup } from '@testing-library/react';
import { useKeyboardNavigation } from '../../../renderer/hooks/keyboard/useKeyboardNavigation';
import type { UseKeyboardNavigationDeps } from '../../../renderer/hooks/keyboard/useKeyboardNavigation';
import { cycleSession } from '../../../renderer/hooks/session/useCycleSession';
import type { CycleSessionDeps } from '../../../renderer/hooks/session/useCycleSession';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useGroupChatStore } from '../../../renderer/stores/groupChatStore';
import { useUIStore } from '../../../renderer/stores/uiStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { getSidebarRevealToken } from '../../../renderer/utils/sidebarReveal';
import { createMockSession } from '../../helpers/mockSession';
import { resetStores } from '../../helpers';
import type { Session } from '../../../renderer/types';
import type { Group } from '../../../renderer/types';
import { useBatchedSessionUpdates } from '../../../renderer/hooks/session/useBatchedSessionUpdates';
import { createMockAITab } from '../../helpers/mockTab';
import type { LogEntry } from '../../../renderer/types';
import { waitFor } from '@testing-library/react';
import type { AgentRun } from '../../../shared/agent-run';
import type { AgentRunEvent } from '../../../shared/agent-run';
import type { Campaign } from '../../../shared/campaign';
import { useAgentRun } from '../../../renderer/hooks/agentRun/useAgentRun';
import type { AITab } from '../../../renderer/types';
import { useSshRemoteNames } from '../../../renderer/hooks/remote/useSshRemoteNames';
import { ipcCache } from '../../../renderer/services/ipcWrapper';
import { useGroupChatHandlers } from '../../../renderer/hooks/groupChat/useGroupChatHandlers';
import { useRef } from 'react';
import { useOutputSearchMatching } from '../../../renderer/hooks/ui/useOutputSearchMatching';
import { useSessionCategories } from '../../../renderer/hooks/session/useSessionCategories';
import { computeSortedSessions } from '../../../renderer/hooks/session/computeSortedSessions';
import { sessionNeedsAttention } from '../../../renderer/utils/sessionAttention';
import { passesUnreadFilter } from '../../../renderer/utils/sidebarMembership';
import { useHeadlessActivityStore } from '../../../renderer/stores/headlessActivityStore';
__maestroMicrobenchDescribe('sidebarRevealContract', () => {
	const session = (id: string, name: string, groupId?: string): Session =>
		createMockSession({ id, name, groupId, cwd: '/tmp', projectRoot: '/tmp' } as never);

	const sessions = [session('s1', 'Alpha'), session('s2', 'Bravo'), session('s3', 'Charlie')];
	const groups: Group[] = [];
	const chats = [{ id: 'gc1', name: 'Squad' }] as never[];

	const starredRow = {
		kind: 'open' as const,
		key: 'open:s1:t1',
		displayName: 'A Star',
		agentName: 'Agent',
		parentSessionId: 's1',
		tabId: 't1',
	};

	const cycleDeps = (extra: Partial<CycleSessionDeps> = {}): CycleSessionDeps =>
		({
			sortedSessions: sessions,
			handleOpenGroupChat: vi.fn(),
			starredItems: [],
			activateStarredItem: vi.fn(),
			navIndexMap: new Map(sessions.map((s, i) => [`ungrouped:${s.id}`, i])),
			...extra,
		}) as CycleSessionDeps;

	const navDeps = (extra: Partial<UseKeyboardNavigationDeps>): UseKeyboardNavigationDeps =>
		({
			sortedSessions: sessions,
			navSessions: sessions,
			bookmarkNavSize: 0,
			selectedSidebarIndex: 0,
			setSelectedSidebarIndex: vi.fn(),
			sidebarExtraSelection: null,
			setSidebarExtraSelection: vi.fn(),
			activeSessionId: 's1',
			setActiveSessionId: vi.fn(),
			activeFocus: 'sidebar',
			setActiveFocus: vi.fn(),
			groups,
			setGroups: vi.fn(),
			bookmarksCollapsed: false,
			setBookmarksCollapsed: vi.fn(),
			inputRef: { current: null },
			terminalOutputRef: { current: null },
			starredItems: [],
			activateStarredItem: vi.fn(),
			starredSectionCollapsed: false,
			setStarredSectionCollapsed: vi.fn(),
			groupChats: chats,
			handleOpenGroupChat: vi.fn(),
			groupChatsExpanded: true,
			setGroupChatsExpanded: vi.fn(),
			groupChatSortAlphabetical: false,
			showUnreadAgentsOnly: false,
			ungroupedCollapsed: false,
			setUngroupedCollapsed: vi.fn(),
			...extra,
		}) as UseKeyboardNavigationDeps;

	beforeEach(() => {
		vi.clearAllMocks();
		resetStores(useSessionStore, useGroupChatStore, useUIStore, useSettingsStore);
		useSessionStore.setState({ sessions, groups, activeSessionId: 's1' } as never);
		useUIStore.setState({ leftSidebarOpen: true, bookmarksCollapsed: false } as never);
		useSettingsStore.setState({
			groupChatsExpanded: true,
			ungroupedCollapsed: false,
			starredSectionCollapsed: false,
		} as never);
		useGroupChatStore.setState({ groupChats: chats, activeGroupChatId: null } as never);
	});

	afterEach(() => cleanup());

	describe('Left Bar reveal contract', () => {
		describe('Cmd+[ / Cmd+] (cycleSession)', () => {
			it('asks for a reveal when it lands on an agent', () => {
				const before = getSidebarRevealToken();

				cycleSession('next', cycleDeps());

				expect(useSessionStore.getState().activeSessionId).toBe('s2');
				expect(getSidebarRevealToken()).toBeGreaterThan(before);
			});

			it('asks for a reveal when it lands on a group chat', () => {
				const deps = cycleDeps();
				// Last agent -> the group chats section is the next thing in visual order.
				useSessionStore.setState({ activeSessionId: 's3' } as never);
				const before = getSidebarRevealToken();

				cycleSession('next', deps);

				expect(deps.handleOpenGroupChat).toHaveBeenCalledWith('gc1');
				expect(getSidebarRevealToken()).toBeGreaterThan(before);
			});

			it('asks for a reveal when it lands on a starred row', () => {
				const deps = cycleDeps({ starredItems: [starredRow] as never });
				// Starred rows sit at the very top, so walking back from the first agent
				// lands on one.
				const before = getSidebarRevealToken();

				cycleSession('prev', deps);

				expect(deps.activateStarredItem).toHaveBeenCalled();
				expect(getSidebarRevealToken()).toBeGreaterThan(before);
			});
		});

		describe('arrow keys', () => {
			it('asks for a reveal when the cursor moves', () => {
				const { result } = renderHook(() => useKeyboardNavigation(navDeps({})));
				const before = getSidebarRevealToken();

				act(() => {
					result.current.handleSidebarNavigation(
						new KeyboardEvent('keydown', { key: 'ArrowDown' })
					);
				});

				expect(getSidebarRevealToken()).toBeGreaterThan(before);
			});
		});

		describe('clicks', () => {
			it('does not ask for a reveal when an agent simply becomes active', () => {
				const before = getSidebarRevealToken();

				// What a click does: set the active agent. The user is already looking at
				// the row they clicked, and re-aiming a list they scrolled by hand reads
				// as the panel fighting them.
				useSessionStore.getState().setActiveSessionId('s3');

				expect(getSidebarRevealToken()).toBe(before);
			});
		});
	});
});
__maestroMicrobenchDescribe('useBatchedSessionUpdates.commandCard', () => {
	const SESSION_ID = 'session-1';
	const TAB_ID = 'tab-1';

	/** The transcript card appended by services/shellCommand.ts for a `!` command. */
	function commandCard(overrides: Partial<LogEntry> = {}): LogEntry {
		return {
			id: 'card-1',
			timestamp: Date.now(),
			source: 'stdout',
			text: 'file-a\nfile-b\n',
			shellCommand: {
				command: 'ls',
				cwd: '/repo',
				status: 'finished',
				exitCode: 0,
			},
			...overrides,
		};
	}

	function seed(logs: LogEntry[]): void {
		useSessionStore.setState({
			sessions: [
				createMockSession({
					id: SESSION_ID,
					activeTabId: TAB_ID,
					aiTabs: [createMockAITab({ id: TAB_ID, logs })],
				}),
			],
			activeSessionId: SESSION_ID,
		});
	}

	function tabLogs(): LogEntry[] {
		const session = useSessionStore.getState().sessions.find((s) => s.id === SESSION_ID);
		return session?.aiTabs.find((t) => t.id === TAB_ID)?.logs ?? [];
	}

	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe('useBatchedSessionUpdates - command-mode card is not a coalesce target', () => {
		it('does not append streamed agent output into a command card', () => {
			const card = commandCard();
			seed([card]);

			const { result } = renderHook(() => useBatchedSessionUpdates());

			act(() => {
				// Agent chunk arriving immediately after the card - inside the 500ms
				// grouping window, which is exactly the real-world case (running `!ls`
				// while the agent is streaming).
				result.current.appendLog(SESSION_ID, TAB_ID, true, 'Shipped to main.');
				result.current.flushNow();
			});

			const logs = tabLogs();
			const cardAfter = logs.find((l) => l.id === 'card-1')!;

			// The card keeps ONLY its own terminal output.
			expect(cardAfter.text).toBe('file-a\nfile-b\n');
			expect(cardAfter.text).not.toContain('Shipped to main.');

			// The agent's text lands in its own entry instead.
			expect(logs).toHaveLength(2);
			expect(logs[1].text).toBe('Shipped to main.');
			expect(logs[1].shellCommand).toBeUndefined();
		});

		it('keeps the card intact across several streamed chunks', () => {
			seed([commandCard()]);

			const { result } = renderHook(() => useBatchedSessionUpdates());

			act(() => {
				result.current.appendLog(SESSION_ID, TAB_ID, true, 'chunk one ');
				result.current.appendLog(SESSION_ID, TAB_ID, true, 'chunk two');
				result.current.flushNow();
			});

			const logs = tabLogs();
			expect(logs.find((l) => l.id === 'card-1')!.text).toBe('file-a\nfile-b\n');
			// The chunks still coalesce with EACH OTHER, just not into the card.
			expect(logs).toHaveLength(2);
			expect(logs[1].text).toBe('chunk one chunk two');
		});

		it('does not append streamed stderr into a command card either', () => {
			seed([commandCard()]);

			const { result } = renderHook(() => useBatchedSessionUpdates());

			act(() => {
				result.current.appendLog(SESSION_ID, TAB_ID, true, 'a warning', true);
				result.current.flushNow();
			});

			const logs = tabLogs();
			expect(logs.find((l) => l.id === 'card-1')!.text).toBe('file-a\nfile-b\n');
			expect(logs).toHaveLength(2);
			expect(logs[1].source).toBe('stderr');
		});

		it('does not append into a still-running command card', () => {
			// The window where this matters most: the command is in flight, so its
			// card is the newest entry while the agent keeps streaming.
			seed([
				commandCard({
					text: '',
					shellCommand: { command: 'tail -f log', cwd: '/repo', status: 'running' },
				}),
			]);

			const { result } = renderHook(() => useBatchedSessionUpdates());

			act(() => {
				result.current.appendLog(SESSION_ID, TAB_ID, true, 'agent still talking');
				result.current.flushNow();
			});

			const logs = tabLogs();
			expect(logs.find((l) => l.id === 'card-1')!.text).toBe('');
			expect(logs).toHaveLength(2);
		});

		it('still coalesces normal agent output into a plain stdout entry', () => {
			// Guard against over-correcting: ordinary streaming must keep grouping,
			// or every chunk becomes its own bubble.
			seed([{ id: 'plain-1', timestamp: Date.now(), source: 'stdout', text: 'hello ' }]);

			const { result } = renderHook(() => useBatchedSessionUpdates());

			act(() => {
				result.current.appendLog(SESSION_ID, TAB_ID, true, 'world');
				result.current.flushNow();
			});

			const logs = tabLogs();
			expect(logs).toHaveLength(1);
			expect(logs[0].text).toBe('hello world');
		});
	});
});
__maestroMicrobenchDescribe('useAgentRun', () => {
	const run: AgentRun = {
		id: 'run-1',
		createdAt: 100,
		updatedAt: 200,
		provider: 'claude-code',
		status: 'running',
		artifacts: [],
		touchedFiles: [],
		checks: [],
		reviews: [],
	};

	const event: AgentRunEvent = {
		id: 'event-1',
		runId: 'run-1',
		timestamp: 300,
		type: 'status',
		message: 'Run started',
	};

	const campaign: Campaign = {
		id: 'campaign-1',
		title: 'Ship parser',
		createdAt: 100,
		updatedAt: 200,
		status: 'running',
		runIds: ['run-1'],
		tasks: [],
	};

	function agentRunApi() {
		return window.maestro.agentRun as unknown as {
			list: ReturnType<typeof vi.fn>;
			show: ReturnType<typeof vi.fn>;
			events: ReturnType<typeof vi.fn>;
			campaigns: {
				list: ReturnType<typeof vi.fn>;
				show: ReturnType<typeof vi.fn>;
			};
		};
	}

	describe('useAgentRun', () => {
		beforeEach(() => {
			vi.clearAllMocks();
			agentRunApi().list.mockResolvedValue({ success: true, runs: [run] });
			agentRunApi().show.mockResolvedValue({ success: true, run });
			agentRunApi().events.mockResolvedValue({ success: true, events: [event] });
			agentRunApi().campaigns.list.mockResolvedValue({ success: true, campaigns: [campaign] });
			agentRunApi().campaigns.show.mockResolvedValue({ success: true, campaign });
		});

		it('loads runs and campaigns on mount', async () => {
			const { result } = renderHook(() => useAgentRun());

			await waitFor(() => expect(result.current.loading).toBe(false));

			expect(result.current.runs).toEqual([run]);
			expect(result.current.campaigns).toEqual([campaign]);
			expect(agentRunApi().list).toHaveBeenCalledWith(undefined);
			expect(agentRunApi().campaigns.list).toHaveBeenCalledWith(undefined);
		});

		it('passes filter options into manual refreshes', async () => {
			const { result } = renderHook(() => useAgentRun({ loadOnMount: false }));

			await act(async () => {
				await result.current.refreshRuns({ status: 'running', campaign: 'campaign-1', limit: 2 });
				await result.current.refreshCampaigns({ status: 'running', limit: 3 });
			});

			expect(agentRunApi().list).toHaveBeenCalledWith({
				status: 'running',
				campaign: 'campaign-1',
				limit: 2,
			});
			expect(agentRunApi().campaigns.list).toHaveBeenCalledWith({ status: 'running', limit: 3 });
			expect(result.current.runs).toEqual([run]);
			expect(result.current.campaigns).toEqual([campaign]);
		});

		it('shows a run and loads its events on demand', async () => {
			const { result } = renderHook(() => useAgentRun({ loadOnMount: false }));

			await act(async () => {
				await result.current.showRun('run-1');
				await result.current.loadRunEvents('run-1');
			});

			expect(agentRunApi().show).toHaveBeenCalledWith('run-1');
			expect(agentRunApi().events).toHaveBeenCalledWith('run-1');
			expect(result.current.selectedRun).toEqual(run);
			expect(result.current.selectedRunEvents).toEqual([event]);
		});

		it('shows one campaign and clears selected state', async () => {
			const { result } = renderHook(() => useAgentRun({ loadOnMount: false }));

			await act(async () => {
				await result.current.showCampaign('campaign-1');
			});

			expect(result.current.selectedCampaign).toEqual(campaign);

			act(() => {
				result.current.clearSelection();
			});

			expect(result.current.selectedRun).toBeNull();
			expect(result.current.selectedRunEvents).toEqual([]);
			expect(result.current.selectedCampaign).toBeNull();
		});

		it('surfaces service errors without replacing current state', async () => {
			const { result } = renderHook(() => useAgentRun({ loadOnMount: false }));

			await act(async () => {
				await result.current.refreshRuns();
			});

			agentRunApi().list.mockResolvedValue({ success: false, error: 'read failed' });

			await act(async () => {
				const runs = await result.current.refreshRuns();
				expect(runs).toEqual([]);
			});

			expect(result.current.runs).toEqual([run]);
			expect(result.current.error).toBe('read failed');
		});
	});
});
__maestroMicrobenchDescribe('useBatchedSessionUpdates.turnSettings', () => {
	const SESSION_ID = 'session-1';
	const TAB_ID = 'tab-1';

	function seed(tabOverrides: Partial<AITab>): void {
		useSessionStore.setState({
			sessions: [
				createMockSession({
					id: SESSION_ID,
					activeTabId: TAB_ID,
					aiTabs: [createMockAITab({ id: TAB_ID, logs: [], ...tabOverrides })],
				}),
			],
			activeSessionId: SESSION_ID,
		});
	}

	function tabLogs(): LogEntry[] {
		const session = useSessionStore.getState().sessions.find((s) => s.id === SESSION_ID);
		return session?.aiTabs.find((t) => t.id === TAB_ID)?.logs ?? [];
	}

	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe('useBatchedSessionUpdates - turn settings stamped on agent output', () => {
		it("stamps the entry with the turn's codified model and effort", () => {
			seed({ turnModel: 'opus', turnEffort: 'high' });

			const { result } = renderHook(() => useBatchedSessionUpdates());

			act(() => {
				result.current.appendLog(SESSION_ID, TAB_ID, true, 'Working on it.');
				result.current.flushNow();
			});

			const [entry] = tabLogs();
			expect(entry.turnModel).toBe('opus');
			expect(entry.turnEffort).toBe('high');
		});

		it('ignores a model change made while the turn is still streaming', () => {
			// The user switched the tab to sonnet mid-turn. That applies to the NEXT
			// message; this response still came from opus and must say so.
			seed({ turnModel: 'opus', turnEffort: 'high', customModel: 'sonnet', customEffort: 'low' });

			const { result } = renderHook(() => useBatchedSessionUpdates());

			act(() => {
				result.current.appendLog(SESSION_ID, TAB_ID, true, 'Still the opus turn.');
				result.current.flushNow();
			});

			const [entry] = tabLogs();
			expect(entry.turnModel).toBe('opus');
			expect(entry.turnEffort).toBe('high');
		});

		it('leaves the entry unstamped when the agent default was in force', () => {
			seed({});

			const { result } = renderHook(() => useBatchedSessionUpdates());

			act(() => {
				result.current.appendLog(SESSION_ID, TAB_ID, true, 'Default configuration.');
				result.current.flushNow();
			});

			const [entry] = tabLogs();
			expect(entry.turnModel).toBeUndefined();
			expect(entry.turnEffort).toBeUndefined();
		});
	});
});
__maestroMicrobenchDescribe('useSshRemoteNames', () => {
	const mockGetConfigs = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
		// Shared cache entry with useSshRemotes - clear it so each case fetches.
		ipcCache.invalidate('ssh-configs');
		(window as any).maestro = {
			sshRemote: {
				getConfigs: mockGetConfigs,
			},
		};
	});

	describe('useSshRemoteNames', () => {
		it('starts empty and resolves into an id -> name map', async () => {
			mockGetConfigs.mockResolvedValue({
				success: true,
				configs: [
					{ id: 'r1', name: 'build-box' },
					{ id: 'r2', name: 'gpu-rig' },
				],
			});

			const { result } = renderHook(() => useSshRemoteNames());
			expect(result.current.size).toBe(0);

			await waitFor(() => expect(result.current.get('r1')).toBe('build-box'));
			expect(result.current.get('r2')).toBe('gpu-rig');
		});

		it('stays empty when the configs fail to load', async () => {
			mockGetConfigs.mockResolvedValue({ success: false, error: 'nope' });

			const { result } = renderHook(() => useSshRemoteNames());
			await waitFor(() => expect(mockGetConfigs).toHaveBeenCalled());
			expect(result.current.size).toBe(0);
		});

		it('swallows a rejected lookup instead of crashing the caller', async () => {
			mockGetConfigs.mockRejectedValue(new Error('ipc down'));

			const { result } = renderHook(() => useSshRemoteNames());
			await waitFor(() => expect(mockGetConfigs).toHaveBeenCalled());
			expect(result.current.size).toBe(0);
		});

		it('serves a second mount from the shared cache without a second IPC call', async () => {
			mockGetConfigs.mockResolvedValue({
				success: true,
				configs: [{ id: 'r1', name: 'build-box' }],
			});

			const first = renderHook(() => useSshRemoteNames());
			await waitFor(() => expect(first.result.current.get('r1')).toBe('build-box'));

			const second = renderHook(() => useSshRemoteNames());
			await waitFor(() => expect(second.result.current.get('r1')).toBe('build-box'));
			expect(mockGetConfigs).toHaveBeenCalledTimes(1);
		});
	});
});
__maestroMicrobenchDescribe('groupChatOpenStateRace.regression', () => {
	const CHAT_ID = 'gc-race';

	const baseState = {
		groupChats: [],
		activeGroupChatId: null,
		groupChatMessages: [],
		groupChatState: 'moderator-thinking' as const,
		participantStates: new Map(),
		moderatorUsage: null,
		groupChatStates: new Map([[CHAT_ID, 'moderator-thinking' as const]]),
		allGroupChatParticipantStates: new Map(),
		unreadGroupChatIds: new Set<string>(),
		groupChatQueues: {},
		groupChatReadOnlyMode: false,
		groupChatRightTab: 'participants' as const,
		groupChatParticipantColors: {},
		groupChatStagedImagesById: {},
		participantLiveOutput: new Map(),
		groupChatError: null,
	};

	describe('opening a group chat does not resurrect a stale busy state', () => {
		beforeEach(() => {
			vi.clearAllMocks();
			useGroupChatStore.setState(baseState);
			useUIStore.setState({ activeFocus: 'main' });

			(window as any).maestro.groupChat = {
				load: vi.fn().mockResolvedValue({ id: CHAT_ID, name: 'Race', participants: [] }),
				// The moderator finishes while the transcript is still loading. This is
				// the real ordering on a phone: the room is opened on wake, and the
				// `idle` frame is already on the wire behind the load.
				getMessages: vi.fn().mockImplementation(async () => {
					useGroupChatStore.getState().setGroupChatStates((prev) => {
						const next = new Map(prev);
						next.set(CHAT_ID, 'idle');
						return next;
					});
					return [];
				}),
				onMessage: vi.fn().mockReturnValue(() => {}),
				onStateChange: vi.fn().mockReturnValue(() => {}),
				// The queue moved into main, so the hook loads it on open and subscribes to
				// the broadcast. Without these the hook throws before it does anything else.
				getQueue: vi.fn().mockResolvedValue({ items: [], paused: false }),
				submitMessage: vi.fn().mockResolvedValue({ items: [], paused: false }),
				queueRemove: vi
					.fn()
					.mockResolvedValue({ state: { items: [], paused: false }, refused: false }),
				queueReorder: vi
					.fn()
					.mockResolvedValue({ state: { items: [], paused: false }, refused: false }),
				queueResume: vi.fn().mockResolvedValue({ items: [], paused: false }),
				onQueueState: vi.fn().mockReturnValue(() => {}),
				onParticipantsChanged: vi.fn().mockReturnValue(() => {}),
				onModeratorUsage: vi.fn().mockReturnValue(() => {}),
				onParticipantState: vi.fn().mockReturnValue(() => {}),
				onModeratorSessionIdChanged: vi.fn().mockReturnValue(() => {}),
			};
			(window as any).maestro.settings = {
				get: vi.fn().mockResolvedValue(undefined),
				set: vi.fn().mockResolvedValue(undefined),
			};
		});

		it('adopts the state that arrived during the load, not the one snapshotted before it', async () => {
			const { result } = renderHook(() => useGroupChatHandlers());

			await act(async () => {
				await result.current.handleOpenGroupChat(CHAT_ID);
			});

			// The authoritative per-chat map says idle, so the scalar the drain reads
			// must agree with it. Before the fix this is 'moderator-thinking', taken
			// from the map as it looked before `getMessages` resolved.
			expect(useGroupChatStore.getState().groupChatStates.get(CHAT_ID)).toBe('idle');
			expect(useGroupChatStore.getState().groupChatState).toBe('idle');
		});
	});
});
__maestroMicrobenchDescribe('useOutputSearchMatching', () => {
	function mountContainer(html: string): HTMLDivElement {
		const el = document.createElement('div');
		el.innerHTML = html;
		document.body.appendChild(el);
		return el;
	}

	describe('useOutputSearchMatching', () => {
		it('counts plain-text matches in the container and advances with goToNextMatch', async () => {
			const container = mountContainer('<p>alpha beta alpha</p>');
			const { result, unmount } = renderHook(() => {
				const containerRef = useRef<HTMLElement | null>(container);
				return useOutputSearchMatching({
					containerRef,
					outputSearchOpen: true,
					outputSearchRegex: false,
					debouncedSearchQuery: 'alpha',
					contentRevision: 1,
				});
			});

			await waitFor(() => {
				expect(result.current.totalMatches).toBe(2);
			});
			expect(result.current.currentMatchIndex).toBe(0);

			act(() => {
				result.current.goToNextMatch();
			});
			expect(result.current.currentMatchIndex).toBe(1);

			act(() => {
				result.current.goToNextMatch();
			});
			expect(result.current.currentMatchIndex).toBe(0);

			unmount();
			container.remove();
		});

		it('reports zero matches and clears when the query is empty', async () => {
			const container = mountContainer('<p>hello world</p>');
			const { result, unmount } = renderHook(() => {
				const containerRef = useRef<HTMLElement | null>(container);
				return useOutputSearchMatching({
					containerRef,
					outputSearchOpen: true,
					outputSearchRegex: false,
					debouncedSearchQuery: '   ',
					contentRevision: 1,
				});
			});

			await waitFor(() => {
				expect(result.current.totalMatches).toBe(0);
			});
			expect(result.current.regexError).toBeNull();

			unmount();
			container.remove();
		});

		it('rescans when contentRevision changes after the DOM text updates', async () => {
			const container = mountContainer('<p>alpha</p>');
			const { result, rerender, unmount } = renderHook(
				({ contentRevision }: { contentRevision: number }) => {
					const containerRef = useRef<HTMLElement | null>(container);
					return useOutputSearchMatching({
						containerRef,
						outputSearchOpen: true,
						outputSearchRegex: false,
						debouncedSearchQuery: 'alpha',
						contentRevision,
					});
				},
				{ initialProps: { contentRevision: 1 } }
			);

			await waitFor(() => {
				expect(result.current.totalMatches).toBe(1);
			});

			container.innerHTML = '<p>alpha alpha</p>';
			rerender({ contentRevision: 2 });

			await waitFor(() => {
				expect(result.current.totalMatches).toBe(2);
			});

			unmount();
			container.remove();
		});

		it('sets regexError and reports zero matches for an invalid regex', async () => {
			const container = mountContainer('<p>alpha</p>');
			const { result, unmount } = renderHook(() => {
				const containerRef = useRef<HTMLElement | null>(container);
				return useOutputSearchMatching({
					containerRef,
					outputSearchOpen: true,
					outputSearchRegex: true,
					debouncedSearchQuery: '[',
					contentRevision: 1,
				});
			});

			await waitFor(() => {
				expect(result.current.regexError).toBeTruthy();
			});
			expect(result.current.totalMatches).toBe(0);

			unmount();
			container.remove();
		});

		it('selects the match inside the jumped-to row', async () => {
			const container = mountContainer(
				'<div data-log-id="a">alpha</div><div data-log-id="b">alpha</div>'
			);
			const jumpRef = { current: 'b' as string | null };
			const { result, unmount } = renderHook(() => {
				const containerRef = useRef<HTMLElement | null>(container);
				return useOutputSearchMatching({
					containerRef,
					outputSearchOpen: true,
					outputSearchRegex: false,
					debouncedSearchQuery: 'alpha',
					contentRevision: 1,
					pendingJumpMatchIdRef: jumpRef,
					jumpIdAttribute: 'data-log-id',
				});
			});

			await waitFor(() => {
				expect(result.current.currentMatchIndex).toBe(1);
			});
			expect(jumpRef.current).toBeNull();

			unmount();
			container.remove();
		});
	});
});
__maestroMicrobenchDescribe('headlessSidebarVisibility', () => {
	const session = createMockSession({ id: 'relay-target', state: 'idle', aiTabs: [] });
	const counts = { [session.id]: 1 };
	afterEach(() => useHeadlessActivityStore.setState({ revision: -1, counts: {} }));

	describe('headless activity under the unread agents filter', () => {
		it('keeps only actual headless workers in shared attention and membership decisions', () => {
			const ctx = {
				batchSessionIds: new Set<string>(),
				stuckOutageIds: new Set<string>(),
				headlessCounts: counts,
			};
			expect(sessionNeedsAttention(session, ctx)).toBe(true);
			expect(passesUnreadFilter(session, { showUnreadAgentsOnly: true, ...ctx })).toBe(true);
			expect(sessionNeedsAttention(createMockSession({ id: 'queued', state: 'idle' }), ctx)).toBe(
				false
			);
		});
		it('keeps headless agents in the navigation projection without desktop tabs', () => {
			const input = {
				sessions: [session],
				groups: [],
				bookmarksCollapsed: false,
				showUnreadAgentsOnly: true,
				headlessCounts: counts,
			};
			expect(computeSortedSessions(input).visibleSessions.map((s) => s.id)).toContain(session.id);
		});
		it('cycles to a Relay worker under the unread filter without changing its desktop state', () => {
			const active = createMockSession({ id: 'active', name: 'Alpha' });
			useSessionStore.setState({
				sessions: [active, session],
				groups: [],
				activeSessionId: active.id,
				cyclePosition: -1,
			});
			useUIStore.setState({
				leftSidebarOpen: true,
				bookmarksCollapsed: true,
				showUnreadAgentsOnly: true,
			});
			useSettingsStore.setState({ groupChatsExpanded: false, ungroupedCollapsed: false });
			useHeadlessActivityStore.setState({ revision: 1, counts });
			cycleSession('next', {
				handleOpenGroupChat: vi.fn(),
				starredItems: [],
				navIndexMap: new Map(),
			});
			expect(useSessionStore.getState().activeSessionId).toBe(session.id);
			expect(useSessionStore.getState().sessions[1].state).toBe('idle');
		});

		it('updates categorization when only the live counts change', () => {
			useSessionStore.setState({ sessions: [session], groups: [] });
			useHeadlessActivityStore.setState({ revision: 0, counts: {} });
			const { result } = renderHook(() => useSessionCategories('', [session], true, 'other'));
			expect(result.current.sortedFilteredSessions).toHaveLength(0);
			act(() => useHeadlessActivityStore.setState({ revision: 1, counts }));
			expect(result.current.sortedFilteredSessions.map((s) => s.id)).toContain(session.id);
			act(() => useHeadlessActivityStore.setState({ revision: 2, counts: {} }));
			expect(result.current.sortedFilteredSessions).toHaveLength(0);
		});
	});
});
