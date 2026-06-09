import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SummarizeProgressModal } from '../../../renderer/components/SummarizeProgressModal';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import type { Theme } from '../../../renderer/types';
import type { SummarizeProgress, SummarizeResult } from '../../../renderer/types/contextMerge';

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
	TrendingDown: ({ className }: { className?: string }) => (
		<svg data-testid="trending-down-icon" className={className} />
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

function renderModal(props: Partial<React.ComponentProps<typeof SummarizeProgressModal>> = {}) {
	return render(
		<LayerStackProvider>
			<SummarizeProgressModal
				theme={mockTheme}
				isOpen={true}
				progress={summarizingProgress}
				result={null}
				onCancel={vi.fn()}
				onComplete={vi.fn()}
				{...props}
			/>
		</LayerStackProvider>
	);
}

describe('SummarizeProgressModal', () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
		vi.restoreAllMocks();
	});

	it('does not render when closed', () => {
		renderModal({ isOpen: false });

		expect(
			screen.queryByRole('dialog', { name: 'Summarization Progress' })
		).not.toBeInTheDocument();
	});

	it('renders in-progress status, stage progression, progress value, and elapsed timer', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
		renderModal();

		expect(screen.getByRole('dialog', { name: 'Summarization Progress' })).toBeInTheDocument();
		expect(screen.getByText('Summarizing Context...')).toBeInTheDocument();
		expect(screen.getByText('Compressing long conversation')).toBeInTheDocument();
		expect(screen.getByText('45%')).toBeInTheDocument();
		expect(screen.getByText('Extract context')).toBeInTheDocument();
		expect(screen.getByText('Summarizing with AI...')).toBeInTheDocument();
		expect(screen.getByText('Create new tab')).toBeInTheDocument();
		expect(screen.getByText('Complete')).toBeInTheDocument();
		expect(screen.getByText('0s')).toBeInTheDocument();
		expect(screen.getByTestId('loader-icon')).toBeInTheDocument();
		expect(screen.getByTestId('wand-icon')).toBeInTheDocument();

		act(() => {
			vi.advanceTimersByTime(61_000);
		});

		expect(screen.getByText('1m 1s')).toBeInTheDocument();
	});

	it('falls back to the first stage when progress is missing', () => {
		renderModal({ progress: null });

		expect(screen.getAllByText('Extracting context...')).toHaveLength(2);
		expect(screen.getByText('0%')).toBeInTheDocument();
	});

	it('falls back to processing text when progress stage is unknown and has no message', () => {
		renderModal({
			progress: {
				stage: 'compressing' as SummarizeProgress['stage'],
				progress: 15,
				message: '',
			},
		});

		expect(screen.getByText('Processing...')).toBeInTheDocument();
		expect(screen.getByText('15%')).toBeInTheDocument();
	});

	it('asks for confirmation before canceling and supports dismissing the confirmation', () => {
		const onCancel = vi.fn();
		renderModal({ onCancel });

		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(screen.getByText('Cancel Compaction?')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'No' }));
		expect(screen.queryByText('Cancel Compaction?')).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		fireEvent.click(screen.getByRole('button', { name: 'Yes' }));

		expect(onCancel).toHaveBeenCalledTimes(1);
		expect(screen.queryByText('Cancel Compaction?')).not.toBeInTheDocument();
	});

	it('opens cancellation confirmation from Escape while incomplete', () => {
		renderModal();

		act(() => {
			window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		});

		expect(screen.getByText('Cancel Compaction?')).toBeInTheDocument();
	});

	it('renders success stats and completes from Done and the close icon', () => {
		const onComplete = vi.fn();
		renderModal({
			progress: { stage: 'complete', progress: 100, message: 'Ready to continue' },
			result: successResult,
			onComplete,
		});

		expect(screen.getByText('Summarization Complete')).toBeInTheDocument();
		expect(screen.getByText('Ready to continue')).toBeInTheDocument();
		expect(screen.getByText('100%')).toBeInTheDocument();
		expect(screen.getByText('Context Reduced by 75%')).toBeInTheDocument();
		expect(screen.getByText('~12,000 tokens')).toBeInTheDocument();
		expect(screen.getByText('~3,000 tokens')).toBeInTheDocument();
		expect(screen.getAllByTestId('check-icon').length).toBeGreaterThan(0);

		fireEvent.click(screen.getByRole('button', { name: 'Done' }));
		fireEvent.click(screen.getByRole('button', { name: 'Close modal' }));

		expect(onComplete).toHaveBeenCalledTimes(2);
	});

	it('renders zero token counts when a successful result omits token totals', () => {
		renderModal({
			progress: { stage: 'complete', progress: 100, message: 'Ready to continue' },
			result: {
				success: true,
				reductionPercent: 100,
			} as SummarizeResult,
		});

		expect(screen.getByText('Context Reduced by 100%')).toBeInTheDocument();
		expect(screen.getAllByText('~0 tokens')).toHaveLength(2);
	});

	it('completes from Escape when the summarization is complete', () => {
		const onComplete = vi.fn();
		renderModal({
			progress: { stage: 'complete', progress: 100, message: 'Done' },
			result: successResult,
			onComplete,
		});

		act(() => {
			window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		});

		expect(onComplete).toHaveBeenCalledTimes(1);
	});

	it('renders completion errors without token stats', () => {
		renderModal({
			progress: { stage: 'complete', progress: 100, message: '' },
			result: {
				success: false,
				originalTokens: 0,
				compactedTokens: 0,
				reductionPercent: 0,
				error: 'Model failed while summarizing',
			},
		});

		expect(screen.getAllByText('Complete').length).toBeGreaterThan(0);
		expect(screen.getByText('Model failed while summarizing')).toBeInTheDocument();
		expect(screen.queryByText(/Context Reduced/)).not.toBeInTheDocument();
		expect(screen.getByTestId('alert-icon')).toBeInTheDocument();
	});
});
