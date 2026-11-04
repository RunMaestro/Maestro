import { describe, expect, it } from 'vitest';
import { isWorktreeGroup, type Group } from '../../shared/types';

const LEGACY_WORKTREE_EMOJI = String.fromCodePoint(0x1f333);

function createGroup(overrides: Partial<Group>): Group {
	return {
		id: 'group-1',
		name: 'Group',
		emoji: '📁',
		collapsed: false,
		...overrides,
	};
}

describe('isWorktreeGroup', () => {
	it('identifies a group with the worktree kind', () => {
		expect(isWorktreeGroup(createGroup({ kind: 'worktree', emoji: '📁' }))).toBe(true);
	});

	it('identifies a legacy tree emoji group', () => {
		expect(isWorktreeGroup(createGroup({ emoji: LEGACY_WORKTREE_EMOJI }))).toBe(true);
	});
	it('identifies a group when both worktree markers are present', () => {
		expect(isWorktreeGroup(createGroup({ kind: 'worktree', emoji: LEGACY_WORKTREE_EMOJI }))).toBe(
			true
		);
	});
	it('does not identify a user group as a worktree group', () => {
		expect(isWorktreeGroup(createGroup({ kind: 'user', emoji: '📁' }))).toBe(false);
	});
});
