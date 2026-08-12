import { describe, it, expect } from 'vitest';
import { Position } from 'reactflow';
import { resolveStepOffset } from '../../../../../renderer/components/CuePipelineEditor/edges/PipelineEdge';

/**
 * `getSmoothStepPath` reserves a straight stub of `offset` px at BOTH ends of an
 * edge before it turns, so it needs 2 * offset px of clearance between handles.
 * Given less, it overshoots and doubles back, drawing hooks instead of one clean
 * elbow. `resolveStepOffset` shrinks the stub to fit tight layouts.
 */
describe('resolveStepOffset', () => {
	it('uses the full 20px stub when the nodes have room', () => {
		expect(resolveStepOffset(0, 0, 200, 100, Position.Right, Position.Left)).toBe(20);
	});

	it('uses the full stub at exactly the 40px break-even clearance', () => {
		expect(resolveStepOffset(0, 0, 40, 100, Position.Right, Position.Left)).toBe(20);
	});

	it('halves the stub when the horizontal gap is smaller than two stubs', () => {
		// 20px of clearance: both gapped points land on the midpoint, so the path
		// is source -> up/down -> target with a single right-angle pair.
		expect(resolveStepOffset(0, 0, 20, 100, Position.Right, Position.Left)).toBe(10);
		expect(resolveStepOffset(100, 0, 106, 60, Position.Right, Position.Left)).toBe(3);
	});

	it('handles a right-to-left flowing graph (Left source, Right target)', () => {
		expect(resolveStepOffset(200, 0, 180, 100, Position.Left, Position.Right)).toBe(10);
		expect(resolveStepOffset(200, 0, 0, 100, Position.Left, Position.Right)).toBe(20);
	});

	it('handles vertical flow on the Y axis', () => {
		expect(resolveStepOffset(0, 0, 100, 24, Position.Bottom, Position.Top)).toBe(12);
		expect(resolveStepOffset(0, 100, 100, 90, Position.Top, Position.Bottom)).toBe(5);
	});

	it('keeps the full stub for a backwards edge, which must loop around the node', () => {
		expect(resolveStepOffset(200, 0, 100, 50, Position.Right, Position.Left)).toBe(20);
		expect(resolveStepOffset(0, 0, 0, 50, Position.Right, Position.Left)).toBe(20);
	});

	it('keeps the full stub for mixed-axis handles', () => {
		expect(resolveStepOffset(0, 0, 10, 10, Position.Right, Position.Top)).toBe(20);
		expect(resolveStepOffset(0, 0, 10, 10, Position.Bottom, Position.Left)).toBe(20);
	});

	it('never returns a stub that overshoots the midpoint', () => {
		for (let gap = 1; gap <= 60; gap++) {
			const offset = resolveStepOffset(0, 0, gap, 80, Position.Right, Position.Left);
			expect(offset).toBeLessThanOrEqual(gap / 2);
			expect(offset).toBeGreaterThan(0);
		}
	});
});
