import React from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	MindMap,
	convertToMindMapData,
	type MindMapNode,
} from '../../renderer/components/DocumentGraph/MindMap';
import {
	buildAdjacencyMap,
	calculateNodeHeight,
	calculateLayout,
	LAYOUT_LABELS,
} from '../../renderer/components/DocumentGraph/mindMapLayouts';
import { logger } from '../../renderer/utils/logger';
import type { GraphNodeData } from '../../renderer/components/DocumentGraph/graphDataBuilder';
import type { Theme } from '../../renderer/types';

type DocumentData = Extract<GraphNodeData, { nodeType: 'document' }>;
type ExternalData = Extract<GraphNodeData, { nodeType: 'external' }>;

const theme: Theme = {
	id: 'integration',
	name: 'Integration',
	mode: 'dark',
	colors: {
		bgMain: '#282a36',
		bgSidebar: '#21222c',
		bgActivity: '#343746',
		border: '#44475a',
		textMain: '#f8f8f2',
		textDim: '#6272a4',
		accent: '#bd93f9',
		accentDim: 'rgba(189, 147, 249, 0.2)',
		accentText: '#ff79c6',
		accentForeground: '#282a36',
		success: '#50fa7b',
		warning: '#ffb86c',
		error: '#ff5555',
	},
};

const canvasRect = {
	x: 0,
	y: 0,
	left: 0,
	top: 0,
	right: 600,
	bottom: 400,
	width: 600,
	height: 400,
	toJSON: () => ({}),
} as DOMRect;

function documentData(overrides: Partial<DocumentData> = {}): DocumentData {
	return {
		nodeType: 'document',
		title: 'Project Overview',
		lineCount: 12,
		wordCount: 140,
		size: '1.2 KB',
		filePath: 'docs/project-overview.md',
		...overrides,
	};
}

function externalData(overrides: Partial<ExternalData> = {}): ExternalData {
	return {
		nodeType: 'external',
		domain: 'example.com',
		linkCount: 1,
		urls: ['https://example.com/docs'],
		...overrides,
	};
}

function createCanvasContext(): CanvasRenderingContext2D {
	return {
		beginPath: vi.fn(),
		bezierCurveTo: vi.fn(),
		closePath: vi.fn(),
		clearRect: vi.fn(),
		fill: vi.fn(),
		fillRect: vi.fn(),
		fillText: vi.fn(),
		lineTo: vi.fn(),
		measureText: vi.fn((text: string) => ({ width: text.length * 7 }) as TextMetrics),
		moveTo: vi.fn(),
		quadraticCurveTo: vi.fn(),
		rect: vi.fn(),
		restore: vi.fn(),
		save: vi.fn(),
		scale: vi.fn(),
		setTransform: vi.fn(),
		setLineDash: vi.fn(),
		stroke: vi.fn(),
		strokeRect: vi.fn(),
		translate: vi.fn(),
	} as unknown as CanvasRenderingContext2D;
}

function getNode(nodes: MindMapNode[], id: string): MindMapNode {
	const node = nodes.find((candidate) => candidate.id === id);
	expect(node).toBeDefined();
	return node!;
}

function createFixture() {
	return convertToMindMapData(
		[
			{
				id: 'doc-a',
				data: documentData({
					title: 'Alpha',
					filePath: 'docs/Alpha.md',
					description: 'Frontmatter summary',
				}),
			},
			{
				id: 'doc-b',
				data: documentData({
					title: 'Beta',
					filePath: 'docs/Beta.md',
					contentPreview: 'Linked document preview text.',
				}),
			},
			{
				id: 'ext-example',
				data: externalData({
					domain: 'example.com',
					urls: ['https://example.com/docs'],
				}),
			},
		],
		[
			{ source: 'doc-a', target: 'doc-b' },
			{ source: 'doc-a', target: 'ext-example', type: 'external' },
		]
	);
}

function createLayoutFixture() {
	return convertToMindMapData(
		[
			{
				id: 'doc-center',
				data: documentData({
					title: 'Center',
					filePath: 'docs/Center.md',
					description: 'Center description '.repeat(10),
				}),
			},
			{
				id: 'doc-alpha',
				data: documentData({
					title: 'Alpha',
					filePath: 'docs/Alpha.md',
					contentPreview: 'Alpha preview '.repeat(8),
				}),
			},
			{
				id: 'doc-beta',
				data: documentData({
					title: 'Beta',
					filePath: 'docs/Beta.md',
				}),
			},
			{
				id: 'doc-gamma',
				data: documentData({
					title: 'Gamma',
					filePath: 'nested/Gamma.md',
				}),
			},
			{
				id: 'ext-alpha',
				data: externalData({
					domain: 'alpha.example',
					urls: ['https://alpha.example/docs'],
				}),
			},
			{
				id: 'ext-zeta',
				data: externalData({
					domain: 'zeta.example',
					urls: ['https://zeta.example/docs'],
				}),
			},
		],
		[
			{ source: 'doc-center', target: 'doc-alpha' },
			{ source: 'doc-alpha', target: 'doc-beta' },
			{ source: 'doc-beta', target: 'doc-gamma' },
			{ source: 'doc-gamma', target: 'doc-center' },
			{ source: 'doc-center', target: 'ext-zeta', type: 'external' },
			{ source: 'doc-alpha', target: 'ext-alpha', type: 'external' },
			{ source: 'doc-alpha', target: 'doc-center' },
		]
	);
}

describe('MindMap integration', () => {
	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	it('converts graph data and drives document-node mouse and keyboard workflows', async () => {
		const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
		const { nodes: convertedNodes, links: convertedLinks } = convertToMindMapData(
			[
				{
					id: 'doc-a',
					data: documentData({
						title: 'Alpha',
						filePath: 'docs/Alpha.md',
						description: 'Frontmatter summary',
						brokenLinks: ['Missing.md'],
						isLargeFile: true,
					}),
				},
				{
					id: 'doc-a',
					data: documentData({ title: 'Ignored duplicate', filePath: 'docs/ignored.md' }),
				},
				{
					id: 'doc-b',
					data: documentData({
						title: 'Beta',
						filePath: 'docs/Beta.md',
						contentPreview: 'Linked document preview text.',
					}),
				},
				{
					id: 'ext-example',
					data: externalData({
						domain: 'example.com',
						urls: ['https://example.com/docs'],
					}),
				},
			],
			[
				{ source: 'doc-a', target: 'doc-b' },
				{ source: 'doc-b', target: 'doc-a' },
				{ source: 'doc-a', target: 'ext-example', type: 'external' },
			]
		);
		expect(warn).toHaveBeenCalledWith('[MindMap] Skipping duplicate node: doc-a');
		expect(convertedNodes.map((node) => node.id)).toEqual(['doc-a', 'doc-b', 'ext-example']);
		expect(convertedLinks).toHaveLength(2);

		const canvasContext = createCanvasContext();
		vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvasContext);
		vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue(canvasRect);

		const onNodeSelect = vi.fn();
		const onNodeDoubleClick = vi.fn();
		const onNodePreview = vi.fn();
		const onNodeContextMenu = vi.fn();
		const onOpenFile = vi.fn();
		const onNodePositionChange = vi.fn();

		const { container } = render(
			<React.StrictMode>
				<MindMap
					centerFilePath="docs/Alpha.md"
					nodes={convertedNodes}
					links={convertedLinks}
					theme={theme}
					width={600}
					height={400}
					maxDepth={2}
					showExternalLinks={true}
					selectedNodeId={null}
					onNodeSelect={onNodeSelect}
					onNodeDoubleClick={onNodeDoubleClick}
					onNodePreview={onNodePreview}
					onNodeContextMenu={onNodeContextMenu}
					onOpenFile={onOpenFile}
					searchQuery="example"
					previewCharLimit={80}
					onNodePositionChange={onNodePositionChange}
				/>
			</React.StrictMode>
		);

		await waitFor(() => {
			expect(canvasContext.fillRect).toHaveBeenCalledWith(0, 0, 600, 400);
		});
		expect(onNodeSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'doc-a' }));
		expect(canvasContext.fillText).toHaveBeenCalled();

		const wrapper = container.querySelector('div[tabindex="0"]') as HTMLElement;
		const canvas = container.querySelector('canvas')!;

		fireEvent.mouseDown(canvas, { clientX: 300, clientY: 200 });
		expect(onNodeSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'doc-a' }));

		fireEvent.mouseMove(canvas, { clientX: 330, clientY: 220 });
		expect(onNodePositionChange).toHaveBeenCalledWith(
			'doc-a',
			expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) })
		);

		fireEvent.mouseUp(canvas);
		fireEvent.contextMenu(canvas, { clientX: 300, clientY: 200 });
		expect(onNodeContextMenu).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'doc-a' }),
			expect.any(MouseEvent)
		);

		fireEvent.keyDown(wrapper, { key: 'Enter' });
		fireEvent.keyDown(wrapper, { key: 'P' });
		expect(onNodePreview).toHaveBeenCalledWith(expect.objectContaining({ id: 'doc-a' }));

		fireEvent.keyDown(wrapper, { key: 'o' });
		expect(onOpenFile).toHaveBeenCalledWith('docs/Alpha.md');

		fireEvent.keyDown(wrapper, { key: ' ' });
		expect(onNodeDoubleClick).toHaveBeenCalledWith(expect.objectContaining({ id: 'doc-a' }));

		const layoutCenterNode = getNode(
			calculateLayout(
				'mindmap',
				convertedNodes,
				convertedLinks,
				buildAdjacencyMap(convertedLinks),
				'docs/Alpha.md',
				2,
				600,
				400,
				true,
				80
			).nodes,
			'doc-a'
		);
		const openIconScreenX = 300 + layoutCenterNode.width / 2 - 15;
		const openIconScreenY = 200 - layoutCenterNode.height / 2 + 16;
		fireEvent.mouseDown(canvas, { clientX: openIconScreenX, clientY: openIconScreenY });
		expect(onOpenFile).toHaveBeenCalledWith('docs/Alpha.md');

		const now = vi.spyOn(Date, 'now');
		now.mockReturnValueOnce(1000).mockReturnValueOnce(1100);
		fireEvent.mouseDown(canvas, { clientX: 300, clientY: 200 });
		fireEvent.mouseUp(canvas);
		fireEvent.mouseDown(canvas, { clientX: 300, clientY: 200 });
		expect(onNodeDoubleClick).toHaveBeenCalledWith(expect.objectContaining({ id: 'doc-a' }));

		onNodeSelect.mockClear();
		fireEvent.mouseDown(canvas, { clientX: -1000, clientY: -1000 });
		expect(onNodeSelect).toHaveBeenCalledWith(null);
		fireEvent.mouseMove(canvas, { clientX: -900, clientY: -900 });
		fireEvent.mouseUp(canvas);
		fireEvent.mouseLeave(canvas);

		const translateCallsBeforeWheel = vi.mocked(canvasContext.translate).mock.calls.length;
		fireEvent.wheel(canvas, { clientX: 300, clientY: 200, deltaY: -100 });
		await waitFor(() => {
			expect(vi.mocked(canvasContext.translate).mock.calls.length).toBeGreaterThan(
				translateCallsBeforeWheel
			);
		});
	});

	it('opens focused external nodes and navigates spatially through custom positions', async () => {
		const canvasContext = createCanvasContext();
		vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvasContext);
		vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue(canvasRect);
		const windowOpen = vi.spyOn(window, 'open').mockImplementation(() => null);

		const { nodes, links } = createFixture();
		const onNodeSelect = vi.fn();
		const nodePositions = new Map([
			['doc-a', { x: 300, y: 200 }],
			['doc-b', { x: 520, y: 200 }],
			['ext-example', { x: 500, y: 320 }],
		]);
		const layoutCenter = getNode(
			calculateLayout(
				'mindmap',
				nodes,
				links,
				buildAdjacencyMap(links),
				'docs/Alpha.md',
				2,
				600,
				400,
				true,
				100
			).nodes,
			'doc-a'
		);
		const panX = 600 / 2 - layoutCenter.x;
		const panY = 400 / 2 - layoutCenter.y;

		const { container, rerender } = render(
			<MindMap
				centerFilePath="docs/Alpha.md"
				nodes={nodes}
				links={links}
				theme={theme}
				width={600}
				height={400}
				maxDepth={2}
				showExternalLinks={true}
				selectedNodeId="ext-example"
				onNodeSelect={onNodeSelect}
				onNodeDoubleClick={vi.fn()}
				onNodePreview={vi.fn()}
				onNodeContextMenu={vi.fn()}
				onOpenFile={vi.fn()}
				searchQuery=""
				nodePositions={nodePositions}
			/>
		);

		await waitFor(() => {
			expect(canvasContext.fillRect).toHaveBeenCalledWith(0, 0, 600, 400);
		});

		const wrapper = container.querySelector('div[tabindex="0"]') as HTMLElement;
		fireEvent.keyDown(wrapper, { key: 'Enter' });
		expect(windowOpen).toHaveBeenCalledWith('https://example.com/docs', '_blank');

		rerender(
			<MindMap
				centerFilePath="docs/Alpha.md"
				nodes={nodes}
				links={links}
				theme={theme}
				width={600}
				height={400}
				maxDepth={2}
				showExternalLinks={true}
				selectedNodeId="doc-a"
				onNodeSelect={onNodeSelect}
				onNodeDoubleClick={vi.fn()}
				onNodePreview={vi.fn()}
				onNodeContextMenu={vi.fn()}
				onOpenFile={vi.fn()}
				searchQuery="beta"
				nodePositions={nodePositions}
			/>
		);

		fireEvent.keyDown(wrapper, { key: 'ArrowRight' });
		expect(onNodeSelect).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'doc-b' }));

		const canvas = container.querySelector('canvas')!;
		fireEvent.mouseMove(canvas, { clientX: 500 + panX, clientY: 320 + panY });
		await waitFor(() => {
			expect(canvas.style.cursor).toBe('grab');
		});
		fireEvent.mouseMove(canvas, { clientX: -1000, clientY: -1000 });
		await waitFor(() => {
			expect(canvas.style.cursor).toBe('default');
		});
	});

	it('calculates node heights, labels, empty layouts, and dispatcher fallbacks', () => {
		expect(LAYOUT_LABELS.mindmap.name).toBe('Mind Map');
		expect(calculateNodeHeight(undefined, 80)).toBeGreaterThan(0);
		const longHeight = calculateNodeHeight('long preview '.repeat(40), 200);
		expect(calculateNodeHeight('long preview '.repeat(40), 200)).toBe(longHeight);
		expect(longHeight).toBeGreaterThan(calculateNodeHeight('short', 200));

		const emptyAdjacency = new Map<string, Set<string>>();
		for (const layoutType of ['mindmap', 'radial', 'force'] as const) {
			expect(
				calculateLayout(layoutType, [], [], emptyAdjacency, 'missing.md', 2, 640, 480, true, 80)
			).toEqual({
				nodes: [],
				links: [],
				bounds: { minX: 0, maxX: 640, minY: 0, maxY: 480 },
			});
		}

		const { nodes, links } = createLayoutFixture();
		const adjacency = buildAdjacencyMap(links);
		const fallback = calculateLayout(
			'unknown' as 'mindmap',
			nodes,
			links,
			adjacency,
			'missing.md',
			1,
			640,
			480,
			false,
			80
		);
		expect(fallback.nodes[0].id).toBe('doc-center');
		expect(fallback.nodes.every((node) => node.nodeType === 'document')).toBe(true);
	});

	it('lays out mindmap branches with center matching, depth filtering, and external rows', () => {
		const { nodes, links } = createLayoutFixture();
		const adjacency = buildAdjacencyMap(links);

		const byFilename = calculateLayout(
			'mindmap',
			nodes,
			links,
			adjacency,
			'/docs/Center.md',
			3,
			800,
			600,
			true,
			140
		);
		expect(getNode(byFilename.nodes, 'doc-center').isFocused).toBe(true);
		expect(getNode(byFilename.nodes, 'doc-alpha').side).toMatch(/left|right/);
		expect(getNode(byFilename.nodes, 'ext-alpha').side).toBe('external');
		expect(getNode(byFilename.nodes, 'ext-zeta').x).toBeGreaterThan(
			getNode(byFilename.nodes, 'ext-alpha').x
		);
		expect(byFilename.links.some((link) => link.type === 'external')).toBe(true);
		expect(byFilename.bounds.minX).toBeLessThan(byFilename.bounds.maxX);

		const noExternal = calculateLayout(
			'mindmap',
			nodes,
			links,
			adjacency,
			'Center',
			1,
			800,
			600,
			false,
			80
		);
		expect(noExternal.nodes.map((node) => node.id)).toEqual(
			expect.arrayContaining(['doc-center', 'doc-alpha', 'doc-gamma'])
		);
		expect(noExternal.nodes.some((node) => node.nodeType === 'external')).toBe(false);
		expect(noExternal.nodes.some((node) => node.id === 'doc-beta')).toBe(false);
	});

	it('lays out radial rings and force simulations with visible link filtering', () => {
		const { nodes, links } = createLayoutFixture();
		const adjacency = buildAdjacencyMap(links);

		const radial = calculateLayout(
			'radial',
			nodes,
			links,
			adjacency,
			'docs/Center.md',
			3,
			900,
			700,
			true,
			120
		);
		expect(radial.nodes).toHaveLength(nodes.length);
		expect(getNode(radial.nodes, 'doc-center').side).toBe('center');
		expect(getNode(radial.nodes, 'doc-alpha').depth).toBe(1);
		expect(getNode(radial.nodes, 'doc-beta').depth).toBe(2);
		expect(getNode(radial.nodes, 'ext-alpha').side).toBe('external');
		expect(radial.links.every((link) => link.source !== 'missing')).toBe(true);
		expect(radial.bounds.maxY).toBeGreaterThan(radial.bounds.minY);

		const force = calculateLayout(
			'force',
			nodes,
			links,
			adjacency,
			'Center.md',
			3,
			900,
			700,
			true,
			120
		);
		expect(force.nodes).toHaveLength(nodes.length);
		expect(getNode(force.nodes, 'doc-center').isFocused).toBe(true);
		expect(getNode(force.nodes, 'ext-alpha').side).toBe('external');
		expect(force.links.some((link) => link.type === 'external')).toBe(true);
		expect(
			force.links.filter(
				(link) =>
					(link.source === 'doc-center' && link.target === 'doc-alpha') ||
					(link.source === 'doc-alpha' && link.target === 'doc-center')
			)
		).toHaveLength(1);
		for (const node of force.nodes) {
			expect(Number.isFinite(node.x)).toBe(true);
			expect(Number.isFinite(node.y)).toBe(true);
		}
	});

	it('covers render fallbacks for long text, missing metadata, and absent canvas geometry', async () => {
		const { nodes, links } = convertToMindMapData(
			[
				{
					id: 'doc-long',
					data: documentData({
						title: 'A very long title that should be truncated by the canvas renderer',
						filePath: undefined,
						description: 'word '.repeat(80),
						contentPreview: undefined,
					}),
				},
				{
					id: 'doc-empty',
					data: documentData({
						title: 'Empty',
						filePath: undefined,
						description: undefined,
						contentPreview: undefined,
					}),
				},
				{
					id: 'ext-long',
					data: externalData({
						domain: 'very-long-external-domain-name.example.com',
						urls: [],
					}),
				},
			],
			[{ source: 'doc-long', target: 'ext-long', type: 'external' }],
			220
		);
		expect(getNode(nodes, 'doc-empty').connectionCount).toBe(0);
		expect(getNode(nodes, 'doc-empty').label).toBe('Empty');

		vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
		const noopView = render(
			<MindMap
				centerFilePath="A very long title that should be truncated by the canvas renderer"
				nodes={nodes}
				links={links}
				theme={theme}
				width={360}
				height={260}
				maxDepth={2}
				showExternalLinks={true}
				selectedNodeId={null}
				onNodeSelect={vi.fn()}
				onNodeDoubleClick={vi.fn()}
				onNodePreview={vi.fn()}
				onNodeContextMenu={vi.fn()}
				onOpenFile={vi.fn()}
				searchQuery=""
				previewCharLimit={220}
			/>
		);
		noopView.unmount();
		vi.restoreAllMocks();

		const canvasContext = createCanvasContext();
		vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvasContext);
		vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue(
			undefined as unknown as DOMRect
		);
		const onNodeSelect = vi.fn();
		const { container } = render(
			<MindMap
				centerFilePath="A very long title that should be truncated by the canvas renderer"
				nodes={nodes}
				links={links}
				theme={theme}
				width={360}
				height={260}
				maxDepth={2}
				showExternalLinks={true}
				selectedNodeId="ext-long"
				onNodeSelect={onNodeSelect}
				onNodeDoubleClick={vi.fn()}
				onNodePreview={vi.fn()}
				onNodeContextMenu={vi.fn()}
				onOpenFile={vi.fn()}
				searchQuery="missing"
				previewCharLimit={220}
				nodePositions={
					new Map([
						['doc-long', { x: 100, y: 100 }],
						['doc-empty', { x: 260, y: 100 }],
						['ext-long', { x: 180, y: 210 }],
					])
				}
			/>
		);

		await waitFor(() => expect(canvasContext.fillRect).toHaveBeenCalledWith(0, 0, 360, 260));
		const canvas = container.querySelector('canvas')!;
		fireEvent.wheel(canvas, { clientX: 100, clientY: 100, deltaY: -100 });
		fireEvent.mouseDown(canvas, { clientX: 100, clientY: 100 });
		expect(onNodeSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'doc-long' }));
		expect(canvasContext.fillText).toHaveBeenCalledWith(
			expect.stringContaining('...'),
			expect.any(Number),
			expect.any(Number)
		);
	});

	it('covers keyboard focus recovery, spatial navigation, and focused-node no-ops', async () => {
		const canvasContext = createCanvasContext();
		vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvasContext);
		vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue(canvasRect);
		const windowOpen = vi.spyOn(window, 'open').mockImplementation(() => null);

		const { nodes, links } = convertToMindMapData(
			[
				{ id: 'center', data: documentData({ title: 'Center', filePath: 'docs/center.md' }) },
				{ id: 'above', data: documentData({ title: 'Above', filePath: 'docs/above.md' }) },
				{ id: 'below', data: documentData({ title: 'Below', filePath: 'docs/below.md' }) },
				{ id: 'left-a', data: documentData({ title: 'Left A', filePath: 'docs/left-a.md' }) },
				{ id: 'left-b', data: documentData({ title: 'Left B', filePath: 'docs/left-b.md' }) },
				{ id: 'right-a', data: documentData({ title: 'Right A', filePath: 'docs/right-a.md' }) },
				{ id: 'right-b', data: documentData({ title: 'Right B', filePath: 'docs/right-b.md' }) },
				{
					id: 'ext-empty',
					data: externalData({ domain: 'empty.example', urls: [] }),
				},
			],
			[
				{ source: 'center', target: 'above' },
				{ source: 'center', target: 'below' },
				{ source: 'center', target: 'left-a' },
				{ source: 'center', target: 'right-a' },
				{ source: 'center', target: 'ext-empty', type: 'external' },
			]
		);
		const nodePositions = new Map([
			['center', { x: 300, y: 200 }],
			['above', { x: 300, y: 40 }],
			['below', { x: 300, y: 360 }],
			['left-a', { x: 80, y: 185 }],
			['left-b', { x: 60, y: 260 }],
			['right-a', { x: 560, y: 190 }],
			['right-b', { x: 580, y: 270 }],
			['ext-empty', { x: 300, y: 500 }],
		]);
		const onNodeSelect = vi.fn();
		const onNodeDoubleClick = vi.fn();
		const onNodePreview = vi.fn();
		const onOpenFile = vi.fn();

		const { container, rerender } = render(
			<MindMap
				centerFilePath="docs/center.md"
				nodes={nodes}
				links={links}
				theme={theme}
				width={360}
				height={240}
				maxDepth={2}
				showExternalLinks={true}
				selectedNodeId={null}
				onNodeSelect={onNodeSelect}
				onNodeDoubleClick={onNodeDoubleClick}
				onNodePreview={onNodePreview}
				onNodeContextMenu={vi.fn()}
				onOpenFile={onOpenFile}
				searchQuery=""
				nodePositions={nodePositions}
			/>
		);
		await waitFor(() => expect(canvasContext.fillRect).toHaveBeenCalledWith(0, 0, 360, 240));
		const wrapper = container.querySelector('div[tabindex="0"]') as HTMLElement;
		const canvas = container.querySelector('canvas')!;

		fireEvent.mouseDown(canvas, { clientX: -1000, clientY: -1000 });
		fireEvent.keyDown(wrapper, { key: 'ArrowRight' });
		expect(onNodeSelect).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'center' }));

		fireEvent.keyDown(wrapper, { key: 'ArrowUp' });
		expect(onNodeSelect).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'above' }));
		fireEvent.keyDown(wrapper, { key: 'ArrowDown' });
		expect(onNodeSelect).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'center' }));
		fireEvent.keyDown(wrapper, { key: 'ArrowLeft' });
		expect(onNodeSelect).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'left-a' }));
		fireEvent.keyDown(wrapper, { key: 'ArrowRight' });
		expect(onNodeSelect).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'center' }));
		fireEvent.keyDown(wrapper, { key: 'ArrowRight' });
		expect(onNodeSelect).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'right-a' }));

		rerender(
			<MindMap
				centerFilePath="docs/center.md"
				nodes={nodes}
				links={links}
				theme={theme}
				width={360}
				height={240}
				maxDepth={2}
				showExternalLinks={true}
				selectedNodeId="ext-empty"
				onNodeSelect={onNodeSelect}
				onNodeDoubleClick={onNodeDoubleClick}
				onNodePreview={onNodePreview}
				onNodeContextMenu={vi.fn()}
				onOpenFile={onOpenFile}
				searchQuery=""
				nodePositions={nodePositions}
			/>
		);
		fireEvent.keyDown(wrapper, { key: 'Enter' });
		fireEvent.keyDown(wrapper, { key: ' ' });
		fireEvent.keyDown(wrapper, { key: 'p' });
		fireEvent.keyDown(wrapper, { key: 'O' });
		expect(windowOpen).not.toHaveBeenCalled();
		expect(onNodeDoubleClick).not.toHaveBeenCalledWith(
			expect.objectContaining({ id: 'ext-empty' })
		);
		expect(onNodePreview).not.toHaveBeenCalledWith(expect.objectContaining({ id: 'ext-empty' }));
		expect(onOpenFile).not.toHaveBeenCalledWith(undefined);

		rerender(
			<MindMap
				centerFilePath="docs/center.md"
				nodes={nodes}
				links={links}
				theme={theme}
				width={360}
				height={240}
				maxDepth={2}
				showExternalLinks={true}
				selectedNodeId="missing-node"
				onNodeSelect={onNodeSelect}
				onNodeDoubleClick={onNodeDoubleClick}
				onNodePreview={onNodePreview}
				onNodeContextMenu={vi.fn()}
				onOpenFile={onOpenFile}
				searchQuery=""
				nodePositions={nodePositions}
			/>
		);
		fireEvent.keyDown(wrapper, { key: 'ArrowLeft' });
	});

	it('covers overflow wrapping, hover rendering, panning, and navigation no-op branches', async () => {
		const originalDevicePixelRatio = window.devicePixelRatio;
		Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 0 });

		const canvasContext = createCanvasContext();
		vi.mocked(canvasContext.measureText).mockImplementation(
			(text: string) =>
				({
					width: text.includes(' ') ? 999 : 80,
				}) as TextMetrics
		);
		vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvasContext);
		vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue(
			undefined as unknown as DOMRect
		);

		try {
			const { nodes, links } = convertToMindMapData(
				[
					{
						id: 'center',
						data: documentData({
							title: 'Center',
							filePath: 'Root.md',
							description: Array.from({ length: 260 }, (_, index) => `word${index}`).join(' '),
						}),
					},
					{
						id: 'hover',
						data: documentData({
							title: 'Hover',
							filePath: 'docs/hover.md',
							description: 'hover preview',
						}),
					},
				],
				[{ source: 'center', target: 'hover' }],
				1000
			);
			const nodePositions = new Map([
				['center', { x: 100, y: 100 }],
				['hover', { x: 260, y: 100 }],
			]);
			const onNodeContextMenu = vi.fn();
			const { container, unmount } = render(
				<MindMap
					centerFilePath="Root.md"
					nodes={nodes}
					links={links}
					theme={theme}
					width={360}
					height={260}
					maxDepth={2}
					showExternalLinks={true}
					selectedNodeId={null}
					onNodeSelect={vi.fn()}
					onNodeDoubleClick={vi.fn()}
					onNodePreview={vi.fn()}
					onNodeContextMenu={onNodeContextMenu}
					onOpenFile={vi.fn()}
					searchQuery=""
					previewCharLimit={1000}
					nodePositions={nodePositions}
				/>
			);
			await waitFor(() => expect(canvasContext.fillRect).toHaveBeenCalledWith(0, 0, 360, 260));
			expect(canvasContext.fillText).toHaveBeenCalledWith(
				'./',
				expect.any(Number),
				expect.any(Number)
			);
			expect(canvasContext.fillText).toHaveBeenCalledWith(
				expect.stringContaining('...'),
				expect.any(Number),
				expect.any(Number)
			);

			const canvas = container.querySelector('canvas')!;
			fireEvent.mouseMove(canvas, { clientX: 260, clientY: 100 });
			await waitFor(() => expect(canvas.style.cursor).toBe('grab'));
			fireEvent.mouseUp(canvas);
			expect(canvas.style.cursor).toBe('grab');
			fireEvent.contextMenu(canvas, { clientX: -1000, clientY: -1000 });
			expect(onNodeContextMenu).not.toHaveBeenCalled();

			fireEvent.mouseDown(canvas, { clientX: -1000, clientY: -1000 });
			await waitFor(() => expect(canvas.style.cursor).toBe('grabbing'));
			const translateCallsBeforePan = vi.mocked(canvasContext.translate).mock.calls.length;
			fireEvent.mouseMove(canvas, { clientX: -900, clientY: -900 });
			await waitFor(() =>
				expect(vi.mocked(canvasContext.translate).mock.calls.length).toBeGreaterThan(
					translateCallsBeforePan
				)
			);
			unmount();

			const emptyView = render(
				<MindMap
					centerFilePath="missing.md"
					nodes={[]}
					links={[]}
					theme={theme}
					width={360}
					height={260}
					maxDepth={2}
					showExternalLinks={true}
					selectedNodeId={null}
					onNodeSelect={vi.fn()}
					onNodeDoubleClick={vi.fn()}
					onNodePreview={vi.fn()}
					onNodeContextMenu={vi.fn()}
					onOpenFile={vi.fn()}
					searchQuery=""
				/>
			);
			fireEvent.keyDown(emptyView.container.querySelector('div[tabindex="0"]') as HTMLElement, {
				key: 'ArrowUp',
			});
			fireEvent.keyDown(emptyView.container.querySelector('div[tabindex="0"]') as HTMLElement, {
				key: 'x',
			});
			emptyView.unmount();
		} finally {
			Object.defineProperty(window, 'devicePixelRatio', {
				configurable: true,
				value: originalDevicePixelRatio,
			});
		}

		vi.restoreAllMocks();
		const keyboardContext = createCanvasContext();
		vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(keyboardContext);
		vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue(canvasRect);
		const { nodes, links } = convertToMindMapData(
			[
				{ id: 'center', data: documentData({ title: 'Center', filePath: 'docs/center.md' }) },
				{ id: 'above-a', data: documentData({ title: 'Above A', filePath: 'docs/above-a.md' }) },
				{ id: 'above-b', data: documentData({ title: 'Above B', filePath: 'docs/above-b.md' }) },
				{ id: 'left-a', data: documentData({ title: 'Left A', filePath: 'docs/left-a.md' }) },
				{ id: 'left-b', data: documentData({ title: 'Left B', filePath: 'docs/left-b.md' }) },
				{ id: 'left-c', data: documentData({ title: 'Left C', filePath: 'docs/left-c.md' }) },
				{ id: 'right-a', data: documentData({ title: 'Right A', filePath: 'docs/right-a.md' }) },
			],
			[
				{ source: 'center', target: 'above-a' },
				{ source: 'center', target: 'above-b' },
				{ source: 'center', target: 'left-a' },
				{ source: 'center', target: 'left-b' },
				{ source: 'center', target: 'left-c' },
				{ source: 'center', target: 'right-a' },
			]
		);
		const onNodeSelect = vi.fn();
		const { container, rerender } = render(
			<MindMap
				centerFilePath="docs/center.md"
				nodes={nodes}
				links={links}
				theme={theme}
				width={1000}
				height={800}
				maxDepth={2}
				showExternalLinks={true}
				selectedNodeId="center"
				onNodeSelect={onNodeSelect}
				onNodeDoubleClick={vi.fn()}
				onNodePreview={vi.fn()}
				onNodeContextMenu={vi.fn()}
				onOpenFile={vi.fn()}
				searchQuery=""
				nodePositions={
					new Map([
						['center', { x: 300, y: 300 }],
						['above-a', { x: 300, y: 120 }],
						['above-b', { x: 300, y: 180 }],
						['left-a', { x: 100, y: 280 }],
						['left-b', { x: 80, y: 360 }],
						['left-c', { x: -40, y: 300 }],
						['right-a', { x: 500, y: 300 }],
					])
				}
			/>
		);
		await waitFor(() => expect(keyboardContext.fillRect).toHaveBeenCalledWith(0, 0, 1000, 800));
		const wrapper = container.querySelector('div[tabindex="0"]') as HTMLElement;
		const keyboardCanvas = container.querySelector('canvas')!;
		fireEvent.mouseDown(keyboardCanvas, { clientX: -1000, clientY: -1000 });
		fireEvent.keyDown(wrapper, { key: 'x' });
		rerender(
			<MindMap
				centerFilePath="docs/center.md"
				nodes={nodes}
				links={links}
				theme={theme}
				width={1000}
				height={800}
				maxDepth={2}
				showExternalLinks={true}
				selectedNodeId="center"
				onNodeSelect={onNodeSelect}
				onNodeDoubleClick={vi.fn()}
				onNodePreview={vi.fn()}
				onNodeContextMenu={vi.fn()}
				onOpenFile={vi.fn()}
				searchQuery=""
				nodePositions={
					new Map([
						['center', { x: 300, y: 300 }],
						['above-a', { x: 300, y: 120 }],
						['above-b', { x: 300, y: 180 }],
						['left-a', { x: 100, y: 280 }],
						['left-b', { x: 80, y: 360 }],
						['left-c', { x: -40, y: 300 }],
						['right-a', { x: 500, y: 300 }],
					])
				}
			/>
		);
		fireEvent.keyDown(wrapper, { key: 'ArrowUp' });
		await waitFor(() =>
			expect(onNodeSelect).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'above-b' }))
		);
		rerender(
			<MindMap
				centerFilePath="docs/center.md"
				nodes={nodes}
				links={links}
				theme={theme}
				width={1000}
				height={800}
				maxDepth={2}
				showExternalLinks={true}
				selectedNodeId="center"
				onNodeSelect={onNodeSelect}
				onNodeDoubleClick={vi.fn()}
				onNodePreview={vi.fn()}
				onNodeContextMenu={vi.fn()}
				onOpenFile={vi.fn()}
				searchQuery=""
				nodePositions={
					new Map([
						['center', { x: 300, y: 300 }],
						['above-a', { x: 300, y: 120 }],
						['above-b', { x: 300, y: 180 }],
						['left-a', { x: 100, y: 280 }],
						['left-b', { x: 80, y: 360 }],
						['left-c', { x: -40, y: 300 }],
						['right-a', { x: 500, y: 300 }],
					])
				}
			/>
		);
		fireEvent.keyDown(wrapper, { key: 'ArrowLeft' });
		await waitFor(() =>
			expect(onNodeSelect).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'left-a' }))
		);
		rerender(
			<MindMap
				centerFilePath="docs/center.md"
				nodes={nodes}
				links={links}
				theme={theme}
				width={1000}
				height={800}
				maxDepth={2}
				showExternalLinks={true}
				selectedNodeId="center"
				onNodeSelect={onNodeSelect}
				onNodeDoubleClick={vi.fn()}
				onNodePreview={vi.fn()}
				onNodeContextMenu={vi.fn()}
				onOpenFile={vi.fn()}
				searchQuery=""
				nodePositions={
					new Map([
						['center', { x: 300, y: 300 }],
						['above-a', { x: 300, y: 120 }],
						['above-b', { x: 300, y: 180 }],
						['left-a', { x: 100, y: 280 }],
						['left-b', { x: 80, y: 360 }],
						['right-a', { x: 500, y: 300 }],
					])
				}
			/>
		);
		fireEvent.keyDown(wrapper, { key: 'ArrowRight' });
		await waitFor(() =>
			expect(onNodeSelect).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'right-a' }))
		);
	});
});
