// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/renderer/utils/concertoLinks.test.ts
// Source: src/__tests__/renderer/utils/gitGraphLayout.test.ts
// Source: src/__tests__/renderer/utils/groupChatExport.test.ts
// Source: src/__tests__/renderer/utils/groupChatOrdering.test.ts
// Source: src/__tests__/renderer/utils/labelWidth.test.ts
// Source: src/__tests__/renderer/utils/tokenCounter.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { parseConcertoHref, flashConcertoTarget } from '../../../renderer/utils/concertoLinks';
import { applyMovementPayload, useMovementStore } from '../../../renderer/stores/movementStore';
import { useCadenzaStore } from '../../../renderer/stores/cadenzaStore';
import { getModalActions, useModalStore } from '../../../renderer/stores/modalStore';
import {
	assignGitGraphBranches,
	buildGitGraphCore,
	buildGitGraphTemplate,
	computeGitGraphGeometry,
	contractGitGraphNodes,
	gitGraphColumnEdge,
	gitGraphTopCommit,
	GIT_GRAPH_BRANCH_COLORS,
	jumpGitGraphVertical,
	pickBranchFromRefs,
	stepGitGraphHorizontal,
	stepGitGraphVertical,
} from '../../../renderer/utils/gitGraphLayout';
import type { GitGraphNode } from '../../../renderer/services/git';
import type { Theme as S2_Theme } from '../../../renderer/types';
import { generateGroupChatExportHtml } from '../../../renderer/utils/groupChatExport';
import { mockTheme } from '../../helpers/mockTheme';
import type {
	GroupChat,
	GroupChatMessage,
	GroupChatHistoryEntry,
	Theme as S3_Theme,
} from '../../../renderer/types';
import {
	orderGroupChatsForDisplay,
	pickNextGroupChatIdAfterDelete,
} from '../../../renderer/utils/groupChatOrdering';
import { estimateLabelWidth, widestLabelWidth } from '../../../renderer/utils/labelWidth';
import {
	countTokens,
	estimateTokens,
	formatTokenCount,
	getEncoder,
} from '../../../renderer/utils/tokenCounter';
// Source: src/__tests__/renderer/utils/concertoLinks.test.ts
describe('', () => {
	describe('parseConcertoHref', () => {
		it('parses the canonical maestro:// form for both surfaces', () => {
			expect(parseConcertoHref('maestro://concerto/movement/deploy-status')).toEqual({
				surface: 'movement',
				id: 'deploy-status',
			});
			expect(parseConcertoHref('maestro://concerto/cadenza/tests')).toEqual({
				surface: 'cadenza',
				id: 'tests',
			});
		});
		it('parses the bare concerto: fallback form', () => {
			expect(parseConcertoHref('concerto:movement/foo')).toEqual({
				surface: 'movement',
				id: 'foo',
			});
		});
		it('decodes a percent-encoded id', () => {
			expect(parseConcertoHref('maestro://concerto/movement/a%2Fb')).toEqual({
				surface: 'movement',
				id: 'a/b',
			});
		});
		it('is case-insensitive on scheme and surface', () => {
			expect(parseConcertoHref('MAESTRO://CONCERTO/MOVEMENT/x')).toEqual({
				surface: 'movement',
				id: 'x',
			});
		});
		it('returns null for non-concerto, empty-id, unknown-surface, and nullish hrefs', () => {
			expect(parseConcertoHref('https://example.com')).toBeNull();
			expect(parseConcertoHref('maestro://concerto/movement/')).toBeNull();
			expect(parseConcertoHref('maestro://concerto/bogus/x')).toBeNull();
			expect(parseConcertoHref('')).toBeNull();
			expect(parseConcertoHref(null)).toBeNull();
			expect(parseConcertoHref(undefined)).toBeNull();
		});
	});
	describe('flashConcertoTarget', () => {
		let flashCadenza: ReturnType<typeof vi.fn>;
		let setCadenzasHidden: ReturnType<typeof vi.fn>;
		let origMaestro: unknown;
		const win = window as unknown as {
			maestro: unknown;
		};
		beforeEach(() => {
			vi.useFakeTimers();
			useMovementStore.setState({ items: [], dismissedItems: [], flashedId: null });
			useCadenzaStore.setState({ cadenzas: [], hidden: true, flashedId: null });
			getModalActions().setConcertoStageOpen(false);
			flashCadenza = vi.fn();
			setCadenzasHidden = vi.fn();
			origMaestro = win.maestro;
			win.maestro = {
				process: {
					flashCadenza,
					setCadenzasHidden,
					restoreConcertoHtmlDocument: vi.fn().mockResolvedValue(17),
				},
			};
		});
		afterEach(() => {
			vi.clearAllTimers();
			vi.useRealTimers();
			win.maestro = origMaestro;
		});
		it('flashes the movement store and reopens the closed stage for a live movement href', async () => {
			applyMovementPayload({ op: 'add', id: 'deploy' });
			getModalActions().setConcertoStageOpen(false);
			await expect(flashConcertoTarget('maestro://concerto/movement/deploy')).resolves.toBe(true);
			expect(useMovementStore.getState().flashedId).toBe('deploy');
			expect(useModalStore.getState().isOpen('concertoStage')).toBe(true);
		});
		it('restores a dismissed HTML movement as a fresh document', async () => {
			applyMovementPayload({
				op: 'add',
				id: 'mockup',
				viewType: 'html',
				body: '<button>Fresh</button>',
				revision: 3,
			});
			useMovementStore.getState().dismissItem('mockup');
			await expect(flashConcertoTarget('maestro://concerto/movement/mockup')).resolves.toBe(true);
			expect((win.maestro as any).process.restoreConcertoHtmlDocument).toHaveBeenCalledWith(
				'movement',
				'mockup',
				'<button>Fresh</button>'
			);
			expect(useMovementStore.getState().items).toMatchObject([
				{ id: 'mockup', timestamp: 17, minimized: false },
			]);
			expect(useMovementStore.getState().dismissedItems).toEqual([]);
		});
		it('returns false when the movement is neither live nor recently dismissed', async () => {
			await expect(flashConcertoTarget('maestro://concerto/movement/missing')).resolves.toBe(false);
			expect(useMovementStore.getState().flashedId).toBeNull();
		});
		it('routes a cadenza href through main (flashCadenza), since cadenzas live in the HUD', async () => {
			await expect(flashConcertoTarget('maestro://concerto/cadenza/tests')).resolves.toBe(true);
			expect(flashCadenza).toHaveBeenCalledWith('tests');
		});
		it('un-stashes cadenzas in both renderers before pointing at one', async () => {
			await expect(flashConcertoTarget('maestro://concerto/cadenza/tests')).resolves.toBe(true);
			expect(useCadenzaStore.getState().hidden).toBe(false);
			expect(setCadenzasHidden).toHaveBeenCalledWith(false);
		});
		it('is a no-op returning false for a non-concerto href', async () => {
			await expect(flashConcertoTarget('https://example.com')).resolves.toBe(false);
			expect(useMovementStore.getState().flashedId).toBeNull();
			expect(flashCadenza).not.toHaveBeenCalled();
		});
	});
});
// Source: src/__tests__/renderer/utils/gitGraphLayout.test.ts
describe('', () => {
	// Minimal theme stub - only the color fields the template reads.
	const theme = {
		colors: {
			accent: 'rgb(1, 2, 3)',
			bgSidebar: 'rgb(10, 11, 12)',
			textMain: 'rgb(255, 255, 255)',
			border: 'rgb(50, 50, 50)',
		},
	} as unknown as S2_Theme;
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
			const seen: Array<{
				hash: string;
				size: number;
			}> = [];
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
	// Filtering a graph must not filter the LINES out of it. A survivor whose
	// parent was dropped has to inherit the nearest kept ancestor, or the view
	// degenerates into unconnected dots - strictly less than the list beside it.
	describe('contractGitGraphNodes', () => {
		it('returns the same array when nothing is filtered out', () => {
			expect(contractGitGraphNodes(FIXTURE, () => true)).toBe(FIXTURE);
		});
		it('reattaches a survivor to the nearest kept ancestor', () => {
			// Drop c2, which sat between c1 and the merge m1.
			const kept = contractGitGraphNodes(FIXTURE, (n) => n.hash !== 'c2');
			expect(kept.map((n) => n.hash).sort()).toEqual(['c1', 'f1', 'f2', 'm1']);
			expect(kept.find((n) => n.hash === 'm1')?.parents).toEqual(['c1', 'f2']);
		});
		it('walks through a whole run of dropped commits', () => {
			const kept = contractGitGraphNodes(FIXTURE, (n) => n.hash === 'm1' || n.hash === 'c1');
			expect(kept.find((n) => n.hash === 'm1')?.parents).toEqual(['c1']);
		});
		it('keeps first-parent order, which decides the branch a commit stays on', () => {
			const kept = contractGitGraphNodes(FIXTURE, (n) => n.hash !== 'f2');
			// f2 was the SECOND parent of m1, so its replacement (f1) stays second.
			expect(kept.find((n) => n.hash === 'm1')?.parents).toEqual(['c2', 'f1']);
		});
		it('keeps both lines a dropped merge joined', () => {
			// m1 itself is filtered out, and a child of it would inherit c2 and f2.
			const nodes = [...FIXTURE, node('x1', 6, ['m1'])];
			const kept = contractGitGraphNodes(nodes, (n) => n.hash !== 'm1');
			expect(kept.find((n) => n.hash === 'x1')?.parents).toEqual(['c2', 'f2']);
		});
		it('ends the line at a parent outside the fetched window', () => {
			// c1's parent is unknown here, exactly as it is at the edge of --max-count.
			const kept = contractGitGraphNodes([node('z1', 1, ['not-fetched'])], () => true);
			expect(kept[0].parents).toEqual(['not-fetched']);
			const filtered = contractGitGraphNodes(
				[node('z1', 1, ['not-fetched']), node('z2', 2, ['z1'])],
				(n) => n.hash !== 'z1'
			);
			expect(filtered.map((n) => n.hash)).toEqual(['z2']);
			expect(filtered[0].parents).toEqual([]);
		});
		it('leaves a graph the filter empties as an empty graph', () => {
			expect(contractGitGraphNodes(FIXTURE, () => false)).toEqual([]);
		});
		it('produces a graph the geometry can still lay out in one column', () => {
			// c1 -> c2 -> m1 with the feature branch filtered away: one branch line.
			const kept = contractGitGraphNodes(FIXTURE, (n) => !n.hash.startsWith('f'));
			const geometry = computeGitGraphGeometry(kept, theme);
			expect(geometry.columns).toHaveLength(1);
			expect(geometry.commitsInColumn.get(geometry.columns[0])).toEqual(['m1', 'c2', 'c1']);
		});
	});
});
// Source: src/__tests__/renderer/utils/groupChatExport.test.ts
describe('', () => {
	// Mock theme for testing
	// Mock data factories
	function createMockGroupChat(overrides?: Partial<GroupChat>): GroupChat {
		return {
			id: 'test-group-chat-id',
			name: 'Test Group Chat',
			createdAt: 1703116800000, // 2023-12-21T00:00:00.000Z
			moderatorAgentId: 'claude-code',
			moderatorSessionId: 'mod-session-123',
			participants: [
				{
					name: 'Agent1',
					agentId: 'claude-code',
					sessionId: 'agent1-session',
					addedAt: 1703116800000,
					color: '#3b82f6',
				},
				{
					name: 'Agent2',
					agentId: 'claude-code',
					sessionId: 'agent2-session',
					addedAt: 1703116900000,
					color: '#10b981',
				},
			],
			logPath: '/path/to/chat.log',
			imagesDir: '/path/to/images',
			...overrides,
		};
	}
	function createMockMessages(count = 3): GroupChatMessage[] {
		const messages: GroupChatMessage[] = [];
		const baseTime = new Date('2023-12-21T10:00:00.000Z').getTime();
		for (let i = 0; i < count; i++) {
			const isUser = i % 3 === 0;
			const fromOptions = isUser ? 'user' : i % 3 === 1 ? 'Agent1' : 'Agent2';
			messages.push({
				timestamp: new Date(baseTime + i * 60000).toISOString(),
				from: fromOptions,
				content: `Message ${i + 1} content`,
			});
		}
		return messages;
	}
	function createMockHistory(): GroupChatHistoryEntry[] {
		return [
			{
				id: 'history-1',
				timestamp: 1703120400000,
				summary: 'Delegated task to Agent1',
				participantName: 'moderator',
				participantColor: '#f59e0b',
				type: 'delegation',
			},
			{
				id: 'history-2',
				timestamp: 1703120500000,
				summary: 'Agent1 completed analysis',
				participantName: 'Agent1',
				participantColor: '#3b82f6',
				type: 'response',
				elapsedTimeMs: 5000,
				tokenCount: 150,
			},
		];
	}
	describe('groupChatExport', () => {
		describe('generateGroupChatExportHtml', () => {
			describe('basic HTML structure', () => {
				it('generates valid HTML document', () => {
					const groupChat = createMockGroupChat();
					const messages = createMockMessages();
					const history = createMockHistory();
					const html = generateGroupChatExportHtml(groupChat, messages, history, {}, mockTheme);
					expect(html).toContain('<!DOCTYPE html>');
					expect(html).toContain('<html lang="en">');
					expect(html).toContain('</html>');
					expect(html).toContain('<head>');
					expect(html).toContain('</head>');
					expect(html).toContain('<body>');
					expect(html).toContain('</body>');
				});
				it('includes group chat name in title', () => {
					const groupChat = createMockGroupChat({ name: 'My Custom Chat' });
					const messages = createMockMessages();
					const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);
					expect(html).toContain('<title>My Custom Chat - Maestro Group Chat Export</title>');
				});
				it('includes group chat name in header', () => {
					const groupChat = createMockGroupChat({ name: 'Test Chat Name' });
					const messages = createMockMessages();
					const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);
					expect(html).toContain('Test Chat Name');
				});
				it('includes embedded CSS styles', () => {
					const groupChat = createMockGroupChat();
					const messages = createMockMessages();
					const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);
					expect(html).toContain('<style>');
					expect(html).toContain('</style>');
					expect(html).toContain('--bg-primary');
					expect(html).toContain('--text-primary');
				});
			});
			describe('branding', () => {
				it('includes Maestro branding section', () => {
					const groupChat = createMockGroupChat();
					const messages = createMockMessages();
					const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);
					expect(html).toContain('class="branding"');
					expect(html).toContain('Maestro');
					expect(html).toContain('Multi-agent orchestration');
				});
				it('includes runmaestro.ai link', () => {
					const groupChat = createMockGroupChat();
					const messages = createMockMessages();
					const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);
					expect(html).toContain('href="https://runmaestro.ai"');
					expect(html).toContain('runmaestro.ai');
				});
				it('includes GitHub link', () => {
					const groupChat = createMockGroupChat();
					const messages = createMockMessages();
					const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);
					expect(html).toContain('href="https://github.com/RunMaestro/Maestro"');
					expect(html).toContain('GitHub');
				});
				it('includes Maestro logo SVG', () => {
					const groupChat = createMockGroupChat();
					const messages = createMockMessages();
					const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);
					expect(html).toContain('class="branding-logo"');
					expect(html).toContain('<svg');
				});
			});
			describe('theme colors', () => {
				it('uses theme colors in CSS variables', () => {
					const groupChat = createMockGroupChat();
					const messages = createMockMessages();
					const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);
					expect(html).toContain('--bg-primary: #282a36');
					expect(html).toContain('--bg-secondary: #21222c');
					expect(html).toContain('--text-primary: #f8f8f2');
					expect(html).toContain('--accent: #bd93f9');
				});
				it('includes theme name in footer', () => {
					const groupChat = createMockGroupChat();
					const messages = createMockMessages();
					const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);
					expect(html).toContain('Theme: Dracula');
				});
				it('uses different theme colors when provided', () => {
					const groupChat = createMockGroupChat();
					const messages = createMockMessages();
					const lightTheme: S3_Theme = {
						id: 'github-light',
						name: 'GitHub Light',
						mode: 'light',
						colors: {
							bgMain: '#ffffff',
							bgSidebar: '#f6f8fa',
							bgActivity: '#f0f0f0',
							border: '#d0d7de',
							textMain: '#24292f',
							textDim: '#57606a',
							accent: '#0969da',
							accentDim: 'rgba(9, 105, 218, 0.1)',
							accentText: '#0969da',
							accentForeground: '#ffffff',
							success: '#1a7f37',
							warning: '#9a6700',
							error: '#cf222e',
						},
					};
					const html = generateGroupChatExportHtml(groupChat, messages, [], {}, lightTheme);
					expect(html).toContain('--bg-primary: #ffffff');
					expect(html).toContain('--accent: #0969da');
					expect(html).toContain('Theme: GitHub Light');
				});
			});
			describe('statistics', () => {
				it('calculates correct participant count', () => {
					const groupChat = createMockGroupChat();
					const messages = createMockMessages();
					const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);
					// Stats should show in HTML
					expect(html).toContain('<div class="stat-value">2</div>');
				});
				it('calculates correct total message count', () => {
					const groupChat = createMockGroupChat();
					const messages = createMockMessages(10);
					const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);
					expect(html).toContain('<div class="stat-value">10</div>');
				});
				it('displays stats in HTML', () => {
					const groupChat = createMockGroupChat();
					const messages = createMockMessages(5);
					const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);
					// Check for stats cards
					expect(html).toContain('Agents');
					expect(html).toContain('Messages');
					expect(html).toContain('Agent Replies');
					expect(html).toContain('Working');
					expect(html).toContain('Tokens');
					expect(html).toContain('Cost');
				});
				it('reports working time from the history log, not the message span', () => {
					const groupChat = createMockGroupChat();
					const messages = createMockMessages(5);
					const start = Date.parse('2023-12-21T10:00:00Z');
					const history: GroupChatHistoryEntry[] = [
						{
							id: 'h1',
							timestamp: start + 120000,
							summary: 'worked',
							participantName: 'Agent1',
							participantColor: '#fff',
							type: 'response',
							elapsedTimeMs: 120000,
							tokenCount: 1500,
							cost: 0.42,
						},
					];
					const html = generateGroupChatExportHtml(groupChat, messages, history, {}, mockTheme);
					expect(html).toContain('<div class="stat-value">2m</div>');
					expect(html).toContain('<div class="stat-value">~2K</div>');
					expect(html).toContain('<div class="stat-value">$0.42</div>');
				});
				it('reports tokens as unknown rather than zero when no turn recorded usage', () => {
					const groupChat = createMockGroupChat();
					const html = generateGroupChatExportHtml(
						groupChat,
						createMockMessages(5),
						[],
						{},
						mockTheme
					);
					expect(html).toContain('<div class="stat-value">-</div>');
				});
			});
			describe('message rendering', () => {
				it('renders user messages with user class', () => {
					const groupChat = createMockGroupChat();
					const messages: GroupChatMessage[] = [
						{ timestamp: '2023-12-21T10:00:00Z', from: 'user', content: 'Hello' },
					];
					const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);
					expect(html).toContain('message-user');
				});
				it('renders agent messages with agent class', () => {
					const groupChat = createMockGroupChat();
					const messages: GroupChatMessage[] = [
						{ timestamp: '2023-12-21T10:00:00Z', from: 'Agent1', content: 'Response' },
					];
					const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);
					expect(html).toContain('message-agent');
				});
				it('shows read-only badge for read-only messages', () => {
					const groupChat = createMockGroupChat();
					const messages: GroupChatMessage[] = [
						{ timestamp: '2023-12-21T10:00:00Z', from: 'user', content: 'Query', readOnly: true },
					];
					const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);
					expect(html).toContain('read-only');
				});
				it('includes message timestamps', () => {
					const groupChat = createMockGroupChat();
					const messages: GroupChatMessage[] = [
						{ timestamp: '2023-12-21T10:30:00Z', from: 'user', content: 'Test' },
					];
					const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);
					expect(html).toContain('message-time');
				});
				it('uses participant colors from groupChat', () => {
					const groupChat = createMockGroupChat({
						participants: [
							{
								name: 'ColoredAgent',
								agentId: 'claude-code',
								sessionId: 's1',
								addedAt: 0,
								color: '#ff5500',
							},
						],
					});
					const messages: GroupChatMessage[] = [
						{ timestamp: '2023-12-21T10:00:00Z', from: 'ColoredAgent', content: 'Hi' },
					];
					const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);
					expect(html).toContain('#ff5500');
				});
				it('uses theme accent color for user messages', () => {
					const groupChat = createMockGroupChat();
					const messages: GroupChatMessage[] = [
						{ timestamp: '2023-12-21T10:00:00Z', from: 'user', content: 'Hello' },
					];
					const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);
					// User messages should use theme accent color
					expect(html).toContain(`style="color: ${mockTheme.colors.accent}"`);
				});
			});
			describe('markdown rendering with marked library', () => {
				it('renders tables correctly', () => {
					const groupChat = createMockGroupChat();
					const messages: GroupChatMessage[] = [
						{
							timestamp: '2023-12-21T10:00:00Z',
							from: 'Agent1',
							content: '| A | B |\n|---|---|\n| 1 | 2 |',
						},
					];
					const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);
					expect(html).toContain('<table>');
					expect(html).toContain('<th>');
					expect(html).toContain('<td>');
				});
				it('renders horizontal rules correctly', () => {
					const groupChat = createMockGroupChat();
					const messages: GroupChatMessage[] = [
						{
							timestamp: '2023-12-21T10:00:00Z',
							from: 'Agent1',
							content: 'Before\n\n---\n\nAfter',
						},
					];
					const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);
					expect(html).toContain('<hr');
				});
				it('converts inline code to HTML code tags', () => {
					const groupChat = createMockGroupChat();
					const messages: GroupChatMessage[] = [
						{
							timestamp: '2023-12-21T10:00:00Z',
							from: 'Agent1',
							content: 'Use `npm install` to install',
						},
					];
					const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);
					expect(html).toContain('<code>npm install</code>');
				});
				it('converts code blocks to pre tags', () => {
					const groupChat = createMockGroupChat();
					const messages: GroupChatMessage[] = [
						{
							timestamp: '2023-12-21T10:00:00Z',
							from: 'Agent1',
							content: '```javascript\nconst x = 1;\n```',
						},
					];
					const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);
					expect(html).toContain('<pre>');
					expect(html).toContain('const x = 1;');
				});
				it('converts bold markdown to strong tags', () => {
					const groupChat = createMockGroupChat();
					const messages: GroupChatMessage[] = [
						{ timestamp: '2023-12-21T10:00:00Z', from: 'Agent1', content: 'This is **important**' },
					];
					const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);
					expect(html).toContain('<strong>important</strong>');
				});
				it('converts italic markdown to em tags', () => {
					const groupChat = createMockGroupChat();
					const messages: GroupChatMessage[] = [
						{ timestamp: '2023-12-21T10:00:00Z', from: 'Agent1', content: 'This is *emphasized*' },
					];
					const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);
					expect(html).toContain('<em>emphasized</em>');
				});
				it('converts markdown headers', () => {
					const groupChat = createMockGroupChat();
					const messages: GroupChatMessage[] = [
						{
							timestamp: '2023-12-21T10:00:00Z',
							from: 'Agent1',
							content: '# Heading 1\n\n## Heading 2\n\n### Heading 3',
						},
					];
					const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);
					expect(html).toContain('<h1');
					expect(html).toContain('Heading 1');
					expect(html).toContain('<h2');
					expect(html).toContain('Heading 2');
					expect(html).toContain('<h3');
					expect(html).toContain('Heading 3');
				});
				it('converts markdown bullet lists', () => {
					const groupChat = createMockGroupChat();
					const messages: GroupChatMessage[] = [
						{ timestamp: '2023-12-21T10:00:00Z', from: 'Agent1', content: '- Item 1\n- Item 2' },
					];
					const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);
					expect(html).toContain('<li>Item 1</li>');
					expect(html).toContain('<li>Item 2</li>');
					expect(html).toContain('<ul>');
				});
				it('converts markdown links', () => {
					const groupChat = createMockGroupChat();
					const messages: GroupChatMessage[] = [
						{
							timestamp: '2023-12-21T10:00:00Z',
							from: 'Agent1',
							content: 'Check [this link](https://example.com)',
						},
					];
					const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);
					expect(html).toContain('href="https://example.com"');
					expect(html).toContain('this link');
				});
				it('converts blockquotes', () => {
					const groupChat = createMockGroupChat();
					const messages: GroupChatMessage[] = [
						{ timestamp: '2023-12-21T10:00:00Z', from: 'Agent1', content: '> This is a quote' },
					];
					const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);
					expect(html).toContain('<blockquote>');
				});
				it('converts strikethrough text', () => {
					const groupChat = createMockGroupChat();
					const messages: GroupChatMessage[] = [
						{ timestamp: '2023-12-21T10:00:00Z', from: 'Agent1', content: '~~deleted~~' },
					];
					const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);
					expect(html).toContain('<del>deleted</del>');
				});
			});
			describe('image embedding', () => {
				it('embeds images as data URLs', () => {
					const groupChat = createMockGroupChat();
					const messages: GroupChatMessage[] = [
						{
							timestamp: '2023-12-21T10:00:00Z',
							from: 'Agent1',
							content: '![screenshot](screenshot.png)',
						},
					];
					const images = { 'screenshot.png': 'data:image/png;base64,abc123' };
					const html = generateGroupChatExportHtml(groupChat, messages, [], images, mockTheme);
					expect(html).toContain('src="data:image/png;base64,abc123"');
				});
				it('handles [Image: filename] pattern', () => {
					const groupChat = createMockGroupChat();
					const messages: GroupChatMessage[] = [
						{ timestamp: '2023-12-21T10:00:00Z', from: 'Agent1', content: '[Image: photo.jpg]' },
					];
					const images = { 'photo.jpg': 'data:image/jpeg;base64,xyz789' };
					const html = generateGroupChatExportHtml(groupChat, messages, [], images, mockTheme);
					expect(html).toContain('src="data:image/jpeg;base64,xyz789"');
				});
			});
			describe('participants section', () => {
				it('renders participants section when participants exist', () => {
					const groupChat = createMockGroupChat();
					const messages = createMockMessages();
					const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);
					expect(html).toContain('Participants');
					expect(html).toContain('Agent1');
					expect(html).toContain('Agent2');
				});
				it('omits participants section when no participants', () => {
					const groupChat = createMockGroupChat({ participants: [] });
					const messages = createMockMessages();
					const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);
					// Should not have a participants section header
					expect(html).not.toContain('class="section-title">Participants');
				});
				it('shows participant colors', () => {
					const groupChat = createMockGroupChat({
						participants: [
							{
								name: 'TestAgent',
								agentId: 'claude-code',
								sessionId: 's1',
								addedAt: 0,
								color: '#e91e63',
							},
						],
					});
					const messages = createMockMessages();
					const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);
					expect(html).toContain('#e91e63');
				});
				it('shows participant agent IDs', () => {
					const groupChat = createMockGroupChat();
					const messages = createMockMessages();
					const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);
					expect(html).toContain('claude-code');
				});
			});
			describe('metadata section', () => {
				it('includes group chat ID', () => {
					const groupChat = createMockGroupChat({ id: 'unique-chat-id-123' });
					const messages = createMockMessages();
					const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);
					expect(html).toContain('unique-chat-id-123');
				});
				it('includes moderator agent ID', () => {
					const groupChat = createMockGroupChat({ moderatorAgentId: 'custom-moderator' });
					const messages = createMockMessages();
					const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);
					expect(html).toContain('custom-moderator');
				});
				it('includes creation date', () => {
					const groupChat = createMockGroupChat();
					const messages = createMockMessages();
					const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);
					expect(html).toContain('Created');
				});
			});
			describe('footer', () => {
				it('includes Maestro attribution with runmaestro.ai', () => {
					const groupChat = createMockGroupChat();
					const messages = createMockMessages();
					const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);
					expect(html).toContain('Exported from');
					expect(html).toContain('href="https://runmaestro.ai"');
				});
			});
			describe('edge cases', () => {
				it('handles empty messages array', () => {
					const groupChat = createMockGroupChat();
					const html = generateGroupChatExportHtml(groupChat, [], [], {}, mockTheme);
					expect(html).toContain('<!DOCTYPE html>');
				});
				it('handles empty history array', () => {
					const groupChat = createMockGroupChat();
					const messages = createMockMessages();
					const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);
					// Should still generate valid HTML
					expect(html).toContain('<!DOCTYPE html>');
				});
				it('handles empty images object', () => {
					const groupChat = createMockGroupChat();
					const messages = createMockMessages();
					const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);
					expect(html).toContain('<!DOCTYPE html>');
				});
				it('handles special characters in participant names', () => {
					const groupChat = createMockGroupChat({
						participants: [
							{ name: 'Agent <Test>', agentId: 'claude-code', sessionId: 's1', addedAt: 0 },
						],
					});
					const messages = createMockMessages();
					const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);
					expect(html).toContain('Agent &lt;Test&gt;');
				});
				it('handles unicode in messages', () => {
					const groupChat = createMockGroupChat();
					const messages: GroupChatMessage[] = [
						{ timestamp: '2023-12-21T10:00:00Z', from: 'user', content: 'Hello! Café ☕' },
					];
					const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);
					expect(html).toContain('Café');
					expect(html).toContain('☕');
				});
				it('handles very long messages', () => {
					const groupChat = createMockGroupChat();
					const longContent = 'A'.repeat(10000);
					const messages: GroupChatMessage[] = [
						{ timestamp: '2023-12-21T10:00:00Z', from: 'Agent1', content: longContent },
					];
					const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);
					expect(html).toContain(longContent);
				});
			});
			describe('CSS responsiveness', () => {
				it('includes mobile media query', () => {
					const groupChat = createMockGroupChat();
					const messages = createMockMessages();
					const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);
					expect(html).toContain('@media (max-width: 640px)');
				});
				it('includes print media query', () => {
					const groupChat = createMockGroupChat();
					const messages = createMockMessages();
					const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);
					expect(html).toContain('@media print');
				});
			});
		});
	});
});
// Source: src/__tests__/renderer/utils/groupChatOrdering.test.ts
describe('', () => {
	const chats = [
		{ id: 'a', name: 'Charlie', updatedAt: 1 },
		{ id: 'b', name: 'Alpha', updatedAt: 3 },
		{ id: 'c', name: 'Bravo', updatedAt: 2, archived: true },
		{ id: 'd', name: 'Delta', createdAt: 2, updatedAt: undefined as unknown as number },
	];
	describe('orderGroupChatsForDisplay', () => {
		it('drops archived chats and sorts by most-recent activity by default', () => {
			const ordered = orderGroupChatsForDisplay(chats, false);
			expect(ordered.map((c) => c.id)).toEqual(['b', 'd', 'a']);
		});
		it('sorts alphabetically when the toggle is on', () => {
			const ordered = orderGroupChatsForDisplay(chats, true);
			expect(ordered.map((c) => c.name)).toEqual(['Alpha', 'Charlie', 'Delta']);
		});
	});
	describe('pickNextGroupChatIdAfterDelete', () => {
		const list = [
			{ id: 'gc-1', name: 'One', updatedAt: 3 },
			{ id: 'gc-2', name: 'Two', updatedAt: 2 },
			{ id: 'gc-3', name: 'Three', updatedAt: 1 },
		];
		it('returns the chat that shifts up into the deleted slot (next below)', () => {
			expect(pickNextGroupChatIdAfterDelete('gc-1', list, false)).toBe('gc-2');
			expect(pickNextGroupChatIdAfterDelete('gc-2', list, false)).toBe('gc-3');
		});
		it('returns the new last chat when deleting the bottom-most one', () => {
			expect(pickNextGroupChatIdAfterDelete('gc-3', list, false)).toBe('gc-2');
		});
		it('returns null when the deleted chat is the only one', () => {
			expect(pickNextGroupChatIdAfterDelete('gc-1', [list[0]], false)).toBeNull();
		});
		it('returns null when the deleted id is not in the list', () => {
			expect(pickNextGroupChatIdAfterDelete('missing', list, false)).toBeNull();
		});
		it('ignores archived chats when choosing the next focus', () => {
			const withArchived = [
				{ id: 'gc-1', name: 'One', updatedAt: 3 },
				{ id: 'gc-2', name: 'Two', updatedAt: 2, archived: true },
				{ id: 'gc-3', name: 'Three', updatedAt: 1 },
			];
			// Visible order is gc-1, gc-3; deleting gc-1 focuses gc-3.
			expect(pickNextGroupChatIdAfterDelete('gc-1', withArchived, false)).toBe('gc-3');
		});
	});
});
// Source: src/__tests__/renderer/utils/labelWidth.test.ts
describe('', () => {
	describe('estimateLabelWidth', () => {
		it('scales with both the character count and the font size', () => {
			const small = estimateLabelWidth('abcdefghij', { fontSizePx: 12 });
			const large = estimateLabelWidth('abcdefghij', { fontSizePx: 24 });
			expect(small).toBe(66); // 10 chars * 12px * 0.55
			expect(large).toBe(small * 2);
		});
		it('adds chrome on top of the text', () => {
			expect(estimateLabelWidth('abcdefghij', { fontSizePx: 12, chromePx: 40 })).toBe(106);
		});
		it('rounds up, so a fractional estimate never clips the label', () => {
			// 5 chars * 12 * 0.55 = 33.0 exactly; 7 chars = 46.2 and must not floor to 46.
			expect(estimateLabelWidth('abcde', { fontSizePx: 12 })).toBe(33);
			expect(estimateLabelWidth('abcdefg', { fontSizePx: 12 })).toBe(47);
		});
		it('honors a floor and a ceiling', () => {
			const options = { fontSizePx: 12, minPx: 100, maxPx: 200 };
			expect(estimateLabelWidth('a', options)).toBe(100);
			expect(estimateLabelWidth('x'.repeat(500), options)).toBe(200);
		});
		it('prefers the floor when a caller passes a floor above its ceiling', () => {
			expect(estimateLabelWidth('a', { fontSizePx: 12, minPx: 300, maxPx: 200 })).toBe(300);
		});
	});
	describe('widestLabelWidth', () => {
		it('sizes to the longest label, whatever its position', () => {
			const expected = estimateLabelWidth('a longer label', { fontSizePx: 12 });
			expect(widestLabelWidth(['a', 'a longer label', 'b'], { fontSizePx: 12 })).toBe(expected);
			expect(widestLabelWidth(['a longer label', 'a', 'b'], { fontSizePx: 12 })).toBe(expected);
		});
		it('falls back to chrome and the floor for an empty list', () => {
			expect(widestLabelWidth([], { fontSizePx: 12, chromePx: 40 })).toBe(40);
			expect(widestLabelWidth([], { fontSizePx: 12, chromePx: 40, minPx: 120 })).toBe(120);
		});
	});
});
// Source: src/__tests__/renderer/utils/tokenCounter.test.ts
describe('', () => {
	describe('tokenCounter', () => {
		it('loads the encoder on demand and reuses it', async () => {
			const first = getEncoder();
			const second = getEncoder();
			expect(second).toBe(first);
			expect(await countTokens('hello')).toBe(1);
		});
		it('keeps the lightweight estimate and display helpers synchronous', () => {
			expect(estimateTokens('12345678')).toBe(2);
			expect(formatTokenCount(1500)).toBe('1.5k');
		});
	});
});
