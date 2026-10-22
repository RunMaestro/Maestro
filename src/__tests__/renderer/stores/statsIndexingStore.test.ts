import { beforeEach, describe, expect, it } from 'vitest';
import {
	selectStatsIndexingActive,
	useStatsIndexingStore,
} from '../../../renderer/stores/statsIndexingStore';
import {
	EMPTY_STATS_INDEXING_STATE,
	STATS_INDEXING_VISIBLE_MIN_FILES,
	type StatsIndexingState,
} from '../../../shared/statsIndexing';

const scanning = (files = STATS_INDEXING_VISIBLE_MIN_FILES): StatsIndexingState => ({
	jobs: [
		{
			id: 'global-stats',
			label: 'Usage totals',
			reason: 'upgrade',
			doneFiles: 0,
			totalFiles: files,
			doneBytes: 0,
			totalBytes: 1000,
			startedAt: 0,
			updatedAt: 0,
		},
	],
});

describe('statsIndexingStore', () => {
	beforeEach(() => {
		useStatsIndexingStore.setState({
			state: EMPTY_STATS_INDEXING_STATE,
			presentation: 'modal',
			preferBackground: false,
		});
	});

	it('opens a newly visible scan as the modal', () => {
		useStatsIndexingStore.getState().hideCard();
		useStatsIndexingStore.getState().applyState(scanning());
		expect(useStatsIndexingStore.getState().presentation).toBe('modal');
		expect(selectStatsIndexingActive(useStatsIndexingStore.getState())).toBe(true);
	});

	it('keeps the presentation while the same scan progresses', () => {
		const store = useStatsIndexingStore.getState();
		store.applyState(scanning());
		store.hideCard();
		store.applyState(scanning());
		expect(useStatsIndexingStore.getState().presentation).toBe('hidden');
	});

	it('starts later scans as the card once the user chose background', () => {
		const store = useStatsIndexingStore.getState();
		store.applyState(scanning());
		store.sendToBackground();
		store.applyState(EMPTY_STATS_INDEXING_STATE);
		store.applyState(scanning());
		expect(useStatsIndexingStore.getState().presentation).toBe('card');
	});

	it('does not count a scan below the visibility threshold as active', () => {
		useStatsIndexingStore.getState().applyState(scanning(STATS_INDEXING_VISIBLE_MIN_FILES - 1));
		expect(selectStatsIndexingActive(useStatsIndexingStore.getState())).toBe(false);
	});
});
