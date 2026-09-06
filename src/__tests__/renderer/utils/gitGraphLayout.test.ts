import { describe, it, expect, vi } from 'vitest';
import {
	assignGitGraphBranches,
	buildGitGraphCore,
	buildGitGraphTemplate,
	computeGitGraphGeometry,
	gitGraphColumnEdge,
	gitGraphTopCommit,
	GIT_GRAPH_BRANCH_COLORS,
	jumpGitGraphVertical,
	pickBranchFromRefs,
	stepGitGraphHorizontal,
	stepGitGraphVertical,
} from '../../../renderer/utils/gitGraphLayout';
import type { GitGraphNode } from '../../../renderer/services/git';
import type { Theme } from '../../../renderer/types';

// Minimal theme stub - only the color fields the template reads.
const theme = {
	colors: {
		accent: 'rgb(1, 2, 3)',
		bgSidebar: 'rgb(10, 11, 12)',
		textMain: 'rgb(255, 255, 255)',
		border: 'rgb(50, 50, 50)',
	},
} as unknown as Theme;

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
// Committed oldest first: c1, f1, c2, f2, m1.
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

describe('buildGitGraphTemplate (issue #1278)', () => {
	const template = buildGitGraphTemplate(theme);

	it('uses the Maestro monospace stack for message, branch label, and tag fonts', () => {
		expect(template.commit.message.font).toContain('JetBrains Mono');
		expect(template.commit.message.font).toContain('monospace');
		expect(template.branch.label.font).toContain('monospace');
		expect(template.tag.font).toContain('monospace');
		// No sans-serif should remain anywhere in the typography.
		expect(template.commit.message.font).not.toContain('sans-serif');
		expect(template.branch.label.font).not.toContain('sans-serif');
	});

	it('does not hardcode a flat message color, so text inherits its branch color', () => {
		// @gitgraph only fills the message with the branch color when it is left
		// undefined (withDefaultColor). A static textMain would break branch coloring.
		expect(template.commit.message.color).toBeUndefined();
		expect(template.commit.message.color).not.toBe(theme.colors.textMain);
	});

	it('leaves branch label text/stroke unset so the pill matches its branch color', () => {
		expect(template.branch.label.color).toBeUndefined();
		expect(template.branch.label.strokeColor).toBeUndefined();
		// The pill background stays themed for legibility.
		expect(template.branch.label.bgColor).toBe(theme.colors.bgSidebar);
	});

	it('drives every branch color from the shared palette (line + text single source)', () => {
		const palette = GIT_GRAPH_BRANCH_COLORS(theme);
		expect(template.colors).toEqual(palette);
		// Theme accent leads the palette so the primary lane matches the app accent.
		expect(template.colors[0]).toBe(theme.colors.accent);
	});
});

describe('assignGitGraphBranches', () => {
	const { ordered, branchOfCommit } = assignGitGraphBranches(FIXTURE);

	it('builds the graph oldest first', () => {
		expect(ordered.map((n) => n.hash)).toEqual(['c1', 'f1', 'c2', 'f2', 'm1']);
	});

	it('names a branch from the commit refs and lets children inherit it', () => {
		expect(branchOfCommit.get('c1')).toBe('main');
		// c2 carries no ref of its own, so it stays on its first parent's branch.
		expect(branchOfCommit.get('c2')).toBe('main');
		expect(branchOfCommit.get('f1')).toBe('feature');
		expect(branchOfCommit.get('f2')).toBe('feature');
		// A merge commit belongs to the branch it was committed to, not the source.
		expect(branchOfCommit.get('m1')).toBe('main');
	});

	it('opens an anonymous lane for a commit with no ref and no known parent', () => {
		const orphan = assignGitGraphBranches([node('x1', 1, ['missing'])]);
		expect(orphan.branchOfCommit.get('x1')).toBe('lane-1');
	});
});

// The commit message is the biggest, most readable target a commit has, so it
// selects the same commit its dot does. Wiring only the dot leaves a 5px circle
// as the sole click target and makes clicking the text a user is reading a
// no-op.
describe('buildGitGraphCore click targets', () => {
	it('selects the commit from either its dot or its message', () => {
		const onCommitClick = vi.fn();
		const core = buildGitGraphCore(FIXTURE, {
			template: buildGitGraphTemplate(theme),
			onCommitClick,
		});
		const commit = core.getRenderedData().commits.find((c) => c.hash === 'c2')!;

		commit.onClick();
		expect(onCommitClick).toHaveBeenCalledWith('c2');

		onCommitClick.mockClear();
		commit.onMessageClick();
		expect(onCommitClick).toHaveBeenCalledWith('c2');
	});

	// Selection is drawn by the view's own dot renderer, never baked into the
	// core: a core rebuilt per keypress remounts the SVG, and the momentarily
	// empty scroll container resets to the top of the graph.
	it('hands every commit to the view dot renderer, with the size the line is drawn through', () => {
		const seen: Array<{ hash: string; size: number }> = [];
		const core = buildGitGraphCore<string>(FIXTURE, {
			template: buildGitGraphTemplate(theme),
			renderDot: (commit) => {
				seen.push({ hash: commit.hash, size: commit.style.dot.size });
				return commit.hash;
			},
		});
		const commits = core.getRenderedData().commits;

		expect(commits.every((c) => typeof c.renderDot === 'function')).toBe(true);
		commits.forEach((c) => c.renderDot!(c));
		expect(seen.map((s) => s.hash).sort()).toEqual(['c1', 'c2', 'f1', 'f2', 'm1']);
		// @gitgraph offsets the branch paths by exactly this, so a dot centered
		// anywhere else floats off its own line.
		expect(new Set(seen.map((s) => s.size))).toEqual(new Set([5]));
	});
});

// The geometry is @gitgraph's OWN answer, read back from getRenderedData(), so
// navigation moves by what is on screen instead of by an order re-derived
// beside the renderer.
describe('computeGitGraphGeometry', () => {
	const geometry = computeGitGraphGeometry(FIXTURE, theme);

	it('gives each branch its own column, ordered left to right', () => {
		expect(geometry.columns).toHaveLength(2);
		expect(geometry.columns[0]).toBeLessThan(geometry.columns[1]);
		const [mainColumn, featureColumn] = geometry.columns;
		expect(geometry.positionOfCommit.get('m1')?.x).toBe(mainColumn);
		expect(geometry.positionOfCommit.get('f2')?.x).toBe(featureColumn);
	});

	it('orders each column newest first, matching y growing downward', () => {
		const [mainColumn, featureColumn] = geometry.columns;
		expect(geometry.commitsInColumn.get(mainColumn)).toEqual(['m1', 'c2', 'c1']);
		expect(geometry.commitsInColumn.get(featureColumn)).toEqual(['f2', 'f1']);
		expect(geometry.positionOfCommit.get('m1')!.y).toBeLessThan(
			geometry.positionOfCommit.get('c1')!.y
		);
	});

	it('reports the commit drawn highest as the graph top', () => {
		expect(gitGraphTopCommit(geometry)).toBe('m1');
		expect(gitGraphTopCommit(computeGitGraphGeometry([], theme))).toBeUndefined();
	});

	it('handles an empty graph', () => {
		const empty = computeGitGraphGeometry([], theme);
		expect(empty.columns).toEqual([]);
		expect(empty.positionOfCommit.size).toBe(0);
	});
});

describe('stepGitGraphVertical', () => {
	const geometry = computeGitGraphGeometry(FIXTURE, theme);

	// Following one drawn line is the whole point: commits drawn between these in
	// other columns must be skipped, or Up/Down wanders across branches by itself
	// and leaves Left/Right with nothing to do.
	it('stays in the anchor column and skips commits drawn in others', () => {
		// c2 -> m1 up the main column, past f2, which is drawn between them.
		expect(stepGitGraphVertical(geometry, 'c2', 'up')).toBe('m1');
		// c2 -> c1 down the main column, past f1.
		expect(stepGitGraphVertical(geometry, 'c2', 'down')).toBe('c1');
		// The feature column walks its own two commits, never main's.
		expect(stepGitGraphVertical(geometry, 'f1', 'up')).toBe('f2');
		expect(stepGitGraphVertical(geometry, 'f2', 'down')).toBe('f1');
	});

	it('holds at both ends of the column instead of spilling sideways', () => {
		expect(stepGitGraphVertical(geometry, 'm1', 'up')).toBeNull();
		expect(stepGitGraphVertical(geometry, 'c1', 'down')).toBeNull();
		// The feature column's own ends, even though main is drawn above and below.
		expect(stepGitGraphVertical(geometry, 'f2', 'up')).toBeNull();
		expect(stepGitGraphVertical(geometry, 'f1', 'down')).toBeNull();
	});

	it('returns null for an anchor that is not on the graph', () => {
		expect(stepGitGraphVertical(geometry, 'nope', 'up')).toBeNull();
		expect(stepGitGraphVertical(geometry, undefined, 'up')).toBeNull();
	});
});

describe('jumpGitGraphVertical and gitGraphColumnEdge', () => {
	const geometry = computeGitGraphGeometry(FIXTURE, theme);

	// A page jump near an end should REACH the end, unlike a single step, which
	// holds. Both stay in the column.
	it('clamps a page jump to the ends of the current column', () => {
		expect(jumpGitGraphVertical(geometry, 'm1', 10)).toBe('c1');
		expect(jumpGitGraphVertical(geometry, 'c1', -10)).toBe('m1');
		expect(jumpGitGraphVertical(geometry, 'f1', -10)).toBe('f2');
	});

	it('reports the top and bottom of the anchor column, not of the graph', () => {
		expect(gitGraphColumnEdge(geometry, 'c2', 'top')).toBe('m1');
		expect(gitGraphColumnEdge(geometry, 'c2', 'bottom')).toBe('c1');
		expect(gitGraphColumnEdge(geometry, 'f2', 'top')).toBe('f2');
		expect(gitGraphColumnEdge(geometry, 'f2', 'bottom')).toBe('f1');
	});

	it('returns null for an anchor that is not on the graph', () => {
		expect(jumpGitGraphVertical(geometry, undefined, 1)).toBeNull();
		expect(gitGraphColumnEdge(geometry, 'nope', 'top')).toBeNull();
	});
});

describe('stepGitGraphHorizontal', () => {
	const geometry = computeGitGraphGeometry(FIXTURE, theme);

	// Sideways means sideways: the adjacent column, entered at the height the
	// user was already reading at, so the selection never teleports up or down.
	it('moves to the adjacent column at the nearest height', () => {
		// c2 sits exactly between f2 (above) and f1 (below); the tie goes upward.
		expect(stepGitGraphHorizontal(geometry, 'c2', 'right')).toBe('f2');
		// From the newest commit on main, the nearest feature commit is its tip.
		expect(stepGitGraphHorizontal(geometry, 'm1', 'right')).toBe('f2');
		// From main's root, the nearest feature commit is the feature root.
		expect(stepGitGraphHorizontal(geometry, 'c1', 'right')).toBe('f1');
	});

	// f2 is equidistant from m1 (above) and c2 (below), so the documented upward
	// tie-break decides it. Without a fixed rule the same keypress would answer
	// differently depending on map iteration order.
	it('breaks a height tie toward the newer commit', () => {
		expect(stepGitGraphHorizontal(geometry, 'f2', 'left')).toBe('m1');
	});

	it('stops at the outermost column rather than wrapping across the graph', () => {
		expect(stepGitGraphHorizontal(geometry, 'f1', 'right')).toBeNull();
		expect(stepGitGraphHorizontal(geometry, 'c1', 'left')).toBeNull();
	});

	it('returns null for an anchor that is not on the graph', () => {
		expect(stepGitGraphHorizontal(geometry, 'nope', 'right')).toBeNull();
		expect(stepGitGraphHorizontal(geometry, undefined, 'left')).toBeNull();
	});
});

// Pixel-level check on a busier graph: whichever commit a horizontal step lands
// on, no commit in that column may be drawn nearer the anchor's height. Computed
// here straight from the raw positions, so a regression in how the impl groups
// or orders a column shows up as a worse landing rather than as a passing test.
describe('a horizontal step lands on the nearest dot in that column', () => {
	// Two side branches cut in at different depths, so the nearest neighbour is a
	// different commit depending on where the anchor sits.
	const nodes: GitGraphNode[] = [
		node('a1', 1, [], ['main']),
		node('a2', 2, ['a1']),
		node('b1', 3, ['a2'], ['topic']),
		node('a3', 4, ['a2']),
		node('a4', 5, ['a3']),
		node('b2', 6, ['b1']),
		node('a5', 7, ['a4']),
		node('c1', 8, ['a5'], ['spike']),
		node('a6', 9, ['a5']),
	];
	const geometry = computeGitGraphGeometry(nodes, theme);

	const nearestIn = (column: number, y: number) => {
		let best = Infinity;
		for (const [hash, position] of geometry.positionOfCommit) {
			if (position.x !== column) continue;
			best = Math.min(best, Math.abs(position.y - y));
		}
		return best;
	};

	it('never leaves a nearer dot behind, from any commit, in either direction', () => {
		expect(geometry.columns.length).toBeGreaterThan(2);

		for (const [hash, position] of geometry.positionOfCommit) {
			const columnIndex = geometry.columns.indexOf(position.x);
			for (const direction of ['left', 'right'] as const) {
				const neighbour = geometry.columns[columnIndex + (direction === 'right' ? 1 : -1)];
				const landed = stepGitGraphHorizontal(geometry, hash, direction);

				if (neighbour === undefined) {
					// Nothing drawn that way, so the selection must hold.
					expect(landed).toBeNull();
					continue;
				}

				expect(landed).not.toBeNull();
				const landedAt = geometry.positionOfCommit.get(landed!)!;
				// It moved exactly one column over, and to the closest dot there.
				expect(landedAt.x).toBe(neighbour);
				expect(Math.abs(landedAt.y - position.y)).toBe(nearestIn(neighbour, position.y));
			}
		}
	});
});

// The column order has to be @gitgraph's, not first-appearance order: a branch
// whose first commit is recent can still be drawn in a column to the LEFT of an
// older one, and a hand-derived order sends Left/Right to a column somewhere
// else on screen.
describe('column order follows the drawn layout', () => {
	it('steps to the column actually adjacent on screen', () => {
		// Three branches. `side` opens late but @gitgraph decides where it lands.
		const nodes: GitGraphNode[] = [
			node('a1', 1, [], ['alpha']),
			node('b1', 2, ['a1'], ['beta']),
			node('a2', 3, ['a1']),
			node('s1', 4, ['a2'], ['sigma']),
			node('b2', 5, ['b1']),
		];
		const geometry = computeGitGraphGeometry(nodes, theme);
		expect(geometry.columns).toHaveLength(3);

		// Whatever the columns are, a right step lands in the very next one and a
		// left step comes back to the one it started from.
		const middleColumn = geometry.columns[1];
		const middleHash = geometry.commitsInColumn.get(middleColumn)![0];
		const right = stepGitGraphHorizontal(geometry, middleHash, 'right');
		const left = stepGitGraphHorizontal(geometry, middleHash, 'left');
		expect(geometry.positionOfCommit.get(right!)?.x).toBe(geometry.columns[2]);
		expect(geometry.positionOfCommit.get(left!)?.x).toBe(geometry.columns[0]);
	});
});
