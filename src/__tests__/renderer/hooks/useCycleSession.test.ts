/**
 * Tests for cycleSession (event-time store reads)
 *
 * Tests:
 *   - Next cycling through ungrouped sessions in alphabetical order
 *   - Prev cycling (reverse direction)
 *   - Wrap-around from last to first (next) and first to last (prev)
 *   - Bookmark duplicates - bookmarked session appears in both bookmark section and regular location
 *   - Group sessions sorted within their groups
 *   - Collapsed groups are skipped
 *   - Ungrouped collapsed skips ungrouped sessions
 *   - Bookmarks collapsed skips bookmark section
 *   - Group chat cycling when groupChatsExpanded is true
 *   - Archived group chats skipped during cycling
 *   - Collapsed sidebar uses sortedSessions from deps
 *   - Empty visual order is a no-op
 *   - Current item not visible selects first visible item
 *   - Worktree children included when parent's worktreesExpanded !== false
 *   - Worktree children skipped when parent's worktreesExpanded === false
 *   - Position tracking via cyclePosition store field
 *   - Unread filter restricts cycling to unread/busy agents only
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================================
// Mocks
// ============================================================================

// compareNamesIgnoringEmojis is imported from another hook file; mock it with
// simple localeCompare so tests are not sensitive to emoji-stripping logic.
vi.mock('../../../renderer/hooks/session/useSortedSessions', () => ({
	compareNamesIgnoringEmojis: (a: string, b: string) => a.localeCompare(b),
}));

// ============================================================================
// Imports (after mocks)
// ============================================================================

import { cycleSession } from '../../../renderer/hooks/session/useCycleSession';
import type { CycleSessionDeps } from '../../../renderer/hooks/session/useCycleSession';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useGroupChatStore } from '../../../renderer/stores/groupChatStore';
import { useUIStore } from '../../../renderer/stores/uiStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import type { Session } from '../../../renderer/types';
import { resetStores, createMockSession, createMockAITab } from '../../helpers';
import { useBatchStore } from '../../../renderer/stores/batchStore';
import { useRetryStore } from '../../../renderer/stores/retryStore';
import { DEFAULT_BATCH_STATE } from '../../../renderer/hooks/batch/batchReducer';

// ============================================================================
// Helpers
// ============================================================================

/** Build a minimal Session object. Only the fields cycleSession actually reads. */
function makeSession(overrides: Partial<Session> & { id: string; name: string }): Session {
	return {
		id: overrides.id,
		name: overrides.name,
		groupId: overrides.groupId,
		bookmarked: overrides.bookmarked ?? false,
		parentSessionId: overrides.parentSessionId,
		worktreesExpanded: overrides.worktreesExpanded,
		worktreeBranch: overrides.worktreeBranch,
		// Provide stubs for the rest of the required Session fields so TypeScript is happy
		toolType: 'claude-code' as any,
		state: 'idle',
		cwd: '/tmp',
		fullPath: '/tmp',
		projectRoot: '/tmp',
		isGitRepo: false,
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
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		fileTreeAutoRefreshInterval: 180,
		shellCwd: '/tmp',
		aiCommandHistory: [],
		shellCommandHistory: [],
		executionQueue: [],
		activeTimeMs: 0,
		aiTabs: [],
		activeTabId: '',
		closedTabHistory: [],
		filePreviewTabs: [],
		activeFileTabId: null,
		unifiedTabOrder: [],
		unifiedClosedTabHistory: [],
		autoRunFolderPath: '/tmp',
		...overrides,
	} as Session;
}

/** Build a minimal GroupChat object. */
function makeGroupChat(id: string, name: string) {
	return { id, name } as any;
}

/** Build a minimal Group object. */
function makeGroup(id: string, name: string, collapsed = false) {
	return { id, name, collapsed } as any;
}

/** Create default deps for cycleSession. */
function makeDeps(overrides: Partial<CycleSessionDeps> = {}): CycleSessionDeps {
	return {
		sortedSessions: [],
		handleOpenGroupChat: vi.fn(),
		starredItems: [],
		activateStarredItem: vi.fn(),
		navIndexMap: new Map(),
		...overrides,
	};
}

/** Build a minimal open StarredItem row. */
function makeOpenStarred(parentSessionId: string, tabId: string, displayName: string) {
	return {
		kind: 'open' as const,
		key: `open:${parentSessionId}:${tabId}`,
		displayName,
		agentName: 'Agent',
		parentSessionId,
		tabId,
	};
}

// ============================================================================
// Setup / Teardown
// ============================================================================

beforeEach(() => {
	vi.clearAllMocks();
	resetStores(
		useSessionStore,
		useGroupChatStore,
		useUIStore,
		useSettingsStore,
		useBatchStore,
		useRetryStore
	);
});

// ============================================================================
// Tests
// ============================================================================

describe('cycleSession', () => {
	// =========================================================================
	// Export
	// =========================================================================
	describe('export', () => {
		it('exports cycleSession function', () => {
			expect(typeof cycleSession).toBe('function');
		});
	});

	// =========================================================================
	// Empty visual order - no-op
	// =========================================================================
	describe('empty visual order', () => {
		it('does nothing when no sessions, groups, or group chats exist', () => {
			const deps = makeDeps();

			cycleSession('next', deps);

			// No active session should have been set
			expect(useSessionStore.getState().activeSessionId).toBe('');
			expect(deps.handleOpenGroupChat).not.toHaveBeenCalled();
		});

		it('does nothing when ungroupedCollapsed and no groups/group chats', () => {
			useSettingsStore.setState({ ungroupedCollapsed: true } as any);
			useSettingsStore.setState({ groupChatsExpanded: false } as any);

			const sessA = makeSession({ id: 'a', name: 'Alpha' });
			useSessionStore.setState({ sessions: [sessA], activeSessionId: 'a' } as any);

			const deps = makeDeps();

			cycleSession('next', deps);

			// activeSessionId should remain 'a' because visual order is empty - no-op
			expect(useSessionStore.getState().activeSessionId).toBe('a');
		});
	});

	// =========================================================================
	// Ungrouped sessions - sidebar open, bookmarks collapsed, no groups, no group chats
	// =========================================================================
	describe('next cycling - ungrouped sessions', () => {
		it('moves to the next session in alphabetical order', () => {
			const sessA = makeSession({ id: 'a', name: 'Alpha' });
			const sessB = makeSession({ id: 'b', name: 'Beta' });
			const sessC = makeSession({ id: 'c', name: 'Gamma' });

			useSessionStore.setState({
				sessions: [sessC, sessA, sessB], // intentionally unordered
				activeSessionId: 'a',
				cyclePosition: -1,
			} as any);
			useUIStore.setState({
				leftSidebarOpen: true,
				bookmarksCollapsed: true,
			} as any);
			useSettingsStore.setState({ groupChatsExpanded: false } as any);

			const deps = makeDeps();

			cycleSession('next', deps);

			// Alpha → Beta (alphabetical order)
			expect(useSessionStore.getState().activeSessionId).toBe('b');
		});

		it('advances correctly through multiple next cycles', () => {
			const sessA = makeSession({ id: 'a', name: 'Alpha' });
			const sessB = makeSession({ id: 'b', name: 'Beta' });
			const sessC = makeSession({ id: 'c', name: 'Gamma' });

			useSessionStore.setState({
				sessions: [sessA, sessB, sessC],
				activeSessionId: 'a',
				cyclePosition: -1,
			} as any);
			useUIStore.setState({
				leftSidebarOpen: true,
				bookmarksCollapsed: true,
			} as any);
			useSettingsStore.setState({ groupChatsExpanded: false } as any);

			const deps = makeDeps();

			cycleSession('next', deps);
			expect(useSessionStore.getState().activeSessionId).toBe('b');

			cycleSession('next', deps);
			expect(useSessionStore.getState().activeSessionId).toBe('c');
		});
	});

	// =========================================================================
	// Prev cycling - reverse direction
	// =========================================================================
	describe('prev cycling', () => {
		it('moves to the previous session in alphabetical order', () => {
			const sessA = makeSession({ id: 'a', name: 'Alpha' });
			const sessB = makeSession({ id: 'b', name: 'Beta' });
			const sessC = makeSession({ id: 'c', name: 'Gamma' });

			useSessionStore.setState({
				sessions: [sessA, sessB, sessC],
				activeSessionId: 'b',
				cyclePosition: -1,
			} as any);
			useUIStore.setState({
				leftSidebarOpen: true,
				bookmarksCollapsed: true,
			} as any);
			useSettingsStore.setState({ groupChatsExpanded: false } as any);

			const deps = makeDeps();

			cycleSession('prev', deps);

			// Beta → Alpha
			expect(useSessionStore.getState().activeSessionId).toBe('a');
		});

		it('advances correctly through multiple prev cycles', () => {
			const sessA = makeSession({ id: 'a', name: 'Alpha' });
			const sessB = makeSession({ id: 'b', name: 'Beta' });
			const sessC = makeSession({ id: 'c', name: 'Gamma' });

			useSessionStore.setState({
				sessions: [sessA, sessB, sessC],
				activeSessionId: 'c',
				cyclePosition: -1,
			} as any);
			useUIStore.setState({
				leftSidebarOpen: true,
				bookmarksCollapsed: true,
			} as any);
			useSettingsStore.setState({ groupChatsExpanded: false } as any);

			const deps = makeDeps();

			cycleSession('prev', deps);
			expect(useSessionStore.getState().activeSessionId).toBe('b');

			cycleSession('prev', deps);
			expect(useSessionStore.getState().activeSessionId).toBe('a');
		});
	});

	// =========================================================================
	// Wrap-around
	// =========================================================================
	describe('wrap-around', () => {
		it('wraps from last to first on next', () => {
			const sessA = makeSession({ id: 'a', name: 'Alpha' });
			const sessB = makeSession({ id: 'b', name: 'Beta' });
			const sessC = makeSession({ id: 'c', name: 'Gamma' });

			useSessionStore.setState({
				sessions: [sessA, sessB, sessC],
				activeSessionId: 'c',
				cyclePosition: -1,
			} as any);
			useUIStore.setState({
				leftSidebarOpen: true,
				bookmarksCollapsed: true,
			} as any);
			useSettingsStore.setState({ groupChatsExpanded: false } as any);

			const deps = makeDeps();

			cycleSession('next', deps);

			// Gamma (last) → Alpha (first)
			expect(useSessionStore.getState().activeSessionId).toBe('a');
		});

		it('wraps from first to last on prev', () => {
			const sessA = makeSession({ id: 'a', name: 'Alpha' });
			const sessB = makeSession({ id: 'b', name: 'Beta' });
			const sessC = makeSession({ id: 'c', name: 'Gamma' });

			useSessionStore.setState({
				sessions: [sessA, sessB, sessC],
				activeSessionId: 'a',
				cyclePosition: -1,
			} as any);
			useUIStore.setState({
				leftSidebarOpen: true,
				bookmarksCollapsed: true,
			} as any);
			useSettingsStore.setState({ groupChatsExpanded: false } as any);

			const deps = makeDeps();

			cycleSession('prev', deps);

			// Alpha (first) → Gamma (last)
			expect(useSessionStore.getState().activeSessionId).toBe('c');
		});
	});

	// =========================================================================
	// Bookmark duplicates
	// =========================================================================
	describe('bookmark section', () => {
		it('bookmarked sessions appear at the top before their regular position', () => {
			// sessB is bookmarked; visual order should be: B (bookmark), A (ungrouped), B (ungrouped)
			const sessA = makeSession({ id: 'a', name: 'Alpha' });
			const sessB = makeSession({ id: 'b', name: 'Beta', bookmarked: true });

			useSessionStore.setState({
				sessions: [sessA, sessB],
				activeSessionId: 'a',
				cyclePosition: -1,
			} as any);
			useUIStore.setState({
				leftSidebarOpen: true,
				bookmarksCollapsed: false,
			} as any);
			useSettingsStore.setState({ groupChatsExpanded: false } as any);

			const deps = makeDeps();

			// Active = Alpha (index 1 in visualOrder: [Beta-bookmark, Alpha, Beta-ungrouped])
			// prev from Alpha → Beta-bookmark (index 0)
			cycleSession('prev', deps);

			expect(useSessionStore.getState().activeSessionId).toBe('b');
			// cyclePosition should be 0 (first occurrence - bookmark slot)
			expect(useSessionStore.getState().cyclePosition).toBe(0);
		});

		it('can cycle through all occurrences of a bookmarked session', () => {
			// Visual order: [B-bookmark(0), A-ungrouped(1), B-ungrouped(2)]
			const sessA = makeSession({ id: 'a', name: 'Alpha' });
			const sessB = makeSession({ id: 'b', name: 'Beta', bookmarked: true });

			useSessionStore.setState({
				sessions: [sessA, sessB],
				// Start active on B - cyclePosition=0 means we're on the bookmark slot
				activeSessionId: 'b',
				cyclePosition: 0,
			} as any);
			useUIStore.setState({
				leftSidebarOpen: true,
				bookmarksCollapsed: false,
			} as any);
			useSettingsStore.setState({ groupChatsExpanded: false } as any);

			const deps = makeDeps();

			// next from B-bookmark(0) → A-ungrouped(1)
			cycleSession('next', deps);
			expect(useSessionStore.getState().activeSessionId).toBe('a');
			expect(useSessionStore.getState().cyclePosition).toBe(1);

			// next from A-ungrouped(1) → B-ungrouped(2)
			cycleSession('next', deps);
			expect(useSessionStore.getState().activeSessionId).toBe('b');
			expect(useSessionStore.getState().cyclePosition).toBe(2);
		});

		it('bookmarks collapsed: bookmarked sessions only appear in ungrouped section', () => {
			const sessA = makeSession({ id: 'a', name: 'Alpha' });
			const sessB = makeSession({ id: 'b', name: 'Beta', bookmarked: true });

			useSessionStore.setState({
				sessions: [sessA, sessB],
				activeSessionId: 'a',
				cyclePosition: -1,
			} as any);
			useUIStore.setState({
				leftSidebarOpen: true,
				bookmarksCollapsed: true,
			} as any);
			useSettingsStore.setState({ groupChatsExpanded: false } as any);

			const deps = makeDeps();

			// Visual order without bookmarks: [Alpha, Beta]; next from Alpha → Beta
			cycleSession('next', deps);

			expect(useSessionStore.getState().activeSessionId).toBe('b');
			expect(useSessionStore.getState().cyclePosition).toBe(1);
		});
	});

	// =========================================================================
	// Highlight tracks the EXACT occurrence (bookmarked-agent jump-up bug)
	// =========================================================================
	describe('selectedSidebarIndex tracks the cycled occurrence', () => {
		it('lands on a bookmarked agent group row without snapping to its bookmark row', () => {
			// 'b' is bookmarked AND in a group, so it appears twice in the sidebar:
			// bookmark row (top) and group row (below). Cycling onto the GROUP row must
			// highlight the group row, not jump the highlight up to the bookmark row.
			const grp = makeGroup('grp-1', 'Group', false);
			const sessA = makeSession({ id: 'a', name: 'Alpha', groupId: 'grp-1' });
			const sessB = makeSession({ id: 'b', name: 'Beta', bookmarked: true, groupId: 'grp-1' });

			useSessionStore.setState({
				sessions: [sessA, sessB],
				groups: [grp],
				activeSessionId: 'a',
				cyclePosition: -1,
			} as any);
			useUIStore.setState({
				leftSidebarOpen: true,
				bookmarksCollapsed: false,
				selectedSidebarIndex: 0,
				sidebarExtraSelection: null,
			} as any);
			useSettingsStore.setState({ groupChatsExpanded: false, ungroupedCollapsed: false } as any);

			// navIndexMap: bookmark row for 'b' at 0, then group rows Alpha=1, Beta=2.
			const navIndexMap = new Map<string, number>([
				['bookmark:b', 0],
				['group:grp-1:a', 1],
				['group:grp-1:b', 2],
			]);
			const deps = makeDeps({ navIndexMap });

			// Visual order: [bookmark Beta(0), group Alpha(1), group Beta(2)].
			// Active Alpha → first session occurrence is group Alpha(1). next → group Beta(2).
			cycleSession('next', deps);

			expect(useSessionStore.getState().activeSessionId).toBe('b');
			// Highlight must be the GROUP occurrence (navIndex 2), NOT the bookmark row (0).
			expect(useUIStore.getState().selectedSidebarIndex).toBe(2);
		});

		it('highlights the bookmark row when cycling through the bookmarks section', () => {
			const sessA = makeSession({ id: 'a', name: 'Alpha' });
			const sessB = makeSession({ id: 'b', name: 'Beta', bookmarked: true });

			useSessionStore.setState({
				sessions: [sessA, sessB],
				activeSessionId: 'a',
				cyclePosition: -1,
			} as any);
			useUIStore.setState({
				leftSidebarOpen: true,
				bookmarksCollapsed: false,
				selectedSidebarIndex: -1,
				sidebarExtraSelection: null,
			} as any);
			useSettingsStore.setState({ groupChatsExpanded: false, ungroupedCollapsed: false } as any);

			// bookmark Beta=0, ungrouped Alpha=1, ungrouped Beta=2
			const navIndexMap = new Map<string, number>([
				['bookmark:b', 0],
				['ungrouped:a', 1],
				['ungrouped:b', 2],
			]);
			const deps = makeDeps({ navIndexMap });

			// Visual order: [bookmark Beta(0), Alpha(1), Beta(2)]. Active Alpha is at
			// visual index 1; prev → bookmark Beta(0).
			cycleSession('prev', deps);

			expect(useSessionStore.getState().activeSessionId).toBe('b');
			// Bookmark occurrence highlighted (navIndex 0).
			expect(useUIStore.getState().selectedSidebarIndex).toBe(0);
		});
	});

	// =========================================================================
	// Starred Sessions section
	// =========================================================================
	describe('starred sessions section', () => {
		it('starred rows appear at the top of the visual order, above agents', () => {
			// Starred row points at agent 'b'. Visual order:
			// [starred(id=b), Alpha(a), Beta(b)]
			const sessA = makeSession({ id: 'a', name: 'Alpha' });
			const sessB = makeSession({ id: 'b', name: 'Beta' });

			useSessionStore.setState({
				sessions: [sessA, sessB],
				activeSessionId: 'a',
				cyclePosition: -1,
			} as any);
			useUIStore.setState({
				leftSidebarOpen: true,
				bookmarksCollapsed: true,
			} as any);
			useSettingsStore.setState({
				groupChatsExpanded: false,
				starredSessionsCollapsed: false,
			} as any);

			const activateStarredItem = vi.fn();
			const starredItems = [makeOpenStarred('b', 't1', 'Zstar')];
			const deps = makeDeps({ starredItems, activateStarredItem });

			// Active = Alpha (session slot at index 1). prev → starred slot at index 0.
			cycleSession('prev', deps);

			expect(activateStarredItem).toHaveBeenCalledWith(starredItems[0]);
			expect(useSessionStore.getState().cyclePosition).toBe(0);
			// The cursor must visibly mark the starred row (the reported bug was no feedback).
			expect(useUIStore.getState().sidebarExtraSelection).toEqual({
				kind: 'starred',
				key: starredItems[0].key,
			});
		});

		it('consecutive presses advance through starred rows instead of getting stuck', () => {
			// Reproduces the reported bug: a starred row's parent agent == the currently
			// active agent, so activating it leaves activeSessionId unchanged. Without the
			// sidebarExtraSelection cursor, the next press would re-resolve to the same
			// agent occurrence and bounce back onto the same starred row.
			const sessA = makeSession({ id: 'chat', name: 'Chat Intel', bookmarked: true });
			// Two starred rows; the second points at the active agent ('chat').
			const starredItems = [
				makeOpenStarred('rc', 't0', 'Package Version Check'),
				makeOpenStarred('chat', 't1', 'Slack Discord Last Run'),
			];

			useSessionStore.setState({
				sessions: [sessA],
				activeSessionId: 'chat',
				cyclePosition: -1,
			} as any);
			useUIStore.setState({
				leftSidebarOpen: true,
				bookmarksCollapsed: false,
				sidebarExtraSelection: null,
			} as any);
			useSettingsStore.setState({
				groupChatsExpanded: false,
				starredSessionsCollapsed: false,
			} as any);

			// activateStarredItem is a no-op spy here (the real one would set the parent
			// active); the cycle owns sidebarExtraSelection regardless.
			const activateStarredItem = vi.fn();
			const deps = makeDeps({ starredItems, activateStarredItem });

			// Visual order: [Package(0), Slack(1), bookmark Chat(2)].
			// Active 'chat' with no extra cursor → first session occurrence = bookmark(2).
			// prev → Slack starred(1).
			cycleSession('prev', deps);
			expect(activateStarredItem).toHaveBeenLastCalledWith(starredItems[1]);
			expect(useUIStore.getState().sidebarExtraSelection).toEqual({
				kind: 'starred',
				key: starredItems[1].key,
			});

			// prev again must ADVANCE to Package starred(0), not bounce back to Slack.
			cycleSession('prev', deps);
			expect(activateStarredItem).toHaveBeenLastCalledWith(starredItems[0]);
			expect(useUIStore.getState().sidebarExtraSelection).toEqual({
				kind: 'starred',
				key: starredItems[0].key,
			});
		});

		it('clears the starred cursor when cycling onto a plain agent', () => {
			const sessA = makeSession({ id: 'a', name: 'Alpha' });
			const starredItems = [makeOpenStarred('a', 't1', 'Star A')];

			useSessionStore.setState({
				sessions: [sessA],
				activeSessionId: 'a',
				cyclePosition: 0, // currently parked on the starred slot
			} as any);
			useUIStore.setState({
				leftSidebarOpen: true,
				bookmarksCollapsed: true,
				sidebarExtraSelection: { kind: 'starred', key: starredItems[0].key },
			} as any);
			useSettingsStore.setState({
				groupChatsExpanded: false,
				starredSessionsCollapsed: false,
			} as any);

			const deps = makeDeps({ starredItems });

			// Visual order: [Star A(0), Alpha(1)]. On starred(0), next → Alpha(1) agent.
			cycleSession('next', deps);

			expect(useSessionStore.getState().activeSessionId).toBe('a');
			expect(useUIStore.getState().sidebarExtraSelection).toBeNull();
		});

		it('skips the starred section when starredSessionsCollapsed is true', () => {
			const sessA = makeSession({ id: 'a', name: 'Alpha' });
			const sessB = makeSession({ id: 'b', name: 'Beta' });

			useSessionStore.setState({
				sessions: [sessA, sessB],
				activeSessionId: 'a',
				cyclePosition: -1,
			} as any);
			useUIStore.setState({
				leftSidebarOpen: true,
				bookmarksCollapsed: true,
			} as any);
			useSettingsStore.setState({
				groupChatsExpanded: false,
				starredSessionsCollapsed: true,
			} as any);

			const activateStarredItem = vi.fn();
			const starredItems = [makeOpenStarred('b', 't1', 'Zstar')];
			const deps = makeDeps({ starredItems, activateStarredItem });

			// Visual order: [Alpha, Beta] only. prev from Alpha(0) wraps to Beta(1).
			cycleSession('prev', deps);

			expect(activateStarredItem).not.toHaveBeenCalled();
			expect(useSessionStore.getState().activeSessionId).toBe('b');
		});

		it('skips the starred section when the unread-agents filter is active', () => {
			// Section is hidden in SessionList under the unread filter, so cycling
			// must not traverse it either.
			const sessA = makeSession({ id: 'a', name: 'Alpha', aiTabs: [{ hasUnread: true }] as any });
			const sessB = makeSession({ id: 'b', name: 'Beta', aiTabs: [{ hasUnread: true }] as any });

			useSessionStore.setState({
				sessions: [sessA, sessB],
				activeSessionId: 'a',
				cyclePosition: -1,
			} as any);
			useUIStore.setState({
				leftSidebarOpen: true,
				bookmarksCollapsed: true,
				showUnreadAgentsOnly: true,
			} as any);
			useSettingsStore.setState({
				groupChatsExpanded: false,
				starredSessionsCollapsed: false,
			} as any);

			const activateStarredItem = vi.fn();
			const starredItems = [makeOpenStarred('b', 't1', 'Zstar')];
			const deps = makeDeps({ starredItems, activateStarredItem });

			cycleSession('next', deps);

			expect(activateStarredItem).not.toHaveBeenCalled();
			// Alpha → Beta (both unread); starred row excluded.
			expect(useSessionStore.getState().activeSessionId).toBe('b');
		});

		it('cycles forward from the last agent onto starred rows (wrap to top)', () => {
			const sessA = makeSession({ id: 'a', name: 'Alpha' });

			useSessionStore.setState({
				sessions: [sessA],
				activeSessionId: 'a',
				cyclePosition: 1, // on the Alpha session slot (index 1, after starred at 0)
			} as any);
			useUIStore.setState({
				leftSidebarOpen: true,
				bookmarksCollapsed: true,
			} as any);
			useSettingsStore.setState({
				groupChatsExpanded: false,
				starredSessionsCollapsed: false,
			} as any);

			const activateStarredItem = vi.fn();
			const starredItems = [makeOpenStarred('a', 't1', 'Star One')];
			const deps = makeDeps({ starredItems, activateStarredItem });

			// Visual order: [starred(0), Alpha(1)]. next from 1 wraps to starred(0).
			cycleSession('next', deps);

			expect(activateStarredItem).toHaveBeenCalledWith(starredItems[0]);
			expect(useSessionStore.getState().cyclePosition).toBe(0);
		});
	});

	// =========================================================================
	// Group sessions
	// =========================================================================
	describe('group sessions', () => {
		it('sessions within a group are sorted alphabetically', () => {
			const grp = makeGroup('grp-1', 'MyGroup');
			const sessC = makeSession({ id: 'c', name: 'Charlie', groupId: 'grp-1' });
			const sessA = makeSession({ id: 'a', name: 'Alice', groupId: 'grp-1' });
			const sessB = makeSession({ id: 'b', name: 'Bob', groupId: 'grp-1' });

			useSessionStore.setState({
				sessions: [sessC, sessA, sessB],
				groups: [grp],
				activeSessionId: 'a',
				cyclePosition: -1,
			} as any);
			useUIStore.setState({
				leftSidebarOpen: true,
				bookmarksCollapsed: true,
			} as any);
			useSettingsStore.setState({ groupChatsExpanded: false } as any);
			useSettingsStore.setState({ ungroupedCollapsed: true } as any);

			const deps = makeDeps();

			// next from Alice → Bob
			cycleSession('next', deps);
			expect(useSessionStore.getState().activeSessionId).toBe('b');

			// next from Bob → Charlie
			cycleSession('next', deps);
			expect(useSessionStore.getState().activeSessionId).toBe('c');
		});

		it('multiple groups are sorted alphabetically between themselves', () => {
			const grpB = makeGroup('grp-b', 'Bees');
			const grpA = makeGroup('grp-a', 'Ants');

			const sessA1 = makeSession({ id: 'a1', name: 'Ant-One', groupId: 'grp-a' });
			const sessB1 = makeSession({ id: 'b1', name: 'Bee-One', groupId: 'grp-b' });

			useSessionStore.setState({
				sessions: [sessB1, sessA1],
				groups: [grpB, grpA], // intentionally unordered
				activeSessionId: 'a1',
				cyclePosition: -1,
			} as any);
			useUIStore.setState({
				leftSidebarOpen: true,
				bookmarksCollapsed: true,
			} as any);
			useSettingsStore.setState({ groupChatsExpanded: false } as any);
			useSettingsStore.setState({ ungroupedCollapsed: true } as any);

			const deps = makeDeps();

			// Visual order: Ants-group [Ant-One], Bees-group [Bee-One]
			// next from Ant-One → Bee-One
			cycleSession('next', deps);
			expect(useSessionStore.getState().activeSessionId).toBe('b1');
		});
	});

	// =========================================================================
	// Collapsed groups are skipped
	// =========================================================================
	describe('collapsed groups are skipped', () => {
		it('sessions in a collapsed group are excluded from the visual order', () => {
			const collapsedGrp = makeGroup('grp-collapsed', 'Hidden', true);
			const openGrp = makeGroup('grp-open', 'Visible', false);

			const sessHidden = makeSession({ id: 'h', name: 'Hidden', groupId: 'grp-collapsed' });
			const sessA = makeSession({ id: 'a', name: 'Alpha', groupId: 'grp-open' });
			const sessB = makeSession({ id: 'b', name: 'Beta', groupId: 'grp-open' });

			useSessionStore.setState({
				sessions: [sessHidden, sessA, sessB],
				groups: [collapsedGrp, openGrp],
				activeSessionId: 'a',
				cyclePosition: -1,
			} as any);
			useUIStore.setState({
				leftSidebarOpen: true,
				bookmarksCollapsed: true,
			} as any);
			useSettingsStore.setState({ groupChatsExpanded: false } as any);
			useSettingsStore.setState({ ungroupedCollapsed: true } as any);

			const deps = makeDeps();

			// Visual order: [Alpha, Beta] (Hidden is in collapsed group → skipped)
			cycleSession('next', deps);
			expect(useSessionStore.getState().activeSessionId).toBe('b');

			// wrap around - Beta → Alpha (not Hidden)
			cycleSession('next', deps);
			expect(useSessionStore.getState().activeSessionId).toBe('a');
		});

		it('all sessions are skipped when all groups are collapsed and ungrouped is collapsed', () => {
			const collapsedGrp = makeGroup('grp-1', 'G1', true);
			const sessA = makeSession({ id: 'a', name: 'Alpha', groupId: 'grp-1' });

			useSessionStore.setState({
				sessions: [sessA],
				groups: [collapsedGrp],
				activeSessionId: 'a',
				cyclePosition: -1,
			} as any);
			useUIStore.setState({
				leftSidebarOpen: true,
				bookmarksCollapsed: true,
			} as any);
			useSettingsStore.setState({ groupChatsExpanded: false } as any);
			useSettingsStore.setState({ ungroupedCollapsed: true } as any);

			const deps = makeDeps();

			cycleSession('next', deps);

			// visual order empty → no-op
			expect(useSessionStore.getState().activeSessionId).toBe('a');
		});
	});

	// =========================================================================
	// Ungrouped collapsed
	// =========================================================================
	describe('ungroupedCollapsed', () => {
		it('ungrouped sessions are skipped when ungroupedCollapsed is true', () => {
			const grp = makeGroup('grp-1', 'Group', false);
			const sessInGroup = makeSession({ id: 'g', name: 'Grouped', groupId: 'grp-1' });
			const sessUngrouped = makeSession({ id: 'u', name: 'Ungrouped' });

			useSessionStore.setState({
				sessions: [sessInGroup, sessUngrouped],
				groups: [grp],
				activeSessionId: 'g',
				cyclePosition: -1,
			} as any);
			useUIStore.setState({
				leftSidebarOpen: true,
				bookmarksCollapsed: true,
			} as any);
			useSettingsStore.setState({ groupChatsExpanded: false } as any);
			useSettingsStore.setState({ ungroupedCollapsed: true } as any);

			const deps = makeDeps();

			// Visual order: [Grouped] only (Ungrouped is hidden)
			// next from Grouped → wraps back to Grouped (single item)
			cycleSession('next', deps);
			expect(useSessionStore.getState().activeSessionId).toBe('g');
		});

		it('ungrouped sessions are included when ungroupedCollapsed is false', () => {
			const grp = makeGroup('grp-1', 'Group', false);
			const sessInGroup = makeSession({ id: 'g', name: 'Grouped', groupId: 'grp-1' });
			const sessUngrouped = makeSession({ id: 'u', name: 'Zed-Ungrouped' });

			useSessionStore.setState({
				sessions: [sessInGroup, sessUngrouped],
				groups: [grp],
				activeSessionId: 'g',
				cyclePosition: -1,
			} as any);
			useUIStore.setState({
				leftSidebarOpen: true,
				bookmarksCollapsed: true,
			} as any);
			useSettingsStore.setState({ groupChatsExpanded: false } as any);
			useSettingsStore.setState({ ungroupedCollapsed: false } as any);

			const deps = makeDeps();

			// Visual order: [Grouped, Zed-Ungrouped]; next from Grouped → Zed-Ungrouped
			cycleSession('next', deps);
			expect(useSessionStore.getState().activeSessionId).toBe('u');
		});
	});

	// =========================================================================
	// Group chat cycling
	// =========================================================================
	describe('group chat cycling', () => {
		it('group chats appear at the end of the visual order when groupChatsExpanded is true', () => {
			const sessA = makeSession({ id: 'a', name: 'Alpha' });
			const gc1 = makeGroupChat('gc-1', 'Chat One');

			useSessionStore.setState({
				sessions: [sessA],
				activeSessionId: 'a',
				cyclePosition: -1,
			} as any);
			useGroupChatStore.setState({
				groupChats: [gc1],
				activeGroupChatId: null,
			} as any);
			useUIStore.setState({
				leftSidebarOpen: true,
				bookmarksCollapsed: true,
			} as any);
			useSettingsStore.setState({ groupChatsExpanded: true } as any);

			const handleOpenGroupChat = vi.fn();
			const deps = makeDeps({ handleOpenGroupChat });

			// Visual order: [Alpha, Chat One]; next from Alpha → Chat One
			cycleSession('next', deps);

			expect(handleOpenGroupChat).toHaveBeenCalledWith('gc-1');
			expect(useSessionStore.getState().cyclePosition).toBe(1);
		});

		it('group chats are sorted alphabetically', () => {
			const sessA = makeSession({ id: 'a', name: 'Alpha' });
			const gcZ = makeGroupChat('gc-z', 'Zebra Chat');
			const gcA = makeGroupChat('gc-a', 'Ant Chat');

			useSessionStore.setState({
				sessions: [sessA],
				activeSessionId: 'a',
				cyclePosition: -1,
			} as any);
			useGroupChatStore.setState({
				groupChats: [gcZ, gcA], // intentionally unordered
				activeGroupChatId: null,
			} as any);
			useUIStore.setState({
				leftSidebarOpen: true,
				bookmarksCollapsed: true,
			} as any);
			useSettingsStore.setState({ groupChatsExpanded: true } as any);

			const handleOpenGroupChat = vi.fn();
			const deps = makeDeps({ handleOpenGroupChat });

			// Visual order: [Alpha(0), Ant Chat(1), Zebra Chat(2)]
			// next from Alpha → Ant Chat
			cycleSession('next', deps);
			expect(handleOpenGroupChat).toHaveBeenCalledWith('gc-a');

			// Simulate Ant Chat now being active
			useGroupChatStore.setState({ activeGroupChatId: 'gc-a' } as any);

			// next from Ant Chat → Zebra Chat
			cycleSession('next', deps);
			expect(handleOpenGroupChat).toHaveBeenCalledWith('gc-z');
		});

		it('group chats are excluded when groupChatsExpanded is false', () => {
			const sessA = makeSession({ id: 'a', name: 'Alpha' });
			const gc1 = makeGroupChat('gc-1', 'Chat One');

			useSessionStore.setState({
				sessions: [sessA],
				activeSessionId: 'a',
				cyclePosition: -1,
			} as any);
			useGroupChatStore.setState({
				groupChats: [gc1],
				activeGroupChatId: null,
			} as any);
			useUIStore.setState({
				leftSidebarOpen: true,
				bookmarksCollapsed: true,
			} as any);
			useSettingsStore.setState({ groupChatsExpanded: false } as any);

			const handleOpenGroupChat = vi.fn();
			const deps = makeDeps({ handleOpenGroupChat });

			// next from Alpha → wraps back to Alpha (only one item)
			cycleSession('next', deps);
			expect(handleOpenGroupChat).not.toHaveBeenCalled();
			expect(useSessionStore.getState().activeSessionId).toBe('a');
		});

		it('group chats are excluded even when groupChatsExpanded is true but list is empty', () => {
			const sessA = makeSession({ id: 'a', name: 'Alpha' });

			useSessionStore.setState({
				sessions: [sessA],
				activeSessionId: 'a',
				cyclePosition: -1,
			} as any);
			useGroupChatStore.setState({
				groupChats: [], // empty
				activeGroupChatId: null,
			} as any);
			useUIStore.setState({
				leftSidebarOpen: true,
				bookmarksCollapsed: true,
			} as any);
			useSettingsStore.setState({ groupChatsExpanded: true } as any);

			const handleOpenGroupChat = vi.fn();
			const deps = makeDeps({ handleOpenGroupChat });

			cycleSession('next', deps);

			expect(handleOpenGroupChat).not.toHaveBeenCalled();
			// Single item → wraps back to itself
			expect(useSessionStore.getState().activeSessionId).toBe('a');
		});

		it('can cycle from a group chat back to a session', () => {
			const sessA = makeSession({ id: 'a', name: 'Alpha' });
			const gc1 = makeGroupChat('gc-1', 'Chat One');

			useSessionStore.setState({
				sessions: [sessA],
				activeSessionId: 'a',
				cyclePosition: -1,
			} as any);
			useGroupChatStore.setState({
				groupChats: [gc1],
				activeGroupChatId: 'gc-1',
			} as any);
			useUIStore.setState({
				leftSidebarOpen: true,
				bookmarksCollapsed: true,
			} as any);
			useSettingsStore.setState({ groupChatsExpanded: true } as any);

			// cyclePosition=1 means we are on the group chat slot
			useSessionStore.setState({ cyclePosition: 1 } as any);

			const handleOpenGroupChat = vi.fn();
			const deps = makeDeps({ handleOpenGroupChat });

			// next from Chat One(1) → wraps to Alpha(0)
			cycleSession('next', deps);

			expect(useSessionStore.getState().activeSessionId).toBe('a');
			expect(handleOpenGroupChat).not.toHaveBeenCalled();
		});

		it('archived group chats are skipped during cycling', () => {
			const sessA = makeSession({ id: 'a', name: 'Alpha' });
			const gcActive = makeGroupChat('gc-active', 'Active Chat');
			const gcArchived = { ...makeGroupChat('gc-archived', 'Archived Chat'), archived: true };

			useSessionStore.setState({
				sessions: [sessA],
				activeSessionId: 'a',
				cyclePosition: -1,
			} as any);
			useGroupChatStore.setState({
				groupChats: [gcActive, gcArchived],
				activeGroupChatId: null,
			} as any);
			useUIStore.setState({
				leftSidebarOpen: true,
				bookmarksCollapsed: true,
			} as any);
			useSettingsStore.setState({ groupChatsExpanded: true } as any);

			const handleOpenGroupChat = vi.fn();
			const deps = makeDeps({ handleOpenGroupChat });

			// Visual order: [Alpha(0), Active Chat(1)] - Archived Chat excluded
			// next from Alpha → Active Chat
			cycleSession('next', deps);
			expect(handleOpenGroupChat).toHaveBeenCalledWith('gc-active');

			// Simulate being on Active Chat
			useGroupChatStore.setState({ activeGroupChatId: 'gc-active' } as any);
			useSessionStore.setState({ cyclePosition: 1 } as any);

			// next from Active Chat → wraps to Alpha (skips archived)
			cycleSession('next', deps);
			expect(useSessionStore.getState().activeSessionId).toBe('a');
		});
	});

	// =========================================================================
	// Sidebar collapsed - uses sortedSessions from deps
	// =========================================================================
	describe('sidebar collapsed', () => {
		it('uses sortedSessions from deps when sidebar is closed', () => {
			const sessA = makeSession({ id: 'a', name: 'Alpha' });
			const sessB = makeSession({ id: 'b', name: 'Beta' });
			const sessC = makeSession({ id: 'c', name: 'Gamma' });

			useSessionStore.setState({
				sessions: [sessA, sessB, sessC],
				activeSessionId: 'a',
				cyclePosition: -1,
			} as any);
			useUIStore.setState({
				leftSidebarOpen: false,
				bookmarksCollapsed: true,
			} as any);
			useSettingsStore.setState({ groupChatsExpanded: true } as any);

			// sortedSessions provided by deps in a specific custom order
			const deps = makeDeps({ sortedSessions: [sessC, sessB, sessA] });

			// Visual order when sidebar closed = sortedSessions order: [Gamma, Beta, Alpha]
			// Active is 'a' (Alpha at index 2), next → wraps to Gamma(0)
			cycleSession('next', deps);
			expect(useSessionStore.getState().activeSessionId).toBe('c');
		});

		it('does not include group chats when sidebar is closed', () => {
			const sessA = makeSession({ id: 'a', name: 'Alpha' });
			const gc1 = makeGroupChat('gc-1', 'Chat One');

			useSessionStore.setState({
				sessions: [sessA],
				activeSessionId: 'a',
				cyclePosition: -1,
			} as any);
			useGroupChatStore.setState({
				groupChats: [gc1],
				activeGroupChatId: null,
			} as any);
			useUIStore.setState({
				leftSidebarOpen: false,
				bookmarksCollapsed: false,
			} as any);
			useSettingsStore.setState({ groupChatsExpanded: true } as any);

			const handleOpenGroupChat = vi.fn();
			const deps = makeDeps({ sortedSessions: [sessA], handleOpenGroupChat });

			// Visual order = [Alpha] only; next → wraps to Alpha
			cycleSession('next', deps);
			expect(handleOpenGroupChat).not.toHaveBeenCalled();
			expect(useSessionStore.getState().activeSessionId).toBe('a');
		});
	});

	// =========================================================================
	// Current item not visible - selects first visible item
	// =========================================================================
	describe('current item not visible', () => {
		it('selects first visible item when active session is not in visual order', () => {
			// Active session is in a collapsed group → not in visual order
			const collapsedGrp = makeGroup('grp-hidden', 'Hidden', true);
			const openGrp = makeGroup('grp-open', 'Open', false);

			const sessHidden = makeSession({
				id: 'hidden',
				name: 'Hidden',
				groupId: 'grp-hidden',
			});
			const sessFirst = makeSession({ id: 'first', name: 'First', groupId: 'grp-open' });
			const sessSecond = makeSession({ id: 'second', name: 'Second', groupId: 'grp-open' });

			useSessionStore.setState({
				sessions: [sessHidden, sessFirst, sessSecond],
				groups: [collapsedGrp, openGrp],
				activeSessionId: 'hidden',
				cyclePosition: -1,
			} as any);
			useUIStore.setState({
				leftSidebarOpen: true,
				bookmarksCollapsed: true,
			} as any);
			useSettingsStore.setState({ groupChatsExpanded: false } as any);
			useSettingsStore.setState({ ungroupedCollapsed: true } as any);

			const deps = makeDeps();

			cycleSession('next', deps);

			// Since 'hidden' is not in visual order, first item 'first' is selected
			expect(useSessionStore.getState().activeSessionId).toBe('first');
			expect(useSessionStore.getState().cyclePosition).toBe(0);
		});

		it('selects first group chat item when it is the only visible item and session is not visible', () => {
			// Only group chat in visual order; session is in a collapsed group
			const collapsedGrp = makeGroup('grp-1', 'G1', true);
			const sessHidden = makeSession({ id: 'h', name: 'Hidden', groupId: 'grp-1' });
			const gc1 = makeGroupChat('gc-1', 'Chat One');

			useSessionStore.setState({
				sessions: [sessHidden],
				groups: [collapsedGrp],
				activeSessionId: 'h',
				cyclePosition: -1,
			} as any);
			useGroupChatStore.setState({
				groupChats: [gc1],
				activeGroupChatId: null,
			} as any);
			useUIStore.setState({
				leftSidebarOpen: true,
				bookmarksCollapsed: true,
			} as any);
			useSettingsStore.setState({ groupChatsExpanded: true } as any);
			useSettingsStore.setState({ ungroupedCollapsed: true } as any);

			const handleOpenGroupChat = vi.fn();
			const deps = makeDeps({ handleOpenGroupChat });

			cycleSession('next', deps);

			expect(handleOpenGroupChat).toHaveBeenCalledWith('gc-1');
			expect(useSessionStore.getState().cyclePosition).toBe(0);
		});

		it('selects first item on prev when active session is invisible', () => {
			const sessA = makeSession({ id: 'a', name: 'Alpha' });
			const sessB = makeSession({ id: 'b', name: 'Beta' });

			// Suppose 'invisible' is active but not in any expanded section
			useSessionStore.setState({
				sessions: [sessA, sessB],
				groups: [],
				activeSessionId: 'invisible',
				cyclePosition: -1,
			} as any);
			useUIStore.setState({
				leftSidebarOpen: true,
				bookmarksCollapsed: true,
			} as any);
			useSettingsStore.setState({ groupChatsExpanded: false } as any);

			const deps = makeDeps();

			cycleSession('prev', deps);

			// First item alphabetically is Alpha
			expect(useSessionStore.getState().activeSessionId).toBe('a');
			expect(useSessionStore.getState().cyclePosition).toBe(0);
		});
	});

	// =========================================================================
	// Worktree children
	// =========================================================================
	describe('worktree children', () => {
		it('includes worktree children when parent worktreesExpanded is not false', () => {
			// worktreesExpanded=undefined counts as expanded (truthy)
			const parent = makeSession({ id: 'p', name: 'Parent', worktreesExpanded: undefined });
			const child1 = makeSession({
				id: 'c1',
				name: 'Child One',
				parentSessionId: 'p',
				worktreeBranch: 'branch-a',
			});
			const child2 = makeSession({
				id: 'c2',
				name: 'Child Two',
				parentSessionId: 'p',
				worktreeBranch: 'branch-b',
			});

			useSessionStore.setState({
				sessions: [parent, child2, child1], // intentionally unordered children
				activeSessionId: 'p',
				cyclePosition: -1,
			} as any);
			useUIStore.setState({
				leftSidebarOpen: true,
				bookmarksCollapsed: true,
			} as any);
			useSettingsStore.setState({ groupChatsExpanded: false } as any);

			const deps = makeDeps();

			// Visual order: [Parent, Child-branch-a(c1), Child-branch-b(c2)]
			// next from Parent → c1
			cycleSession('next', deps);
			expect(useSessionStore.getState().activeSessionId).toBe('c1');

			// next from c1 → c2
			cycleSession('next', deps);
			expect(useSessionStore.getState().activeSessionId).toBe('c2');
		});

		it('includes worktree children when parent worktreesExpanded is true', () => {
			const parent = makeSession({ id: 'p', name: 'Parent', worktreesExpanded: true });
			const child = makeSession({
				id: 'c',
				name: 'Child',
				parentSessionId: 'p',
				worktreeBranch: 'feature',
			});

			useSessionStore.setState({
				sessions: [parent, child],
				activeSessionId: 'p',
				cyclePosition: -1,
			} as any);
			useUIStore.setState({
				leftSidebarOpen: true,
				bookmarksCollapsed: true,
			} as any);
			useSettingsStore.setState({ groupChatsExpanded: false } as any);

			const deps = makeDeps();

			cycleSession('next', deps);
			expect(useSessionStore.getState().activeSessionId).toBe('c');
		});

		it('excludes worktree children when parent worktreesExpanded is false', () => {
			const parent = makeSession({ id: 'p', name: 'Parent', worktreesExpanded: false });
			const child = makeSession({
				id: 'c',
				name: 'Child',
				parentSessionId: 'p',
				worktreeBranch: 'feature',
			});
			const sessB = makeSession({ id: 'b', name: 'Beta' });

			useSessionStore.setState({
				sessions: [parent, child, sessB],
				activeSessionId: 'p',
				cyclePosition: -1,
			} as any);
			useUIStore.setState({
				leftSidebarOpen: true,
				bookmarksCollapsed: true,
			} as any);
			useSettingsStore.setState({ groupChatsExpanded: false } as any);

			const deps = makeDeps();

			// Visual order: [Beta, Parent] - child is excluded, parent is ungrouped
			// Active = 'p' (Parent, index 1), next → wraps to Beta(0)
			cycleSession('next', deps);
			expect(useSessionStore.getState().activeSessionId).toBe('b');
		});

		it('worktree children are sorted by display name, not branch name', () => {
			// Cycling order must match the visible Left Bar order. SessionItem renders
			// `session.name` as the primary label, so cycling sorts by name and ignores
			// `worktreeBranch` (which is only a subtitle and would otherwise make Cmd+Shift+[/]
			// bounce around relative to what the user sees).
			const parent = makeSession({ id: 'p', name: 'Parent', worktreesExpanded: true });
			const childZ = makeSession({
				id: 'cz',
				name: 'zebra-agent',
				parentSessionId: 'p',
				worktreeBranch: 'aaa-branch',
			});
			const childA = makeSession({
				id: 'ca',
				name: 'apple-agent',
				parentSessionId: 'p',
				worktreeBranch: 'zzz-branch',
			});

			useSessionStore.setState({
				sessions: [parent, childZ, childA],
				activeSessionId: 'p',
				cyclePosition: -1,
			} as any);
			useUIStore.setState({
				leftSidebarOpen: true,
				bookmarksCollapsed: true,
			} as any);
			useSettingsStore.setState({ groupChatsExpanded: false } as any);

			const deps = makeDeps();

			// Visual order by name: [Parent, apple-agent(ca), zebra-agent(cz)]
			// next from Parent → ca (apple-agent comes first alphabetically by name)
			cycleSession('next', deps);
			expect(useSessionStore.getState().activeSessionId).toBe('ca');

			// next from ca → cz (zebra-agent)
			cycleSession('next', deps);
			expect(useSessionStore.getState().activeSessionId).toBe('cz');
		});

		it('worktree child sessions do not appear as top-level entries', () => {
			// The parent-child model should not add the child at the ungrouped level separately
			const parent = makeSession({ id: 'p', name: 'Parent', worktreesExpanded: true });
			const child = makeSession({
				id: 'c',
				name: 'Child',
				parentSessionId: 'p',
				worktreeBranch: 'feature',
			});

			useSessionStore.setState({
				sessions: [parent, child],
				activeSessionId: 'c',
				cyclePosition: -1,
			} as any);
			useUIStore.setState({
				leftSidebarOpen: true,
				bookmarksCollapsed: true,
			} as any);
			useSettingsStore.setState({ groupChatsExpanded: false } as any);

			const deps = makeDeps();

			// Visual order: [Parent(0), child(1)] - child appears once, under parent
			// Active = c (index 1); next → wraps to Parent(0)
			cycleSession('next', deps);
			expect(useSessionStore.getState().activeSessionId).toBe('p');
			expect(useSessionStore.getState().cyclePosition).toBe(0);
		});
	});

	// =========================================================================
	// Position tracking via cyclePosition
	// =========================================================================
	describe('cyclePosition tracking', () => {
		it('updates cyclePosition to the index of the next item', () => {
			const sessA = makeSession({ id: 'a', name: 'Alpha' });
			const sessB = makeSession({ id: 'b', name: 'Beta' });
			const sessC = makeSession({ id: 'c', name: 'Gamma' });

			useSessionStore.setState({
				sessions: [sessA, sessB, sessC],
				activeSessionId: 'a',
				cyclePosition: -1,
			} as any);
			useUIStore.setState({
				leftSidebarOpen: true,
				bookmarksCollapsed: true,
			} as any);
			useSettingsStore.setState({ groupChatsExpanded: false } as any);

			const deps = makeDeps();

			cycleSession('next', deps);
			expect(useSessionStore.getState().cyclePosition).toBe(1); // Beta at index 1

			cycleSession('next', deps);
			expect(useSessionStore.getState().cyclePosition).toBe(2); // Gamma at index 2

			// Wrap around
			cycleSession('next', deps);
			expect(useSessionStore.getState().cyclePosition).toBe(0); // Alpha at index 0
		});

		it('uses stored cyclePosition when it is still valid', () => {
			// Visual order: [Alpha(0), Beta(1), Gamma(2)]
			// Suppose we are on Beta and cyclePosition=1 is stored
			const sessA = makeSession({ id: 'a', name: 'Alpha' });
			const sessB = makeSession({ id: 'b', name: 'Beta' });
			const sessC = makeSession({ id: 'c', name: 'Gamma' });

			useSessionStore.setState({
				sessions: [sessA, sessB, sessC],
				activeSessionId: 'b',
				cyclePosition: 1, // valid: index 1 is 'b'
			} as any);
			useUIStore.setState({
				leftSidebarOpen: true,
				bookmarksCollapsed: true,
			} as any);
			useSettingsStore.setState({ groupChatsExpanded: false } as any);

			const deps = makeDeps();

			cycleSession('next', deps);
			// Uses stored position 1 → next is Gamma at index 2
			expect(useSessionStore.getState().activeSessionId).toBe('c');
			expect(useSessionStore.getState().cyclePosition).toBe(2);
		});

		it('resets cyclePosition lookup when stored position does not match active item', () => {
			// cyclePosition=1 but item at index 1 does not match activeSessionId='a'
			const sessA = makeSession({ id: 'a', name: 'Alpha' });
			const sessB = makeSession({ id: 'b', name: 'Beta' });
			const sessC = makeSession({ id: 'c', name: 'Gamma' });

			useSessionStore.setState({
				sessions: [sessA, sessB, sessC],
				activeSessionId: 'a', // Alpha is at index 0, not 1
				cyclePosition: 1, // stale
			} as any);
			useUIStore.setState({
				leftSidebarOpen: true,
				bookmarksCollapsed: true,
			} as any);
			useSettingsStore.setState({ groupChatsExpanded: false } as any);

			const deps = makeDeps();

			cycleSession('next', deps);
			// Falls back to findIndex - Alpha found at 0 → next is Beta at 1
			expect(useSessionStore.getState().activeSessionId).toBe('b');
			expect(useSessionStore.getState().cyclePosition).toBe(1);
		});

		it('handles cyclePosition that is out of bounds', () => {
			const sessA = makeSession({ id: 'a', name: 'Alpha' });
			const sessB = makeSession({ id: 'b', name: 'Beta' });

			useSessionStore.setState({
				sessions: [sessA, sessB],
				activeSessionId: 'a',
				cyclePosition: 99, // out of bounds
			} as any);
			useUIStore.setState({
				leftSidebarOpen: true,
				bookmarksCollapsed: true,
			} as any);
			useSettingsStore.setState({ groupChatsExpanded: false } as any);

			const deps = makeDeps();

			cycleSession('next', deps);
			// Falls back to findIndex - Alpha at 0, next is Beta at 1
			expect(useSessionStore.getState().activeSessionId).toBe('b');
			expect(useSessionStore.getState().cyclePosition).toBe(1);
		});

		it('prev cycling sets cyclePosition to previous index', () => {
			const sessA = makeSession({ id: 'a', name: 'Alpha' });
			const sessB = makeSession({ id: 'b', name: 'Beta' });
			const sessC = makeSession({ id: 'c', name: 'Gamma' });

			useSessionStore.setState({
				sessions: [sessA, sessB, sessC],
				activeSessionId: 'c',
				cyclePosition: -1,
			} as any);
			useUIStore.setState({
				leftSidebarOpen: true,
				bookmarksCollapsed: true,
			} as any);
			useSettingsStore.setState({ groupChatsExpanded: false } as any);

			const deps = makeDeps();

			cycleSession('prev', deps);
			// Gamma(2) → Beta(1)
			expect(useSessionStore.getState().cyclePosition).toBe(1);
		});
	});

	// =========================================================================
	// setActiveGroupChatId is cleared when switching to a session
	// =========================================================================
	describe('group chat to session transition', () => {
		it('clears activeGroupChatId when cycling to a session', () => {
			const sessA = makeSession({ id: 'a', name: 'Alpha' });
			const gc1 = makeGroupChat('gc-1', 'Chat One');

			useSessionStore.setState({
				sessions: [sessA],
				activeSessionId: '',
				cyclePosition: 1, // currently on group chat slot
			} as any);
			useGroupChatStore.setState({
				groupChats: [gc1],
				activeGroupChatId: 'gc-1',
			} as any);
			useUIStore.setState({
				leftSidebarOpen: true,
				bookmarksCollapsed: true,
			} as any);
			useSettingsStore.setState({ groupChatsExpanded: true } as any);

			const deps = makeDeps();

			// Visual order: [Alpha(0), Chat One(1)]
			// Active on Chat One (index 1), next → wraps to Alpha(0)
			cycleSession('next', deps);

			expect(useSessionStore.getState().activeSessionId).toBe('a');
			expect(useGroupChatStore.getState().activeGroupChatId).toBeNull();
		});
	});

	// =========================================================================
	// Single-item edge cases
	// =========================================================================
	describe('single item', () => {
		it('single session cycles to itself on next', () => {
			const sessA = makeSession({ id: 'a', name: 'Alpha' });

			useSessionStore.setState({
				sessions: [sessA],
				activeSessionId: 'a',
				cyclePosition: -1,
			} as any);
			useUIStore.setState({
				leftSidebarOpen: true,
				bookmarksCollapsed: true,
			} as any);
			useSettingsStore.setState({ groupChatsExpanded: false } as any);

			const deps = makeDeps();

			cycleSession('next', deps);

			expect(useSessionStore.getState().activeSessionId).toBe('a');
			expect(useSessionStore.getState().cyclePosition).toBe(0);
		});

		it('single session cycles to itself on prev', () => {
			const sessA = makeSession({ id: 'a', name: 'Alpha' });

			useSessionStore.setState({
				sessions: [sessA],
				activeSessionId: 'a',
				cyclePosition: -1,
			} as any);
			useUIStore.setState({
				leftSidebarOpen: true,
				bookmarksCollapsed: true,
			} as any);
			useSettingsStore.setState({ groupChatsExpanded: false } as any);

			const deps = makeDeps();

			cycleSession('prev', deps);

			expect(useSessionStore.getState().activeSessionId).toBe('a');
			expect(useSessionStore.getState().cyclePosition).toBe(0);
		});
	});

	// =========================================================================
	// Unread filter - showUnreadAgentsOnly restricts cycling
	// =========================================================================
	describe('unread agents filter', () => {
		it('cycles only through unread sessions when filter is active', () => {
			const sessA = makeSession({ id: 'a', name: 'Alpha', aiTabs: [{ hasUnread: true }] as any });
			const sessB = makeSession({ id: 'b', name: 'Beta' }); // no unread
			const sessC = makeSession({ id: 'c', name: 'Gamma', aiTabs: [{ hasUnread: true }] as any });

			useSessionStore.setState({
				sessions: [sessA, sessB, sessC],
				activeSessionId: 'a',
				cyclePosition: -1,
			} as any);
			useUIStore.setState({
				leftSidebarOpen: true,
				bookmarksCollapsed: true,
				showUnreadAgentsOnly: true,
			} as any);
			useSettingsStore.setState({ groupChatsExpanded: false } as any);

			const deps = makeDeps();

			cycleSession('next', deps);

			// Alpha → Gamma (skips Beta which has no unread)
			expect(useSessionStore.getState().activeSessionId).toBe('c');
		});

		it('includes busy sessions even if not unread', () => {
			const sessA = makeSession({ id: 'a', name: 'Alpha', aiTabs: [{ hasUnread: true }] as any });
			const sessB = makeSession({ id: 'b', name: 'Beta', state: 'busy' });
			const sessC = makeSession({ id: 'c', name: 'Gamma' }); // neither unread nor busy

			useSessionStore.setState({
				sessions: [sessA, sessB, sessC],
				activeSessionId: 'a',
				cyclePosition: -1,
			} as any);
			useUIStore.setState({
				leftSidebarOpen: true,
				bookmarksCollapsed: true,
				showUnreadAgentsOnly: true,
			} as any);
			useSettingsStore.setState({ groupChatsExpanded: false } as any);

			const deps = makeDeps();

			cycleSession('next', deps);

			// Alpha → Beta (busy counts as visible)
			expect(useSessionStore.getState().activeSessionId).toBe('b');
		});

		it('always includes the currently active session in the cycle list', () => {
			// Active session 'a' is not unread but should still appear in the filtered
			// cycle list so the user can cycle away from it (rather than being stuck).
			const sessA = makeSession({ id: 'a', name: 'Alpha' }); // not unread, but active
			const sessB = makeSession({ id: 'b', name: 'Beta', aiTabs: [{ hasUnread: true }] as any });
			const sessC = makeSession({ id: 'c', name: 'Gamma', aiTabs: [{ hasUnread: true }] as any });

			useSessionStore.setState({
				sessions: [sessA, sessB, sessC],
				activeSessionId: 'a',
				cyclePosition: -1,
			} as any);
			useUIStore.setState({
				leftSidebarOpen: true,
				bookmarksCollapsed: true,
				showUnreadAgentsOnly: true,
			} as any);
			useSettingsStore.setState({ groupChatsExpanded: false } as any);

			const deps = makeDeps();

			// 'a' is active (not unread) → included. Filtered list: [a, b, c]
			cycleSession('next', deps);
			expect(useSessionStore.getState().activeSessionId).toBe('b');
		});

		it('wraps around within filtered sessions', () => {
			const sessA = makeSession({ id: 'a', name: 'Alpha', aiTabs: [{ hasUnread: true }] as any });
			const sessB = makeSession({ id: 'b', name: 'Beta' });
			const sessC = makeSession({ id: 'c', name: 'Gamma', aiTabs: [{ hasUnread: true }] as any });

			useSessionStore.setState({
				sessions: [sessA, sessB, sessC],
				activeSessionId: 'c',
				cyclePosition: -1,
			} as any);
			useUIStore.setState({
				leftSidebarOpen: true,
				bookmarksCollapsed: true,
				showUnreadAgentsOnly: true,
			} as any);
			useSettingsStore.setState({ groupChatsExpanded: false } as any);

			const deps = makeDeps();

			cycleSession('next', deps);

			// Gamma is last unread → wraps to Alpha (active Gamma + unread Alpha + unread Gamma)
			expect(useSessionStore.getState().activeSessionId).toBe('a');
		});

		it('includes parent when worktree child has unread', () => {
			const parent = makeSession({ id: 'p', name: 'Parent' }); // no unread itself
			const child = makeSession({
				id: 'child1',
				name: 'Child',
				parentSessionId: 'p',
				worktreeBranch: 'feat',
				aiTabs: [{ hasUnread: true }] as any,
			});
			const other = makeSession({ id: 'o', name: 'Other', aiTabs: [{ hasUnread: true }] as any });

			useSessionStore.setState({
				sessions: [parent, child, other],
				activeSessionId: 'o',
				cyclePosition: -1,
			} as any);
			useUIStore.setState({
				leftSidebarOpen: true,
				bookmarksCollapsed: true,
				showUnreadAgentsOnly: true,
			} as any);
			useSettingsStore.setState({ groupChatsExpanded: false } as any);

			const deps = makeDeps();

			cycleSession('next', deps);

			// Other → Parent (parent included because child has unread)
			expect(useSessionStore.getState().activeSessionId).toBe('p');
		});

		it('does not filter when showUnreadAgentsOnly is false', () => {
			const sessA = makeSession({ id: 'a', name: 'Alpha' });
			const sessB = makeSession({ id: 'b', name: 'Beta' });

			useSessionStore.setState({
				sessions: [sessA, sessB],
				activeSessionId: 'a',
				cyclePosition: -1,
			} as any);
			useUIStore.setState({
				leftSidebarOpen: true,
				bookmarksCollapsed: true,
				showUnreadAgentsOnly: false,
			} as any);
			useSettingsStore.setState({ groupChatsExpanded: false } as any);

			const deps = makeDeps();

			cycleSession('next', deps);

			// All sessions visible - Alpha → Beta
			expect(useSessionStore.getState().activeSessionId).toBe('b');
		});
		it('includes auto-running (batch) sessions even if not unread', () => {
			const sessA = createMockSession({
				id: 'a',
				name: 'Alpha',
				aiTabs: [createMockAITab({ hasUnread: true })],
			});
			const sessB = createMockSession({ id: 'b', name: 'Beta' }); // idle, but auto-running
			const sessC = createMockSession({ id: 'c', name: 'Gamma' }); // neither

			useSessionStore.setState({
				sessions: [sessA, sessB, sessC],
				activeSessionId: 'a',
				cyclePosition: -1,
			});
			useUIStore.setState({
				leftSidebarOpen: true,
				bookmarksCollapsed: true,
				showUnreadAgentsOnly: true,
			});
			useSettingsStore.setState({ groupChatsExpanded: false });

			const deps = makeDeps({ batchSessionIds: new Set(['b']) });

			cycleSession('next', deps);

			// Alpha -> Beta (auto-running counts as visible); Gamma skipped.
			expect(useSessionStore.getState().activeSessionId).toBe('b');
		});

		it('includes stuck (outage) sessions even if not unread', () => {
			const sessA = createMockSession({
				id: 'a',
				name: 'Alpha',
				aiTabs: [createMockAITab({ hasUnread: true })],
			});
			const sessB = createMockSession({ id: 'b', name: 'Beta' }); // idle, but stuck
			const sessC = createMockSession({ id: 'c', name: 'Gamma' }); // neither

			useSessionStore.setState({
				sessions: [sessA, sessB, sessC],
				activeSessionId: 'a',
				cyclePosition: -1,
			});
			useUIStore.setState({
				leftSidebarOpen: true,
				bookmarksCollapsed: true,
				showUnreadAgentsOnly: true,
			});
			useSettingsStore.setState({ groupChatsExpanded: false });

			const deps = makeDeps({ stuckOutageIds: new Set(['b']) });

			cycleSession('next', deps);

			// Alpha -> Beta (stuck counts as visible); Gamma skipped.
			expect(useSessionStore.getState().activeSessionId).toBe('b');
		});

		it('includes parent when a worktree child is auto-running a batch', () => {
			const parent = createMockSession({ id: 'p', name: 'Parent' }); // idle itself
			const child = createMockSession({
				id: 'child1',
				name: 'Child',
				parentSessionId: 'p',
				worktreeBranch: 'feat',
			});
			const other = createMockSession({
				id: 'o',
				name: 'Other',
				aiTabs: [createMockAITab({ hasUnread: true })],
			});

			useSessionStore.setState({
				sessions: [parent, child, other],
				activeSessionId: 'o',
				cyclePosition: -1,
			});
			useUIStore.setState({
				leftSidebarOpen: true,
				bookmarksCollapsed: true,
				showUnreadAgentsOnly: true,
			});
			useSettingsStore.setState({ groupChatsExpanded: false });

			const deps = makeDeps({ batchSessionIds: new Set(['child1']) });

			cycleSession('next', deps);

			// Other -> Parent (parent kept because its worktree child is auto-running).
			expect(useSessionStore.getState().activeSessionId).toBe('p');
		});

		it('reads auto-running sessions from batchStore when no deps override is given', () => {
			const sessA = createMockSession({
				id: 'a',
				name: 'Alpha',
				aiTabs: [createMockAITab({ hasUnread: true })],
			});
			const sessB = createMockSession({ id: 'b', name: 'Beta' });
			const sessC = createMockSession({ id: 'c', name: 'Gamma' });

			useSessionStore.setState({
				sessions: [sessA, sessB, sessC],
				activeSessionId: 'a',
				cyclePosition: -1,
			});
			useUIStore.setState({
				leftSidebarOpen: true,
				bookmarksCollapsed: true,
				showUnreadAgentsOnly: true,
			});
			useSettingsStore.setState({ groupChatsExpanded: false });
			useBatchStore.setState({
				batchRunStates: { b: { ...DEFAULT_BATCH_STATE, isRunning: true } },
			});

			const deps = makeDeps(); // no override -> event-time batchStore read

			cycleSession('next', deps);

			// Alpha -> Beta (batchStore marks 'b' auto-running); Gamma skipped.
			expect(useSessionStore.getState().activeSessionId).toBe('b');
		});

		it('reads stuck sessions from retryStore when no deps override is given', () => {
			const sessA = createMockSession({
				id: 'a',
				name: 'Alpha',
				aiTabs: [createMockAITab({ hasUnread: true })],
			});
			const sessB = createMockSession({ id: 'b', name: 'Beta' });
			const sessC = createMockSession({ id: 'c', name: 'Gamma' });

			useSessionStore.setState({
				sessions: [sessA, sessB, sessC],
				activeSessionId: 'a',
				cyclePosition: -1,
			});
			useUIStore.setState({
				leftSidebarOpen: true,
				bookmarksCollapsed: true,
				showUnreadAgentsOnly: true,
			});
			useSettingsStore.setState({ groupChatsExpanded: false });
			useRetryStore.getState().patchOutage('outage-b', { sessionId: 'b', status: 'active' });

			const deps = makeDeps(); // no override -> event-time retryStore read

			cycleSession('next', deps);

			// Alpha -> Beta (retryStore marks 'b' stuck); Gamma skipped.
			expect(useSessionStore.getState().activeSessionId).toBe('b');
		});
	});

	// =========================================================================
	// Window scoping (multi-window) - ownsSession predicate restricts cycling
	// to agents THIS window owns, never jumping to an agent another window
	// surfaces. Group chats are not window-owned, so they stay in the cycle.
	// =========================================================================
	describe('window scoping (multi-window)', () => {
		/** Predicate that owns only the listed agent ids (everything else lives elsewhere). */
		const ownsOnly =
			(...ids: string[]) =>
			(id: string) =>
				ids.includes(id);

		it('includes every session when no ownsSession predicate is provided (single-window default)', () => {
			const sessA = makeSession({ id: 'a', name: 'Alpha' });
			const sessB = makeSession({ id: 'b', name: 'Beta' });

			useSessionStore.setState({
				sessions: [sessA, sessB],
				activeSessionId: 'a',
				cyclePosition: -1,
			} as any);
			useUIStore.setState({ leftSidebarOpen: true, bookmarksCollapsed: true } as any);
			useSettingsStore.setState({ groupChatsExpanded: false } as any);

			// No ownsSession in deps → unscoped, behaves exactly as before.
			const deps = makeDeps();

			cycleSession('next', deps);
			expect(useSessionStore.getState().activeSessionId).toBe('b');
		});

		it('cycles only through agents this window owns, skipping agents owned by other windows', () => {
			const sessA = makeSession({ id: 'a', name: 'Alpha' });
			const sessB = makeSession({ id: 'b', name: 'Beta' }); // owned by ANOTHER window
			const sessC = makeSession({ id: 'c', name: 'Gamma' });

			useSessionStore.setState({
				sessions: [sessA, sessB, sessC],
				activeSessionId: 'a',
				cyclePosition: -1,
			} as any);
			useUIStore.setState({ leftSidebarOpen: true, bookmarksCollapsed: true } as any);
			useSettingsStore.setState({ groupChatsExpanded: false } as any);

			// This window owns Alpha and Gamma, but NOT Beta.
			const deps = makeDeps({ ownsSession: ownsOnly('a', 'c') });

			// Scoped visual order: [Alpha, Gamma] - Beta is dropped.
			cycleSession('next', deps);
			expect(useSessionStore.getState().activeSessionId).toBe('c');

			// prev from Gamma → Alpha (still skipping Beta).
			cycleSession('prev', deps);
			expect(useSessionStore.getState().activeSessionId).toBe('a');
		});

		it('keeps group chats in the cycle even when the ownsSession predicate would exclude them', () => {
			const sessA = makeSession({ id: 'a', name: 'Alpha' });
			const gc1 = makeGroupChat('gc-1', 'Chat One');

			useSessionStore.setState({
				sessions: [sessA],
				activeSessionId: 'a',
				cyclePosition: -1,
			} as any);
			useGroupChatStore.setState({ groupChats: [gc1], activeGroupChatId: null } as any);
			useUIStore.setState({ leftSidebarOpen: true, bookmarksCollapsed: true } as any);
			useSettingsStore.setState({ groupChatsExpanded: true } as any);

			const handleOpenGroupChat = vi.fn();
			// Predicate owns only Alpha; it would return false for the group chat id, but
			// group chats are not window-owned agents and must stay in the cycle.
			const deps = makeDeps({ handleOpenGroupChat, ownsSession: ownsOnly('a') });

			// Visual order: [Alpha, Chat One]; next from Alpha → Chat One.
			cycleSession('next', deps);
			expect(handleOpenGroupChat).toHaveBeenCalledWith('gc-1');
		});

		it('drops worktree children owned by another window', () => {
			const parent = makeSession({ id: 'p', name: 'Parent', worktreesExpanded: true });
			const child = makeSession({
				id: 'c',
				name: 'Child',
				parentSessionId: 'p',
				worktreeBranch: 'feature',
			}); // child lives in ANOTHER window
			const sessZ = makeSession({ id: 'z', name: 'Zed' });

			useSessionStore.setState({
				sessions: [parent, child, sessZ],
				activeSessionId: 'p',
				cyclePosition: -1,
			} as any);
			useUIStore.setState({ leftSidebarOpen: true, bookmarksCollapsed: true } as any);
			useSettingsStore.setState({ groupChatsExpanded: false } as any);

			// This window owns Parent and Zed, but not the worktree child.
			const deps = makeDeps({ ownsSession: ownsOnly('p', 'z') });

			// Unscoped order: [Parent, Child, Zed]; scoped drops Child → [Parent, Zed].
			// next from Parent → Zed (the child is skipped).
			cycleSession('next', deps);
			expect(useSessionStore.getState().activeSessionId).toBe('z');
		});

		it('drops starred rows whose parent agent is owned by another window', () => {
			const sessA = makeSession({ id: 'a', name: 'Alpha' });
			const sessC = makeSession({ id: 'c', name: 'Gamma' });
			// Starred row points at agent 'x', which lives in another window.
			const starredItems = [makeOpenStarred('x', 't1', 'Star X')];

			useSessionStore.setState({
				sessions: [sessA, sessC],
				activeSessionId: 'a',
				cyclePosition: -1,
			} as any);
			useUIStore.setState({ leftSidebarOpen: true, bookmarksCollapsed: true } as any);
			useSettingsStore.setState({
				groupChatsExpanded: false,
				starredSessionsCollapsed: false,
			} as any);

			const activateStarredItem = vi.fn();
			// Owns Alpha and Gamma, but not the starred row's parent 'x'.
			const deps = makeDeps({
				starredItems,
				activateStarredItem,
				ownsSession: ownsOnly('a', 'c'),
			});

			// Unscoped order: [Star X, Alpha, Gamma]; scoped drops the starred row →
			// [Alpha, Gamma]. prev from Alpha wraps to Gamma; the starred row is never hit.
			cycleSession('prev', deps);
			expect(activateStarredItem).not.toHaveBeenCalled();
			expect(useSessionStore.getState().activeSessionId).toBe('c');
		});

		it('is a no-op when the window owns no agents and there are no group chats', () => {
			const sessA = makeSession({ id: 'a', name: 'Alpha' });
			const sessB = makeSession({ id: 'b', name: 'Beta' });

			useSessionStore.setState({
				sessions: [sessA, sessB],
				activeSessionId: 'a',
				cyclePosition: -1,
			} as any);
			useUIStore.setState({ leftSidebarOpen: true, bookmarksCollapsed: true } as any);
			useSettingsStore.setState({ groupChatsExpanded: false } as any);

			// Window owns nothing → scoped visual order is empty.
			const deps = makeDeps({ ownsSession: ownsOnly() });

			cycleSession('next', deps);
			// Empty visual order → no-op; active session is untouched.
			expect(useSessionStore.getState().activeSessionId).toBe('a');
		});

		it('selects the first owned agent when the active agent has left this window', () => {
			// An agent moved to another window mid-session: the window no longer owns its
			// previously-active agent. Cycling must land deterministically on an owned
			// agent rather than no-op or jump to the departed one.
			const sessA = makeSession({ id: 'a', name: 'Alpha' }); // moved to another window
			const sessB = makeSession({ id: 'b', name: 'Beta' });
			const sessC = makeSession({ id: 'c', name: 'Gamma' });

			useSessionStore.setState({
				sessions: [sessA, sessB, sessC],
				activeSessionId: 'a', // stale: now owned elsewhere
				cyclePosition: -1,
			} as any);
			useUIStore.setState({ leftSidebarOpen: true, bookmarksCollapsed: true } as any);
			useSettingsStore.setState({ groupChatsExpanded: false } as any);

			const deps = makeDeps({ ownsSession: ownsOnly('b', 'c') });

			// Scoped order: [Beta, Gamma]; 'a' not present → first owned item (Beta).
			cycleSession('next', deps);
			expect(useSessionStore.getState().activeSessionId).toBe('b');
			expect(useSessionStore.getState().cyclePosition).toBe(0);
		});
	});
});
