import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { RetryCountdown } from '../../../../../renderer/components/FileExplorerPanel/components/RetryCountdown';
import { mockTheme } from '../../../../helpers/mockTheme';

describe('RetryCountdown', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('displays the initial countdown value', () => {
		const retryAt = Date.now() + 5000;
		render(<RetryCountdown retryAt={retryAt} theme={mockTheme} onRetryNow={vi.fn()} />);
		expect(screen.getByText(/Retrying in 5s/)).toBeInTheDocument();
	});

	it('decrements the countdown each second', () => {
		const retryAt = Date.now() + 3000;
		render(<RetryCountdown retryAt={retryAt} theme={mockTheme} onRetryNow={vi.fn()} />);
		act(() => {
			vi.advanceTimersByTime(1000);
		});
		expect(screen.getByText(/Retrying in 2s/)).toBeInTheDocument();
	});

	it('clamps to 0 when retryAt is in the past', () => {
		const retryAt = Date.now() - 1000;
		render(<RetryCountdown retryAt={retryAt} theme={mockTheme} onRetryNow={vi.fn()} />);
		expect(screen.getByText(/Retrying in 0s/)).toBeInTheDocument();
	});

	it('calls onRetryNow when Retry Now is clicked', () => {
		const onRetryNow = vi.fn();
		const retryAt = Date.now() + 10000;
		render(<RetryCountdown retryAt={retryAt} theme={mockTheme} onRetryNow={onRetryNow} />);
		fireEvent.click(screen.getByText('Retry Now'));
		expect(onRetryNow).toHaveBeenCalledTimes(1);
	});
});
