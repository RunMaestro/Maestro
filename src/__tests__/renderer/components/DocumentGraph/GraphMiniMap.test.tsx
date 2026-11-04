import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { GraphMiniMap } from '../../../../renderer/components/DocumentGraph/GraphMiniMap';
import type { MindMapNode } from '../../../../renderer/components/DocumentGraph/MindMap';
import { mockTheme } from '../../../helpers/mockTheme';

// jsdom has no 2D canvas context, so getContext('2d') returns null and the
// component's draw() bails early. That's fine: these tests cover the rendering
// guards and positioning logic, which don't depend on the canvas actually
// painting. The click/drag-to-navigate path needs a live context (geomRef is
// only populated by draw()) and can't be exercised here.

function makeNode(id: string, x: number, y: number): MindMapNode {
	return {
		id,
		x,
		y,
		width: 120,
		height: 60,
		depth: 0,
		side: 'center',
		nodeType: 'document',
		label: id,
	};
}

const baseProps = {
	theme: mockTheme,
	viewWidth: 800,
	viewHeight: 600,
	transform: { zoom: 1, panX: 0, panY: 0 },
	onRecenter: vi.fn(),
	legendExpanded: false,
	selectedNodeId: null,
	focusedNodeId: null,
};

describe('GraphMiniMap', () => {
	it('renders nothing when there are no nodes', () => {
		const { container } = render(<GraphMiniMap {...baseProps} nodes={[]} />);
		expect(container.firstChild).toBeNull();
	});

	it('renders nothing with a single node (nothing worth navigating)', () => {
		const { container } = render(<GraphMiniMap {...baseProps} nodes={[makeNode('a', 0, 0)]} />);
		expect(container.firstChild).toBeNull();
	});

	it('renders the minimap once there are at least two nodes', () => {
		const { container } = render(
			<GraphMiniMap {...baseProps} nodes={[makeNode('a', 0, 0), makeNode('b', 300, 200)]} />
		);
		const root = container.firstChild as HTMLElement | null;
		expect(root).not.toBeNull();
		expect(root?.querySelector('canvas')).not.toBeNull();
	});

	it('sits at the edge margin when the legend is collapsed', () => {
		const { container } = render(
			<GraphMiniMap
				{...baseProps}
				legendExpanded={false}
				nodes={[makeNode('a', 0, 0), makeNode('b', 300, 200)]}
			/>
		);
		const root = container.firstChild as HTMLElement;
		// EDGE_MARGIN (12px) with no legend offset.
		expect(root.style.left).toBe('12px');
	});

	it('slides clear of the legend drawer when it is expanded', () => {
		const { container } = render(
			<GraphMiniMap
				{...baseProps}
				legendExpanded={true}
				nodes={[makeNode('a', 0, 0), makeNode('b', 300, 200)]}
			/>
		);
		const root = container.firstChild as HTMLElement;
		// LEGEND_WIDTH (280) + EDGE_MARGIN (12) = 292px when the legend is open.
		expect(root.style.left).toBe('292px');
	});
});
