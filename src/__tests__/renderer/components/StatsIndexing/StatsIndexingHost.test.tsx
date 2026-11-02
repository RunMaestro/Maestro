import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StatsIndexingHost } from '../../../../renderer/components/StatsIndexing/StatsIndexingHost';
import { LayerStackProvider } from '../../../../renderer/contexts/LayerStackContext';
import { useStatsIndexingStore } from '../../../../renderer/stores/statsIndexingStore';
import { mockTheme } from '../../../helpers/mockTheme';
import {
	EMPTY_STATS_INDEXING_STATE,
	STATS_INDEXING_VISIBLE_MIN_FILES,
	type StatsIndexingState,
} from '../../../../shared/statsIndexing';

const scanning: StatsIndexingState = {
	jobs: [
		{
			id: 'global-stats',
			label: 'Usage totals',
			reason: 'upgrade',
			doneFiles: 10,
			totalFiles: STATS_INDEXING_VISIBLE_MIN_FILES * 4,
			doneBytes: 250,
			totalBytes: 1000,
			startedAt: Date.now(),
			updatedAt: Date.now(),
			surfaced: true,
		},
	],
};

function renderHost() {
	return render(
		<LayerStackProvider>
			<StatsIndexingHost theme={mockTheme} />
		</LayerStackProvider>
	);
}

describe('StatsIndexingHost', () => {
	let push: ((state: StatsIndexingState) => void) | undefined;

	beforeEach(() => {
		useStatsIndexingStore.setState({
			state: EMPTY_STATS_INDEXING_STATE,
			presentation: 'modal',
			preferBackground: false,
		});
		push = undefined;
		vi.mocked(window.maestro.stats.getIndexingState).mockResolvedValue(EMPTY_STATS_INDEXING_STATE);
		vi.mocked(window.maestro.stats.onIndexingUpdate).mockImplementation((callback) => {
			push = callback;
			return () => {};
		});
	});

	it('renders nothing while no scan is running', () => {
		const { container } = renderHost();
		expect(container).toBeEmptyDOMElement();
	});

	it('shows a pushed upgrade as a modal with its progress', async () => {
		renderHost();
		await waitFor(() => expect(push).toBeDefined());
		act(() => push!(scanning));

		expect(screen.getByTestId('stats-indexing-modal')).toBeInTheDocument();
		expect(screen.getByText('Upgrading usage data')).toBeInTheDocument();
		expect(screen.getByTestId('stats-indexing-modal-bar')).toHaveAttribute('aria-valuenow', '25');
	});

	it('picks up a scan already running when the window opens', async () => {
		vi.mocked(window.maestro.stats.getIndexingState).mockResolvedValue(scanning);
		renderHost();
		expect(await screen.findByTestId('stats-indexing-modal')).toBeInTheDocument();
	});

	it('shrinks to the corner card on Continue in background, and expands again on click', async () => {
		vi.mocked(window.maestro.stats.getIndexingState).mockResolvedValue(scanning);
		renderHost();
		fireEvent.click(await screen.findByText('Continue in background'));

		expect(screen.queryByTestId('stats-indexing-modal')).not.toBeInTheDocument();
		expect(screen.getByTestId('stats-indexing-card')).toHaveTextContent('25%');

		fireEvent.click(screen.getByTestId('stats-indexing-card-expand'));
		expect(screen.getByTestId('stats-indexing-modal')).toBeInTheDocument();
	});

	it('hides the card until the next scan', async () => {
		vi.mocked(window.maestro.stats.getIndexingState).mockResolvedValue(scanning);
		renderHost();
		fireEvent.click(await screen.findByText('Continue in background'));
		fireEvent.click(screen.getByLabelText('Hide scan progress'));
		expect(screen.queryByTestId('stats-indexing-card')).not.toBeInTheDocument();
	});
});
