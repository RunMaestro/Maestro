import { describe, expect, it, vi } from 'vitest';
import { drawLink } from '../../../../renderer/components/DocumentGraph/mindMapCanvas';
import { graphEdgeGeometry } from '../../../../renderer/utils/graphEdgeGeometry';

describe('drawLink', () => {
	it.each([
		[false, false],
		[true, false],
		[true, true],
	])('draws shared routing with arrows=%s and reciprocal lanes=%s', (directed, reverse) => {
		const context = {
			beginPath: vi.fn(),
			moveTo: vi.fn(),
			lineTo: vi.fn(),
			bezierCurveTo: vi.fn(),
			quadraticCurveTo: vi.fn(),
			stroke: vi.fn(),
			setLineDash: vi.fn(),
			closePath: vi.fn(),
			fill: vi.fn(),
		};
		const geometry = directed
			? graphEdgeGeometry(
					{ centerX: 0, centerY: 0, halfWidth: 10, halfHeight: 10 },
					{ centerX: 100, centerY: 60, halfWidth: 10, halfHeight: 10 },
					reverse
				)
			: undefined;
		drawLink(
			context as unknown as CanvasRenderingContext2D,
			geometry?.start.x ?? 0,
			geometry?.start.y ?? 0,
			geometry?.end.x ?? 100,
			geometry?.end.y ?? 60,
			'#9146FF',
			1.5,
			true,
			directed,
			geometry
		);
		expect(context.setLineDash).toHaveBeenCalledWith([6, 4]);
		expect(context.setLineDash).toHaveBeenLastCalledWith([]);
		expect(context.stroke).toHaveBeenCalledOnce();
		expect(context.fill).toHaveBeenCalledTimes(directed ? 1 : 0);
		if (directed) expect(context.moveTo).toHaveBeenLastCalledWith(geometry!.end.x, geometry!.end.y);
		if (reverse)
			expect(context.quadraticCurveTo).toHaveBeenCalledWith(
				geometry!.control!.x,
				geometry!.control!.y,
				geometry!.end.x,
				geometry!.end.y
			);
	});
});
