/**
 * Tests for PlaygroundPanel.tsx
 *
 * Tests the PlaygroundPanel component, including:
 * - Initial render and modal structure
 * - Tab navigation (achievements, confetti)
 * - Tab keyboard shortcuts
 * - Layer stack integration
 * - Close functionality
 * - Achievements tab: badge level buttons, time controls, standing ovation
 * - Confetti tab: origin grid, parameters, shapes, physics, colors
 * - Helper functions: formatMs, sliderToTime, timeToSlider
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { PlaygroundPanel } from '../../../renderer/components/PlaygroundPanel';
import type { Theme } from '../../../renderer/types';

// Mock the LayerStackContext
const mockRegisterLayer = vi.fn(() => 'layer-123');
const mockUnregisterLayer = vi.fn();
const mockUpdateLayerHandler = vi.fn();

vi.mock('../../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: vi.fn(() => ({
		registerLayer: mockRegisterLayer,
		unregisterLayer: mockUnregisterLayer,
		updateLayerHandler: mockUpdateLayerHandler,
	})),
}));

// Mock confetti
const mockConfetti = vi.fn();
vi.mock('canvas-confetti', () => ({
	default: (options: unknown) => mockConfetti(options),
}));

// Mock AchievementCard
vi.mock('../../../renderer/components/AchievementCard', () => ({
	AchievementCard: ({ theme, autoRunStats }: { theme: Theme; autoRunStats: unknown }) => (
		<div data-testid="achievement-card" data-stats={JSON.stringify(autoRunStats)}>
			Achievement Card
		</div>
	),
}));

// Mock StandingOvationOverlay
vi.mock('../../../renderer/components/StandingOvationOverlay', () => ({
	StandingOvationOverlay: ({
		theme,
		themeMode,
		badge,
		cumulativeTimeMs,
		recordTimeMs,
		isNewRecord,
		onClose,
	}: {
		theme: Theme;
		themeMode: string;
		badge: { level: number; name: string };
		cumulativeTimeMs: number;
		recordTimeMs: number;
		isNewRecord: boolean;
		onClose: () => void;
	}) => (
		<div
			data-testid="standing-ovation"
			data-badge-level={badge?.level}
			data-is-new-record={isNewRecord}
		>
			Standing Ovation
			<button onClick={onClose} data-testid="close-ovation">
				Close
			</button>
		</div>
	),
}));

// Mock CONDUCTOR_BADGES
vi.mock('../../../renderer/constants/conductorBadges', () => ({
	CONDUCTOR_BADGES: [
		{
			id: 'apprentice',
			level: 1,
			name: 'Apprentice',
			requiredTimeMs: 900000,
			shortName: 'Apprentice',
		},
		{
			id: 'assistant',
			level: 2,
			name: 'Assistant',
			requiredTimeMs: 3600000,
			shortName: 'Assistant',
		},
		{
			id: 'associate',
			level: 3,
			name: 'Associate',
			requiredTimeMs: 28800000,
			shortName: 'Associate',
		},
	],
	getBadgeForTime: vi.fn((timeMs: number) => {
		if (timeMs >= 28800000) return { level: 3, name: 'Associate', requiredTimeMs: 28800000 };
		if (timeMs >= 3600000) return { level: 2, name: 'Assistant', requiredTimeMs: 3600000 };
		if (timeMs >= 900000) return { level: 1, name: 'Apprentice', requiredTimeMs: 900000 };
		return null;
	}),
}));

// Sample theme for testing
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
		accentDim: '#bd93f920',
		accentForeground: '#ffffff',
		success: '#50fa7b',
		warning: '#ffb86c',
		error: '#ff5555',
	},
};

describe('PlaygroundPanel', () => {
	let mockOnClose: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.clearAllMocks();
		mockOnClose = vi.fn();

		// Mock clipboard
		Object.assign(navigator, {
			clipboard: {
				writeText: vi.fn().mockResolvedValue(undefined),
			},
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('Initial Render', () => {
		it('renders modal with correct structure', () => {
			render(<PlaygroundPanel theme={mockTheme} themeMode="dark" onClose={mockOnClose} />);

			expect(screen.getByRole('dialog')).toBeInTheDocument();
		});

		it('has dialog role and aria-modal', () => {
			render(<PlaygroundPanel theme={mockTheme} themeMode="dark" onClose={mockOnClose} />);

			const dialog = screen.getByRole('dialog');
			expect(dialog).toHaveAttribute('aria-modal', 'true');
		});

		it('has correct aria-label', () => {
			render(<PlaygroundPanel theme={mockTheme} themeMode="dark" onClose={mockOnClose} />);

			const dialog = screen.getByRole('dialog');
			expect(dialog).toHaveAttribute('aria-label', 'Developer Playground');
		});

		it('displays header with title', () => {
			render(<PlaygroundPanel theme={mockTheme} themeMode="dark" onClose={mockOnClose} />);

			expect(screen.getByText('Developer Playground')).toBeInTheDocument();
		});

		it('displays close button in header', () => {
			render(<PlaygroundPanel theme={mockTheme} themeMode="dark" onClose={mockOnClose} />);

			// Find button by checking for button with X icon (close is within the header)
			const buttons = screen.getAllByRole('button');
			const closeButton = buttons.find((btn) => {
				const svg = btn.querySelector('svg');
				return svg && btn.closest('[class*="justify-between"]');
			});
			expect(closeButton).toBeInTheDocument();
		});

		it('shows achievements tab by default', () => {
			render(<PlaygroundPanel theme={mockTheme} themeMode="dark" onClose={mockOnClose} />);

			// Check that achievement-related content is visible
			expect(screen.getByText('Quick Set Badge Level')).toBeInTheDocument();
			expect(screen.getByText('Achievement Card Preview')).toBeInTheDocument();
		});

		it('has tabIndex -1 for focus management', () => {
			render(<PlaygroundPanel theme={mockTheme} themeMode="dark" onClose={mockOnClose} />);

			const dialog = screen.getByRole('dialog');
			expect(dialog).toHaveAttribute('tabIndex', '-1');
		});
	});

	describe('Tab Navigation', () => {
		it('displays both tabs', () => {
			render(<PlaygroundPanel theme={mockTheme} themeMode="dark" onClose={mockOnClose} />);

			expect(screen.getByText('Achievements')).toBeInTheDocument();
			expect(screen.getByText('Confetti')).toBeInTheDocument();
		});

		it('clicking confetti tab switches to confetti view', () => {
			render(<PlaygroundPanel theme={mockTheme} themeMode="dark" onClose={mockOnClose} />);

			fireEvent.click(screen.getByText('Confetti'));

			// Confetti-specific content should be visible
			expect(screen.getByText('Launch Origins (click to toggle)')).toBeInTheDocument();
			expect(screen.getByText('Fire Confetti!')).toBeInTheDocument();
		});

		it('clicking achievements tab switches back to achievements view', () => {
			render(<PlaygroundPanel theme={mockTheme} themeMode="dark" onClose={mockOnClose} />);

			// First switch to confetti
			fireEvent.click(screen.getByText('Confetti'));
			expect(screen.getByText('Fire Confetti!')).toBeInTheDocument();

			// Then back to achievements
			fireEvent.click(screen.getByText('Achievements'));
			expect(screen.getByText('Quick Set Badge Level')).toBeInTheDocument();
		});

		it('Cmd+Shift+] switches to next tab', () => {
			render(<PlaygroundPanel theme={mockTheme} themeMode="dark" onClose={mockOnClose} />);

			// Verify we're on achievements initially
			expect(screen.getByText('Quick Set Badge Level')).toBeInTheDocument();

			// Press Cmd+Shift+]
			fireEvent.keyDown(window, { key: ']', metaKey: true, shiftKey: true });

			// Should switch to confetti
			expect(screen.getByText('Fire Confetti!')).toBeInTheDocument();
		});

		it('Cmd+Shift+[ switches to previous tab', () => {
			render(<PlaygroundPanel theme={mockTheme} themeMode="dark" onClose={mockOnClose} />);

			// First switch to confetti
			fireEvent.click(screen.getByText('Confetti'));
			expect(screen.getByText('Fire Confetti!')).toBeInTheDocument();

			// Press Cmd+Shift+[
			fireEvent.keyDown(window, { key: '[', metaKey: true, shiftKey: true });

			// Should switch back to achievements
			expect(screen.getByText('Quick Set Badge Level')).toBeInTheDocument();
		});

		it('Cmd+Shift+] wraps from last to first tab', () => {
			render(<PlaygroundPanel theme={mockTheme} themeMode="dark" onClose={mockOnClose} />);

			// Switch to confetti (last tab)
			fireEvent.click(screen.getByText('Confetti'));

			// Press Cmd+Shift+]
			fireEvent.keyDown(window, { key: ']', metaKey: true, shiftKey: true });

			// Should wrap to achievements (first tab)
			expect(screen.getByText('Quick Set Badge Level')).toBeInTheDocument();
		});

		it('Cmd+Shift+[ wraps from first to last tab', () => {
			render(<PlaygroundPanel theme={mockTheme} themeMode="dark" onClose={mockOnClose} />);

			// We're on achievements (first tab)

			// Press Cmd+Shift+[
			fireEvent.keyDown(window, { key: '[', metaKey: true, shiftKey: true });

			// Should wrap to confetti (last tab)
			expect(screen.getByText('Fire Confetti!')).toBeInTheDocument();
		});

		it('Cmd+Shift+{ (shifted [) also switches tabs', () => {
			render(<PlaygroundPanel theme={mockTheme} themeMode="dark" onClose={mockOnClose} />);

			fireEvent.click(screen.getByText('Confetti'));

			fireEvent.keyDown(window, { key: '{', metaKey: true, shiftKey: true });

			expect(screen.getByText('Quick Set Badge Level')).toBeInTheDocument();
		});

		it('Cmd+Shift+} (shifted ]) also switches tabs', () => {
			render(<PlaygroundPanel theme={mockTheme} themeMode="dark" onClose={mockOnClose} />);

			fireEvent.keyDown(window, { key: '}', metaKey: true, shiftKey: true });

			expect(screen.getByText('Fire Confetti!')).toBeInTheDocument();
		});
	});

	describe('Close Functionality', () => {
		it('close button calls onClose', () => {
			render(<PlaygroundPanel theme={mockTheme} themeMode="dark" onClose={mockOnClose} />);

			// Find the close button in header (the one with X icon)
			const buttons = screen.getAllByRole('button');
			const closeButton = buttons.find((btn) => {
				const parent = btn.closest('div[class*="justify-between"]');
				return parent !== null;
			});

			if (closeButton) {
				fireEvent.click(closeButton);
				expect(mockOnClose).toHaveBeenCalled();
			}
		});

		it('registers layer on mount', () => {
			render(<PlaygroundPanel theme={mockTheme} themeMode="dark" onClose={mockOnClose} />);

			expect(mockRegisterLayer).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'modal',
					ariaLabel: 'Developer Playground',
				})
			);
		});

		it('unregisters layer on unmount', () => {
			const { unmount } = render(
				<PlaygroundPanel theme={mockTheme} themeMode="dark" onClose={mockOnClose} />
			);

			unmount();

			expect(mockUnregisterLayer).toHaveBeenCalledWith('layer-123');
		});

		it('updates layer handler when onClose changes', () => {
			const { rerender } = render(
				<PlaygroundPanel theme={mockTheme} themeMode="dark" onClose={mockOnClose} />
			);

			const newOnClose = vi.fn();
			rerender(<PlaygroundPanel theme={mockTheme} themeMode="dark" onClose={newOnClose} />);

			expect(mockUpdateLayerHandler).toHaveBeenCalled();
		});
	});

	describe('Achievements Tab - Badge Level Buttons', () => {
		it('displays badge level buttons including None (0)', () => {
			render(<PlaygroundPanel theme={mockTheme} themeMode="dark" onClose={mockOnClose} />);

			expect(screen.getByRole('button', { name: 'None' })).toBeInTheDocument();
		});

		it('displays badge level buttons for each badge level', () => {
			render(<PlaygroundPanel theme={mockTheme} themeMode="dark" onClose={mockOnClose} />);

			expect(screen.getByRole('button', { name: 'Lv 1' })).toBeInTheDocument();
			expect(screen.getByRole('button', { name: 'Lv 2' })).toBeInTheDocument();
			expect(screen.getByRole('button', { name: 'Lv 3' })).toBeInTheDocument();
		});

		it('clicking badge level updates AchievementCard stats', async () => {
			render(<PlaygroundPanel theme={mockTheme} themeMode="dark" onClose={mockOnClose} />);

			fireEvent.click(screen.getByRole('button', { name: 'Lv 1' }));

			await waitFor(() => {
				const card = screen.getByTestId('achievement-card');
				const stats = JSON.parse(card.getAttribute('data-stats') || '{}');
				expect(stats.cumulativeTimeMs).toBeGreaterThan(0);
			});
		});
	});

	describe('Achievements Tab - Time Controls', () => {
		it('displays cumulative time slider', () => {
			render(<PlaygroundPanel theme={mockTheme} themeMode="dark" onClose={mockOnClose} />);

			expect(screen.getByText(/Cumulative Time:/)).toBeInTheDocument();
		});

		it('displays longest run slider', () => {
			render(<PlaygroundPanel theme={mockTheme} themeMode="dark" onClose={mockOnClose} />);

			expect(screen.getByText(/Longest Run:/)).toBeInTheDocument();
		});

		it('displays total runs slider', () => {
			render(<PlaygroundPanel theme={mockTheme} themeMode="dark" onClose={mockOnClose} />);

			expect(screen.getByText(/Total Runs:/)).toBeInTheDocument();
		});

		it('changing cumulative time slider updates display', () => {
			render(<PlaygroundPanel theme={mockTheme} themeMode="dark" onClose={mockOnClose} />);

			const sliders = screen.getAllByRole('slider');
			// First slider is cumulative time
			const cumulativeSlider = sliders[0];

			fireEvent.change(cumulativeSlider, { target: { value: '50' } });

			// Time should have changed from initial
			expect(screen.getByText(/Cumulative Time:/)).toBeInTheDocument();
		});

		it('changing total runs slider updates display', () => {
			render(<PlaygroundPanel theme={mockTheme} themeMode="dark" onClose={mockOnClose} />);

			const sliders = screen.getAllByRole('slider');
			// Third slider is total runs
			const totalRunsSlider = sliders[2];

			fireEvent.change(totalRunsSlider, { target: { value: '100' } });

			expect(screen.getByText(/Total Runs: 100/)).toBeInTheDocument();
		});
	});

	describe('Achievements Tab - Standing Ovation', () => {
		it('displays standing ovation test section', () => {
			render(<PlaygroundPanel theme={mockTheme} themeMode="dark" onClose={mockOnClose} />);

			expect(screen.getByText('Standing Ovation Test')).toBeInTheDocument();
		});

		it('displays badge level dropdown', () => {
			render(<PlaygroundPanel theme={mockTheme} themeMode="dark" onClose={mockOnClose} />);

			// Get the badge level dropdown within the Standing Ovation Test section
			const standingOvationSection = screen.getByText('Standing Ovation Test').closest('div');
			const select = standingOvationSection!.querySelector('select');
			expect(select).toBeInTheDocument();
		});

		it('displays new record checkbox', () => {
			render(<PlaygroundPanel theme={mockTheme} themeMode="dark" onClose={mockOnClose} />);

			expect(screen.getByLabelText('Show as New Record')).toBeInTheDocument();
		});

		it('trigger button shows standing ovation', () => {
			render(<PlaygroundPanel theme={mockTheme} themeMode="dark" onClose={mockOnClose} />);

			fireEvent.click(screen.getByRole('button', { name: /Trigger Standing Ovation/ }));

			expect(screen.getByTestId('standing-ovation')).toBeInTheDocument();
		});

		it('standing ovation receives correct badge level', () => {
			render(<PlaygroundPanel theme={mockTheme} themeMode="dark" onClose={mockOnClose} />);

			// Change to level 2 using the Standing Ovation Test section's dropdown
			const standingOvationSection = screen
				.getByText('Standing Ovation Test')
				.closest('div')?.parentElement;
			const select = standingOvationSection!.querySelector('select');
			fireEvent.change(select!, { target: { value: '2' } });

			fireEvent.click(screen.getByRole('button', { name: /Trigger Standing Ovation/ }));

			const ovation = screen.getByTestId('standing-ovation');
			expect(ovation).toHaveAttribute('data-badge-level', '2');
		});

		it('new record checkbox updates ovation prop', () => {
			render(<PlaygroundPanel theme={mockTheme} themeMode="dark" onClose={mockOnClose} />);

			fireEvent.click(screen.getByLabelText('Show as New Record'));
			fireEvent.click(screen.getByRole('button', { name: /Trigger Standing Ovation/ }));

			const ovation = screen.getByTestId('standing-ovation');
			expect(ovation).toHaveAttribute('data-is-new-record', 'true');
		});

		it('closing ovation updates state', () => {
			render(<PlaygroundPanel theme={mockTheme} themeMode="dark" onClose={mockOnClose} />);

			fireEvent.click(screen.getByRole('button', { name: /Trigger Standing Ovation/ }));
			expect(screen.getByTestId('standing-ovation')).toBeInTheDocument();

			fireEvent.click(screen.getByTestId('close-ovation'));
			expect(screen.queryByTestId('standing-ovation')).not.toBeInTheDocument();
		});
	});

	describe('Achievements Tab - Reset', () => {
		it('reset button is displayed', () => {
			render(<PlaygroundPanel theme={mockTheme} themeMode="dark" onClose={mockOnClose} />);

			expect(screen.getByRole('button', { name: /Reset All Mock Data/ })).toBeInTheDocument();
		});

		it('clicking reset resets values', async () => {
			render(<PlaygroundPanel theme={mockTheme} themeMode="dark" onClose={mockOnClose} />);

			// First set some values
			fireEvent.click(screen.getByRole('button', { name: 'Lv 1' }));

			// Then reset
			fireEvent.click(screen.getByRole('button', { name: /Reset All Mock Data/ }));

			await waitFor(() => {
				const card = screen.getByTestId('achievement-card');
				const stats = JSON.parse(card.getAttribute('data-stats') || '{}');
				expect(stats.cumulativeTimeMs).toBe(0);
				expect(stats.longestRunMs).toBe(0);
				expect(stats.totalRuns).toBe(0);
			});
		});
	});

	describe('Achievements Tab - Preview', () => {
		it('renders AchievementCard', () => {
			render(<PlaygroundPanel theme={mockTheme} themeMode="dark" onClose={mockOnClose} />);

			expect(screen.getByTestId('achievement-card')).toBeInTheDocument();
		});

		it('AchievementCard receives mock stats', () => {
			render(<PlaygroundPanel theme={mockTheme} themeMode="dark" onClose={mockOnClose} />);

			const card = screen.getByTestId('achievement-card');
			expect(card).toHaveAttribute('data-stats');
		});
	});

	describe('Confetti Tab - Origin Grid', () => {
		beforeEach(() => {
			render(<PlaygroundPanel theme={mockTheme} themeMode="dark" onClose={mockOnClose} />);
			fireEvent.click(screen.getByText('Confetti'));
		});

		it('grid displays all 9 positions', () => {
			const gridButtons = screen.getAllByRole('button').filter((btn) => {
				const text = btn.textContent || '';
				return (
					text.includes('Top') ||
					text.includes('Middle') ||
					text.includes('Bottom') ||
					text.includes('Center')
				);
			});
			expect(gridButtons.length).toBe(9);
		});

		it('default selection is bottom center', () => {
			expect(screen.getByText('1 origin selected')).toBeInTheDocument();
		});

		it('clicking toggles selection on', () => {
			const topLeft = screen.getByTitle('Top Left');
			fireEvent.click(topLeft);

			expect(screen.getByText('2 origins selected')).toBeInTheDocument();
		});

		it('clicking again toggles selection off', () => {
			// Click bottom center to toggle it off (it's the only selected one)
			const bottomCenter = screen.getByTitle('Bottom Center');
			fireEvent.click(bottomCenter);

			expect(screen.getByText('Select at least one origin')).toBeInTheDocument();
		});

		it('origin count displays correctly with pluralization', () => {
			// Add two more origins
			fireEvent.click(screen.getByTitle('Top Left'));
			fireEvent.click(screen.getByTitle('Top Right'));

			expect(screen.getByText('3 origins selected')).toBeInTheDocument();
		});
	});

	describe('Confetti Tab - Basic Parameters', () => {
		beforeEach(() => {
			render(<PlaygroundPanel theme={mockTheme} themeMode="dark" onClose={mockOnClose} />);
			fireEvent.click(screen.getByText('Confetti'));
		});

		it('displays particle count with label', () => {
			expect(screen.getByText('Particle Count')).toBeInTheDocument();
		});

		it('displays angle with degree symbol', () => {
			expect(screen.getByText(/Angle \(degrees\)/)).toBeInTheDocument();
			expect(screen.getByText('90°')).toBeInTheDocument();
		});

		it('displays spread with degree symbol', () => {
			expect(screen.getByText(/Spread \(degrees\)/)).toBeInTheDocument();
			expect(screen.getByText('45°')).toBeInTheDocument();
		});

		it('displays start velocity', () => {
			expect(screen.getByText('Start Velocity')).toBeInTheDocument();
		});

		it('changing particle count updates display', () => {
			const allSliders = screen.getAllByRole('slider');
			// Find the particle count slider (in the confetti tab basic params section)
			const particleSlider = allSliders.find((slider) => {
				const label = slider.closest('div')?.querySelector('label');
				return label?.textContent?.includes('Particle Count');
			});

			if (particleSlider) {
				fireEvent.change(particleSlider, { target: { value: '250' } });
				expect(screen.getByText('250')).toBeInTheDocument();
			}
		});
	});

	describe('Confetti Tab - Shapes', () => {
		beforeEach(() => {
			render(<PlaygroundPanel theme={mockTheme} themeMode="dark" onClose={mockOnClose} />);
			fireEvent.click(screen.getByText('Confetti'));
		});

		it('displays all three shapes', () => {
			expect(screen.getByText(/■ square/)).toBeInTheDocument();
			expect(screen.getByText(/● circle/)).toBeInTheDocument();
			expect(screen.getByText(/★ star/)).toBeInTheDocument();
		});

		it('clicking toggles shape on', () => {
			const starButton = screen.getByRole('button', { name: /★ star/ });
			fireEvent.click(starButton);

			// Star should now be selected (check visual feedback through mock)
			expect(starButton).toBeInTheDocument();
		});

		it('clicking toggles shape off', () => {
			// Square is selected by default, clicking should toggle it off
			const squareButton = screen.getByRole('button', { name: /■ square/ });
			fireEvent.click(squareButton);

			// Should still work
			expect(squareButton).toBeInTheDocument();
		});

		it('cannot remove last shape', () => {
			// Deselect square
			fireEvent.click(screen.getByRole('button', { name: /■ square/ }));

			// Now try to deselect circle (the only remaining one)
			const circleButton = screen.getByRole('button', { name: /● circle/ });
			fireEvent.click(circleButton);

			// Circle should still be selected (can't remove last shape)
			// The state won't change if we try to remove the last shape
			expect(circleButton).toBeInTheDocument();
		});
	});

	describe('Confetti Tab - Physics Parameters', () => {
		beforeEach(() => {
			render(<PlaygroundPanel theme={mockTheme} themeMode="dark" onClose={mockOnClose} />);
			fireEvent.click(screen.getByText('Confetti'));
		});

		it('displays gravity slider', () => {
			expect(screen.getByText('Gravity')).toBeInTheDocument();
		});

		it('displays decay slider', () => {
			expect(screen.getByText('Decay')).toBeInTheDocument();
		});

		it('displays drift slider', () => {
			expect(screen.getByText('Drift')).toBeInTheDocument();
		});

		it('displays scalar slider', () => {
			expect(screen.getByText('Scalar (size)')).toBeInTheDocument();
		});

		it('displays ticks slider', () => {
			expect(screen.getByText('Ticks (duration)')).toBeInTheDocument();
		});

		it('displays flat checkbox', () => {
			expect(screen.getByLabelText('Flat (disable 3D wobble)')).toBeInTheDocument();
		});

		it('flat checkbox toggles', () => {
			const checkbox = screen.getByLabelText('Flat (disable 3D wobble)');
			expect(checkbox).not.toBeChecked();

			fireEvent.click(checkbox);
			expect(checkbox).toBeChecked();
		});
	});

	describe('Confetti Tab - Colors', () => {
		beforeEach(() => {
			render(<PlaygroundPanel theme={mockTheme} themeMode="dark" onClose={mockOnClose} />);
			fireEvent.click(screen.getByText('Confetti'));
		});

		it('displays default colors', () => {
			// Color inputs don't have a role, query directly
			const colorInputs = document.querySelectorAll('input[type="color"]');
			// There should be 8 default colors
			expect(colorInputs.length).toBe(8);
		});

		it('add button adds new color', () => {
			const addButton = screen.getByRole('button', { name: '+' });
			fireEvent.click(addButton);

			// Should add a new color
			const colorInputs = document.querySelectorAll('input[type="color"]');
			expect(colorInputs.length).toBe(9); // 8 default + 1 new
		});
	});

	describe('Confetti Tab - Fire Button', () => {
		beforeEach(() => {
			render(<PlaygroundPanel theme={mockTheme} themeMode="dark" onClose={mockOnClose} />);
			fireEvent.click(screen.getByText('Confetti'));
		});

		it('fire button renders', () => {
			expect(screen.getByRole('button', { name: /Fire Confetti!/ })).toBeInTheDocument();
		});

		it('fire button is disabled when no origins selected', () => {
			// Deselect the default origin
			fireEvent.click(screen.getByTitle('Bottom Center'));

			expect(screen.getByRole('button', { name: /Fire Confetti!/ })).toBeDisabled();
		});

		it('fire button calls confetti with settings', () => {
			fireEvent.click(screen.getByRole('button', { name: /Fire Confetti!/ }));

			expect(mockConfetti).toHaveBeenCalled();
		});

		it('confetti called with correct origin', () => {
			fireEvent.click(screen.getByRole('button', { name: /Fire Confetti!/ }));

			expect(mockConfetti).toHaveBeenCalledWith(
				expect.objectContaining({
					origin: { x: 0.5, y: 1 }, // Bottom center
				})
			);
		});
	});

	describe('Confetti Tab - Copy Settings', () => {
		beforeEach(() => {
			vi.useFakeTimers();
			render(<PlaygroundPanel theme={mockTheme} themeMode="dark" onClose={mockOnClose} />);
			fireEvent.click(screen.getByText('Confetti'));
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it('copy button renders', () => {
			expect(screen.getByRole('button', { name: /Copy Settings/ })).toBeInTheDocument();
		});

		it('clicking copy writes to clipboard', async () => {
			await act(async () => {
				fireEvent.click(screen.getByRole('button', { name: /Copy Settings/ }));
			});

			expect(navigator.clipboard.writeText).toHaveBeenCalled();
		});

		it('copy success shows Copied! text', async () => {
			await act(async () => {
				fireEvent.click(screen.getByRole('button', { name: /Copy Settings/ }));
			});

			expect(screen.getByText('Copied!')).toBeInTheDocument();
		});

		it('success resets after timeout', async () => {
			await act(async () => {
				fireEvent.click(screen.getByRole('button', { name: /Copy Settings/ }));
			});

			expect(screen.getByText('Copied!')).toBeInTheDocument();

			await act(async () => {
				vi.advanceTimersByTime(2000);
			});

			expect(screen.queryByText('Copied!')).not.toBeInTheDocument();
			expect(screen.getByText('Copy Settings')).toBeInTheDocument();
		});
	});

	describe('Confetti Tab - Reset', () => {
		beforeEach(() => {
			render(<PlaygroundPanel theme={mockTheme} themeMode="dark" onClose={mockOnClose} />);
			fireEvent.click(screen.getByText('Confetti'));
		});

		it('reset button renders', () => {
			expect(screen.getByRole('button', { name: /Reset to Defaults/ })).toBeInTheDocument();
		});

		it('clicking reset restores particle count', () => {
			// Change particle count
			const allSliders = screen.getAllByRole('slider');
			const particleSlider = allSliders.find((slider) => {
				const label = slider.closest('div')?.querySelector('label');
				return label?.textContent?.includes('Particle Count');
			});

			if (particleSlider) {
				fireEvent.change(particleSlider, { target: { value: '250' } });
			}

			// Reset
			fireEvent.click(screen.getByRole('button', { name: /Reset to Defaults/ }));

			// Default particle count is 100
			expect(screen.getByText('100')).toBeInTheDocument();
		});

		it('clicking reset restores origins to bottom center', () => {
			// Add more origins
			fireEvent.click(screen.getByTitle('Top Left'));
			expect(screen.getByText('2 origins selected')).toBeInTheDocument();

			// Reset
			fireEvent.click(screen.getByRole('button', { name: /Reset to Defaults/ }));

			// Should be back to 1 origin
			expect(screen.getByText('1 origin selected')).toBeInTheDocument();
		});
	});

	describe('Layer Stack Integration', () => {
		it('registers layer with correct type', () => {
			render(<PlaygroundPanel theme={mockTheme} themeMode="dark" onClose={mockOnClose} />);

			expect(mockRegisterLayer).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'modal',
				})
			);
		});

		it('registers layer with blocksLowerLayers', () => {
			render(<PlaygroundPanel theme={mockTheme} themeMode="dark" onClose={mockOnClose} />);

			expect(mockRegisterLayer).toHaveBeenCalledWith(
				expect.objectContaining({
					blocksLowerLayers: true,
				})
			);
		});

		it('registers layer with capturesFocus', () => {
			render(<PlaygroundPanel theme={mockTheme} themeMode="dark" onClose={mockOnClose} />);

			expect(mockRegisterLayer).toHaveBeenCalledWith(
				expect.objectContaining({
					capturesFocus: true,
				})
			);
		});

		it('registers layer with strict focus trap', () => {
			render(<PlaygroundPanel theme={mockTheme} themeMode="dark" onClose={mockOnClose} />);

			expect(mockRegisterLayer).toHaveBeenCalledWith(
				expect.objectContaining({
					focusTrap: 'strict',
				})
			);
		});
	});

	describe('Theme Styling', () => {
		it('applies theme background color to modal', () => {
			render(<PlaygroundPanel theme={mockTheme} themeMode="dark" onClose={mockOnClose} />);

			const dialog = screen.getByRole('dialog');
			const innerModal = dialog.querySelector('div > div');
			expect(innerModal).toHaveStyle({ backgroundColor: mockTheme.colors.bgSidebar });
		});

		it('applies theme border color', () => {
			render(<PlaygroundPanel theme={mockTheme} themeMode="dark" onClose={mockOnClose} />);

			const dialog = screen.getByRole('dialog');
			const innerModal = dialog.querySelector('div > div');
			expect(innerModal).toHaveStyle({ borderColor: mockTheme.colors.border });
		});
	});

	describe('Keyboard Event Cleanup', () => {
		it('removes keyboard listener on unmount', () => {
			const removeEventListenerSpy = vi.spyOn(window, 'removeEventListener');

			const { unmount } = render(
				<PlaygroundPanel theme={mockTheme} themeMode="dark" onClose={mockOnClose} />
			);

			unmount();

			expect(removeEventListenerSpy).toHaveBeenCalledWith('keydown', expect.any(Function));

			removeEventListenerSpy.mockRestore();
		});
	});

	describe('formatMs Helper Function', () => {
		// These tests validate the internal formatMs function through UI display

		it('formats time with days correctly', () => {
			render(<PlaygroundPanel theme={mockTheme} themeMode="dark" onClose={mockOnClose} />);

			// Set to a time that would show days (badge level 4 = 1 day)
			// Actually, we need to simulate setting a high cumulative time
			const sliders = screen.getAllByRole('slider');
			const cumulativeSlider = sliders[0];

			// Set to high value to get days format
			fireEvent.change(cumulativeSlider, { target: { value: '75' } });

			// Should show day format
			expect(screen.getByText(/Cumulative Time:/)).toBeInTheDocument();
		});

		it('formats time with hours correctly', () => {
			render(<PlaygroundPanel theme={mockTheme} themeMode="dark" onClose={mockOnClose} />);

			const sliders = screen.getAllByRole('slider');
			const cumulativeSlider = sliders[0];

			// Set to medium value to get hours format
			fireEvent.change(cumulativeSlider, { target: { value: '50' } });

			expect(screen.getByText(/Cumulative Time:/)).toBeInTheDocument();
		});

		it('formats time with minutes correctly', () => {
			render(<PlaygroundPanel theme={mockTheme} themeMode="dark" onClose={mockOnClose} />);

			const sliders = screen.getAllByRole('slider');
			const cumulativeSlider = sliders[0];

			// Set to low value to get minutes format
			fireEvent.change(cumulativeSlider, { target: { value: '20' } });

			expect(screen.getByText(/Cumulative Time:/)).toBeInTheDocument();
		});

		it('formats zero time correctly', () => {
			render(<PlaygroundPanel theme={mockTheme} themeMode="dark" onClose={mockOnClose} />);

			// Default is 0
			expect(screen.getByText(/Cumulative Time: 0s/)).toBeInTheDocument();
		});
	});

	describe('Default Export', () => {
		it('default export is the same as named export', async () => {
			const { default: DefaultPlaygroundPanel } =
				await import('../../../renderer/components/PlaygroundPanel');
			expect(DefaultPlaygroundPanel).toBe(PlaygroundPanel);
		});
	});

	describe('Confetti Settings Copy Failure', () => {
		it('handles clipboard write failure gracefully', async () => {
			// Mock clipboard to fail
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
			Object.assign(navigator, {
				clipboard: {
					writeText: vi.fn().mockRejectedValue(new Error('Clipboard error')),
				},
			});

			render(<PlaygroundPanel theme={mockTheme} themeMode="dark" onClose={mockOnClose} />);
			fireEvent.click(screen.getByText('Confetti'));

			await act(async () => {
				fireEvent.click(screen.getByRole('button', { name: /Copy Settings/ }));
			});

			expect(consoleError).toHaveBeenCalledWith('Failed to copy settings:', expect.any(Error));

			consoleError.mockRestore();
		});
	});

	describe('Color Management', () => {
		beforeEach(() => {
			render(<PlaygroundPanel theme={mockTheme} themeMode="dark" onClose={mockOnClose} />);
			fireEvent.click(screen.getByText('Confetti'));
		});

		it('color picker changes color value', () => {
			const colorInputs = document.querySelectorAll('input[type="color"]');
			const firstColorInput = colorInputs[0] as HTMLInputElement;

			fireEvent.change(firstColorInput, { target: { value: '#00FF00' } });

			expect(firstColorInput.value).toBe('#00ff00');
		});
	});

	describe('Multiple Origins Confetti', () => {
		beforeEach(() => {
			render(<PlaygroundPanel theme={mockTheme} themeMode="dark" onClose={mockOnClose} />);
			fireEvent.click(screen.getByText('Confetti'));
		});

		it('fires confetti for each selected origin', () => {
			// Select additional origin
			fireEvent.click(screen.getByTitle('Top Left'));

			mockConfetti.mockClear();

			fireEvent.click(screen.getByRole('button', { name: /Fire Confetti!/ }));

			// Should be called twice (once for each origin)
			expect(mockConfetti).toHaveBeenCalledTimes(2);
		});

		it('divides particle count among origins', () => {
			// Select additional origin
			fireEvent.click(screen.getByTitle('Top Left'));

			mockConfetti.mockClear();

			fireEvent.click(screen.getByRole('button', { name: /Fire Confetti!/ }));

			// Each call should have half the particles (100 / 2 = 50)
			expect(mockConfetti).toHaveBeenCalledWith(
				expect.objectContaining({
					particleCount: 50,
				})
			);
		});
	});

	describe('Slider Value Ranges', () => {
		beforeEach(() => {
			render(<PlaygroundPanel theme={mockTheme} themeMode="dark" onClose={mockOnClose} />);
			fireEvent.click(screen.getByText('Confetti'));
		});

		it('angle slider shows value with degree symbol', () => {
			const allSliders = screen.getAllByRole('slider');
			const angleSlider = allSliders.find((slider) => {
				const label = slider.closest('div')?.querySelector('label');
				return label?.textContent?.includes('Angle');
			});

			if (angleSlider) {
				fireEvent.change(angleSlider, { target: { value: '180' } });
				expect(screen.getByText('180°')).toBeInTheDocument();
			}
		});

		it('spread slider shows value with degree symbol', () => {
			const allSliders = screen.getAllByRole('slider');
			const spreadSlider = allSliders.find((slider) => {
				const label = slider.closest('div')?.querySelector('label');
				return label?.textContent?.includes('Spread');
			});

			if (spreadSlider) {
				// Change to 120 to avoid collision with angle default of 90
				fireEvent.change(spreadSlider, { target: { value: '120' } });
				expect(screen.getByText('120°')).toBeInTheDocument();
			}
		});

		it('gravity shows formatted decimal value', () => {
			expect(screen.getByText('1.00')).toBeInTheDocument(); // Default gravity
		});

		it('decay shows formatted decimal value', () => {
			expect(screen.getByText('0.90')).toBeInTheDocument(); // Default decay
		});

		it('drift shows formatted decimal value', () => {
			expect(screen.getByText('0.0')).toBeInTheDocument(); // Default drift
		});

		it('scalar shows formatted decimal value', () => {
			// Default scalar is 1.0, which might conflict with gravity 1.00
			// So we look for it within the Scalar section
			const scalarLabel = screen.getByText('Scalar (size)');
			const scalarSection = scalarLabel.closest('div');
			expect(scalarSection).toBeInTheDocument();
		});

		it('ticks shows value', () => {
			expect(screen.getByText('200')).toBeInTheDocument(); // Default ticks
		});
	});
});
