import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import {
	MindMap,
	convertToMindMapData,
	type MindMapNode,
} from '../../../../renderer/components/DocumentGraph/MindMap';
import type { GraphNodeData } from '../../../../renderer/components/DocumentGraph/graphDataBuilder';
import {
	EXTERNAL_NODE_HEIGHT,
	EXTERNAL_NODE_WIDTH,
	NODE_HEIGHT_BASE,
	NODE_WIDTH,
	buildAdjacencyMap,
	calculateLayout,
} from '../../../../renderer/components/DocumentGraph/mindMapLayouts';
import type { Theme } from '../../../../renderer/types';

type DocumentData = Extract<GraphNodeData, { nodeType: 'document' }>;
type ExternalData = Extract<GraphNodeData, { nodeType: 'external' }>;

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

function getNode(nodes: MindMapNode[], id: string): MindMapNode {
	const node = nodes.find((candidate) => candidate.id === id);
	expect(node).toBeDefined();
	return node!;
}

const mockTheme: Theme = {
	id: 'dracula',
	name: 'Dracula',
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

function createMindMapFixture() {
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

describe('MindMap', () => {
	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	it('converts graph nodes into deduplicated mind map nodes and links', () => {
		const { nodes, links } = convertToMindMapData(
			[
				{
					id: 'doc-a',
					data: documentData({
						title: 'Duplicate Should Not Replace',
						filePath: 'docs/Alpha.md',
						description: 'Frontmatter summary',
						contentPreview: 'Plain text fallback',
						brokenLinks: ['Missing.md'],
						isLargeFile: true,
					}),
				},
				{
					id: 'doc-a',
					data: documentData({
						title: 'Ignored Duplicate',
						filePath: 'docs/ignored.md',
					}),
				},
				{
					id: 'doc-b',
					data: documentData({
						title: 'Fallback B',
						filePath: '',
						description: undefined,
						contentPreview: 'Content preview is used when no description is available.',
					}),
				},
				{
					id: 'ext-example',
					data: externalData({
						domain: 'example.com',
						linkCount: 2,
						urls: ['https://example.com/docs', 'https://example.com/api'],
					}),
				},
				{
					id: 'isolated',
					data: documentData({
						title: 'No Links',
						filePath: '',
					}),
				},
			],
			[
				{ source: 'doc-a', target: 'doc-b' },
				{ source: 'doc-a', target: 'ext-example', type: 'external' },
				{ source: 'doc-b', target: 'doc-a' },
			]
		);

		expect(nodes).toHaveLength(4);

		const docA = getNode(nodes, 'doc-a');
		expect(docA).toMatchObject({
			id: 'doc-a',
			nodeType: 'document',
			label: 'Alpha',
			filePath: 'docs/Alpha.md',
			description: 'Frontmatter summary',
			contentPreview: 'Plain text fallback',
			lineCount: 12,
			wordCount: 140,
			size: '1.2 KB',
			brokenLinks: ['Missing.md'],
			isLargeFile: true,
			connectionCount: 2,
			width: NODE_WIDTH,
		});
		expect(docA.height).toBeGreaterThan(NODE_HEIGHT_BASE);
		expect([...docA.neighbors!].sort()).toEqual(['doc-b', 'ext-example']);

		const docB = getNode(nodes, 'doc-b');
		expect(docB).toMatchObject({
			nodeType: 'document',
			label: 'Fallback B',
			description: undefined,
			contentPreview: 'Content preview is used when no description is available.',
			connectionCount: 1,
		});
		expect([...docB.neighbors!]).toEqual(['doc-a']);

		const isolated = getNode(nodes, 'isolated');
		expect(isolated).toMatchObject({
			label: 'No Links',
			connectionCount: 0,
		});
		expect(isolated.neighbors).toBeInstanceOf(Set);
		expect(isolated.neighbors!.size).toBe(0);

		const external = getNode(nodes, 'ext-example');
		expect(external).toMatchObject({
			nodeType: 'external',
			label: 'example.com',
			domain: 'example.com',
			urls: ['https://example.com/docs', 'https://example.com/api'],
			connectionCount: 1,
			width: EXTERNAL_NODE_WIDTH,
			height: EXTERNAL_NODE_HEIGHT,
		});

		expect(links).toEqual([
			{ source: 'doc-a', target: 'doc-b', type: 'internal' },
			{ source: 'doc-a', target: 'ext-example', type: 'external' },
		]);
	});

	it('renders the canvas and handles focused document actions', async () => {
		const canvasContext = createCanvasContext();
		vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvasContext);
		vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue(canvasRect);

		const { nodes, links } = convertToMindMapData(
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

		const onNodeSelect = vi.fn();
		const onNodeDoubleClick = vi.fn();
		const onNodePreview = vi.fn();
		const onNodeContextMenu = vi.fn();
		const onOpenFile = vi.fn();
		const onNodePositionChange = vi.fn();

		const { container } = render(
			React.createElement(MindMap, {
				centerFilePath: 'docs/Alpha.md',
				nodes,
				links,
				theme: mockTheme,
				width: 600,
				height: 400,
				maxDepth: 2,
				showExternalLinks: true,
				selectedNodeId: null,
				onNodeSelect,
				onNodeDoubleClick,
				onNodePreview,
				onNodeContextMenu,
				onOpenFile,
				searchQuery: 'example',
				previewCharLimit: 80,
				onNodePositionChange,
			})
		);

		await waitFor(() => {
			expect(onNodeSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'doc-a' }));
		});

		expect(canvasContext.fillRect).toHaveBeenCalledWith(0, 0, 600, 400);
		expect(canvasContext.fillText).toHaveBeenCalled();

		const wrapper = container.firstElementChild as HTMLElement;
		const canvas = container.querySelector('canvas');
		expect(canvas).toBeInstanceOf(HTMLCanvasElement);

		fireEvent.mouseDown(canvas!, { clientX: 300, clientY: 200 });
		expect(onNodeSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'doc-a' }));

		fireEvent.mouseMove(canvas!, { clientX: 330, clientY: 220 });
		expect(onNodePositionChange).toHaveBeenCalledWith(
			'doc-a',
			expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) })
		);

		fireEvent.mouseUp(canvas!);
		fireEvent.contextMenu(canvas!, { clientX: 300, clientY: 200 });
		expect(onNodeContextMenu).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'doc-a' }),
			expect.any(MouseEvent)
		);

		fireEvent.keyDown(wrapper, { key: 'Enter' });
		expect(onNodePreview).toHaveBeenCalledWith(expect.objectContaining({ id: 'doc-a' }));

		fireEvent.keyDown(wrapper, { key: 'P' });
		expect(onNodePreview).toHaveBeenCalledWith(expect.objectContaining({ id: 'doc-a' }));

		fireEvent.keyDown(wrapper, { key: 'o' });
		expect(onOpenFile).toHaveBeenCalledWith('docs/Alpha.md');

		fireEvent.keyDown(wrapper, { key: ' ' });
		expect(onNodeDoubleClick).toHaveBeenCalledWith(expect.objectContaining({ id: 'doc-a' }));

		fireEvent.mouseDown(canvas!, { clientX: -1000, clientY: -1000 });
		expect(onNodeSelect).toHaveBeenCalledWith(null);

		fireEvent.mouseMove(canvas!, { clientX: -900, clientY: -900 });
		fireEvent.mouseUp(canvas!);
		fireEvent.mouseLeave(canvas!);

		const translateCallsBeforeWheel = vi.mocked(canvasContext.translate).mock.calls.length;
		fireEvent.wheel(canvas!, { clientX: 300, clientY: 200, deltaY: -100 });
		await waitFor(() => {
			expect(vi.mocked(canvasContext.translate).mock.calls.length).toBeGreaterThan(
				translateCallsBeforeWheel
			);
		});
	});

	it('handles open-icon clicks, double-click recentering, and keyboard refocus', async () => {
		const canvasContext = createCanvasContext();
		vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvasContext);
		vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue(canvasRect);

		const { nodes, links } = createMindMapFixture();
		const onNodeSelect = vi.fn();
		const onNodeDoubleClick = vi.fn();
		const onNodePreview = vi.fn();
		const onNodeContextMenu = vi.fn();
		const onOpenFile = vi.fn();

		const { container } = render(
			React.createElement(MindMap, {
				centerFilePath: 'docs/Alpha.md',
				nodes,
				links,
				theme: mockTheme,
				width: 600,
				height: 400,
				maxDepth: 2,
				showExternalLinks: true,
				selectedNodeId: null,
				onNodeSelect,
				onNodeDoubleClick,
				onNodePreview,
				onNodeContextMenu,
				onOpenFile,
				searchQuery: '',
			})
		);

		await waitFor(() => {
			expect(onNodeSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'doc-a' }));
		});

		const wrapper = container.firstElementChild as HTMLElement;
		const canvas = container.querySelector('canvas')!;
		const layoutCenterNode = getNode(
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

		onNodeSelect.mockClear();
		fireEvent.keyDown(wrapper, { key: 'ArrowRight' });
		expect(onNodeSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'doc-a' }));
	});

	it('opens a focused external node with Enter', async () => {
		const canvasContext = createCanvasContext();
		vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvasContext);
		vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue(canvasRect);
		const windowOpen = vi.spyOn(window, 'open').mockImplementation(() => null);

		const { nodes, links } = createMindMapFixture();

		const { container } = render(
			React.createElement(MindMap, {
				centerFilePath: 'docs/Alpha.md',
				nodes,
				links,
				theme: mockTheme,
				width: 600,
				height: 400,
				maxDepth: 2,
				showExternalLinks: true,
				selectedNodeId: 'ext-example',
				onNodeSelect: vi.fn(),
				onNodeDoubleClick: vi.fn(),
				onNodePreview: vi.fn(),
				onNodeContextMenu: vi.fn(),
				onOpenFile: vi.fn(),
				searchQuery: '',
			})
		);

		await waitFor(() => {
			expect(canvasContext.fillRect).toHaveBeenCalledWith(0, 0, 600, 400);
		});

		const wrapper = container.firstElementChild as HTMLElement;
		fireEvent.keyDown(wrapper, { key: 'Enter' });

		expect(windowOpen).toHaveBeenCalledWith('https://example.com/docs', '_blank');
	});

	it('navigates spatially with arrow keys and pans focused nodes into view', async () => {
		const canvasContext = createCanvasContext();
		vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvasContext);
		vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue(canvasRect);

		const { nodes, links } = convertToMindMapData(
			[
				{
					id: 'doc-center',
					data: documentData({ title: 'Center', filePath: 'docs/Center.md' }),
				},
				{
					id: 'doc-up',
					data: documentData({ title: 'Up', filePath: 'docs/Up.md' }),
				},
				{
					id: 'doc-down',
					data: documentData({ title: 'Down', filePath: 'docs/Down.md' }),
				},
				{
					id: 'doc-left',
					data: documentData({ title: 'Left', filePath: 'docs/Left.md' }),
				},
				{
					id: 'doc-right-near',
					data: documentData({ title: 'Right Near', filePath: 'docs/RightNear.md' }),
				},
				{
					id: 'doc-right-far',
					data: documentData({ title: 'Right Far', filePath: 'docs/RightFar.md' }),
				},
			],
			[
				{ source: 'doc-center', target: 'doc-up' },
				{ source: 'doc-center', target: 'doc-down' },
				{ source: 'doc-center', target: 'doc-left' },
				{ source: 'doc-center', target: 'doc-right-near' },
				{ source: 'doc-center', target: 'doc-right-far' },
			]
		);
		const nodePositions = new Map([
			['doc-center', { x: 300, y: 200 }],
			['doc-up', { x: 300, y: 40 }],
			['doc-down', { x: 300, y: 360 }],
			['doc-left', { x: 40, y: 210 }],
			['doc-right-near', { x: 560, y: 190 }],
			['doc-right-far', { x: 560, y: 320 }],
		]);
		const onNodeSelect = vi.fn();

		const { container } = render(
			React.createElement(MindMap, {
				centerFilePath: 'docs/Center.md',
				nodes,
				links,
				theme: mockTheme,
				width: 600,
				height: 400,
				maxDepth: 2,
				showExternalLinks: true,
				selectedNodeId: null,
				onNodeSelect,
				onNodeDoubleClick: vi.fn(),
				onNodePreview: vi.fn(),
				onNodeContextMenu: vi.fn(),
				onOpenFile: vi.fn(),
				searchQuery: '',
				nodePositions,
			})
		);

		await waitFor(() => {
			expect(onNodeSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'doc-center' }));
		});
		onNodeSelect.mockClear();

		const wrapper = container.firstElementChild as HTMLElement;
		fireEvent.keyDown(wrapper, { key: 'ArrowRight' });
		expect(onNodeSelect).toHaveBeenLastCalledWith(
			expect.objectContaining({ id: 'doc-right-near' })
		);

		fireEvent.keyDown(wrapper, { key: 'ArrowLeft' });
		expect(onNodeSelect).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'doc-center' }));

		fireEvent.keyDown(wrapper, { key: 'ArrowUp' });
		expect(onNodeSelect).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'doc-up' }));

		fireEvent.keyDown(wrapper, { key: 'ArrowDown' });
		expect(onNodeSelect).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'doc-center' }));
		expect(canvasContext.translate).toHaveBeenCalledWith(expect.any(Number), expect.any(Number));
	});

	it('renders long previews, skips orphan links, and selects hovered external nodes', async () => {
		const canvasContext = createCanvasContext();
		vi.mocked(canvasContext.measureText).mockImplementation(
			(text: string) => ({ width: text.length * 30 }) as TextMetrics
		);
		vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvasContext);
		vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue(canvasRect);

		const longDescription =
			'This document has a long summary that should wrap across several rendered lines before it is truncated.';
		const { nodes, links } = convertToMindMapData(
			[
				{
					id: 'doc-a',
					data: documentData({
						title: 'Alpha',
						filePath: 'docs/Alpha.md',
						description: longDescription,
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
				{ source: 'doc-a', target: 'ext-example', type: 'external' },
				{ source: 'doc-a', target: 'missing-doc' },
			],
			70
		);
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
				70
			).nodes,
			'doc-a'
		);
		const panX = 600 / 2 - layoutCenter.x;
		const panY = 400 / 2 - layoutCenter.y;
		const nodePositions = new Map([
			['doc-a', { x: 300, y: 200 }],
			['ext-example', { x: 500, y: 320 }],
		]);
		const onNodeSelect = vi.fn();

		const { container } = render(
			React.createElement(MindMap, {
				centerFilePath: 'docs/Alpha.md',
				nodes,
				links,
				theme: mockTheme,
				width: 600,
				height: 400,
				maxDepth: 2,
				showExternalLinks: true,
				selectedNodeId: null,
				onNodeSelect,
				onNodeDoubleClick: vi.fn(),
				onNodePreview: vi.fn(),
				onNodeContextMenu: vi.fn(),
				onOpenFile: vi.fn(),
				searchQuery: 'nomatch',
				previewCharLimit: 70,
				nodePositions,
			})
		);

		await waitFor(() => {
			expect(canvasContext.fillRect).toHaveBeenCalledWith(0, 0, 600, 400);
		});
		expect(
			vi
				.mocked(canvasContext.fillText)
				.mock.calls.some(([text]) => typeof text === 'string' && text.endsWith('...'))
		).toBe(true);

		const canvas = container.querySelector('canvas')!;
		fireEvent.mouseMove(canvas, { clientX: 500 + panX, clientY: 320 + panY });
		await waitFor(() => {
			expect(canvas.style.cursor).toBe('grab');
		});
		fireEvent.mouseMove(canvas, { clientX: -1000, clientY: -1000 });
		await waitFor(() => {
			expect(canvas.style.cursor).toBe('default');
		});

		onNodeSelect.mockClear();
		fireEvent.mouseDown(canvas, { clientX: 500 + panX, clientY: 320 + panY });
		expect(onNodeSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'ext-example' }));
		fireEvent.mouseUp(canvas);
	});

	it('renders hovered document styling, root paths, and missing file paths', async () => {
		const canvasContext = createCanvasContext();
		vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvasContext);
		vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue(canvasRect);

		const { nodes, links } = convertToMindMapData(
			[
				{
					id: 'doc-root',
					data: documentData({ title: 'Root', filePath: 'Root.md' }),
				},
				{
					id: 'doc-no-path',
					data: documentData({ title: 'No Path', filePath: undefined as any }),
				},
			],
			[{ source: 'doc-root', target: 'doc-no-path' }]
		);
		const nodePositions = new Map([
			['doc-root', { x: 300, y: 200 }],
			['doc-no-path', { x: 460, y: 200 }],
		]);

		const { container } = render(
			React.createElement(MindMap, {
				centerFilePath: 'Root.md',
				nodes,
				links,
				theme: mockTheme,
				width: 600,
				height: 400,
				maxDepth: 2,
				showExternalLinks: true,
				selectedNodeId: null,
				onNodeSelect: vi.fn(),
				onNodeDoubleClick: vi.fn(),
				onNodePreview: vi.fn(),
				onNodeContextMenu: vi.fn(),
				onOpenFile: vi.fn(),
				searchQuery: '',
				nodePositions,
			})
		);

		await waitFor(() => {
			expect(canvasContext.fillRect).toHaveBeenCalledWith(0, 0, 600, 400);
		});
		expect(vi.mocked(canvasContext.fillText).mock.calls.some(([text]) => text === './')).toBe(true);

		const canvas = container.querySelector('canvas')!;
		fireEvent.mouseMove(canvas, { clientX: 460, clientY: 200 });
		await waitFor(() => {
			expect(canvas.style.cursor).toBe('grab');
		});
		fireEvent.mouseUp(canvas);
		expect(canvas.style.cursor).toBe('grab');
	});

	it('filters sparse document nodes through optional search fields', async () => {
		const canvasContext = createCanvasContext();
		vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvasContext);
		vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue(canvasRect);

		const { nodes, links } = convertToMindMapData(
			[
				{
					id: 'doc-sparse',
					data: documentData({
						title: 'Sparse',
						filePath: undefined as any,
						description: undefined,
						contentPreview: undefined,
					}),
				},
			],
			[]
		);

		render(
			React.createElement(MindMap, {
				centerFilePath: '',
				nodes,
				links,
				theme: mockTheme,
				width: 600,
				height: 400,
				maxDepth: 2,
				showExternalLinks: true,
				selectedNodeId: null,
				onNodeSelect: vi.fn(),
				onNodeDoubleClick: vi.fn(),
				onNodePreview: vi.fn(),
				onNodeContextMenu: vi.fn(),
				onOpenFile: vi.fn(),
				searchQuery: 'absent',
			})
		);

		await waitFor(() => {
			expect(canvasContext.fillRect).toHaveBeenCalledWith(0, 0, 600, 400);
		});
	});

	it('handles empty and missing-center layouts without keyboard focus targets', async () => {
		const originalDpr = window.devicePixelRatio;
		Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 0 });
		const canvasContext = createCanvasContext();
		vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvasContext);
		vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue(canvasRect);

		try {
			const emptyRender = render(
				React.createElement(MindMap, {
					centerFilePath: 'docs/Missing.md',
					nodes: [],
					links: [],
					theme: mockTheme,
					width: 600,
					height: 400,
					maxDepth: 2,
					showExternalLinks: true,
					selectedNodeId: null,
					onNodeSelect: vi.fn(),
					onNodeDoubleClick: vi.fn(),
					onNodePreview: vi.fn(),
					onNodeContextMenu: vi.fn(),
					onOpenFile: vi.fn(),
					searchQuery: '',
				})
			);

			await waitFor(() => {
				expect(canvasContext.scale).toHaveBeenCalledWith(1, 1);
			});
			const emptyWrapper = emptyRender.container.firstElementChild as HTMLElement;
			fireEvent.keyDown(emptyWrapper, { key: 'Enter' });
			fireEvent.keyDown(emptyWrapper, { key: 'ArrowRight' });
			emptyRender.unmount();

			const { nodes, links } = createMindMapFixture();
			const onNodeSelect = vi.fn();
			const missingCenterRender = render(
				React.createElement(MindMap, {
					centerFilePath: 'docs/Missing.md',
					nodes,
					links,
					theme: mockTheme,
					width: 600,
					height: 400,
					maxDepth: 2,
					showExternalLinks: true,
					selectedNodeId: null,
					onNodeSelect,
					onNodeDoubleClick: vi.fn(),
					onNodePreview: vi.fn(),
					onNodeContextMenu: vi.fn(),
					onOpenFile: vi.fn(),
					searchQuery: '',
				})
			);

			await waitFor(() => {
				expect(canvasContext.fillRect).toHaveBeenCalledWith(0, 0, 600, 400);
			});
			fireEvent.keyDown(missingCenterRender.container.firstElementChild as HTMLElement, {
				key: 'ArrowRight',
			});
			expect(onNodeSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'doc-a' }));
		} finally {
			Object.defineProperty(window, 'devicePixelRatio', {
				configurable: true,
				value: originalDpr,
			});
		}
	});

	it('tolerates missing canvas context and geometry fallbacks', async () => {
		vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValueOnce(null);

		const { nodes, links } = createMindMapFixture();
		const { unmount } = render(
			React.createElement(MindMap, {
				centerFilePath: 'docs/Alpha.md',
				nodes,
				links,
				theme: mockTheme,
				width: 600,
				height: 400,
				maxDepth: 2,
				showExternalLinks: true,
				selectedNodeId: null,
				onNodeSelect: vi.fn(),
				onNodeDoubleClick: vi.fn(),
				onNodeContextMenu: vi.fn(),
				onOpenFile: vi.fn(),
				searchQuery: '',
			})
		);

		unmount();

		const canvasContext = createCanvasContext();
		vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvasContext);
		vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue(
			undefined as unknown as DOMRect
		);
		const onNodeSelect = vi.fn();
		const nodePositions = new Map([['doc-a', { x: 300, y: 200 }]]);

		const { container } = render(
			React.createElement(MindMap, {
				centerFilePath: 'docs/Alpha.md',
				nodes,
				links,
				theme: mockTheme,
				width: 600,
				height: 400,
				maxDepth: 2,
				showExternalLinks: true,
				selectedNodeId: null,
				onNodeSelect,
				onNodeDoubleClick: vi.fn(),
				onNodeContextMenu: vi.fn(),
				onOpenFile: vi.fn(),
				searchQuery: '',
				nodePositions,
			})
		);

		await waitFor(() => {
			expect(canvasContext.fillRect).toHaveBeenCalledWith(0, 0, 600, 400);
		});

		const canvas = container.querySelector('canvas')!;
		fireEvent.mouseDown(canvas, { clientX: 300, clientY: 200 });
		expect(onNodeSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'doc-a' }));

		fireEvent.wheel(canvas, { clientX: 300, clientY: 200, deltaY: -100 });
	});

	it('ignores background context menus and keyboard focus misses', async () => {
		const canvasContext = createCanvasContext();
		vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvasContext);
		vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue(canvasRect);
		const { nodes, links } = createMindMapFixture();
		const onNodeSelect = vi.fn();
		const onNodeContextMenu = vi.fn();

		const { container } = render(
			React.createElement(MindMap, {
				centerFilePath: 'docs/Missing.md',
				nodes,
				links,
				theme: mockTheme,
				width: 600,
				height: 400,
				maxDepth: 2,
				showExternalLinks: true,
				selectedNodeId: 'missing-node',
				onNodeSelect,
				onNodeDoubleClick: vi.fn(),
				onNodePreview: vi.fn(),
				onNodeContextMenu,
				onOpenFile: vi.fn(),
				searchQuery: '',
			})
		);

		await waitFor(() => {
			expect(canvasContext.fillRect).toHaveBeenCalledWith(0, 0, 600, 400);
		});

		const wrapper = container.firstElementChild as HTMLElement;
		const canvas = container.querySelector('canvas')!;

		onNodeSelect.mockClear();
		fireEvent.keyDown(wrapper, { key: 'ArrowRight' });
		expect(onNodeSelect).not.toHaveBeenCalledWith(expect.objectContaining({ id: 'doc-a' }));

		fireEvent.contextMenu(canvas, { clientX: -1000, clientY: -1000 });
		expect(onNodeContextMenu).not.toHaveBeenCalled();
	});

	it('treats external keyboard actions without URLs as no-ops', async () => {
		const canvasContext = createCanvasContext();
		vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvasContext);
		vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue(canvasRect);
		const windowOpen = vi.spyOn(window, 'open').mockImplementation(() => null);
		const { nodes, links } = convertToMindMapData(
			[
				{
					id: 'doc-a',
					data: documentData({ title: 'Alpha', filePath: 'docs/Alpha.md' }),
				},
				{
					id: 'ext-empty',
					data: externalData({ domain: 'empty.example', urls: [] }),
				},
			],
			[{ source: 'doc-a', target: 'ext-empty', type: 'external' }]
		);
		const onNodeDoubleClick = vi.fn();
		const onOpenFile = vi.fn();
		const onNodePreview = vi.fn();

		const { container } = render(
			React.createElement(MindMap, {
				centerFilePath: 'docs/Alpha.md',
				nodes,
				links,
				theme: mockTheme,
				width: 600,
				height: 400,
				maxDepth: 2,
				showExternalLinks: true,
				selectedNodeId: 'ext-empty',
				onNodeSelect: vi.fn(),
				onNodeDoubleClick,
				onNodePreview,
				onNodeContextMenu: vi.fn(),
				onOpenFile,
				searchQuery: '',
			})
		);

		await waitFor(() => {
			expect(canvasContext.fillRect).toHaveBeenCalledWith(0, 0, 600, 400);
		});

		const wrapper = container.firstElementChild as HTMLElement;
		fireEvent.keyDown(wrapper, { key: 'Enter' });
		fireEvent.keyDown(wrapper, { key: ' ' });
		fireEvent.keyDown(wrapper, { key: 'o' });
		fireEvent.keyDown(wrapper, { key: 'p' });

		expect(windowOpen).not.toHaveBeenCalled();
		expect(onNodeDoubleClick).not.toHaveBeenCalled();
		expect(onOpenFile).not.toHaveBeenCalled();
		expect(onNodePreview).not.toHaveBeenCalled();
	});

	it('sorts same-column candidates and pans to offscreen keyboard targets', async () => {
		const canvasContext = createCanvasContext();
		vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvasContext);
		vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue(canvasRect);
		const { nodes, links } = convertToMindMapData(
			[
				{
					id: 'doc-center',
					data: documentData({ title: 'Center', filePath: 'docs/Center.md' }),
				},
				{
					id: 'doc-up-far',
					data: documentData({ title: 'Up Far', filePath: 'docs/UpFar.md' }),
				},
				{
					id: 'doc-up-near',
					data: documentData({ title: 'Up Near', filePath: 'docs/UpNear.md' }),
				},
				{
					id: 'doc-left-offscreen',
					data: documentData({ title: 'Left Offscreen', filePath: 'docs/Left.md' }),
				},
				{
					id: 'doc-right-column',
					data: documentData({ title: 'Right Column', filePath: 'docs/Right.md' }),
				},
				{
					id: 'doc-right-far-column',
					data: documentData({ title: 'Right Far Column', filePath: 'docs/RightFar.md' }),
				},
				{
					id: 'doc-down-offscreen',
					data: documentData({ title: 'Down Offscreen', filePath: 'docs/Down.md' }),
				},
			],
			[
				{ source: 'doc-center', target: 'doc-up-far' },
				{ source: 'doc-center', target: 'doc-up-near' },
				{ source: 'doc-center', target: 'doc-left-offscreen' },
				{ source: 'doc-center', target: 'doc-right-column' },
				{ source: 'doc-center', target: 'doc-right-far-column' },
				{ source: 'doc-center', target: 'doc-down-offscreen' },
			]
		);
		const nodePositions = new Map([
			['doc-center', { x: 300, y: 200 }],
			['doc-up-far', { x: 300, y: 20 }],
			['doc-up-near', { x: 300, y: 80 }],
			['doc-left-offscreen', { x: 20, y: 200 }],
			['doc-right-column', { x: 900, y: 190 }],
			['doc-right-far-column', { x: 1100, y: 210 }],
			['doc-down-offscreen', { x: 300, y: 900 }],
		]);
		const onNodeSelect = vi.fn();

		const { container } = render(
			React.createElement(MindMap, {
				centerFilePath: 'docs/Center.md',
				nodes,
				links,
				theme: mockTheme,
				width: 600,
				height: 400,
				maxDepth: 2,
				showExternalLinks: true,
				selectedNodeId: null,
				onNodeSelect,
				onNodeDoubleClick: vi.fn(),
				onNodePreview: vi.fn(),
				onNodeContextMenu: vi.fn(),
				onOpenFile: vi.fn(),
				searchQuery: '',
				nodePositions,
			})
		);

		await waitFor(() => {
			expect(onNodeSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'doc-center' }));
		});
		onNodeSelect.mockClear();

		const wrapper = container.firstElementChild as HTMLElement;
		fireEvent.keyDown(wrapper, { key: 'ArrowUp' });
		expect(onNodeSelect).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'doc-up-near' }));

		fireEvent.keyDown(wrapper, { key: 'ArrowDown' });
		expect(onNodeSelect).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'doc-center' }));

		fireEvent.keyDown(wrapper, { key: 'ArrowLeft' });
		expect(onNodeSelect).toHaveBeenLastCalledWith(
			expect.objectContaining({ id: 'doc-left-offscreen' })
		);

		fireEvent.keyDown(wrapper, { key: 'ArrowRight' });
		expect(onNodeSelect).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'doc-center' }));

		fireEvent.keyDown(wrapper, { key: 'ArrowDown' });
		expect(onNodeSelect).toHaveBeenLastCalledWith(
			expect.objectContaining({ id: 'doc-down-offscreen' })
		);
	});
});
