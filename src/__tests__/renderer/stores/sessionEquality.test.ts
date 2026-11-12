/**
 * Tests for src/renderer/stores/sessionEquality.ts
 *
 * `sidebarSessionEquality` is the equality function used by SessionList,
 * useSessionCategories, and the App-level navigation pipeline to skip
 * re-renders driven purely by streaming log/usage updates. The contract:
 *
 *   - Returns `true` when nothing the sidebar visibly displays changed.
 *   - Returns `false` when any sidebar-relevant field shifted (name, state,
 *     bookmark, group/parent membership, worktree expansion, AI tab
 *     unread/state, etc.).
 *
 * If this contract drifts, the sidebar will either re-render too often
 * (perf regression) or stop reflecting state changes (correctness bug).
 */

import { describe, it, expect } from 'vitest';
import {
	sidebarSessionEquality,
	activeSessionChromeEquality,
} from '../../../renderer/stores/sessionEquality';
import { createMockSession } from '../../helpers/mockSession';
import type { AITab, Session } from '../../../renderer/types';

function tab(overrides: Partial<AITab> = {}): AITab {
	return {
		id: 'tab-1',
		agentSessionId: null,
		name: null,
		starred: false,
		logs: [],
		inputValue: '',
		stagedImages: [],
		createdAt: 0,
		state: 'idle',
		...overrides,
	};
}

describe('sidebarSessionEquality', () => {
	it('returns true for the same array reference', () => {
		const arr: Session[] = [createMockSession({ id: 'a' })];
		expect(sidebarSessionEquality(arr, arr)).toBe(true);
	});

	it('returns false when length differs', () => {
		const a = [createMockSession({ id: 'a' })];
		const b = [createMockSession({ id: 'a' }), createMockSession({ id: 'b' })];
		expect(sidebarSessionEquality(a, b)).toBe(false);
	});

	it('returns true when only streaming-only fields change (logs, usage, cycle counters)', () => {
		const base = createMockSession({
			id: 'a',
			aiTabs: [tab({ id: 't1', logs: [] })],
		});
		const next: Session = {
			...base,
			// Streaming-heavy fields the equality fn intentionally ignores:
			aiLogs: [{ id: 'log-1', timestamp: 0, source: 'stdout', text: 'hi' }],
			shellLogs: [{ id: 'log-2', timestamp: 0, source: 'stdout', text: 'hi' }],
			usageStats: {
				inputTokens: 1,
				outputTokens: 1,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
				totalCostUsd: 0,
				contextWindow: 200_000,
			},
			contextUsage: 42,
			aiTabs: [
				tab({
					id: 't1',
					logs: [{ id: 'log-3', timestamp: 0, source: 'stdout', text: 'streamed' }],
				}),
			],
		};
		expect(sidebarSessionEquality([base], [next])).toBe(true);
	});

	it('returns false when name changes', () => {
		const a = [createMockSession({ id: 'a', name: 'old' })];
		const b = [createMockSession({ id: 'a', name: 'new' })];
		expect(sidebarSessionEquality(a, b)).toBe(false);
	});

	it('returns false when state changes', () => {
		const a = [createMockSession({ id: 'a', state: 'idle' })];
		const b = [createMockSession({ id: 'a', state: 'busy' })];
		expect(sidebarSessionEquality(a, b)).toBe(false);
	});

	it('returns false when bookmarked toggles', () => {
		const a = [createMockSession({ id: 'a', bookmarked: false })];
		const b = [createMockSession({ id: 'a', bookmarked: true })];
		expect(sidebarSessionEquality(a, b)).toBe(false);
	});

	it('returns false when groupId changes', () => {
		const a = [createMockSession({ id: 'a', groupId: 'g1' })];
		const b = [createMockSession({ id: 'a', groupId: 'g2' })];
		expect(sidebarSessionEquality(a, b)).toBe(false);
	});

	it('returns false when worktreesExpanded toggles', () => {
		const a = [createMockSession({ id: 'a', worktreesExpanded: true })];
		const b = [createMockSession({ id: 'a', worktreesExpanded: false })];
		expect(sidebarSessionEquality(a, b)).toBe(false);
	});

	it('returns false when an AI tab hasUnread flips', () => {
		const a = [createMockSession({ id: 'a', aiTabs: [tab({ id: 't1', hasUnread: false })] })];
		const b = [createMockSession({ id: 'a', aiTabs: [tab({ id: 't1', hasUnread: true })] })];
		expect(sidebarSessionEquality(a, b)).toBe(false);
	});

	it('returns false when an AI tab busy state flips', () => {
		const a = [createMockSession({ id: 'a', aiTabs: [tab({ id: 't1', state: 'idle' })] })];
		const b = [createMockSession({ id: 'a', aiTabs: [tab({ id: 't1', state: 'busy' })] })];
		expect(sidebarSessionEquality(a, b)).toBe(false);
	});

	it('returns true when AI tab logs change but tab metadata is identical', () => {
		const a = [
			createMockSession({
				id: 'a',
				aiTabs: [tab({ id: 't1', logs: [] })],
			}),
		];
		const b = [
			createMockSession({
				id: 'a',
				aiTabs: [
					tab({
						id: 't1',
						logs: [{ id: 'log-1', timestamp: 0, source: 'stdout', text: 'streamed' }],
					}),
				],
			}),
		];
		expect(sidebarSessionEquality(a, b)).toBe(true);
	});

	it('returns false when AI tab count changes', () => {
		const a = [createMockSession({ id: 'a', aiTabs: [tab({ id: 't1' })] })];
		const b = [createMockSession({ id: 'a', aiTabs: [tab({ id: 't1' }), tab({ id: 't2' })] })];
		expect(sidebarSessionEquality(a, b)).toBe(false);
	});
});

describe('activeSessionChromeEquality', () => {
	it('returns true when isGeneratingName flips (MainPanel owns naming spinner)', () => {
		const a = createMockSession({ aiTabs: [tab({ id: 't1', isGeneratingName: false })] });
		const b: Session = {
			...a,
			aiTabs: [{ ...a.aiTabs[0], isGeneratingName: true }],
		};
		expect(activeSessionChromeEquality(a, b)).toBe(true);
	});

	it('returns true when session/tab busy state flips (sidebar + MainPanel own busy paint)', () => {
		const a = createMockSession({
			state: 'idle',
			aiTabs: [tab({ id: 't1', state: 'idle' })],
		});
		const b: Session = {
			...a,
			state: 'busy',
			aiTabs: [{ ...a.aiTabs[0], state: 'busy' }],
		};
		expect(activeSessionChromeEquality(a, b)).toBe(true);
	});

	it('returns false when browser customTitle changes', () => {
		const a = createMockSession({
			browserTabs: [{ id: 'b1', title: 'Docs', url: 'https://x', customTitle: undefined } as any],
		});
		const b = createMockSession({
			browserTabs: [{ id: 'b1', title: 'Docs', url: 'https://x', customTitle: 'Pinned' } as any],
		});
		expect(activeSessionChromeEquality(a, b)).toBe(false);
	});

	it('returns true when only logs change', () => {
		const a = createMockSession({
			aiTabs: [tab({ id: 't1', logs: [] })],
		});
		const b: Session = {
			...a,
			aiTabs: [
				{
					...a.aiTabs[0],
					logs: [{ id: 'log-1', timestamp: 0, source: 'stdout', text: 'streamed' }],
				},
			],
		};
		expect(activeSessionChromeEquality(a, b)).toBe(true);
	});
});
