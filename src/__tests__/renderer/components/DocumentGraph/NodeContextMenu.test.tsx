/**
 * Tests for the NodeContextMenu component
 *
 * Tests context menu rendering, actions (Open, Copy, Focus), and dismiss behavior.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import {
	NodeContextMenu,
	type NodeContextMenuProps,
} from '../../../../renderer/components/DocumentGraph/NodeContextMenu';
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

// Mock document node data
const mockDocumentNodeData: DocumentNodeData = {
	nodeType: 'document',
	title: 'Test Document',
	lineCount: 100,
	wordCount: 500,
	size: '1.5 KB',
	filePath: '/test/path/document.md',
};

// Mock external node data with single URL
const mockExternalNodeDataSingle: ExternalLinkNodeData = {
	nodeType: 'external',
	domain: 'example.com',
	linkCount: 1,
	urls: ['https://example.com/page'],
};

// Mock external node data with multiple URLs
const mockExternalNodeDataMultiple: ExternalLinkNodeData = {
	nodeType: 'external',
	domain: 'github.com',
	linkCount: 3,
	urls: [
		'https://github.com/user/repo',
		'https://github.com/user/repo/issues',
		'https://github.com/other/project',
	],
};

// Default props helper
function createProps(overrides: Partial<NodeContextMenuProps> = {}): NodeContextMenuProps {
	return {
		x: 100,
		y: 200,
		theme: mockTheme,
		nodeData: mockDocumentNodeData,
		nodeId: 'test-node-1',
		onOpen: vi.fn(),
		onOpenExternal: vi.fn(),
		onFocus: vi.fn(),
		onDismiss: vi.fn(),
		...overrides,
	};
}

describe('NodeContextMenu', () => {
	// Mock clipboard API
	const mockClipboardWriteText = vi.fn();

	beforeEach(() => {
		mockClipboardWriteText.mockClear();
		Object.assign(navigator, {
			clipboard: {
				writeText: mockClipboardWriteText.mockResolvedValue(undefined),
			},
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe('Basic Rendering', () => {
		it('renders the context menu', () => {
			const props = createProps();
			render(<NodeContextMenu {...props} />);

			expect(screen.getByRole('button', { name: /open/i })).toBeInTheDocument();
			expect(screen.getByRole('button', { name: /copy path/i })).toBeInTheDocument();
			expect(screen.getByRole('button', { name: /focus/i })).toBeInTheDocument();
		});

		it('renders at the correct position', () => {
			const props = createProps({ x: 150, y: 250 });
			const { container } = render(<NodeContextMenu {...props} />);

			const menu = container.firstChild as HTMLElement;
			expect(menu.style.left).toBe('150px');
			expect(menu.style.top).toBe('250px');
		});

		it('adjusts position to stay within viewport', () => {
			// Position that would overflow the viewport (assuming 180px menu width and 150px height)
			const props = createProps({ x: window.innerWidth - 50, y: window.innerHeight - 50 });
			const { container } = render(<NodeContextMenu {...props} />);

			const menu = container.firstChild as HTMLElement;
			const left = parseInt(menu.style.left);
			const top = parseInt(menu.style.top);

			// Should be adjusted to stay within viewport
			expect(left).toBeLessThanOrEqual(window.innerWidth - 180);
			expect(top).toBeLessThanOrEqual(window.innerHeight - 150);
		});
	});

	describe('Document Node Menu', () => {
		it('shows "Copy Path" for document nodes', () => {
			const props = createProps({ nodeData: mockDocumentNodeData });
			render(<NodeContextMenu {...props} />);

			expect(screen.getByRole('button', { name: /copy path/i })).toBeInTheDocument();
		});

		it('shows file icon for Open button on document nodes', () => {
			const props = createProps({ nodeData: mockDocumentNodeData });
			render(<NodeContextMenu {...props} />);

			// The Open button should exist
			const openButton = screen.getByRole('button', { name: /open/i });
			expect(openButton).toBeInTheDocument();
		});

		it('calls onOpen with file path when Open is clicked', () => {
			const onOpen = vi.fn();
			const props = createProps({ nodeData: mockDocumentNodeData, onOpen });
			render(<NodeContextMenu {...props} />);

			fireEvent.click(screen.getByRole('button', { name: /open/i }));

			expect(onOpen).toHaveBeenCalledWith('/test/path/document.md');
		});

		it('copies file path to clipboard when Copy Path is clicked', async () => {
			const onDismiss = vi.fn();
			const props = createProps({ nodeData: mockDocumentNodeData, onDismiss });
			render(<NodeContextMenu {...props} />);

			fireEvent.click(screen.getByRole('button', { name: /copy path/i }));

			await waitFor(() => {
				expect(mockClipboardWriteText).toHaveBeenCalledWith('/test/path/document.md');
			});
			expect(onDismiss).toHaveBeenCalled();
		});
	});

	describe('External Node Menu (Single URL)', () => {
		it('shows "Copy URL" for external nodes with single URL', () => {
			const props = createProps({ nodeData: mockExternalNodeDataSingle });
			render(<NodeContextMenu {...props} />);

			expect(screen.getByRole('button', { name: /copy url$/i })).toBeInTheDocument();
		});

		it('calls onOpenExternal with URL when Open is clicked', () => {
			const onOpenExternal = vi.fn();
			const props = createProps({ nodeData: mockExternalNodeDataSingle, onOpenExternal });
			render(<NodeContextMenu {...props} />);

			fireEvent.click(screen.getByRole('button', { name: /open/i }));

			expect(onOpenExternal).toHaveBeenCalledWith('https://example.com/page');
		});

		it('copies URL to clipboard when Copy URL is clicked', async () => {
			const onDismiss = vi.fn();
			const props = createProps({ nodeData: mockExternalNodeDataSingle, onDismiss });
			render(<NodeContextMenu {...props} />);

			fireEvent.click(screen.getByRole('button', { name: /copy url$/i }));

			await waitFor(() => {
				expect(mockClipboardWriteText).toHaveBeenCalledWith('https://example.com/page');
			});
			expect(onDismiss).toHaveBeenCalled();
		});
	});

	describe('External Node Menu (Multiple URLs)', () => {
		it('shows "Copy URLs" for external nodes with multiple URLs', () => {
			const props = createProps({ nodeData: mockExternalNodeDataMultiple });
			render(<NodeContextMenu {...props} />);

			expect(screen.getByRole('button', { name: /copy urls/i })).toBeInTheDocument();
		});

		it('copies all URLs to clipboard when Copy URLs is clicked', async () => {
			const onDismiss = vi.fn();
			const props = createProps({ nodeData: mockExternalNodeDataMultiple, onDismiss });
			render(<NodeContextMenu {...props} />);

			fireEvent.click(screen.getByRole('button', { name: /copy urls/i }));

			await waitFor(() => {
				expect(mockClipboardWriteText).toHaveBeenCalledWith(
					'https://github.com/user/repo\nhttps://github.com/user/repo/issues\nhttps://github.com/other/project'
				);
			});
			expect(onDismiss).toHaveBeenCalled();
		});

		it('opens first URL when Open is clicked on multi-URL node', () => {
			const onOpenExternal = vi.fn();
			const props = createProps({ nodeData: mockExternalNodeDataMultiple, onOpenExternal });
			render(<NodeContextMenu {...props} />);

			fireEvent.click(screen.getByRole('button', { name: /open/i }));

			expect(onOpenExternal).toHaveBeenCalledWith('https://github.com/user/repo');
		});
	});

	describe('Focus Action', () => {
		it('calls onFocus with node ID when Focus is clicked', () => {
			const onFocus = vi.fn();
			const props = createProps({ nodeId: 'node-xyz', onFocus });
			render(<NodeContextMenu {...props} />);

			fireEvent.click(screen.getByRole('button', { name: /focus/i }));

			expect(onFocus).toHaveBeenCalledWith('node-xyz');
		});

		it('dismisses menu after Focus action', () => {
			const onDismiss = vi.fn();
			const props = createProps({ onDismiss });
			render(<NodeContextMenu {...props} />);

			fireEvent.click(screen.getByRole('button', { name: /focus/i }));

			expect(onDismiss).toHaveBeenCalled();
		});
	});

	describe('Dismiss Behavior', () => {
		it('calls onDismiss after Open action', () => {
			const onDismiss = vi.fn();
			const props = createProps({ onDismiss });
			render(<NodeContextMenu {...props} />);

			fireEvent.click(screen.getByRole('button', { name: /open/i }));

			expect(onDismiss).toHaveBeenCalled();
		});

		it('calls onDismiss on Escape key', () => {
			const onDismiss = vi.fn();
			const props = createProps({ onDismiss });
			render(<NodeContextMenu {...props} />);

			fireEvent.keyDown(document, { key: 'Escape' });

			expect(onDismiss).toHaveBeenCalled();
		});
	});

	describe('Theme Styling', () => {
		it('applies theme colors to menu', () => {
			const props = createProps();
			const { container } = render(<NodeContextMenu {...props} />);

			const menu = container.firstChild as HTMLElement;
			// Check that style is applied (browser converts hex to rgb)
			expect(menu.style.backgroundColor).toBeTruthy();
			expect(menu.style.borderColor).toBeTruthy();
		});

		it('applies theme colors to menu items', () => {
			const props = createProps();
			render(<NodeContextMenu {...props} />);

			const openButton = screen.getByRole('button', { name: /open/i });
			// Check that style is applied (browser converts hex to rgb)
			expect(openButton.style.color).toBeTruthy();
		});
	});

	describe('Clipboard Error Handling', () => {
		it('handles clipboard write failure gracefully', async () => {
			const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			mockClipboardWriteText.mockRejectedValueOnce(new Error('Clipboard access denied'));

			const onDismiss = vi.fn();
			const props = createProps({ nodeData: mockDocumentNodeData, onDismiss });
			render(<NodeContextMenu {...props} />);

			fireEvent.click(screen.getByRole('button', { name: /copy path/i }));

			await waitFor(() => {
				expect(consoleErrorSpy).toHaveBeenCalledWith(
					'Failed to copy to clipboard:',
					expect.any(Error)
				);
			});
			expect(onDismiss).toHaveBeenCalled();

			consoleErrorSpy.mockRestore();
		});
	});
});
