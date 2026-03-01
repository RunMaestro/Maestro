/**
 * Tests for CueHelpModal component
 *
 * CueHelpModal is a help dialog that displays comprehensive documentation
 * about the Maestro Cue event-driven automation feature. It integrates
 * with the layer stack for modal management.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { CueHelpModal } from '../../../renderer/components/CueHelpModal';
import type { Theme } from '../../../renderer/types';

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
	isMacOS: () => false,
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

describe('CueHelpModal', () => {
	const mockOnClose = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		cleanup();
	});

	describe('Rendering', () => {
		it('should render the modal container', () => {
			render(<CueHelpModal theme={mockTheme} onClose={mockOnClose} />);

			const backdrop = document.querySelector('.fixed.inset-0');
			expect(backdrop).toBeInTheDocument();
		});

		it('should render the header with title', () => {
			render(<CueHelpModal theme={mockTheme} onClose={mockOnClose} />);

			expect(screen.getByText('Maestro Cue Guide')).toBeInTheDocument();
		});

		it('should render the close button (X icon) in header', () => {
			render(<CueHelpModal theme={mockTheme} onClose={mockOnClose} />);

			const closeButtons = screen.getAllByRole('button');
			expect(closeButtons.length).toBeGreaterThan(0);
		});

		it('should render the "Got it" button in footer', () => {
			render(<CueHelpModal theme={mockTheme} onClose={mockOnClose} />);

			expect(screen.getByText('Got it')).toBeInTheDocument();
		});
	});

	describe('Content Sections', () => {
		beforeEach(() => {
			render(<CueHelpModal theme={mockTheme} onClose={mockOnClose} />);
		});

		it('should render What is Maestro Cue section', () => {
			expect(screen.getByText('What is Maestro Cue?')).toBeInTheDocument();
			expect(screen.getByText(/event-driven automation system/)).toBeInTheDocument();
		});

		it('should render Getting Started section', () => {
			expect(screen.getByText('Getting Started')).toBeInTheDocument();
			expect(screen.getByText(/maestro-cue.yaml/)).toBeInTheDocument();
		});

		it('should render Encore Feature callout', () => {
			expect(screen.getByText(/Encore Feature/)).toBeInTheDocument();
		});

		it('should render minimal YAML example', () => {
			expect(screen.getByText(/My First Cue/)).toBeInTheDocument();
		});

		it('should render Event Types section', () => {
			expect(screen.getByText('Event Types')).toBeInTheDocument();
		});

		it('should render all three event types', () => {
			expect(screen.getByText('Interval')).toBeInTheDocument();
			expect(screen.getByText('File Watch')).toBeInTheDocument();
			expect(screen.getByText('Agent Completed')).toBeInTheDocument();
		});

		it('should render event type codes', () => {
			expect(screen.getByText('time.interval')).toBeInTheDocument();
			expect(screen.getByText('file.changed')).toBeInTheDocument();
			expect(screen.getByText('agent.completed')).toBeInTheDocument();
		});

		it('should render Template Variables section', () => {
			expect(screen.getByText('Template Variables')).toBeInTheDocument();
		});

		it('should render CUE template variables', () => {
			expect(screen.getByText('{{CUE_EVENT_TYPE}}')).toBeInTheDocument();
			expect(screen.getByText('{{CUE_EVENT_TIMESTAMP}}')).toBeInTheDocument();
			expect(screen.getByText('{{CUE_TRIGGER_NAME}}')).toBeInTheDocument();
			expect(screen.getByText('{{CUE_RUN_ID}}')).toBeInTheDocument();
			expect(screen.getByText('{{CUE_FILE_PATH}}')).toBeInTheDocument();
			expect(screen.getByText('{{CUE_FILE_NAME}}')).toBeInTheDocument();
			expect(screen.getByText('{{CUE_FILE_DIR}}')).toBeInTheDocument();
			expect(screen.getByText('{{CUE_FILE_EXT}}')).toBeInTheDocument();
			expect(screen.getByText('{{CUE_SOURCE_SESSION}}')).toBeInTheDocument();
			expect(screen.getByText('{{CUE_SOURCE_OUTPUT}}')).toBeInTheDocument();
		});

		it('should mention standard Maestro template variables', () => {
			expect(screen.getByText('{{AGENT_NAME}}')).toBeInTheDocument();
			expect(screen.getByText('{{DATE}}')).toBeInTheDocument();
		});

		it('should render Multi-Agent Orchestration section', () => {
			expect(screen.getByText('Multi-Agent Orchestration')).toBeInTheDocument();
		});

		it('should render fan-out and fan-in patterns', () => {
			expect(screen.getByText(/Fan-Out:/)).toBeInTheDocument();
			expect(screen.getByText(/Fan-In:/)).toBeInTheDocument();
		});

		it('should render ASCII orchestration diagram', () => {
			expect(screen.getByText(/fan-out/)).toBeInTheDocument();
			// fan-in appears in both orchestration diagram and coordination patterns
			const fanInElements = screen.getAllByText(/fan-in/);
			expect(fanInElements.length).toBeGreaterThan(0);
		});

		it('should render Timeouts & Failure Handling section', () => {
			expect(screen.getByText('Timeouts & Failure Handling')).toBeInTheDocument();
			expect(screen.getByText(/Default timeout is 30 minutes/)).toBeInTheDocument();
		});

		it('should render timeout YAML example', () => {
			expect(screen.getByText(/timeout_minutes: 60/)).toBeInTheDocument();
			// timeout_on_fail appears both as inline code and in the code example
			const timeoutOnFailElements = screen.getAllByText(/timeout_on_fail: continue/);
			expect(timeoutOnFailElements.length).toBeGreaterThan(0);
		});

		it('should render AI YAML Editor section', () => {
			expect(screen.getByText('AI YAML Editor')).toBeInTheDocument();
			expect(screen.getByText(/Describe what you want in plain text/)).toBeInTheDocument();
		});

		it('should render keyboard shortcut tip for opening Cue dashboard', () => {
			const kbdElements = document.querySelectorAll('kbd');
			const hasShortcut = Array.from(kbdElements).some((kbd) => kbd.textContent?.includes('Meta'));
			expect(hasShortcut).toBe(true);
		});

		it('should render Coordination Patterns section', () => {
			expect(screen.getByText('Coordination Patterns')).toBeInTheDocument();
		});

		it('should render all coordination pattern names', () => {
			expect(screen.getByText('Scheduled Task')).toBeInTheDocument();
			expect(screen.getByText('File Enrichment')).toBeInTheDocument();
			expect(screen.getByText('Research Swarm')).toBeInTheDocument();
			expect(screen.getByText('Sequential Chain')).toBeInTheDocument();
			expect(screen.getByText('Debate')).toBeInTheDocument();
		});

		it('should render pattern ASCII diagrams', () => {
			// Check for arrow entities rendered in the diagrams
			const diagramElements = document.querySelectorAll('.font-mono');
			expect(diagramElements.length).toBeGreaterThan(0);
		});

		it('should render YAML editor pattern presets tip', () => {
			expect(screen.getByText(/pattern presets to get started quickly/)).toBeInTheDocument();
		});
	});

	describe('Theme Integration', () => {
		it('should apply theme background color to modal', () => {
			render(<CueHelpModal theme={mockTheme} onClose={mockOnClose} />);

			const modal = document.querySelector('[style*="width: 672px"]');
			expect(modal).toHaveStyle({ backgroundColor: mockTheme.colors.bgSidebar });
		});

		it('should apply theme text color to title', () => {
			render(<CueHelpModal theme={mockTheme} onClose={mockOnClose} />);

			const title = screen.getByText('Maestro Cue Guide');
			expect(title).toHaveStyle({ color: mockTheme.colors.textMain });
		});

		it('should apply theme accent color to "Got it" button', () => {
			render(<CueHelpModal theme={mockTheme} onClose={mockOnClose} />);

			const gotItButton = screen.getByText('Got it');
			expect(gotItButton).toHaveStyle({ backgroundColor: mockTheme.colors.accent });
		});
	});

	describe('User Interactions', () => {
		it('should call onClose when backdrop is clicked', () => {
			render(<CueHelpModal theme={mockTheme} onClose={mockOnClose} />);

			const dialog = screen.getByRole('dialog');
			fireEvent.click(dialog);

			expect(mockOnClose).toHaveBeenCalledTimes(1);
		});

		it('should call onClose when X button is clicked', () => {
			render(<CueHelpModal theme={mockTheme} onClose={mockOnClose} />);

			const closeButton = screen.getByRole('button', { name: 'Close modal' });
			fireEvent.click(closeButton);

			expect(mockOnClose).toHaveBeenCalledTimes(1);
		});

		it('should call onClose when "Got it" button is clicked', () => {
			render(<CueHelpModal theme={mockTheme} onClose={mockOnClose} />);

			const gotItButton = screen.getByText('Got it');
			fireEvent.click(gotItButton);

			expect(mockOnClose).toHaveBeenCalledTimes(1);
		});
	});

	describe('Layer Stack Integration', () => {
		it('should register layer on mount', () => {
			render(<CueHelpModal theme={mockTheme} onClose={mockOnClose} />);

			expect(mockRegisterLayer).toHaveBeenCalledTimes(1);
			expect(mockRegisterLayer).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'modal',
				})
			);
		});

		it('should register layer with correct onEscape handler', () => {
			render(<CueHelpModal theme={mockTheme} onClose={mockOnClose} />);

			const registerCall = mockRegisterLayer.mock.calls[0][0];
			expect(registerCall.onEscape).toBeDefined();

			registerCall.onEscape();
			expect(mockOnClose).toHaveBeenCalledTimes(1);
		});

		it('should unregister layer on unmount', () => {
			const { unmount } = render(<CueHelpModal theme={mockTheme} onClose={mockOnClose} />);

			unmount();

			expect(mockUnregisterLayer).toHaveBeenCalledTimes(1);
			expect(mockUnregisterLayer).toHaveBeenCalledWith('layer-123');
		});
	});

	describe('Accessibility', () => {
		it('should have proper modal structure', () => {
			render(<CueHelpModal theme={mockTheme} onClose={mockOnClose} />);

			const modalContainer = document.querySelector(
				'.fixed.inset-0.flex.items-center.justify-center'
			);
			expect(modalContainer).toBeInTheDocument();
		});

		it('should have scrollable content area', () => {
			render(<CueHelpModal theme={mockTheme} onClose={mockOnClose} />);

			const contentArea = document.querySelector('.overflow-y-auto');
			expect(contentArea).toBeInTheDocument();
		});

		it('should render main title as h2', () => {
			render(<CueHelpModal theme={mockTheme} onClose={mockOnClose} />);

			const mainTitle = screen.getByRole('heading', { level: 2 });
			expect(mainTitle).toHaveTextContent('Maestro Cue Guide');
		});

		it('should have kbd elements for keyboard shortcuts', () => {
			render(<CueHelpModal theme={mockTheme} onClose={mockOnClose} />);

			const kbdElements = document.querySelectorAll('kbd');
			expect(kbdElements.length).toBeGreaterThan(0);
		});
	});

	describe('Content Structure', () => {
		it('should render icons for each section', () => {
			render(<CueHelpModal theme={mockTheme} onClose={mockOnClose} />);

			const svgElements = document.querySelectorAll('svg');
			expect(svgElements.length).toBeGreaterThan(5);
		});

		it('should render code elements for technical content', () => {
			render(<CueHelpModal theme={mockTheme} onClose={mockOnClose} />);

			const codeElements = document.querySelectorAll('code');
			expect(codeElements.length).toBeGreaterThan(0);
		});

		it('should have max-width constraint on modal', () => {
			render(<CueHelpModal theme={mockTheme} onClose={mockOnClose} />);

			const modal = document.querySelector('[style*="width: 672px"]');
			expect(modal).toBeInTheDocument();
		});

		it('should have max-height constraint for scrolling', () => {
			render(<CueHelpModal theme={mockTheme} onClose={mockOnClose} />);

			const modal = document.querySelector('[style*="max-height: 85vh"]');
			expect(modal).toBeInTheDocument();
		});
	});
});
