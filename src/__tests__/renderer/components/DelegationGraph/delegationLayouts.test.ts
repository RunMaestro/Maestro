/**
 * Tests for delegationLayouts - where each agent goes on the Delegation Graph.
 *
 * The algorithms give coordinates nobody should pin by hand, so most cases
 * here assert a PROPERTY of the arrangement (no two agents overlap, a saved
 * position is untouched, a new agent is not on the origin) and not a number.
 */

import { describe, it, expect } from 'vitest';
import {
	arrangeDelegationGraph,
	computeDelegationLayout,
	delegationMindMapData,
	scaleDelegationPositions,
} from '../../../../renderer/components/DelegationGraph/delegationLayouts';
import {
	DELEGATION_ALGORITHM_LAYOUTS,
	type DelegationAlgorithmLayout,
} from '../../../../renderer/components/DelegationGraph/delegationLayoutTypes';
import {
	AGENT_DELEGATION_NODE_HEIGHT,
	estimateAgentDelegationNodeWidth,
} from '../../../../renderer/components/DelegationGraph/nodes/agentDelegationNodeSize';
import type {
	DelegationGraphEdge,
	DelegationGraphModel,
	DelegationGraphNode,
} from '../../../../shared/delegationGraph';
import type { DelegationSavedPositions } from '../../../../shared/delegationGraphLayout';

function node(id: string): DelegationGraphNode {
	return { sessionId: id, name: id, scope: 'in-scope' };
}

function edge(sourceId: string, targetId: string): DelegationGraphEdge {
	return {
		id: `${sourceId}->${targetId}`,
		sourceId,
		targetId,
		read: true,
		write: false,
		source: 'explicit',
	};
}

function graph(ids: string[], edges: Array<[string, string]>): DelegationGraphModel {
	return { nodes: ids.map(node), edges: edges.map(([source, target]) => edge(source, target)) };
}

/**
 * A lead with two reports, one of which reports back (a mutual pair), a second
 * level under each report, a pair off on their own, and three agents with no
 * peers at all.
 */
const TEAM = graph(
	['boss', 'dev1', 'dev2', 'qa', 'docs', 'x1', 'x2', 'solo1', 'solo2', 'solo3'],
	[
		['boss', 'dev1'],
		['boss', 'dev2'],
		['dev1', 'boss'],
		['dev1', 'qa'],
		['dev2', 'docs'],
		['x1', 'x2'],
	]
);
const CONNECTED = ['boss', 'dev1', 'dev2', 'qa', 'docs', 'x1', 'x2'];
const ISOLATED = ['solo1', 'solo2', 'solo3'];

/** Every pair of agents whose rectangles overlap. The node's name is its id here. */
function overlappingPairs(positions: DelegationSavedPositions): string[] {
	const ids = Object.keys(positions);
	const pairs: string[] = [];
	for (let i = 0; i < ids.length; i++) {
		for (let j = i + 1; j < ids.length; j++) {
			const a = positions[ids[i]];
			const b = positions[ids[j]];
			const aWidth = estimateAgentDelegationNodeWidth(ids[i]);
			const bWidth = estimateAgentDelegationNodeWidth(ids[j]);
			if (
				a.x < b.x + bWidth &&
				b.x < a.x + aWidth &&
				a.y < b.y + AGENT_DELEGATION_NODE_HEIGHT &&
				b.y < a.y + AGENT_DELEGATION_NODE_HEIGHT
			) {
				pairs.push(`${ids[i]}/${ids[j]}`);
			}
		}
	}
	return pairs;
}

/** The middle of an agent's rectangle. */
function centerOf(positions: DelegationSavedPositions, id: string): { x: number; y: number } {
	return {
		x: positions[id].x + estimateAgentDelegationNodeWidth(id) / 2,
		y: positions[id].y + AGENT_DELEGATION_NODE_HEIGHT / 2,
	};
}

function distanceFromOrigin(positions: DelegationSavedPositions, id: string): number {
	const { x, y } = centerOf(positions, id);
	return Math.hypot(x, y);
}

describe('computeDelegationLayout', () => {
	it('adapts agent identity and directed access styles to the shared canvas', () => {
		const model: DelegationGraphModel = {
			nodes: [
				{ sessionId: 'a', name: 'Alpha.md', scope: 'in-scope' },
				{ sessionId: 'b', name: 'Beta', scope: 'in-scope' },
			],
			edges: [
				{ id: 'a->b', sourceId: 'a', targetId: 'b', read: true, write: false, source: 'explicit' },
			],
		};
		const data = delegationMindMapData(model);
		expect(data.nodes[0]).toMatchObject({ id: 'a', filePath: 'a', label: 'Alpha.md' });
		expect(data.links).toEqual([
			{
				source: 'a',
				target: 'b',
				type: 'internal',
				directed: true,
				dashed: true,
				strokeWidth: 1.5,
				opacity: 1,
			},
		]);
	});
	describe.each(DELEGATION_ALGORITHM_LAYOUTS.map((layout) => [layout]))('%s', (layout) => {
		const positions = computeDelegationLayout(layout as DelegationAlgorithmLayout, TEAM);

		it('gives every agent a finite position', () => {
			expect(Object.keys(positions).sort()).toEqual(TEAM.nodes.map((n) => n.sessionId).sort());
			for (const { x, y } of Object.values(positions)) {
				expect(Number.isFinite(x)).toBe(true);
				expect(Number.isFinite(y)).toBe(true);
			}
		});

		it('puts no agent on top of another', () => {
			expect(overlappingPairs(positions)).toEqual([]);
		});

		it("keeps unrelated teams in separate rectangles, clear of each other's edges", () => {
			const main = ['boss', 'dev1', 'dev2', 'qa', 'docs'];
			const minX = Math.min(...main.map((id) => positions[id].x));
			const maxX = Math.max(
				...main.map((id) => positions[id].x + estimateAgentDelegationNodeWidth(id))
			);
			const minY = Math.min(...main.map((id) => positions[id].y));
			const maxY = Math.max(...main.map((id) => positions[id].y + AGENT_DELEGATION_NODE_HEIGHT));
			for (const id of ['x1', 'x2']) {
				expect(
					positions[id].x >= maxX ||
						positions[id].x + estimateAgentDelegationNodeWidth(id) <= minX ||
						positions[id].y >= maxY ||
						positions[id].y + AGENT_DELEGATION_NODE_HEIGHT <= minY
				).toBe(true);
			}
		});

		// Most agents in a fleet have no peers. Handed to the algorithm they make
		// one row dozens of nodes wide, or drift, so they are packed underneath.
		it('packs the isolated agents in a block below the connected ones', () => {
			const lowestConnected = Math.max(
				...CONNECTED.map((id) => positions[id].y + AGENT_DELEGATION_NODE_HEIGHT)
			);
			for (const id of ISOLATED) expect(positions[id].y).toBeGreaterThan(lowestConnected);
		});

		// "The same agent is in the same place every time you open it."
		it('gives the same arrangement on every run', () => {
			expect(computeDelegationLayout(layout as DelegationAlgorithmLayout, TEAM)).toEqual(positions);
		});

		it('returns nothing for an empty graph', () => {
			expect(computeDelegationLayout(layout as DelegationAlgorithmLayout, graph([], []))).toEqual(
				{}
			);
		});

		it('lays out a graph where every agent is isolated, with none on the origin', () => {
			const lonely = computeDelegationLayout(
				layout as DelegationAlgorithmLayout,
				graph(['a', 'b', 'c'], [])
			);
			expect(overlappingPairs(lonely)).toEqual([]);
			for (const position of Object.values(lonely)) {
				expect(position).not.toEqual({ x: 0, y: 0 });
			}
		});
	});

	describe('hierarchical', () => {
		it('draws an agent above the agents it reaches, like an org chart', () => {
			const tree = graph(
				['lead', 'left', 'right', 'leaf'],
				[
					['lead', 'left'],
					['lead', 'right'],
					['left', 'leaf'],
				]
			);
			const positions = computeDelegationLayout('hierarchical', tree);

			expect(positions.lead.y).toBeLessThan(positions.left.y);
			expect(positions.left.y).toBe(positions.right.y);
			expect(positions.left.y).toBeLessThan(positions.leaf.y);
		});
	});

	describe('radial', () => {
		it('puts the most connected agent in the middle', () => {
			const positions = computeDelegationLayout('radial', TEAM);
			// boss and dev1 both touch two agents; the tie goes to the first by name.
			expect(distanceFromOrigin(positions, 'boss')).toBeCloseTo(0);
		});

		it('puts the named agent in the middle when one is given', () => {
			const positions = computeDelegationLayout('radial', TEAM, { centerId: 'dev2' });
			expect(distanceFromOrigin(positions, 'dev2')).toBeCloseTo(0);
		});

		it('ignores a center that is not connected to anything', () => {
			const positions = computeDelegationLayout('radial', TEAM, { centerId: 'solo1' });
			expect(distanceFromOrigin(positions, 'boss')).toBeCloseTo(0);
		});

		// Distance is counted in either direction: dev1 reaches boss and boss
		// reaches dev2, and both are one relationship from boss.
		it('puts agents on rings by how many relationships they are from the middle', () => {
			const positions = computeDelegationLayout('radial', TEAM);
			const ringOne = distanceFromOrigin(positions, 'dev1');
			const ringTwo = distanceFromOrigin(positions, 'qa');

			expect(distanceFromOrigin(positions, 'dev2')).toBeCloseTo(ringOne);
			expect(distanceFromOrigin(positions, 'docs')).toBeCloseTo(ringTwo);
			expect(ringOne).toBeGreaterThan(0);
			expect(ringTwo).toBeGreaterThan(ringOne);
		});

		it('gives a disconnected team its own radial center', () => {
			const positions = computeDelegationLayout('radial', TEAM);
			const pair = computeDelegationLayout('radial', graph(['x1', 'x2'], [['x1', 'x2']]));
			expect(positions.x2.x - positions.x1.x).toBeCloseTo(pair.x2.x - pair.x1.x);
			expect(positions.x2.y - positions.x1.y).toBeCloseTo(pair.x2.y - pair.x1.y);
		});

		// A branch fans out from its own lead: an agent is nearer to the agent it
		// was reached through than to that agent's sibling.
		it('keeps an agent on the side of the agent it was reached through', () => {
			const positions = computeDelegationLayout('radial', TEAM);
			const gap = (a: string, b: string) => {
				const from = centerOf(positions, a);
				const to = centerOf(positions, b);
				return Math.hypot(from.x - to.x, from.y - to.y);
			};

			expect(gap('qa', 'dev1')).toBeLessThan(gap('qa', 'dev2'));
			expect(gap('docs', 'dev2')).toBeLessThan(gap('docs', 'dev1'));
		});

		it('moves a ring out far enough for a long name', () => {
			const wide = 'An agent with a very long name indeed';
			const model = graph(
				['hub', 'a', 'b', 'c', 'd', wide],
				[
					['hub', 'a'],
					['hub', 'b'],
					['hub', 'c'],
					['hub', 'd'],
					['hub', wide],
				]
			);
			expect(overlappingPairs(computeDelegationLayout('radial', model))).toEqual([]);
		});
	});

	it.each(['mindmap', 'lobes'] as const)(
		'reserves full card footprints in dense %s layouts',
		(layout) => {
			const names = Array.from(
				{ length: 16 },
				(_, index) => `Long worktree agent ${index} with a descriptive branch name`
			);
			const model = graph(
				['hub', ...names],
				names.flatMap(
					(name): Array<[string, string]> => [
						['hub', name],
						[name, 'hub'],
					]
				)
			);
			expect(overlappingPairs(computeDelegationLayout(layout, model))).toEqual([]);
		}
	);

	it('increases spacing while keeping card sizes and relationships unchanged', () => {
		const model = graph(
			['lead', 'left', 'right'],
			[
				['lead', 'left'],
				['lead', 'right'],
			]
		);
		const original = computeDelegationLayout('hierarchical', model);
		const expanded = computeDelegationLayout('hierarchical', model, { spacingScale: 1.5 });
		const gap = (positions: DelegationSavedPositions) =>
			centerOf(positions, 'right').x - centerOf(positions, 'left').x;
		expect(gap(expanded)).toBeCloseTo(gap(original) * 1.5);
		expect(overlappingPairs(expanded)).toEqual([]);
		expect(model.edges).toHaveLength(2);
	});
});

describe('arrangeDelegationGraph', () => {
	const SAVED: DelegationSavedPositions = {
		boss: { x: 100, y: 100 },
		dev1: { x: 100, y: 400 },
	};

	it('resizes saved placement without mutating its input or adding unsaved nodes', () => {
		const scaled = scaleDelegationPositions(TEAM, SAVED, 1.5);
		expect(SAVED).toEqual({ boss: { x: 100, y: 100 }, dev1: { x: 100, y: 400 } });
		expect(Object.keys(scaled).sort()).toEqual(['boss', 'dev1']);
		expect(scaleDelegationPositions(TEAM, scaled, 1 / 1.5).boss.x).toBeCloseTo(SAVED.boss.x);
	});

	it('returns the saved positions unchanged when every agent has one', () => {
		const everyone = computeDelegationLayout('force', TEAM);

		const arrangement = arrangeDelegationGraph(TEAM, 'manual', everyone);

		expect(arrangement.positions).toEqual(everyone);
		expect(arrangement.newlyPlaced).toEqual({});
	});

	it("runs the scope's algorithm when nothing is saved", () => {
		const arrangement = arrangeDelegationGraph(TEAM, 'radial', {});

		expect(arrangement.positions).toEqual(computeDelegationLayout('radial', TEAM));
		expect(arrangement.newlyPlaced).toEqual(arrangement.positions);
	});

	// Every agent that was placed by hand is gone. `manual` names no algorithm,
	// so the default one draws the agents that are left.
	it('falls back to the default algorithm for a manual scope with nothing left of it', () => {
		const arrangement = arrangeDelegationGraph(TEAM, 'manual', { gone: { x: 5, y: 5 } });

		expect(arrangement.positions).toEqual(computeDelegationLayout('hierarchical', TEAM));
	});

	it('never returns a position for an agent that is not on the graph', () => {
		const arrangement = arrangeDelegationGraph(TEAM, 'manual', {
			...SAVED,
			gone: { x: 5, y: 5 },
		});

		expect(arrangement.positions).not.toHaveProperty('gone');
		expect(Object.keys(arrangement.positions).sort()).toEqual(
			TEAM.nodes.map((n) => n.sessionId).sort()
		);
	});

	// Persistent layout is the rule here, not auto-heal.
	it('leaves every saved position exactly where it was', () => {
		const arrangement = arrangeDelegationGraph(TEAM, 'manual', SAVED);

		expect(arrangement.positions.boss).toEqual(SAVED.boss);
		expect(arrangement.positions.dev1).toEqual(SAVED.dev1);
		expect(arrangement.newlyPlaced).not.toHaveProperty('boss');
		expect(arrangement.newlyPlaced).not.toHaveProperty('dev1');
	});

	it('reports exactly the agents it placed', () => {
		const arrangement = arrangeDelegationGraph(TEAM, 'manual', SAVED);

		expect(Object.keys(arrangement.newlyPlaced).sort()).toEqual(
			['dev2', 'qa', 'docs', 'x1', 'x2', ...ISOLATED].sort()
		);
		for (const [id, position] of Object.entries(arrangement.newlyPlaced)) {
			expect(arrangement.positions[id]).toEqual(position);
		}
	});

	// The placement uses a random angle, so the properties are checked over many
	// runs: one lucky run proves nothing.
	it('puts a new agent near the agents it is connected to, never on the origin or another agent', () => {
		const model = graph(
			['boss', 'dev1', 'dev2'],
			[
				['boss', 'dev1'],
				['boss', 'dev2'],
			]
		);
		for (let run = 0; run < 50; run++) {
			const { positions } = arrangeDelegationGraph(model, 'manual', SAVED);

			expect(positions.dev2).not.toEqual({ x: 0, y: 0 });
			expect(overlappingPairs(positions)).toEqual([]);
			// Beside its one placed neighbor, which is boss: within a few node heights.
			const near = Math.hypot(positions.dev2.x - SAVED.boss.x, positions.dev2.y - SAVED.boss.y);
			expect(near).toBeLessThan(700);
		}
	});

	it('places a chain of new agents outward from the agents that have a place', () => {
		// docs is connected only to dev2, and dev2 is new as well.
		for (let run = 0; run < 50; run++) {
			const { positions } = arrangeDelegationGraph(TEAM, 'manual', SAVED);
			expect(overlappingPairs(positions)).toEqual([]);
		}
	});

	it('puts a new agent with no placed neighbor in a block under the graph', () => {
		const { positions } = arrangeDelegationGraph(TEAM, 'manual', SAVED);
		const anchoredIds = ['boss', 'dev1', 'dev2', 'qa', 'docs'];
		const lowestAnchored = Math.max(
			...anchoredIds.map((id) => positions[id].y + AGENT_DELEGATION_NODE_HEIGHT)
		);

		// x1 and x2 reach only each other, and neither has a place yet.
		for (const id of ['x1', 'x2', ...ISOLATED]) {
			expect(positions[id].y).toBeGreaterThan(lowestAnchored);
		}
	});
});
