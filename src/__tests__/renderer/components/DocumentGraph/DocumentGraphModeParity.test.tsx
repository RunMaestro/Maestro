/**
 * The Document Graph reads the agent's own disk in every mode (docs/parity/agent-ux-parity.md).
 *
 * A local agent's graph reads this machine, an SSH or hosted agent's graph reads its remote, and
 * the screen is the same. An SSH agent whose remote is not resolved yet must not fall back to this
 * machine's disk: the graph reads nothing and shows the words a file operation shows.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../../../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => ({
		registerLayer: vi.fn(() => 'mock-layer-id'),
		unregisterLayer: vi.fn(),
		updateLayerHandler: vi.fn(),
	}),
	LayerStackProvider: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

const mindMapNodes = vi.hoisted(() => ({ current: [] as unknown[] }));
vi.mock('../../../../renderer/components/DocumentGraph/MindMap', () => ({
	MindMap: ({ onNodePreview }: { onNodePreview: (node: unknown) => void }) => (
		<button
			data-testid="mind-map-mock"
			onClick={() => onNodePreview({ nodeType: 'document', filePath: 'a.md' })}
		/>
	),
	convertToMindMapData: () => ({ nodes: mindMapNodes.current, links: [] }),
}));

// The preview's markdown: a link inside it, which reads the linked document.
vi.mock('../../../../renderer/components/MarkdownRenderer', () => ({
	MarkdownRenderer: ({ onFileClick }: { onFileClick: (path: string) => void }) => (
		<button data-testid="preview-link" onClick={() => onFileClick('b.md')} />
	),
}));

const buildGraphData = vi.fn();
vi.mock('../../../../renderer/components/DocumentGraph/graphDataBuilder', () => ({
	buildGraphData: (options: unknown) => buildGraphData(options),
	isDocumentNode: (data: any) => data?.nodeType === 'document',
	isExternalLinkNode: (data: any) => data?.nodeType === 'external',
}));

import { DocumentGraphView } from '../../../../renderer/components/DocumentGraph/DocumentGraphView';
import {
	pathPickerRemoteId,
	UNRESOLVED_REMOTE_MESSAGE,
} from '../../../../renderer/services/pathPicker';
import { AGENT_MODES, createModeSession } from '../../../helpers';
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

const EMPTY_GRAPH = {
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
};

function renderGraph(sshRemoteId: string | null | undefined) {
	return render(
		<DocumentGraphView
			isOpen
			onClose={vi.fn()}
			theme={theme}
			rootPath="/test"
			focusFilePath="/test/index.md"
			sshRemoteId={sshRemoteId}
		/>
	);
}

describe('Document Graph across agent modes', () => {
	beforeEach(() => {
		mindMapNodes.current = [];
		buildGraphData.mockReset();
		buildGraphData.mockResolvedValue(EMPTY_GRAPH);
		(window as any).maestro.documentGraph = {
			watchFolder: vi.fn().mockResolvedValue(undefined),
			unwatchFolder: vi.fn().mockResolvedValue(undefined),
			onFilesChanged: vi.fn().mockReturnValue(() => {}),
		};
	});

	it.each(AGENT_MODES)(
		'builds the %s agent graph from that agent disk, with the same screen',
		async (mode) => {
			const { container, unmount } = renderGraph(pathPickerRemoteId(createModeSession(mode)));
			await waitFor(() => expect(buildGraphData).toHaveBeenCalledTimes(1));
			expect(buildGraphData.mock.calls[0][0].sshRemoteId).toBe(mode === 'local' ? undefined : 'r1');
			await screen.findByTestId('document-graph-scroll-mode-toggle');
			expect(screen.queryByText(UNRESOLVED_REMOTE_MESSAGE)).toBeNull();
			expect(container.querySelectorAll('button').length).toBeGreaterThan(0);
			unmount();
		}
	);

	it('draws the same controls for a local, an SSH, and a hosted agent', async () => {
		const labels: string[][] = [];
		for (const mode of AGENT_MODES) {
			const { container, unmount } = renderGraph(pathPickerRemoteId(createModeSession(mode)));
			await screen.findByTestId('document-graph-scroll-mode-toggle');
			labels.push(
				Array.from(container.ownerDocument.querySelectorAll('button')).map(
					(b) => b.getAttribute('aria-label') || b.textContent || ''
				)
			);
			unmount();
		}
		expect(labels[1]).toEqual(labels[0]);
		expect(labels[2]).toEqual(labels[0]);
	});

	it('reads nothing and says the remote is not set for an SSH agent with no remote resolved', async () => {
		const unresolved = createModeSession('ssh', {
			sshRemoteId: undefined,
			sessionSshRemoteConfig: { enabled: true, remoteId: null },
		} as any);
		expect(pathPickerRemoteId(unresolved)).toBeNull();

		renderGraph(pathPickerRemoteId(unresolved));

		expect(await screen.findByText(UNRESOLVED_REMOTE_MESSAGE)).toBeInTheDocument();
		expect(buildGraphData).not.toHaveBeenCalled();
	});

	it('reads a link inside a preview from the remote and root that preview came from', async () => {
		mindMapNodes.current = [{ id: 'a.md', nodeType: 'document', filePath: 'a.md' }];
		const readFile = vi.fn().mockResolvedValue('# Doc');
		(window as any).maestro.fs = { ...(window as any).maestro.fs, readFile };
		const view = (sshRemoteId: string, rootPath = '/test') => (
			<DocumentGraphView
				isOpen
				onClose={vi.fn()}
				theme={theme}
				rootPath={rootPath}
				focusFilePath="/test/index.md"
				sshRemoteId={sshRemoteId}
			/>
		);
		const { rerender } = render(view('r1'));
		fireEvent.click(await screen.findByTestId('mind-map-mock'));
		await waitFor(() => expect(readFile).toHaveBeenCalledWith('/test/a.md', 'r1'));

		// The agent's remote and root change while the preview of r1's document stays open.
		rerender(view('r2', '/other'));
		fireEvent.click(await screen.findByTestId('preview-link'));

		await waitFor(() => expect(readFile).toHaveBeenCalledTimes(2));
		expect(readFile).toHaveBeenLastCalledWith('/test/b.md', 'r1');
	});
});
