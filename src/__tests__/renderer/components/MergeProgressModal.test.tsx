import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MergeProgressModal } from '../../../renderer/components/MergeProgressModal';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import type { Theme } from '../../../renderer/types';
import type { GroomingProgress } from '../../../renderer/types/contextMerge';

const testTheme: Theme = {
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#1e1e1e',
		bgSidebar: '#252526',
		bgActivity: '#333333',
		textMain: '#d4d4d4',
		textDim: '#808080',
		accent: '#007acc',
		accentForeground: '#ffffff',
		border: '#404040',
		error: '#f14c4c',
		warning: '#cca700',
		success: '#89d185',
		info: '#3794ff',
		textInverse: '#000000',
	},
};

const collectingProgress: GroomingProgress = {
	stage: 'collecting',
	progress: 10,
	message: 'Collecting source contexts...',
};

const groomingProgress: GroomingProgress = {
	stage: 'grooming',
	progress: 45,
	message: 'Removing duplicate context...',
};

const creatingProgress: GroomingProgress = {
	stage: 'creating',
	progress: 80,
	message: 'Adding context to target session...',
};

const completeProgress: GroomingProgress = {
	stage: 'complete',
	progress: 100,
	message: 'Merge complete!',
};

const renderModal = ({
	isOpen = true,
	progress = groomingProgress,
	sourceName,
	targetName,
	onCancel = vi.fn(),
}: {
	isOpen?: boolean;
	progress?: GroomingProgress;
	sourceName?: string;
	targetName?: string;
	onCancel?: () => void;
} = {}) => {
	const view = render(
		<LayerStackProvider>
			<MergeProgressModal
				theme={testTheme}
				isOpen={isOpen}
				progress={progress}
				sourceName={sourceName}
				targetName={targetName}
				onCancel={onCancel}
			/>
		</LayerStackProvider>
	);

	return { ...view, onCancel };
};

describe('MergeProgressModal', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it('does not render when closed', () => {
		renderModal({ isOpen: false });

		expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
	});

	it('renders source and target names, progress, active stages, and spinner', () => {
		renderModal({
			progress: creatingProgress,
			sourceName: 'Feature Branch',
			targetName: 'Main Session',
		});

		expect(screen.getByRole('dialog', { name: 'Merge Progress' })).toHaveAttribute(
			'aria-modal',
			'true'
		);
		expect(screen.getByText('Merging "Feature Branch" into "Main Session"...')).toBeInTheDocument();
		expect(screen.getByText('Adding context to target session...')).toBeInTheDocument();
		expect(screen.getByText('80%')).toBeInTheDocument();
		expect(screen.getByText('Collect contexts')).toHaveStyle({ color: testTheme.colors.success });
		expect(screen.getByText('Groom with AI')).toHaveStyle({ color: testTheme.colors.success });
		expect(screen.getByText('Adding to session...')).toHaveStyle({
			color: testTheme.colors.textMain,
		});
		expect(screen.getByText('Complete')).toHaveStyle({ color: testTheme.colors.textDim });
		expect(document.querySelector('.animate-spin')).toBeInTheDocument();
	});

	it('uses fallback titles and active labels when names or messages are missing', () => {
		const { rerender } = renderModal({ progress: { ...collectingProgress, message: '' } });

		expect(screen.getByText('Merging Contexts...')).toBeInTheDocument();
		expect(screen.getAllByText('Collecting contexts...').length).toBeGreaterThan(0);

		rerender(
			<LayerStackProvider>
				<MergeProgressModal
					theme={testTheme}
					isOpen={true}
					progress={{ ...groomingProgress, message: '' }}
					sourceName="Source Tab"
					onCancel={vi.fn()}
				/>
			</LayerStackProvider>
		);

		expect(screen.getByText('Merging "Source Tab" into "session"...')).toBeInTheDocument();
		expect(screen.getAllByText('Grooming with AI...').length).toBeGreaterThan(0);
	});

	it('falls back to Processing when the stage is unknown', () => {
		renderModal({
			progress: {
				stage: 'unknown' as GroomingProgress['stage'],
				progress: 5,
				message: '',
			},
		});

		expect(screen.getByText('Processing...')).toBeInTheDocument();
		expect(screen.getByText('5%')).toBeInTheDocument();
	});

	it('shows elapsed time and updates from seconds to minutes', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-05-13T14:00:00Z'));
		renderModal({ progress: groomingProgress });

		expect(screen.getByText('Elapsed:')).toBeInTheDocument();
		expect(screen.getByText('0s')).toBeInTheDocument();

		await act(async () => {
			vi.advanceTimersByTime(65_000);
		});

		expect(screen.getByText('1m 5s')).toBeInTheDocument();
	});

	it('opens, dismisses, and confirms cancellation from the Cancel button', () => {
		const onCancel = vi.fn();
		renderModal({ onCancel });

		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

		expect(screen.getByText('Cancel Merge?')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Continue Merge' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Cancel Merge' })).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Continue Merge' }));

		expect(screen.queryByText('Cancel Merge?')).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		fireEvent.click(screen.getByRole('button', { name: 'Cancel Merge' }));

		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it('opens cancellation confirmation from Escape while in progress', async () => {
		renderModal({ progress: groomingProgress });

		fireEvent.keyDown(window, { key: 'Escape' });

		await waitFor(() => {
			expect(screen.getByText('Cancel Merge?')).toBeInTheDocument();
		});
	});

	it('calls onCancel directly from Escape when complete', async () => {
		const onCancel = vi.fn();
		renderModal({ progress: completeProgress, onCancel });

		fireEvent.keyDown(window, { key: 'Escape' });

		await waitFor(() => {
			expect(onCancel).toHaveBeenCalledTimes(1);
		});
	});

	it('renders complete state and closes from Done or the close button', () => {
		const onCancel = vi.fn();
		renderModal({ progress: completeProgress, onCancel });

		expect(screen.getByText('Merge Complete')).toBeInTheDocument();
		expect(screen.getByText('Merge complete!')).toBeInTheDocument();
		expect(screen.queryByText('Elapsed:')).not.toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Done' })).toHaveStyle({
			backgroundColor: testTheme.colors.accent,
		});

		fireEvent.click(screen.getByRole('button', { name: 'Done' }));
		fireEvent.click(screen.getByRole('button', { name: 'Close modal' }));

		expect(onCancel).toHaveBeenCalledTimes(2);
	});

	it('updates the Escape handler when progress changes to complete', async () => {
		const onCancel = vi.fn();
		const { rerender } = renderModal({ progress: groomingProgress, onCancel });

		rerender(
			<LayerStackProvider>
				<MergeProgressModal
					theme={testTheme}
					isOpen={true}
					progress={completeProgress}
					onCancel={onCancel}
				/>
			</LayerStackProvider>
		);

		fireEvent.keyDown(window, { key: 'Escape' });

		await waitFor(() => {
			expect(onCancel).toHaveBeenCalledTimes(1);
		});
		expect(screen.queryByText('Cancel Merge?')).not.toBeInTheDocument();
	});
});
