/**
 * Tests for the ExternalLinkNode React Flow custom node component
 */

import { describe, it, expect } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { ReactFlowProvider } from 'reactflow';
import {
	ExternalLinkNode,
	type ExternalLinkNodeProps,
} from '../../../../renderer/components/DocumentGraph/ExternalLinkNode';
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

// Helper to create node props
function createNodeProps(
	overrides: Partial<ExternalLinkNodeProps['data']> = {}
): ExternalLinkNodeProps {
	return {
		id: 'test-external-1',
		type: 'externalLinkNode',
		data: {
			nodeType: 'external',
			domain: 'example.com',
			linkCount: 1,
			urls: ['https://example.com/page'],
			theme: mockTheme,
			...overrides,
		},
		selected: false,
		isConnectable: true,
		xPos: 0,
		yPos: 0,
		zIndex: 0,
		dragging: false,
	} as ExternalLinkNodeProps;
}

// Wrapper component for React Flow context
function renderWithProvider(ui: React.ReactElement) {
	return render(<ReactFlowProvider>{ui}</ReactFlowProvider>);
}

describe('ExternalLinkNode', () => {
	describe('Basic Rendering', () => {
		it('renders the domain name', () => {
			const props = createNodeProps({ domain: 'github.com' });
			renderWithProvider(<ExternalLinkNode {...props} />);

			expect(screen.getByText('github.com')).toBeInTheDocument();
		});

		it('renders domain without www prefix', () => {
			const props = createNodeProps({ domain: 'mozilla.org' });
			renderWithProvider(<ExternalLinkNode {...props} />);

			expect(screen.getByText('mozilla.org')).toBeInTheDocument();
		});

		it('renders globe icon', () => {
			const props = createNodeProps();
			const { container } = renderWithProvider(<ExternalLinkNode {...props} />);

			// Lucide icons render as SVG elements
			const svgs = container.querySelectorAll('svg');
			expect(svgs.length).toBeGreaterThan(0);
		});
	});

	describe('Link Count Badge', () => {
		it('shows badge when linkCount is greater than 1', () => {
			const props = createNodeProps({ linkCount: 5 });
			renderWithProvider(<ExternalLinkNode {...props} />);

			expect(screen.getByText('5')).toBeInTheDocument();
		});

		it('does not show badge when linkCount is 1', () => {
			const props = createNodeProps({ linkCount: 1 });
			renderWithProvider(<ExternalLinkNode {...props} />);

			// Should not find a "1" badge
			expect(screen.queryByText('1')).not.toBeInTheDocument();
		});

		it('badge has tooltip with count info', () => {
			const props = createNodeProps({ linkCount: 3 });
			const { container } = renderWithProvider(<ExternalLinkNode {...props} />);

			const badge = container.querySelector('[title="3 links to this domain"]');
			expect(badge).toBeInTheDocument();
		});
	});

	describe('URL Tooltip', () => {
		it('shows single URL as tooltip when only one URL', () => {
			const props = createNodeProps({
				urls: ['https://example.com/docs/guide'],
			});
			const { container } = renderWithProvider(<ExternalLinkNode {...props} />);

			const node = container.querySelector('.external-link-node');
			expect(node).toHaveAttribute('title', 'https://example.com/docs/guide');
		});

		it('shows all URLs in tooltip when multiple URLs', () => {
			const props = createNodeProps({
				urls: [
					'https://example.com/page1',
					'https://example.com/page2',
					'https://example.com/page3',
				],
				linkCount: 3,
			});
			const { container } = renderWithProvider(<ExternalLinkNode {...props} />);

			const node = container.querySelector('.external-link-node');
			const expectedTooltip =
				'https://example.com/page1\nhttps://example.com/page2\nhttps://example.com/page3';
			expect(node).toHaveAttribute('title', expectedTooltip);
		});
	});

	describe('Selection State', () => {
		it('applies accent border when selected', () => {
			const props = createNodeProps();
			const selectedProps = { ...props, selected: true };

			const { container } = renderWithProvider(<ExternalLinkNode {...selectedProps} />);

			const nodeElement = container.querySelector('.external-link-node');
			expect(nodeElement).toHaveStyle({ borderColor: mockTheme.colors.accent });
		});

		it('applies default border when not selected', () => {
			const props = createNodeProps();

			const { container } = renderWithProvider(<ExternalLinkNode {...props} />);

			const nodeElement = container.querySelector('.external-link-node');
			expect(nodeElement).toHaveStyle({ borderColor: mockTheme.colors.border });
		});

		it('applies thicker border when selected', () => {
			const props = createNodeProps();
			const selectedProps = { ...props, selected: true };

			const { container } = renderWithProvider(<ExternalLinkNode {...selectedProps} />);

			const nodeElement = container.querySelector('.external-link-node');
			expect(nodeElement).toHaveStyle({ borderWidth: '2px' });
		});
	});

	describe('Dashed Border Style', () => {
		it('uses dashed border to distinguish from document nodes', () => {
			const props = createNodeProps();

			const { container } = renderWithProvider(<ExternalLinkNode {...props} />);

			const nodeElement = container.querySelector('.external-link-node');
			expect(nodeElement).toHaveStyle({ borderStyle: 'dashed' });
		});
	});

	describe('Theme Integration', () => {
		it('uses theme bgSidebar color for background', () => {
			const props = createNodeProps();

			const { container } = renderWithProvider(<ExternalLinkNode {...props} />);

			const nodeElement = container.querySelector('.external-link-node');
			expect(nodeElement).toHaveStyle({
				backgroundColor: mockTheme.colors.bgSidebar,
			});
		});

		it('uses accent color for badge background', () => {
			const props = createNodeProps({ linkCount: 2 });

			const { container } = renderWithProvider(<ExternalLinkNode {...props} />);

			const badge = container.querySelector('[title="2 links to this domain"]');
			expect(badge).toHaveStyle({
				backgroundColor: mockTheme.colors.accent,
			});
		});

		it('works with light theme colors', () => {
			const lightTheme: Theme = {
				id: 'github-light',
				name: 'GitHub',
				mode: 'light',
				colors: {
					bgMain: '#ffffff',
					bgSidebar: '#f6f8fa',
					bgActivity: '#eff2f5',
					border: '#d0d7de',
					textMain: '#24292f',
					textDim: '#57606a',
					accent: '#0969da',
					accentDim: 'rgba(9, 105, 218, 0.1)',
					accentText: '#0969da',
					accentForeground: '#ffffff',
					success: '#1a7f37',
					warning: '#9a6700',
					error: '#cf222e',
				},
			};

			const props = createNodeProps({ theme: lightTheme });

			const { container } = renderWithProvider(<ExternalLinkNode {...props} />);

			const nodeElement = container.querySelector('.external-link-node');
			expect(nodeElement).toHaveStyle({
				backgroundColor: lightTheme.colors.bgSidebar,
			});
		});
	});

	describe('React Flow Integration', () => {
		it('renders input handle at top', () => {
			const props = createNodeProps();

			const { container } = renderWithProvider(<ExternalLinkNode {...props} />);

			const handles = container.querySelectorAll('.react-flow__handle');
			expect(handles.length).toBe(1); // Only input handle, no output

			const targetHandle = container.querySelector('.react-flow__handle-top');
			expect(targetHandle).toBeInTheDocument();
		});

		it('does not render output handle (leaf node)', () => {
			const props = createNodeProps();

			const { container } = renderWithProvider(<ExternalLinkNode {...props} />);

			// Should not have a bottom handle since external links are leaf nodes
			const sourceHandle = container.querySelector('.react-flow__handle-bottom');
			expect(sourceHandle).not.toBeInTheDocument();
		});
	});

	describe('Compact Size', () => {
		it('has smaller dimensions than document nodes', () => {
			const props = createNodeProps();

			const { container } = renderWithProvider(<ExternalLinkNode {...props} />);

			const nodeElement = container.querySelector('.external-link-node');
			// External link nodes have max-width of 160px vs document nodes' 280px
			expect(nodeElement).toHaveStyle({ maxWidth: '160px' });
		});

		it('has rounded corners for pill-like appearance', () => {
			const props = createNodeProps();

			const { container } = renderWithProvider(<ExternalLinkNode {...props} />);

			const nodeElement = container.querySelector('.external-link-node');
			expect(nodeElement).toHaveStyle({ borderRadius: '12px' });
		});
	});

	describe('Search/Filter Dimming', () => {
		it('renders with full opacity when search is not active', () => {
			const props = createNodeProps({
				searchActive: false,
				searchMatch: true,
			});

			const { container } = renderWithProvider(<ExternalLinkNode {...props} />);

			const nodeElement = container.querySelector('.external-link-node');
			expect(nodeElement).toHaveStyle({
				opacity: '1',
				filter: 'none',
			});
		});

		it('renders with full opacity when search is active and node matches', () => {
			const props = createNodeProps({
				searchActive: true,
				searchMatch: true,
			});

			const { container } = renderWithProvider(<ExternalLinkNode {...props} />);

			const nodeElement = container.querySelector('.external-link-node');
			expect(nodeElement).toHaveStyle({
				opacity: '1',
				filter: 'none',
			});
		});

		it('renders with reduced opacity when search is active and node does not match', () => {
			const props = createNodeProps({
				searchActive: true,
				searchMatch: false,
			});

			const { container } = renderWithProvider(<ExternalLinkNode {...props} />);

			const nodeElement = container.querySelector('.external-link-node');
			expect(nodeElement).toHaveStyle({
				opacity: '0.35',
				filter: 'grayscale(50%)',
			});
		});

		it('renders with full opacity when searchActive/searchMatch are undefined', () => {
			const props = createNodeProps();
			// Don't set searchActive or searchMatch - should default to full opacity

			const { container } = renderWithProvider(<ExternalLinkNode {...props} />);

			const nodeElement = container.querySelector('.external-link-node');
			expect(nodeElement).toHaveStyle({
				opacity: '1',
				filter: 'none',
			});
		});
	});

	describe('Search Highlighting', () => {
		it('applies accent border color when search is active and node matches', () => {
			const props = createNodeProps({
				searchActive: true,
				searchMatch: true,
			});

			const { container } = renderWithProvider(<ExternalLinkNode {...props} />);

			const nodeElement = container.querySelector('.external-link-node');
			expect(nodeElement).toHaveStyle({
				borderColor: mockTheme.colors.accent,
				borderWidth: '2px',
			});
		});

		it('applies highlight glow box-shadow when search is active and node matches', () => {
			const props = createNodeProps({
				searchActive: true,
				searchMatch: true,
			});

			const { container } = renderWithProvider(<ExternalLinkNode {...props} />);

			const nodeElement = container.querySelector('.external-link-node');
			const style = nodeElement?.getAttribute('style') || '';
			// Should have a box-shadow with the accent color for the glow effect
			expect(style).toContain('box-shadow');
			expect(style).toContain(mockTheme.colors.accent.replace('#', ''));
		});

		it('adds search-highlight class when search is active and node matches', () => {
			const props = createNodeProps({
				searchActive: true,
				searchMatch: true,
			});

			const { container } = renderWithProvider(<ExternalLinkNode {...props} />);

			const nodeElement = container.querySelector('.external-link-node');
			expect(nodeElement).toHaveClass('search-highlight');
		});

		it('does not add search-highlight class when search is not active', () => {
			const props = createNodeProps({
				searchActive: false,
				searchMatch: true,
			});

			const { container } = renderWithProvider(<ExternalLinkNode {...props} />);

			const nodeElement = container.querySelector('.external-link-node');
			expect(nodeElement).not.toHaveClass('search-highlight');
		});

		it('does not add search-highlight class when node does not match', () => {
			const props = createNodeProps({
				searchActive: true,
				searchMatch: false,
			});

			const { container } = renderWithProvider(<ExternalLinkNode {...props} />);

			const nodeElement = container.querySelector('.external-link-node');
			expect(nodeElement).not.toHaveClass('search-highlight');
		});

		it('prioritizes highlight border over selection border when both apply', () => {
			const props = createNodeProps({
				searchActive: true,
				searchMatch: true,
			});
			const selectedProps = { ...props, selected: true };

			const { container } = renderWithProvider(<ExternalLinkNode {...selectedProps} />);

			const nodeElement = container.querySelector('.external-link-node');
			// Both highlight and selection would have accent border - should still be accent
			expect(nodeElement).toHaveStyle({
				borderColor: mockTheme.colors.accent,
				borderWidth: '2px',
			});
			// Should still have the search-highlight class for animation
			expect(nodeElement).toHaveClass('search-highlight');
		});

		it('does not apply highlight styling when searchActive/searchMatch are undefined', () => {
			const props = createNodeProps();

			const { container } = renderWithProvider(<ExternalLinkNode {...props} />);

			const nodeElement = container.querySelector('.external-link-node');
			// Should use default border color, not accent
			expect(nodeElement).toHaveStyle({
				borderColor: mockTheme.colors.border,
			});
			expect(nodeElement).not.toHaveClass('search-highlight');
		});
	});
});
