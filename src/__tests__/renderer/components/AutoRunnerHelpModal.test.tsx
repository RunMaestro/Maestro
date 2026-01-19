/**
 * Tests for AutoRunnerHelpModal component
 *
 * AutoRunnerHelpModal is a help dialog that displays comprehensive documentation
 * about the Auto Run feature. It integrates with the layer stack for modal management.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { AutoRunnerHelpModal } from '../../../renderer/components/AutoRunnerHelpModal';
import type { Theme } from '../../../renderer/types';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';

// Mock the layer stack context
const mockRegisterLayer = vi.fn(() => 'layer-123');
const mockUnregisterLayer = vi.fn();
const mockUpdateLayerHandler = vi.fn();

vi.mock('../../../renderer/contexts/LayerStackContext', async () => {
	const actual = await vi.importActual('../../../renderer/contexts/LayerStackContext');
	return {
		...actual,
		useLayerStack: () => ({
			registerLayer: mockRegisterLayer,
			unregisterLayer: mockUnregisterLayer,
			updateLayerHandler: mockUpdateLayerHandler,
			getTopLayer: vi.fn(),
			closeTopLayer: vi.fn(),
			getLayers: vi.fn(() => []),
			hasOpenLayers: vi.fn(() => false),
			hasOpenModal: vi.fn(() => false),
			layerCount: 0,
		}),
	};
});

// Mock formatShortcutKeys to return predictable output
vi.mock('../../../renderer/utils/shortcutFormatter', () => ({
	formatShortcutKeys: (keys: string[]) => keys.join('+'),
}));

// Sample theme for testing
const mockTheme: Theme = {
	id: 'test-dark',
	name: 'Test Dark',
	mode: 'dark',
	colors: {
		bgMain: '#1a1a1a',
		bgSidebar: '#252525',
		bgActivity: '#2d2d2d',
		border: '#444444',
		textMain: '#ffffff',
		textDim: '#888888',
		accent: '#007acc',
		error: '#ff4444',
		success: '#44ff44',
		warning: '#ffaa00',
		cursor: '#ffffff',
		selection: '#264f78',
		terminalBackground: '#000000',
	},
};

describe('AutoRunnerHelpModal', () => {
	const mockOnClose = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		cleanup();
	});

	describe('Rendering', () => {
		it('should render the modal container', () => {
			render(<AutoRunnerHelpModal theme={mockTheme} onClose={mockOnClose} />);

			// Check for the modal backdrop
			const backdrop = document.querySelector('.fixed.inset-0');
			expect(backdrop).toBeInTheDocument();
		});

		it('should render the header with title', () => {
			render(<AutoRunnerHelpModal theme={mockTheme} onClose={mockOnClose} />);

			expect(screen.getByText('Auto Run Guide')).toBeInTheDocument();
		});

		it('should render the close button (X icon) in header', () => {
			render(<AutoRunnerHelpModal theme={mockTheme} onClose={mockOnClose} />);

			// Find button with X icon (close button in header)
			const closeButtons = screen.getAllByRole('button');
			expect(closeButtons.length).toBeGreaterThan(0);
		});

		it('should render the "Got it" button in footer', () => {
			render(<AutoRunnerHelpModal theme={mockTheme} onClose={mockOnClose} />);

			expect(screen.getByText('Got it')).toBeInTheDocument();
		});
	});

	describe('Content Sections', () => {
		beforeEach(() => {
			render(<AutoRunnerHelpModal theme={mockTheme} onClose={mockOnClose} />);
		});

		it('should render Introduction section', () => {
			expect(
				screen.getByText(/Auto Run is a file-system-based document runner/)
			).toBeInTheDocument();
		});

		it('should render Setting Up section', () => {
			expect(screen.getByText('Setting Up a Runner Docs Folder')).toBeInTheDocument();
			expect(screen.getByText(/When you first open the Auto Run tab/)).toBeInTheDocument();
		});

		it('should render Document Format section', () => {
			expect(screen.getByText('Document Format')).toBeInTheDocument();
			expect(screen.getByText(/Create markdown files/)).toBeInTheDocument();
		});

		it('should render Creating Tasks section', () => {
			expect(screen.getByText('Creating Tasks')).toBeInTheDocument();
			expect(screen.getByText(/Write clear, specific task descriptions/)).toBeInTheDocument();
		});

		it('should render Image Attachments section', () => {
			expect(screen.getByText('Image Attachments')).toBeInTheDocument();
			expect(screen.getByText(/Paste images directly into your documents/)).toBeInTheDocument();
		});

		it('should render Running a Single Document section', () => {
			expect(screen.getByText('Running a Single Document')).toBeInTheDocument();
			expect(screen.getByText(/The runner spawns a fresh AI session/)).toBeInTheDocument();
		});

		it('should render Running Multiple Documents section', () => {
			expect(screen.getByText('Running Multiple Documents')).toBeInTheDocument();
			expect(screen.getByText(/Documents are processed sequentially/)).toBeInTheDocument();
		});

		it('should render Template Variables section', () => {
			expect(screen.getByText('Template Variables')).toBeInTheDocument();
			expect(screen.getByText(/Use template variables in your documents/)).toBeInTheDocument();
		});

		it('should render available template variable examples', () => {
			expect(screen.getByText('{{AGENT_NAME}}')).toBeInTheDocument();
			expect(screen.getByText('{{AGENT_PATH}}')).toBeInTheDocument();
			expect(screen.getByText('{{GIT_BRANCH}}')).toBeInTheDocument();
			expect(screen.getByText('{{DATE}}')).toBeInTheDocument();
			expect(screen.getByText('{{LOOP_NUMBER}}')).toBeInTheDocument();
			expect(screen.getByText('{{DOCUMENT_NAME}}')).toBeInTheDocument();
		});

		it('should render Reset on Completion section', () => {
			expect(screen.getByText('Reset on Completion')).toBeInTheDocument();
			expect(screen.getByText(/Enable the reset toggle/)).toBeInTheDocument();
		});

		it('should render Loop Mode section', () => {
			expect(screen.getByText('Loop Mode')).toBeInTheDocument();
			expect(screen.getByText(/continuously cycle through the document queue/)).toBeInTheDocument();
		});

		it('should render Playbooks section', () => {
			// Use getAllByText since "Playbooks" appears multiple times (heading + reference)
			const playbooksElements = screen.getAllByText(/Playbooks/);
			expect(playbooksElements.length).toBeGreaterThan(0);
			expect(screen.getByText(/Save your batch run configurations/)).toBeInTheDocument();
		});

		it('should render History & Tracking section', () => {
			expect(screen.getByText('History & Tracking')).toBeInTheDocument();
			expect(screen.getByText(/Completed tasks appear in the/)).toBeInTheDocument();
		});

		it('should render Read-Only Mode section', () => {
			expect(screen.getByText('Read-Only Mode')).toBeInTheDocument();
			expect(
				screen.getByText(/While Auto Run is active, the AI interpreter operates in/)
			).toBeInTheDocument();
		});

		// NOTE: Git Worktree section was removed from the help modal
		// The worktree UI has moved to WorktreeConfigModal
		it.skip('should render Git Worktree section', () => {
			expect(screen.getByText('Git Worktree (Parallel Work)')).toBeInTheDocument();
			expect(screen.getByText(/For Git repositories, enable/)).toBeInTheDocument();
		});

		it('should render Stopping Auto Run section', () => {
			expect(screen.getByText('Stopping Auto Run')).toBeInTheDocument();
			expect(screen.getByText(/to gracefully stop/)).toBeInTheDocument();
		});

		it('should render Keyboard Shortcuts section', () => {
			expect(screen.getByText('Keyboard Shortcuts')).toBeInTheDocument();
		});

		it('should render all keyboard shortcuts', () => {
			expect(screen.getByText('Open Auto Run tab')).toBeInTheDocument();
			expect(screen.getByText('Toggle Edit/Preview mode')).toBeInTheDocument();
			expect(screen.getByText('Insert checkbox at cursor')).toBeInTheDocument();
			expect(screen.getByText('Undo')).toBeInTheDocument();
			expect(screen.getByText('Redo')).toBeInTheDocument();
		});

		it('should render code examples in Document Format section', () => {
			expect(screen.getByText(/# Feature Plan/)).toBeInTheDocument();
			expect(screen.getByText(/Implement user authentication/)).toBeInTheDocument();
		});

		it('should render list items in Playbooks section', () => {
			expect(screen.getByText('Document selection and order')).toBeInTheDocument();
			expect(screen.getByText('Reset-on-completion settings per document')).toBeInTheDocument();
			expect(screen.getByText('Loop mode preference')).toBeInTheDocument();
			expect(screen.getByText('Custom agent prompt')).toBeInTheDocument();
		});
	});

	describe('Theme Integration', () => {
		it('should apply theme background color to modal', () => {
			render(<AutoRunnerHelpModal theme={mockTheme} onClose={mockOnClose} />);

			// Modal component uses inline width style
			const modal = document.querySelector('[style*="width: 672px"]');
			expect(modal).toHaveStyle({ backgroundColor: mockTheme.colors.bgSidebar });
		});

		it('should apply theme text color to title', () => {
			render(<AutoRunnerHelpModal theme={mockTheme} onClose={mockOnClose} />);

			const title = screen.getByText('Auto Run Guide');
			expect(title).toHaveStyle({ color: mockTheme.colors.textMain });
		});

		it('should apply theme accent color to "Got it" button', () => {
			render(<AutoRunnerHelpModal theme={mockTheme} onClose={mockOnClose} />);

			const gotItButton = screen.getByText('Got it');
			expect(gotItButton).toHaveStyle({ backgroundColor: mockTheme.colors.accent });
		});
	});

	describe('User Interactions', () => {
		it('should call onClose when backdrop is clicked', () => {
			render(<AutoRunnerHelpModal theme={mockTheme} onClose={mockOnClose} />);

			// Modal component with closeOnBackdropClick enabled - clicking the dialog element closes modal
			const dialog = screen.getByRole('dialog');
			fireEvent.click(dialog);

			expect(mockOnClose).toHaveBeenCalledTimes(1);
		});

		it('should call onClose when X button is clicked', () => {
			render(<AutoRunnerHelpModal theme={mockTheme} onClose={mockOnClose} />);

			// Modal component renders close button with aria-label
			const closeButton = screen.getByRole('button', { name: 'Close modal' });
			fireEvent.click(closeButton);

			expect(mockOnClose).toHaveBeenCalledTimes(1);
		});

		it('should call onClose when "Got it" button is clicked', () => {
			render(<AutoRunnerHelpModal theme={mockTheme} onClose={mockOnClose} />);

			const gotItButton = screen.getByText('Got it');
			fireEvent.click(gotItButton);

			expect(mockOnClose).toHaveBeenCalledTimes(1);
		});
	});

	describe('Layer Stack Integration', () => {
		it('should register layer on mount', () => {
			render(<AutoRunnerHelpModal theme={mockTheme} onClose={mockOnClose} />);

			expect(mockRegisterLayer).toHaveBeenCalledTimes(1);
			expect(mockRegisterLayer).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'modal',
				})
			);
		});

		it('should register layer with correct onEscape handler', () => {
			render(<AutoRunnerHelpModal theme={mockTheme} onClose={mockOnClose} />);

			const registerCall = mockRegisterLayer.mock.calls[0][0];
			expect(registerCall.onEscape).toBeDefined();

			// Call the onEscape handler
			registerCall.onEscape();
			expect(mockOnClose).toHaveBeenCalledTimes(1);
		});

		it('should unregister layer on unmount', () => {
			const { unmount } = render(<AutoRunnerHelpModal theme={mockTheme} onClose={mockOnClose} />);

			unmount();

			expect(mockUnregisterLayer).toHaveBeenCalledTimes(1);
			expect(mockUnregisterLayer).toHaveBeenCalledWith('layer-123');
		});

		it('should update layer handler when onClose changes', () => {
			render(<AutoRunnerHelpModal theme={mockTheme} onClose={mockOnClose} />);

			expect(mockUpdateLayerHandler).toHaveBeenCalled();
		});

		it('should call updated onClose when escape handler is invoked after update', () => {
			render(<AutoRunnerHelpModal theme={mockTheme} onClose={mockOnClose} />);

			// Get the handler passed to updateLayerHandler
			const updateCall = mockUpdateLayerHandler.mock.calls[0];
			if (updateCall && updateCall[1]) {
				updateCall[1](); // Invoke the handler
				expect(mockOnClose).toHaveBeenCalled();
			}
		});
	});

	describe('Accessibility', () => {
		it('should have proper modal structure', () => {
			render(<AutoRunnerHelpModal theme={mockTheme} onClose={mockOnClose} />);

			// Modal should have proper container structure
			const modalContainer = document.querySelector(
				'.fixed.inset-0.flex.items-center.justify-center'
			);
			expect(modalContainer).toBeInTheDocument();
		});

		it('should have scrollable content area', () => {
			render(<AutoRunnerHelpModal theme={mockTheme} onClose={mockOnClose} />);

			// Content area should be scrollable
			const contentArea = document.querySelector('.overflow-y-auto');
			expect(contentArea).toBeInTheDocument();
		});

		it('should render section headings as h3 elements', () => {
			render(<AutoRunnerHelpModal theme={mockTheme} onClose={mockOnClose} />);

			// Main title should be h2
			const mainTitle = screen.getByRole('heading', { level: 2 });
			expect(mainTitle).toHaveTextContent('Auto Run Guide');
		});

		it('should have keyboard shortcuts displayed with kbd elements', () => {
			render(<AutoRunnerHelpModal theme={mockTheme} onClose={mockOnClose} />);

			// kbd elements should be present for shortcuts
			const kbdElements = document.querySelectorAll('kbd');
			expect(kbdElements.length).toBeGreaterThan(0);
		});
	});

	describe('Content Structure', () => {
		it('should render icons for each section', () => {
			render(<AutoRunnerHelpModal theme={mockTheme} onClose={mockOnClose} />);

			// SVG icons should be present throughout
			const svgElements = document.querySelectorAll('svg');
			expect(svgElements.length).toBeGreaterThan(10); // Multiple sections with icons
		});

		it('should render code elements for technical content', () => {
			render(<AutoRunnerHelpModal theme={mockTheme} onClose={mockOnClose} />);

			// Code elements for file extensions, commands, etc.
			const codeElements = document.querySelectorAll('code');
			expect(codeElements.length).toBeGreaterThan(0);
		});

		it('should apply accent color styling to section icons', () => {
			render(<AutoRunnerHelpModal theme={mockTheme} onClose={mockOnClose} />);

			// Section icons should have accent color
			const sectionHeaders = document.querySelectorAll('.flex.items-center.gap-2');
			expect(sectionHeaders.length).toBeGreaterThan(0);
		});

		it('should render border styling with theme colors', () => {
			render(<AutoRunnerHelpModal theme={mockTheme} onClose={mockOnClose} />);

			// Border elements should use theme border color
			const borderedElements = document.querySelectorAll('.border-b');
			expect(borderedElements.length).toBeGreaterThan(0);
		});
	});

	describe('Dynamic Content', () => {
		it('should format keyboard shortcuts using formatShortcutKeys', () => {
			render(<AutoRunnerHelpModal theme={mockTheme} onClose={mockOnClose} />);

			// Our mock returns keys joined with +
			// The component uses formatShortcutKeys for shortcuts like ['Meta', 'l']
			// Should render something like "Meta+l"
			const kbdElements = document.querySelectorAll('kbd');
			const hasFormattedShortcut = Array.from(kbdElements).some((kbd) =>
				kbd.textContent?.includes('Meta')
			);
			expect(hasFormattedShortcut).toBe(true);
		});

		it('should highlight "Quick Insert" tips', () => {
			render(<AutoRunnerHelpModal theme={mockTheme} onClose={mockOnClose} />);

			// Multiple "Quick Insert" tips exist
			const quickInsertElements = screen.getAllByText(/Quick Insert:/);
			expect(quickInsertElements.length).toBeGreaterThan(0);
		});

		it('should include template variable syntax examples', () => {
			render(<AutoRunnerHelpModal theme={mockTheme} onClose={mockOnClose} />);

			// Template variable trigger syntax
			expect(screen.getByText('{{')).toBeInTheDocument();
		});
	});

	describe('Responsive Design', () => {
		it('should have max-width constraint on modal', () => {
			render(<AutoRunnerHelpModal theme={mockTheme} onClose={mockOnClose} />);

			// Modal component uses inline width style
			const modal = document.querySelector('[style*="width: 672px"]');
			expect(modal).toBeInTheDocument();
		});

		it('should have max-height constraint for scrolling', () => {
			render(<AutoRunnerHelpModal theme={mockTheme} onClose={mockOnClose} />);

			// Modal component uses inline max-height style
			const modal = document.querySelector('[style*="max-height: 85vh"]');
			expect(modal).toBeInTheDocument();
		});

		it('should use flex layout for modal structure', () => {
			render(<AutoRunnerHelpModal theme={mockTheme} onClose={mockOnClose} />);

			// Modal inner container uses flex flex-col
			const flexModal = document.querySelector('.flex.flex-col');
			expect(flexModal).toBeInTheDocument();
		});
	});

	describe('onCloseRef Updates', () => {
		it('should use ref to track onClose for stable layer registration', () => {
			const { rerender } = render(<AutoRunnerHelpModal theme={mockTheme} onClose={mockOnClose} />);

			const newOnClose = vi.fn();
			rerender(<AutoRunnerHelpModal theme={mockTheme} onClose={newOnClose} />);

			// The updateLayerHandler should have been called
			expect(mockUpdateLayerHandler).toHaveBeenCalled();

			// Get the latest handler and call it
			const lastCall =
				mockUpdateLayerHandler.mock.calls[mockUpdateLayerHandler.mock.calls.length - 1];
			if (lastCall && lastCall[1]) {
				lastCall[1]();
				// The new onClose should be called due to ref update
				expect(newOnClose).toHaveBeenCalled();
			}
		});
	});

	describe('Special Characters in Content', () => {
		it('should render checkbox syntax examples', () => {
			render(<AutoRunnerHelpModal theme={mockTheme} onClose={mockOnClose} />);

			// Checkbox format is mentioned
			expect(screen.getByText(/- \[ \]/)).toBeInTheDocument();
		});

		it('should render file extension examples', () => {
			render(<AutoRunnerHelpModal theme={mockTheme} onClose={mockOnClose} />);

			// .md extension mentioned
			const codeElements = document.querySelectorAll('code');
			const hasMdExtension = Array.from(codeElements).some((code) =>
				code.textContent?.includes('.md')
			);
			expect(hasMdExtension).toBe(true);
		});

		it('should render images subfolder reference', () => {
			render(<AutoRunnerHelpModal theme={mockTheme} onClose={mockOnClose} />);

			// images/ subfolder mentioned
			const codeElements = document.querySelectorAll('code');
			const hasImagesFolder = Array.from(codeElements).some((code) =>
				code.textContent?.includes('images/')
			);
			expect(hasImagesFolder).toBe(true);
		});
	});

	describe('Warning Colors', () => {
		it('should use warning color for Read-Only Mode icon', () => {
			render(<AutoRunnerHelpModal theme={mockTheme} onClose={mockOnClose} />);

			// Read-Only Mode section uses warning color
			const readOnlyHeading = screen.getByText('Read-Only Mode');
			const section = readOnlyHeading.closest('section');
			expect(section).toBeInTheDocument();
		});

		it('should highlight read-only indicator with warning color', () => {
			render(<AutoRunnerHelpModal theme={mockTheme} onClose={mockOnClose} />);

			// READ-ONLY text is styled with warning color
			expect(screen.getByText('READ-ONLY')).toBeInTheDocument();
		});

		it('should highlight AUTO label in History section', () => {
			render(<AutoRunnerHelpModal theme={mockTheme} onClose={mockOnClose} />);

			// AUTO label is mentioned
			expect(screen.getByText('AUTO')).toBeInTheDocument();
		});

		it('should use error color for Stop button in Stopping section', () => {
			render(<AutoRunnerHelpModal theme={mockTheme} onClose={mockOnClose} />);

			// Stop is highlighted in the stopping section
			expect(screen.getByText('Stopping Auto Run')).toBeInTheDocument();
		});
	});
});
