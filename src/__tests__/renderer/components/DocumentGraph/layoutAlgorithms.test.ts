/**
 * Tests for the Document Graph layout algorithms
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Node, Edge } from 'reactflow';
import {
	applyForceLayout,
	applyHierarchicalLayout,
	interpolatePosition,
	createLayoutTransitionFrames,
	saveNodePositions,
	restoreNodePositions,
	clearNodePositions,
	hasSavedPositions,
	diffNodes,
	createNodeEntryFrames,
	createNodeExitFrames,
	mergeAnimatingNodes,
	positionNewNodesNearNeighbors,
} from '../../../../renderer/components/DocumentGraph/layoutAlgorithms';
import type {
	GraphNodeData,
	DocumentNodeData,
	ExternalLinkNodeData,
} from '../../../../renderer/components/DocumentGraph/graphDataBuilder';

/**
 * Create a mock document node
 */
function createDocumentNode(id: string, x = 0, y = 0): Node<DocumentNodeData> {
	return {
		id,
		type: 'documentNode',
		position: { x, y },
		data: {
			nodeType: 'document',
			title: id,
			lineCount: 100,
			wordCount: 500,
			size: '1 KB',
			filePath: `${id}.md`,
		},
	};
}

/**
 * Create a mock external link node
 */
function createExternalNode(domain: string, x = 0, y = 0): Node<ExternalLinkNodeData> {
	return {
		id: `ext-${domain}`,
		type: 'externalLinkNode',
		position: { x, y },
		data: {
			nodeType: 'external',
			domain,
			linkCount: 1,
			urls: [`https://${domain}`],
		},
	};
}

/**
 * Create a mock edge
 */
function createEdge(source: string, target: string, type = 'default'): Edge {
	return {
		id: `${source}-${target}`,
		source,
		target,
		type,
	};
}

describe('layoutAlgorithms', () => {
	describe('applyForceLayout', () => {
		it('should return empty array for empty input', () => {
			const result = applyForceLayout([], []);
			expect(result).toEqual([]);
		});

		it('should position a single node at center', () => {
			const nodes: Node<GraphNodeData>[] = [createDocumentNode('doc1')];
			const result = applyForceLayout(nodes, [], { centerX: 0, centerY: 0 });

			expect(result).toHaveLength(1);
			// Single node should be near center (within reasonable bounds due to forces)
			expect(result[0].position.x).toBeCloseTo(0, -1); // Allow some variance
			expect(result[0].position.y).toBeCloseTo(0, -1);
		});

		it('should position multiple nodes with spacing', () => {
			const nodes: Node<GraphNodeData>[] = [
				createDocumentNode('doc1'),
				createDocumentNode('doc2'),
				createDocumentNode('doc3'),
			];
			const edges: Edge[] = [createEdge('doc1', 'doc2'), createEdge('doc2', 'doc3')];

			const result = applyForceLayout(nodes, edges);

			expect(result).toHaveLength(3);

			// Nodes should be separated (not all at same position)
			const positions = result.map((n) => n.position);
			const allSamePosition = positions.every(
				(p) => p.x === positions[0].x && p.y === positions[0].y
			);
			expect(allSamePosition).toBe(false);
		});

		it('should handle nodes without edges', () => {
			const nodes: Node<GraphNodeData>[] = [createDocumentNode('doc1'), createDocumentNode('doc2')];

			const result = applyForceLayout(nodes, []);

			expect(result).toHaveLength(2);
			// Nodes should still be positioned
			expect(result[0].position).toBeDefined();
			expect(result[1].position).toBeDefined();
		});

		it('should handle external link nodes differently', () => {
			const nodes: Node<GraphNodeData>[] = [
				createDocumentNode('doc1'),
				createExternalNode('github.com'),
			];
			const edges: Edge[] = [createEdge('doc1', 'ext-github.com', 'external')];

			const result = applyForceLayout(nodes, edges);

			expect(result).toHaveLength(2);
			// Both nodes should have positions
			expect(result[0].position).toBeDefined();
			expect(result[1].position).toBeDefined();
		});

		it('should preserve node data after layout', () => {
			const nodes: Node<GraphNodeData>[] = [createDocumentNode('doc1')];
			const result = applyForceLayout(nodes, []);

			const data = result[0].data as DocumentNodeData;
			expect(data.nodeType).toBe('document');
			expect(data.title).toBe('doc1');
			expect(data.filePath).toBe('doc1.md');
		});

		it('should use custom layout options', () => {
			const nodes: Node<GraphNodeData>[] = [createDocumentNode('doc1'), createDocumentNode('doc2')];
			const edges: Edge[] = [createEdge('doc1', 'doc2')];

			const result = applyForceLayout(nodes, edges, {
				centerX: 500,
				centerY: 500,
				nodeSeparation: 100,
			});

			expect(result).toHaveLength(2);
			// Nodes should be roughly centered around 500, 500
			const avgX = (result[0].position.x + result[1].position.x) / 2;
			const avgY = (result[0].position.y + result[1].position.y) / 2;
			expect(avgX).toBeCloseTo(500, -2);
			expect(avgY).toBeCloseTo(500, -2);
		});
	});

	describe('applyHierarchicalLayout', () => {
		it('should return empty array for empty input', () => {
			const result = applyHierarchicalLayout([], []);
			expect(result).toEqual([]);
		});

		it('should position nodes in hierarchical order', () => {
			const nodes: Node<GraphNodeData>[] = [
				createDocumentNode('doc1'),
				createDocumentNode('doc2'),
				createDocumentNode('doc3'),
			];
			const edges: Edge[] = [createEdge('doc1', 'doc2'), createEdge('doc1', 'doc3')];

			const result = applyHierarchicalLayout(nodes, edges, { rankDirection: 'TB' });

			expect(result).toHaveLength(3);

			// doc1 should be above doc2 and doc3 (lower Y in TB layout)
			const doc1 = result.find((n) => n.id === 'doc1');
			const doc2 = result.find((n) => n.id === 'doc2');
			const doc3 = result.find((n) => n.id === 'doc3');

			expect(doc1!.position.y).toBeLessThan(doc2!.position.y);
			expect(doc1!.position.y).toBeLessThan(doc3!.position.y);
			// doc2 and doc3 should be at similar Y (same rank)
			expect(doc2!.position.y).toBeCloseTo(doc3!.position.y, 0);
		});

		it('should handle LR (left-right) direction', () => {
			const nodes: Node<GraphNodeData>[] = [createDocumentNode('doc1'), createDocumentNode('doc2')];
			const edges: Edge[] = [createEdge('doc1', 'doc2')];

			const result = applyHierarchicalLayout(nodes, edges, { rankDirection: 'LR' });

			expect(result).toHaveLength(2);

			const doc1 = result.find((n) => n.id === 'doc1');
			const doc2 = result.find((n) => n.id === 'doc2');

			// doc1 should be to the left of doc2 (lower X in LR layout)
			expect(doc1!.position.x).toBeLessThan(doc2!.position.x);
		});

		it('should handle disconnected components', () => {
			const nodes: Node<GraphNodeData>[] = [
				createDocumentNode('doc1'),
				createDocumentNode('doc2'),
				createDocumentNode('doc3'),
			];
			const edges: Edge[] = [createEdge('doc1', 'doc2')];
			// doc3 is disconnected

			const result = applyHierarchicalLayout(nodes, edges);

			expect(result).toHaveLength(3);
			// All nodes should have positions
			expect(result[0].position).toBeDefined();
			expect(result[1].position).toBeDefined();
			expect(result[2].position).toBeDefined();
		});

		it('should handle external links with longer edges', () => {
			const nodes: Node<GraphNodeData>[] = [
				createDocumentNode('doc1'),
				createExternalNode('github.com'),
			];
			const edges: Edge[] = [createEdge('doc1', 'ext-github.com', 'external')];

			const result = applyHierarchicalLayout(nodes, edges, { rankDirection: 'TB' });

			expect(result).toHaveLength(2);
			// External node should be below document (minlen: 2)
			const doc = result.find((n) => n.id === 'doc1');
			const ext = result.find((n) => n.id === 'ext-github.com');
			expect(doc!.position.y).toBeLessThan(ext!.position.y);
		});

		it('should apply node and rank separation options', () => {
			const nodes: Node<GraphNodeData>[] = [
				createDocumentNode('doc1'),
				createDocumentNode('doc2'),
				createDocumentNode('doc3'),
			];
			const edges: Edge[] = [createEdge('doc1', 'doc2'), createEdge('doc1', 'doc3')];

			const defaultResult = applyHierarchicalLayout(nodes, edges);
			const spacedResult = applyHierarchicalLayout(nodes, edges, {
				nodeSeparation: 200,
				rankSeparation: 300,
			});

			// Spaced result should have more separation
			const defaultDoc2 = defaultResult.find((n) => n.id === 'doc2');
			const defaultDoc3 = defaultResult.find((n) => n.id === 'doc3');
			const spacedDoc2 = spacedResult.find((n) => n.id === 'doc2');
			const spacedDoc3 = spacedResult.find((n) => n.id === 'doc3');

			const defaultSep = Math.abs(defaultDoc2!.position.x - defaultDoc3!.position.x);
			const spacedSep = Math.abs(spacedDoc2!.position.x - spacedDoc3!.position.x);

			expect(spacedSep).toBeGreaterThan(defaultSep);
		});
	});

	describe('interpolatePosition', () => {
		it('should return start position at t=0', () => {
			const start = { x: 0, y: 0 };
			const end = { x: 100, y: 100 };
			const result = interpolatePosition(start, end, 0);

			expect(result.x).toBe(0);
			expect(result.y).toBe(0);
		});

		it('should return end position at t=1', () => {
			const start = { x: 0, y: 0 };
			const end = { x: 100, y: 100 };
			const result = interpolatePosition(start, end, 1);

			expect(result.x).toBe(100);
			expect(result.y).toBe(100);
		});

		it('should interpolate at midpoint with easing', () => {
			const start = { x: 0, y: 0 };
			const end = { x: 100, y: 100 };
			const result = interpolatePosition(start, end, 0.5);

			// Due to ease-out cubic, midpoint should be past 50%
			expect(result.x).toBeGreaterThan(50);
			expect(result.y).toBeGreaterThan(50);
			expect(result.x).toBeLessThan(100);
			expect(result.y).toBeLessThan(100);
		});

		it('should clamp t to valid range', () => {
			const start = { x: 0, y: 0 };
			const end = { x: 100, y: 100 };

			const resultNeg = interpolatePosition(start, end, -0.5);
			expect(resultNeg.x).toBe(0);
			expect(resultNeg.y).toBe(0);

			const resultOver = interpolatePosition(start, end, 1.5);
			expect(resultOver.x).toBe(100);
			expect(resultOver.y).toBe(100);
		});
	});

	describe('createLayoutTransitionFrames', () => {
		it('should return end nodes for empty input', () => {
			const result = createLayoutTransitionFrames([], []);
			expect(result).toEqual([[]]);
		});

		it('should return end nodes for single frame', () => {
			const startNodes: Node<GraphNodeData>[] = [createDocumentNode('doc1', 0, 0)];
			const endNodes: Node<GraphNodeData>[] = [createDocumentNode('doc1', 100, 100)];

			const result = createLayoutTransitionFrames(startNodes, endNodes, 1);
			expect(result).toEqual([endNodes]);
		});

		it('should create correct number of frames', () => {
			const startNodes: Node<GraphNodeData>[] = [createDocumentNode('doc1', 0, 0)];
			const endNodes: Node<GraphNodeData>[] = [createDocumentNode('doc1', 100, 100)];

			const result = createLayoutTransitionFrames(startNodes, endNodes, 10);
			expect(result).toHaveLength(11); // 0 to 10 inclusive
		});

		it('should start at start positions and end at end positions', () => {
			const startNodes: Node<GraphNodeData>[] = [createDocumentNode('doc1', 0, 0)];
			const endNodes: Node<GraphNodeData>[] = [createDocumentNode('doc1', 100, 100)];

			const result = createLayoutTransitionFrames(startNodes, endNodes, 10);

			// First frame should be at start position
			expect(result[0][0].position.x).toBe(0);
			expect(result[0][0].position.y).toBe(0);

			// Last frame should be at end position
			const lastFrame = result[result.length - 1];
			expect(lastFrame[0].position.x).toBe(100);
			expect(lastFrame[0].position.y).toBe(100);
		});

		it('should preserve node data through frames', () => {
			const startNodes: Node<GraphNodeData>[] = [createDocumentNode('doc1', 0, 0)];
			const endNodes: Node<GraphNodeData>[] = [createDocumentNode('doc1', 100, 100)];

			const result = createLayoutTransitionFrames(startNodes, endNodes, 5);

			for (const frame of result) {
				const data = frame[0].data as DocumentNodeData;
				expect(data.nodeType).toBe('document');
				expect(data.title).toBe('doc1');
			}
		});
	});

	describe('position persistence', () => {
		const testGraphId = 'test-graph';

		beforeEach(() => {
			clearNodePositions(testGraphId);
		});

		it('should report no saved positions initially', () => {
			expect(hasSavedPositions(testGraphId)).toBe(false);
		});

		it('should save and restore node positions', () => {
			const nodes: Node<GraphNodeData>[] = [
				createDocumentNode('doc1', 100, 200),
				createDocumentNode('doc2', 300, 400),
			];

			saveNodePositions(testGraphId, nodes);
			expect(hasSavedPositions(testGraphId)).toBe(true);

			// Create new nodes at different positions
			const newNodes: Node<GraphNodeData>[] = [
				createDocumentNode('doc1', 0, 0),
				createDocumentNode('doc2', 0, 0),
			];

			const restoredNodes = restoreNodePositions(testGraphId, newNodes);

			expect(restoredNodes[0].position).toEqual({ x: 100, y: 200 });
			expect(restoredNodes[1].position).toEqual({ x: 300, y: 400 });
		});

		it('should return original nodes if no positions saved', () => {
			const nodes: Node<GraphNodeData>[] = [createDocumentNode('doc1', 50, 50)];

			const result = restoreNodePositions('nonexistent-graph', nodes);

			expect(result).toBe(nodes);
			expect(result[0].position).toEqual({ x: 50, y: 50 });
		});

		it('should return original node if its position not saved', () => {
			const nodes: Node<GraphNodeData>[] = [createDocumentNode('doc1', 100, 100)];
			saveNodePositions(testGraphId, nodes);

			// Try to restore a different node
			const newNodes: Node<GraphNodeData>[] = [createDocumentNode('doc2', 50, 50)];

			const result = restoreNodePositions(testGraphId, newNodes);

			// Should return original since doc2 wasn't saved
			expect(result[0].position).toEqual({ x: 50, y: 50 });
		});

		it('should clear saved positions', () => {
			const nodes: Node<GraphNodeData>[] = [createDocumentNode('doc1', 100, 100)];
			saveNodePositions(testGraphId, nodes);

			expect(hasSavedPositions(testGraphId)).toBe(true);

			clearNodePositions(testGraphId);

			expect(hasSavedPositions(testGraphId)).toBe(false);
		});

		it('should handle multiple graphs independently', () => {
			const graph1 = 'graph-1';
			const graph2 = 'graph-2';

			clearNodePositions(graph1);
			clearNodePositions(graph2);

			const nodes1: Node<GraphNodeData>[] = [createDocumentNode('doc1', 100, 100)];
			const nodes2: Node<GraphNodeData>[] = [createDocumentNode('doc1', 200, 200)];

			saveNodePositions(graph1, nodes1);
			saveNodePositions(graph2, nodes2);

			const newNodes: Node<GraphNodeData>[] = [createDocumentNode('doc1', 0, 0)];

			const restored1 = restoreNodePositions(graph1, newNodes);
			const restored2 = restoreNodePositions(graph2, newNodes);

			expect(restored1[0].position).toEqual({ x: 100, y: 100 });
			expect(restored2[0].position).toEqual({ x: 200, y: 200 });
		});
	});

	describe('Node Addition/Removal Animation', () => {
		describe('diffNodes', () => {
			it('should identify added nodes', () => {
				const oldNodes: Node<GraphNodeData>[] = [createDocumentNode('doc1')];
				const newNodes: Node<GraphNodeData>[] = [
					createDocumentNode('doc1'),
					createDocumentNode('doc2'),
				];

				const diff = diffNodes(oldNodes, newNodes);

				expect(diff.added).toHaveLength(1);
				expect(diff.added[0].id).toBe('doc2');
				expect(diff.removed).toHaveLength(0);
				expect(diff.unchanged).toHaveLength(1);
				expect(diff.addedIds.has('doc2')).toBe(true);
			});

			it('should identify removed nodes', () => {
				const oldNodes: Node<GraphNodeData>[] = [
					createDocumentNode('doc1'),
					createDocumentNode('doc2'),
				];
				const newNodes: Node<GraphNodeData>[] = [createDocumentNode('doc1')];

				const diff = diffNodes(oldNodes, newNodes);

				expect(diff.added).toHaveLength(0);
				expect(diff.removed).toHaveLength(1);
				expect(diff.removed[0].id).toBe('doc2');
				expect(diff.unchanged).toHaveLength(1);
				expect(diff.removedIds.has('doc2')).toBe(true);
			});

			it('should handle simultaneous additions and removals', () => {
				const oldNodes: Node<GraphNodeData>[] = [
					createDocumentNode('doc1'),
					createDocumentNode('doc2'),
				];
				const newNodes: Node<GraphNodeData>[] = [
					createDocumentNode('doc1'),
					createDocumentNode('doc3'),
				];

				const diff = diffNodes(oldNodes, newNodes);

				expect(diff.added).toHaveLength(1);
				expect(diff.added[0].id).toBe('doc3');
				expect(diff.removed).toHaveLength(1);
				expect(diff.removed[0].id).toBe('doc2');
				expect(diff.unchanged).toHaveLength(1);
				expect(diff.unchanged[0].id).toBe('doc1');
			});

			it('should handle empty old nodes (all added)', () => {
				const oldNodes: Node<GraphNodeData>[] = [];
				const newNodes: Node<GraphNodeData>[] = [
					createDocumentNode('doc1'),
					createDocumentNode('doc2'),
				];

				const diff = diffNodes(oldNodes, newNodes);

				expect(diff.added).toHaveLength(2);
				expect(diff.removed).toHaveLength(0);
				expect(diff.unchanged).toHaveLength(0);
			});

			it('should handle empty new nodes (all removed)', () => {
				const oldNodes: Node<GraphNodeData>[] = [
					createDocumentNode('doc1'),
					createDocumentNode('doc2'),
				];
				const newNodes: Node<GraphNodeData>[] = [];

				const diff = diffNodes(oldNodes, newNodes);

				expect(diff.added).toHaveLength(0);
				expect(diff.removed).toHaveLength(2);
				expect(diff.unchanged).toHaveLength(0);
			});

			it('should handle no changes (same nodes)', () => {
				const oldNodes: Node<GraphNodeData>[] = [
					createDocumentNode('doc1'),
					createDocumentNode('doc2'),
				];
				const newNodes: Node<GraphNodeData>[] = [
					createDocumentNode('doc1'),
					createDocumentNode('doc2'),
				];

				const diff = diffNodes(oldNodes, newNodes);

				expect(diff.added).toHaveLength(0);
				expect(diff.removed).toHaveLength(0);
				expect(diff.unchanged).toHaveLength(2);
			});
		});

		describe('createNodeEntryFrames', () => {
			it('should return empty array for empty input', () => {
				const result = createNodeEntryFrames([]);
				expect(result).toEqual([]);
			});

			it('should create correct number of frames', () => {
				const nodes: Node<GraphNodeData>[] = [createDocumentNode('doc1')];
				const result = createNodeEntryFrames(nodes, 10);
				expect(result).toHaveLength(11); // 0 to 10 inclusive
			});

			it('should start with opacity 0 and end with opacity 1', () => {
				const nodes: Node<GraphNodeData>[] = [createDocumentNode('doc1')];
				const result = createNodeEntryFrames(nodes, 15);

				// First frame should have opacity 0 (or near 0)
				expect(result[0][0].style?.opacity).toBe(0);

				// Last frame should have opacity 1
				const lastFrame = result[result.length - 1];
				expect(lastFrame[0].style?.opacity).toBe(1);
			});

			it('should start with scale 0.5 and end with scale 1', () => {
				const nodes: Node<GraphNodeData>[] = [createDocumentNode('doc1')];
				const result = createNodeEntryFrames(nodes, 15);

				// First frame should have scale 0.5
				expect(result[0][0].style?.transform).toBe('scale(0.5)');

				// Last frame should have scale 1
				const lastFrame = result[result.length - 1];
				expect(lastFrame[0].style?.transform).toBe('scale(1)');
			});

			it('should set animationPhase correctly', () => {
				const nodes: Node<GraphNodeData>[] = [createDocumentNode('doc1')];
				const result = createNodeEntryFrames(nodes, 10);

				// During animation, phase should be 'entering'
				expect(result[0][0].data.animationPhase).toBe('entering');
				expect(result[5][0].data.animationPhase).toBe('entering');

				// Last frame should be 'stable'
				const lastFrame = result[result.length - 1];
				expect(lastFrame[0].data.animationPhase).toBe('stable');
			});

			it('should handle single frame case', () => {
				const nodes: Node<GraphNodeData>[] = [createDocumentNode('doc1')];
				const result = createNodeEntryFrames(nodes, 1);

				expect(result).toHaveLength(1);
				expect(result[0][0].data.animationPhase).toBe('stable');
				expect(result[0][0].data.animationProgress).toBe(1);
			});
		});

		describe('createNodeExitFrames', () => {
			it('should return empty array for empty input', () => {
				const result = createNodeExitFrames([]);
				expect(result).toEqual([]);
			});

			it('should return empty for single frame', () => {
				const nodes: Node<GraphNodeData>[] = [createDocumentNode('doc1')];
				const result = createNodeExitFrames(nodes, 1);
				expect(result).toEqual([]);
			});

			it('should create correct number of frames', () => {
				const nodes: Node<GraphNodeData>[] = [createDocumentNode('doc1')];
				const result = createNodeExitFrames(nodes, 10);
				expect(result).toHaveLength(11); // 0 to 10 inclusive
			});

			it('should start with opacity 1 and end with opacity near 0', () => {
				const nodes: Node<GraphNodeData>[] = [createDocumentNode('doc1')];
				const result = createNodeExitFrames(nodes, 10);

				// First frame should have opacity 1
				expect(result[0][0].style?.opacity).toBe(1);

				// Last frame should have opacity near 0
				const lastFrame = result[result.length - 1];
				expect(lastFrame[0].style?.opacity).toBeLessThan(0.1);
			});

			it('should set animationPhase to exiting', () => {
				const nodes: Node<GraphNodeData>[] = [createDocumentNode('doc1')];
				const result = createNodeExitFrames(nodes, 10);

				// All frames should have 'exiting' phase
				for (const frame of result) {
					expect(frame[0].data.animationPhase).toBe('exiting');
				}
			});
		});

		describe('mergeAnimatingNodes', () => {
			it('should combine stable and animating nodes', () => {
				const stableNodes: Node<GraphNodeData>[] = [
					createDocumentNode('doc1', 0, 0),
					createDocumentNode('doc2', 100, 100),
				];
				const animatingNodes: Node<GraphNodeData>[] = [createDocumentNode('doc3', 200, 200)];

				const result = mergeAnimatingNodes(stableNodes, animatingNodes);

				expect(result).toHaveLength(3);
				expect(result.find((n) => n.id === 'doc1')).toBeDefined();
				expect(result.find((n) => n.id === 'doc2')).toBeDefined();
				expect(result.find((n) => n.id === 'doc3')).toBeDefined();
			});

			it('should replace stable node with animating counterpart', () => {
				const stableNodes: Node<GraphNodeData>[] = [
					{ ...createDocumentNode('doc1', 0, 0), style: { opacity: 1 } },
				];
				const animatingNodes: Node<GraphNodeData>[] = [
					{ ...createDocumentNode('doc1', 0, 0), style: { opacity: 0.5 } },
				];

				const result = mergeAnimatingNodes(stableNodes, animatingNodes);

				expect(result).toHaveLength(1);
				expect(result[0].style?.opacity).toBe(0.5);
			});

			it('should handle empty stable nodes', () => {
				const stableNodes: Node<GraphNodeData>[] = [];
				const animatingNodes: Node<GraphNodeData>[] = [createDocumentNode('doc1')];

				const result = mergeAnimatingNodes(stableNodes, animatingNodes);

				expect(result).toHaveLength(1);
				expect(result[0].id).toBe('doc1');
			});

			it('should handle empty animating nodes', () => {
				const stableNodes: Node<GraphNodeData>[] = [
					createDocumentNode('doc1'),
					createDocumentNode('doc2'),
				];
				const animatingNodes: Node<GraphNodeData>[] = [];

				const result = mergeAnimatingNodes(stableNodes, animatingNodes);

				expect(result).toHaveLength(2);
			});
		});

		describe('positionNewNodesNearNeighbors', () => {
			it('should position new nodes near connected existing nodes', () => {
				const existingNodes: Node<GraphNodeData>[] = [createDocumentNode('doc1', 100, 100)];
				const newNodes: Node<GraphNodeData>[] = [createDocumentNode('doc2', 0, 0)];
				const edges: Edge[] = [createEdge('doc1', 'doc2')];

				const result = positionNewNodesNearNeighbors(newNodes, existingNodes, edges);

				expect(result).toHaveLength(1);
				// New node should be positioned near doc1 (100, 100)
				const distance = Math.sqrt(
					Math.pow(result[0].position.x - 100, 2) + Math.pow(result[0].position.y - 100, 2)
				);
				// Should be within reasonable distance (nodeSeparation * 2 to account for randomness)
				expect(distance).toBeLessThan(150);
			});

			it('should position unconnected nodes at center with offset', () => {
				const existingNodes: Node<GraphNodeData>[] = [createDocumentNode('doc1', 100, 100)];
				const newNodes: Node<GraphNodeData>[] = [createDocumentNode('doc2', 0, 0)];
				const edges: Edge[] = []; // No edges connecting the new node

				const result = positionNewNodesNearNeighbors(newNodes, existingNodes, edges, {
					centerX: 200,
					centerY: 200,
				});

				expect(result).toHaveLength(1);
				// Should be roughly near the center (200, 200) with some offset
				const distance = Math.sqrt(
					Math.pow(result[0].position.x - 200, 2) + Math.pow(result[0].position.y - 200, 2)
				);
				// Should be within reasonable distance from center
				expect(distance).toBeLessThan(150);
			});

			it('should handle multiple connected neighbors (average position)', () => {
				const existingNodes: Node<GraphNodeData>[] = [
					createDocumentNode('doc1', 0, 0),
					createDocumentNode('doc2', 200, 0),
					createDocumentNode('doc3', 100, 200),
				];
				const newNodes: Node<GraphNodeData>[] = [createDocumentNode('doc4', 0, 0)];
				const edges: Edge[] = [
					createEdge('doc1', 'doc4'),
					createEdge('doc2', 'doc4'),
					createEdge('doc3', 'doc4'),
				];

				const result = positionNewNodesNearNeighbors(newNodes, existingNodes, edges);

				// Centroid of existing nodes is (100, 66.67)
				// New node should be positioned near this centroid
				const centroidX = (0 + 200 + 100) / 3;
				const centroidY = (0 + 0 + 200) / 3;
				const distance = Math.sqrt(
					Math.pow(result[0].position.x - centroidX, 2) +
						Math.pow(result[0].position.y - centroidY, 2)
				);
				// Should be within reasonable distance from centroid
				expect(distance).toBeLessThan(150);
			});

			it('should handle empty new nodes array', () => {
				const existingNodes: Node<GraphNodeData>[] = [createDocumentNode('doc1', 100, 100)];
				const newNodes: Node<GraphNodeData>[] = [];
				const edges: Edge[] = [];

				const result = positionNewNodesNearNeighbors(newNodes, existingNodes, edges);

				expect(result).toHaveLength(0);
			});

			it('should handle empty existing nodes array', () => {
				const existingNodes: Node<GraphNodeData>[] = [];
				const newNodes: Node<GraphNodeData>[] = [createDocumentNode('doc1', 0, 0)];
				const edges: Edge[] = [];

				const result = positionNewNodesNearNeighbors(newNodes, existingNodes, edges, {
					centerX: 100,
					centerY: 100,
				});

				expect(result).toHaveLength(1);
				// Should be positioned near center since there are no neighbors
				const distance = Math.sqrt(
					Math.pow(result[0].position.x - 100, 2) + Math.pow(result[0].position.y - 100, 2)
				);
				expect(distance).toBeLessThan(150);
			});
		});
	});

	describe('Circular Reference Handling', () => {
		/**
		 * These tests verify that both force and hierarchical layout algorithms
		 * correctly handle circular references (A→B→C→A) without infinite loops.
		 *
		 * Key scenarios tested:
		 * 1. Simple circular chain (A→B→C→A)
		 * 2. Complex multi-cycle graphs
		 * 3. Self-referential links (A→A)
		 * 4. Bidirectional links (A↔B)
		 * 5. Large circular graphs (stress test)
		 */

		describe('applyForceLayout with circular references', () => {
			it('should handle simple circular chain (A→B→C→A) without infinite loop', () => {
				const nodes: Node<GraphNodeData>[] = [
					createDocumentNode('doc-a'),
					createDocumentNode('doc-b'),
					createDocumentNode('doc-c'),
				];
				const edges: Edge[] = [
					createEdge('doc-a', 'doc-b'),
					createEdge('doc-b', 'doc-c'),
					createEdge('doc-c', 'doc-a'), // Completes the cycle
				];

				const result = applyForceLayout(nodes, edges);

				// Should complete without hanging
				expect(result).toHaveLength(3);

				// All nodes should have valid positions
				for (const node of result) {
					expect(node.position).toBeDefined();
					expect(typeof node.position.x).toBe('number');
					expect(typeof node.position.y).toBe('number');
					expect(Number.isFinite(node.position.x)).toBe(true);
					expect(Number.isFinite(node.position.y)).toBe(true);
				}
			});

			it('should handle self-referential link (A→A) without infinite loop', () => {
				const nodes: Node<GraphNodeData>[] = [createDocumentNode('doc-a')];
				const edges: Edge[] = [createEdge('doc-a', 'doc-a')]; // Self-loop

				const result = applyForceLayout(nodes, edges);

				expect(result).toHaveLength(1);
				expect(result[0].position).toBeDefined();
				expect(Number.isFinite(result[0].position.x)).toBe(true);
				expect(Number.isFinite(result[0].position.y)).toBe(true);
			});

			it('should handle bidirectional links (A↔B) without infinite loop', () => {
				const nodes: Node<GraphNodeData>[] = [
					createDocumentNode('doc-a'),
					createDocumentNode('doc-b'),
				];
				const edges: Edge[] = [
					createEdge('doc-a', 'doc-b'),
					createEdge('doc-b', 'doc-a'), // Bidirectional
				];

				const result = applyForceLayout(nodes, edges);

				expect(result).toHaveLength(2);
				// Both nodes should have valid positions
				for (const node of result) {
					expect(Number.isFinite(node.position.x)).toBe(true);
					expect(Number.isFinite(node.position.y)).toBe(true);
				}
			});

			it('should handle complex multi-cycle graph without infinite loop', () => {
				// Graph with multiple overlapping cycles:
				// A→B→C→A (cycle 1)
				// B→D→E→B (cycle 2)
				// C→E     (connecting the cycles)
				const nodes: Node<GraphNodeData>[] = [
					createDocumentNode('doc-a'),
					createDocumentNode('doc-b'),
					createDocumentNode('doc-c'),
					createDocumentNode('doc-d'),
					createDocumentNode('doc-e'),
				];
				const edges: Edge[] = [
					createEdge('doc-a', 'doc-b'),
					createEdge('doc-b', 'doc-c'),
					createEdge('doc-c', 'doc-a'), // Cycle 1
					createEdge('doc-b', 'doc-d'),
					createEdge('doc-d', 'doc-e'),
					createEdge('doc-e', 'doc-b'), // Cycle 2
					createEdge('doc-c', 'doc-e'), // Cross-connection
				];

				const result = applyForceLayout(nodes, edges);

				expect(result).toHaveLength(5);
				for (const node of result) {
					expect(Number.isFinite(node.position.x)).toBe(true);
					expect(Number.isFinite(node.position.y)).toBe(true);
				}
			});

			it('should handle large circular chain (50 nodes) without infinite loop or timeout', () => {
				const nodeCount = 50;
				const nodes: Node<GraphNodeData>[] = Array.from({ length: nodeCount }, (_, i) =>
					createDocumentNode(`doc-${i}`)
				);
				// Create circular chain: 0→1→2→...→49→0
				const edges: Edge[] = Array.from({ length: nodeCount }, (_, i) =>
					createEdge(`doc-${i}`, `doc-${(i + 1) % nodeCount}`)
				);

				const startTime = Date.now();
				const result = applyForceLayout(nodes, edges);
				const elapsed = Date.now() - startTime;

				expect(result).toHaveLength(nodeCount);
				// Should complete in reasonable time (less than 5 seconds)
				expect(elapsed).toBeLessThan(5000);

				// Verify all positions are valid
				for (const node of result) {
					expect(Number.isFinite(node.position.x)).toBe(true);
					expect(Number.isFinite(node.position.y)).toBe(true);
				}
			});

			it('should handle fully connected graph (all-to-all cycles) without infinite loop', () => {
				// Every node connects to every other node (including self)
				const nodeCount = 5;
				const nodes: Node<GraphNodeData>[] = Array.from({ length: nodeCount }, (_, i) =>
					createDocumentNode(`doc-${i}`)
				);
				const edges: Edge[] = [];
				for (let i = 0; i < nodeCount; i++) {
					for (let j = 0; j < nodeCount; j++) {
						edges.push(createEdge(`doc-${i}`, `doc-${j}`));
					}
				}

				const result = applyForceLayout(nodes, edges);

				expect(result).toHaveLength(nodeCount);
				for (const node of result) {
					expect(Number.isFinite(node.position.x)).toBe(true);
					expect(Number.isFinite(node.position.y)).toBe(true);
				}
			});
		});

		describe('applyHierarchicalLayout with circular references', () => {
			it('should handle simple circular chain (A→B→C→A) without infinite loop', () => {
				const nodes: Node<GraphNodeData>[] = [
					createDocumentNode('doc-a'),
					createDocumentNode('doc-b'),
					createDocumentNode('doc-c'),
				];
				const edges: Edge[] = [
					createEdge('doc-a', 'doc-b'),
					createEdge('doc-b', 'doc-c'),
					createEdge('doc-c', 'doc-a'), // Completes the cycle
				];

				const result = applyHierarchicalLayout(nodes, edges);

				// Should complete without hanging
				expect(result).toHaveLength(3);

				// All nodes should have valid positions
				for (const node of result) {
					expect(node.position).toBeDefined();
					expect(Number.isFinite(node.position.x)).toBe(true);
					expect(Number.isFinite(node.position.y)).toBe(true);
				}
			});

			it('should handle self-referential link (A→A) without infinite loop', () => {
				const nodes: Node<GraphNodeData>[] = [createDocumentNode('doc-a')];
				const edges: Edge[] = [createEdge('doc-a', 'doc-a')]; // Self-loop

				const result = applyHierarchicalLayout(nodes, edges);

				expect(result).toHaveLength(1);
				expect(Number.isFinite(result[0].position.x)).toBe(true);
				expect(Number.isFinite(result[0].position.y)).toBe(true);
			});

			it('should handle bidirectional links (A↔B) without infinite loop', () => {
				const nodes: Node<GraphNodeData>[] = [
					createDocumentNode('doc-a'),
					createDocumentNode('doc-b'),
				];
				const edges: Edge[] = [
					createEdge('doc-a', 'doc-b'),
					createEdge('doc-b', 'doc-a'), // Bidirectional
				];

				const result = applyHierarchicalLayout(nodes, edges);

				expect(result).toHaveLength(2);
				for (const node of result) {
					expect(Number.isFinite(node.position.x)).toBe(true);
					expect(Number.isFinite(node.position.y)).toBe(true);
				}
			});

			it('should handle large circular chain (50 nodes) without infinite loop or timeout', () => {
				const nodeCount = 50;
				const nodes: Node<GraphNodeData>[] = Array.from({ length: nodeCount }, (_, i) =>
					createDocumentNode(`doc-${i}`)
				);
				// Create circular chain: 0→1→2→...→49→0
				const edges: Edge[] = Array.from({ length: nodeCount }, (_, i) =>
					createEdge(`doc-${i}`, `doc-${(i + 1) % nodeCount}`)
				);

				const startTime = Date.now();
				const result = applyHierarchicalLayout(nodes, edges);
				const elapsed = Date.now() - startTime;

				expect(result).toHaveLength(nodeCount);
				// Should complete in reasonable time (less than 5 seconds)
				expect(elapsed).toBeLessThan(5000);

				// Verify all positions are valid
				for (const node of result) {
					expect(Number.isFinite(node.position.x)).toBe(true);
					expect(Number.isFinite(node.position.y)).toBe(true);
				}
			});

			it('should apply correct layout direction even with cycles', () => {
				const nodes: Node<GraphNodeData>[] = [
					createDocumentNode('doc-a'),
					createDocumentNode('doc-b'),
					createDocumentNode('doc-c'),
				];
				const edges: Edge[] = [
					createEdge('doc-a', 'doc-b'),
					createEdge('doc-b', 'doc-c'),
					createEdge('doc-c', 'doc-a'),
				];

				const tbResult = applyHierarchicalLayout(nodes, edges, { rankDirection: 'TB' });
				const lrResult = applyHierarchicalLayout(nodes, edges, { rankDirection: 'LR' });

				// Both layouts should complete successfully
				expect(tbResult).toHaveLength(3);
				expect(lrResult).toHaveLength(3);

				// Layouts should produce different arrangements
				// (at least one pair of nodes should have different relative positions)
				const tbPositions = tbResult.map((n) => ({ id: n.id, ...n.position }));
				const lrPositions = lrResult.map((n) => ({ id: n.id, ...n.position }));

				// Sort by ID to compare corresponding nodes
				tbPositions.sort((a, b) => a.id.localeCompare(b.id));
				lrPositions.sort((a, b) => a.id.localeCompare(b.id));

				// At least some positions should differ between TB and LR layouts
				let hasDifferentPosition = false;
				for (let i = 0; i < 3; i++) {
					if (tbPositions[i].x !== lrPositions[i].x || tbPositions[i].y !== lrPositions[i].y) {
						hasDifferentPosition = true;
						break;
					}
				}
				expect(hasDifferentPosition).toBe(true);
			});
		});

		describe('Edge cases with circular references', () => {
			it('should handle graph that is entirely cycles (no tree structure)', () => {
				// Two separate cycles with no connection
				const nodes: Node<GraphNodeData>[] = [
					createDocumentNode('doc-a1'),
					createDocumentNode('doc-a2'),
					createDocumentNode('doc-b1'),
					createDocumentNode('doc-b2'),
				];
				const edges: Edge[] = [
					createEdge('doc-a1', 'doc-a2'),
					createEdge('doc-a2', 'doc-a1'), // Cycle A
					createEdge('doc-b1', 'doc-b2'),
					createEdge('doc-b2', 'doc-b1'), // Cycle B
				];

				const forceResult = applyForceLayout(nodes, edges);
				const hierarchicalResult = applyHierarchicalLayout(nodes, edges);

				expect(forceResult).toHaveLength(4);
				expect(hierarchicalResult).toHaveLength(4);
			});

			it('should handle cycle with mixed internal and external links', () => {
				const nodes: Node<GraphNodeData>[] = [
					createDocumentNode('doc-a'),
					createDocumentNode('doc-b'),
					createExternalNode('github.com'),
				];
				const edges: Edge[] = [
					createEdge('doc-a', 'doc-b'),
					createEdge('doc-b', 'doc-a'), // Cycle
					createEdge('doc-a', 'ext-github.com', 'external'),
					createEdge('doc-b', 'ext-github.com', 'external'),
				];

				const forceResult = applyForceLayout(nodes, edges);
				const hierarchicalResult = applyHierarchicalLayout(nodes, edges);

				expect(forceResult).toHaveLength(3);
				expect(hierarchicalResult).toHaveLength(3);
			});

			it('should handle triple self-loop (A→A→A→A)', () => {
				const nodes: Node<GraphNodeData>[] = [createDocumentNode('doc-a')];
				// Multiple self-edges (possible in some markdown documents)
				const edges: Edge[] = [
					createEdge('doc-a', 'doc-a'),
					{ id: 'doc-a-doc-a-2', source: 'doc-a', target: 'doc-a', type: 'default' },
					{ id: 'doc-a-doc-a-3', source: 'doc-a', target: 'doc-a', type: 'default' },
				];

				const forceResult = applyForceLayout(nodes, edges);
				const hierarchicalResult = applyHierarchicalLayout(nodes, edges);

				expect(forceResult).toHaveLength(1);
				expect(hierarchicalResult).toHaveLength(1);
			});
		});
	});
});
