import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useConfettiPlayground } from '../../../../../renderer/components/PlaygroundPanel/hooks';

const mockConfetti = vi.fn();

vi.mock('canvas-confetti', () => ({
	default: (options: unknown) => mockConfetti(options),
}));

describe('useConfettiPlayground', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		Object.assign(navigator, {
			clipboard: {
				writeText: vi.fn().mockResolvedValue(undefined),
			},
		});
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('starts with the default confetti settings', () => {
		const { result } = renderHook(() => useConfettiPlayground());

		expect(result.current).toMatchObject({
			particleCount: 100,
			angle: 90,
			spread: 45,
			startVelocity: 45,
			gravity: 1,
			decay: 0.9,
			drift: 0,
			scalar: 1,
			ticks: 200,
			flat: false,
			shapes: ['square', 'circle'],
		});
		expect(result.current.selectedOrigins).toEqual(new Set(['2-1']));
		expect(result.current.colors).toHaveLength(8);
	});

	it('toggles origins and disables launch when none are selected', () => {
		const { result } = renderHook(() => useConfettiPlayground());

		act(() => {
			result.current.toggleOrigin(2, 1);
		});
		expect(result.current.selectedOrigins.size).toBe(0);

		act(() => {
			result.current.firePlaygroundConfetti();
		});
		expect(mockConfetti).not.toHaveBeenCalled();
	});

	it('fires confetti for each selected origin with split particle counts', () => {
		const { result } = renderHook(() => useConfettiPlayground());

		act(() => {
			result.current.toggleOrigin(0, 0);
		});
		act(() => {
			result.current.firePlaygroundConfetti();
		});

		expect(mockConfetti).toHaveBeenCalledTimes(2);
		expect(mockConfetti).toHaveBeenCalledWith(
			expect.objectContaining({ particleCount: 50, origin: { x: 0.5, y: 1 } })
		);
		expect(mockConfetti).toHaveBeenCalledWith(
			expect.objectContaining({ particleCount: 50, origin: { x: 0, y: 0 } })
		);
	});

	it('updates shape, color, and physics state', () => {
		const { result } = renderHook(() => useConfettiPlayground());

		act(() => {
			result.current.toggleShape('star');
			result.current.toggleShape('square');
			result.current.setColorAt(0, '#00ff00');
			result.current.addColor();
			result.current.setGravity(2.2);
			result.current.setFlat(true);
		});

		expect(result.current.shapes).toEqual(['circle', 'star']);
		expect(result.current.colors[0]).toBe('#00ff00');
		expect(result.current.colors).toHaveLength(9);
		expect(result.current.gravity).toBe(2.2);
		expect(result.current.flat).toBe(true);
	});

	it('does not remove the final shape or final color', () => {
		const { result } = renderHook(() => useConfettiPlayground());

		act(() => {
			result.current.toggleShape('square');
			result.current.toggleShape('circle');
		});
		expect(result.current.shapes).toEqual(['circle']);

		act(() => {
			for (let index = 0; index < 12; index += 1) {
				result.current.removeColor(0);
			}
		});
		expect(result.current.colors).toHaveLength(1);
	});

	it('copies settings and clears the success state after the timeout', async () => {
		vi.useFakeTimers();
		const { result } = renderHook(() => useConfettiPlayground());

		await act(async () => {
			await result.current.copyConfettiSettings();
		});

		expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
			expect.stringContaining('// Confetti Settings')
		);
		expect(result.current.copySuccess).toBe(true);

		act(() => {
			vi.advanceTimersByTime(2000);
		});
		expect(result.current.copySuccess).toBe(false);
	});

	it('does not show copy success when clipboard write fails', async () => {
		Object.assign(navigator, {
			clipboard: {
				writeText: vi.fn().mockRejectedValue(new Error('Clipboard error')),
			},
		});
		const { result } = renderHook(() => useConfettiPlayground());

		await act(async () => {
			await result.current.copyConfettiSettings();
		});

		expect(result.current.copySuccess).toBe(false);
	});

	it('resets settings to defaults', () => {
		const { result } = renderHook(() => useConfettiPlayground());

		act(() => {
			result.current.setParticleCount(250);
			result.current.toggleOrigin(0, 0);
			result.current.toggleShape('star');
			result.current.addColor();
			result.current.resetConfettiSettings();
		});

		expect(result.current.particleCount).toBe(100);
		expect(result.current.selectedOrigins).toEqual(new Set(['2-1']));
		expect(result.current.shapes).toEqual(['square', 'circle']);
		expect(result.current.colors).toHaveLength(8);
	});
});
