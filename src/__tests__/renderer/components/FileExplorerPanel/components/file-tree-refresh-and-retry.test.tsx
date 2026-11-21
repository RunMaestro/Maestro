// Source: src/__tests__/renderer/components/FileExplorerPanel/components/AutoRefreshOverlay.test.tsx
// Source: src/__tests__/renderer/components/FileExplorerPanel/components/RetryCountdown.test.tsx
import React from 'react';
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { vi } from 'vitest';
import { render } from '@testing-library/react';
import { screen } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import { AutoRefreshOverlay } from '../../../../../renderer/components/FileExplorerPanel/components/AutoRefreshOverlay';
import { beforeEach } from 'vitest';
import { afterEach } from 'vitest';
import { act } from '@testing-library/react';
import { RetryCountdown } from '../../../../../renderer/components/FileExplorerPanel/components/RetryCountdown';
import { mockTheme } from '../../../../helpers/mockTheme';
describe('AutoRefreshOverlay', () => {
	const theme = {
		colors: {
			bgSidebar: '#1a1a1a',
			border: '#333',
			bgActivity: '#222',
			textMain: '#fff',
			textDim: '#888',
			accent: '#7C3AED',
		},
	} as any;

	const defaultProps = {
		theme,
		position: { top: 100, left: 200 },
		currentInterval: 60,
		onIntervalSelect: vi.fn(),
		onMouseEnter: vi.fn(),
		onMouseLeave: vi.fn(),
	};

	describe('AutoRefreshOverlay', () => {
		it('renders all four interval options', () => {
			render(<AutoRefreshOverlay {...defaultProps} />);
			expect(screen.getByText('Every 5 seconds')).toBeTruthy();
			expect(screen.getByText('Every 20 seconds')).toBeTruthy();
			expect(screen.getByText('Every 60 seconds')).toBeTruthy();
			expect(screen.getByText('Every 3 minutes')).toBeTruthy();
		});

		it('renders the header label', () => {
			render(<AutoRefreshOverlay {...defaultProps} />);
			expect(screen.getByText('Auto-refresh')).toBeTruthy();
		});

		it('calls onIntervalSelect with the correct value when an option is clicked', () => {
			const onIntervalSelect = vi.fn();
			render(<AutoRefreshOverlay {...defaultProps} onIntervalSelect={onIntervalSelect} />);
			fireEvent.click(screen.getByText('Every 5 seconds'));
			expect(onIntervalSelect).toHaveBeenCalledWith(5);
		});

		it('shows the Disable option when currentInterval > 0', () => {
			render(<AutoRefreshOverlay {...defaultProps} currentInterval={60} />);
			expect(screen.getByText('Disable auto-refresh')).toBeTruthy();
		});

		it('does not show the Disable option when currentInterval is 0', () => {
			render(<AutoRefreshOverlay {...defaultProps} currentInterval={0} />);
			expect(screen.queryByText('Disable auto-refresh')).toBeNull();
		});

		it('calls onIntervalSelect with 0 when Disable is clicked', () => {
			const onIntervalSelect = vi.fn();
			render(
				<AutoRefreshOverlay
					{...defaultProps}
					currentInterval={60}
					onIntervalSelect={onIntervalSelect}
				/>
			);
			fireEvent.click(screen.getByText('Disable auto-refresh'));
			expect(onIntervalSelect).toHaveBeenCalledWith(0);
		});

		it('calls onMouseEnter when overlay is moused over', () => {
			const onMouseEnter = vi.fn();
			render(<AutoRefreshOverlay {...defaultProps} onMouseEnter={onMouseEnter} />);
			// Portal renders into document.body, not container
			const overlay = document.body.querySelector('.fixed') as HTMLElement;
			fireEvent.mouseEnter(overlay);
			expect(onMouseEnter).toHaveBeenCalled();
		});

		it('calls onMouseLeave when mouse leaves overlay', () => {
			const onMouseLeave = vi.fn();
			render(<AutoRefreshOverlay {...defaultProps} onMouseLeave={onMouseLeave} />);
			const overlay = document.body.querySelector('.fixed') as HTMLElement;
			fireEvent.mouseLeave(overlay);
			expect(onMouseLeave).toHaveBeenCalled();
		});
	});
});
describe('RetryCountdown', () => {
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
});
