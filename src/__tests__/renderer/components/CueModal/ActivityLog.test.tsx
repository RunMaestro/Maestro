/**
 * Tests for the Activity Log's retention control.
 *
 * The Cue modal has no settings surface, so the dial that governs how long
 * `cue_events` rows survive lives in this header. It writes a global setting
 * the main-process prune reads, so the control must round-trip the real store
 * setter and must never render blank - a blank select would show the user no
 * retention window while the engine prunes by one anyway.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ActivityLog } from '../../../../renderer/components/CueModal/ActivityLog';
import { DEFAULT_CUE_HISTORY_RETENTION_DAYS } from '../../../../shared/cue/retention';
import type { Theme } from '../../../../renderer/types';
import type { CueRunResult } from '../../../../shared/cue';

const setCueHistoryRetentionDays = vi.fn();
let storedRetentionDays: unknown = DEFAULT_CUE_HISTORY_RETENTION_DAYS;

vi.mock('../../../../renderer/stores/settingsStore', () => ({
	useSettingsStore: (
		selector: (s: {
			cueHistoryRetentionDays: unknown;
			setCueHistoryRetentionDays: (v: number) => void;
		}) => unknown
	) =>
		selector({
			cueHistoryRetentionDays: storedRetentionDays,
			setCueHistoryRetentionDays,
		}),
}));

const theme = {
	colors: {
		border: '#333',
		textMain: '#fff',
		textDim: '#888',
		bgActivity: '#111',
		bgMain: '#222',
		accent: '#06b6d4',
		error: '#ff0000',
		success: '#00ff00',
		warning: '#ffaa00',
	},
} as unknown as Theme;

function makeRun(overrides: Partial<CueRunResult> = {}): CueRunResult {
	return {
		runId: 'run-1',
		sessionId: 'agent-1',
		sessionName: 'Maestro',
		subscriptionName: 'nightly',
		event: {
			id: 'evt-1',
			type: 'time',
			timestamp: new Date('2026-09-14T10:00:00Z').toISOString(),
			triggerName: 'nightly',
			payload: {},
		},
		status: 'completed',
		stdout: 'all good',
		stderr: '',
		exitCode: 0,
		durationMs: 1200,
		startedAt: new Date('2026-09-14T10:00:00Z').toISOString(),
		endedAt: new Date('2026-09-14T10:00:01Z').toISOString(),
		...overrides,
	};
}

function renderLog(log: CueRunResult[] = [makeRun()]) {
	return render(
		<ActivityLog
			log={log}
			theme={theme}
			subscriptionPipelineMap={new Map()}
			searchQuery=""
			setSearchQuery={vi.fn()}
			searchInputRef={{ current: null }}
		/>
	);
}

function retentionSelect(): HTMLSelectElement {
	return screen.getByLabelText('Days of Cue run history to keep') as HTMLSelectElement;
}

describe('ActivityLog retention control', () => {
	beforeEach(() => {
		setCueHistoryRetentionDays.mockClear();
		storedRetentionDays = DEFAULT_CUE_HISTORY_RETENTION_DAYS;
	});

	it('shows the stored retention window', () => {
		storedRetentionDays = 30;
		renderLog();
		expect(retentionSelect().value).toBe('30');
	});

	it('shows the default when nothing is stored', () => {
		storedRetentionDays = undefined;
		renderLog();
		expect(retentionSelect().value).toBe(String(DEFAULT_CUE_HISTORY_RETENTION_DAYS));
	});

	// A hand-edited settings file can hold anything. The engine clamps it, so
	// the control must show the SAME clamped number or the user is told a
	// window the prune will not honor.
	it('shows the default rather than a garbage stored value', () => {
		storedRetentionDays = 0;
		renderLog();
		expect(retentionSelect().value).toBe(String(DEFAULT_CUE_HISTORY_RETENTION_DAYS));
	});

	// A value written by the CLI is not guaranteed to be one of the rungs; a
	// native select with no matching option renders blank.
	it('keeps a custom stored value selectable', () => {
		storedRetentionDays = 21;
		renderLog();
		const select = retentionSelect();
		expect(select.value).toBe('21');
		expect(screen.getByRole('option', { name: '21 days' })).toBeTruthy();
	});

	it('writes the chosen window as a number', () => {
		renderLog();
		fireEvent.change(retentionSelect(), { target: { value: '90' } });
		expect(setCueHistoryRetentionDays).toHaveBeenCalledWith(90);
	});

	it('labels a year rather than showing 365 days', () => {
		renderLog();
		expect(screen.getByRole('option', { name: '1 year' })).toBeTruthy();
	});

	// Settings search finds the control by this attribute; the two-way parity
	// test in searchableSettings.test.ts pairs it with the registry entry.
	it('carries the data-setting-id settings search looks for', () => {
		const { container } = renderLog();
		expect(container.querySelector('[data-setting-id="cue-history-retention"]')).toBeTruthy();
	});

	// The dial governs the database, not the rows currently on screen, so it
	// stays usable when the log is empty (search and expand-all do not).
	it('stays available when there is no activity yet', () => {
		renderLog([]);
		expect(retentionSelect().disabled).toBe(false);
	});
});
