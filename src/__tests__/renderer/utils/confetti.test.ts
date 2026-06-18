import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import confetti from 'canvas-confetti';
import {
	clearConfetti,
	triggerCelebration,
	triggerConfetti,
} from '../../../renderer/utils/confetti';

vi.mock('canvas-confetti', () => {
	const mockConfetti = vi.fn();
	return {
		default: Object.assign(mockConfetti, {
			reset: vi.fn(),
		}),
	};
});

const confettiMock = confetti as unknown as ReturnType<typeof vi.fn> & {
	reset: ReturnType<typeof vi.fn>;
};

function mockReducedMotion(matches: boolean): void {
	Object.defineProperty(window, 'matchMedia', {
		writable: true,
		value: vi.fn().mockReturnValue({
			matches,
			media: '(prefers-reduced-motion: reduce)',
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
		}),
	});
}

describe('confetti utilities', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.clearAllMocks();
		mockReducedMotion(false);
	});

	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
	});

	describe('triggerConfetti', () => {
		it('skips animation when disabled by settings', () => {
			triggerConfetti({ disabled: true });

			expect(confettiMock).not.toHaveBeenCalled();
			expect(window.matchMedia).not.toHaveBeenCalled();
		});

		it('respects reduced motion preferences by default', () => {
			mockReducedMotion(true);

			triggerConfetti();

			expect(window.matchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)');
			expect(confettiMock).not.toHaveBeenCalled();
		});

		it('can ignore reduced motion checks when requested', () => {
			mockReducedMotion(true);

			triggerConfetti({ respectReducedMotion: false, multiBurst: false });

			expect(window.matchMedia).not.toHaveBeenCalled();
			expect(confettiMock).toHaveBeenCalledWith(
				expect.objectContaining({
					disableForReducedMotion: false,
					origin: { x: 0.5, y: 0.9 },
				})
			);
		});

		it('fires the default center burst and delayed side bursts', () => {
			triggerConfetti();

			expect(confettiMock).toHaveBeenCalledTimes(1);
			expect(confettiMock).toHaveBeenNthCalledWith(
				1,
				expect.objectContaining({
					particleCount: 150,
					spread: 70,
					origin: { x: 0.5, y: 0.9 },
					angle: 90,
					zIndex: 99998,
					shapes: ['circle', 'square'],
				})
			);

			vi.advanceTimersByTime(100);

			expect(confettiMock).toHaveBeenCalledTimes(3);
			expect(confettiMock).toHaveBeenNthCalledWith(
				2,
				expect.objectContaining({
					particleCount: 90,
					origin: { x: 0.2, y: 0.9 },
					angle: 60,
				})
			);
			expect(confettiMock).toHaveBeenNthCalledWith(
				3,
				expect.objectContaining({
					particleCount: 90,
					origin: { x: 0.8, y: 0.9 },
					angle: 120,
				})
			);
		});

		it('uses custom burst options and skips side bursts when multiBurst is false', () => {
			triggerConfetti({
				particleCount: 25,
				spread: 45,
				origin: { x: 0.25, y: 0.75 },
				colors: ['#111111', '#eeeeee'],
				multiBurst: false,
			});

			expect(confettiMock).toHaveBeenCalledWith(
				expect.objectContaining({
					particleCount: 25,
					spread: 45,
					origin: { x: 0.25, y: 0.75 },
					colors: ['#111111', '#eeeeee'],
					angle: 90,
				})
			);

			vi.runAllTimers();

			expect(confettiMock).toHaveBeenCalledTimes(1);
		});
	});

	describe('triggerCelebration', () => {
		it('skips celebration when disabled by settings', () => {
			triggerCelebration(true);
			vi.runAllTimers();

			expect(confettiMock).not.toHaveBeenCalled();
		});

		it('fires intense celebration bursts and a delayed star burst', () => {
			triggerCelebration();

			expect(confettiMock).toHaveBeenCalledTimes(1);
			expect(confettiMock).toHaveBeenNthCalledWith(
				1,
				expect.objectContaining({
					particleCount: 300,
					spread: 100,
					angle: 90,
				})
			);

			vi.advanceTimersByTime(100);

			expect(confettiMock).toHaveBeenCalledTimes(3);

			vi.advanceTimersByTime(200);

			expect(confettiMock).toHaveBeenCalledTimes(4);
			expect(confettiMock).toHaveBeenNthCalledWith(
				4,
				expect.objectContaining({
					particleCount: 50,
					spread: 360,
					origin: { x: 0.5, y: 0.5 },
					shapes: ['star'],
					colors: ['#FFD700', '#FFA500', '#FFFFFF'],
					disableForReducedMotion: true,
				})
			);
		});
	});

	describe('clearConfetti', () => {
		it('resets active confetti animations', () => {
			clearConfetti();

			expect(confettiMock.reset).toHaveBeenCalledTimes(1);
		});
	});
});
