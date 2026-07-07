import { describe, it, expect, beforeEach } from 'vitest';
import type { HistoryEntryType } from '../../../../renderer/types';
import {
	HISTORY_PANEL_FILTERS_KEY,
	historyPanelFilterKeyForAgent,
	loadPersistedHistoryFilters,
	savePersistedHistoryFilters,
	resolveInitialHistoryFilters,
} from '../../../../renderer/components/History';
import { installLocalStorageMock } from '../../../helpers/mockLocalStorage';

const AGENT_A = 'agent-a';
const AGENT_B = 'agent-b';

describe('historyFilterPersistence', () => {
	beforeEach(() => {
		// jsdom here doesn't provide a working Storage; install a fresh
		// in-memory mock each test (doubles as a per-test reset).
		installLocalStorageMock();
	});

	describe('historyPanelFilterKeyForAgent', () => {
		it('namespaces the panel key by agent id', () => {
			expect(historyPanelFilterKeyForAgent(AGENT_A)).toBe(
				`${HISTORY_PANEL_FILTERS_KEY}.${AGENT_A}`
			);
		});

		it('produces a distinct key per agent', () => {
			expect(historyPanelFilterKeyForAgent(AGENT_A)).not.toBe(
				historyPanelFilterKeyForAgent(AGENT_B)
			);
		});
	});

	describe('save/load round trip', () => {
		it('persists and restores a selection under a per-agent key', () => {
			const key = historyPanelFilterKeyForAgent(AGENT_A);
			savePersistedHistoryFilters(key, new Set<HistoryEntryType>(['USER']));
			expect(loadPersistedHistoryFilters(key)).toEqual(new Set(['USER']));
		});

		it('keeps each agent independent', () => {
			savePersistedHistoryFilters(
				historyPanelFilterKeyForAgent(AGENT_A),
				new Set<HistoryEntryType>(['USER'])
			);
			savePersistedHistoryFilters(
				historyPanelFilterKeyForAgent(AGENT_B),
				new Set<HistoryEntryType>(['AUTO', 'CUE'])
			);
			expect(loadPersistedHistoryFilters(historyPanelFilterKeyForAgent(AGENT_A))).toEqual(
				new Set(['USER'])
			);
			expect(loadPersistedHistoryFilters(historyPanelFilterKeyForAgent(AGENT_B))).toEqual(
				new Set(['AUTO', 'CUE'])
			);
		});

		it('treats an empty set as a valid stored choice, distinct from null', () => {
			const key = historyPanelFilterKeyForAgent(AGENT_A);
			expect(loadPersistedHistoryFilters(key)).toBeNull();
			savePersistedHistoryFilters(key, new Set<HistoryEntryType>());
			expect(loadPersistedHistoryFilters(key)).toEqual(new Set());
		});
	});

	describe('resolveInitialHistoryFilters', () => {
		it('defaults to all-on (incl. CUE) when nothing is stored and Cue is enabled', () => {
			const key = historyPanelFilterKeyForAgent(AGENT_A);
			expect(resolveInitialHistoryFilters(key, true)).toEqual(new Set(['USER', 'AUTO', 'CUE']));
		});

		it('strips CUE when the Cue feature is off', () => {
			const key = historyPanelFilterKeyForAgent(AGENT_A);
			savePersistedHistoryFilters(key, new Set<HistoryEntryType>(['USER', 'AUTO', 'CUE']));
			expect(resolveInitialHistoryFilters(key, false)).toEqual(new Set(['USER', 'AUTO']));
		});

		it('hydrates the per-agent selection over the default', () => {
			const key = historyPanelFilterKeyForAgent(AGENT_A);
			savePersistedHistoryFilters(key, new Set<HistoryEntryType>(['AUTO']));
			expect(resolveInitialHistoryFilters(key, true)).toEqual(new Set(['AUTO']));
		});

		it('falls back to the legacy global key the first time an agent is resolved', () => {
			// Simulate a pre-upgrade user who had a global selection saved.
			savePersistedHistoryFilters(HISTORY_PANEL_FILTERS_KEY, new Set<HistoryEntryType>(['USER']));
			const key = historyPanelFilterKeyForAgent(AGENT_A);
			expect(resolveInitialHistoryFilters(key, true, HISTORY_PANEL_FILTERS_KEY)).toEqual(
				new Set(['USER'])
			);
		});

		it('prefers the per-agent selection over the fallback key when both exist', () => {
			savePersistedHistoryFilters(HISTORY_PANEL_FILTERS_KEY, new Set<HistoryEntryType>(['USER']));
			const key = historyPanelFilterKeyForAgent(AGENT_A);
			savePersistedHistoryFilters(key, new Set<HistoryEntryType>(['AUTO']));
			expect(resolveInitialHistoryFilters(key, true, HISTORY_PANEL_FILTERS_KEY)).toEqual(
				new Set(['AUTO'])
			);
		});

		it('respects an empty per-agent set rather than falling back', () => {
			savePersistedHistoryFilters(HISTORY_PANEL_FILTERS_KEY, new Set<HistoryEntryType>(['USER']));
			const key = historyPanelFilterKeyForAgent(AGENT_A);
			savePersistedHistoryFilters(key, new Set<HistoryEntryType>());
			expect(resolveInitialHistoryFilters(key, true, HISTORY_PANEL_FILTERS_KEY)).toEqual(new Set());
		});
	});
});
