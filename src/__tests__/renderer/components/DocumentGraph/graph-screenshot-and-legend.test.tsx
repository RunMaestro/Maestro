// Source: src/__tests__/renderer/components/DocumentGraph/graph-screenshot.test.tsx
// Source: src/__tests__/renderer/components/DocumentGraph/GraphLegend.test.tsx
import { describe as describeSourceSuite } from 'vitest';
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { vi } from 'vitest';
import { beforeEach } from 'vitest';
import { afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { screen } from '@testing-library/react';
import { waitFor } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import { DocumentGraphView } from '../../../../renderer/components/DocumentGraph/DocumentGraphView';
import type { Theme } from '../../../../renderer/types';
import { getShortcutKeys } from '../../../helpers/shortcutKeys';
import React from 'react';
import { within } from '@testing-library/react';
import { GraphLegend } from '../../../../renderer/components/DocumentGraph/GraphLegend';
import type { GraphLegendProps } from '../../../../renderer/components/DocumentGraph/GraphLegend';
import { mockTheme } from '../../../helpers/mockTheme';
vi.mock('../../../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => ({
		registerLayer: vi.fn(() => 'mock-layer-id'),
		unregisterLayer: vi.fn(),
		updateLayerHandler: vi.fn(),
	}),
	LayerStackProvider: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));
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
vi.mock('../../../../renderer/utils/clipboard', () => ({
	safeClipboardWrite: vi.fn().mockResolvedValue(true),
	safeClipboardWriteImage: (dataUrl: string) => safeClipboardWriteImage(dataUrl),
}));
vi.mock('../../../../renderer/utils/imageExport', () => ({
	saveImageDataUrlToDisk: (dataUrl: string, name?: string) => saveImageDataUrlToDisk(dataUrl, name),
}));
const safeClipboardWriteImage = vi.fn().mockResolvedValue(true);
const saveImageDataUrlToDisk = vi.fn().mockResolvedValue({ saved: true, path: '/tmp/graph.png' });

describeSourceSuite('graph-screenshot', () => {
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
			await waitFor(() =>
				expect(screen.getByTestId('graph-screenshot-button')).toBeInTheDocument()
			);

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
			await waitFor(() =>
				expect(screen.getByTestId('graph-screenshot-button')).toBeInTheDocument()
			);

			fireEvent.click(screen.getByTestId('graph-screenshot-button'));
			fireEvent.click(await screen.findByText('Save to Disk'));

			await waitFor(() => expect(saveImageDataUrlToDisk).toHaveBeenCalled());
			const [dataUrl, name] = saveImageDataUrlToDisk.mock.calls[0];
			expect(dataUrl).toBe(CAPTURED);
			expect(name).toMatch(/^graph-\d{8}-\d{6}\.png$/);
		});

		it('opens the same chooser from C, the way the other graph controls have keys', async () => {
			renderGraph();
			await waitFor(() =>
				expect(screen.getByTestId('graph-screenshot-button')).toBeInTheDocument()
			);

			fireEvent.keyDown(screen.getByRole('dialog'), { key: 'c' });

			expect(await screen.findByText('Copy to Clipboard')).toBeInTheDocument();
		});
	});
});
describeSourceSuite('GraphLegend', () => {
	// Mock theme for testing

	// Light theme for theme testing
	const lightTheme: Theme = {
		...mockTheme,
		id: 'light',
		name: 'Light',
		mode: 'light',
		colors: {
			...mockTheme.colors,
			bgMain: '#ffffff',
			bgSidebar: '#f5f5f5',
			bgActivity: '#fafafa',
			border: '#e5e5e5',
			textMain: '#1a1a1a',
			textDim: '#666666',
			accent: '#6366f1',
		},
	};

	// Default props for testing
	const defaultProps: GraphLegendProps = {
		theme: mockTheme,
		showExternalLinks: true,
		scrollMode: 'zoom',
		onScrollModeChange: vi.fn(),
		onClose: vi.fn(),
	};

	describe('GraphLegend', () => {
		describe('Rendering', () => {
			it('renders as a sliding panel with Help heading', () => {
				render(<GraphLegend {...defaultProps} />);

				// Should show the Help heading
				expect(screen.getByText('Help')).toBeInTheDocument();

				// Should show all content sections
				expect(screen.getByText('Node Types')).toBeInTheDocument();
				expect(screen.getByText('Connection Types')).toBeInTheDocument();
				expect(screen.getByText('Selection')).toBeInTheDocument();
			});

			it('has correct aria label on the panel', () => {
				render(<GraphLegend {...defaultProps} />);

				const panel = screen.getByRole('region', { name: /help panel/i });
				expect(panel).toBeInTheDocument();
			});

			it('renders all node types when showExternalLinks is true', () => {
				render(<GraphLegend {...defaultProps} showExternalLinks />);

				expect(screen.getByText('Document')).toBeInTheDocument();
				// External Link appears in both Node Types and Connection Types sections
				const externalLinks = screen.getAllByText('External Link');
				expect(externalLinks.length).toBeGreaterThanOrEqual(1);
			});

			it('hides external node type when showExternalLinks is false', () => {
				render(<GraphLegend {...defaultProps} showExternalLinks={false} />);

				expect(screen.getByText('Document')).toBeInTheDocument();
				// External Link should appear once in "Connection Types" section for edges
				// but not in "Node Types" section
				const nodeTypesSection = screen.getByText('Node Types').parentElement;
				expect(within(nodeTypesSection!).queryByText('External Link')).not.toBeInTheDocument();
			});

			it('renders all edge types when showExternalLinks is true', () => {
				render(<GraphLegend {...defaultProps} showExternalLinks />);

				expect(screen.getByText('Internal Link')).toBeInTheDocument();
				// External Link appears in both Node Types and Connection Types sections
				expect(screen.getAllByText('External Link').length).toBe(2);
			});

			it('hides external edge type when showExternalLinks is false', () => {
				render(<GraphLegend {...defaultProps} showExternalLinks={false} />);

				expect(screen.getByText('Internal Link')).toBeInTheDocument();
				// External Link edge type should not be shown
				const connectionTypesSection = screen.getByText('Connection Types').parentElement;
				expect(
					within(connectionTypesSection!).queryByText('External Link')
				).not.toBeInTheDocument();
			});
		});

		describe('Close Button', () => {
			it('renders close button with correct title', () => {
				render(<GraphLegend {...defaultProps} />);

				const closeButton = screen.getByTitle('Close (Esc)');
				expect(closeButton).toBeInTheDocument();
			});

			it('calls onClose when close button is clicked', () => {
				const onClose = vi.fn();
				render(<GraphLegend {...defaultProps} onClose={onClose} />);

				const closeButton = screen.getByTitle('Close (Esc)');
				fireEvent.click(closeButton);

				expect(onClose).toHaveBeenCalledOnce();
			});
		});

		describe('Keyboard Shortcuts Section', () => {
			it('shows keyboard shortcuts section', () => {
				render(<GraphLegend {...defaultProps} />);

				expect(screen.getByText('Keyboard Shortcuts')).toBeInTheDocument();
			});

			it('displays navigation shortcut', () => {
				render(<GraphLegend {...defaultProps} />);

				expect(screen.getByText('↑ ↓ ← →')).toBeInTheDocument();
				expect(screen.getByText('Navigate between nodes')).toBeInTheDocument();
			});

			it('displays space shortcut', () => {
				render(<GraphLegend {...defaultProps} />);

				expect(screen.getByText('Space')).toBeInTheDocument();
				expect(screen.getByText('Focus node in graph')).toBeInTheDocument();
			});

			it('displays enter shortcut', () => {
				render(<GraphLegend {...defaultProps} />);

				expect(screen.getByText('Enter')).toBeInTheDocument();
				expect(screen.getByText('Preview document in-graph')).toBeInTheDocument();
			});

			it('displays open shortcut', () => {
				render(<GraphLegend {...defaultProps} />);

				expect(screen.getByText('O')).toBeInTheDocument();
				expect(screen.getByText('Open in main preview')).toBeInTheDocument();
			});

			it('displays escape shortcut', () => {
				render(<GraphLegend {...defaultProps} />);

				expect(screen.getByText('Esc')).toBeInTheDocument();
				expect(screen.getByText('Close preview / modal')).toBeInTheDocument();
			});

			it('displays search shortcut', () => {
				render(<GraphLegend {...defaultProps} />);

				expect(getShortcutKeys(['Meta', 'f'])).toBeInTheDocument();
				expect(screen.getByText('Focus search')).toBeInTheDocument();
			});

			it('displays the preview-length shortcut', () => {
				// P used to duplicate Enter; the legend is where a user finds out it
				// now cycles preview length instead.
				render(<GraphLegend {...defaultProps} />);

				expect(screen.getByText('P')).toBeInTheDocument();
				expect(screen.getByText('Cycle preview length (ends at Off)')).toBeInTheDocument();
			});
		});

		describe('Mouse Actions Section', () => {
			it('shows mouse actions section', () => {
				render(<GraphLegend {...defaultProps} />);

				expect(screen.getByText('Mouse Actions')).toBeInTheDocument();
			});

			it('displays click action', () => {
				render(<GraphLegend {...defaultProps} />);

				expect(screen.getByText('Click')).toBeInTheDocument();
				expect(screen.getByText('Select node')).toBeInTheDocument();
			});

			it('displays double-click action', () => {
				render(<GraphLegend {...defaultProps} />);

				expect(screen.getByText('Double-click')).toBeInTheDocument();
				expect(screen.getByText('Recenter view')).toBeInTheDocument();
			});

			it('displays right-click action', () => {
				render(<GraphLegend {...defaultProps} />);

				expect(screen.getByText('Right-click')).toBeInTheDocument();
				expect(screen.getByText('Context menu')).toBeInTheDocument();
			});

			it('displays drag action', () => {
				render(<GraphLegend {...defaultProps} />);

				expect(screen.getByText('Drag')).toBeInTheDocument();
				expect(screen.getByText('Reposition node')).toBeInTheDocument();
			});

			it('displays scroll action', () => {
				render(<GraphLegend {...defaultProps} />);

				expect(screen.getByText('Scroll')).toBeInTheDocument();
				expect(screen.getByText('Zoom in/out')).toBeInTheDocument();
			});
		});

		describe('Selection Section', () => {
			it('shows selection section', () => {
				render(<GraphLegend {...defaultProps} />);

				expect(screen.getByText('Selection')).toBeInTheDocument();
			});

			it('displays selected node info', () => {
				render(<GraphLegend {...defaultProps} />);

				expect(screen.getByText('Selected Node')).toBeInTheDocument();
				expect(screen.getByText('Click or navigate to select')).toBeInTheDocument();
			});

			it('displays connected edge info', () => {
				render(<GraphLegend {...defaultProps} />);

				expect(screen.getByText('Connected Edge')).toBeInTheDocument();
				expect(screen.getByText('Edges to/from selected node')).toBeInTheDocument();
			});
		});

		describe('Status Indicators Section', () => {
			it('shows status indicators section', () => {
				render(<GraphLegend {...defaultProps} />);

				expect(screen.getByText('Status Indicators')).toBeInTheDocument();
			});

			it('displays broken links indicator', () => {
				render(<GraphLegend {...defaultProps} />);

				expect(screen.getByText('Broken Links')).toBeInTheDocument();
				expect(screen.getByText('Links to non-existent files')).toBeInTheDocument();
			});

			it('has accessible broken links indicator icon', () => {
				render(<GraphLegend {...defaultProps} />);

				const indicator = screen.getByRole('img', { name: /broken links warning indicator/i });
				expect(indicator).toBeInTheDocument();
			});
		});

		describe('Node Preview Icons', () => {
			it('renders document node preview with aria-label', () => {
				render(<GraphLegend {...defaultProps} />);

				const docPreviews = screen.getAllByRole('img', { name: /document node card/i });
				expect(docPreviews.length).toBeGreaterThanOrEqual(1);
			});

			it('renders external link node preview when showExternalLinks is true', () => {
				render(<GraphLegend {...defaultProps} showExternalLinks />);

				const extPreviews = screen.getAllByRole('img', { name: /external link node pill/i });
				expect(extPreviews.length).toBeGreaterThanOrEqual(1);
			});

			it('does not render external link node preview when showExternalLinks is false', () => {
				render(<GraphLegend {...defaultProps} showExternalLinks={false} />);

				expect(
					screen.queryByRole('img', { name: /external link node pill/i })
				).not.toBeInTheDocument();
			});

			it('renders selected document node preview', () => {
				render(<GraphLegend {...defaultProps} />);

				// Selected node preview has (selected) in aria-label
				const selectedPreviews = screen.getAllByRole('img', {
					name: /document node card \(selected\)/i,
				});
				expect(selectedPreviews.length).toBeGreaterThanOrEqual(1);
			});
		});

		describe('Edge Preview Icons', () => {
			it('renders internal link edge preview', () => {
				render(<GraphLegend {...defaultProps} />);

				const internalEdges = screen.getAllByRole('img', { name: /internal link edge/i });
				expect(internalEdges.length).toBeGreaterThanOrEqual(1);
			});

			it('renders external link edge preview when showExternalLinks is true', () => {
				render(<GraphLegend {...defaultProps} showExternalLinks />);

				const externalEdges = screen.getAllByRole('img', { name: /external link edge/i });
				expect(externalEdges.length).toBeGreaterThanOrEqual(1);
			});

			it('does not render external link edge preview when showExternalLinks is false', () => {
				render(<GraphLegend {...defaultProps} showExternalLinks={false} />);

				expect(screen.queryByRole('img', { name: /external link edge/i })).not.toBeInTheDocument();
			});

			it('renders highlighted edge preview for connected edges', () => {
				render(<GraphLegend {...defaultProps} />);

				// Highlighted edge preview has (highlighted) in aria-label
				const highlightedEdges = screen.getAllByRole('img', { name: /link edge \(highlighted\)/i });
				expect(highlightedEdges.length).toBeGreaterThanOrEqual(1);
			});
		});

		describe('Theme Integration', () => {
			it('applies theme background color to panel', () => {
				const { container } = render(<GraphLegend {...defaultProps} />);

				const panel = container.querySelector('.graph-legend');
				expect(panel).toHaveStyle({ backgroundColor: mockTheme.colors.bgActivity });
			});

			it('applies theme border color', () => {
				const { container } = render(<GraphLegend {...defaultProps} />);

				const panel = container.querySelector('.graph-legend');
				expect(panel).toHaveStyle({ borderRight: `1px solid ${mockTheme.colors.border}` });
			});

			it('applies theme text color to heading', () => {
				render(<GraphLegend {...defaultProps} />);

				const heading = screen.getByText('Help');
				expect(heading).toHaveStyle({ color: mockTheme.colors.textMain });
			});

			it('applies theme dim text color to section headers', () => {
				render(<GraphLegend {...defaultProps} />);

				const nodeTypesHeader = screen.getByText('Node Types');
				expect(nodeTypesHeader).toHaveStyle({ color: mockTheme.colors.textDim });
			});

			it('works with light theme', () => {
				render(<GraphLegend {...defaultProps} theme={lightTheme} />);

				const heading = screen.getByText('Help');
				expect(heading).toHaveStyle({ color: lightTheme.colors.textMain });
			});
		});

		describe('Dynamic Content', () => {
			it('updates when showExternalLinks prop changes', () => {
				const { rerender } = render(<GraphLegend {...defaultProps} showExternalLinks />);

				// Initially showing external links
				expect(screen.getAllByText('External Link').length).toBe(2);

				// Rerender with external links disabled
				rerender(<GraphLegend {...defaultProps} showExternalLinks={false} />);

				// External Link should no longer appear
				expect(screen.queryByText('External Link')).not.toBeInTheDocument();
			});
		});

		describe('Panel Layout', () => {
			it('has correct width', () => {
				const { container } = render(<GraphLegend {...defaultProps} />);

				const panel = container.querySelector('.graph-legend');
				expect(panel).toHaveStyle({ width: '280px' });
			});

			it('has correct z-index', () => {
				const { container } = render(<GraphLegend {...defaultProps} />);

				const panel = container.querySelector('.graph-legend');
				expect(panel).toHaveStyle({ zIndex: 20 });
			});

			it('is positioned at top-left', () => {
				const { container } = render(<GraphLegend {...defaultProps} />);

				const panel = container.querySelector('.graph-legend');
				expect(panel).toHaveClass('top-0', 'left-0');
			});

			it('has animation class for slide-in effect', () => {
				const { container } = render(<GraphLegend {...defaultProps} />);

				const panel = container.querySelector('.graph-legend');
				expect(panel).toHaveClass('animate-in', 'slide-in-from-left');
			});
		});

		describe('Content Organization', () => {
			it('displays sections in correct order', () => {
				const { container } = render(<GraphLegend {...defaultProps} />);

				const sections = container.querySelectorAll('h4');
				const sectionTexts = Array.from(sections).map((s) => s.textContent);

				expect(sectionTexts).toEqual([
					'Node Types',
					'Connection Types',
					'Selection',
					'Status Indicators',
					'Keyboard Shortcuts',
					'Mouse Actions',
				]);
			});
		});

		describe('Scroll mode toggle', () => {
			it('offers both modes as an inline segmented control', () => {
				render(<GraphLegend {...defaultProps} />);

				expect(screen.getByTestId('graph-legend-scroll-mode-zoom')).toBeInTheDocument();
				expect(screen.getByTestId('graph-legend-scroll-mode-pan')).toBeInTheDocument();
				expect(screen.getByRole('radiogroup', { name: 'Scroll wheel action' })).toBeInTheDocument();
			});

			it('marks the active mode, so the panel says which binding is live', () => {
				const { rerender } = render(<GraphLegend {...defaultProps} scrollMode="zoom" />);
				expect(screen.getByTestId('graph-legend-scroll-mode-zoom')).toHaveAttribute(
					'aria-checked',
					'true'
				);
				expect(screen.getByTestId('graph-legend-scroll-mode-pan')).toHaveAttribute(
					'aria-checked',
					'false'
				);

				rerender(<GraphLegend {...defaultProps} scrollMode="pan" />);
				expect(screen.getByTestId('graph-legend-scroll-mode-pan')).toHaveAttribute(
					'aria-checked',
					'true'
				);
			});

			it('names a destination rather than toggling', () => {
				// Clicking the mode already active must be a no-op, not a flip - a
				// segmented control that toggles undoes itself on a second click.
				const onScrollModeChange = vi.fn();
				render(
					<GraphLegend
						{...defaultProps}
						scrollMode="zoom"
						onScrollModeChange={onScrollModeChange}
					/>
				);

				fireEvent.click(screen.getByTestId('graph-legend-scroll-mode-pan'));
				expect(onScrollModeChange).toHaveBeenCalledWith('pan');

				fireEvent.click(screen.getByTestId('graph-legend-scroll-mode-zoom'));
				expect(onScrollModeChange).toHaveBeenLastCalledWith('zoom');
			});

			it('rewrites the Mouse Actions lines to match the live mode', () => {
				// The panel described Scroll as "Zoom in/out" unconditionally, which
				// is a lie in pan mode - and this is the section the user reads to
				// find out what the wheel does.
				const { rerender } = render(<GraphLegend {...defaultProps} scrollMode="zoom" />);
				expect(screen.getByText('Zoom in/out')).toBeInTheDocument();
				expect(screen.getByText('Pan the canvas')).toBeInTheDocument();

				rerender(<GraphLegend {...defaultProps} scrollMode="pan" />);
				const scrollRow = screen.getByText('Scroll').parentElement!;
				expect(within(scrollRow).getByText('Pan the canvas')).toBeInTheDocument();
				const shiftRow = screen.getByText('Shift+Scroll').parentElement!;
				expect(within(shiftRow).getByText('Zoom in/out')).toBeInTheDocument();
			});

			it('documents the S shortcut alongside the other single-key controls', () => {
				render(<GraphLegend {...defaultProps} />);
				expect(screen.getByText('Switch scroll between zoom and pan')).toBeInTheDocument();
			});
		});
	});
});
