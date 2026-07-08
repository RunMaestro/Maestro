import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SummarizeProgressOverlay } from '../../renderer/components/SummarizeProgressOverlay';
import type { Theme } from '../../renderer/types';
import type { SummarizeProgress, SummarizeResult } from '../../renderer/types/contextMerge';

vi.mock('lucide-react', () => ({
	X: ({ className }: { className?: string }) => <svg data-testid="x-icon" className={className} />,
	Check: ({ className }: { className?: string }) => (
		<svg data-testid="check-icon" className={className} />
	),
	Loader2: ({ className }: { className?: string }) => (
		<svg data-testid="loader-icon" className={className} />
	),
	AlertTriangle: ({ className }: { className?: string }) => (
		<svg data-testid="alert-icon" className={className} />
	),
	Wand2: ({ className }: { className?: string }) => (
		<svg data-testid="wand-icon" className={className} />
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
		warning: '#f59e0b',
		error: '#ef4444',
		buttonBg: '#333333',
		buttonHover: '#444444',
		headerBg: '#202020',
		scrollbarTrack: '#111111',
		scrollbarThumb: '#444444',
	},
};

const summarizingProgress: SummarizeProgress = {
	stage: 'summarizing',
	progress: 45,
	message: 'Compressing long conversation',
};

const successResult: SummarizeResult = {
	success: true,
	newTabId: 'tab-2',
	originalTokens: 12_000,
	compactedTokens: 3_000,
	reductionPercent: 75,
};

function renderOverlay(props: Partial<React.ComponentProps<typeof SummarizeProgressOverlay>> = {}) {
	return render(
		<SummarizeProgressOverlay
			theme={mockTheme}
			progress={summarizingProgress}
			result={null}
			onCancel={vi.fn()}
			startTime={Date.now()}
			{...props}
		/>
	);
}

describe('SummarizeProgressOverlay', () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
		vi.restoreAllMocks();
	});

	it('renders in-progress status, timer, progress bar, and stage indicators', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
		const { container } = renderOverlay({ startTime: Date.now() });

		expect(screen.getByText('Summarizing Context...')).toBeInTheDocument();
		expect(screen.getByText('0ms')).toBeInTheDocument();
		expect(screen.getByText('Extract context')).toBeInTheDocument();
		expect(screen.getByText('Summarize with AI')).toBeInTheDocument();
		expect(screen.getByText('Create new tab')).toBeInTheDocument();
		expect(screen.getByText('Complete')).toBeInTheDocument();
		expect(screen.getByTestId('wand-icon')).toBeInTheDocument();
		expect(screen.getByTestId('loader-icon')).toBeInTheDocument();
		expect(container.querySelector('[style*="width: 45%"]')).toBeInTheDocument();

		act(() => {
			vi.advanceTimersByTime(61_000);
		});

		expect(screen.getByText('1m 1s')).toBeInTheDocument();
	});

	it('falls back to the first stage and 0 percent when progress is missing', () => {
		const { container } = renderOverlay({ progress: null });

		expect(screen.getByText('Summarizing Context...')).toBeInTheDocument();
		expect(container.querySelector('[style*="width: 0%"]')).toBeInTheDocument();
		expect(screen.getByText('Extract context')).toHaveStyle({
			fontWeight: '500',
		});
	});

	it('asks before canceling, supports dismissing confirmation, and confirms from Yes', () => {
		const onCancel = vi.fn();
		renderOverlay({ onCancel });

		fireEvent.click(screen.getByTitle('Cancel'));
		expect(screen.getByText('Cancel Compaction?')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'No' }));
		expect(screen.queryByText('Cancel Compaction?')).not.toBeInTheDocument();

		fireEvent.click(screen.getByTitle('Cancel'));
		fireEvent.click(screen.getByRole('button', { name: 'Yes' }));

		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it('confirms cancellation when the cancel icon is clicked twice', () => {
		const onCancel = vi.fn();
		renderOverlay({ onCancel });
		const cancelButton = screen.getByTitle('Cancel');

		fireEvent.click(cancelButton);
		fireEvent.click(cancelButton);

		expect(onCancel).toHaveBeenCalledTimes(1);
		expect(screen.queryByText('Cancel Compaction?')).not.toBeInTheDocument();
	});

	it('renders completion state, hides cancel, and shows reduction stats', () => {
		const { container } = renderOverlay({
			progress: { stage: 'complete', progress: 100, message: 'Ready' },
			result: successResult,
		});

		expect(screen.getByText('Context Compacted')).toBeInTheDocument();
		expect(screen.queryByTitle('Cancel')).not.toBeInTheDocument();
		expect(screen.getByText(/Reduced context by 75%/)).toBeInTheDocument();
		expect(screen.getAllByTestId('check-icon').length).toBeGreaterThan(0);
		expect(container.querySelector('[style*="width: 100%"]')).toBeInTheDocument();
	});

	it('shows zero token fallbacks when completion stats omit token counts', () => {
		renderOverlay({
			progress: { stage: 'complete', progress: 100, message: 'Ready' },
			result: {
				success: true,
				reductionPercent: 0,
			},
		});

		expect(screen.getByText(/Reduced context by 0%/)).toBeInTheDocument();
		expect(screen.getByText(/~0.*~0 tokens/)).toBeInTheDocument();
	});

	it('renders error state without progress stages or completion stats', () => {
		renderOverlay({
			result: {
				success: false,
				error: 'Model failed while compacting context',
			},
		});

		expect(screen.getByText('Summarization Failed')).toBeInTheDocument();
		expect(screen.getByText('Model failed while compacting context')).toBeInTheDocument();
		expect(screen.getByTestId('alert-icon')).toBeInTheDocument();
		expect(screen.queryByText('Extract context')).not.toBeInTheDocument();
		expect(screen.queryByText(/Reduced context by/)).not.toBeInTheDocument();
	});
});
