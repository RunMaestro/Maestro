// Source: src/__tests__/renderer/stores/statsIndexingStore.test.ts
// Source: src/__tests__/renderer/stores/aiCommandStore.test.ts
import { describe as describeSourceSuite } from 'vitest';
import { beforeEach } from 'vitest';
import { describe } from 'vitest';
import { expect } from 'vitest';
import { it } from 'vitest';
import { selectStatsIndexingActive } from '../../../renderer/stores/statsIndexingStore';
import { useStatsIndexingStore } from '../../../renderer/stores/statsIndexingStore';
import { EMPTY_STATS_INDEXING_STATE } from '../../../shared/statsIndexing';
import { STATS_INDEXING_VISIBLE_MIN_FILES } from '../../../shared/statsIndexing';
import type { StatsIndexingState } from '../../../shared/statsIndexing';
import { test } from 'vitest';
import { aiCommandKey } from '../../../renderer/stores/aiCommandStore';
import { getAiCommandEntry } from '../../../renderer/stores/aiCommandStore';
import { useAiCommandStore } from '../../../renderer/stores/aiCommandStore';
describeSourceSuite('statsIndexingStore', () => {
	const scanning = (surfaced = true): StatsIndexingState => ({
		jobs: [
			{
				id: 'global-stats',
				label: 'Usage totals',
				reason: 'upgrade',
				doneFiles: 0,
				totalFiles: STATS_INDEXING_VISIBLE_MIN_FILES,
				doneBytes: 0,
				totalBytes: 1000,
				startedAt: 0,
				updatedAt: 0,
				surfaced,
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

		it('does not count a scan main has not surfaced as active', () => {
			useStatsIndexingStore.getState().applyState(scanning(false));
			expect(selectStatsIndexingActive(useStatsIndexingStore.getState())).toBe(false);
		});
	});
});
describeSourceSuite('aiCommandStore', () => {
	const SESSION = 'session-1';
	const TAB = 'tab-1';
	const KEY = aiCommandKey(SESSION, TAB);

	function begin(requestId = 'req-1', request = 'find big files', tabId = TAB) {
		useAiCommandStore.getState().beginAiCommand({ requestId, sessionId: SESSION, tabId, request });
	}

	beforeEach(() => {
		useAiCommandStore.setState({ entries: {} });
	});

	describe('aiCommandStore', () => {
		test('a new request starts thinking with Run preselected', () => {
			// The user asked for the command, so the common case is Enter-to-run.
			begin();
			const entry = useAiCommandStore.getState().entries[KEY];
			expect(entry.status).toBe('thinking');
			expect(entry.choice).toBe('run');
		});

		test('resolving moves it to a proposal', () => {
			begin();
			useAiCommandStore.getState().resolveAiCommand('req-1', 'du -sh *');
			expect(useAiCommandStore.getState().entries[KEY]).toMatchObject({
				status: 'proposed',
				command: 'du -sh *',
			});
		});

		test('a reply for a dismissed request is dropped', () => {
			// Escape must actually mean gone: without the request-id check the card
			// would pop back onto the screen seconds after the user closed it.
			begin();
			useAiCommandStore.getState().clearAiCommand(KEY);
			useAiCommandStore.getState().resolveAiCommand('req-1', 'du -sh *');
			expect(useAiCommandStore.getState().entries[KEY]).toBeUndefined();
		});

		test('a reply for a superseded request does not overwrite the current one', () => {
			begin('req-1', 'first ask');
			begin('req-2', 'second ask');
			useAiCommandStore.getState().resolveAiCommand('req-1', 'stale command');

			const entry = useAiCommandStore.getState().entries[KEY];
			expect(entry.requestId).toBe('req-2');
			expect(entry.status).toBe('thinking');
		});

		test('failure is recorded on the entry rather than clearing it', () => {
			begin();
			useAiCommandStore.getState().failAiCommand('req-1', 'nothing came back');
			expect(useAiCommandStore.getState().entries[KEY]).toMatchObject({
				status: 'error',
				error: 'nothing came back',
			});
		});

		test('entries are per tab, so a request in one tab does not touch another', () => {
			begin('req-1', 'first ask', TAB);
			begin('req-2', 'second ask', 'tab-2');

			expect(getAiCommandEntry(SESSION, TAB)?.request).toBe('first ask');
			expect(getAiCommandEntry(SESSION, 'tab-2')?.request).toBe('second ask');

			useAiCommandStore.getState().clearAiCommand(aiCommandKey(SESSION, 'tab-2'));
			expect(getAiCommandEntry(SESSION, TAB)).toBeDefined();
		});

		test('getAiCommandEntry tolerates missing ids', () => {
			expect(getAiCommandEntry(undefined, TAB)).toBeUndefined();
			expect(getAiCommandEntry(SESSION, undefined)).toBeUndefined();
		});
	});
});
