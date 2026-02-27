import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
	useAgentInbox,
	truncate,
	generateSmartSummary,
} from '../../../renderer/hooks/useAgentInbox';
import type { Session, Group } from '../../../renderer/types';
import type { InboxFilterMode, InboxSortMode } from '../../../renderer/types/agent-inbox';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal AITab factory. Fields not relevant to inbox are given sensible defaults. */
const makeTab = (overrides: Record<string, unknown> = {}) => ({
	id: `tab-${Math.random().toString(36).slice(2, 8)}`,
	agentSessionId: null,
	name: null,
	starred: false,
	logs: [],
	inputValue: '',
	stagedImages: [],
	createdAt: 1000,
	state: 'idle' as const,
	hasUnread: false,
	...overrides,
});

/** Minimal Session factory. Only fields consumed by useAgentInbox need real values. */
const makeSession = (overrides: Partial<Session> = {}): Session =>
	({
		id: `s-${Math.random().toString(36).slice(2, 8)}`,
		name: 'Agent A',
		toolType: 'claude-code',
		state: 'idle',
		cwd: '/test',
		fullPath: '/test',
		projectRoot: '/test',
		port: 0,
		aiPid: 0,
		terminalPid: 0,
		inputMode: 'ai',
		aiTabs: [makeTab()],
		activeTabId: 'default-tab',
		closedTabHistory: [],
		aiLogs: [],
		shellLogs: [],
		workLog: [],
		executionQueue: [],
		contextUsage: 0,
		isGitRepo: false,
		changedFiles: [],
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		isLive: false,
		...overrides,
	}) as unknown as Session;

const makeGroup = (overrides: Partial<Group> = {}): Group => ({
	id: `g-${Math.random().toString(36).slice(2, 8)}`,
	name: 'Group',
	emoji: '',
	collapsed: false,
	...overrides,
});

// ---------------------------------------------------------------------------
// truncate()
// ---------------------------------------------------------------------------

describe('truncate', () => {
	it('returns short text unchanged', () => {
		expect(truncate('hello')).toBe('hello');
	});

	it('returns text exactly at MAX_MESSAGE_LENGTH unchanged', () => {
		const text = 'a'.repeat(90);
		expect(truncate(text)).toBe(text);
	});

	it('truncates text longer than 90 chars with ellipsis', () => {
		const text = 'a'.repeat(100);
		const result = truncate(text);
		expect(result.length).toBe(90);
		expect(result.endsWith('...')).toBe(true);
		// 90 - 3 (ellipsis) = 87 'a' chars
		expect(result).toBe('a'.repeat(87) + '...');
	});
});

// ---------------------------------------------------------------------------
// generateSmartSummary()
// ---------------------------------------------------------------------------

describe('generateSmartSummary', () => {
	it('returns default message for empty logs', () => {
		expect(generateSmartSummary([], 'idle')).toBe('No activity yet');
	});

	it('returns default message for undefined logs', () => {
		expect(generateSmartSummary(undefined, 'idle')).toBe('No activity yet');
	});

	it('prefixes with "Waiting:" when session is waiting_input', () => {
		const logs = [
			{ id: '1', timestamp: 1000, source: 'ai' as const, text: 'What should I do next?' },
		];
		const result = generateSmartSummary(logs, 'waiting_input');
		expect(result.startsWith('Waiting: ')).toBe(true);
		expect(result).toContain('What should I do next?');
	});

	it('shows question directly when AI message ends with "?"', () => {
		const logs = [{ id: '1', timestamp: 1000, source: 'ai' as const, text: 'Shall I proceed?' }];
		const result = generateSmartSummary(logs, 'idle');
		expect(result).toBe('Shall I proceed?');
	});

	it('prefixes with "Done:" for AI statement', () => {
		const logs = [
			{ id: '1', timestamp: 1000, source: 'ai' as const, text: 'Refactored the module.' },
		];
		const result = generateSmartSummary(logs, 'idle');
		expect(result).toBe('Done: Refactored the module.');
	});

	it('falls back to last log text when no AI source found', () => {
		const logs = [
			{ id: '1', timestamp: 1000, source: 'user' as const, text: 'Fix the bug please' },
		];
		const result = generateSmartSummary(logs, 'idle');
		expect(result).toBe('Fix the bug please');
	});

	it('truncates long summaries', () => {
		const longText = 'A'.repeat(200);
		const logs = [{ id: '1', timestamp: 1000, source: 'ai' as const, text: longText }];
		const result = generateSmartSummary(logs, 'idle');
		expect(result.length).toBe(90);
		expect(result.endsWith('...')).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// useAgentInbox — Filter Logic
// ---------------------------------------------------------------------------

describe('useAgentInbox — filter logic', () => {
	it('filter "all" returns every tab from every session', () => {
		const tab1 = makeTab({ id: 't1', hasUnread: true });
		const tab2 = makeTab({ id: 't2', hasUnread: false });
		const session = makeSession({ id: 's1', aiTabs: [tab1, tab2] });

		const { result } = renderHook(() => useAgentInbox([session], [], 'all', 'newest'));
		expect(result.current).toHaveLength(2);
	});

	it('filter "unread" returns only unread items', () => {
		const tab1 = makeTab({ id: 't1', hasUnread: true });
		const tab2 = makeTab({ id: 't2', hasUnread: false });
		const session = makeSession({ id: 's1', aiTabs: [tab1, tab2] });

		const { result } = renderHook(() => useAgentInbox([session], [], 'unread', 'newest'));
		expect(result.current).toHaveLength(1);
		expect(result.current[0].tabId).toBe('t1');
		expect(result.current[0].hasUnread).toBe(true);
	});

	it('filter "read" returns only non-unread items', () => {
		const tab1 = makeTab({ id: 't1', hasUnread: true });
		const tab2 = makeTab({ id: 't2', hasUnread: false });
		const session = makeSession({ id: 's1', aiTabs: [tab1, tab2] });

		const { result } = renderHook(() => useAgentInbox([session], [], 'read', 'newest'));
		expect(result.current).toHaveLength(1);
		expect(result.current[0].tabId).toBe('t2');
		expect(result.current[0].hasUnread).toBe(false);
	});

	it('filter "starred" returns only starred items', () => {
		const tab1 = makeTab({ id: 't1', starred: true });
		const tab2 = makeTab({ id: 't2', starred: false });
		const session = makeSession({ id: 's1', aiTabs: [tab1, tab2] });

		const { result } = renderHook(() => useAgentInbox([session], [], 'starred', 'newest'));
		expect(result.current).toHaveLength(1);
		expect(result.current[0].tabId).toBe('t1');
		expect(result.current[0].starred).toBe(true);
	});

	it('skips sessions with falsy id', () => {
		const session = makeSession({ id: '', aiTabs: [makeTab({ hasUnread: true })] });

		const { result } = renderHook(() => useAgentInbox([session], [], 'all', 'newest'));
		expect(result.current).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// useAgentInbox — Sort Logic
// ---------------------------------------------------------------------------

describe('useAgentInbox — sort logic', () => {
	const now = Date.now();

	it('sort "newest" orders by timestamp descending', () => {
		const tab1 = makeTab({
			id: 't1',
			logs: [{ id: '1', timestamp: now - 1000, source: 'ai', text: 'a' }],
		});
		const tab2 = makeTab({
			id: 't2',
			logs: [{ id: '2', timestamp: now, source: 'ai', text: 'b' }],
		});
		const session = makeSession({ id: 's1', aiTabs: [tab1, tab2] });

		const { result } = renderHook(() => useAgentInbox([session], [], 'all', 'newest'));
		expect(result.current[0].tabId).toBe('t2');
		expect(result.current[1].tabId).toBe('t1');
	});

	it('sort "oldest" orders by timestamp ascending', () => {
		const tab1 = makeTab({
			id: 't1',
			logs: [{ id: '1', timestamp: now - 1000, source: 'ai', text: 'a' }],
		});
		const tab2 = makeTab({
			id: 't2',
			logs: [{ id: '2', timestamp: now, source: 'ai', text: 'b' }],
		});
		const session = makeSession({ id: 's1', aiTabs: [tab1, tab2] });

		const { result } = renderHook(() => useAgentInbox([session], [], 'all', 'oldest'));
		expect(result.current[0].tabId).toBe('t1');
		expect(result.current[1].tabId).toBe('t2');
	});

	it('sort "grouped" groups by groupName then by timestamp within group', () => {
		const groupA = makeGroup({ id: 'gA', name: 'Alpha' });
		const groupB = makeGroup({ id: 'gB', name: 'Beta' });

		const tab1 = makeTab({
			id: 't1',
			logs: [{ id: '1', timestamp: now - 2000, source: 'ai', text: 'a' }],
		});
		const tab2 = makeTab({
			id: 't2',
			logs: [{ id: '2', timestamp: now, source: 'ai', text: 'b' }],
		});
		const tab3 = makeTab({
			id: 't3',
			logs: [{ id: '3', timestamp: now - 1000, source: 'ai', text: 'c' }],
		});

		const sessionAlpha = makeSession({ id: 's1', name: 'S1', groupId: 'gA', aiTabs: [tab1] });
		const sessionBeta1 = makeSession({ id: 's2', name: 'S2', groupId: 'gB', aiTabs: [tab2] });
		const sessionBeta2 = makeSession({ id: 's3', name: 'S3', groupId: 'gB', aiTabs: [tab3] });

		const { result } = renderHook(() =>
			useAgentInbox([sessionAlpha, sessionBeta1, sessionBeta2], [groupA, groupB], 'all', 'grouped')
		);

		// Alpha group first, then Beta
		expect(result.current[0].groupName).toBe('Alpha');
		// Beta items sorted by newest first within group
		expect(result.current[1].groupName).toBe('Beta');
		expect(result.current[1].tabId).toBe('t2'); // newer
		expect(result.current[2].groupName).toBe('Beta');
		expect(result.current[2].tabId).toBe('t3'); // older
	});

	it('sort "grouped" puts ungrouped items last', () => {
		const groupA = makeGroup({ id: 'gA', name: 'Alpha' });
		const tabGrouped = makeTab({ id: 't1' });
		const tabUngrouped = makeTab({ id: 't2' });

		const s1 = makeSession({ id: 's1', groupId: 'gA', aiTabs: [tabGrouped] });
		const s2 = makeSession({ id: 's2', aiTabs: [tabUngrouped] });

		const { result } = renderHook(() => useAgentInbox([s1, s2], [groupA], 'all', 'grouped'));

		expect(result.current[0].groupName).toBe('Alpha');
		expect(result.current[1].groupName).toBeUndefined();
	});

	it('sort "byAgent" groups by sessionId, not sessionName', () => {
		// Two sessions with same name but different IDs
		const tab1 = makeTab({ id: 't1', hasUnread: true });
		const tab2 = makeTab({ id: 't2', hasUnread: false });
		const s1 = makeSession({ id: 'agent-aaa', name: 'Same Name', aiTabs: [tab1] });
		const s2 = makeSession({ id: 'agent-bbb', name: 'Same Name', aiTabs: [tab2] });

		const { result } = renderHook(() => useAgentInbox([s1, s2], [], 'all', 'byAgent'));

		// agent-aaa has unread (1) so it should come first
		expect(result.current[0].sessionId).toBe('agent-aaa');
		expect(result.current[1].sessionId).toBe('agent-bbb');
	});

	it('sort "byAgent" puts agents with unreads first', () => {
		const tabUnread = makeTab({ id: 't1', hasUnread: true });
		const tabRead = makeTab({ id: 't2', hasUnread: false });
		const sNoUnread = makeSession({ id: 'agent-zzz', name: 'Alpha', aiTabs: [tabRead] });
		const sWithUnread = makeSession({ id: 'agent-aaa', name: 'Zulu', aiTabs: [tabUnread] });

		const { result } = renderHook(() =>
			useAgentInbox([sNoUnread, sWithUnread], [], 'all', 'byAgent')
		);

		// Agent with unread comes first regardless of alphabetical name
		expect(result.current[0].sessionId).toBe('agent-aaa');
		expect(result.current[1].sessionId).toBe('agent-zzz');
	});
});

// ---------------------------------------------------------------------------
// useAgentInbox — Summary Truncation
// ---------------------------------------------------------------------------

describe('useAgentInbox — summary truncation', () => {
	it('truncates lastMessage to 90 characters', () => {
		const longMessage = 'X'.repeat(200);
		const tab = makeTab({
			id: 't1',
			logs: [{ id: '1', timestamp: 1000, source: 'ai', text: longMessage }],
		});
		const session = makeSession({ id: 's1', aiTabs: [tab] });

		const { result } = renderHook(() => useAgentInbox([session], [], 'all', 'newest'));
		expect(result.current[0].lastMessage.length).toBe(90);
		expect(result.current[0].lastMessage.endsWith('...')).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// useAgentInbox — Timestamp Fallback
// ---------------------------------------------------------------------------

describe('useAgentInbox — timestamp fallback', () => {
	it('uses last log timestamp when available', () => {
		const tab = makeTab({
			id: 't1',
			logs: [{ id: '1', timestamp: 42000, source: 'ai', text: 'hi' }],
		});
		const session = makeSession({ id: 's1', aiTabs: [tab] });

		const { result } = renderHook(() => useAgentInbox([session], [], 'all', 'newest'));
		expect(result.current[0].timestamp).toBe(42000);
	});

	it('falls back to tab createdAt when logs are empty', () => {
		const tab = makeTab({ id: 't1', logs: [], createdAt: 99000 });
		const session = makeSession({ id: 's1', aiTabs: [tab] });

		const { result } = renderHook(() => useAgentInbox([session], [], 'all', 'newest'));
		expect(result.current[0].timestamp).toBe(99000);
	});

	it('falls back to Date.now() when log timestamp and createdAt are invalid', () => {
		const before = Date.now();
		const tab = makeTab({ id: 't1', logs: [], createdAt: 0 });
		const session = makeSession({ id: 's1', aiTabs: [tab] });

		const { result } = renderHook(() => useAgentInbox([session], [], 'all', 'newest'));
		const after = Date.now();

		expect(result.current[0].timestamp).toBeGreaterThanOrEqual(before);
		expect(result.current[0].timestamp).toBeLessThanOrEqual(after);
	});

	it('skips non-finite log timestamps and falls back', () => {
		const tab = makeTab({
			id: 't1',
			logs: [{ id: '1', timestamp: NaN, source: 'ai', text: 'hi' }],
			createdAt: 55000,
		});
		const session = makeSession({ id: 's1', aiTabs: [tab] });

		const { result } = renderHook(() => useAgentInbox([session], [], 'all', 'newest'));
		expect(result.current[0].timestamp).toBe(55000);
	});
});
