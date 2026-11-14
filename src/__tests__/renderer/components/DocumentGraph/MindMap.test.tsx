import { fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
	MindMapNode,
	MindMapProps,
} from '../../../../renderer/components/DocumentGraph/MindMap';
import { MindMap } from '../../../../renderer/components/DocumentGraph/MindMap';
import { delegationMindMapData } from '../../../../renderer/components/DelegationGraph/delegationLayouts';
import { mockTheme } from '../../../helpers/mockTheme';

const drawing = vi.hoisted(() => ({
	drawLink:
		vi.fn<typeof import('../../../../renderer/components/DocumentGraph/mindMapCanvas').drawLink>(),
	renderDocumentNode: vi.fn<(context: CanvasRenderingContext2D, node: MindMapNode) => void>(),
}));

vi.mock('../../../../renderer/components/DocumentGraph/mindMapCanvas', async (importOriginal) => ({
	...(await importOriginal<
		typeof import('../../../../renderer/components/DocumentGraph/mindMapCanvas')
	>()),
	drawLink: drawing.drawLink,
	renderDocumentNode: drawing.renderDocumentNode,
}));

// The minimap has its own tests; keep this canvas's drawing calls separate.
vi.mock('../../../../renderer/components/DocumentGraph/GraphMiniMap', () => ({
	GraphMiniMap: () => null,
}));

const data = delegationMindMapData({
	nodes: [
		{ sessionId: 'a', name: 'Alpha', scope: 'in-scope' },
		{ sessionId: 'b', name: 'Beta', scope: 'in-scope' },
	],
	edges: [
		{ id: 'a->b', sourceId: 'a', targetId: 'b', read: true, write: false, source: 'explicit' },
	],
});

const context = {
	translate: vi.fn<(x: number, y: number) => void>(),
	scale: vi.fn<(x: number, y: number) => void>(),
};

const props: MindMapProps = {
	...data,
	theme: mockTheme,
	width: 600,
	height: 400,
	centerFilePath: 'a',
	maxDepth: 1,
	showExternalLinks: false,
	selectedNodeId: null,
	onNodeSelect: vi.fn(),
	onNodeDoubleClick: vi.fn(),
	onNodeContextMenu: vi.fn(),
	onOpenFile: vi.fn(),
	searchQuery: '',
	previewCharLimit: 0,
	selectCenterOnOpen: false,
};

describe('MindMap shared canvas', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// jsdom has no canvas painter. Keep real layout, hit testing, and gestures.
		const painter = new Proxy(context, {
			get: (target, key) => Reflect.get(target, key) ?? vi.fn(),
		});
		vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
			painter as unknown as CanvasRenderingContext2D
		);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('preserves document selection on open while allowing the fleet view to start unselected', () => {
		const view = render(<MindMap {...props} />);
		expect(props.onNodeSelect).not.toHaveBeenCalled();
		view.unmount();
		render(<MindMap {...props} selectCenterOnOpen />);
		expect(props.onNodeSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }));
	});

	it('passes directed link style and shared border routing to the painter', () => {
		render(<MindMap {...props} />);
		const call = drawing.drawLink.mock.lastCall!;
		expect(call[7]).toBe(true); // Consult links are dashed.
		expect(call[8]).toBe(true); // Directed relationships have an arrowhead.
		expect(call[9]?.start).toEqual({ x: call[1], y: call[2] });
		expect(call[9]?.end).toEqual({ x: call[3], y: call[4] });
	});

	it('captures every displayed position on a drag and does not refit under the pointer', () => {
		const positions = new Map([
			['a', { x: 0, y: 0 }],
			['b', { x: 200, y: 0 }],
		]);
		const onNodePositionChange = vi.fn<NonNullable<MindMapProps['onNodePositionChange']>>();
		const view = render(
			<MindMap {...props} nodePositions={positions} onNodePositionChange={onNodePositionChange} />
		);
		const canvas = view.container.querySelector('canvas')!;
		const [panX, panY] = context.translate.mock.lastCall!;
		const [zoom] = context.scale.mock.lastCall!;
		fireEvent.mouseDown(canvas, { button: 0, clientX: panX, clientY: panY });
		fireEvent.mouseMove(canvas, { clientX: panX + 40, clientY: panY + 25 });
		const [id, position, snapshot] = onNodePositionChange.mock.lastCall!;
		expect(id).toBe('a');
		expect(position.x).toBeCloseTo(40 / zoom);
		expect(position.y).toBeCloseTo(25 / zoom);
		expect(snapshot.get('a')).toEqual(position);
		expect(snapshot.get('b')).toEqual(positions.get('b'));
		view.rerender(
			<MindMap
				{...props}
				layoutType="force"
				nodePositions={new Map(snapshot)}
				onNodePositionChange={onNodePositionChange}
			/>
		);
		expect(context.translate.mock.lastCall).toEqual([panX, panY]);
	});

	it('fits saved coordinates even when they are far outside the algorithm layout', () => {
		const positions = new Map([
			['a', { x: 8000, y: -5000 }],
			['b', { x: 8200, y: -5000 }],
		]);
		render(<MindMap {...props} nodePositions={positions} fitToken={1} />);
		const [panX, panY] = context.translate.mock.lastCall!;
		const [zoom] = context.scale.mock.lastCall!;
		for (const position of positions.values()) {
			expect(position.x * zoom + panX).toBeGreaterThan(0);
			expect(position.x * zoom + panX).toBeLessThan(props.width);
			expect(position.y * zoom + panY).toBeGreaterThan(0);
			expect(position.y * zoom + panY).toBeLessThan(props.height);
		}
	});
});
