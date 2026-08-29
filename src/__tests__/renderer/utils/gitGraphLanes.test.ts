import { describe, it, expect } from 'vitest';
import {
	computeGitGraphLanes,
	pickBranchFromRefs,
	stepGitGraphLane,
	stepGitGraphRow,
} from '../../../renderer/utils/gitGraphLanes';
import type { GitGraphNode } from '../../../renderer/services/git';

const node = (
	hash: string,
	minute: number,
	parents: string[] = [],
	refs: string[] = []
): GitGraphNode => ({
	hash,
	shortHash: hash,
	parents,
	refs,
	author: 'Test Author',
	date: `2026-08-28T10:0${minute}:00Z`,
	subject: `commit ${hash}`,
});

// main:    c1 --- c2 ------ m1 (HEAD)
//                    \     /
// feature:  f1 ------ f2 --
// Rows (oldest first): c1=0, f1=1, c2=2, f2=3, m1=4.
const FIXTURE: GitGraphNode[] = [
	node('m1', 5, ['c2', 'f2'], ['HEAD -> main']),
	node('c1', 1, [], ['main']),
	node('f2', 4, ['f1']),
	node('f1', 2, ['c1'], ['feature']),
	node('c2', 3, ['c1']),
];

describe('pickBranchFromRefs', () => {
	it('prefers a local branch over a remote-tracking ref', () => {
		expect(pickBranchFromRefs(['origin/main', 'main'])).toBe('main');
	});

	it('strips the HEAD arrow and ignores tags', () => {
		expect(pickBranchFromRefs(['HEAD -> rc', 'tag: v1.0.0'])).toBe('rc');
		expect(pickBranchFromRefs(['tag: v1.0.0'])).toBeNull();
	});

	it('falls back to a remote ref when there is no local branch', () => {
		expect(pickBranchFromRefs(['origin/rc'])).toBe('origin/rc');
	});
});

describe('computeGitGraphLanes', () => {
	const lanes = computeGitGraphLanes(FIXTURE);

	it('orders commits oldest first, so a row index is the graph row', () => {
		expect(lanes.ordered.map((n) => n.hash)).toEqual(['c1', 'f1', 'c2', 'f2', 'm1']);
		expect(lanes.rowOfCommit.get('c1')).toBe(0);
		expect(lanes.rowOfCommit.get('m1')).toBe(4);
	});

	it('names a lane from the commit refs and lets children inherit it', () => {
		expect(lanes.laneOfCommit.get('c1')).toBe('main');
		// c2 carries no ref of its own, so it stays on its first parent's lane.
		expect(lanes.laneOfCommit.get('c2')).toBe('main');
		expect(lanes.laneOfCommit.get('f1')).toBe('feature');
		expect(lanes.laneOfCommit.get('f2')).toBe('feature');
		// A merge commit belongs to the lane it was committed on, not the source.
		expect(lanes.laneOfCommit.get('m1')).toBe('main');
	});

	it('lists lanes in first-appearance order, matching the left-to-right draw order', () => {
		expect(lanes.laneOrder).toEqual(['main', 'feature']);
	});

	it('opens an anonymous lane for a commit with no ref and no known parent', () => {
		const orphan = computeGitGraphLanes([node('x1', 1, ['missing'])]);
		expect(orphan.laneOfCommit.get('x1')).toBe('lane-1');
		expect(orphan.laneOrder).toEqual(['lane-1']);
	});

	it('handles an empty graph', () => {
		const empty = computeGitGraphLanes([]);
		expect(empty.ordered).toEqual([]);
		expect(empty.laneOrder).toEqual([]);
	});
});

describe('stepGitGraphRow', () => {
	const lanes = computeGitGraphLanes(FIXTURE);

	it('steps to the newer commit going up and the older one going down', () => {
		// The graph draws row 0 at the bottom, so +1 is visually upward.
		expect(stepGitGraphRow(lanes, 'c2', 1)).toBe('f2');
		expect(stepGitGraphRow(lanes, 'c2', -1)).toBe('f1');
	});

	it('holds at both ends instead of wrapping', () => {
		expect(stepGitGraphRow(lanes, 'm1', 1)).toBeNull();
		expect(stepGitGraphRow(lanes, 'c1', -1)).toBeNull();
	});

	it('returns null for an anchor that is not on the graph', () => {
		expect(stepGitGraphRow(lanes, 'nope', 1)).toBeNull();
		expect(stepGitGraphRow(lanes, undefined, 1)).toBeNull();
	});
});

describe('stepGitGraphLane', () => {
	const lanes = computeGitGraphLanes(FIXTURE);

	it('lands on the commit nearest the current row in the neighbouring lane', () => {
		// From c2 (row 2, main) rightwards: feature's f1 (row 1) is as near as f2
		// (row 3), and the nearer-then-older tie keeps the jump predictable.
		expect(stepGitGraphLane(lanes, 'c2', 1)).toBe('f1');
		expect(stepGitGraphLane(lanes, 'f2', -1)).toBe('c2');
	});

	it('stops at the outermost lane rather than wrapping across the graph', () => {
		expect(stepGitGraphLane(lanes, 'f1', 1)).toBeNull();
		expect(stepGitGraphLane(lanes, 'c1', -1)).toBeNull();
	});

	it('returns null for an anchor that is not on the graph', () => {
		expect(stepGitGraphLane(lanes, 'nope', 1)).toBeNull();
		expect(stepGitGraphLane(lanes, undefined, -1)).toBeNull();
	});
});
