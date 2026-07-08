import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LayerStackProvider } from '../../renderer/contexts/LayerStackContext';
import { clearGraphDataCache } from '../../renderer/components/DocumentGraph/graphDataBuilder';
import * as graphDataBuilder from '../../renderer/components/DocumentGraph/graphDataBuilder';
import {
	DocumentGraphView,
	type DocumentGraphViewProps,
} from '../../renderer/components/DocumentGraph/DocumentGraphView';
import type { Theme } from '../../renderer/types';
import { safeClipboardWrite } from '../../renderer/utils/clipboard';
import { useSettingsStore } from '../../renderer/stores/settingsStore';

const mindMapState = vi.hoisted(() => ({
	props: [] as Array<any>,
}));

const clipboardMocks = vi.hoisted(() => ({
	safeClipboardWrite: vi.fn(),
}));

const loggerMocks = vi.hoisted(() => ({
	debug: vi.fn(),
	error: vi.fn(),
	info: vi.fn(),
	warn: vi.fn(),
}));

vi.mock('../../renderer/utils/clipboard', () => clipboardMocks);

vi.mock('../../renderer/utils/logger', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../renderer/utils/logger')>();

	return {
		...actual,
		logger: loggerMocks,
	};
});

vi.mock('../../renderer/components/DocumentGraph/MindMap', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('../../renderer/components/DocumentGraph/MindMap')>();

	return {
		...actual,
		MindMap: (props: any) => {
			mindMapState.props.push(props);

			const indexNode =
				props.nodes.find((node: any) => node.filePath === 'docs/index.md') ??
				props.nodes.find((node: any) => node.nodeType === 'document');
			const linkedNode = props.nodes.find((node: any) => node.filePath === 'docs/linked.md');
			const externalNode = props.nodes.find((node: any) => node.nodeType === 'external');

			return (
				<div
					ref={props.containerRef}
					data-testid="mind-map"
					data-node-count={props.nodes.length}
					data-link-count={props.links.length}
					data-search-query={props.searchQuery}
					data-layout-type={props.layoutType}
					tabIndex={0}
				>
					{props.nodes.map((node: any) => (
						<div key={node.id}>{node.label}</div>
					))}
					<button onClick={() => indexNode && props.onNodeSelect(indexNode)}>Select Index</button>
					<button onClick={() => linkedNode && props.onNodeSelect(linkedNode)}>
						Select Linked
					</button>
					<button onClick={() => props.onNodeSelect(null)}>Clear Selection</button>
					<button onClick={() => externalNode && props.onNodeSelect(externalNode)}>
						Select External
					</button>
					<button onClick={() => indexNode && props.onNodePreview(indexNode)}>Preview Index</button>
					<button
						onClick={() =>
							props.onNodePreview({
								id: 'absolute-doc',
								nodeType: 'document',
								label: 'Absolute',
								filePath: '/workspace/docs/index.md',
							})
						}
					>
						Preview Absolute
					</button>
					<button
						onClick={() =>
							props.onNodePreview({
								id: 'outside-doc',
								nodeType: 'document',
								label: 'Outside',
								filePath: '/outside.md',
							})
						}
					>
						Preview Outside
					</button>
					<button
						onClick={() =>
							props.onNodePreview({
								id: 'root-doc',
								nodeType: 'document',
								label: 'Root',
								filePath: '/workspace/',
							})
						}
					>
						Preview Root
					</button>
					<button onClick={() => externalNode && props.onNodePreview(externalNode)}>
						Preview External
					</button>
					<button onClick={() => indexNode?.filePath && props.onOpenFile(indexNode.filePath)}>
						Open Index
					</button>
					<button
						onClick={() =>
							indexNode && props.onNodePositionChange(indexNode.id, { x: 120, y: 240 })
						}
					>
						Move Index
					</button>
					<button onClick={() => indexNode && props.onNodeDoubleClick(indexNode)}>
						Recenter Index
					</button>
					<button onClick={() => linkedNode && props.onNodeDoubleClick(linkedNode)}>
						Recenter Linked
					</button>
					<button onClick={() => externalNode && props.onNodeDoubleClick(externalNode)}>
						Recenter External
					</button>
					<button
						onClick={(event) => indexNode && props.onNodeContextMenu(indexNode, event.nativeEvent)}
					>
						Context Index
					</button>
					<button
						onClick={(event) =>
							props.onNodeContextMenu(
								{
									id: 'blank-doc',
									nodeType: 'document',
									label: '',
									filePath: '',
								},
								event.nativeEvent
							)
						}
					>
						Context Blank Document
					</button>
					<button
						onClick={(event) =>
							externalNode && props.onNodeContextMenu(externalNode, event.nativeEvent)
						}
					>
						Context External
					</button>
					<button
						onClick={(event) =>
							props.onNodeContextMenu(
								{
									id: 'blank-external',
									nodeType: 'external',
								},
								event.nativeEvent
							)
						}
					>
						Context Blank External
					</button>
				</div>
			);
		},
	};
});

vi.mock('../../renderer/components/MarkdownRenderer', () => ({
	MarkdownRenderer: ({
		content,
		cwd,
		fileTree,
		onCopy,
		onFileClick,
		enableBionifyReadingMode,
		sshRemoteId,
	}: {
		content: string;
		cwd?: string;
		fileTree?: Array<{ name: string }>;
		onCopy?: (text: string) => Promise<void>;
		onFileClick?: (path: string) => void;
		enableBionifyReadingMode?: boolean;
		sshRemoteId?: string;
	}) => (
		<div
			data-testid="graph-markdown-preview"
			data-cwd={cwd ?? ''}
			data-file-tree-roots={(fileTree ?? []).map((entry) => entry.name).join(',')}
			data-bionify={String(Boolean(enableBionifyReadingMode))}
			data-ssh-remote={sshRemoteId ?? ''}
		>
			{content}
			<button onClick={() => onFileClick?.('docs/linked.md')}>Open linked wiki preview</button>
			<button onClick={() => onFileClick?.('docs/missing.md')}>Open missing wiki preview</button>
			<button onClick={() => onCopy?.('copied markdown')}>Copy markdown</button>
		</div>
	),
}));

const theme: Theme = {
	id: 'custom',
	name: 'Integration Dark',
	mode: 'dark',
	colors: {
		bgMain: '#101114',
		bgSidebar: '#20242b',
		bgActivity: '#181b20',
		border: '#3f3f46',
		textMain: '#f4f4f5',
		textDim: '#a1a1aa',
		accent: '#4f8cff',
		accentDim: '#1d4ed8',
		accentText: '#4f8cff',
		accentForeground: '#ffffff',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
	},
};

const files: Record<string, string> = {
	'/workspace/docs/index.md': [
		'# Index',
		'Start here.',
		'[Linked](linked.md)',
		'[Guide](https://example.com/guide)',
		'- [x] Draft graph',
		'- [ ] Review graph',
	].join('\n\n'),
	'/workspace/docs/linked.md': ['# Linked', 'Back to [[index]].', '- [x] Done'].join('\n\n'),
	'/workspace/notes/today.md': ['# Today', 'Incoming backlink to [Index](../docs/index.md).'].join(
		'\n\n'
	),
};

const directoryEntries: Record<
	string,
	Array<{ name: string; isDirectory: boolean; isFile: boolean; path: string }>
> = {
	'/workspace': [
		{ name: 'docs', isDirectory: true, isFile: false, path: '/workspace/docs' },
		{ name: 'notes', isDirectory: true, isFile: false, path: '/workspace/notes' },
	],
	'/workspace/docs': [
		{ name: 'index.md', isDirectory: false, isFile: true, path: '/workspace/docs/index.md' },
		{ name: 'linked.md', isDirectory: false, isFile: true, path: '/workspace/docs/linked.md' },
	],
	'/workspace/notes': [
		{ name: 'today.md', isDirectory: false, isFile: true, path: '/workspace/notes/today.md' },
	],
};

type GraphData = Awaited<ReturnType<typeof graphDataBuilder.buildGraphData>>;
type GraphNode = GraphData['nodes'][number];

function documentNode(filePath = 'docs/index.md', title = 'Index'): GraphNode {
	return {
		id: filePath,
		type: 'documentNode',
		data: {
			nodeType: 'document',
			title,
			filePath,
			lineCount: 1,
			wordCount: 1,
			size: '1 B',
			contentPreview: title,
		},
	};
}

function externalNode(domain: string | undefined, urls: string[]): GraphNode {
	return {
		id: domain ? `ext-${domain}` : 'ext-missing-domain',
		type: 'externalLinkNode',
		data: {
			nodeType: 'external',
			domain,
			linkCount: urls.length,
			urls,
		} as GraphNode['data'],
	};
}

function graphData(overrides: Partial<GraphData> = {}): GraphData {
	return {
		nodes: [documentNode()],
		edges: [],
		totalDocuments: 1,
		loadedDocuments: 1,
		hasMore: false,
		cachedExternalData: {
			externalNodes: [],
			externalEdges: [],
			domainCount: 0,
			totalLinkCount: 0,
		},
		internalLinkCount: 0,
		allMarkdownFiles: ['docs/index.md'],
		...overrides,
	};
}

function renderGraph(props: Partial<DocumentGraphViewProps> = {}) {
	const onClose = vi.fn();
	const onDocumentOpen = vi.fn();
	const onExternalLinkOpen = vi.fn();
	const onExternalLinksChange = vi.fn();
	const onNeighborDepthChange = vi.fn();
	const onPreviewCharLimitChange = vi.fn();
	const onLayoutTypeChange = vi.fn();

	const result = render(
		<LayerStackProvider>
			<DocumentGraphView
				isOpen
				onClose={onClose}
				theme={theme}
				rootPath="/workspace"
				focusFilePath="docs/index.md"
				onDocumentOpen={onDocumentOpen}
				onExternalLinkOpen={onExternalLinkOpen}
				onExternalLinksChange={onExternalLinksChange}
				onNeighborDepthChange={onNeighborDepthChange}
				onPreviewCharLimitChange={onPreviewCharLimitChange}
				onLayoutTypeChange={onLayoutTypeChange}
				{...props}
			/>
		</LayerStackProvider>
	);

	return {
		...result,
		onClose,
		onDocumentOpen,
		onExternalLinkOpen,
		onExternalLinksChange,
		onNeighborDepthChange,
		onPreviewCharLimitChange,
		onLayoutTypeChange,
	};
}

function latestMindMapProps() {
	const props = mindMapState.props.at(-1);
	if (!props) {
		throw new Error('MindMap has not rendered yet');
	}
	return props;
}

function getByExactTextContent(text: string) {
	return screen.getAllByText((_content, node) => node?.textContent === text)[0];
}

function invokeReactKeyDown(element: HTMLElement, key: string) {
	// RTL key events do not reach this input inside the modal harness; call the actual React handler.
	const reactPropsKey = Object.keys(element).find((propKey) => propKey.startsWith('__reactProps$'));
	const onKeyDown = reactPropsKey ? (element as any)[reactPropsKey]?.onKeyDown : undefined;

	if (typeof onKeyDown !== 'function') {
		throw new Error('React keydown handler was not found on the target element');
	}

	onKeyDown({
		key,
		code: key,
		currentTarget: element,
		target: element,
		preventDefault: vi.fn(),
		stopPropagation: vi.fn(),
	} as React.KeyboardEvent<HTMLInputElement>);
}

describe('DocumentGraphView integration', () => {
	const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
	let consoleLogSpy: ReturnType<typeof vi.spyOn>;
	let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
	let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
	let filesChangedHandler:
		((data: { rootPath: string; changes: Array<{ filePath: string }> }) => void) | null;

	beforeEach(() => {
		vi.clearAllMocks();
		mindMapState.props = [];
		filesChangedHandler = null;

		consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		clearGraphDataCache();
		globalThis.requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
			callback(performance.now());
			return 1;
		});

		Object.assign(window.maestro, {
			documentGraph: {
				watchFolder: vi.fn().mockResolvedValue({ success: true }),
				unwatchFolder: vi.fn().mockResolvedValue({ success: true }),
				onFilesChanged: vi.fn((handler) => {
					filesChangedHandler = handler;
					return vi.fn();
				}),
			},
		});
		window.maestro.fs.readDir = vi.fn(async (dirPath: string) => {
			const entries = directoryEntries[dirPath];
			if (!entries) {
				throw new Error(`Unknown directory: ${dirPath}`);
			}
			return entries;
		});
		window.maestro.fs.readFile = vi.fn(async (filePath: string) => files[filePath] ?? null);
		window.maestro.fs.stat = vi.fn(async (filePath: string) => ({
			size: files[filePath]?.length ?? 0,
			createdAt: '2026-01-01T00:00:00.000Z',
			modifiedAt: '2026-01-02T00:00:00.000Z',
			isDirectory: false,
			isFile: true,
		}));
		vi.mocked(safeClipboardWrite).mockResolvedValue(true);
	});

	afterEach(() => {
		cleanup();
		consoleLogSpy.mockRestore();
		consoleWarnSpy.mockRestore();
		consoleErrorSpy.mockRestore();
		if (originalRequestAnimationFrame) {
			globalThis.requestAnimationFrame = originalRequestAnimationFrame;
		} else {
			delete (globalThis as Partial<typeof globalThis>).requestAnimationFrame;
		}
	});

	it('renders nothing while closed', () => {
		renderGraph({ isOpen: false });

		expect(screen.queryByRole('dialog', { name: 'Document Graph' })).not.toBeInTheDocument();
	});

	it('builds a graph from the Electron filesystem bridge and toggles external-link/search state', async () => {
		const { onExternalLinksChange } = renderGraph();

		expect(await screen.findByTestId('mind-map')).toHaveAttribute('data-node-count', '3');
		expect(screen.getByText('index')).toBeInTheDocument();
		expect(screen.getByText('linked')).toBeInTheDocument();
		expect(screen.getByText('today')).toBeInTheDocument();
		expect(screen.queryByText('example.com')).not.toBeInTheDocument();
		expect(window.maestro.fs.readDir).toHaveBeenCalledWith('/workspace', undefined);
		expect(window.maestro.documentGraph.watchFolder).toHaveBeenCalledWith('/workspace');

		const externalToggle = screen.getByTitle('Show external links');
		fireEvent.mouseEnter(externalToggle);
		fireEvent.mouseLeave(externalToggle);
		fireEvent.click(externalToggle);

		expect(onExternalLinksChange).toHaveBeenCalledWith(true);
		expect(await screen.findByText('example.com')).toBeInTheDocument();
		expect(screen.getByText(/3 documents, 1 external domain/)).toBeInTheDocument();

		fireEvent.change(screen.getByLabelText('Search documents in graph'), {
			target: { value: 'linked' },
		});

		await waitFor(() => expect(latestMindMapProps().searchQuery).toBe('linked'));
		expect(getByExactTextContent('1 of 4 matching')).toBeInTheDocument();
		fireEvent.mouseEnter(screen.getByLabelText('Clear search'));
		fireEvent.mouseLeave(screen.getByLabelText('Clear search'));
	});

	it('aborts an in-flight backlink scan when refreshing and unmounting', async () => {
		const abortBacklinkScan = vi.fn();
		const startBacklinkScan = vi.fn(() => abortBacklinkScan);
		const buildGraphDataSpy = vi.spyOn(graphDataBuilder, 'buildGraphData').mockResolvedValue({
			nodes: [
				{
					id: 'docs/index.md',
					type: 'documentNode',
					data: {
						nodeType: 'document',
						title: 'Index',
						filePath: 'docs/index.md',
						lineCount: 1,
						wordCount: 1,
						size: '1 B',
						contentPreview: 'Index',
					},
				},
			],
			edges: [],
			totalDocuments: 1,
			loadedDocuments: 1,
			hasMore: false,
			cachedExternalData: {
				externalNodes: [],
				externalEdges: [],
				domainCount: 0,
				totalLinkCount: 0,
			},
			internalLinkCount: 0,
			allMarkdownFiles: ['', 'docs/index.md'],
			startBacklinkScan,
		} as Awaited<ReturnType<typeof graphDataBuilder.buildGraphData>>);

		const rendered = renderGraph();

		try {
			await screen.findByTestId('mind-map');
			expect(startBacklinkScan).toHaveBeenCalledOnce();

			fireEvent.click(screen.getByTitle('Refresh graph'));
			await waitFor(() => expect(buildGraphDataSpy).toHaveBeenCalledTimes(2));
			expect(abortBacklinkScan).toHaveBeenCalledOnce();
			await waitFor(() => expect(startBacklinkScan).toHaveBeenCalledTimes(2));

			rendered.unmount();
			expect(abortBacklinkScan).toHaveBeenCalledTimes(2);
		} finally {
			buildGraphDataSpy.mockRestore();
		}
	});

	it('selects document nodes, loads footer metadata, previews markdown, and opens files', async () => {
		const { onDocumentOpen } = renderGraph();

		await screen.findByTestId('mind-map');
		fireEvent.click(screen.getByRole('button', { name: 'Select Index' }));

		expect(await screen.findByText('docs/index.md')).toBeInTheDocument();
		await waitFor(() => expect(getByExactTextContent('1 of 2 tasks')).toBeInTheDocument());
		expect(getByExactTextContent('Created Dec 31, 2025')).toBeInTheDocument();
		expect(getByExactTextContent('Modified Jan 1, 2026')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Preview Index' }));

		const preview = await screen.findByTestId('graph-markdown-preview');
		expect(preview).toHaveTextContent('# Index');
		expect(preview).toHaveAttribute('data-cwd', 'docs');
		expect(preview).toHaveAttribute('data-file-tree-roots', 'docs,notes');

		fireEvent.click(within(preview).getByRole('button', { name: 'Copy markdown' }));
		await waitFor(() => expect(safeClipboardWrite).toHaveBeenCalledWith('copied markdown'));

		fireEvent.click(screen.getByRole('button', { name: 'Open Index' }));
		expect(onDocumentOpen).toHaveBeenCalledWith('docs/index.md');

		fireEvent.click(screen.getByRole('button', { name: 'Open' }));
		expect(onDocumentOpen).toHaveBeenCalledWith('docs/index.md');
	});

	it('navigates preview history, forwards preview settings, and handles preview errors', async () => {
		useSettingsStore.setState({ bionifyReadingMode: true });
		renderGraph({ sshRemoteId: 'remote-1' });

		await screen.findByTestId('mind-map');
		fireEvent.click(screen.getByRole('button', { name: 'Preview Index' }));

		const firstPreview = await screen.findByTestId('graph-markdown-preview');
		expect(firstPreview).toHaveTextContent('# Index');
		expect(firstPreview).toHaveAttribute('data-bionify', 'true');
		expect(firstPreview).toHaveAttribute('data-ssh-remote', 'remote-1');

		fireEvent.click(within(firstPreview).getByRole('button', { name: 'Open linked wiki preview' }));
		const secondPreview = await screen.findByTestId('graph-markdown-preview');
		expect(secondPreview).toHaveTextContent('# Linked');

		const previewPanel = secondPreview.closest('.graph-preview')?.parentElement as HTMLElement;
		fireEvent.keyDown(previewPanel, { key: 'ArrowRight' });
		expect(screen.getByTestId('graph-markdown-preview')).toHaveTextContent('# Linked');
		fireEvent.keyDown(previewPanel, { key: 'ArrowLeft' });
		await waitFor(() =>
			expect(screen.getByTestId('graph-markdown-preview')).toHaveTextContent('# Index')
		);

		const backButton = screen.getByRole('button', { name: 'Go back' });
		const forwardButton = screen.getByRole('button', { name: 'Go forward' });
		fireEvent.mouseEnter(forwardButton);
		fireEvent.mouseLeave(forwardButton);

		fireEvent.keyDown(previewPanel, { key: 'ArrowRight' });
		await waitFor(() =>
			expect(screen.getByTestId('graph-markdown-preview')).toHaveTextContent('# Linked')
		);

		fireEvent.mouseEnter(backButton);
		fireEvent.mouseLeave(backButton);
		fireEvent.mouseEnter(forwardButton);
		fireEvent.mouseLeave(forwardButton);

		fireEvent.keyDown(previewPanel, { key: 'ArrowLeft', ctrlKey: true });
		expect(screen.getByTestId('graph-markdown-preview')).toHaveTextContent('# Linked');

		fireEvent.click(
			within(screen.getByTestId('graph-markdown-preview')).getByRole('button', {
				name: 'Open missing wiki preview',
			})
		);
		expect(await screen.findByText('Unable to read file contents.')).toBeInTheDocument();

		fireEvent.keyDown(document, { key: 'Escape' });
		expect(screen.queryByText('Unable to read file contents.')).not.toBeInTheDocument();
	});

	it('handles optional open callbacks and preview path fallbacks', async () => {
		const readFile = vi.fn(async (filePath: string) => {
			if (filePath === '/outside.md') return '# Outside';
			if (filePath === '/workspace/') return '# Workspace Root';
			return files[filePath] ?? null;
		});
		window.maestro.fs.readFile = readFile;

		renderGraph({
			onDocumentOpen: undefined,
			onExternalLinkOpen: undefined,
			defaultShowExternalLinks: true,
		});

		await screen.findByTestId('mind-map');

		fireEvent.click(screen.getByRole('button', { name: 'Open Index' }));
		fireEvent.click(screen.getByRole('button', { name: 'Context Index' }));
		fireEvent.click(screen.getByRole('button', { name: 'Open' }));
		fireEvent.click(screen.getByRole('button', { name: 'Context External' }));
		fireEvent.click(screen.getByRole('button', { name: 'Open' }));

		fireEvent.click(screen.getByRole('button', { name: 'Preview Absolute' }));
		expect(await screen.findByTestId('graph-markdown-preview')).toHaveTextContent('# Index');

		fireEvent.click(screen.getByRole('button', { name: 'Preview Outside' }));
		expect(await screen.findByTestId('graph-markdown-preview')).toHaveTextContent('# Outside');

		fireEvent.click(screen.getByRole('button', { name: 'Preview Root' }));
		expect(await screen.findByTestId('graph-markdown-preview')).toHaveTextContent(
			'# Workspace Root'
		);

		readFile.mockRejectedValueOnce('bad preview');
		fireEvent.click(screen.getByRole('button', { name: 'Preview Index' }));
		expect(await screen.findByText('Failed to load preview.')).toBeInTheDocument();
	});

	it('routes context-menu actions for document and external nodes', async () => {
		const { onDocumentOpen, onExternalLinkOpen } = renderGraph({ defaultShowExternalLinks: true });

		await screen.findByText('example.com');

		fireEvent.click(screen.getByRole('button', { name: 'Context Index' }));
		fireEvent.click(screen.getByRole('button', { name: 'Copy Path' }));
		await waitFor(() => expect(safeClipboardWrite).toHaveBeenCalledWith('docs/index.md'));

		fireEvent.click(screen.getByRole('button', { name: 'Context Index' }));
		fireEvent.click(screen.getByRole('button', { name: 'Open' }));
		expect(onDocumentOpen).toHaveBeenCalledWith('docs/index.md');

		fireEvent.click(screen.getByRole('button', { name: 'Context External' }));
		fireEvent.click(screen.getByRole('button', { name: 'Open' }));
		expect(onExternalLinkOpen).toHaveBeenCalledWith('https://example.com/guide');
	});

	it('handles search shortcuts, external selection, help panel, and context-menu focus', async () => {
		renderGraph({ defaultShowExternalLinks: true, defaultNeighborDepth: 0 });

		await screen.findByText('example.com');
		const dialog = screen.getByRole('dialog', { name: 'Document Graph' });
		const searchInput = screen.getByLabelText('Search documents in graph') as HTMLInputElement;

		fireEvent.keyDown(dialog, { key: 'f', metaKey: true });
		expect(document.activeElement).toBe(searchInput);

		fireEvent.change(searchInput, { target: { value: 'example' } });
		await waitFor(() => expect(latestMindMapProps().searchQuery).toBe('example'));
		act(() => invokeReactKeyDown(screen.getByLabelText('Search documents in graph'), 'Escape'));
		await waitFor(() => expect(latestMindMapProps().searchQuery).toBe(''));

		fireEvent.change(screen.getByLabelText('Search documents in graph'), {
			target: { value: 'example' },
		});
		await waitFor(() => expect(latestMindMapProps().searchQuery).toBe('example'));
		fireEvent.mouseEnter(screen.getByLabelText('Clear search'));
		fireEvent.mouseLeave(screen.getByLabelText('Clear search'));
		fireEvent.click(screen.getByLabelText('Clear search'));
		await waitFor(() => expect(searchInput).toHaveValue(''));

		const emptySearchInput = screen.getByLabelText('Search documents in graph') as HTMLInputElement;
		emptySearchInput.focus();
		act(() => invokeReactKeyDown(emptySearchInput, 'Escape'));
		await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('mind-map')));

		fireEvent.click(screen.getByRole('button', { name: 'Select External' }));
		expect(screen.getByText('External: example.com')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Clear Selection' }));
		expect(screen.queryByText('External: example.com')).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Preview External' }));
		expect(screen.queryByTestId('graph-markdown-preview')).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Recenter External' }));
		fireEvent.click(screen.getByRole('button', { name: 'Recenter Index' }));
		await waitFor(() => expect(latestMindMapProps().centerFilePath).toBe('docs/index.md'));

		fireEvent.click(screen.getByRole('button', { name: 'Context Index' }));
		fireEvent.click(screen.getByRole('button', { name: 'Focus' }));
		await waitFor(() =>
			expect(screen.getByRole('button', { name: /Depth: 2/i })).toBeInTheDocument()
		);

		vi.mocked(safeClipboardWrite).mockClear();
		fireEvent.click(screen.getByRole('button', { name: 'Context External' }));
		fireEvent.click(screen.getByRole('button', { name: 'Copy URL' }));
		await waitFor(() =>
			expect(safeClipboardWrite).toHaveBeenCalledWith('https://example.com/guide')
		);

		const helpButton = screen.getByRole('button', { name: /Help\?/i });
		fireEvent.mouseEnter(helpButton);
		fireEvent.mouseLeave(helpButton);
		fireEvent.click(helpButton);
		const helpPanel = screen.getByRole('region', { name: 'Help panel' });
		expect(within(helpPanel).getByText('Keyboard Shortcuts')).toBeInTheDocument();
		fireEvent.click(within(helpPanel).getByTitle('Close (Esc)'));
		expect(screen.queryByRole('region', { name: 'Help panel' })).not.toBeInTheDocument();
		fireEvent.click(helpButton);
		fireEvent.keyDown(document, { key: 'Escape' });
		expect(screen.queryByRole('region', { name: 'Help panel' })).not.toBeInTheDocument();
	});

	it('covers metadata, context menu, depth, external, and empty-focus fallbacks', async () => {
		const stat = vi.fn(async () => ({
			size: 0,
			createdAt: undefined,
			modifiedAt: undefined,
			isDirectory: false,
			isFile: true,
		}));
		window.maestro.fs.stat = stat;

		const { onExternalLinksChange } = renderGraph({
			defaultNeighborDepth: 0,
			defaultShowExternalLinks: true,
			defaultPreviewCharLimit: 200,
		});

		await screen.findByText('example.com');
		const readFile = vi.fn(async (filePath: string) =>
			filePath === '/workspace/docs/index.md' ? '# Plain document' : (files[filePath] ?? null)
		);
		window.maestro.fs.readFile = readFile;
		fireEvent.click(screen.getByRole('button', { name: 'Select Index' }));
		await waitFor(() => expect(stat).toHaveBeenCalledWith('/workspace/docs/index.md', undefined));
		expect(screen.queryByText(/tasks/)).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Context Blank Document' }));
		fireEvent.click(screen.getByRole('button', { name: 'Copy Path' }));
		await waitFor(() => expect(safeClipboardWrite).toHaveBeenCalledWith(''));

		fireEvent.click(screen.getByRole('button', { name: 'Context Blank External' }));
		expect(screen.getByRole('button', { name: 'Open' })).toBeInTheDocument();

		const depthButton = screen.getByRole('button', { name: /Depth: All/i });
		fireEvent.mouseEnter(depthButton);
		fireEvent.mouseLeave(depthButton);
		fireEvent.click(depthButton);
		expect(screen.getByText('Showing all documents')).toBeInTheDocument();

		const previewLimitButton = screen.getByRole('button', { name: /Preview: 200/i });
		fireEvent.mouseEnter(previewLimitButton);
		fireEvent.mouseLeave(previewLimitButton);

		const externalToggle = screen.getByTitle('Hide external links');
		fireEvent.mouseEnter(externalToggle);
		fireEvent.mouseLeave(externalToggle);
		fireEvent.click(externalToggle);
		expect(onExternalLinksChange).toHaveBeenCalledWith(false);

		cleanup();

		const buildGraphDataSpy = vi.spyOn(graphDataBuilder, 'buildGraphData').mockResolvedValue({
			nodes: [
				{
					id: 'docs/index.md',
					type: 'documentNode',
					data: {
						nodeType: 'document',
						title: 'Index',
						filePath: 'docs/index.md',
						lineCount: 1,
						wordCount: 1,
						size: '1 B',
						contentPreview: 'Index',
					},
				},
			],
			edges: [],
			totalDocuments: 1,
			loadedDocuments: 1,
			hasMore: false,
			cachedExternalData: {
				externalNodes: [],
				externalEdges: [],
				domainCount: 0,
				totalLinkCount: 0,
			},
			internalLinkCount: 0,
			allMarkdownFiles: ['docs/index.md'],
		} as Awaited<ReturnType<typeof graphDataBuilder.buildGraphData>>);

		try {
			renderGraph({ focusFilePath: '' });
			expect(await screen.findByText('No focus document selected')).toBeInTheDocument();
		} finally {
			buildGraphDataSpy.mockRestore();
		}
	});

	it('handles file watcher updates and selected-node metadata fallbacks', async () => {
		const stat = vi.fn(async (filePath: string) => ({
			size: files[filePath]?.length ?? 0,
			createdAt: '2026-01-01T00:00:00.000Z',
			modifiedAt: '2026-01-02T00:00:00.000Z',
			isDirectory: false,
			isFile: true,
		}));
		const readFile = vi.fn(async (filePath: string) => files[filePath] ?? null);
		window.maestro.fs.stat = stat;
		window.maestro.fs.readFile = readFile;

		renderGraph();

		await screen.findByTestId('mind-map');
		expect(filesChangedHandler).toBeTruthy();
		filesChangedHandler?.({
			rootPath: '/elsewhere',
			changes: [{ filePath: '/elsewhere/ignored.md' }],
		});
		filesChangedHandler?.({
			rootPath: '/workspace',
			changes: [{ filePath: '/workspace/docs/index.md' }],
		});

		stat.mockRejectedValue(new Error('stat unavailable'));
		readFile.mockImplementation(async (filePath: string) =>
			filePath === '/workspace/docs/index.md'
				? Promise.reject(new Error('content unavailable'))
				: (files[filePath] ?? null)
		);
		fireEvent.click(screen.getByRole('button', { name: 'Select Index' }));
		await waitFor(() => expect(stat).toHaveBeenCalledWith('/workspace/docs/index.md', undefined));
		expect(screen.queryByText(/tasks/)).not.toBeInTheDocument();

		readFile.mockImplementation(async (filePath: string) =>
			filePath === '/workspace/docs/linked.md' ? null : (files[filePath] ?? null)
		);
		fireEvent.click(screen.getByRole('button', { name: 'Select Linked' }));
		await waitFor(() =>
			expect(readFile).toHaveBeenCalledWith('/workspace/docs/linked.md', undefined)
		);
		expect(screen.queryByText(/tasks/)).not.toBeInTheDocument();
	});

	it('persists settings control changes, resets dragged positions, and confirms close', async () => {
		const { onClose, onLayoutTypeChange, onNeighborDepthChange, onPreviewCharLimitChange } =
			renderGraph();

		await screen.findByTestId('mind-map');

		const layoutButton = screen.getByRole('button', { name: /Hierarchical/i });
		fireEvent.mouseEnter(layoutButton);
		fireEvent.mouseLeave(layoutButton);
		fireEvent.click(layoutButton);
		fireEvent.keyDown(document, { key: 'Escape' });
		expect(screen.queryByRole('button', { name: /Radial/i })).not.toBeInTheDocument();
		fireEvent.click(layoutButton);
		const layoutOverlay = document.querySelector('div.fixed.inset-0.z-40') as HTMLElement;
		fireEvent.click(layoutOverlay);
		expect(screen.queryByRole('button', { name: /Radial/i })).not.toBeInTheDocument();
		fireEvent.click(layoutButton);
		const radialButton = screen.getByRole('button', { name: /Radial/i });
		fireEvent.mouseEnter(radialButton);
		fireEvent.mouseLeave(radialButton);
		fireEvent.click(radialButton);
		expect(onLayoutTypeChange).toHaveBeenCalledWith('radial');
		await waitFor(() => expect(latestMindMapProps().layoutType).toBe('radial'));

		const depthButton = screen.getByRole('button', { name: /Depth: 2/i });
		fireEvent.mouseEnter(depthButton);
		fireEvent.mouseLeave(depthButton);
		fireEvent.click(depthButton);
		fireEvent.keyDown(document, { key: 'Escape' });
		expect(screen.queryByDisplayValue('2')).not.toBeInTheDocument();
		fireEvent.click(depthButton);
		const depthOverlay = document.querySelector('div.fixed.inset-0.z-40') as HTMLElement;
		fireEvent.click(depthOverlay);
		expect(screen.queryByDisplayValue('2')).not.toBeInTheDocument();
		fireEvent.click(depthButton);
		fireEvent.change(screen.getByDisplayValue('2'), { target: { value: '3' } });
		expect(onNeighborDepthChange).toHaveBeenCalledWith(3);

		const previewLimitButton = screen.getByRole('button', { name: /Preview: 100/i });
		fireEvent.mouseEnter(previewLimitButton);
		fireEvent.mouseLeave(previewLimitButton);
		fireEvent.click(previewLimitButton);
		fireEvent.change(screen.getByDisplayValue('100'), { target: { value: '200' } });
		expect(onPreviewCharLimitChange).toHaveBeenCalledWith(200);

		fireEvent.click(screen.getByRole('button', { name: 'Move Index' }));
		const resetButton = await screen.findByRole('button', { name: /Reset Layout/i });
		fireEvent.mouseEnter(resetButton);
		fireEvent.mouseLeave(resetButton);
		expect(resetButton).toBeInTheDocument();
		fireEvent.click(resetButton);
		await waitFor(() =>
			expect(screen.queryByRole('button', { name: /Reset Layout/i })).not.toBeInTheDocument()
		);
		fireEvent.click(screen.getByRole('button', { name: 'Move Index' }));
		expect(await screen.findByRole('button', { name: /Reset Layout/i })).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Recenter Linked' }));
		await waitFor(() => expect(latestMindMapProps().centerFilePath).toBe('docs/linked.md'));
		await waitFor(() =>
			expect(screen.queryByRole('button', { name: /Reset Layout/i })).not.toBeInTheDocument()
		);

		const refreshButton = screen.getByTitle('Refresh graph');
		fireEvent.mouseEnter(refreshButton);
		fireEvent.mouseLeave(refreshButton);
		fireEvent.click(refreshButton);
		await waitFor(() => expect(screen.getByTestId('mind-map')).toBeInTheDocument());

		const closeButton = screen.getByTitle('Close (Esc)');
		fireEvent.mouseEnter(closeButton);
		fireEvent.mouseLeave(closeButton);
		fireEvent.click(closeButton);
		expect(screen.getByText('Close Document Graph?')).toBeInTheDocument();
		fireEvent.click(screen.getByLabelText('Close modal'));
		expect(screen.queryByText('Close Document Graph?')).not.toBeInTheDocument();

		fireEvent.click(screen.getByTitle('Close (Esc)'));
		expect(screen.getByText('Close Document Graph?')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(screen.queryByText('Close Document Graph?')).not.toBeInTheDocument();

		fireEvent.click(screen.getByTitle('Close (Esc)'));
		fireEvent.click(screen.getByRole('button', { name: 'Close Graph' }));
		expect(onClose).toHaveBeenCalledOnce();
	});

	it('shows empty and error states, retries, cleans watcher failures, and loads more nodes', async () => {
		window.maestro.fs.readDir = vi.fn().mockResolvedValue([]);
		const empty = renderGraph({ rootPath: '/empty', focusFilePath: 'missing.md' });
		expect(await screen.findByText('No markdown files found')).toBeInTheDocument();
		empty.unmount();

		const retryGraphDataSpy = vi
			.spyOn(graphDataBuilder, 'buildGraphData')
			.mockRejectedValueOnce(new Error('scan failed'))
			.mockResolvedValue(graphData());
		try {
			const retried = renderGraph();
			expect(await screen.findByText('Failed to load document graph')).toBeInTheDocument();
			expect(screen.getByText(/scan failed/)).toBeInTheDocument();
			fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
			await waitFor(() =>
				expect(retried.container.querySelector('[data-testid="mind-map"]')).toHaveAttribute(
					'data-node-count',
					'1'
				)
			);
			retried.unmount();
		} finally {
			retryGraphDataSpy.mockRestore();
		}

		window.maestro.documentGraph.watchFolder = vi.fn().mockRejectedValue(new Error('watch failed'));
		const watchFailed = renderGraph();
		await waitFor(() =>
			expect(watchFailed.container.querySelector('[data-testid="mind-map"]')).toBeInTheDocument()
		);
		await waitFor(() =>
			expect(loggerMocks.error).toHaveBeenCalledWith(
				'Failed to start document graph file watcher:',
				undefined,
				expect.any(Error)
			)
		);
		watchFailed.unmount();

		window.maestro.documentGraph.unwatchFolder = vi
			.fn()
			.mockRejectedValue(new Error('unwatch failed'));
		const watched = renderGraph();
		await waitFor(() =>
			expect(watched.container.querySelector('[data-testid="mind-map"]')).toBeInTheDocument()
		);
		watched.unmount();
		await waitFor(() =>
			expect(loggerMocks.error).toHaveBeenCalledWith(
				'Failed to stop document graph file watcher:',
				undefined,
				expect.any(Error)
			)
		);
		window.maestro.documentGraph.watchFolder = vi.fn().mockResolvedValue({ success: true });
		window.maestro.documentGraph.unwatchFolder = vi.fn().mockResolvedValue({ success: true });

		const paged = renderGraph({ defaultMaxNodes: 1 });
		await screen.findByTestId('mind-map');
		const loadMoreButton = await screen.findByRole('button', { name: /Load more/i });
		fireEvent.mouseEnter(loadMoreButton);
		fireEvent.mouseLeave(loadMoreButton);
		fireEvent.click(loadMoreButton);
		await waitFor(() => expect(latestMindMapProps().nodes.length).toBeGreaterThan(1));
		paged.unmount();

		const failedLoadMore = renderGraph({ defaultMaxNodes: 1 });
		await screen.findByTestId('mind-map');
		const loadMoreFailureSpy = vi
			.spyOn(graphDataBuilder, 'buildGraphData')
			.mockRejectedValue(new Error('load more failed'));
		try {
			clearGraphDataCache();
			fireEvent.click(await screen.findByRole('button', { name: /Load more/i }));
			await waitFor(() =>
				expect(loggerMocks.error).toHaveBeenCalledWith(
					'Failed to load more documents:',
					undefined,
					expect.any(Error)
				)
			);
		} finally {
			loadMoreFailureSpy.mockRestore();
		}
		failedLoadMore.unmount();
	});

	it('shows loading progress, backlink progress, and ignores empty backlink updates', async () => {
		const OriginalResizeObserver = globalThis.ResizeObserver;
		let resizeCallback: ResizeObserverCallback | undefined;

		class TestResizeObserver {
			constructor(callback: ResizeObserverCallback) {
				resizeCallback = callback;
			}
			observe() {}
			disconnect() {}
		}

		globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;

		let buildOptions: Parameters<typeof graphDataBuilder.buildGraphData>[0] | undefined;
		let resolveGraph!: (data: GraphData) => void;
		let backlinkUpdate:
			((data: Parameters<NonNullable<GraphData['startBacklinkScan']>>[0]) => void) | undefined;
		const abortBacklinkScan = vi.fn();
		const startBacklinkScan = vi.fn((onUpdate) => {
			backlinkUpdate = onUpdate;
			return abortBacklinkScan;
		});
		const buildGraphDataSpy = vi.spyOn(graphDataBuilder, 'buildGraphData').mockImplementation(
			(options) =>
				new Promise<GraphData>((resolve) => {
					buildOptions = options;
					resolveGraph = resolve;
				})
		);

		try {
			const rendered = renderGraph();

			await waitFor(() => expect(buildOptions).toBeTruthy());

			act(() =>
				buildOptions?.onProgress?.({
					phase: 'scanning',
					current: 4,
					total: 0,
				})
			);
			expect(await screen.findByText('Scanning directories... (4 scanned)')).toBeInTheDocument();

			act(() =>
				buildOptions?.onProgress?.({
					phase: 'parsing',
					current: 1,
					total: 2,
					currentFile: 'docs/index.md',
					externalLinksFound: 2,
				})
			);
			expect(await screen.findByText('Parsing documents... 1 of 2')).toBeInTheDocument();
			expect(screen.getByTitle('docs/index.md')).toBeInTheDocument();
			expect(getByExactTextContent('0 internal · 2 external links')).toBeInTheDocument();

			act(() =>
				buildOptions?.onProgress?.({
					phase: 'parsing',
					current: 2,
					total: 2,
					internalLinksFound: 3,
				})
			);
			expect(getByExactTextContent('3 internal · 0 external links')).toBeInTheDocument();

			await act(async () => {
				resolveGraph(graphData({ startBacklinkScan }));
			});
			expect(await screen.findByTestId('mind-map')).toBeInTheDocument();
			expect(startBacklinkScan).toHaveBeenCalledOnce();

			act(() =>
				backlinkUpdate?.({
					filesScanned: 1,
					totalFiles: 2,
					newNodes: [],
					newEdges: [],
				})
			);
			expect(await screen.findByText(/Scanning backlinks \(1\/2\)/)).toBeInTheDocument();
			expect(screen.getByTestId('mind-map')).toHaveAttribute('data-node-count', '1');

			rendered.unmount();
			act(() => resizeCallback?.([] as ResizeObserverEntry[], {} as ResizeObserver));
		} finally {
			globalThis.ResizeObserver = OriginalResizeObserver;
			buildGraphDataSpy.mockRestore();
		}
	});

	it('uses load-more fallbacks without an active focus file and handles non-error load failures', async () => {
		const buildGraphDataSpy = vi
			.spyOn(graphDataBuilder, 'buildGraphData')
			.mockResolvedValueOnce(
				graphData({
					totalDocuments: 2,
					loadedDocuments: 1,
					hasMore: true,
				})
			)
			.mockResolvedValueOnce(
				graphData({
					totalDocuments: 2,
					loadedDocuments: 2,
					hasMore: false,
				})
			);

		try {
			renderGraph({ focusFilePath: '', defaultMaxNodes: 1, defaultNeighborDepth: 0 });
			expect(await screen.findByText('No focus document selected')).toBeInTheDocument();
			expect(getByExactTextContent('1 of 2 document')).toBeInTheDocument();

			act(() => invokeReactKeyDown(screen.getByLabelText('Search documents in graph'), 'Escape'));
			fireEvent.click(screen.getByRole('button', { name: /Load more/i }));

			await waitFor(() => expect(buildGraphDataSpy).toHaveBeenCalledTimes(2));
			expect(buildGraphDataSpy.mock.calls[1][0]).toMatchObject({
				focusFile: '',
				maxDepth: 10,
			});
		} finally {
			buildGraphDataSpy.mockRestore();
		}

		cleanup();
		const stringFailureSpy = vi
			.spyOn(graphDataBuilder, 'buildGraphData')
			.mockRejectedValue('string failure');

		try {
			clearGraphDataCache();
			const failed = renderGraph();

			expect(await screen.findAllByText('Failed to load document graph')).toHaveLength(2);
			await waitFor(() =>
				expect(loggerMocks.error).toHaveBeenCalledWith(
					'Failed to build graph data:',
					undefined,
					'string failure'
				)
			);
			failed.unmount();
		} finally {
			stringFailureSpy.mockRestore();
		}
	});

	it('covers search, layout, depth, legend, and context focus fallback branches', async () => {
		renderGraph({ defaultShowExternalLinks: true, defaultNeighborDepth: 1 });

		await screen.findByText('example.com');
		const searchInput = screen.getByLabelText('Search documents in graph') as HTMLInputElement;

		fireEvent.change(searchInput, { target: { value: 'docs/' } });
		await waitFor(() => expect(latestMindMapProps().searchQuery).toBe('docs/'));
		expect(getByExactTextContent('2 of 4 matching')).toBeInTheDocument();
		fireEvent.focus(searchInput);
		fireEvent.blur(searchInput);
		act(() => invokeReactKeyDown(searchInput, 'Enter'));

		fireEvent.click(screen.getByRole('button', { name: 'Context Index' }));
		fireEvent.click(screen.getByRole('button', { name: 'Focus' }));
		expect(screen.getByRole('button', { name: /Depth: 1/i })).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Context External' }));
		fireEvent.click(screen.getByRole('button', { name: 'Focus' }));

		const layoutButton = screen.getByRole('button', { name: /Hierarchical/i });
		fireEvent.click(layoutButton);
		const activeLayoutOption = screen.getAllByRole('button', { name: /Mind Map/i }).at(-1)!;
		fireEvent.mouseEnter(activeLayoutOption);
		fireEvent.mouseLeave(activeLayoutOption);

		const depthButton = screen.getByRole('button', { name: /Depth: 1/i });
		expect(depthButton).toHaveAttribute('title', 'Showing 1 level of neighbors');
		fireEvent.click(depthButton);
		expect(screen.getByText('Showing documents within 1 link of focus')).toBeInTheDocument();

		const helpButton = screen.getByRole('button', { name: /Help\?/i });
		fireEvent.click(helpButton);
		fireEvent.mouseEnter(helpButton);
		fireEvent.mouseLeave(helpButton);
		expect(screen.getByRole('region', { name: 'Help panel' })).toBeInTheDocument();
	});

	it('renders external multi-link details and skips missing-domain search matches', async () => {
		const exampleExternal = externalNode('example.com', [
			'https://example.com/a',
			'https://example.com/b',
		]);
		const docsExternal = externalNode('docs.example.org', ['https://docs.example.org/start']);
		const missingDomainExternal = externalNode(undefined, ['https://missing.example/link']);
		const buildGraphDataSpy = vi.spyOn(graphDataBuilder, 'buildGraphData').mockResolvedValue(
			graphData({
				cachedExternalData: {
					externalNodes: [exampleExternal, docsExternal, missingDomainExternal],
					externalEdges: [],
					domainCount: 3,
					totalLinkCount: 4,
				},
			})
		);

		try {
			renderGraph({ defaultShowExternalLinks: true });

			await screen.findByText('example.com');
			expect(getByExactTextContent('1 document, 3 external domains')).toBeInTheDocument();

			fireEvent.click(screen.getByRole('button', { name: 'Select External' }));
			expect(screen.getByText('(2 links)')).toBeInTheDocument();

			fireEvent.change(screen.getByLabelText('Search documents in graph'), {
				target: { value: 'absent' },
			});
			await waitFor(() => expect(latestMindMapProps().searchQuery).toBe('absent'));
			expect(getByExactTextContent('0 of 4 matching')).toBeInTheDocument();
		} finally {
			buildGraphDataSpy.mockRestore();
		}
	});

	it('handles search escape when the active focus has no matching center node', async () => {
		const pathlessNode = documentNode('docs/pathless.md', 'Pathless');
		delete (pathlessNode.data as { filePath?: string }).filePath;
		const buildGraphDataSpy = vi.spyOn(graphDataBuilder, 'buildGraphData').mockResolvedValue(
			graphData({
				nodes: [documentNode('docs/other.md', 'Other'), pathlessNode],
				allMarkdownFiles: ['docs/other.md', 'docs/pathless.md'],
			})
		);

		try {
			renderGraph({ focusFilePath: 'docs/missing.md' });

			await screen.findByTestId('mind-map');
			const searchInput = screen.getByLabelText('Search documents in graph') as HTMLInputElement;
			fireEvent.change(searchInput, { target: { value: 'absent' } });
			await waitFor(() => expect(latestMindMapProps().searchQuery).toBe('absent'));
			expect(getByExactTextContent('0 of 2 matching')).toBeInTheDocument();
			fireEvent.click(screen.getByLabelText('Clear search'));
			await waitFor(() => expect(latestMindMapProps().searchQuery).toBe(''));
			searchInput.focus();
			act(() => invokeReactKeyDown(searchInput, 'Escape'));
			await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('mind-map')));
		} finally {
			buildGraphDataSpy.mockRestore();
		}
	});
});
