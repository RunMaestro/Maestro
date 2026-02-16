/**
 * Tests for useAgentInbox hook
 *
 * This hook aggregates session/tab data into InboxItems,
 * applying filter and sort modes with null guards.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAgentInbox } from '../../../renderer/hooks/useAgentInbox';
import type { Session, Group } from '../../../renderer/types';
import type { InboxFilterMode, InboxSortMode } from '../../../renderer/types/agent-inbox';

// Factory for creating minimal valid Session objects
function makeSession(overrides: Partial<Session> & { id: string }): Session {
	return {
		name: 'Test Session',
		toolType: 'claude-code',
		state: 'idle',
		cwd: '/tmp',
		fullPath: '/tmp',
		projectRoot: '/tmp',
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
		aiTabs: [],
		activeTabId: '',
		closedTabHistory: [],
		filePreviewTabs: [],
		activeFileTabId: null,
		unifiedTabOrder: [],
		unifiedClosedTabHistory: [],
		executionQueue: [],
		activeTimeMs: 0,
		...overrides,
	} as Session;
}

function makeGroup(overrides: Partial<Group> & { id: string; name: string }): Group {
	return {
		emoji: '',
		collapsed: false,
		...overrides,
	};
}

function makeTab(overrides: Partial<Session['aiTabs'][0]> & { id: string }) {
	return {
		agentSessionId: null,
		name: null,
		starred: false,
		logs: [],
		inputValue: '',
		stagedImages: [],
		createdAt: Date.now(),
		state: 'idle' as const,
		...overrides,
	};
}

describe('useAgentInbox', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	describe('empty states', () => {
		it('should return empty array when no sessions', () => {
			const { result } = renderHook(() =>
				useAgentInbox([], [], 'all', 'newest')
			);
			expect(result.current).toEqual([]);
		});

		it('should return empty array when sessions have no aiTabs', () => {
			const sessions = [makeSession({ id: 's1', aiTabs: [] })];
			const { result } = renderHook(() =>
				useAgentInbox(sessions, [], 'all', 'newest')
			);
			expect(result.current).toEqual([]);
		});

		it('should return empty array when aiTabs is undefined (null guard)', () => {
			const sessions = [makeSession({ id: 's1', aiTabs: undefined as any })];
			const { result } = renderHook(() =>
				useAgentInbox(sessions, [], 'all', 'newest')
			);
			expect(result.current).toEqual([]);
		});
	});

	describe('session id validation', () => {
		it('should skip sessions with empty string id', () => {
			const sessions = [
				makeSession({
					id: '',
					state: 'waiting_input',
					aiTabs: [makeTab({ id: 't1', hasUnread: true })],
				}),
			];
			const { result } = renderHook(() =>
				useAgentInbox(sessions, [], 'all', 'newest')
			);
			expect(result.current).toEqual([]);
		});
	});

	describe('filter mode: all', () => {
		it('should include tabs with hasUnread=true', () => {
			const sessions = [
				makeSession({
					id: 's1',
					state: 'busy',
					aiTabs: [makeTab({ id: 't1', hasUnread: true })],
				}),
			];
			const { result } = renderHook(() =>
				useAgentInbox(sessions, [], 'all', 'newest')
			);
			expect(result.current).toHaveLength(1);
			expect(result.current[0].sessionId).toBe('s1');
		});

		it('should include tabs when session state is waiting_input', () => {
			const sessions = [
				makeSession({
					id: 's1',
					state: 'waiting_input',
					aiTabs: [makeTab({ id: 't1', hasUnread: false })],
				}),
			];
			const { result } = renderHook(() =>
				useAgentInbox(sessions, [], 'all', 'newest')
			);
			expect(result.current).toHaveLength(1);
		});

		it('should include tabs when session state is idle', () => {
			const sessions = [
				makeSession({
					id: 's1',
					state: 'idle',
					aiTabs: [makeTab({ id: 't1', hasUnread: false })],
				}),
			];
			const { result } = renderHook(() =>
				useAgentInbox(sessions, [], 'all', 'newest')
			);
			expect(result.current).toHaveLength(1);
		});

		it('should exclude tabs when session is busy and no unread', () => {
			const sessions = [
				makeSession({
					id: 's1',
					state: 'busy',
					aiTabs: [makeTab({ id: 't1', hasUnread: false })],
				}),
			];
			const { result } = renderHook(() =>
				useAgentInbox(sessions, [], 'all', 'newest')
			);
			expect(result.current).toHaveLength(0);
		});

		it('should exclude tabs when session has error state and no unread', () => {
			const sessions = [
				makeSession({
					id: 's1',
					state: 'error',
					aiTabs: [makeTab({ id: 't1', hasUnread: false })],
				}),
			];
			const { result } = renderHook(() =>
				useAgentInbox(sessions, [], 'all', 'newest')
			);
			expect(result.current).toHaveLength(0);
		});
	});

	describe('filter mode: unread', () => {
		it('should only include tabs with hasUnread=true', () => {
			const sessions = [
				makeSession({
					id: 's1',
					state: 'waiting_input',
					aiTabs: [makeTab({ id: 't1', hasUnread: true })],
				}),
				makeSession({
					id: 's2',
					state: 'idle',
					aiTabs: [makeTab({ id: 't2', hasUnread: true })],
				}),
				makeSession({
					id: 's3',
					state: 'idle',
					aiTabs: [makeTab({ id: 't3', hasUnread: false })],
				}),
			];
			const { result } = renderHook(() =>
				useAgentInbox(sessions, [], 'unread', 'newest')
			);
			expect(result.current).toHaveLength(2);
			expect(result.current.map(i => i.sessionId).sort()).toEqual(['s1', 's2']);
		});
	});

	describe('filter mode: read', () => {
		it('should only include tabs with hasUnread=false and idle/waiting_input state', () => {
			const sessions = [
				makeSession({
					id: 's1',
					state: 'idle',
					aiTabs: [makeTab({ id: 't1', hasUnread: true })],
				}),
				makeSession({
					id: 's2',
					state: 'idle',
					aiTabs: [makeTab({ id: 't2', hasUnread: false })],
				}),
				makeSession({
					id: 's3',
					state: 'waiting_input',
					aiTabs: [makeTab({ id: 't3', hasUnread: false })],
				}),
				makeSession({
					id: 's4',
					state: 'busy',
					aiTabs: [makeTab({ id: 't4', hasUnread: false })],
				}),
			];
			const { result } = renderHook(() =>
				useAgentInbox(sessions, [], 'read', 'newest')
			);
			// s2 (idle, hasUnread=false) and s3 (waiting_input, hasUnread=false) match
			// s1 excluded (hasUnread=true), s4 excluded (busy state)
			expect(result.current).toHaveLength(2);
			expect(result.current.map(i => i.sessionId).sort()).toEqual(['s2', 's3']);
		});
	});

	describe('InboxItem field mapping', () => {
		it('should map session and tab fields correctly', () => {
			const groups = [makeGroup({ id: 'g1', name: 'Backend' })];
			const sessions = [
				makeSession({
					id: 's1',
					name: 'My Agent',
					toolType: 'claude-code',
					state: 'waiting_input',
					groupId: 'g1',
					contextUsage: 45,
					worktreeBranch: 'feature/test',
					aiTabs: [
						makeTab({
							id: 't1',
							hasUnread: true,
							createdAt: 1700000000000,
							logs: [
								{ id: 'l1', timestamp: 1700000001000, source: 'ai', text: 'Hello world' },
							],
						}),
					],
				}),
			];
			const { result } = renderHook(() =>
				useAgentInbox(sessions, groups, 'all', 'newest')
			);
			expect(result.current).toHaveLength(1);
			const item = result.current[0];
			expect(item.sessionId).toBe('s1');
			expect(item.tabId).toBe('t1');
			expect(item.groupId).toBe('g1');
			expect(item.groupName).toBe('Backend');
			expect(item.sessionName).toBe('My Agent');
			expect(item.toolType).toBe('claude-code');
			expect(item.gitBranch).toBe('feature/test');
			expect(item.contextUsage).toBe(45);
			expect(item.lastMessage).toBe('Waiting: Hello world');
			expect(item.timestamp).toBe(1700000001000);
			expect(item.state).toBe('waiting_input');
			expect(item.hasUnread).toBe(true);
		});

		it('should handle missing group gracefully', () => {
			const sessions = [
				makeSession({
					id: 's1',
					groupId: 'nonexistent',
					state: 'idle',
					aiTabs: [makeTab({ id: 't1', hasUnread: true })],
				}),
			];
			const { result } = renderHook(() =>
				useAgentInbox(sessions, [], 'all', 'newest')
			);
			expect(result.current[0].groupId).toBe('nonexistent');
			expect(result.current[0].groupName).toBeUndefined();
		});

		it('should handle session with no groupId', () => {
			const sessions = [
				makeSession({
					id: 's1',
					state: 'idle',
					aiTabs: [makeTab({ id: 't1', hasUnread: true })],
				}),
			];
			const { result } = renderHook(() =>
				useAgentInbox(sessions, [], 'all', 'newest')
			);
			expect(result.current[0].groupId).toBeUndefined();
			expect(result.current[0].groupName).toBeUndefined();
		});
	});

	describe('smart summary generation', () => {
		it('should show "No activity yet" when logs array is empty', () => {
			const sessions = [
				makeSession({
					id: 's1',
					state: 'idle',
					aiTabs: [makeTab({ id: 't1', hasUnread: true, logs: [] })],
				}),
			];
			const { result } = renderHook(() =>
				useAgentInbox(sessions, [], 'all', 'newest')
			);
			expect(result.current[0].lastMessage).toBe('No activity yet');
		});

		it('should show "No activity yet" when logs is undefined', () => {
			const sessions = [
				makeSession({
					id: 's1',
					state: 'idle',
					aiTabs: [makeTab({ id: 't1', hasUnread: true, logs: undefined as any })],
				}),
			];
			const { result } = renderHook(() =>
				useAgentInbox(sessions, [], 'all', 'newest')
			);
			expect(result.current[0].lastMessage).toBe('No activity yet');
		});

		it('should prefix with "Waiting: " when session state is waiting_input', () => {
			const sessions = [
				makeSession({
					id: 's1',
					state: 'waiting_input',
					aiTabs: [
						makeTab({
							id: 't1',
							hasUnread: true,
							logs: [
								{ id: 'l1', timestamp: 1000, source: 'ai' as const, text: 'Do you want to proceed?' },
							],
						}),
					],
				}),
			];
			const { result } = renderHook(() =>
				useAgentInbox(sessions, [], 'all', 'newest')
			);
			expect(result.current[0].lastMessage).toBe('Waiting: Do you want to proceed?');
		});

		it('should show "Waiting: awaiting your response" when waiting_input but no AI message', () => {
			const sessions = [
				makeSession({
					id: 's1',
					state: 'waiting_input',
					aiTabs: [
						makeTab({
							id: 't1',
							hasUnread: false,
							logs: [
								{ id: 'l1', timestamp: 1000, source: 'user' as const, text: 'hello' },
							],
						}),
					],
				}),
			];
			const { result } = renderHook(() =>
				useAgentInbox(sessions, [], 'all', 'newest')
			);
			expect(result.current[0].lastMessage).toBe('Waiting: awaiting your response');
		});

		it('should show AI question directly when it ends with "?"', () => {
			const sessions = [
				makeSession({
					id: 's1',
					state: 'idle',
					aiTabs: [
						makeTab({
							id: 't1',
							hasUnread: true,
							logs: [
								{ id: 'l1', timestamp: 1000, source: 'ai' as const, text: 'Which file should I modify?' },
							],
						}),
					],
				}),
			];
			const { result } = renderHook(() =>
				useAgentInbox(sessions, [], 'all', 'newest')
			);
			expect(result.current[0].lastMessage).toBe('Which file should I modify?');
		});

		it('should prefix with "Done: " + first sentence for AI statements', () => {
			const sessions = [
				makeSession({
					id: 's1',
					state: 'idle',
					aiTabs: [
						makeTab({
							id: 't1',
							hasUnread: true,
							logs: [
								{ id: 'l1', timestamp: 1000, source: 'ai' as const, text: 'I have updated the file. The changes include formatting.' },
							],
						}),
					],
				}),
			];
			const { result } = renderHook(() =>
				useAgentInbox(sessions, [], 'all', 'newest')
			);
			expect(result.current[0].lastMessage).toBe('Done: I have updated the file.');
		});

		it('should find AI message among last 3 log entries', () => {
			const sessions = [
				makeSession({
					id: 's1',
					state: 'idle',
					aiTabs: [
						makeTab({
							id: 't1',
							hasUnread: true,
							logs: [
								{ id: 'l1', timestamp: 1000, source: 'ai' as const, text: 'Old AI message' },
								{ id: 'l2', timestamp: 2000, source: 'ai' as const, text: 'Task completed successfully.' },
								{ id: 'l3', timestamp: 3000, source: 'tool' as const, text: 'file.ts modified' },
							],
						}),
					],
				}),
			];
			const { result } = renderHook(() =>
				useAgentInbox(sessions, [], 'all', 'newest')
			);
			expect(result.current[0].lastMessage).toBe('Done: Task completed successfully.');
		});

		it('should fall back to last log text when no AI message in last 3 entries', () => {
			const sessions = [
				makeSession({
					id: 's1',
					state: 'idle',
					aiTabs: [
						makeTab({
							id: 't1',
							hasUnread: true,
							logs: [
								{ id: 'l1', timestamp: 1000, source: 'user' as const, text: 'User sent something' },
							],
						}),
					],
				}),
			];
			const { result } = renderHook(() =>
				useAgentInbox(sessions, [], 'all', 'newest')
			);
			expect(result.current[0].lastMessage).toBe('User sent something');
		});

		it('should skip log entries with undefined text', () => {
			const sessions = [
				makeSession({
					id: 's1',
					state: 'idle',
					aiTabs: [
						makeTab({
							id: 't1',
							hasUnread: true,
							logs: [
								{ id: 'l1', timestamp: 1000, source: 'ai' as const, text: 'Good message.' },
								{ id: 'l2', timestamp: 2000, source: 'ai' as const, text: undefined as any },
							],
						}),
					],
				}),
			];
			const { result } = renderHook(() =>
				useAgentInbox(sessions, [], 'all', 'newest')
			);
			// Should find the earlier AI message since the later one has undefined text
			expect(result.current[0].lastMessage).toBe('Done: Good message.');
		});

		it('should truncate summaries longer than 90 chars', () => {
			const longText = 'A'.repeat(100);
			const sessions = [
				makeSession({
					id: 's1',
					state: 'idle',
					aiTabs: [
						makeTab({
							id: 't1',
							hasUnread: true,
							logs: [{ id: 'l1', timestamp: 1000, source: 'ai' as const, text: longText + '?' }],
						}),
					],
				}),
			];
			const { result } = renderHook(() =>
				useAgentInbox(sessions, [], 'all', 'newest')
			);
			// Question shown directly, but truncated at 90 chars
			expect(result.current[0].lastMessage).toBe('A'.repeat(90) + '...');
			expect(result.current[0].lastMessage.length).toBe(93); // 90 + '...'
		});

		it('should not truncate summaries exactly at 90 chars', () => {
			// "Done: " is 6 chars, so AI text of 84 chars → total 90 chars
			const exactText = 'B'.repeat(84) + '.';
			const sessions = [
				makeSession({
					id: 's1',
					state: 'idle',
					aiTabs: [
						makeTab({
							id: 't1',
							hasUnread: true,
							logs: [{ id: 'l1', timestamp: 1000, source: 'ai' as const, text: exactText }],
						}),
					],
				}),
			];
			const { result } = renderHook(() =>
				useAgentInbox(sessions, [], 'all', 'newest')
			);
			// "Done: " (6) + firstSentence of text = total
			const summary = result.current[0].lastMessage;
			expect(summary.length).toBeLessThanOrEqual(93); // at most 90+3
		});

		it('should handle log entries with null text gracefully', () => {
			const sessions = [
				makeSession({
					id: 's1',
					state: 'idle',
					aiTabs: [
						makeTab({
							id: 't1',
							hasUnread: true,
							logs: [
								{ id: 'l1', timestamp: 1000, source: 'ai' as const, text: null as any },
							],
						}),
					],
				}),
			];
			const { result } = renderHook(() =>
				useAgentInbox(sessions, [], 'all', 'newest')
			);
			expect(result.current[0].lastMessage).toBe('No activity yet');
		});
	});

	describe('timestamp derivation', () => {
		it('should use last log entry timestamp when available', () => {
			const sessions = [
				makeSession({
					id: 's1',
					state: 'idle',
					aiTabs: [
						makeTab({
							id: 't1',
							hasUnread: true,
							createdAt: 1000,
							logs: [{ id: 'l1', timestamp: 5000, source: 'ai' as const, text: 'msg' }],
						}),
					],
				}),
			];
			const { result } = renderHook(() =>
				useAgentInbox(sessions, [], 'all', 'newest')
			);
			expect(result.current[0].timestamp).toBe(5000);
		});

		it('should fall back to tab createdAt when no logs', () => {
			const sessions = [
				makeSession({
					id: 's1',
					state: 'idle',
					aiTabs: [
						makeTab({ id: 't1', hasUnread: true, createdAt: 9999, logs: [] }),
					],
				}),
			];
			const { result } = renderHook(() =>
				useAgentInbox(sessions, [], 'all', 'newest')
			);
			expect(result.current[0].timestamp).toBe(9999);
		});

		it('should fall back to Date.now() when timestamp is invalid', () => {
			const before = Date.now();
			const sessions = [
				makeSession({
					id: 's1',
					state: 'idle',
					aiTabs: [
						makeTab({ id: 't1', hasUnread: true, createdAt: -1, logs: [] }),
					],
				}),
			];
			const { result } = renderHook(() =>
				useAgentInbox(sessions, [], 'all', 'newest')
			);
			const after = Date.now();
			expect(result.current[0].timestamp).toBeGreaterThanOrEqual(before);
			expect(result.current[0].timestamp).toBeLessThanOrEqual(after);
		});
	});

	describe('sort mode: newest', () => {
		it('should sort by timestamp descending', () => {
			const sessions = [
				makeSession({
					id: 's1',
					state: 'idle',
					aiTabs: [
						makeTab({ id: 't1', hasUnread: true, logs: [{ id: 'l1', timestamp: 1000, source: 'ai' as const, text: 'old' }] }),
					],
				}),
				makeSession({
					id: 's2',
					state: 'idle',
					aiTabs: [
						makeTab({ id: 't2', hasUnread: true, logs: [{ id: 'l2', timestamp: 3000, source: 'ai' as const, text: 'new' }] }),
					],
				}),
			];
			const { result } = renderHook(() =>
				useAgentInbox(sessions, [], 'all', 'newest')
			);
			expect(result.current[0].sessionId).toBe('s2');
			expect(result.current[1].sessionId).toBe('s1');
		});
	});

	describe('sort mode: oldest', () => {
		it('should sort by timestamp ascending', () => {
			const sessions = [
				makeSession({
					id: 's1',
					state: 'idle',
					aiTabs: [
						makeTab({ id: 't1', hasUnread: true, logs: [{ id: 'l1', timestamp: 3000, source: 'ai' as const, text: 'new' }] }),
					],
				}),
				makeSession({
					id: 's2',
					state: 'idle',
					aiTabs: [
						makeTab({ id: 't2', hasUnread: true, logs: [{ id: 'l2', timestamp: 1000, source: 'ai' as const, text: 'old' }] }),
					],
				}),
			];
			const { result } = renderHook(() =>
				useAgentInbox(sessions, [], 'all', 'oldest')
			);
			expect(result.current[0].sessionId).toBe('s2');
			expect(result.current[1].sessionId).toBe('s1');
		});
	});

	describe('sort mode: grouped', () => {
		it('should sort alphabetically by group name, ungrouped last', () => {
			const groups = [
				makeGroup({ id: 'g1', name: 'Backend' }),
				makeGroup({ id: 'g2', name: 'Frontend' }),
			];
			const sessions = [
				makeSession({
					id: 's1',
					state: 'idle',
					aiTabs: [makeTab({ id: 't1', hasUnread: true, logs: [{ id: 'l1', timestamp: 1000, source: 'ai' as const, text: 'a' }] })],
				}),
				makeSession({
					id: 's2',
					state: 'idle',
					groupId: 'g2',
					aiTabs: [makeTab({ id: 't2', hasUnread: true, logs: [{ id: 'l2', timestamp: 2000, source: 'ai' as const, text: 'b' }] })],
				}),
				makeSession({
					id: 's3',
					state: 'idle',
					groupId: 'g1',
					aiTabs: [makeTab({ id: 't3', hasUnread: true, logs: [{ id: 'l3', timestamp: 3000, source: 'ai' as const, text: 'c' }] })],
				}),
			];
			const { result } = renderHook(() =>
				useAgentInbox(sessions, groups, 'all', 'grouped')
			);
			// Backend (g1) first, then Frontend (g2), then ungrouped
			expect(result.current[0].groupName).toBe('Backend');
			expect(result.current[1].groupName).toBe('Frontend');
			expect(result.current[2].groupName).toBeUndefined();
		});

		it('should sort by timestamp descending within same group', () => {
			const groups = [makeGroup({ id: 'g1', name: 'Backend' })];
			const sessions = [
				makeSession({
					id: 's1',
					state: 'idle',
					groupId: 'g1',
					aiTabs: [makeTab({ id: 't1', hasUnread: true, logs: [{ id: 'l1', timestamp: 1000, source: 'ai' as const, text: 'old' }] })],
				}),
				makeSession({
					id: 's2',
					state: 'idle',
					groupId: 'g1',
					aiTabs: [makeTab({ id: 't2', hasUnread: true, logs: [{ id: 'l2', timestamp: 3000, source: 'ai' as const, text: 'new' }] })],
				}),
			];
			const { result } = renderHook(() =>
				useAgentInbox(sessions, groups, 'all', 'grouped')
			);
			expect(result.current[0].sessionId).toBe('s2');
			expect(result.current[1].sessionId).toBe('s1');
		});
	});

	describe('multiple tabs per session', () => {
		it('should create separate InboxItems for each matching tab', () => {
			const sessions = [
				makeSession({
					id: 's1',
					state: 'idle',
					aiTabs: [
						makeTab({ id: 't1', hasUnread: true }),
						makeTab({ id: 't2', hasUnread: true }),
						makeTab({ id: 't3', hasUnread: false }),
					],
				}),
			];
			const { result } = renderHook(() =>
				useAgentInbox(sessions, [], 'unread', 'newest')
			);
			// 'unread' = hasUnread → t1, t2 match; t3 does not
			expect(result.current).toHaveLength(2);
			expect(result.current.map(i => i.tabId).sort()).toEqual(['t1', 't2']);
		});

		it('should include tabName when session has 2+ tabs', () => {
			const sessions = [
				makeSession({
					id: 's1',
					state: 'idle',
					aiTabs: [
						makeTab({ id: 't1', hasUnread: true, name: 'My Tab' }),
						makeTab({ id: 't2', hasUnread: true, name: null }),
					],
				}),
			];
			const { result } = renderHook(() =>
				useAgentInbox(sessions, [], 'all', 'newest')
			);
			expect(result.current).toHaveLength(2);
			// First tab has explicit name
			expect(result.current.find(i => i.tabId === 't1')?.tabName).toBe('My Tab');
			// Second tab falls back to "Tab 2"
			expect(result.current.find(i => i.tabId === 't2')?.tabName).toBe('Tab 2');
		});

		it('should not include tabName when session has only 1 tab', () => {
			const sessions = [
				makeSession({
					id: 's1',
					state: 'idle',
					aiTabs: [
						makeTab({ id: 't1', hasUnread: true, name: 'My Tab' }),
					],
				}),
			];
			const { result } = renderHook(() =>
				useAgentInbox(sessions, [], 'all', 'newest')
			);
			expect(result.current).toHaveLength(1);
			expect(result.current[0].tabName).toBeUndefined();
		});
	});

	describe('git branch mapping', () => {
		it('should use worktreeBranch when available', () => {
			const sessions = [
				makeSession({
					id: 's1',
					state: 'idle',
					worktreeBranch: 'feature/xyz',
					aiTabs: [makeTab({ id: 't1', hasUnread: true })],
				}),
			];
			const { result } = renderHook(() =>
				useAgentInbox(sessions, [], 'all', 'newest')
			);
			expect(result.current[0].gitBranch).toBe('feature/xyz');
		});

		it('should be undefined when worktreeBranch is not set', () => {
			const sessions = [
				makeSession({
					id: 's1',
					state: 'idle',
					aiTabs: [makeTab({ id: 't1', hasUnread: true })],
				}),
			];
			const { result } = renderHook(() =>
				useAgentInbox(sessions, [], 'all', 'newest')
			);
			expect(result.current[0].gitBranch).toBeUndefined();
		});
	});

	describe('memoization', () => {
		it('should return same reference when inputs do not change', () => {
			const sessions = [
				makeSession({
					id: 's1',
					state: 'idle',
					aiTabs: [makeTab({ id: 't1', hasUnread: true })],
				}),
			];
			const groups: Group[] = [];
			const { result, rerender } = renderHook(
				({ s, g, f, so }: { s: Session[]; g: Group[]; f: InboxFilterMode; so: InboxSortMode }) =>
					useAgentInbox(s, g, f, so),
				{ initialProps: { s: sessions, g: groups, f: 'all' as InboxFilterMode, so: 'newest' as InboxSortMode } }
			);
			const firstResult = result.current;
			// Rerender with same references
			rerender({ s: sessions, g: groups, f: 'all', so: 'newest' });
			expect(result.current).toBe(firstResult);
		});

		it('should return new reference when filter mode changes', () => {
			const sessions = [
				makeSession({
					id: 's1',
					state: 'idle',
					aiTabs: [makeTab({ id: 't1', hasUnread: true })],
				}),
			];
			const groups: Group[] = [];
			const { result, rerender } = renderHook(
				({ f }: { f: InboxFilterMode }) => useAgentInbox(sessions, groups, f, 'newest'),
				{ initialProps: { f: 'all' as InboxFilterMode } }
			);
			const firstResult = result.current;
			rerender({ f: 'unread' });
			expect(result.current).not.toBe(firstResult);
		});
	});
});
