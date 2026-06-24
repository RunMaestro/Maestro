import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useElapsedGenerationTime } from '../../../../../renderer/components/InlineWizard/DocumentGenerationView/hooks/useElapsedGenerationTime';

describe('useElapsedGenerationTime', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('uses the persisted start timestamp while generating', () => {
		vi.useFakeTimers();
		vi.setSystemTime(10_000);

		const { result } = renderHook(() => useElapsedGenerationTime(true, 7_000));

		expect(result.current).toBe(3_000);

		act(() => {
			vi.advanceTimersByTime(1_000);
		});

		expect(result.current).toBe(4_000);
	});

	it('does not start an interval after generation is complete', () => {
		vi.useFakeTimers();
		vi.setSystemTime(10_000);

		const { result } = renderHook(() => useElapsedGenerationTime(false, 7_000));

		act(() => {
			vi.advanceTimersByTime(5_000);
		});

		expect(result.current).toBe(3_000);
	});

	it('finalizes elapsed time when generation stops', () => {
		vi.useFakeTimers();
		vi.setSystemTime(10_000);

		const { result, rerender } = renderHook(
			({ isGenerating }) => useElapsedGenerationTime(isGenerating, 7_000),
			{ initialProps: { isGenerating: true } }
		);

		act(() => {
			vi.advanceTimersByTime(1_500);
		});

		expect(result.current).toBe(4_000);

		rerender({ isGenerating: false });

		expect(result.current).toBe(4_500);

		act(() => {
			vi.advanceTimersByTime(5_000);
		});

		expect(result.current).toBe(4_500);
	});
});
