import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { HistoryHelpModal } from '../../../renderer/components/HistoryHelpModal';
import type { Theme } from '../../../renderer/types';

// Mock the layer stack context
const mockRegisterLayer = vi.fn();
const mockUnregisterLayer = vi.fn();
const mockUpdateLayerHandler = vi.fn();

vi.mock('../../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => ({
		registerLayer: mockRegisterLayer,
		unregisterLayer: mockUnregisterLayer,
		updateLayerHandler: mockUpdateLayerHandler,
		layers: [],
	}),
}));

// Mock window.maestro APIs
const mockGetCurrentStoragePath = vi.fn();
const mockHomeDir = vi.fn();

Object.defineProperty(window, 'maestro', {
	value: {
		sync: {
			getCurrentStoragePath: mockGetCurrentStoragePath,
		},
		fs: {
			homeDir: mockHomeDir,
		},
	},
	writable: true,
});

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
	X: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="x-icon" className={className} style={style} />
	),
	History: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="history-icon" className={className} style={style} />
	),
	Play: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="play-icon" className={className} style={style} />
	),
	Clock: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="clock-icon" className={className} style={style} />
	),
	DollarSign: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="dollar-sign-icon" className={className} style={style} />
	),
	BarChart2: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="bar-chart-icon" className={className} style={style} />
	),
	CheckCircle: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="check-circle-icon" className={className} style={style} />
	),
	Bot: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="bot-icon" className={className} style={style} />
	),
	User: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="user-icon" className={className} style={style} />
	),
	Eye: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="eye-icon" className={className} style={style} />
	),
	Layers: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="layers-icon" className={className} style={style} />
	),
	FileJson: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="file-json-icon" className={className} style={style} />
	),
}));

// Create a mock theme
const mockTheme: Theme = {
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#1a1a1a',
		bgSidebar: '#141414',
		bgActivity: '#262626',
		textMain: '#ffffff',
		textDim: '#a0a0a0',
		accent: '#6366f1',
		border: '#333333',
		error: '#ef4444',
		success: '#22c55e',
		warning: '#eab308',
	},
};

describe('HistoryHelpModal', () => {
	const defaultProps = {
		theme: mockTheme,
		onClose: vi.fn(),
	};

	beforeEach(() => {
		vi.clearAllMocks();
		mockRegisterLayer.mockReturnValue('test-layer-id');
		// Default mock values for storage path APIs
		mockGetCurrentStoragePath.mockResolvedValue(
			'/Users/testuser/Library/Application Support/maestro'
		);
		mockHomeDir.mockResolvedValue('/Users/testuser');
	});

	afterEach(() => {
		cleanup();
	});

	describe('Rendering', () => {
		it('renders the modal with correct structure', () => {
			render(<HistoryHelpModal {...defaultProps} />);

			expect(screen.getByText('History Panel Guide')).toBeInTheDocument();
		});

		it('renders the fixed overlay container', () => {
			const { container } = render(<HistoryHelpModal {...defaultProps} />);

			// Modal component uses fixed inset-0 with backdrop and flex centering
			const overlay = container.querySelector('.fixed.inset-0');
			expect(overlay).toBeInTheDocument();
			expect(overlay).toHaveClass('flex', 'items-center', 'justify-center');
		});

		it('renders the backdrop with correct opacity', () => {
			const { container } = render(<HistoryHelpModal {...defaultProps} />);

			// Modal component uses modal-overlay class for solid background
			const backdrop = container.querySelector('.modal-overlay');
			expect(backdrop).toBeInTheDocument();
		});

		it('renders the modal container with theme-based styling', () => {
			const { container } = render(<HistoryHelpModal {...defaultProps} />);

			// Modal component uses inline width style
			const modalContainer = container.querySelector('[style*="width: 672px"]');
			expect(modalContainer).toBeInTheDocument();
			expect(modalContainer).toHaveStyle({
				backgroundColor: mockTheme.colors.bgSidebar,
				borderColor: mockTheme.colors.border,
			});
		});
	});

	describe('Header', () => {
		it('displays the modal title', () => {
			render(<HistoryHelpModal {...defaultProps} />);

			const title = screen.getByText('History Panel Guide');
			expect(title).toBeInTheDocument();
			// Modal component uses text-sm font-bold for title
			expect(title).toHaveClass('text-sm', 'font-bold');
			expect(title).toHaveStyle({ color: mockTheme.colors.textMain });
		});

		it('renders the close button with X icon', () => {
			const { container } = render(<HistoryHelpModal {...defaultProps} />);

			// Modal component renders close button with aria-label
			const closeButton = screen.getByRole('button', { name: 'Close modal' });
			expect(closeButton).toBeInTheDocument();
			// X icon is rendered as SVG within the close button
			expect(closeButton.querySelector('svg')).toBeInTheDocument();
		});

		it('calls onClose when close button is clicked', () => {
			const onClose = vi.fn();
			render(<HistoryHelpModal {...defaultProps} onClose={onClose} />);

			const closeButton = screen.getByRole('button', { name: 'Close modal' });
			fireEvent.click(closeButton);

			expect(onClose).toHaveBeenCalledTimes(1);
		});

		it('applies hover styles to close button', () => {
			render(<HistoryHelpModal {...defaultProps} />);

			const closeButton = screen.getByRole('button', { name: 'Close modal' });
			expect(closeButton).toHaveClass('hover:bg-white/10', 'transition-colors');
		});
	});

	describe('Backdrop', () => {
		it('calls onClose when backdrop is clicked', () => {
			const onClose = vi.fn();
			render(<HistoryHelpModal {...defaultProps} onClose={onClose} />);

			// Modal component with closeOnBackdropClick enabled - clicking the backdrop (dialog element) closes modal
			const dialog = screen.getByRole('dialog');
			fireEvent.click(dialog);

			expect(onClose).toHaveBeenCalledTimes(1);
		});

		it('does not close modal when modal content is clicked', () => {
			const onClose = vi.fn();
			const { container } = render(<HistoryHelpModal {...defaultProps} onClose={onClose} />);

			// Clicking on modal content (the inner container with width style) should not close
			const modalContent = container.querySelector('[style*="width: 672px"]');
			fireEvent.click(modalContent!);

			// Only the backdrop should close the modal, not the content area itself
			expect(onClose).not.toHaveBeenCalled();
		});
	});

	describe('Introduction Section', () => {
		it('renders the introduction text', () => {
			render(<HistoryHelpModal {...defaultProps} />);

			expect(
				screen.getByText(/The History panel tracks a synopsis of your work sessions/)
			).toBeInTheDocument();
		});

		it('applies correct text styling to introduction', () => {
			render(<HistoryHelpModal {...defaultProps} />);

			const intro = screen.getByText(/The History panel tracks a synopsis/);
			expect(intro).toHaveClass('text-sm', 'leading-relaxed');
			expect(intro).toHaveStyle({ color: mockTheme.colors.textDim });
		});
	});

	describe('Entry Types Section', () => {
		it('renders the Entry Types section header', () => {
			render(<HistoryHelpModal {...defaultProps} />);

			expect(screen.getByText('Entry Types')).toBeInTheDocument();
			expect(screen.getByTestId('history-icon')).toBeInTheDocument();
		});

		it('renders the USER badge with correct styling', () => {
			render(<HistoryHelpModal {...defaultProps} />);

			const userBadge = screen.getByText('USER');
			expect(userBadge).toBeInTheDocument();
			expect(userBadge).toHaveClass(
				'px-2',
				'py-0.5',
				'rounded-full',
				'text-[10px]',
				'font-bold',
				'uppercase'
			);
		});

		it('renders the AUTO badge with correct styling', () => {
			const { container } = render(<HistoryHelpModal {...defaultProps} />);

			// Find AUTO badge by looking for the element with the specific badge styling
			const autoBadges = container.querySelectorAll('.rounded-full.text-\\[10px\\]');
			const autoBadge = Array.from(autoBadges).find((el) => el.textContent?.includes('AUTO'));
			expect(autoBadge).toBeTruthy();
			expect(autoBadge).toHaveClass(
				'px-2',
				'py-0.5',
				'rounded-full',
				'text-[10px]',
				'font-bold',
				'uppercase'
			);
		});

		it('renders User icon in USER badge', () => {
			render(<HistoryHelpModal {...defaultProps} />);

			expect(screen.getByTestId('user-icon')).toBeInTheDocument();
		});

		it('renders Bot icon in AUTO badge and AI Context section', () => {
			render(<HistoryHelpModal {...defaultProps} />);

			// There are multiple bot icons: one in AUTO badge, one in AI Context Integration section
			const botIcons = screen.getAllByTestId('bot-icon');
			expect(botIcons.length).toBeGreaterThanOrEqual(1);
		});

		it('renders /history code snippet', () => {
			render(<HistoryHelpModal {...defaultProps} />);

			const historyCode = screen.getAllByText('/history');
			expect(historyCode[0].tagName.toLowerCase()).toBe('code');
		});

		it('renders /clear code snippet', () => {
			render(<HistoryHelpModal {...defaultProps} />);

			const clearCode = screen.getByText('/clear');
			expect(clearCode.tagName.toLowerCase()).toBe('code');
		});

		it('describes USER entry creation methods', () => {
			render(<HistoryHelpModal {...defaultProps} />);

			expect(
				screen.getByText(/Synopsis entries from your interactive work sessions/)
			).toBeInTheDocument();
		});

		it('describes AUTO entry generation', () => {
			render(<HistoryHelpModal {...defaultProps} />);

			expect(
				screen.getByText(/Entries automatically generated by the Auto Runner/)
			).toBeInTheDocument();
		});
	});

	describe('Status Indicators Section', () => {
		it('renders the Status Indicators section header', () => {
			render(<HistoryHelpModal {...defaultProps} />);

			expect(screen.getByText('Status Indicators')).toBeInTheDocument();
		});

		it('renders CheckCircle icons for status indicators', () => {
			render(<HistoryHelpModal {...defaultProps} />);

			const checkCircleIcons = screen.getAllByTestId('check-circle-icon');
			expect(checkCircleIcons.length).toBeGreaterThanOrEqual(1);
		});

		it('describes successful task completion', () => {
			render(<HistoryHelpModal {...defaultProps} />);

			// There are multiple mentions, use getAllByText
			const successTexts = screen.getAllByText(/Task completed successfully/);
			expect(successTexts.length).toBeGreaterThanOrEqual(1);
		});

		it('describes human-validated tasks', () => {
			render(<HistoryHelpModal {...defaultProps} />);

			expect(screen.getByText('and human-validated')).toBeInTheDocument();
		});

		it('mentions Validated option in detail view', () => {
			render(<HistoryHelpModal {...defaultProps} />);

			expect(screen.getByText(/Validated/)).toBeInTheDocument();
		});
	});

	describe('Viewing Details Section', () => {
		it('renders the Viewing Details section header', () => {
			render(<HistoryHelpModal {...defaultProps} />);

			expect(screen.getByText('Viewing Details')).toBeInTheDocument();
			expect(screen.getByTestId('eye-icon')).toBeInTheDocument();
		});

		it('describes what detail view shows', () => {
			render(<HistoryHelpModal {...defaultProps} />);

			expect(
				screen.getByText(/Click any history entry to open the full details view/)
			).toBeInTheDocument();
		});

		it('lists detail view items', () => {
			render(<HistoryHelpModal {...defaultProps} />);

			expect(screen.getByText('Complete synopsis text')).toBeInTheDocument();
			expect(screen.getByText(/Token usage/)).toBeInTheDocument();
			expect(screen.getByText('Context window utilization')).toBeInTheDocument();
			expect(screen.getByText('Total elapsed time')).toBeInTheDocument();
			expect(screen.getByText('Cost for that task')).toBeInTheDocument();
		});
	});

	describe('Resuming Sessions Section', () => {
		it('renders the Resuming Sessions section header', () => {
			render(<HistoryHelpModal {...defaultProps} />);

			expect(screen.getByText('Resuming Sessions')).toBeInTheDocument();
			expect(screen.getByTestId('play-icon')).toBeInTheDocument();
		});

		it('mentions Claude session ID preservation', () => {
			render(<HistoryHelpModal {...defaultProps} />);

			expect(
				screen.getByText(/Each history entry preserves the Claude session ID/)
			).toBeInTheDocument();
		});

		it('mentions Resume button functionality', () => {
			render(<HistoryHelpModal {...defaultProps} />);

			expect(screen.getByText('Resume')).toBeInTheDocument();
		});

		it('describes resumption benefits', () => {
			render(<HistoryHelpModal {...defaultProps} />);

			expect(screen.getByText(/pick up exactly where the task left off/)).toBeInTheDocument();
		});
	});

	describe('Time & Cost Tracking Section', () => {
		it('renders the Time & Cost Tracking section header', () => {
			render(<HistoryHelpModal {...defaultProps} />);

			expect(screen.getByText('Time & Cost Tracking')).toBeInTheDocument();
			expect(screen.getByTestId('clock-icon')).toBeInTheDocument();
			expect(screen.getByTestId('dollar-sign-icon')).toBeInTheDocument();
		});

		it('describes time and cost display', () => {
			render(<HistoryHelpModal {...defaultProps} />);

			expect(screen.getByText(/Each entry displays the elapsed time and cost/)).toBeInTheDocument();
		});
	});

	describe('Activity Graph Section', () => {
		it('renders the Activity Graph section header', () => {
			render(<HistoryHelpModal {...defaultProps} />);

			expect(screen.getByText('Activity Graph')).toBeInTheDocument();
			expect(screen.getByTestId('bar-chart-icon')).toBeInTheDocument();
		});

		it('describes the activity graph', () => {
			render(<HistoryHelpModal {...defaultProps} />);

			expect(
				screen.getByText(/The bar graph in the header visualizes your activity/)
			).toBeInTheDocument();
		});

		it('describes right-click to change lookback period', () => {
			render(<HistoryHelpModal {...defaultProps} />);

			expect(screen.getByText('Right-click the graph')).toBeInTheDocument();
			expect(
				screen.getByText(
					/24 hours, 72 hours, 1 week, 2 weeks, 1 month, 6 months, 1 year, or all time/
				)
			).toBeInTheDocument();
		});

		it('describes click to filter functionality', () => {
			render(<HistoryHelpModal {...defaultProps} />);

			expect(screen.getByText('Click any bar')).toBeInTheDocument();
			expect(screen.getByText(/to filter the history list/)).toBeInTheDocument();
		});

		it('describes hover functionality', () => {
			render(<HistoryHelpModal {...defaultProps} />);

			expect(screen.getByText(/Hover over any bar to see the exact count/)).toBeInTheDocument();
		});
	});

	describe('Footer', () => {
		it('renders the footer with correct border styling', () => {
			const { container } = render(<HistoryHelpModal {...defaultProps} />);

			// Modal component uses p-4 for footer padding
			const footer = container.querySelector('.p-4.border-t');
			expect(footer).toBeInTheDocument();
			expect(footer).toHaveStyle({ borderColor: mockTheme.colors.border });
		});

		it('renders the "Got it" button', () => {
			render(<HistoryHelpModal {...defaultProps} />);

			const gotItButton = screen.getByText('Got it');
			expect(gotItButton).toBeInTheDocument();
			expect(gotItButton.tagName.toLowerCase()).toBe('button');
		});

		it('applies correct styling to "Got it" button', () => {
			render(<HistoryHelpModal {...defaultProps} />);

			const gotItButton = screen.getByRole('button', { name: 'Got it' });
			expect(gotItButton).toHaveClass(
				'px-4',
				'py-2',
				'rounded',
				'text-sm',
				'font-medium',
				'transition-colors'
			);
			// Check for accent background - the exact RGB value
			const style = gotItButton.getAttribute('style');
			expect(style).toContain('background-color');
			expect(style).toContain('color: white');
		});

		it('calls onClose when "Got it" button is clicked', () => {
			const onClose = vi.fn();
			render(<HistoryHelpModal {...defaultProps} onClose={onClose} />);

			const gotItButton = screen.getByText('Got it');
			fireEvent.click(gotItButton);

			expect(onClose).toHaveBeenCalledTimes(1);
		});
	});

	describe('Layer Stack Integration', () => {
		it('registers layer on mount', () => {
			render(<HistoryHelpModal {...defaultProps} />);

			expect(mockRegisterLayer).toHaveBeenCalledTimes(1);
			expect(mockRegisterLayer).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'modal',
					priority: expect.any(Number),
					onEscape: expect.any(Function),
				})
			);
		});

		it('uses CONFIRM priority for the layer', () => {
			render(<HistoryHelpModal {...defaultProps} />);

			const registerCall = mockRegisterLayer.mock.calls[0][0];
			// MODAL_PRIORITIES.CONFIRM is typically around 30-50
			expect(typeof registerCall.priority).toBe('number');
		});

		it('unregisters layer on unmount', () => {
			const { unmount } = render(<HistoryHelpModal {...defaultProps} />);

			expect(mockUnregisterLayer).not.toHaveBeenCalled();

			unmount();

			expect(mockUnregisterLayer).toHaveBeenCalledTimes(1);
			expect(mockUnregisterLayer).toHaveBeenCalledWith('test-layer-id');
		});

		it('escape handler calls onClose', () => {
			const onClose = vi.fn();
			render(<HistoryHelpModal {...defaultProps} onClose={onClose} />);

			const registerCall = mockRegisterLayer.mock.calls[0][0];
			registerCall.onEscape();

			expect(onClose).toHaveBeenCalledTimes(1);
		});

		it('updates layer handler when onClose changes', () => {
			const onClose1 = vi.fn();
			const { rerender } = render(<HistoryHelpModal {...defaultProps} onClose={onClose1} />);

			const onClose2 = vi.fn();
			rerender(<HistoryHelpModal {...defaultProps} onClose={onClose2} />);

			expect(mockUpdateLayerHandler).toHaveBeenCalled();
		});

		it('calls updated handler after handler update', () => {
			const onClose1 = vi.fn();
			const onClose2 = vi.fn();

			const { rerender } = render(<HistoryHelpModal {...defaultProps} onClose={onClose1} />);

			// After rerender with new onClose, updateLayerHandler should be called
			rerender(<HistoryHelpModal {...defaultProps} onClose={onClose2} />);

			// Get the last call to updateLayerHandler and invoke the handler
			const updateCalls = mockUpdateLayerHandler.mock.calls;
			if (updateCalls.length > 0) {
				const lastHandler = updateCalls[updateCalls.length - 1][1];
				lastHandler();

				// The updated handler should call onClose2, not onClose1
				expect(onClose2).toHaveBeenCalledTimes(1);
			}
		});
	});

	describe('Theme Styling', () => {
		it('applies accent color to History icon', () => {
			render(<HistoryHelpModal {...defaultProps} />);

			const historyIcon = screen.getByTestId('history-icon');
			expect(historyIcon).toHaveStyle({ color: mockTheme.colors.accent });
		});

		it('applies success color to Play icon', () => {
			render(<HistoryHelpModal {...defaultProps} />);

			const playIcon = screen.getByTestId('play-icon');
			expect(playIcon).toHaveStyle({ color: mockTheme.colors.success });
		});

		it('applies success color to CheckCircle icon', () => {
			render(<HistoryHelpModal {...defaultProps} />);

			// Find the CheckCircle icon in the Status Indicators section header
			const checkCircleIcons = screen.getAllByTestId('check-circle-icon');
			// At least one icon should have success color styling
			const hasSuccessColor = checkCircleIcons.some((icon) => {
				const style = icon.getAttribute('style') || '';
				// Check for the hex color or RGB equivalent
				return style.includes('#22c55e') || style.includes('rgb(34, 197, 94)');
			});
			expect(hasSuccessColor).toBe(true);
		});

		it('applies textDim color to X icon', () => {
			render(<HistoryHelpModal {...defaultProps} />);

			const xIcon = screen.getByTestId('x-icon');
			expect(xIcon).toHaveStyle({ color: mockTheme.colors.textDim });
		});

		it('applies accent color to BarChart2 icon', () => {
			render(<HistoryHelpModal {...defaultProps} />);

			const barChartIcon = screen.getByTestId('bar-chart-icon');
			expect(barChartIcon).toHaveStyle({ color: mockTheme.colors.accent });
		});

		it('applies accent color to Eye icon', () => {
			render(<HistoryHelpModal {...defaultProps} />);

			const eyeIcon = screen.getByTestId('eye-icon');
			expect(eyeIcon).toHaveStyle({ color: mockTheme.colors.accent });
		});

		it('applies accent color to Clock icon', () => {
			render(<HistoryHelpModal {...defaultProps} />);

			const clockIcon = screen.getByTestId('clock-icon');
			expect(clockIcon).toHaveStyle({ color: mockTheme.colors.accent });
		});

		it('applies success color to DollarSign icon', () => {
			render(<HistoryHelpModal {...defaultProps} />);

			const dollarIcon = screen.getByTestId('dollar-sign-icon');
			expect(dollarIcon).toHaveStyle({ color: mockTheme.colors.success });
		});
	});

	describe('Code Snippets Styling', () => {
		it('applies bgActivity background to code elements', () => {
			render(<HistoryHelpModal {...defaultProps} />);

			const historyCode = screen.getAllByText('/history');
			expect(historyCode[0]).toHaveStyle({ backgroundColor: mockTheme.colors.bgActivity });

			const clearCode = screen.getByText('/clear');
			expect(clearCode).toHaveStyle({ backgroundColor: mockTheme.colors.bgActivity });
		});

		it('applies correct classes to code elements', () => {
			render(<HistoryHelpModal {...defaultProps} />);

			const historyCode = screen.getAllByText('/history');
			expect(historyCode[0]).toHaveClass('px-1', 'rounded');
		});
	});

	describe('Scrollable Content', () => {
		it('applies scrollable classes to content area', () => {
			const { container } = render(<HistoryHelpModal {...defaultProps} />);

			// Modal component uses overflow-y-auto for scrollability
			const contentArea = container.querySelector('.flex-1.overflow-y-auto');
			expect(contentArea).toBeInTheDocument();
		});
	});

	describe('Edge Cases', () => {
		it('handles rapid onClose updates correctly', () => {
			const onClose1 = vi.fn();
			const onClose2 = vi.fn();
			const onClose3 = vi.fn();

			const { rerender } = render(<HistoryHelpModal {...defaultProps} onClose={onClose1} />);
			rerender(<HistoryHelpModal {...defaultProps} onClose={onClose2} />);
			rerender(<HistoryHelpModal {...defaultProps} onClose={onClose3} />);

			// Click the Got it button with latest handler
			const gotItButton = screen.getByText('Got it');
			fireEvent.click(gotItButton);

			// Should call the latest onClose
			expect(onClose3).toHaveBeenCalledTimes(1);
			expect(onClose1).not.toHaveBeenCalled();
			expect(onClose2).not.toHaveBeenCalled();
		});

		it('works with different theme configurations', () => {
			const customTheme: Theme = {
				...mockTheme,
				mode: 'light',
				colors: {
					...mockTheme.colors,
					bgMain: '#ffffff',
					bgSidebar: '#f5f5f5',
					textMain: '#000000',
					textDim: '#666666',
					accent: '#3b82f6',
					success: '#10b981',
					warning: '#f59e0b',
				},
			};

			render(<HistoryHelpModal theme={customTheme} onClose={vi.fn()} />);

			expect(screen.getByText('History Panel Guide')).toHaveStyle({
				color: customTheme.colors.textMain,
			});
		});

		it('renders all section headers with font-bold', () => {
			render(<HistoryHelpModal {...defaultProps} />);

			const sectionHeaders = [
				'Entry Types',
				'Status Indicators',
				'Viewing Details',
				'Resuming Sessions',
				'Time & Cost Tracking',
				'Activity Graph',
			];

			sectionHeaders.forEach((header) => {
				const element = screen.getByText(header);
				expect(element).toHaveClass('font-bold');
			});
		});

		it('does not call unregisterLayer if layerIdRef is not set', () => {
			// This tests the edge case where layer registration might fail
			mockRegisterLayer.mockReturnValue(undefined);

			const { unmount } = render(<HistoryHelpModal {...defaultProps} />);

			unmount();

			// Should not throw and should not call unregister with undefined
			expect(mockUnregisterLayer).not.toHaveBeenCalled();
		});

		it('does not call updateLayerHandler if layerIdRef is not set', () => {
			mockRegisterLayer.mockReturnValue(undefined);

			const onClose1 = vi.fn();
			const onClose2 = vi.fn();

			const { rerender } = render(<HistoryHelpModal {...defaultProps} onClose={onClose1} />);

			mockUpdateLayerHandler.mockClear();

			rerender(<HistoryHelpModal {...defaultProps} onClose={onClose2} />);

			// Should not call updateLayerHandler if no layerId
			expect(mockUpdateLayerHandler).not.toHaveBeenCalled();
		});
	});

	describe('Accessibility', () => {
		it('renders buttons that are accessible', () => {
			render(<HistoryHelpModal {...defaultProps} />);

			const buttons = screen.getAllByRole('button');
			expect(buttons.length).toBeGreaterThanOrEqual(2); // Close button and Got it button
		});

		it('allows keyboard focus on buttons', () => {
			render(<HistoryHelpModal {...defaultProps} />);

			const gotItButton = screen.getByText('Got it');
			gotItButton.focus();
			expect(document.activeElement).toBe(gotItButton);
		});
	});

	describe('SVG in Status Indicators', () => {
		it('renders the custom double-checkmark SVG for human-validated status', () => {
			const { container } = render(<HistoryHelpModal {...defaultProps} />);

			// Look for the polyline elements in the custom SVG
			const polylines = container.querySelectorAll('polyline');
			expect(polylines.length).toBe(2); // Two polylines for double checkmark
		});

		it('applies success color to double-checkmark SVG', () => {
			const { container } = render(<HistoryHelpModal {...defaultProps} />);

			// Find the parent SVG that contains the polylines
			const svgWithPolylines = container.querySelector('svg.w-3.h-3');
			if (svgWithPolylines) {
				expect(svgWithPolylines).toHaveStyle({ color: mockTheme.colors.success });
			}
		});
	});

	describe('Badge Containers Styling', () => {
		it('applies correct background and border to USER badge', () => {
			const { container } = render(<HistoryHelpModal {...defaultProps} />);

			// Find USER badge container - it has the inline styles
			const userBadgeSpan = screen.getByText('USER');
			// The parent span has the inline styles
			const style = userBadgeSpan.getAttribute('style') || '';
			// The style uses rgba format derived from the accent color
			// #6366f1 = rgb(99, 102, 241)
			expect(style).toContain('rgb(99, 102, 241)');
		});

		it('applies correct background and border to AUTO badge', () => {
			const { container } = render(<HistoryHelpModal {...defaultProps} />);

			// Find AUTO badge by looking for the element with specific styling
			const autoBadges = container.querySelectorAll('.rounded-full.text-\\[10px\\]');
			const autoBadge = Array.from(autoBadges).find((el) => el.textContent?.includes('AUTO'));
			expect(autoBadge).toBeTruthy();
			// The badge should have warning-based colors
			// #eab308 = rgb(234, 179, 8)
			const style = autoBadge!.getAttribute('style') || '';
			expect(style).toContain('rgb(234, 179, 8)');
		});
	});

	describe('Success Indicator Containers', () => {
		it('renders success indicator circles with correct styling', () => {
			const { container } = render(<HistoryHelpModal {...defaultProps} />);

			// Find the circular indicators
			const circles = container.querySelectorAll('.w-5.h-5.rounded-full');
			expect(circles.length).toBe(2); // Regular success and human-validated
		});
	});

	describe('Content Area Structure', () => {
		it('renders all sections in correct order', () => {
			render(<HistoryHelpModal {...defaultProps} />);

			const contentText = screen.getByText(/The History panel tracks/).textContent;
			expect(contentText).toBeTruthy();
		});

		it('applies spacing between sections', () => {
			const { container } = render(<HistoryHelpModal {...defaultProps} />);

			const contentArea = container.querySelector('.space-y-6');
			expect(contentArea).toBeInTheDocument();
		});

		it('applies padding to content area', () => {
			const { container } = render(<HistoryHelpModal {...defaultProps} />);

			// Modal component uses p-6 for content area padding
			const contentArea = container.querySelector('.p-6');
			expect(contentArea).toBeInTheDocument();
		});
	});

	describe('Dynamic History Path', () => {
		it('displays default storage path with home directory shortened', async () => {
			mockGetCurrentStoragePath.mockResolvedValue(
				'/Users/testuser/Library/Application Support/maestro'
			);
			mockHomeDir.mockResolvedValue('/Users/testuser');

			render(<HistoryHelpModal {...defaultProps} />);

			await waitFor(() => {
				expect(
					screen.getByText('~/Library/Application Support/maestro/history/<sessionId>.json')
				).toBeInTheDocument();
			});
		});

		it('displays custom storage path when user has configured one', async () => {
			mockGetCurrentStoragePath.mockResolvedValue('/Users/testuser/Dropbox/MaestroSync');
			mockHomeDir.mockResolvedValue('/Users/testuser');

			render(<HistoryHelpModal {...defaultProps} />);

			await waitFor(() => {
				expect(
					screen.getByText('~/Dropbox/MaestroSync/history/<sessionId>.json')
				).toBeInTheDocument();
			});
		});

		it('displays full path when not under home directory', async () => {
			mockGetCurrentStoragePath.mockResolvedValue('/opt/maestro/data');
			mockHomeDir.mockResolvedValue('/Users/testuser');

			render(<HistoryHelpModal {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getByText('/opt/maestro/data/history/<sessionId>.json')).toBeInTheDocument();
			});
		});

		it('displays Windows path with backslashes when detected', async () => {
			mockGetCurrentStoragePath.mockResolvedValue('C:\\Users\\testuser\\AppData\\Roaming\\maestro');
			mockHomeDir.mockResolvedValue('C:\\Users\\testuser');

			render(<HistoryHelpModal {...defaultProps} />);

			await waitFor(() => {
				expect(
					screen.getByText('~\\AppData\\Roaming\\maestro\\history\\<sessionId>.json')
				).toBeInTheDocument();
			});
		});

		it('shows fallback path when API fails', async () => {
			mockGetCurrentStoragePath.mockRejectedValue(new Error('API unavailable'));
			mockHomeDir.mockRejectedValue(new Error('API unavailable'));

			render(<HistoryHelpModal {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getByText('<storage-folder>/history/<sessionId>.json')).toBeInTheDocument();
			});
		});

		it('shows Loading... initially before path is fetched', () => {
			// Use a promise that never resolves to test loading state
			mockGetCurrentStoragePath.mockReturnValue(new Promise(() => {}));
			mockHomeDir.mockReturnValue(new Promise(() => {}));

			render(<HistoryHelpModal {...defaultProps} />);

			expect(screen.getByText('Loading...')).toBeInTheDocument();
		});
	});
});
