/**
 * Tests for buildWindowMoveTargets - the shared labeling/ownership helper behind
 * the Left Bar "Move to Window" submenu and the Cmd+K palette move commands.
 */

import { describe, it, expect } from 'vitest';
import {
	buildWindowMoveTargets,
	scopeSessionsToOwningWindow,
	MAIN_WINDOW_LABEL,
} from '../../../renderer/utils/windowTargets';
import type { WindowInfo } from '../../../shared/window-types';

function makeInfo(partial: Partial<WindowInfo> & Pick<WindowInfo, 'id'>): WindowInfo {
	return { isMain: false, sessionIds: [], activeSessionId: null, ...partial };
}

const names: Record<string, string> = {
	a: 'Alpha',
	b: 'Bravo',
	c: 'Charlie',
};
const getName = (id: string) => names[id];

describe('buildWindowMoveTargets', () => {
	it('returns [] before the registry has hydrated (single-window common case)', () => {
		expect(buildWindowMoveTargets([], 'a', getName)).toEqual([]);
	});

	it('labels the primary "Main Window" and each secondary by its lead agent', () => {
		const windows = [
			makeInfo({ id: 'primary', isMain: true }),
			makeInfo({ id: 'win-2', sessionIds: ['b', 'c'] }),
		];
		const targets = buildWindowMoveTargets(windows, 'a', getName);
		expect(targets.map((t) => t.label)).toEqual([MAIN_WINDOW_LABEL, 'Bravo']);
		expect(targets.map((t) => t.windowNumber)).toEqual([1, 2]);
	});

	it('flags the primary as current owner for a catch-all (unclaimed) agent', () => {
		const windows = [
			makeInfo({ id: 'primary', isMain: true }),
			makeInfo({ id: 'win-2', sessionIds: ['b'] }),
		];
		const targets = buildWindowMoveTargets(windows, 'a', getName);
		// 'a' is claimed by no secondary, so the primary catch-all owns it.
		expect(targets.find((t) => t.isMain)?.isCurrentOwner).toBe(true);
		expect(targets.find((t) => t.windowId === 'win-2')?.isCurrentOwner).toBe(false);
	});

	it('flags the claiming secondary as current owner, not the primary', () => {
		const windows = [
			makeInfo({ id: 'primary', isMain: true }),
			makeInfo({ id: 'win-2', sessionIds: ['a'] }),
		];
		const targets = buildWindowMoveTargets(windows, 'a', getName);
		expect(targets.find((t) => t.isMain)?.isCurrentOwner).toBe(false);
		expect(targets.find((t) => t.windowId === 'win-2')?.isCurrentOwner).toBe(true);
	});

	it('falls back to the window number when a secondary has no resolvable lead name', () => {
		const windows = [
			makeInfo({ id: 'primary', isMain: true }),
			makeInfo({ id: 'win-2', sessionIds: ['unknown-id'] }),
		];
		const targets = buildWindowMoveTargets(windows, 'a', getName);
		expect(targets.find((t) => t.windowId === 'win-2')?.label).toBe('Window 2');
	});

	it('truncates a long lead-agent name with an end ellipsis', () => {
		const longName = 'A'.repeat(60);
		const windows = [
			makeInfo({ id: 'primary', isMain: true }),
			makeInfo({ id: 'win-2', sessionIds: ['long'] }),
		];
		const targets = buildWindowMoveTargets(windows, 'a', (id) =>
			id === 'long' ? longName : undefined
		);
		const label = targets.find((t) => t.windowId === 'win-2')!.label;
		expect(label.length).toBeLessThan(longName.length);
		expect(label.endsWith('…')).toBe(true);
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
