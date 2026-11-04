/**
 * Tests for buildWindowMoveTargets - the shared labeling/ownership helper behind
 * the Left Bar "Move to Window" submenu and the Cmd+K palette move commands.
 */

import { describe, it, expect } from 'vitest';
import {
	buildGroupWindowMoveTargets,
	collectGroupAgentIds,
	resolveOwningWindowId,
	buildWindowMoveTargets,
	scopeSessionsToOwningWindow,
	MAIN_WINDOW_LABEL,
} from '../../../renderer/utils/windowTargets';
import type { WindowInfo } from '../../../shared/window-types';

function makeInfo(partial: Partial<WindowInfo> & Pick<WindowInfo, 'id'>): WindowInfo {
	return { isMain: false, sessionIds: [], activeSessionId: null, ...partial };
}

describe('buildWindowMoveTargets', () => {
	it('returns [] before the registry has hydrated (single-window common case)', () => {
		expect(buildWindowMoveTargets([], 'a')).toEqual([]);
	});

	it('labels the primary "Main Window" and each secondary by its window number', () => {
		const windows = [
			makeInfo({ id: 'primary', isMain: true }),
			// Secondary borrows NO agent name - it is a numbered container.
			makeInfo({ id: 'win-2', sessionIds: ['b', 'c'] }),
			makeInfo({ id: 'win-3', sessionIds: ['d'] }),
		];
		const targets = buildWindowMoveTargets(windows, 'a');
		expect(targets.map((t) => t.label)).toEqual([MAIN_WINDOW_LABEL, 'Window 2', 'Window 3']);
		expect(targets.map((t) => t.windowNumber)).toEqual([1, 2, 3]);
	});

	it('flags the primary as current owner for a catch-all (unclaimed) agent', () => {
		const windows = [
			makeInfo({ id: 'primary', isMain: true }),
			makeInfo({ id: 'win-2', sessionIds: ['b'] }),
		];
		const targets = buildWindowMoveTargets(windows, 'a');
		// 'a' is claimed by no secondary, so the primary catch-all owns it.
		expect(targets.find((t) => t.isMain)?.isCurrentOwner).toBe(true);
		expect(targets.find((t) => t.windowId === 'win-2')?.isCurrentOwner).toBe(false);
	});

	it('flags the claiming secondary as current owner, not the primary', () => {
		const windows = [
			makeInfo({ id: 'primary', isMain: true }),
			makeInfo({ id: 'win-2', sessionIds: ['a'] }),
		];
		const targets = buildWindowMoveTargets(windows, 'a');
		expect(targets.find((t) => t.isMain)?.isCurrentOwner).toBe(false);
		expect(targets.find((t) => t.windowId === 'win-2')?.isCurrentOwner).toBe(true);
	});

	it('uses a custom window name as the label (and exposes it as customName)', () => {
		const windows = [
			makeInfo({ id: 'primary', isMain: true }),
			makeInfo({ id: 'win-2', sessionIds: ['b'], name: 'Deploy Watch' }),
		];
		const targets = buildWindowMoveTargets(windows, 'a');
		const secondary = targets.find((t) => t.windowId === 'win-2')!;
		// Custom name wins over the generic "Window 2" label.
		expect(secondary.label).toBe('Deploy Watch');
		expect(secondary.customName).toBe('Deploy Watch');
	});

	it('a custom name on the primary overrides "Main Window"', () => {
		const windows = [makeInfo({ id: 'primary', isMain: true, name: 'Home Base' })];
		const targets = buildWindowMoveTargets(windows, 'a');
		expect(targets[0].label).toBe('Home Base');
	});

	it('labels an unnamed secondary by its number regardless of the agents it holds', () => {
		const windows = [
			makeInfo({ id: 'primary', isMain: true }),
			makeInfo({ id: 'win-2', sessionIds: ['some-agent'] }),
		];
		const targets = buildWindowMoveTargets(windows, 'a');
		expect(targets.find((t) => t.windowId === 'win-2')?.label).toBe('Window 2');
	});

	it('truncates a long custom name with an end ellipsis', () => {
		const longName = 'A'.repeat(60);
		const windows = [
			makeInfo({ id: 'primary', isMain: true }),
			makeInfo({ id: 'win-2', sessionIds: ['b'], name: longName }),
		];
		const targets = buildWindowMoveTargets(windows, 'a');
		const label = targets.find((t) => t.windowId === 'win-2')!.label;
		expect(label.length).toBeLessThan(longName.length);
		expect(label.endsWith('…')).toBe(true);
	});

	it('omits an empty secondary window (it is auto-closing, not a destination)', () => {
		const windows = [
			makeInfo({ id: 'primary', isMain: true, sessionIds: ['a'] }),
			makeInfo({ id: 'win-2', sessionIds: [] }), // just lost its last agent
			makeInfo({ id: 'win-3', sessionIds: ['b'] }),
		];
		const targets = buildWindowMoveTargets(windows, 'a');
		expect(targets.map((t) => t.windowId)).toEqual(['primary', 'win-3']);
		// windowNumber stays the registry-order index, so win-3 is still "Window 3"
		// (matching its OS title) even though the empty win-2 was skipped.
		expect(targets.find((t) => t.windowId === 'win-3')?.windowNumber).toBe(3);
		expect(targets.find((t) => t.windowId === 'win-3')?.label).toBe('Window 3');
	});

	it('keeps the primary even when it is the catch-all owner of zero explicit agents', () => {
		// The primary never auto-closes, so it is always a valid destination.
		const windows = [
			makeInfo({ id: 'primary', isMain: true, sessionIds: [] }),
			makeInfo({ id: 'win-2', sessionIds: ['a'] }),
		];
		const targets = buildWindowMoveTargets(windows, 'a');
		expect(targets.some((t) => t.isMain)).toBe(true);
	});
});

describe('scopeSessionsToOwningWindow', () => {
	interface S {
		id: string;
		parentSessionId?: string | null;
	}
	const list: S[] = [
		{ id: 'a' },
		{ id: 'b' },
		{ id: 'c' },
		{ id: 'a-wt', parentSessionId: 'a' }, // worktree child of a
		{ id: 'b-wt', parentSessionId: 'b' }, // worktree child of b
	];

	it('returns the list unchanged when there is no ownsSession (no WindowProvider)', () => {
		expect(scopeSessionsToOwningWindow(list, null)).toBe(list);
	});

	it('is a no-op when ownsSession owns everything (single-window primary)', () => {
		const scoped = scopeSessionsToOwningWindow(list, () => true).map((s) => s.id);
		expect(scoped).toEqual(['a', 'b', 'c', 'a-wt', 'b-wt']);
	});

	it('keeps only owned agents (applies to primary and secondary alike)', () => {
		const owns = (id: string) => id === 'a';
		const scoped = scopeSessionsToOwningWindow(list, owns).map((s) => s.id);
		// 'a' is owned; 'a-wt' rides along as its worktree child. b/c and b-wt drop.
		expect(scoped).toEqual(['a', 'a-wt']);
	});

	it('drops an agent owned by another window from this window (primary loses a moved agent)', () => {
		// Primary ownsSession = "not claimed by a secondary". Say 'b' moved to a
		// secondary window, so the primary no longer owns it.
		const owns = (id: string) => id !== 'b' && id !== 'b-wt';
		const scoped = scopeSessionsToOwningWindow(list, owns).map((s) => s.id);
		expect(scoped).toEqual(['a', 'c', 'a-wt']);
	});

	it('keeps a worktree child whose parent is owned, even if the child id is not', () => {
		// Ownership is recorded per-agent; a moved parent should keep its worktrees.
		const owns = (id: string) => id === 'b';
		const scoped = scopeSessionsToOwningWindow(list, owns).map((s) => s.id);
		expect(scoped).toEqual(['b', 'b-wt']);
	});
});

describe('group window moves', () => {
	const windows: WindowInfo[] = [
		makeInfo({ id: 'p', isMain: true }),
		makeInfo({ id: 'w2', sessionIds: ['b'] }),
	];

	it('resolves an agent to its claiming secondary, else the primary', () => {
		expect(resolveOwningWindowId(windows, 'b')).toBe('w2');
		expect(resolveOwningWindowId(windows, 'a')).toBe('p');
		expect(resolveOwningWindowId([], 'a')).toBeNull();
	});

	it('marks a window as the owner only when it holds EVERY agent in the group', () => {
		const split = buildGroupWindowMoveTargets(windows, ['a', 'b']);
		expect(split.map((t) => [t.windowId, t.isCurrentOwner])).toEqual([
			['p', false],
			['w2', false],
		]);
		const whole = buildGroupWindowMoveTargets(windows, ['b']);
		expect(whole.find((t) => t.windowId === 'w2')?.isCurrentOwner).toBe(true);
	});

	it('offers nothing for an empty group', () => {
		expect(buildGroupWindowMoveTargets(windows, [])).toEqual([]);
	});

	it('collects top-level members, adding subgroups only when asked', () => {
		const sessions = [
			{ id: 'a', groupId: 'g' },
			{ id: 'wt', groupId: 'g', parentSessionId: 'a' },
			{ id: 'c', groupId: 'child' },
			{ id: 'x', groupId: 'other' },
			{ id: 'u' },
		];
		const groups = [
			{ id: 'g' },
			{ id: 'child', parentGroupId: 'g' },
			{ id: 'other' },
			// A malformed cycle must not loop forever.
			{ id: 'loop1', parentGroupId: 'loop2' },
			{ id: 'loop2', parentGroupId: 'loop1' },
		];
		expect(collectGroupAgentIds(sessions, groups, 'g', false)).toEqual(['a']);
		expect(collectGroupAgentIds(sessions, groups, 'g', true)).toEqual(['a', 'c']);
		expect(collectGroupAgentIds(sessions, groups, 'loop1', true)).toEqual([]);
	});
});
