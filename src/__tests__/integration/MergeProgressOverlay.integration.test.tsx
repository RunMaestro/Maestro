import { render, screen, fireEvent, act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MergeProgressOverlay } from '../../renderer/components/MergeProgressOverlay';
import type { Theme } from '../../renderer/types';
import type { GroomingProgress, MergeResult } from '../../renderer/types/contextMerge';

const theme: Theme = {
	id: 'test',
	name: 'Test',
	mode: 'dark',
	colors: {
		bgMain: '#000000',
		bgSidebar: '#111111',
		bgActivity: '#1a1a1a',
		border: '#333333',
		textMain: '#ffffff',
		textDim: '#999999',
		accent: '#4f9cff',
		accentDim: '#1c4c7a',
		accentText: '#ffffff',
		accentForeground: '#ffffff',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
	},
};

const createProgress = (overrides: Partial<GroomingProgress> = {}): GroomingProgress => ({
	stage: 'grooming',
	progress: 50,
	message: 'Grooming',
	...overrides,
});

function renderOverlay(props: Partial<React.ComponentProps<typeof MergeProgressOverlay>> = {}) {
	const onCancel = vi.fn();
	render(
		<MergeProgressOverlay
			theme={theme}
			progress={createProgress()}
			result={null}
			sourceName="Source Agent"
			targetName="Target Agent"
			onCancel={onCancel}
			startTime={Date.now() - 1500}
			{...props}
		/>
	);
	return { onCancel };
}

describe('MergeProgressOverlay', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('renders running merge progress with source, target, stages, and elapsed time', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:01:05.000Z'));

		renderOverlay({
			progress: createProgress({ stage: 'grooming', progress: 42 }),
			startTime: new Date('2026-01-01T00:00:00.000Z').getTime(),
		});

		expect(screen.getByText('Merging "Source Agent" into "Target Agent"...')).toBeInTheDocument();
		expect(screen.getByText('1m 5s')).toBeInTheDocument();
		expect(screen.getByText('Collect contexts')).toBeInTheDocument();
		expect(screen.getByText('Groom with AI')).toBeInTheDocument();
		expect(screen.getByText('Add to session')).toBeInTheDocument();
		expect(screen.getByText('Complete')).toBeInTheDocument();

		act(() => {
			vi.advanceTimersByTime(1000);
		});
		expect(screen.getByText('1m 6s')).toBeInTheDocument();
	});

	it('opens cancel confirmation, continues, and confirms cancellation', () => {
		const { onCancel } = renderOverlay();

		fireEvent.click(screen.getByTitle('Cancel'));
		expect(screen.getByText('Cancel Merge?')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
		expect(screen.queryByText('Cancel Merge?')).not.toBeInTheDocument();

		fireEvent.click(screen.getByTitle('Cancel'));
		fireEvent.click(screen.getByTitle('Cancel'));

		expect(onCancel).toHaveBeenCalledTimes(1);
		expect(screen.queryByText('Cancel Merge?')).not.toBeInTheDocument();
	});

	it('renders failed merge state with error message and no progress stages', () => {
		const result: MergeResult = {
			success: false,
			error: 'Grooming agent failed',
		};

		renderOverlay({
			progress: createProgress({ stage: 'creating', progress: 75 }),
			result,
			sourceName: undefined,
			targetName: undefined,
		});

		expect(screen.getByText('Merge Failed')).toBeInTheDocument();
		expect(screen.getByText('Grooming agent failed')).toBeInTheDocument();
		expect(screen.queryByText('Collect contexts')).not.toBeInTheDocument();
		expect(screen.getByTitle('Cancel')).toBeInTheDocument();
	});

	it('renders complete state with token savings and no cancel button', () => {
		const result: MergeResult = {
			success: true,
			tokensSaved: 12345,
		};

		renderOverlay({
			progress: createProgress({ stage: 'complete', progress: 100 }),
			result,
		});

		expect(screen.getByText('Contexts Merged')).toBeInTheDocument();
		expect(screen.getByText('Saved ~12,345 tokens through deduplication')).toBeInTheDocument();
		expect(screen.queryByTitle('Cancel')).not.toBeInTheDocument();
	});

	it('falls back to generic title and zero progress without progress data', () => {
		renderOverlay({
			progress: null,
			result: null,
			sourceName: undefined,
			targetName: undefined,
		});

		expect(screen.getByText('Merging Contexts...')).toBeInTheDocument();
		expect(screen.getByText('Collect contexts')).toBeInTheDocument();
		expect(screen.getByTitle('Cancel')).toBeInTheDocument();
	});

	it('omits token savings when completion has no positive savings', () => {
		renderOverlay({
			progress: createProgress({ stage: 'complete', progress: 100 }),
			result: { success: true, tokensSaved: 0 },
		});

		expect(screen.getByText('Contexts Merged')).toBeInTheDocument();
		expect(screen.queryByText(/Saved ~/i)).not.toBeInTheDocument();
	});
});
