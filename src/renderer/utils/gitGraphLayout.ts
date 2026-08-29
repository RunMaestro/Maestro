/**
 * Layout and navigation for the Git Log graph view.
 *
 * `GitGraphView` DRAWS the graph and `GitLogViewer` NAVIGATES it with the arrow
 * keys. Both go through this module, and both get their answer from the SAME
 * @gitgraph construction, because navigation here is VISUAL: an arrow key means
 * "the branch line drawn next to this one", not "the next entry in some list I
 * derived". Two derivations drift, and a horizontal jump that lands three
 * columns away loses the user's place on screen.
 *
 * The coordinate system is @gitgraph's own, read back from
 * `GitgraphCore.getRenderedData()`:
 * - `x` is the branch's COLUMN. Every branch gets a distinct x
 *   (`initCommitOffsetX + branch.spacing * order`), so a column IS a branch,
 *   and the columns sorted ascending read left to right on screen.
 * - `y` GROWS DOWNWARD and downward is older
 *   (`initCommitOffsetY + spacing * (maxRow - row)`), so the newest commit sits
 *   at the top of its column.
 *
 * Deriving the x order ourselves is exactly the bug this replaces: @gitgraph
 * orders its columns by when each branch first appears in ITS OWN commit
 * iteration, which is not the order a hand-written lane list produces, so
 * "one lane left" walked to a column somewhere else on screen.
 */

import { GitgraphCore, templateExtend, TemplateName } from '@gitgraph/core';
import type { Theme } from '../types';
import type { GitGraphNode } from '../services/git';

// @gitgraph/core does not re-export its `Template` type from the package index,
// so name it through the one factory that produces one.
type GitGraphTemplate = ReturnType<typeof templateExtend>;

// Maestro's monospace stack (mirrors `--font-mono` in index.css / tailwind.config).
// SVG font strings need a size prefix, so callers build `<px>px ${MONO_FONT}`.
const MONO_FONT = "'JetBrains Mono', 'Fira Code', 'Courier New', monospace";

// Branch/lane color palette. Every branch line, dot, message and label pill
// picks its color from here (via the branch's column), so a single source keeps
// text and its branch line in sync.
export const GIT_GRAPH_BRANCH_COLORS = (theme: Theme): string[] => [
	theme.colors.accent,
	'rgb(34, 197, 94)',
	'rgb(59, 130, 246)',
	'rgb(234, 179, 8)',
	'rgb(168, 85, 247)',
	'rgb(244, 63, 94)',
	'rgb(20, 184, 166)',
	'rgb(236, 72, 153)',
];

/**
 * Build the @gitgraph template from the active Maestro theme. Pure and
 * exported so its typography/color choices are unit-testable without mounting
 * an SVG (jsdom lacks getBBox, which @gitgraph's label layout needs).
 *
 * It lives beside the geometry because the geometry is derived from it: branch
 * `spacing` is the column pitch and commit `spacing` is the row pitch.
 */
export function buildGitGraphTemplate(theme: Theme): GitGraphTemplate {
	return templateExtend(TemplateName.Metro, {
		colors: GIT_GRAPH_BRANCH_COLORS(theme),
		branch: {
			lineWidth: 2,
			spacing: 14,
			label: {
				display: true,
				bgColor: theme.colors.bgSidebar,
				// Leave `color`/`strokeColor` unset so @gitgraph falls back to the
				// commit's branch color (see BranchLabel in @gitgraph/react), keeping
				// each branch pill in sync with its line/dot color.
				borderRadius: 4,
				font: `10px ${MONO_FONT}`,
			},
		},
		commit: {
			// Slightly tighter than the Metro default for a denser, neater log.
			spacing: 24,
			hasTooltipInCompactMode: false,
			dot: {
				size: 5,
				strokeWidth: 0,
			},
			message: {
				display: true,
				displayAuthor: false,
				displayHash: false,
				// Leave `color` unset so each commit message inherits its branch
				// color (@gitgraph's withDefaultColor fills it from the same source
				// as the branch line), instead of a flat textMain.
				font: `12px ${MONO_FONT}`,
			},
		},
		tag: {
			bgColor: 'rgba(234, 179, 8, 0.2)',
			color: 'rgb(234, 179, 8)',
			strokeColor: 'rgb(234, 179, 8)',
			borderRadius: 3,
			font: `9px ${MONO_FONT}`,
		},
	});
}

/**
 * Pull a branch label out of a commit's refs (e.g. "HEAD -> main, origin/main,
 * tag: v1"). Prefers local branches over remote-tracking refs; ignores tags.
 */
export function pickBranchFromRefs(refs: string[]): string | null {
	const cleaned = refs
		.map((r) => r.replace(/^HEAD -> /, '').trim())
		.filter((r) => r && !r.startsWith('tag:'));
	if (cleaned.length === 0) return null;
	const local = cleaned.find((r) => !r.includes('/'));
	return local || cleaned[0];
}

/**
 * Assign every commit to a branch, oldest first, which is the order the graph
 * is built in. A commit takes its branch from its own refs when it has one,
 * otherwise it stays on its first parent's branch, otherwise it opens an
 * anonymous `lane-N`.
 *
 * This decides which branch a commit is COMMITTED to. Where that branch is
 * DRAWN is @gitgraph's answer, read back as a column in the geometry below.
 */
export function assignGitGraphBranches(nodes: GitGraphNode[]): {
	ordered: GitGraphNode[];
	branchOfCommit: Map<string, string>;
} {
	const ordered = [...nodes].sort(
		(a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
	);

	const branchOfCommit = new Map<string, string>();
	let laneCounter = 0;

	for (const node of ordered) {
		const refBranch = pickBranchFromRefs(node.refs);
		const firstParent = node.parents[0];
		const inherited = firstParent ? (branchOfCommit.get(firstParent) ?? null) : null;
		branchOfCommit.set(node.hash, refBranch ?? inherited ?? `lane-${++laneCounter}`);
	}

	return { ordered, branchOfCommit };
}

export interface BuildGitGraphCoreOptions {
	template: GitGraphTemplate;
	/** Called with the commit hash when its dot or its message is clicked. */
	onCommitClick?: (hash: string) => void;
	/** Commit to draw with an enlarged, outlined dot. */
	selectedHash?: string;
	/** Stroke color for that outline. */
	selectionColor?: string;
}

/**
 * Build the populated `GitgraphCore` for a set of commits.
 *
 * Shared rather than inlined in the view because the geometry the keyboard
 * navigates by is read back out of a core built the same way. If the two
 * constructions could differ, an arrow key would move by a layout nobody is
 * looking at.
 */
export function buildGitGraphCore<TNode = SVGElement>(
	nodes: GitGraphNode[],
	{ template, onCommitClick, selectedHash, selectionColor }: BuildGitGraphCoreOptions
): GitgraphCore<TNode> {
	const core = new GitgraphCore<TNode>({ template });
	const api = core.getUserApi();
	const { ordered, branchOfCommit } = assignGitGraphBranches(nodes);

	const branches = new Map<string, ReturnType<typeof api.branch>>();
	const commitToBranch = new Map<string, ReturnType<typeof api.branch>>();

	const ensureBranch = (name: string, parentHash?: string) => {
		const existing = branches.get(name);
		if (existing) return existing;
		const parentBranch = parentHash ? commitToBranch.get(parentHash) : undefined;
		const created = parentBranch ? parentBranch.branch(name) : api.branch(name);
		branches.set(name, created);
		return created;
	};

	for (const node of ordered) {
		const firstParent = node.parents[0];
		const branch = ensureBranch(branchOfCommit.get(node.hash) ?? 'lane-0', firstParent);

		const subject = node.subject || '(no message)';
		const truncated = subject.length > 60 ? subject.slice(0, 57) + '…' : subject;
		// Pass the full hash so @gitgraph/react's internal React keys are unique;
		// shortHash (7 chars) can collide on busy `--all` ranges and cause React to
		// drop duplicate children → a blank graph. displayHash:false in the template
		// keeps the hash off the rendered label.
		const commitOptions = {
			hash: node.hash,
			subject: truncated,
			author: node.author,
			// The message is the biggest, most readable target for a commit, so it
			// selects the same commit the dot does. Without this only the 5px dot is
			// clickable, and clicking the text a user is reading does nothing.
			onClick: onCommitClick ? () => onCommitClick(node.hash) : undefined,
			onMessageClick: onCommitClick ? () => onCommitClick(node.hash) : undefined,
			style:
				selectedHash && selectedHash === node.hash
					? { dot: { size: 10, strokeWidth: 2, strokeColor: selectionColor } }
					: undefined,
		};

		if (node.parents.length >= 2) {
			const sourceBranch = commitToBranch.get(node.parents[1]);
			if (sourceBranch) {
				branch.merge({ branch: sourceBranch, commitOptions });
			} else {
				branch.commit(commitOptions);
			}
		} else {
			branch.commit(commitOptions);
		}

		commitToBranch.set(node.hash, branch);

		// Attach tag refs (skip duplicate branch labels - gitgraph adds those automatically).
		for (const ref of node.refs) {
			const cleaned = ref.replace(/^HEAD -> /, '').trim();
			if (cleaned.startsWith('tag:')) {
				branch.tag(cleaned.replace(/^tag:\s*/, ''));
			}
		}
	}

	return core;
}

export interface GitGraphGeometry {
	/** Drawn position of each commit, in @gitgraph's own coordinate space. */
	positionOfCommit: Map<string, { x: number; y: number }>;
	/** Distinct column x values, ascending - i.e. left to right on screen. */
	columns: number[];
	/** Hashes in each column, sorted by y ascending: newest (top) first. */
	commitsInColumn: Map<number, string[]>;
	/** Each commit's index within its own column's top-to-bottom list. */
	indexInColumn: Map<string, number>;
}

const EMPTY_GEOMETRY: GitGraphGeometry = {
	positionOfCommit: new Map(),
	columns: [],
	commitsInColumn: new Map(),
	indexInColumn: new Map(),
};

/**
 * Where every commit is actually drawn, grouped into the columns the user sees.
 *
 * `getRenderedData()` is pure computation (no DOM), so this is safe to call
 * outside a render and in tests.
 */
export function computeGitGraphGeometry(nodes: GitGraphNode[], theme: Theme): GitGraphGeometry {
	if (nodes.length === 0) return EMPTY_GEOMETRY;

	const core = buildGitGraphCore(nodes, { template: buildGitGraphTemplate(theme) });
	const { commits } = core.getRenderedData();

	const positionOfCommit = new Map<string, { x: number; y: number }>();
	const commitsInColumn = new Map<number, string[]>();
	for (const commit of commits) {
		positionOfCommit.set(commit.hash, { x: commit.x, y: commit.y });
		const column = commitsInColumn.get(commit.x);
		if (column) column.push(commit.hash);
		else commitsInColumn.set(commit.x, [commit.hash]);
	}

	const indexInColumn = new Map<string, number>();
	for (const [, hashes] of commitsInColumn) {
		// Top of the screen first, so "one step up" is one step back through this
		// list regardless of the order @gitgraph happened to emit the commits in.
		hashes.sort((a, b) => (positionOfCommit.get(a)?.y ?? 0) - (positionOfCommit.get(b)?.y ?? 0));
		hashes.forEach((hash, index) => indexInColumn.set(hash, index));
	}

	const columns = [...commitsInColumn.keys()].sort((a, b) => a - b);

	return { positionOfCommit, columns, commitsInColumn, indexInColumn };
}

/**
 * The commit drawn highest on screen, i.e. the newest in the whole graph. Used
 * as the anchor when nothing on the graph is selected yet: a key that answers
 * with nothing reads as broken, so every key needs somewhere to start.
 */
export function gitGraphTopCommit(geometry: GitGraphGeometry): string | undefined {
	let best: { hash: string; y: number } | undefined;
	for (const [hash, position] of geometry.positionOfCommit) {
		if (!best || position.y < best.y) best = { hash, y: position.y };
	}
	return best?.hash;
}

/** The column a commit is drawn in, plus its place down that column. */
function locate(
	geometry: GitGraphGeometry,
	hash: string | undefined
): { hashes: string[]; index: number; x: number; y: number } | null {
	if (!hash) return null;
	const position = geometry.positionOfCommit.get(hash);
	if (!position) return null;
	const hashes = geometry.commitsInColumn.get(position.x);
	const index = geometry.indexInColumn.get(hash);
	if (!hashes || index === undefined) return null;
	return { hashes, index, x: position.x, y: position.y };
}

/**
 * Step one commit along the CURRENT column: `'up'` is the next commit drawn
 * above (newer), `'down'` the next one below (older). Commits drawn between
 * them in other columns are skipped, because the user asked to follow one line.
 *
 * Returns null at either end of the column rather than wrapping or spilling
 * sideways - crossing branches is what the horizontal step is for.
 */
export function stepGitGraphVertical(
	geometry: GitGraphGeometry,
	fromHash: string | undefined,
	direction: 'up' | 'down'
): string | null {
	const at = locate(geometry, fromHash);
	if (!at) return null;
	const target = at.index + (direction === 'up' ? -1 : 1);
	if (target < 0 || target >= at.hashes.length) return null;
	return at.hashes[target];
}

/**
 * Move `delta` commits down the current column (negative moves up), CLAMPED to
 * its ends. Use it for jumps meant to land somewhere definite (a page, the top,
 * the bottom): a page jump near an end should reach the end rather than refuse
 * to move, which is the opposite of what a single step should do.
 */
export function jumpGitGraphVertical(
	geometry: GitGraphGeometry,
	fromHash: string | undefined,
	delta: number
): string | null {
	const at = locate(geometry, fromHash);
	if (!at) return null;
	const clamped = Math.min(Math.max(at.index + delta, 0), at.hashes.length - 1);
	return at.hashes[clamped];
}

/** The topmost (newest) or bottommost (oldest) commit of the anchor's column. */
export function gitGraphColumnEdge(
	geometry: GitGraphGeometry,
	fromHash: string | undefined,
	edge: 'top' | 'bottom'
): string | null {
	const at = locate(geometry, fromHash);
	if (!at) return null;
	return edge === 'top' ? at.hashes[0] : at.hashes[at.hashes.length - 1];
}

/**
 * Move to the branch line drawn immediately to the left or right, landing on
 * whichever of its commits is drawn CLOSEST TO THE CURRENT HEIGHT.
 *
 * Both halves of that are what keeps the user's place: the next column over is
 * the one they can see beside them, and staying at the same height means the
 * selection moves sideways rather than teleporting to some branch's tip. Ties
 * resolve upward (the newer commit) so a jump and a jump back are stable.
 *
 * The ends do not wrap: wrapping across the whole graph reads as a jump to a
 * random branch rather than as a step.
 */
export function stepGitGraphHorizontal(
	geometry: GitGraphGeometry,
	fromHash: string | undefined,
	direction: 'left' | 'right'
): string | null {
	const at = locate(geometry, fromHash);
	if (!at) return null;

	const columnIndex = geometry.columns.indexOf(at.x);
	if (columnIndex < 0) return null;
	const nextColumn = geometry.columns[columnIndex + (direction === 'right' ? 1 : -1)];
	if (nextColumn === undefined) return null;

	const hashes = geometry.commitsInColumn.get(nextColumn);
	if (!hashes || hashes.length === 0) return null;

	let best: { hash: string; distance: number } | null = null;
	for (const hash of hashes) {
		const distance = Math.abs((geometry.positionOfCommit.get(hash)?.y ?? 0) - at.y);
		if (!best || distance < best.distance) best = { hash, distance };
	}
	return best?.hash ?? null;
}
