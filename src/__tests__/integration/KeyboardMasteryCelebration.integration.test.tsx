import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import confetti from 'canvas-confetti';
import { KeyboardMasteryCelebration } from '../../renderer/components/KeyboardMasteryCelebration';
import { LayerStackProvider } from '../../renderer/contexts/LayerStackContext';
import * as LayerStackContext from '../../renderer/contexts/LayerStackContext';
import type { Theme } from '../../renderer/types';

vi.mock('canvas-confetti', () => ({
	default: vi.fn(),
}));

vi.mock('lucide-react', () => ({
	Keyboard: ({ className }: { className?: string }) => (
		<svg data-testid="keyboard-icon" className={className} />
	),
	Trophy: ({ className }: { className?: string }) => (
		<svg data-testid="trophy-icon" className={className} />
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
		buttonBg: '#333333',
		buttonHover: '#444444',
		headerBg: '#202020',
		scrollbarTrack: '#111111',
		scrollbarThumb: '#444444',
	},
};

const originalMatchMedia = window.matchMedia;
const originalPlatform = window.maestro.platform;

function renderCelebration(
	props: Partial<React.ComponentProps<typeof KeyboardMasteryCelebration>> = {}
) {
	return render(
		<LayerStackProvider>
			<KeyboardMasteryCelebration theme={mockTheme} level={2} onClose={vi.fn()} {...props} />
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

describe('KeyboardMasteryCelebration', () => {
	beforeEach(() => {
		mockReducedMotion(false);
		window.maestro.platform = 'darwin';
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		window.maestro.platform = originalPlatform;
		if (originalMatchMedia) {
			Object.defineProperty(window, 'matchMedia', {
				configurable: true,
				value: originalMatchMedia,
			});
		} else {
			Reflect.deleteProperty(window, 'matchMedia');
		}
	});

	it('renders the current level, progress guidance, and default help shortcut', () => {
		renderCelebration();

		expect(screen.getByRole('dialog', { name: 'Keyboard Mastery Level Up' })).toBeInTheDocument();
		expect(screen.getByText('Level Up!')).toBeInTheDocument();
		expect(screen.getByText('Performer')).toBeInTheDocument();
		expect(screen.getByText('Getting comfortable')).toBeInTheDocument();
		expect(screen.getByText(/Keep using shortcuts to reach Virtuoso!/)).toBeInTheDocument();
		expect(screen.getByText('⌘/')).toBeInTheDocument();
		expect(screen.getByTestId('keyboard-icon')).toBeInTheDocument();
		expect(confetti).toHaveBeenCalledWith(
			expect.objectContaining({
				particleCount: 200,
				spread: 80,
				origin: { x: 0.5, y: 0.6 },
				disableForReducedMotion: true,
			})
		);
	});

	it('falls back to beginner copy and non-Mac shortcut labels for out-of-range levels', () => {
		window.maestro.platform = 'linux';
		renderCelebration({
			level: 99,
			shortcuts: {
				help: {
					id: 'help',
					label: 'Help',
					keys: ['Control', 'Alt', '/'],
					description: 'Open help',
					category: 'global',
				},
			},
		});

		expect(screen.getByText('Beginner')).toBeInTheDocument();
		expect(screen.getByText('CtrlAlt/')).toBeInTheDocument();
	});

	it('formats Meta as Ctrl on non-Mac platforms', () => {
		window.maestro.platform = 'linux';
		renderCelebration({
			shortcuts: {
				help: {
					id: 'help',
					label: 'Help',
					keys: ['Meta', '/'],
					description: 'Open help',
					category: 'global',
				},
			},
		});

		expect(screen.getByText('Ctrl/')).toBeInTheDocument();
	});

	it('falls back to the default help shortcut when custom shortcuts omit help', () => {
		renderCelebration({ shortcuts: {} });

		expect(screen.getByText('⌘/')).toBeInTheDocument();
	});

	it('uses Mac glyphs for custom help shortcuts on macOS', () => {
		renderCelebration({
			shortcuts: {
				help: {
					id: 'help',
					label: 'Help',
					keys: ['Alt', 'Shift', 'Control', '/'],
					description: 'Open help',
					category: 'global',
				},
			},
		});

		expect(screen.getByText('⌥⇧⌃/')).toBeInTheDocument();
	});

	it('suppresses confetti when disabled or when reduced motion is requested', () => {
		const { unmount } = renderCelebration({ disableConfetti: true });
		expect(confetti).not.toHaveBeenCalled();
		unmount();

		mockReducedMotion(true);
		renderCelebration();

		expect(confetti).not.toHaveBeenCalled();
	});

	it('renders Maestro-specific copy and runs the extra star burst', () => {
		vi.useFakeTimers();
		renderCelebration({ level: 4 });

		expect(screen.getByText('Keyboard Maestro!')).toBeInTheDocument();
		expect(screen.getByText('the highest level')).toBeInTheDocument();
		expect(screen.getByText("You've mastered all keyboard shortcuts!")).toBeInTheDocument();
		expect(screen.getByTestId('trophy-icon')).toBeInTheDocument();
		expect(confetti).toHaveBeenCalledWith(
			expect.objectContaining({
				particleCount: 500,
				spread: 120,
			})
		);

		act(() => {
			vi.advanceTimersByTime(300);
		});

		expect(confetti).toHaveBeenCalledWith(
			expect.objectContaining({
				particleCount: 100,
				spread: 360,
				colors: ['#FFD700'],
			})
		);
	});

	it('closes once after the exit delay when dismissed by click or keyboard', () => {
		vi.useFakeTimers();
		const onClose = vi.fn();
		renderCelebration({ onClose });

		fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
		fireEvent.keyDown(window, { key: 'Escape' });

		expect(screen.getByRole('button', { name: 'Onwards!' })).toBeDisabled();
		expect(onClose).not.toHaveBeenCalled();

		act(() => {
			vi.advanceTimersByTime(800);
		});

		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('dismisses from Enter and layer-stack Escape keyboard handling', () => {
		vi.useFakeTimers();
		const onCloseFromEnter = vi.fn();
		const { unmount } = renderCelebration({ onClose: onCloseFromEnter });

		act(() => {
			window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		});
		act(() => {
			vi.advanceTimersByTime(800);
		});
		expect(onCloseFromEnter).toHaveBeenCalledTimes(1);
		unmount();

		const onCloseFromEscape = vi.fn();
		renderCelebration({ onClose: onCloseFromEscape });
		act(() => {
			window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		});
		act(() => {
			vi.advanceTimersByTime(800);
		});

		expect(onCloseFromEscape).toHaveBeenCalledTimes(1);
	});

	it('ignores unrelated keyboard shortcuts', () => {
		vi.useFakeTimers();
		const onClose = vi.fn();
		renderCelebration({ onClose });

		act(() => {
			window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
			vi.advanceTimersByTime(800);
		});

		expect(onClose).not.toHaveBeenCalled();
		expect(screen.getByRole('button', { name: 'Continue' })).not.toBeDisabled();
	});

	it('registers a layer-stack escape handler that starts the close sequence', () => {
		vi.useFakeTimers();
		const onClose = vi.fn();
		let registeredEscapeHandler: (() => void) | undefined;

		vi.spyOn(LayerStackContext, 'useLayerStack').mockReturnValue({
			registerLayer: vi.fn((layer) => {
				registeredEscapeHandler = layer.onEscape;
				return 'keyboard-mastery-layer';
			}),
			unregisterLayer: vi.fn(),
			updateLayerHandler: vi.fn(),
		} as unknown as ReturnType<typeof LayerStackContext.useLayerStack>);

		render(<KeyboardMasteryCelebration theme={mockTheme} level={2} onClose={onClose} />);

		expect(registeredEscapeHandler).toEqual(expect.any(Function));

		act(() => {
			registeredEscapeHandler?.();
			vi.advanceTimersByTime(800);
		});

		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('clears pending close and Maestro burst timers on unmount', () => {
		vi.useFakeTimers();
		const onClose = vi.fn();
		const { unmount } = renderCelebration({ level: 4, onClose });

		fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
		unmount();
		act(() => {
			vi.advanceTimersByTime(800);
		});

		expect(onClose).not.toHaveBeenCalled();
		expect(confetti).toHaveBeenCalledTimes(2);
	});
});
