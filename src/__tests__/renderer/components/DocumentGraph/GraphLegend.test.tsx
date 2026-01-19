/**
 * Tests for the GraphLegend component
 *
 * The GraphLegend displays a sliding panel explaining node types, edge types,
 * keyboard shortcuts, and interaction hints in the Document Graph visualization.
 *
 * The panel is always shown (no collapsed state) and can be closed via onClose callback.
 */

import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import {
	GraphLegend,
	type GraphLegendProps,
} from '../../../../renderer/components/DocumentGraph/GraphLegend';
import type { Theme } from '../../../../renderer/types';

// Mock theme for testing
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
			expect(within(connectionTypesSection!).queryByText('External Link')).not.toBeInTheDocument();
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

		it('displays enter shortcut', () => {
			render(<GraphLegend {...defaultProps} />);

			expect(screen.getByText('Enter')).toBeInTheDocument();
			expect(screen.getByText('Recenter on focused node')).toBeInTheDocument();
		});

		it('displays open shortcut', () => {
			render(<GraphLegend {...defaultProps} />);

			expect(screen.getByText('O')).toBeInTheDocument();
			expect(screen.getByText('Open file in preview')).toBeInTheDocument();
		});

		it('displays search shortcut', () => {
			render(<GraphLegend {...defaultProps} />);

			expect(screen.getByText('⌘F')).toBeInTheDocument();
			expect(screen.getByText('Focus search')).toBeInTheDocument();
		});

		it('displays escape shortcut', () => {
			render(<GraphLegend {...defaultProps} />);

			expect(screen.getByText('Esc')).toBeInTheDocument();
			expect(screen.getByText('Close panel / modal')).toBeInTheDocument();
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
});
