/**
 * Tests for the NodeBreadcrumb component
 *
 * The NodeBreadcrumb displays a path hierarchy for the currently selected node
 * in the Document Graph, showing folder/file structure for documents and
 * domain for external links.
 */

import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import {
	NodeBreadcrumb,
	type NodeBreadcrumbProps,
} from '../../../../renderer/components/DocumentGraph/NodeBreadcrumb';
import type { Theme } from '../../../../renderer/types';
import type {
	DocumentNodeData,
	ExternalLinkNodeData,
} from '../../../../renderer/components/DocumentGraph/graphDataBuilder';

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
	},
};

// Helper to create document node data
function createDocumentNodeData(filePath: string): DocumentNodeData & { theme: Theme } {
	return {
		nodeType: 'document',
		title: filePath.split('/').pop()?.replace(/\.md$/i, '') || 'Untitled',
		lineCount: 100,
		wordCount: 500,
		size: '1.5 KB',
		filePath,
		theme: mockTheme,
	};
}

// Helper to create external link node data
function createExternalNodeData(
	domain: string,
	urls: string[] = []
): ExternalLinkNodeData & { theme: Theme } {
	return {
		nodeType: 'external',
		domain,
		linkCount: urls.length || 1,
		urls: urls.length > 0 ? urls : [`https://${domain}/page`],
		theme: mockTheme,
	};
}

describe('NodeBreadcrumb', () => {
	describe('Rendering', () => {
		it('renders nothing when no node is selected', () => {
			const { container } = render(
				<NodeBreadcrumb selectedNodeData={null} theme={mockTheme} rootPath="/project" />
			);

			expect(container.firstChild).toBeNull();
		});

		it('renders breadcrumb for a document node in root directory', () => {
			render(
				<NodeBreadcrumb
					selectedNodeData={createDocumentNodeData('README.md')}
					theme={mockTheme}
					rootPath="/Users/test/project"
				/>
			);

			// Should show project (root) and the file name
			expect(screen.getByText('project')).toBeInTheDocument();
			expect(screen.getByText('README')).toBeInTheDocument();
		});

		it('renders breadcrumb with nested path for document node', () => {
			render(
				<NodeBreadcrumb
					selectedNodeData={createDocumentNodeData('docs/guides/getting-started.md')}
					theme={mockTheme}
					rootPath="/Users/test/my-project"
				/>
			);

			// Should show root, folders, and file
			expect(screen.getByText('my-project')).toBeInTheDocument();
			expect(screen.getByText('docs')).toBeInTheDocument();
			expect(screen.getByText('guides')).toBeInTheDocument();
			expect(screen.getByText('getting-started')).toBeInTheDocument();
		});

		it('renders breadcrumb for external link node', () => {
			render(
				<NodeBreadcrumb
					selectedNodeData={createExternalNodeData('github.com')}
					theme={mockTheme}
					rootPath="/project"
				/>
			);

			expect(screen.getByText('External Links')).toBeInTheDocument();
			expect(screen.getByText('github.com')).toBeInTheDocument();
		});

		it('strips .md extension from file name', () => {
			render(
				<NodeBreadcrumb
					selectedNodeData={createDocumentNodeData('api/endpoints.md')}
					theme={mockTheme}
					rootPath="/project"
				/>
			);

			expect(screen.getByText('endpoints')).toBeInTheDocument();
			expect(screen.queryByText('endpoints.md')).not.toBeInTheDocument();
		});

		it('handles deep nesting correctly', () => {
			render(
				<NodeBreadcrumb
					selectedNodeData={createDocumentNodeData('src/components/ui/buttons/primary-button.md')}
					theme={mockTheme}
					rootPath="/app"
				/>
			);

			expect(screen.getByText('app')).toBeInTheDocument();
			expect(screen.getByText('src')).toBeInTheDocument();
			expect(screen.getByText('components')).toBeInTheDocument();
			expect(screen.getByText('ui')).toBeInTheDocument();
			expect(screen.getByText('buttons')).toBeInTheDocument();
			expect(screen.getByText('primary-button')).toBeInTheDocument();
		});
	});

	describe('Chevron separators', () => {
		it('renders chevron separators between segments', () => {
			const { container } = render(
				<NodeBreadcrumb
					selectedNodeData={createDocumentNodeData('folder/subfolder/file.md')}
					theme={mockTheme}
					rootPath="/project"
				/>
			);

			// Should have 3 chevrons (root > folder > subfolder > file)
			// There are 4 segments total, so 3 chevrons between them
			// Count ChevronRight icons - they are rendered directly (not inside buttons)
			const breadcrumb = container.querySelector('.node-breadcrumb');
			const buttons = breadcrumb?.querySelectorAll('button');
			// 4 segments = 4 buttons, and 3 chevrons between them
			expect(buttons?.length).toBe(4);

			// Chevrons are siblings between buttons, so we should have 4 buttons
			// and the SVG chevrons are outside of buttons
			const allSvgs = breadcrumb?.querySelectorAll('svg');
			// Total SVGs: 4 segments (some have icons) + 3 chevrons
			// Root has Home icon, file has FileText icon = 2 icons in buttons
			// Plus 3 chevron icons = 5 total SVGs
			expect(allSvgs?.length).toBeGreaterThanOrEqual(3);
		});

		it('does not render chevron before first segment', () => {
			render(
				<NodeBreadcrumb
					selectedNodeData={createDocumentNodeData('file.md')}
					theme={mockTheme}
					rootPath="/project"
				/>
			);

			// First element should be the root button, not a chevron
			const navigation = screen.getByRole('navigation');
			const firstChild = navigation.firstChild;
			expect(firstChild?.nodeName.toLowerCase()).toBe('button');
		});
	});

	describe('Segment interaction', () => {
		it('calls onSegmentClick when non-final segment is clicked', () => {
			const onSegmentClick = vi.fn();

			render(
				<NodeBreadcrumb
					selectedNodeData={createDocumentNodeData('folder/file.md')}
					theme={mockTheme}
					rootPath="/project"
					onSegmentClick={onSegmentClick}
				/>
			);

			// Click on folder segment
			fireEvent.click(screen.getByText('folder'));
			expect(onSegmentClick).toHaveBeenCalledWith('folder');
		});

		it('does not call onSegmentClick when final segment is clicked', () => {
			const onSegmentClick = vi.fn();

			render(
				<NodeBreadcrumb
					selectedNodeData={createDocumentNodeData('folder/file.md')}
					theme={mockTheme}
					rootPath="/project"
					onSegmentClick={onSegmentClick}
				/>
			);

			// Click on file segment (final)
			fireEvent.click(screen.getByText('file'));
			expect(onSegmentClick).not.toHaveBeenCalled();
		});

		it('root segment click passes empty path', () => {
			const onSegmentClick = vi.fn();

			render(
				<NodeBreadcrumb
					selectedNodeData={createDocumentNodeData('folder/file.md')}
					theme={mockTheme}
					rootPath="/project"
					onSegmentClick={onSegmentClick}
				/>
			);

			// Click on root segment
			fireEvent.click(screen.getByText('project'));
			expect(onSegmentClick).toHaveBeenCalledWith('');
		});

		it('final segment button is disabled', () => {
			render(
				<NodeBreadcrumb
					selectedNodeData={createDocumentNodeData('folder/file.md')}
					theme={mockTheme}
					rootPath="/project"
				/>
			);

			const fileButton = screen.getByText('file').closest('button');
			expect(fileButton).toBeDisabled();
		});

		it('non-final segments are not disabled', () => {
			render(
				<NodeBreadcrumb
					selectedNodeData={createDocumentNodeData('folder/subfolder/file.md')}
					theme={mockTheme}
					rootPath="/project"
				/>
			);

			const folderButton = screen.getByText('folder').closest('button');
			const subfolderButton = screen.getByText('subfolder').closest('button');

			expect(folderButton).not.toBeDisabled();
			expect(subfolderButton).not.toBeDisabled();
		});
	});

	describe('Accessibility', () => {
		it('has navigation role', () => {
			render(
				<NodeBreadcrumb
					selectedNodeData={createDocumentNodeData('file.md')}
					theme={mockTheme}
					rootPath="/project"
				/>
			);

			expect(screen.getByRole('navigation')).toBeInTheDocument();
		});

		it('has aria-label for navigation', () => {
			render(
				<NodeBreadcrumb
					selectedNodeData={createDocumentNodeData('file.md')}
					theme={mockTheme}
					rootPath="/project"
				/>
			);

			expect(screen.getByRole('navigation')).toHaveAttribute('aria-label', 'Selected node path');
		});

		it('final segment has aria-current="page"', () => {
			render(
				<NodeBreadcrumb
					selectedNodeData={createDocumentNodeData('folder/file.md')}
					theme={mockTheme}
					rootPath="/project"
				/>
			);

			const fileButton = screen.getByText('file').closest('button');
			expect(fileButton).toHaveAttribute('aria-current', 'page');
		});

		it('non-final segments do not have aria-current', () => {
			render(
				<NodeBreadcrumb
					selectedNodeData={createDocumentNodeData('folder/file.md')}
					theme={mockTheme}
					rootPath="/project"
				/>
			);

			const folderButton = screen.getByText('folder').closest('button');
			expect(folderButton).not.toHaveAttribute('aria-current');
		});

		it('segments have title attributes', () => {
			render(
				<NodeBreadcrumb
					selectedNodeData={createDocumentNodeData('folder/file.md')}
					theme={mockTheme}
					rootPath="/project"
				/>
			);

			const folderButton = screen.getByText('folder').closest('button');
			const fileButton = screen.getByText('file').closest('button');

			expect(folderButton).toHaveAttribute('title', 'Go to folder');
			expect(fileButton).toHaveAttribute('title', 'file');
		});
	});

	describe('Theme styling', () => {
		it('applies theme colors to container', () => {
			const { container } = render(
				<NodeBreadcrumb
					selectedNodeData={createDocumentNodeData('file.md')}
					theme={mockTheme}
					rootPath="/project"
				/>
			);

			const breadcrumb = container.querySelector('.node-breadcrumb');
			expect(breadcrumb).toHaveStyle({ borderBottom: `1px solid ${mockTheme.colors.border}` });
		});

		it('applies light theme colors correctly', () => {
			const lightNodeData = { ...createDocumentNodeData('file.md'), theme: lightTheme };

			const { container } = render(
				<NodeBreadcrumb selectedNodeData={lightNodeData} theme={lightTheme} rootPath="/project" />
			);

			const breadcrumb = container.querySelector('.node-breadcrumb');
			expect(breadcrumb).toHaveStyle({ borderBottom: `1px solid ${lightTheme.colors.border}` });
		});

		it('final segment has main text color', () => {
			render(
				<NodeBreadcrumb
					selectedNodeData={createDocumentNodeData('file.md')}
					theme={mockTheme}
					rootPath="/project"
				/>
			);

			const fileButton = screen.getByText('file').closest('button');
			expect(fileButton).toHaveStyle({ color: mockTheme.colors.textMain });
		});

		it('non-final segments have dim text color', () => {
			render(
				<NodeBreadcrumb
					selectedNodeData={createDocumentNodeData('folder/file.md')}
					theme={mockTheme}
					rootPath="/project"
				/>
			);

			const folderButton = screen.getByText('folder').closest('button');
			expect(folderButton).toHaveStyle({ color: mockTheme.colors.textDim });
		});
	});

	describe('Icons', () => {
		it('renders Home icon for root segment', () => {
			const { container } = render(
				<NodeBreadcrumb
					selectedNodeData={createDocumentNodeData('file.md')}
					theme={mockTheme}
					rootPath="/project"
				/>
			);

			// Check for Home icon (lucide-react renders as SVG with specific class)
			const rootButton = screen.getByText('project').closest('button');
			const icon = rootButton?.querySelector('svg');
			expect(icon).toBeInTheDocument();
		});

		it('renders FileText icon for document final segment', () => {
			const { container } = render(
				<NodeBreadcrumb
					selectedNodeData={createDocumentNodeData('file.md')}
					theme={mockTheme}
					rootPath="/project"
				/>
			);

			// File button should have FileText icon with accent color
			const fileButton = screen.getByText('file').closest('button');
			const icon = fileButton?.querySelector('svg');
			expect(icon).toBeInTheDocument();
			expect(icon).toHaveStyle({ color: mockTheme.colors.accent });
		});

		it('renders Globe icon for external link final segment', () => {
			const { container } = render(
				<NodeBreadcrumb
					selectedNodeData={createExternalNodeData('github.com')}
					theme={mockTheme}
					rootPath="/project"
				/>
			);

			// External link button should have Globe icon
			const externalButton = screen.getByText('github.com').closest('button');
			const icon = externalButton?.querySelector('svg');
			expect(icon).toBeInTheDocument();
			expect(icon).toHaveStyle({ color: mockTheme.colors.accent });
		});

		it('does not render icon for folder segments', () => {
			const { container } = render(
				<NodeBreadcrumb
					selectedNodeData={createDocumentNodeData('folder/file.md')}
					theme={mockTheme}
					rootPath="/project"
				/>
			);

			// Folder button should not have an icon
			const folderButton = screen.getByText('folder').closest('button');
			const icon = folderButton?.querySelector('svg');
			expect(icon).toBeNull();
		});
	});

	describe('Edge cases', () => {
		it('handles file in root with no parent folders', () => {
			render(
				<NodeBreadcrumb
					selectedNodeData={createDocumentNodeData('CHANGELOG.md')}
					theme={mockTheme}
					rootPath="/my-app"
				/>
			);

			expect(screen.getByText('my-app')).toBeInTheDocument();
			expect(screen.getByText('CHANGELOG')).toBeInTheDocument();
		});

		it('handles rootPath with trailing slash', () => {
			render(
				<NodeBreadcrumb
					selectedNodeData={createDocumentNodeData('file.md')}
					theme={mockTheme}
					rootPath="/project/"
				/>
			);

			expect(screen.getByText('project')).toBeInTheDocument();
		});

		it('handles complex domain names', () => {
			render(
				<NodeBreadcrumb
					selectedNodeData={createExternalNodeData('docs.anthropic.com')}
					theme={mockTheme}
					rootPath="/project"
				/>
			);

			expect(screen.getByText('docs.anthropic.com')).toBeInTheDocument();
		});

		it('handles file names with special characters (excluding path)', () => {
			render(
				<NodeBreadcrumb
					selectedNodeData={createDocumentNodeData('docs/[id]-guide.md')}
					theme={mockTheme}
					rootPath="/project"
				/>
			);

			expect(screen.getByText('docs')).toBeInTheDocument();
			expect(screen.getByText('[id]-guide')).toBeInTheDocument();
		});

		it('handles uppercase .MD extension', () => {
			// Create a custom node data with uppercase extension in title
			const nodeData = {
				...createDocumentNodeData('docs/README.MD'),
				title: 'README.MD', // Override title to test .MD stripping
			};
			// The breadcrumb strips .md case-insensitively based on filePath
			render(<NodeBreadcrumb selectedNodeData={nodeData} theme={mockTheme} rootPath="/project" />);

			// Should strip .MD extension
			expect(screen.getByText('README')).toBeInTheDocument();
		});
	});

	describe('Container styling', () => {
		it('has correct CSS class for styling', () => {
			const { container } = render(
				<NodeBreadcrumb
					selectedNodeData={createDocumentNodeData('file.md')}
					theme={mockTheme}
					rootPath="/project"
				/>
			);

			expect(container.querySelector('.node-breadcrumb')).toBeInTheDocument();
		});

		it('has minimum height for consistent layout', () => {
			const { container } = render(
				<NodeBreadcrumb
					selectedNodeData={createDocumentNodeData('file.md')}
					theme={mockTheme}
					rootPath="/project"
				/>
			);

			const breadcrumb = container.querySelector('.node-breadcrumb');
			expect(breadcrumb).toHaveStyle({ minHeight: '36px' });
		});

		it('has overflow-x auto for long paths', () => {
			const { container } = render(
				<NodeBreadcrumb
					selectedNodeData={createDocumentNodeData('a/b/c/d/e/f/g/h/file.md')}
					theme={mockTheme}
					rootPath="/project"
				/>
			);

			const breadcrumb = container.querySelector('.node-breadcrumb');
			expect(breadcrumb).toHaveClass('overflow-x-auto');
		});
	});

	describe('Hover states', () => {
		it('non-final segment has pointer cursor', () => {
			render(
				<NodeBreadcrumb
					selectedNodeData={createDocumentNodeData('folder/file.md')}
					theme={mockTheme}
					rootPath="/project"
				/>
			);

			const folderButton = screen.getByText('folder').closest('button');
			expect(folderButton).toHaveStyle({ cursor: 'pointer' });
		});

		it('final segment has default cursor', () => {
			render(
				<NodeBreadcrumb
					selectedNodeData={createDocumentNodeData('folder/file.md')}
					theme={mockTheme}
					rootPath="/project"
				/>
			);

			const fileButton = screen.getByText('file').closest('button');
			expect(fileButton).toHaveStyle({ cursor: 'default' });
		});
	});
});
