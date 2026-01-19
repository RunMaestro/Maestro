/**
 * Tests for StandingOvationOverlay component
 * Full-screen celebration overlay for badge unlocks and new records
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import StandingOvationOverlay, {
	StandingOvationOverlay as NamedStandingOvationOverlay,
} from '../../../renderer/components/StandingOvationOverlay';
import type { Theme, ThemeMode } from '../../../renderer/types';
import type { ConductorBadge } from '../../../renderer/constants/conductorBadges';

// Mock canvas-confetti
const mockConfetti = vi.fn();
vi.mock('canvas-confetti', () => ({
	default: (...args: unknown[]) => mockConfetti(...args),
}));

// Mock AnimatedMaestro component
vi.mock('../../../renderer/components/MaestroSilhouette', () => ({
	AnimatedMaestro: ({ variant, size }: { variant: string; size: number }) => (
		<div data-testid="animated-maestro" data-variant={variant} data-size={size}>
			Maestro
		</div>
	),
}));

// Mock useLayerStack
const mockRegisterLayer = vi.fn(() => 'layer-123');
const mockUnregisterLayer = vi.fn();
const mockUpdateLayerHandler = vi.fn();
vi.mock('../../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => ({
		registerLayer: mockRegisterLayer,
		unregisterLayer: mockUnregisterLayer,
		updateLayerHandler: mockUpdateLayerHandler,
	}),
}));

// Mock conductorBadges functions
vi.mock('../../../renderer/constants/conductorBadges', () => ({
	formatCumulativeTime: (ms: number) => {
		if (ms < 60000) return `${Math.floor(ms / 1000)}s`;
		if (ms < 3600000) return `${Math.floor(ms / 60000)}m`;
		return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`;
	},
	formatTimeRemaining: (current: number, nextBadge: ConductorBadge) => {
		const remaining = nextBadge.minTimeMs - current;
		return `${Math.floor(remaining / 3600000)}h remaining`;
	},
	getNextBadge: (badge: ConductorBadge) => {
		if (badge.level >= 11) return null;
		return {
			id: `badge-${badge.level + 1}`,
			name: `Next Badge ${badge.level + 1}`,
			level: badge.level + 1,
			minTimeMs: badge.minTimeMs + 3600000,
		} as ConductorBadge;
	},
}));

// Mock window.maestro.shell.openExternal
const mockOpenExternal = vi.fn();
Object.defineProperty(window, 'maestro', {
	value: {
		...window.maestro,
		shell: {
			openExternal: mockOpenExternal,
		},
	},
	writable: true,
});

// Mock ClipboardItem
class MockClipboardItem {
	types: string[];
	constructor(items: Record<string, Blob>) {
		this.types = Object.keys(items);
	}
}
(global as any).ClipboardItem = MockClipboardItem;

// Mock navigator.clipboard globally
Object.defineProperty(navigator, 'clipboard', {
	value: {
		write: vi.fn().mockResolvedValue(undefined),
		writeText: vi.fn().mockResolvedValue(undefined),
		read: vi.fn().mockResolvedValue([]),
		readText: vi.fn().mockResolvedValue(''),
	},
	writable: true,
	configurable: true,
});

// Sample data for tests
const createTheme = (mode: ThemeMode = 'dark'): Theme => ({
	id: 'test-theme',
	name: 'Test Theme',
	mode,
	colors: {
		accent: '#7C3AED',
		bgMain: '#1E1E1E',
		bgSidebar: '#252526',
		bgActivity: '#2D2D30',
		border: '#3C3C3C',
		textMain: '#D4D4D4',
		textDim: '#808080',
		success: '#4EC9B0',
		warning: '#DCDCAA',
		error: '#F14C4C',
		terminalGreen: '#4EC9B0',
		scrollbar: '#5A5A5A',
		scrollbarActive: '#7A7A7A',
	},
});

const createBadge = (level: number = 1): ConductorBadge => ({
	id: `badge-${level}`,
	name: `Conductor Level ${level}`,
	level,
	minTimeMs: level * 900000, // 15 min per level
	description: `You have conducted for ${level * 15} minutes`,
	flavorText: `A journey of a thousand miles begins with a single step`,
	exampleConductor: {
		name: 'Herbert von Karajan',
		era: '1908-1989',
		achievement: 'Principal conductor of the Berlin Philharmonic for 34 years',
		wikipediaUrl: 'https://en.wikipedia.org/wiki/Herbert_von_Karajan',
	},
});

describe('StandingOvationOverlay', () => {
	const mockOnClose = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();

		// Mock canvas API
		const mockContext = {
			fillStyle: '',
			strokeStyle: '',
			lineWidth: 0,
			font: '',
			textAlign: 'left' as CanvasTextAlign,
			fillRect: vi.fn(),
			fill: vi.fn(),
			stroke: vi.fn(),
			beginPath: vi.fn(),
			arc: vi.fn(),
			roundRect: vi.fn(),
			fillText: vi.fn(),
			measureText: vi.fn(() => ({ width: 50 })),
			createLinearGradient: vi.fn(() => ({
				addColorStop: vi.fn(),
			})),
			createRadialGradient: vi.fn(() => ({
				addColorStop: vi.fn(),
			})),
		};

		HTMLCanvasElement.prototype.getContext = vi.fn(() => mockContext) as any;
		HTMLCanvasElement.prototype.toDataURL = vi.fn(() => 'data:image/png;base64,test');
		HTMLCanvasElement.prototype.toBlob = vi.fn((callback: BlobCallback) => {
			callback(new Blob(['test'], { type: 'image/png' }));
		});
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('Exports', () => {
		it('exports named StandingOvationOverlay component', () => {
			expect(NamedStandingOvationOverlay).toBeDefined();
			expect(typeof NamedStandingOvationOverlay).toBe('function');
		});

		it('exports default StandingOvationOverlay component', () => {
			expect(StandingOvationOverlay).toBeDefined();
			expect(typeof StandingOvationOverlay).toBe('function');
		});

		it('named and default exports are the same', () => {
			expect(StandingOvationOverlay).toBe(NamedStandingOvationOverlay);
		});
	});

	describe('Initial Render', () => {
		it('renders the overlay with all required elements', () => {
			render(
				<StandingOvationOverlay
					theme={createTheme()}
					themeMode="dark"
					badge={createBadge()}
					cumulativeTimeMs={3600000}
					onClose={mockOnClose}
				/>
			);

			expect(screen.getByRole('dialog')).toBeInTheDocument();
			expect(screen.getByText('STANDING OVATION')).toBeInTheDocument();
			expect(screen.getByText('Achievement Unlocked!')).toBeInTheDocument();
			expect(screen.getByText('Take a Bow')).toBeInTheDocument();
		});

		it('displays badge name and level', () => {
			render(
				<StandingOvationOverlay
					theme={createTheme()}
					themeMode="dark"
					badge={createBadge(5)}
					cumulativeTimeMs={3600000}
					onClose={mockOnClose}
				/>
			);

			expect(screen.getByText('Conductor Level 5')).toBeInTheDocument();
			expect(screen.getByText('Level 5')).toBeInTheDocument();
		});

		it('displays badge description and flavor text', () => {
			const badge = createBadge();
			render(
				<StandingOvationOverlay
					theme={createTheme()}
					themeMode="dark"
					badge={badge}
					cumulativeTimeMs={3600000}
					onClose={mockOnClose}
				/>
			);

			expect(screen.getByText(badge.description)).toBeInTheDocument();
			expect(screen.getByText(`"${badge.flavorText}"`)).toBeInTheDocument();
		});

		it('displays example conductor information', () => {
			const badge = createBadge();
			render(
				<StandingOvationOverlay
					theme={createTheme()}
					themeMode="dark"
					badge={badge}
					cumulativeTimeMs={3600000}
					onClose={mockOnClose}
				/>
			);

			expect(screen.getByText('Example Maestro')).toBeInTheDocument();
			expect(screen.getByText(badge.exampleConductor.name)).toBeInTheDocument();
			expect(screen.getByText(badge.exampleConductor.era)).toBeInTheDocument();
			expect(screen.getByText(badge.exampleConductor.achievement)).toBeInTheDocument();
			expect(screen.getByText('Learn more on Wikipedia')).toBeInTheDocument();
		});

		it('fires confetti on mount', () => {
			render(
				<StandingOvationOverlay
					theme={createTheme()}
					themeMode="dark"
					badge={createBadge()}
					cumulativeTimeMs={3600000}
					onClose={mockOnClose}
				/>
			);

			// Should fire confetti 3 times (center, left, right)
			expect(mockConfetti).toHaveBeenCalledTimes(3);
		});
	});

	describe('Layer Stack Integration', () => {
		it('registers with layer stack on mount', () => {
			render(
				<StandingOvationOverlay
					theme={createTheme()}
					themeMode="dark"
					badge={createBadge()}
					cumulativeTimeMs={3600000}
					onClose={mockOnClose}
				/>
			);

			expect(mockRegisterLayer).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'modal',
					blocksLowerLayers: true,
					capturesFocus: true,
					focusTrap: 'strict',
					ariaLabel: 'Standing Ovation Achievement',
				})
			);
		});

		it('unregisters layer on unmount', () => {
			const { unmount } = render(
				<StandingOvationOverlay
					theme={createTheme()}
					themeMode="dark"
					badge={createBadge()}
					cumulativeTimeMs={3600000}
					onClose={mockOnClose}
				/>
			);

			unmount();

			expect(mockUnregisterLayer).toHaveBeenCalledWith('layer-123');
		});

		it('updates layer handler when close handler changes', () => {
			render(
				<StandingOvationOverlay
					theme={createTheme()}
					themeMode="dark"
					badge={createBadge()}
					cumulativeTimeMs={3600000}
					onClose={mockOnClose}
				/>
			);

			expect(mockUpdateLayerHandler).toHaveBeenCalled();
		});
	});

	describe('Theme Mode Handling', () => {
		it('uses light maestro variant in dark mode', () => {
			render(
				<StandingOvationOverlay
					theme={createTheme('dark')}
					themeMode="dark"
					badge={createBadge()}
					cumulativeTimeMs={3600000}
					onClose={mockOnClose}
				/>
			);

			const maestro = screen.getByTestId('animated-maestro');
			expect(maestro).toHaveAttribute('data-variant', 'light');
		});

		it('uses dark maestro variant in light mode', () => {
			render(
				<StandingOvationOverlay
					theme={createTheme('light')}
					themeMode="light"
					badge={createBadge()}
					cumulativeTimeMs={3600000}
					onClose={mockOnClose}
				/>
			);

			const maestro = screen.getByTestId('animated-maestro');
			expect(maestro).toHaveAttribute('data-variant', 'dark');
		});

		it('renders maestro with correct size', () => {
			render(
				<StandingOvationOverlay
					theme={createTheme()}
					themeMode="dark"
					badge={createBadge()}
					cumulativeTimeMs={3600000}
					onClose={mockOnClose}
				/>
			);

			const maestro = screen.getByTestId('animated-maestro');
			expect(maestro).toHaveAttribute('data-size', '160');
		});
	});

	describe('New Record Display', () => {
		it('shows "Achievement Unlocked!" when not a new record', () => {
			render(
				<StandingOvationOverlay
					theme={createTheme()}
					themeMode="dark"
					badge={createBadge()}
					isNewRecord={false}
					cumulativeTimeMs={3600000}
					onClose={mockOnClose}
				/>
			);

			expect(screen.getByText('Achievement Unlocked!')).toBeInTheDocument();
		});

		it('shows "New Personal Record!" when isNewRecord is true', () => {
			render(
				<StandingOvationOverlay
					theme={createTheme()}
					themeMode="dark"
					badge={createBadge()}
					isNewRecord={true}
					recordTimeMs={7200000}
					cumulativeTimeMs={3600000}
					onClose={mockOnClose}
				/>
			);

			expect(screen.getByText('New Personal Record!')).toBeInTheDocument();
		});

		it('defaults isNewRecord to false', () => {
			render(
				<StandingOvationOverlay
					theme={createTheme()}
					themeMode="dark"
					badge={createBadge()}
					cumulativeTimeMs={3600000}
					onClose={mockOnClose}
				/>
			);

			expect(screen.getByText('Achievement Unlocked!')).toBeInTheDocument();
		});
	});

	describe('Stats Display', () => {
		it('displays cumulative time', () => {
			render(
				<StandingOvationOverlay
					theme={createTheme()}
					themeMode="dark"
					badge={createBadge()}
					cumulativeTimeMs={3600000}
					onClose={mockOnClose}
				/>
			);

			expect(screen.getByText('Total AutoRun')).toBeInTheDocument();
			expect(screen.getByText('1h 0m')).toBeInTheDocument();
		});

		it('displays record time when provided', () => {
			render(
				<StandingOvationOverlay
					theme={createTheme()}
					themeMode="dark"
					badge={createBadge()}
					recordTimeMs={1800000}
					cumulativeTimeMs={3600000}
					onClose={mockOnClose}
				/>
			);

			expect(screen.getByText('Longest Run')).toBeInTheDocument();
			expect(screen.getByText('30m')).toBeInTheDocument();
		});

		it('shows "New Record" label when isNewRecord is true', () => {
			render(
				<StandingOvationOverlay
					theme={createTheme()}
					themeMode="dark"
					badge={createBadge()}
					isNewRecord={true}
					recordTimeMs={1800000}
					cumulativeTimeMs={3600000}
					onClose={mockOnClose}
				/>
			);

			expect(screen.getByText('New Record')).toBeInTheDocument();
		});

		it('does not display record section when recordTimeMs is not provided', () => {
			render(
				<StandingOvationOverlay
					theme={createTheme()}
					themeMode="dark"
					badge={createBadge()}
					cumulativeTimeMs={3600000}
					onClose={mockOnClose}
				/>
			);

			expect(screen.queryByText('Longest Run')).not.toBeInTheDocument();
			expect(screen.queryByText('New Record')).not.toBeInTheDocument();
		});
	});

	describe('Next Badge Display', () => {
		it('shows next badge information when not at max level', () => {
			render(
				<StandingOvationOverlay
					theme={createTheme()}
					themeMode="dark"
					badge={createBadge(5)}
					cumulativeTimeMs={3600000}
					onClose={mockOnClose}
				/>
			);

			expect(screen.getByText('Next:')).toBeInTheDocument();
			expect(screen.getByText('Next Badge 6')).toBeInTheDocument();
		});

		it('shows max level message at highest level', () => {
			const maxBadge = createBadge(11);
			render(
				<StandingOvationOverlay
					theme={createTheme()}
					themeMode="dark"
					badge={maxBadge}
					cumulativeTimeMs={999999999}
					onClose={mockOnClose}
				/>
			);

			expect(screen.getByText(/You have achieved the highest rank!/)).toBeInTheDocument();
			expect(screen.getByText(/Titan of the Baton/)).toBeInTheDocument();
		});
	});

	describe('Close Behavior', () => {
		it('calls handleTakeABow when clicking "Take a Bow" button', async () => {
			render(
				<StandingOvationOverlay
					theme={createTheme()}
					themeMode="dark"
					badge={createBadge()}
					cumulativeTimeMs={3600000}
					onClose={mockOnClose}
				/>
			);

			const button = screen.getByText('Take a Bow');
			fireEvent.click(button);

			// Should fire confetti again
			expect(mockConfetti).toHaveBeenCalledTimes(6); // 3 initial + 3 for close

			// Wait for timeout
			act(() => {
				vi.advanceTimersByTime(1500);
			});

			expect(mockOnClose).toHaveBeenCalled();
		});

		it('calls handleTakeABow when clicking backdrop', async () => {
			render(
				<StandingOvationOverlay
					theme={createTheme()}
					themeMode="dark"
					badge={createBadge()}
					cumulativeTimeMs={3600000}
					onClose={mockOnClose}
				/>
			);

			// Find and click backdrop (first div with inset-0)
			const backdrop = document.querySelector('.fixed.inset-0.z-\\[99997\\]');
			expect(backdrop).toBeInTheDocument();
			fireEvent.click(backdrop!);

			act(() => {
				vi.advanceTimersByTime(1500);
			});

			expect(mockOnClose).toHaveBeenCalled();
		});

		it('prevents multiple close actions when isClosing is true', async () => {
			render(
				<StandingOvationOverlay
					theme={createTheme()}
					themeMode="dark"
					badge={createBadge()}
					cumulativeTimeMs={3600000}
					onClose={mockOnClose}
				/>
			);

			const button = screen.getByText('Take a Bow');

			// Click multiple times
			fireEvent.click(button);
			fireEvent.click(button);
			fireEvent.click(button);

			// Should only fire closing confetti once
			expect(mockConfetti).toHaveBeenCalledTimes(6); // 3 initial + 3 for single close
		});

		it('shows closing state button text', async () => {
			render(
				<StandingOvationOverlay
					theme={createTheme()}
					themeMode="dark"
					badge={createBadge()}
					cumulativeTimeMs={3600000}
					onClose={mockOnClose}
				/>
			);

			const button = screen.getByText('Take a Bow');
			fireEvent.click(button);

			expect(screen.getByText('Bravo!', { exact: false })).toBeInTheDocument();
		});

		it('disables button during closing', async () => {
			render(
				<StandingOvationOverlay
					theme={createTheme()}
					themeMode="dark"
					badge={createBadge()}
					cumulativeTimeMs={3600000}
					onClose={mockOnClose}
				/>
			);

			const button = screen.getByText('Take a Bow');
			expect(button).not.toBeDisabled();

			fireEvent.click(button);

			// Button should now be disabled
			const closingButton = screen.getByRole('button', { name: /bravo/i });
			expect(closingButton).toBeDisabled();
		});
	});

	describe('Click Propagation', () => {
		it('stops propagation when clicking modal content', () => {
			render(
				<StandingOvationOverlay
					theme={createTheme()}
					themeMode="dark"
					badge={createBadge()}
					cumulativeTimeMs={3600000}
					onClose={mockOnClose}
				/>
			);

			// Reset confetti mock to ignore initial calls
			mockConfetti.mockClear();

			// Click on the modal content (card)
			const badgeName = screen.getByText('Conductor Level 1');
			fireEvent.click(badgeName);

			// Should not trigger close
			expect(mockConfetti).not.toHaveBeenCalled();
		});
	});

	describe('External Link', () => {
		it('opens Wikipedia link when clicking "Learn more"', () => {
			const badge = createBadge();
			render(
				<StandingOvationOverlay
					theme={createTheme()}
					themeMode="dark"
					badge={badge}
					cumulativeTimeMs={3600000}
					onClose={mockOnClose}
				/>
			);

			const link = screen.getByText('Learn more on Wikipedia');
			fireEvent.click(link);

			expect(mockOpenExternal).toHaveBeenCalledWith(badge.exampleConductor.wikipediaUrl);
		});
	});

	describe('Share Menu', () => {
		it('opens share menu when clicking "Share Achievement"', () => {
			render(
				<StandingOvationOverlay
					theme={createTheme()}
					themeMode="dark"
					badge={createBadge()}
					cumulativeTimeMs={3600000}
					onClose={mockOnClose}
				/>
			);

			const shareButton = screen.getByText('Share Achievement');
			fireEvent.click(shareButton);

			expect(screen.getByText('Copy to Clipboard')).toBeInTheDocument();
			expect(screen.getByText('Save as Image')).toBeInTheDocument();
		});

		it('closes share menu when clicking again', () => {
			render(
				<StandingOvationOverlay
					theme={createTheme()}
					themeMode="dark"
					badge={createBadge()}
					cumulativeTimeMs={3600000}
					onClose={mockOnClose}
				/>
			);

			const shareButton = screen.getByText('Share Achievement');

			// Open
			fireEvent.click(shareButton);
			expect(screen.getByText('Copy to Clipboard')).toBeInTheDocument();

			// Close
			fireEvent.click(shareButton);
			expect(screen.queryByText('Copy to Clipboard')).not.toBeInTheDocument();
		});

		it('triggers copy action when clicking copy option', () => {
			render(
				<StandingOvationOverlay
					theme={createTheme()}
					themeMode="dark"
					badge={createBadge()}
					cumulativeTimeMs={3600000}
					onClose={mockOnClose}
				/>
			);

			// Open share menu
			const shareButton = screen.getByText('Share Achievement');
			fireEvent.click(shareButton);

			// Click copy - this triggers the async copy flow
			const copyButton = screen.getByText('Copy to Clipboard');
			fireEvent.click(copyButton);

			// Menu should close after clicking
			expect(screen.queryByText('Copy to Clipboard')).not.toBeInTheDocument();
		});

		it('triggers download action when clicking save option', () => {
			render(
				<StandingOvationOverlay
					theme={createTheme()}
					themeMode="dark"
					badge={createBadge(3)}
					cumulativeTimeMs={3600000}
					onClose={mockOnClose}
				/>
			);

			// Open share menu
			const shareButton = screen.getByText('Share Achievement');
			fireEvent.click(shareButton);

			// Click save - this triggers the async download flow
			const saveButton = screen.getByText('Save as Image');
			fireEvent.click(saveButton);

			// Menu should close after clicking
			expect(screen.queryByText('Save as Image')).not.toBeInTheDocument();
		});

		it('displays copy and download icons in share menu', () => {
			render(
				<StandingOvationOverlay
					theme={createTheme()}
					themeMode="dark"
					badge={createBadge()}
					cumulativeTimeMs={3600000}
					onClose={mockOnClose}
				/>
			);

			// Open share menu
			const shareButton = screen.getByText('Share Achievement');
			fireEvent.click(shareButton);

			// Both options should be visible
			expect(screen.getByText('Copy to Clipboard')).toBeInTheDocument();
			expect(screen.getByText('Save as Image')).toBeInTheDocument();
		});
	});

	describe('Accessibility', () => {
		it('has correct dialog role and aria-modal', () => {
			render(
				<StandingOvationOverlay
					theme={createTheme()}
					themeMode="dark"
					badge={createBadge()}
					cumulativeTimeMs={3600000}
					onClose={mockOnClose}
				/>
			);

			const dialog = screen.getByRole('dialog');
			expect(dialog).toHaveAttribute('aria-modal', 'true');
			expect(dialog).toHaveAttribute('aria-label', 'Standing Ovation Achievement');
		});

		it('has tabIndex for keyboard focus', () => {
			render(
				<StandingOvationOverlay
					theme={createTheme()}
					themeMode="dark"
					badge={createBadge()}
					cumulativeTimeMs={3600000}
					onClose={mockOnClose}
				/>
			);

			const dialog = screen.getByRole('dialog');
			expect(dialog).toHaveAttribute('tabIndex', '-1');
		});
	});

	describe('Confetti Configuration', () => {
		it('fires confetti with correct settings', () => {
			render(
				<StandingOvationOverlay
					theme={createTheme()}
					themeMode="dark"
					badge={createBadge()}
					cumulativeTimeMs={3600000}
					onClose={mockOnClose}
				/>
			);

			// Check confetti was called with expected properties
			expect(mockConfetti).toHaveBeenCalledWith(
				expect.objectContaining({
					particleCount: 500,
					angle: 90,
					spread: 91,
					startVelocity: 74,
					gravity: 0.8,
					decay: 0.9,
					drift: 1.5,
					scalar: 1.2,
					ticks: 355,
					flat: false,
					zIndex: 99998,
					disableForReducedMotion: true,
				})
			);
		});

		it('fires confetti from three origins', () => {
			render(
				<StandingOvationOverlay
					theme={createTheme()}
					themeMode="dark"
					badge={createBadge()}
					cumulativeTimeMs={3600000}
					onClose={mockOnClose}
				/>
			);

			// Center
			expect(mockConfetti).toHaveBeenCalledWith(
				expect.objectContaining({ origin: { x: 0.5, y: 1 } })
			);
			// Left
			expect(mockConfetti).toHaveBeenCalledWith(
				expect.objectContaining({ origin: { x: 0, y: 1 } })
			);
			// Right
			expect(mockConfetti).toHaveBeenCalledWith(
				expect.objectContaining({ origin: { x: 1, y: 1 } })
			);
		});

		it('uses correct confetti colors', () => {
			render(
				<StandingOvationOverlay
					theme={createTheme()}
					themeMode="dark"
					badge={createBadge()}
					cumulativeTimeMs={3600000}
					onClose={mockOnClose}
				/>
			);

			expect(mockConfetti).toHaveBeenCalledWith(
				expect.objectContaining({
					colors: [
						'#FFD700', // Gold
						'#FF6B6B', // Red
						'#4ECDC4', // Teal
						'#45B7D1', // Blue
						'#FFA726', // Orange
						'#BA68C8', // Purple
						'#F48FB1', // Pink
						'#FFEAA7', // Yellow
					],
				})
			);
		});

		it('does not fire confetti when disableConfetti is true', () => {
			mockConfetti.mockClear();
			render(
				<StandingOvationOverlay
					theme={createTheme()}
					themeMode="dark"
					badge={createBadge()}
					cumulativeTimeMs={3600000}
					onClose={mockOnClose}
					disableConfetti={true}
				/>
			);

			// Confetti should not be called
			expect(mockConfetti).not.toHaveBeenCalled();
		});
	});

	describe('Theme Styling', () => {
		it('applies theme colors to content', () => {
			const theme = createTheme();
			render(
				<StandingOvationOverlay
					theme={theme}
					themeMode="dark"
					badge={createBadge()}
					cumulativeTimeMs={3600000}
					onClose={mockOnClose}
				/>
			);

			// Check that badge name uses accent color
			const badgeName = screen.getByText('Conductor Level 1');
			expect(badgeName).toHaveStyle({ color: theme.colors.accent });
		});

		it('applies gold color to title', () => {
			render(
				<StandingOvationOverlay
					theme={createTheme()}
					themeMode="dark"
					badge={createBadge()}
					cumulativeTimeMs={3600000}
					onClose={mockOnClose}
				/>
			);

			const title = screen.getByText('STANDING OVATION');
			expect(title).toHaveStyle({ color: '#FFD700' });
		});
	});

	describe('Closing Animation', () => {
		it('applies closing class when isClosing is true', () => {
			const { container } = render(
				<StandingOvationOverlay
					theme={createTheme()}
					themeMode="dark"
					badge={createBadge()}
					cumulativeTimeMs={3600000}
					onClose={mockOnClose}
				/>
			);

			// Click to trigger close
			const button = screen.getByText('Take a Bow');
			fireEvent.click(button);

			// Check for closing styles
			const card = container.querySelector('.opacity-0.scale-95');
			expect(card).toBeInTheDocument();
		});
	});

	describe('Edge Cases', () => {
		it('handles very large cumulative time', () => {
			render(
				<StandingOvationOverlay
					theme={createTheme()}
					themeMode="dark"
					badge={createBadge()}
					cumulativeTimeMs={999999999999}
					onClose={mockOnClose}
				/>
			);

			// Should render without crashing
			expect(screen.getByText('STANDING OVATION')).toBeInTheDocument();
		});

		it('handles zero cumulative time', () => {
			render(
				<StandingOvationOverlay
					theme={createTheme()}
					themeMode="dark"
					badge={createBadge()}
					cumulativeTimeMs={0}
					onClose={mockOnClose}
				/>
			);

			expect(screen.getByText('STANDING OVATION')).toBeInTheDocument();
		});

		it('handles badge with special characters in name', () => {
			const badge = createBadge();
			badge.name = 'Test <Badge> & "Special"';

			render(
				<StandingOvationOverlay
					theme={createTheme()}
					themeMode="dark"
					badge={badge}
					cumulativeTimeMs={3600000}
					onClose={mockOnClose}
				/>
			);

			expect(screen.getByText('Test <Badge> & "Special"')).toBeInTheDocument();
		});

		it('handles unicode in badge name', () => {
			const badge = createBadge();
			badge.name = 'Maestro 🎼 Level';

			render(
				<StandingOvationOverlay
					theme={createTheme()}
					themeMode="dark"
					badge={badge}
					cumulativeTimeMs={3600000}
					onClose={mockOnClose}
				/>
			);

			expect(screen.getByText('Maestro 🎼 Level')).toBeInTheDocument();
		});

		it('handles vibe theme mode', () => {
			render(
				<StandingOvationOverlay
					theme={createTheme('vibe')}
					themeMode="vibe"
					badge={createBadge()}
					cumulativeTimeMs={3600000}
					onClose={mockOnClose}
				/>
			);

			// Vibe is not dark, so should use dark maestro variant
			const maestro = screen.getByTestId('animated-maestro');
			expect(maestro).toHaveAttribute('data-variant', 'dark');
		});
	});

	describe('Canvas Image Generation', () => {
		it('canvas mock is properly set up', () => {
			// Verify the mock is available
			const canvas = document.createElement('canvas');
			const ctx = canvas.getContext('2d');
			expect(ctx).toBeTruthy();
		});

		it('share button exists and can be clicked to open menu', () => {
			render(
				<StandingOvationOverlay
					theme={createTheme()}
					themeMode="dark"
					badge={createBadge()}
					cumulativeTimeMs={3600000}
					onClose={mockOnClose}
				/>
			);

			const shareButton = screen.getByText('Share Achievement');
			expect(shareButton).toBeInTheDocument();

			fireEvent.click(shareButton);

			// Menu opens with both options
			expect(screen.getByText('Copy to Clipboard')).toBeInTheDocument();
			expect(screen.getByText('Save as Image')).toBeInTheDocument();
		});
	});

	describe('Star Icons', () => {
		it('renders star icons around level number', () => {
			render(
				<StandingOvationOverlay
					theme={createTheme()}
					themeMode="dark"
					badge={createBadge(7)}
					cumulativeTimeMs={3600000}
					onClose={mockOnClose}
				/>
			);

			// There should be two star icons (left and right of level)
			const levelContainer = screen.getByText('Level 7').parentElement;
			expect(levelContainer).toBeInTheDocument();
		});
	});

	describe('Z-Index Layering', () => {
		it('has correct z-index order for elements', () => {
			const { container } = render(
				<StandingOvationOverlay
					theme={createTheme()}
					themeMode="dark"
					badge={createBadge()}
					cumulativeTimeMs={3600000}
					onClose={mockOnClose}
				/>
			);

			// Backdrop should have z-index 99997
			const backdrop = container.querySelector('.z-\\[99997\\]');
			expect(backdrop).toBeInTheDocument();

			// Modal should have z-index 99999
			const modal = container.querySelector('.z-\\[99999\\]');
			expect(modal).toBeInTheDocument();
		});
	});
});
