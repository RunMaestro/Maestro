import { describe, it, expect } from 'vitest';
import {
	computeGitGraphLanes,
	gitGraphLaneEdge,
	jumpGitGraphAlongLane,
	pickBranchFromRefs,
	stepGitGraphAcrossLanes,
	stepGitGraphAlongLane,
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

	it('groups each lane oldest-first, which is what Up/Down walks', () => {
		expect(lanes.commitsOnLane.get('main')).toEqual(['c1', 'c2', 'm1']);
		expect(lanes.commitsOnLane.get('feature')).toEqual(['f1', 'f2']);
		// f2 is row 3 of the whole graph but only index 1 of its own lane.
		expect(lanes.rowOfCommit.get('f2')).toBe(3);
		expect(lanes.indexOnLane.get('f2')).toBe(1);
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

describe('stepGitGraphAlongLane', () => {
	const lanes = computeGitGraphLanes(FIXTURE);

	// Following one line is the whole point: the commits sitting between these on
	// other branches must be skipped, or Up/Down wanders across branches by itself
	// and leaves Left/Right with nothing to do.
	it('stays on the anchor lane and skips over other branches', () => {
		// c2 (main, row 2) -> m1 (main, row 4), stepping over f2 (feature, row 3).
		expect(stepGitGraphAlongLane(lanes, 'c2', 1)).toBe('m1');
		// c2 -> c1 (main, row 0), stepping over f1 (feature, row 1).
		expect(stepGitGraphAlongLane(lanes, 'c2', -1)).toBe('c1');
		// The feature lane walks its own two commits, never main's.
		expect(stepGitGraphAlongLane(lanes, 'f1', 1)).toBe('f2');
		expect(stepGitGraphAlongLane(lanes, 'f2', -1)).toBe('f1');
	});

	it('holds at both ends of the lane instead of spilling onto a neighbour', () => {
		expect(stepGitGraphAlongLane(lanes, 'm1', 1)).toBeNull();
		expect(stepGitGraphAlongLane(lanes, 'c1', -1)).toBeNull();
		// The feature lane's own ends, even though main has commits above/below.
		expect(stepGitGraphAlongLane(lanes, 'f2', 1)).toBeNull();
		expect(stepGitGraphAlongLane(lanes, 'f1', -1)).toBeNull();
	});

	it('returns null for an anchor that is not on the graph', () => {
		expect(stepGitGraphAlongLane(lanes, 'nope', 1)).toBeNull();
		expect(stepGitGraphAlongLane(lanes, undefined, 1)).toBeNull();
	});
});

describe('jumpGitGraphAlongLane and gitGraphLaneEdge', () => {
	const lanes = computeGitGraphLanes(FIXTURE);

	// A page jump near an end should REACH the end, unlike a single step, which
	// holds. Both stay on the lane.
	it('clamps a page jump to the ends of the current lane', () => {
		expect(jumpGitGraphAlongLane(lanes, 'm1', -10)).toBe('c1');
		expect(jumpGitGraphAlongLane(lanes, 'c1', 10)).toBe('m1');
		expect(jumpGitGraphAlongLane(lanes, 'f1', 10)).toBe('f2');
	});

	it('reports the tip and root of the anchor lane, not of the graph', () => {
		expect(gitGraphLaneEdge(lanes, 'c2', 'tip')).toBe('m1');
		expect(gitGraphLaneEdge(lanes, 'c2', 'root')).toBe('c1');
		expect(gitGraphLaneEdge(lanes, 'f2', 'tip')).toBe('f2');
		expect(gitGraphLaneEdge(lanes, 'f2', 'root')).toBe('f1');
	});

	it('returns null for an anchor that is not on the graph', () => {
		expect(jumpGitGraphAlongLane(lanes, undefined, 1)).toBeNull();
		expect(gitGraphLaneEdge(lanes, 'nope', 'tip')).toBeNull();
	});
});

describe('stepGitGraphAcrossLanes', () => {
	const lanes = computeGitGraphLanes(FIXTURE);

	it('lands on the commit nearest the current row in the neighbouring lane', () => {
		// From c2 (row 2, main) rightwards: feature's f1 (row 1) is as near as f2
		// (row 3), and the nearer-then-older tie keeps the jump predictable.
		expect(stepGitGraphAcrossLanes(lanes, 'c2', 1)).toBe('f1');
		expect(stepGitGraphAcrossLanes(lanes, 'f2', -1)).toBe('c2');
	});

	it('stops at the outermost lane rather than wrapping across the graph', () => {
		expect(stepGitGraphAcrossLanes(lanes, 'f1', 1)).toBeNull();
		expect(stepGitGraphAcrossLanes(lanes, 'c1', -1)).toBeNull();
	});

	it('returns null for an anchor that is not on the graph', () => {
		expect(stepGitGraphAcrossLanes(lanes, 'nope', 1)).toBeNull();
		expect(stepGitGraphAcrossLanes(lanes, undefined, -1)).toBeNull();
	});
});
