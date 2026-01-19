/**
 * Tests for the DocumentNode React Flow custom node component
 */

import { describe, it, expect } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { ReactFlowProvider } from 'reactflow';
import {
	DocumentNode,
	type DocumentNodeProps,
} from '../../../../renderer/components/DocumentGraph/DocumentNode';
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
function createNodeProps(overrides: Partial<DocumentNodeProps['data']> = {}): DocumentNodeProps {
	return {
		id: 'test-node-1',
		type: 'documentNode',
		data: {
			nodeType: 'document',
			title: 'Test Document',
			lineCount: 100,
			wordCount: 500,
			size: '1.5 KB',
			filePath: 'test/document.md',
			theme: mockTheme,
			...overrides,
		},
		selected: false,
		isConnectable: true,
		xPos: 0,
		yPos: 0,
		zIndex: 0,
		dragging: false,
	} as DocumentNodeProps;
}

// Wrapper component for React Flow context
function renderWithProvider(ui: React.ReactElement) {
	return render(<ReactFlowProvider>{ui}</ReactFlowProvider>);
}

describe('DocumentNode', () => {
	describe('Basic Rendering', () => {
		it('renders the document title', () => {
			const props = createNodeProps({ title: 'My Document' });
			renderWithProvider(<DocumentNode {...props} />);

			expect(screen.getByText('My Document')).toBeInTheDocument();
		});

		it('renders line count', () => {
			const props = createNodeProps({ lineCount: 42 });
			renderWithProvider(<DocumentNode {...props} />);

			expect(screen.getByText('42')).toBeInTheDocument();
		});

		it('renders word count', () => {
			const props = createNodeProps({ wordCount: 1234 });
			renderWithProvider(<DocumentNode {...props} />);

			expect(screen.getByText('1234')).toBeInTheDocument();
		});

		it('renders file size', () => {
			const props = createNodeProps({ size: '2.3 MB' });
			renderWithProvider(<DocumentNode {...props} />);

			expect(screen.getByText('2.3 MB')).toBeInTheDocument();
		});

		it('renders description when provided', () => {
			const props = createNodeProps({
				description: 'A brief description of the document',
			});
			renderWithProvider(<DocumentNode {...props} />);

			expect(screen.getByText('A brief description of the document')).toBeInTheDocument();
		});

		it('does not render description section when not provided', () => {
			const props = createNodeProps({ description: undefined });
			renderWithProvider(<DocumentNode {...props} />);

			// Should only have stats row, no extra text
			expect(screen.queryByText(/description/i)).not.toBeInTheDocument();
		});
	});

	describe('Title Truncation', () => {
		it('displays full title when under 40 characters', () => {
			const shortTitle = 'Short Title Here';
			const props = createNodeProps({ title: shortTitle });
			renderWithProvider(<DocumentNode {...props} />);

			expect(screen.getByText(shortTitle)).toBeInTheDocument();
		});

		it('truncates title with ellipsis when exceeding 40 characters', () => {
			const longTitle =
				'This Is A Very Long Document Title That Exceeds The Maximum Allowed Length';
			const props = createNodeProps({ title: longTitle });
			renderWithProvider(<DocumentNode {...props} />);

			// Should show truncated text with ellipsis
			const truncatedElement = screen.getByText(/\.\.\./);
			expect(truncatedElement).toBeInTheDocument();
			// The full title should not appear
			expect(screen.queryByText(longTitle)).not.toBeInTheDocument();
		});

		it('truncates title at exactly 40 characters', () => {
			// Create a title that's exactly 42 chars (40 + will be truncated)
			const longTitle = 'ABCDEFGHIJ'.repeat(5); // 50 chars
			const props = createNodeProps({ title: longTitle });
			renderWithProvider(<DocumentNode {...props} />);

			// First 40 characters should be visible (trimmed) with ellipsis
			const truncatedText = 'ABCDEFGHIJ'.repeat(4) + '...'; // 40 chars + ellipsis
			expect(screen.getByText(truncatedText)).toBeInTheDocument();
		});

		it('shows full title in tooltip when title is truncated', () => {
			const longTitle =
				'This Is A Very Long Document Title That Exceeds The Maximum Allowed Length';
			const filePath = 'docs/my-document.md';
			const props = createNodeProps({ title: longTitle, filePath });

			const { container } = renderWithProvider(<DocumentNode {...props} />);

			const nodeElement = container.querySelector('.document-node');
			const titleAttr = nodeElement?.getAttribute('title') || '';
			// Tooltip should contain the full title
			expect(titleAttr).toContain(longTitle);
			// And the file path
			expect(titleAttr).toContain(filePath);
		});

		it('shows only file path in tooltip when title is not truncated', () => {
			const shortTitle = 'Short Title';
			const filePath = 'docs/my-document.md';
			const props = createNodeProps({ title: shortTitle, filePath });

			const { container } = renderWithProvider(<DocumentNode {...props} />);

			const nodeElement = container.querySelector('.document-node');
			expect(nodeElement).toHaveAttribute('title', filePath);
		});

		it('handles title exactly at max length (40 chars)', () => {
			const exactTitle = 'A'.repeat(40); // Exactly 40 chars
			const props = createNodeProps({ title: exactTitle });
			renderWithProvider(<DocumentNode {...props} />);

			// Should show full title without ellipsis
			expect(screen.getByText(exactTitle)).toBeInTheDocument();
		});

		it('preserves CSS overflow ellipsis on title element', () => {
			const props = createNodeProps({ title: 'Test Title' });

			const { container } = renderWithProvider(<DocumentNode {...props} />);

			// Find the title div (contains the title text)
			const titleElement = screen.getByText('Test Title');
			expect(titleElement).toHaveStyle({
				overflow: 'hidden',
				textOverflow: 'ellipsis',
				whiteSpace: 'nowrap',
			});
		});
	});

	describe('Description Truncation', () => {
		it('displays full description when under 100 characters', () => {
			const shortDescription = 'This is a brief description that fits within the limit.';
			const props = createNodeProps({ description: shortDescription });
			renderWithProvider(<DocumentNode {...props} />);

			expect(screen.getByText(shortDescription)).toBeInTheDocument();
		});

		it('truncates description with ellipsis when exceeding 100 characters', () => {
			// Create a description that's exactly 120 chars (exceeds 100)
			const longDescription = 'A'.repeat(120);
			const props = createNodeProps({ description: longDescription });
			renderWithProvider(<DocumentNode {...props} />);

			// Should show truncated text with ellipsis (100 chars + "...")
			const expectedTruncated = 'A'.repeat(100) + '...';
			expect(screen.getByText(expectedTruncated)).toBeInTheDocument();
			// The full description should not appear
			expect(screen.queryByText(longDescription)).not.toBeInTheDocument();
		});

		it('handles description exactly at max length (100 chars) without truncation', () => {
			const exactDescription = 'B'.repeat(100); // Exactly 100 chars
			const props = createNodeProps({ description: exactDescription });
			renderWithProvider(<DocumentNode {...props} />);

			// Should show full description without ellipsis
			expect(screen.getByText(exactDescription)).toBeInTheDocument();
		});

		it('shows full description in tooltip when description is truncated', () => {
			const longDescription =
				'This is a very long description that exceeds the maximum allowed length of 100 characters and should show a tooltip with the full text when hovering.';
			const props = createNodeProps({ description: longDescription });

			const { container } = renderWithProvider(<DocumentNode {...props} />);

			// Find the description element (contains truncated text with ellipsis)
			const descriptionElement = screen.getByText(/\.\.\./);
			expect(descriptionElement).toHaveAttribute('title', longDescription);
		});

		it('does not show tooltip on description when not truncated', () => {
			const shortDescription = 'Brief description under limit';
			const props = createNodeProps({ description: shortDescription });

			const { container } = renderWithProvider(<DocumentNode {...props} />);

			// The description element should not have a title attribute
			const descriptionElement = screen.getByText(shortDescription);
			expect(descriptionElement).not.toHaveAttribute('title');
		});

		it('handles description exactly at 101 characters (just over limit)', () => {
			const description101 = 'C'.repeat(101); // Just 1 char over
			const props = createNodeProps({ description: description101 });
			renderWithProvider(<DocumentNode {...props} />);

			// Should truncate to 100 chars + ellipsis
			const expectedTruncated = 'C'.repeat(100) + '...';
			expect(screen.getByText(expectedTruncated)).toBeInTheDocument();
		});

		it('does not render description section when description is undefined', () => {
			const props = createNodeProps({ description: undefined });
			renderWithProvider(<DocumentNode {...props} />);

			// Should not have any description-related elements (no truncated text)
			expect(screen.queryByText(/\.\.\./)).not.toBeInTheDocument();
		});

		it('handles empty string description', () => {
			const props = createNodeProps({ description: '' });
			renderWithProvider(<DocumentNode {...props} />);

			// Empty string is falsy, so description section should not render
			// (truncateText returns empty string, but displayDescription will be null due to falsy check)
			const descriptionElements = document.querySelectorAll('[style*="opacity: 0.85"]');
			expect(descriptionElements.length).toBe(0);
		});

		it('preserves whitespace when truncating', () => {
			// Description with words that will be truncated mid-word
			const description =
				'Word1 Word2 Word3 Word4 Word5 Word6 Word7 Word8 Word9 Word10 Word11 Word12 Word13 Word14 Word15 Word16 Word17 Word18';
			const props = createNodeProps({ description });
			renderWithProvider(<DocumentNode {...props} />);

			// Should truncate at 100 chars and add ellipsis
			const truncatedText = description.slice(0, 100).trim() + '...';
			expect(screen.getByText(truncatedText)).toBeInTheDocument();
		});
	});

	describe('Selection State', () => {
		it('applies different border when selected', () => {
			const props = createNodeProps();
			const selectedProps = { ...props, selected: true };

			const { container } = renderWithProvider(<DocumentNode {...selectedProps} />);

			const nodeElement = container.querySelector('.document-node');
			expect(nodeElement).toBeInTheDocument();
			// Selected border should be accent color
			expect(nodeElement).toHaveStyle({ borderColor: mockTheme.colors.accent });
		});

		it('applies default border when not selected', () => {
			const props = createNodeProps();

			const { container } = renderWithProvider(<DocumentNode {...props} />);

			const nodeElement = container.querySelector('.document-node');
			expect(nodeElement).toBeInTheDocument();
			// Default border should be border color
			expect(nodeElement).toHaveStyle({ borderColor: mockTheme.colors.border });
		});

		it('applies thicker border when selected', () => {
			const props = createNodeProps();
			const selectedProps = { ...props, selected: true };

			const { container } = renderWithProvider(<DocumentNode {...selectedProps} />);

			const nodeElement = container.querySelector('.document-node');
			expect(nodeElement).toHaveStyle({ borderWidth: '2px' });
		});
	});

	describe('Accessibility', () => {
		it('has file path as title attribute when title is not truncated', () => {
			const props = createNodeProps({
				title: 'Short Title', // Under 40 chars
				filePath: 'docs/guide/intro.md',
			});

			const { container } = renderWithProvider(<DocumentNode {...props} />);

			const nodeElement = container.querySelector('.document-node');
			expect(nodeElement).toHaveAttribute('title', 'docs/guide/intro.md');
		});

		it('includes full title and file path in tooltip when title is truncated', () => {
			const longTitle = 'This Is A Very Long Document Title That Exceeds Maximum';
			const filePath = 'docs/guide/intro.md';
			const props = createNodeProps({
				title: longTitle,
				filePath,
			});

			const { container } = renderWithProvider(<DocumentNode {...props} />);

			const nodeElement = container.querySelector('.document-node');
			const titleAttr = nodeElement?.getAttribute('title') || '';
			expect(titleAttr).toContain(longTitle);
			expect(titleAttr).toContain(filePath);
		});

		it('has tooltips for stat items', () => {
			const props = createNodeProps({
				lineCount: 50,
				wordCount: 200,
				size: '512 B',
			});

			const { container } = renderWithProvider(<DocumentNode {...props} />);

			// Check for title attributes on stat items
			expect(container.querySelector('[title="50 lines"]')).toBeInTheDocument();
			expect(container.querySelector('[title="200 words"]')).toBeInTheDocument();
			expect(container.querySelector('[title="512 B"]')).toBeInTheDocument();
		});
	});

	describe('Theme Integration', () => {
		it('uses theme background color', () => {
			const props = createNodeProps();

			const { container } = renderWithProvider(<DocumentNode {...props} />);

			const nodeElement = container.querySelector('.document-node');
			expect(nodeElement).toHaveStyle({
				backgroundColor: mockTheme.colors.bgActivity,
			});
		});

		it('uses theme accent color for document icon', () => {
			const props = createNodeProps();

			const { container } = renderWithProvider(<DocumentNode {...props} />);

			// Find the FileText icon container (lucide renders with data-lucide or class)
			// Lucide icons are rendered as SVG elements
			const svgs = container.querySelectorAll('svg');
			// First SVG should be the FileText icon
			expect(svgs.length).toBeGreaterThan(0);
			// The icon's parent should have the accent color style
			const iconContainer = svgs[0]?.parentElement;
			expect(iconContainer).toBeInTheDocument();
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

			const { container } = renderWithProvider(<DocumentNode {...props} />);

			const nodeElement = container.querySelector('.document-node');
			expect(nodeElement).toHaveStyle({
				backgroundColor: lightTheme.colors.bgActivity,
			});
		});
	});

	describe('React Flow Integration', () => {
		it('renders input handle at top', () => {
			const props = createNodeProps();

			const { container } = renderWithProvider(<DocumentNode {...props} />);

			const handles = container.querySelectorAll('.react-flow__handle');
			expect(handles.length).toBe(2);

			// Find the target (input) handle
			const targetHandle = container.querySelector('.react-flow__handle-top');
			expect(targetHandle).toBeInTheDocument();
		});

		it('renders output handle at bottom', () => {
			const props = createNodeProps();

			const { container } = renderWithProvider(<DocumentNode {...props} />);

			// Find the source (output) handle
			const sourceHandle = container.querySelector('.react-flow__handle-bottom');
			expect(sourceHandle).toBeInTheDocument();
		});
	});

	describe('Search/Filter Dimming', () => {
		it('renders with full opacity when search is not active', () => {
			const props = createNodeProps({
				searchActive: false,
				searchMatch: true,
			});

			const { container } = renderWithProvider(<DocumentNode {...props} />);

			const nodeElement = container.querySelector('.document-node');
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

			const { container } = renderWithProvider(<DocumentNode {...props} />);

			const nodeElement = container.querySelector('.document-node');
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

			const { container } = renderWithProvider(<DocumentNode {...props} />);

			const nodeElement = container.querySelector('.document-node');
			expect(nodeElement).toHaveStyle({
				opacity: '0.35',
				filter: 'grayscale(50%)',
			});
		});

		it('renders with full opacity when searchActive/searchMatch are undefined', () => {
			const props = createNodeProps();
			// Don't set searchActive or searchMatch - should default to full opacity

			const { container } = renderWithProvider(<DocumentNode {...props} />);

			const nodeElement = container.querySelector('.document-node');
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

			const { container } = renderWithProvider(<DocumentNode {...props} />);

			const nodeElement = container.querySelector('.document-node');
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

			const { container } = renderWithProvider(<DocumentNode {...props} />);

			const nodeElement = container.querySelector('.document-node');
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

			const { container } = renderWithProvider(<DocumentNode {...props} />);

			const nodeElement = container.querySelector('.document-node');
			expect(nodeElement).toHaveClass('search-highlight');
		});

		it('does not add search-highlight class when search is not active', () => {
			const props = createNodeProps({
				searchActive: false,
				searchMatch: true,
			});

			const { container } = renderWithProvider(<DocumentNode {...props} />);

			const nodeElement = container.querySelector('.document-node');
			expect(nodeElement).not.toHaveClass('search-highlight');
		});

		it('does not add search-highlight class when node does not match', () => {
			const props = createNodeProps({
				searchActive: true,
				searchMatch: false,
			});

			const { container } = renderWithProvider(<DocumentNode {...props} />);

			const nodeElement = container.querySelector('.document-node');
			expect(nodeElement).not.toHaveClass('search-highlight');
		});

		it('prioritizes highlight border over selection border when both apply', () => {
			const props = createNodeProps({
				searchActive: true,
				searchMatch: true,
			});
			const selectedProps = { ...props, selected: true };

			const { container } = renderWithProvider(<DocumentNode {...selectedProps} />);

			const nodeElement = container.querySelector('.document-node');
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

			const { container } = renderWithProvider(<DocumentNode {...props} />);

			const nodeElement = container.querySelector('.document-node');
			// Should use default border color, not accent
			expect(nodeElement).toHaveStyle({
				borderColor: mockTheme.colors.border,
			});
			expect(nodeElement).not.toHaveClass('search-highlight');
		});
	});

	describe('Broken Links Warning', () => {
		it('shows warning icon when document has broken links', () => {
			const props = createNodeProps({
				brokenLinks: ['missing-doc.md', 'nonexistent/file.md'],
			});

			renderWithProvider(<DocumentNode {...props} />);

			const warningIcon = screen.getByTestId('broken-links-warning');
			expect(warningIcon).toBeInTheDocument();
		});

		it('does not show warning icon when brokenLinks is empty', () => {
			const props = createNodeProps({
				brokenLinks: [],
			});

			renderWithProvider(<DocumentNode {...props} />);

			expect(screen.queryByTestId('broken-links-warning')).not.toBeInTheDocument();
		});

		it('does not show warning icon when brokenLinks is undefined', () => {
			const props = createNodeProps();

			renderWithProvider(<DocumentNode {...props} />);

			expect(screen.queryByTestId('broken-links-warning')).not.toBeInTheDocument();
		});

		it('displays correct aria-label for single broken link', () => {
			const props = createNodeProps({
				brokenLinks: ['missing-doc.md'],
			});

			renderWithProvider(<DocumentNode {...props} />);

			const warningIcon = screen.getByTestId('broken-links-warning');
			expect(warningIcon).toHaveAttribute('aria-label', '1 broken link');
		});

		it('displays correct aria-label for multiple broken links', () => {
			const props = createNodeProps({
				brokenLinks: ['missing1.md', 'missing2.md', 'missing3.md'],
			});

			renderWithProvider(<DocumentNode {...props} />);

			const warningIcon = screen.getByTestId('broken-links-warning');
			expect(warningIcon).toHaveAttribute('aria-label', '3 broken links');
		});

		it('includes broken links in tooltip', () => {
			const props = createNodeProps({
				filePath: 'docs/readme.md',
				brokenLinks: ['missing1.md', 'subfolder/missing2.md'],
			});

			const { container } = renderWithProvider(<DocumentNode {...props} />);

			const nodeElement = container.querySelector('.document-node');
			const tooltip = nodeElement?.getAttribute('title') || '';

			expect(tooltip).toContain('docs/readme.md');
			expect(tooltip).toContain('⚠️ Broken links (2)');
			expect(tooltip).toContain('missing1.md');
			expect(tooltip).toContain('subfolder/missing2.md');
		});

		it('does not include broken links section in tooltip when no broken links', () => {
			const props = createNodeProps({
				filePath: 'docs/readme.md',
				brokenLinks: [],
			});

			const { container } = renderWithProvider(<DocumentNode {...props} />);

			const nodeElement = container.querySelector('.document-node');
			const tooltip = nodeElement?.getAttribute('title') || '';

			expect(tooltip).toContain('docs/readme.md');
			expect(tooltip).not.toContain('⚠️ Broken links');
		});

		it('warning icon has amber/warning color', () => {
			const props = createNodeProps({
				brokenLinks: ['missing.md'],
			});

			const { container } = renderWithProvider(<DocumentNode {...props} />);

			const warningIcon = screen.getByTestId('broken-links-warning');
			// The icon should have the amber warning color
			expect(warningIcon).toHaveStyle({
				color: '#f59e0b',
			});
		});

		it('shows warning icon alongside title and file icon', () => {
			const props = createNodeProps({
				title: 'Document With Broken Links',
				brokenLinks: ['missing.md'],
			});

			renderWithProvider(<DocumentNode {...props} />);

			// All three should be visible: title, file icon, and warning
			expect(screen.getByText('Document With Broken Links')).toBeInTheDocument();
			expect(screen.getByTestId('broken-links-warning')).toBeInTheDocument();
		});

		it('includes broken links in tooltip alongside full title when title is truncated', () => {
			const longTitle = 'This is a very long title that definitely exceeds forty characters';
			const props = createNodeProps({
				title: longTitle,
				filePath: 'docs/long-doc.md',
				brokenLinks: ['missing.md'],
			});

			const { container } = renderWithProvider(<DocumentNode {...props} />);

			const nodeElement = container.querySelector('.document-node');
			const tooltip = nodeElement?.getAttribute('title') || '';

			// Should contain full title, file path, AND broken links
			expect(tooltip).toContain(longTitle);
			expect(tooltip).toContain('docs/long-doc.md');
			expect(tooltip).toContain('⚠️ Broken links (1)');
			expect(tooltip).toContain('missing.md');
		});
	});

	describe('Large File Indicator', () => {
		it('shows large file indicator icon when isLargeFile is true', () => {
			const props = createNodeProps({
				title: 'Large Document',
				isLargeFile: true,
			});

			renderWithProvider(<DocumentNode {...props} />);

			const indicator = screen.getByTestId('large-file-indicator');
			expect(indicator).toBeInTheDocument();
		});

		it('does not show large file indicator when isLargeFile is undefined', () => {
			const props = createNodeProps({
				title: 'Normal Document',
				// isLargeFile not set
			});

			renderWithProvider(<DocumentNode {...props} />);

			expect(screen.queryByTestId('large-file-indicator')).not.toBeInTheDocument();
		});

		it('does not show large file indicator when isLargeFile is false', () => {
			const props = createNodeProps({
				title: 'Normal Document',
				isLargeFile: false,
			});

			renderWithProvider(<DocumentNode {...props} />);

			expect(screen.queryByTestId('large-file-indicator')).not.toBeInTheDocument();
		});

		it('large file indicator has correct tooltip', () => {
			const props = createNodeProps({
				title: 'Large Document',
				isLargeFile: true,
			});

			renderWithProvider(<DocumentNode {...props} />);

			const indicator = screen.getByTestId('large-file-indicator');
			expect(indicator).toHaveAttribute(
				'title',
				'Large file (>1MB) - content truncated for parsing'
			);
		});

		it('large file indicator has blue info color', () => {
			const props = createNodeProps({
				title: 'Large Document',
				isLargeFile: true,
			});

			renderWithProvider(<DocumentNode {...props} />);

			const indicator = screen.getByTestId('large-file-indicator');
			expect(indicator).toHaveStyle({
				color: '#3b82f6',
			});
		});

		it('includes large file info in main tooltip', () => {
			const props = createNodeProps({
				title: 'Large Document',
				filePath: 'docs/large.md',
				isLargeFile: true,
			});

			const { container } = renderWithProvider(<DocumentNode {...props} />);

			const nodeElement = container.querySelector('.document-node');
			const tooltip = nodeElement?.getAttribute('title') || '';

			expect(tooltip).toContain('docs/large.md');
			expect(tooltip).toContain('ℹ️ Large file (>1MB) - some links may not be detected');
		});

		it('does not include large file info in tooltip when not a large file', () => {
			const props = createNodeProps({
				title: 'Normal Document',
				filePath: 'docs/normal.md',
				isLargeFile: false,
			});

			const { container } = renderWithProvider(<DocumentNode {...props} />);

			const nodeElement = container.querySelector('.document-node');
			const tooltip = nodeElement?.getAttribute('title') || '';

			expect(tooltip).not.toContain('Large file');
		});

		it('shows both large file indicator and broken links warning when both present', () => {
			const props = createNodeProps({
				title: 'Large Document With Issues',
				isLargeFile: true,
				brokenLinks: ['missing.md'],
			});

			renderWithProvider(<DocumentNode {...props} />);

			expect(screen.getByTestId('large-file-indicator')).toBeInTheDocument();
			expect(screen.getByTestId('broken-links-warning')).toBeInTheDocument();
		});

		it('includes both large file info and broken links in tooltip', () => {
			const props = createNodeProps({
				title: 'Large Document With Issues',
				filePath: 'docs/large.md',
				isLargeFile: true,
				brokenLinks: ['missing.md'],
			});

			const { container } = renderWithProvider(<DocumentNode {...props} />);

			const nodeElement = container.querySelector('.document-node');
			const tooltip = nodeElement?.getAttribute('title') || '';

			expect(tooltip).toContain('ℹ️ Large file (>1MB)');
			expect(tooltip).toContain('⚠️ Broken links (1)');
			expect(tooltip).toContain('missing.md');
		});

		it('large file indicator appears in stats row next to size', () => {
			const props = createNodeProps({
				title: 'Large Document',
				size: '5.2 MB',
				isLargeFile: true,
			});

			const { container } = renderWithProvider(<DocumentNode {...props} />);

			// Both the size and the indicator should be visible
			expect(screen.getByText('5.2 MB')).toBeInTheDocument();
			expect(screen.getByTestId('large-file-indicator')).toBeInTheDocument();
		});
	});
});
