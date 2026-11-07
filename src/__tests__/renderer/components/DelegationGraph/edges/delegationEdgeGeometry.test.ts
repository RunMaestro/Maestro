/**
 * Tests for delegationEdgeGeometry - the line of one Delegation Graph edge.
 *
 * The rule that matters most is the last block: two agents that reach each
 * other are two edges, and the two must not be drawn as one line.
 */

import { describe, it, expect } from 'vitest';
import {
	REVERSE_PAIR_BOW,
	REVERSE_PAIR_SHIFT,
	anchorOfNode,
	graphEdgeGeometry as delegationEdgeGeometry,
	type GraphEdgeAnchor as DelegationEdgeAnchor,
} from '../../../../../renderer/utils/graphEdgeGeometry';

const NODE_WIDTH = 180;
const NODE_HEIGHT = 80;

/** A measured node whose top-left corner is at (x, y). */
function nodeAt(x: number, y: number): DelegationEdgeAnchor {
	return anchorOfNode({ positionAbsolute: { x, y }, width: NODE_WIDTH, height: NODE_HEIGHT }, 0, 0);
}

/** A node reactflow has not measured, known only by a handle position. */
function pointAt(x: number, y: number): DelegationEdgeAnchor {
	return anchorOfNode(undefined, x, y);
}

describe('anchorOfNode', () => {
	it('gives the center and half the size of a measured node', () => {
		expect(nodeAt(100, 40)).toEqual({
			centerX: 190,
			centerY: 80,
			halfWidth: 90,
			halfHeight: 40,
		});
	});

	it('falls back to the bare point when there is no node', () => {
		expect(anchorOfNode(undefined, 12, 34)).toEqual({
			centerX: 12,
			centerY: 34,
			halfWidth: 0,
			halfHeight: 0,
		});
	});

	it.each([
		['no position', { width: 180, height: 80 }],
		['a null width', { positionAbsolute: { x: 0, y: 0 }, width: null, height: 80 }],
		['a null height', { positionAbsolute: { x: 0, y: 0 }, width: 180, height: null }],
		['a zero width', { positionAbsolute: { x: 0, y: 0 }, width: 0, height: 80 }],
	])('falls back to the bare point for a node with %s', (_label, node) => {
		expect(anchorOfNode(node, 5, 6)).toEqual({
			centerX: 5,
			centerY: 6,
			halfWidth: 0,
			halfHeight: 0,
		});
	});
});

describe('delegationEdgeGeometry, one direction only', () => {
	it('runs straight from the border of one node to the border of the other', () => {
		const geometry = delegationEdgeGeometry(nodeAt(0, 0), nodeAt(400, 0), false);

		// Out of the right side of the source, into the left side of the target.
		expect(geometry.start).toEqual({ x: 180, y: 40 });
		expect(geometry.end).toEqual({ x: 400, y: 40 });
		expect(geometry.path).toBe('M 180,40 L 400,40');
	});

	it('leaves by the bottom when the target is below', () => {
		const geometry = delegationEdgeGeometry(nodeAt(0, 0), nodeAt(0, 200), false);

		expect(geometry.start).toEqual({ x: 90, y: 80 });
		expect(geometry.end).toEqual({ x: 90, y: 200 });
	});

	it('puts the label in the middle of the DRAWN line, not between the centers', () => {
		const geometry = delegationEdgeGeometry(nodeAt(0, 0), nodeAt(400, 0), false);

		expect(geometry.labelX).toBe(290);
		expect(geometry.labelY).toBe(40);
	});

	it('stops at whichever border a diagonal line reaches first', () => {
		const geometry = delegationEdgeGeometry(nodeAt(0, 0), nodeAt(300, 260), false);

		// The line is steep enough to leave a 180 x 80 node by its bottom edge.
		expect(geometry.start.y).toBe(80);
		expect(geometry.start.x).toBeGreaterThan(90);
		expect(geometry.start.x).toBeLessThan(180);
		expect(geometry.end.y).toBe(260);
	});

	it('runs point to point between two nodes that are not measured yet', () => {
		const geometry = delegationEdgeGeometry(pointAt(0, 0), pointAt(100, 0), false);

		expect(geometry.path).toBe('M 0,0 L 100,0');
	});

	it('draws a harmless zero-length path for two nodes at the same spot', () => {
		const geometry = delegationEdgeGeometry(nodeAt(0, 0), nodeAt(0, 0), true);

		expect(geometry.path).toBe('M 90,40 L 90,40');
		expect(geometry.path).not.toContain('NaN');
		expect(geometry.labelX).toBe(90);
		expect(geometry.labelY).toBe(40);
	});

	it('never writes a negative zero into the path', () => {
		const geometry = delegationEdgeGeometry(pointAt(0, 0), pointAt(-100, 0), false);

		expect(geometry.path).toBe('M 0,0 L -100,0');
	});
});

/**
 * The visual case the edge exists for: a manager who delegates down to an
 * employee who consults back up. That is two edges between one pair, drawn
 * with the manager directly above the employee.
 */
describe('delegationEdgeGeometry, a manager and an employee who reach each other', () => {
	const manager = nodeAt(0, 0);
	const employee = nodeAt(0, 200);
	const down = delegationEdgeGeometry(manager, employee, true);
	const up = delegationEdgeGeometry(employee, manager, true);
	// The straight line the two would share if neither moved aside.
	const sharedX = 90;

	it('draws two different paths', () => {
		expect(down.path).not.toBe(up.path);
	});

	it('curves each one, where a single direction is straight', () => {
		expect(down.path).toMatch(/^M [\d.,-]+ Q [\d.,-]+ [\d.,-]+$/);
		expect(up.path).toMatch(/^M [\d.,-]+ Q [\d.,-]+ [\d.,-]+$/);
		expect(delegationEdgeGeometry(manager, employee, false).path).toContain(' L ');
	});

	it('puts the two on opposite sides of the line between the nodes', () => {
		expect((down.labelX - sharedX) * (up.labelX - sharedX)).toBeLessThan(0);
		expect((down.start.x - sharedX) * (up.start.x - sharedX)).toBeLessThan(0);
		expect((down.end.x - sharedX) * (up.end.x - sharedX)).toBeLessThan(0);
	});

	it('keeps the ends apart, so the two arrowheads do not meet at one point', () => {
		// The arrowhead of `down` is on the employee; `up` leaves the employee.
		expect(Math.abs(down.end.x - up.start.x)).toBe(REVERSE_PAIR_SHIFT * 2);
		expect(Math.abs(up.end.x - down.start.x)).toBe(REVERSE_PAIR_SHIFT * 2);
	});

	it('keeps the badges far enough apart to read as two', () => {
		const apart = Math.hypot(down.labelX - up.labelX, down.labelY - up.labelY);

		expect(apart).toBe((REVERSE_PAIR_SHIFT + REVERSE_PAIR_BOW) * 2);
		// A badge is about 26 px wide. The two must not touch.
		expect(apart).toBeGreaterThan(26);
	});

	it('still ends each edge on a node border', () => {
		expect(down.start.y).toBe(80);
		expect(down.end.y).toBe(200);
		expect(up.start.y).toBe(200);
		expect(up.end.y).toBe(80);
	});

	it('mirrors the two edges across the line between the nodes', () => {
		expect(down.labelX + up.labelX).toBe(sharedX * 2);
		expect(down.labelY).toBe(up.labelY);
	});

	it('separates a side-by-side pair the same way, on the other axis', () => {
		const left = nodeAt(0, 0);
		const right = nodeAt(400, 0);
		const out = delegationEdgeGeometry(left, right, true);
		const back = delegationEdgeGeometry(right, left, true);

		expect(out.path).not.toBe(back.path);
		expect((out.labelY - 40) * (back.labelY - 40)).toBeLessThan(0);
		expect(Math.abs(out.labelY - back.labelY)).toBe((REVERSE_PAIR_SHIFT + REVERSE_PAIR_BOW) * 2);
	});

	it('separates a pair at any angle', () => {
		const a = nodeAt(0, 0);
		const b = nodeAt(300, 260);
		const out = delegationEdgeGeometry(a, b, true);
		const back = delegationEdgeGeometry(b, a, true);

		// Each lane meets the node borders at its own spot, so the two badges can
		// also slide along the line. They are never closer than the lanes are.
		const apart = Math.hypot(out.labelX - back.labelX, out.labelY - back.labelY);
		expect(out.path).not.toBe(back.path);
		expect(apart).toBeGreaterThan((REVERSE_PAIR_SHIFT + REVERSE_PAIR_BOW) * 2 - 0.1);
	});

	it('separates a pair that is not measured yet', () => {
		const out = delegationEdgeGeometry(pointAt(0, 0), pointAt(0, 100), true);
		const back = delegationEdgeGeometry(pointAt(0, 100), pointAt(0, 0), true);

		expect(out.path).toBe('M -8,0 Q -36,50 -8,100');
		expect(back.path).toBe('M 8,100 Q 36,50 8,0');
	});
});
