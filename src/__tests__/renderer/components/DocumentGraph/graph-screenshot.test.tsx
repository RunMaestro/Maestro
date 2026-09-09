/**
 * The graph screenshot affordance.
 *
 * Three things here are easy to get wrong and cheap to pin down: the camera is
 * offered only when the bridge can actually take a shot, `C` reaches the same
 * chooser as the button, and the chooser gets out of the way before the capture
 * runs so the shot does not contain the dialog that asked for it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

vi.mock('../../../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => ({
		registerLayer: vi.fn(() => 'mock-layer-id'),
		unregisterLayer: vi.fn(),
		updateLayerHandler: vi.fn(),
	}),
	LayerStackProvider: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

// The canvas is not what this exercises, and jsdom cannot paint it.
vi.mock('../../../../renderer/components/DocumentGraph/MindMap', () => ({
	MindMap: () => <div data-testid="mind-map-mock" />,
	convertToMindMapData: () => ({ nodes: [], links: [] }),
}));

vi.mock('../../../../renderer/components/DocumentGraph/graphDataBuilder', () => ({
	buildGraphData: vi.fn().mockResolvedValue({
		nodes: [],
		edges: [],
		totalDocuments: 0,
		loadedDocuments: 0,
		hasMore: false,
		cachedExternalData: { externalNodes: [], externalEdges: [], domainCount: 0, totalLinkCount: 0 },
		internalLinkCount: 0,
		allMarkdownFiles: [],
		orphanFiles: [],
		centerFile: '/test/index.md',
		backlinksLoading: false,
		startBacklinkScan: vi.fn().mockReturnValue(() => {}),
	}),
	isDocumentNode: (data: any) => data?.nodeType === 'document',
	isExternalLinkNode: (data: any) => data?.nodeType === 'external',
}));

const safeClipboardWriteImage = vi.fn().mockResolvedValue(true);
vi.mock('../../../../renderer/utils/clipboard', () => ({
	safeClipboardWrite: vi.fn().mockResolvedValue(true),
	safeClipboardWriteImage: (dataUrl: string) => safeClipboardWriteImage(dataUrl),
}));

const saveImageDataUrlToDisk = vi.fn().mockResolvedValue({ saved: true, path: '/tmp/graph.png' });
vi.mock('../../../../renderer/utils/imageExport', () => ({
	saveImageDataUrlToDisk: (dataUrl: string, name?: string) => saveImageDataUrlToDisk(dataUrl, name),
}));

import { DocumentGraphView } from '../../../../renderer/components/DocumentGraph/DocumentGraphView';
import type { Theme } from '../../../../renderer/types';

const theme = {
	id: 'test',
	name: 'Test',
	mode: 'dark',
	colors: {
		bgMain: '#000',
		bgSidebar: '#111',
		bgActivity: '#222',
		border: '#333',
		textMain: '#fff',
		textDim: '#888',
		accent: '#00f',
		accentDim: '#008',
		accentText: '#0ff',
		accentForeground: '#fff',
		success: '#0f0',
		warning: '#ff0',
		error: '#f00',
	},
} as unknown as Theme;

function renderGraph() {
	return render(
		<DocumentGraphView
			isOpen
			onClose={vi.fn()}
			theme={theme}
			rootPath="/test"
			focusFilePath="/test/index.md"
		/>
	);
}

const CAPTURED = 'data:image/png;base64,AAA';

describe('graph screenshot', () => {
	let capturePage: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.clearAllMocks();
		safeClipboardWriteImage.mockResolvedValue(true);
		saveImageDataUrlToDisk.mockResolvedValue({ saved: true, path: '/tmp/graph.png' });
		capturePage = vi.fn().mockResolvedValue(CAPTURED);
		(window as any).maestro.shell.capturePage = capturePage;
		// Not in the shared setup mock, and the view starts a watcher on mount.
		(window as any).maestro.documentGraph = {
			watchFolder: vi.fn().mockResolvedValue(undefined),
			unwatchFolder: vi.fn().mockResolvedValue(undefined),
			onFilesChanged: vi.fn().mockReturnValue(() => {}),
		};
		// jsdom reports every element as zero-sized, and a zero-area rect is
		// refused on purpose, so give the graph container a real box.
		vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
			x: 12,
			y: 34,
			left: 12,
			top: 34,
			width: 800,
			height: 600,
			right: 812,
			bottom: 634,
			toJSON: () => ({}),
		} as DOMRect);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		delete (window as any).maestro.shell.capturePage;
	});

	it('hides the camera when the bridge cannot capture the page', async () => {
		delete (window as any).maestro.shell.capturePage;
		renderGraph();
		// The camera lives in the footer, so wait for a sibling control to prove
		// the footer rendered before concluding the camera is absent.
		await screen.findByTestId('document-graph-scroll-mode-toggle');
		expect(screen.queryByTestId('graph-screenshot-button')).toBeNull();
	});

	it('copies the captured graph and dismisses the chooser before shooting', async () => {
		renderGraph();
		await waitFor(() => expect(screen.getByTestId('graph-screenshot-button')).toBeInTheDocument());

		fireEvent.click(screen.getByTestId('graph-screenshot-button'));
		const copy = await screen.findByText('Copy to Clipboard');
		fireEvent.click(copy);

		await waitFor(() => expect(safeClipboardWriteImage).toHaveBeenCalledWith(CAPTURED));
		// The dialog is gone by the time the capture runs, or it would be in the shot.
		expect(screen.queryByText('Copy to Clipboard')).toBeNull();
		expect(capturePage).toHaveBeenCalledWith({ x: 12, y: 34, width: 800, height: 600 });
	});

	it('writes a timestamped PNG when asked to save', async () => {
		renderGraph();
		await waitFor(() => expect(screen.getByTestId('graph-screenshot-button')).toBeInTheDocument());

		fireEvent.click(screen.getByTestId('graph-screenshot-button'));
		fireEvent.click(await screen.findByText('Save to Disk'));

		await waitFor(() => expect(saveImageDataUrlToDisk).toHaveBeenCalled());
		const [dataUrl, name] = saveImageDataUrlToDisk.mock.calls[0];
		expect(dataUrl).toBe(CAPTURED);
		expect(name).toMatch(/^graph-\d{8}-\d{6}\.png$/);
	});

	it('opens the same chooser from C, the way the other graph controls have keys', async () => {
		renderGraph();
		await waitFor(() => expect(screen.getByTestId('graph-screenshot-button')).toBeInTheDocument());

		fireEvent.keyDown(screen.getByRole('dialog'), { key: 'c' });

		expect(await screen.findByText('Copy to Clipboard')).toBeInTheDocument();
	});
});
