import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import confetti from 'canvas-confetti';
import { FirstRunCelebration } from '../../../renderer/components/FirstRunCelebration';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import * as LayerStackContext from '../../../renderer/contexts/LayerStackContext';
import type { Theme } from '../../../renderer/types';

vi.mock('canvas-confetti', () => ({
	default: vi.fn(),
}));

vi.mock('lucide-react', () => ({
	PartyPopper: ({ className }: { className?: string }) => (
		<svg data-testid="party-popper-icon" className={className} />
	),
	Rocket: ({ className }: { className?: string }) => (
		<svg data-testid="rocket-icon" className={className} />
	),
	Clock: ({ className }: { className?: string }) => (
		<svg data-testid="clock-icon" className={className} />
	),
	Star: ({ className }: { className?: string }) => (
		<svg data-testid="star-icon" className={className} />
	),
	Trophy: ({ className }: { className?: string }) => (
		<svg data-testid="trophy-icon" className={className} />
	),
	FileText: ({ className }: { className?: string }) => (
		<svg data-testid="file-text-icon" className={className} />
	),
	ArrowRight: ({ className }: { className?: string }) => (
		<svg data-testid="arrow-right-icon" className={className} />
	),
	Sparkles: ({ className }: { className?: string }) => (
		<svg data-testid="sparkles-icon" className={className} />
	),
}));

const mockTheme: Theme = {
	id: 'test-dark',
	name: 'Test Dark',
	mode: 'dark',
	colors: {
		bgMain: '#111111',
		bgSidebar: '#202020',
		bgActivity: '#2a2a2a',
		border: '#333333',
		textMain: '#ffffff',
		textDim: '#999999',
		textFaint: '#666666',
		accent: '#4a9eff',
		accentForeground: '#ffffff',
		success: '#22c55e',
		buttonBg: '#333333',
		buttonHover: '#444444',
		headerBg: '#202020',
		scrollbarTrack: '#111111',
		scrollbarThumb: '#444444',
	},
};

const originalMatchMedia = window.matchMedia;

function renderCelebration(props: Partial<React.ComponentProps<typeof FirstRunCelebration>> = {}) {
	return render(
		<LayerStackProvider>
			<FirstRunCelebration
				theme={mockTheme}
				elapsedTimeMs={65_000}
				completedTasks={1}
				totalTasks={1}
				onClose={vi.fn()}
				{...props}
			/>
		</LayerStackProvider>
	);
}

function mockReducedMotion(matches: boolean) {
	Object.defineProperty(window, 'matchMedia', {
		configurable: true,
		value: vi.fn().mockReturnValue({
			matches,
			media: '(prefers-reduced-motion: reduce)',
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			addListener: vi.fn(),
			removeListener: vi.fn(),
			dispatchEvent: vi.fn(),
		}),
	});
}

describe('FirstRunCelebration', () => {
	beforeEach(() => {
		mockReducedMotion(false);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
		vi.restoreAllMocks();
		if (originalMatchMedia) {
			Object.defineProperty(window, 'matchMedia', {
				configurable: true,
				value: originalMatchMedia,
			});
		} else {
			Reflect.deleteProperty(window, 'matchMedia');
		}
	});

	it('renders a standard first-run celebration with duration, task count, and next steps', () => {
		renderCelebration();

		expect(screen.getByRole('dialog', { name: 'First Auto Run Celebration' })).toBeInTheDocument();
		expect(screen.getByText('Congratulations!')).toBeInTheDocument();
		expect(screen.getByText('You just completed your first Auto Run')).toBeInTheDocument();
		expect(screen.getByText('1 minute 5 seconds')).toBeInTheDocument();
		expect(screen.getByText('• 1 of 1 task completed')).toBeInTheDocument();
		expect(screen.getByText('Explore the additional Auto Run documents')).toBeInTheDocument();
		expect(screen.getByText(/Use Ctrl\+Shift\+N to open the wizard anytime/)).toBeInTheDocument();
		expect(screen.getByTestId('party-popper-icon')).toBeInTheDocument();
		expect(confetti).toHaveBeenCalledTimes(3);
		expect(confetti).toHaveBeenCalledWith(
			expect.objectContaining({
				particleCount: 400,
				origin: { x: 0.5, y: 1 },
				disableForReducedMotion: true,
			})
		);
	});

	it.each([
		[1_000, '1 second'],
		[2_000, '2 seconds'],
		[60_000, '1 minute'],
		[121_000, '2 minutes 1 second'],
		[3_600_000, '1 hour'],
		[3_720_000, '1 hour 2 minutes'],
		[7_200_000, '2 hours'],
		[7_260_000, '2 hours 1 minute'],
	])('formats elapsed duration %i as %s', (elapsedTimeMs, expected) => {
		renderCelebration({ elapsedTimeMs, disableConfetti: true });

		expect(screen.getByText(expected)).toBeInTheDocument();
	});

	it('renders standing ovation copy and schedules the extra star burst', () => {
		vi.useFakeTimers();
		renderCelebration({
			elapsedTimeMs: 15 * 60 * 1000,
			completedTasks: 3,
			totalTasks: 4,
		});

		expect(screen.getByText('Standing Ovation!')).toBeInTheDocument();
		expect(
			screen.getByText('Your AI worked autonomously for over 15 minutes!')
		).toBeInTheDocument();
		expect(screen.getByText('15 minutes')).toBeInTheDocument();
		expect(screen.getByText('• 3 of 4 tasks completed')).toBeInTheDocument();
		expect(screen.getByTestId('trophy-icon')).toBeInTheDocument();
		expect(confetti).toHaveBeenCalledWith(
			expect.objectContaining({
				particleCount: 600,
				startVelocity: 80,
				origin: { x: 0.5, y: 1 },
			})
		);

		act(() => {
			vi.advanceTimersByTime(500);
		});

		expect(confetti).toHaveBeenCalledWith(
			expect.objectContaining({
				particleCount: 100,
				shapes: ['star'],
				spread: 360,
			})
		);
	});

	it('suppresses confetti when disabled or reduced motion is requested', () => {
		const { unmount } = renderCelebration({ disableConfetti: true });
		expect(confetti).not.toHaveBeenCalled();
		unmount();

		mockReducedMotion(true);
		renderCelebration();

		expect(confetti).not.toHaveBeenCalled();
	});

	it('closes after the exit delay from the primary button and keyboard', () => {
		vi.useFakeTimers();
		const onClose = vi.fn();
		const { container, unmount } = renderCelebration({ onClose });

		fireEvent.click(screen.getByRole('button', { name: 'Got It!' }));
		fireEvent.click(container.firstElementChild!);
		expect(screen.getByRole('button', { name: /Let's Go!/ })).toBeDisabled();
		act(() => {
			vi.advanceTimersByTime(1_000);
		});
		expect(onClose).toHaveBeenCalledTimes(1);
		unmount();

		const onKeyboardClose = vi.fn();
		renderCelebration({ onClose: onKeyboardClose });
		act(() => {
			window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
			vi.advanceTimersByTime(1_000);
		});
		expect(onKeyboardClose).not.toHaveBeenCalled();

		act(() => {
			window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		});
		act(() => {
			window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		});
		act(() => {
			vi.advanceTimersByTime(1_000);
		});

		expect(onKeyboardClose).toHaveBeenCalledTimes(1);
	});

	it('registers a layer-stack escape handler that starts the close sequence', () => {
		vi.useFakeTimers();
		const onClose = vi.fn();
		let registeredEscapeHandler: (() => void) | undefined;

		vi.spyOn(LayerStackContext, 'useLayerStack').mockReturnValue({
			registerLayer: vi.fn((layer) => {
				registeredEscapeHandler = layer.onEscape;
				return 'first-run-layer';
			}),
			unregisterLayer: vi.fn(),
			updateLayerHandler: vi.fn(),
		} as unknown as ReturnType<typeof LayerStackContext.useLayerStack>);

		render(
			<FirstRunCelebration
				theme={mockTheme}
				elapsedTimeMs={65_000}
				completedTasks={1}
				totalTasks={1}
				onClose={onClose}
			/>
		);

		expect(registeredEscapeHandler).toEqual(expect.any(Function));

		act(() => {
			registeredEscapeHandler?.();
			vi.advanceTimersByTime(1_000);
		});

		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('skips layer cleanup and handler updates when registration returns no id', () => {
		const registerLayer = vi.fn(() => undefined);
		const unregisterLayer = vi.fn();
		const updateLayerHandler = vi.fn();

		vi.spyOn(LayerStackContext, 'useLayerStack').mockReturnValue({
			registerLayer,
			unregisterLayer,
			updateLayerHandler,
		} as unknown as ReturnType<typeof LayerStackContext.useLayerStack>);

		const { unmount } = render(
			<FirstRunCelebration
				theme={mockTheme}
				elapsedTimeMs={65_000}
				completedTasks={1}
				totalTasks={1}
				onClose={vi.fn()}
				disableConfetti={true}
			/>
		);

		expect(registerLayer).toHaveBeenCalledTimes(1);
		expect(updateLayerHandler).not.toHaveBeenCalled();

		unmount();

		expect(unregisterLayer).not.toHaveBeenCalled();
	});

	it('opens leaderboard registration after the close animation and hides it for registered users', () => {
		vi.useFakeTimers();
		const onClose = vi.fn();
		const onOpenLeaderboardRegistration = vi.fn();
		const { rerender } = renderCelebration({
			onClose,
			onOpenLeaderboardRegistration,
			isLeaderboardRegistered: false,
		});

		fireEvent.click(screen.getByRole('button', { name: /Join Global Leaderboard/i }));
		act(() => {
			vi.advanceTimersByTime(1_000);
		});
		expect(onClose).toHaveBeenCalledTimes(1);
		expect(onOpenLeaderboardRegistration).not.toHaveBeenCalled();

		act(() => {
			vi.advanceTimersByTime(100);
		});
		expect(onOpenLeaderboardRegistration).toHaveBeenCalledTimes(1);

		rerender(
			<LayerStackProvider>
				<FirstRunCelebration
					theme={mockTheme}
					elapsedTimeMs={65_000}
					completedTasks={1}
					totalTasks={1}
					onClose={vi.fn()}
					onOpenLeaderboardRegistration={vi.fn()}
					isLeaderboardRegistered={true}
					disableConfetti={true}
				/>
			</LayerStackProvider>
		);

		expect(
			screen.queryByRole('button', { name: /Join Global Leaderboard/i })
		).not.toBeInTheDocument();
	});
});
