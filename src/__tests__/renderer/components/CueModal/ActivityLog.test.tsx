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

// A gated row is an event its subscription's gate skipped. Nothing ran, so it
// must read as neither a success nor a failure, and it must say why.
describe('ActivityLog gated events', () => {
	const gatedRun = (reason = 'The comment is praise and asks for nothing.') =>
		makeRun({
			runId: 'run-gated',
			status: 'gated',
			stdout: '',
			exitCode: null,
			durationMs: 40,
			event: {
				id: 'evt-2',
				type: 'github.issue',
				timestamp: new Date('2026-09-14T10:00:00Z').toISOString(),
				triggerName: 'nightly',
				payload: { number: 7, title: 'Thanks', gate: { outcome: 'gated', reason } },
			},
		});

	function renderWithQuery(log: CueRunResult[], searchQuery: string) {
		return render(
			<ActivityLog
				log={log}
				theme={theme}
				subscriptionPipelineMap={new Map()}
				searchQuery={searchQuery}
				setSearchQuery={vi.fn()}
				searchInputRef={{ current: null }}
			/>
		);
	}

	it('labels the row gated, not completed or failed, and shows the reason', () => {
		renderLog([gatedRun()]);

		expect(screen.getByText('gated')).toBeTruthy();
		expect(screen.queryByText(/completed in/)).toBeNull();
		expect(screen.queryByText(/✗/)).toBeNull();
		expect(screen.getByText(/The comment is praise and asks for nothing\./)).toBeTruthy();
	});

	it('finds a gated row by its reason', () => {
		renderWithQuery([gatedRun(), makeRun()], 'praise');

		expect(screen.getByText('gated')).toBeTruthy();
		expect(screen.queryByText(/completed in/)).toBeNull();
	});

	it('shows the verdict in the expanded detail, apart from the event payload', () => {
		renderLog([gatedRun()]);
		fireEvent.click(screen.getByText('gated'));

		const detail = screen.getByTestId('cue-activity-gate');
		expect(detail.textContent).toContain('Skipped the run');
		expect(detail.textContent).toContain('The comment is praise and asks for nothing.');
		// The record is drawn once, in its own section, not again as a payload row.
		expect(screen.queryByText('gate:')).toBeNull();
		expect(screen.getByText('title:')).toBeTruthy();
	});

	it('flags a run that started with its gate unchecked', () => {
		renderLog([
			makeRun({
				event: {
					id: 'evt-3',
					type: 'github.issue',
					timestamp: new Date('2026-09-14T10:00:00Z').toISOString(),
					triggerName: 'nightly',
					payload: { gate: { outcome: 'ran-unchecked', reason: 'Cue gate is off.' } },
				},
			}),
		]);

		// The run itself completed; the warning says the gate did not check it.
		expect(screen.getByText(/completed in/)).toBeTruthy();
		expect(screen.getByLabelText('Gate not checked')).toBeTruthy();
	});

	it('draws no gate marker on a row no gate touched', () => {
		renderLog([makeRun()]);
		expect(screen.queryByLabelText('Gate not checked')).toBeNull();
		expect(screen.queryByText('gated')).toBeNull();
	});
});

// A blocked row is a run the prompt-injection screen refused. Nothing ran, and
// unlike a gated row it is a failure the user has to see, with the reason.
describe('ActivityLog blocked runs', () => {
	const REASON =
		'The new comments ({{CUE_NEW_COMMENTS}}) scored 0.97 on the prompt-injection screen (threshold 0.80).';

	const blockedRun = () =>
		makeRun({
			runId: 'run-blocked',
			status: 'blocked-injection',
			stdout: '',
			// The engine puts the reason where a failed run keeps its error.
			stderr: REASON,
			exitCode: null,
			durationMs: 40,
			event: {
				id: 'evt-4',
				type: 'github.issue',
				timestamp: new Date('2026-09-14T10:00:00Z').toISOString(),
				triggerName: 'nightly',
				payload: {
					number: 7,
					title: 'Hello',
					injectionScreen: {
						outcome: 'blocked',
						reason: REASON,
						variable: 'CUE_NEW_COMMENTS',
						score: 0.97,
						threshold: 0.8,
					},
				},
			},
		});

	it('labels the row blocked, not completed, and shows the variable and score', () => {
		renderLog([blockedRun()]);

		expect(screen.getByText('blocked ✗')).toBeTruthy();
		expect(screen.queryByText(/completed in/)).toBeNull();
		expect(screen.getByText(/\{\{CUE_NEW_COMMENTS\}\}\) scored 0\.97/)).toBeTruthy();
		// The reason is the whole story, so the generic "error output" mark is not added.
		expect(screen.queryByLabelText('Run produced error output')).toBeNull();
	});

	it('shows the verdict once in the expanded detail, apart from the payload and the errors', () => {
		renderLog([blockedRun()]);
		fireEvent.click(screen.getByText('blocked ✗'));

		const detail = screen.getByTestId('cue-activity-injection-screen');
		expect(detail.textContent).toContain('Blocked the run');
		expect(detail.textContent).toContain('scored 0.97');
		expect(screen.queryByText('injectionScreen:')).toBeNull();
		expect(screen.queryByText('Errors')).toBeNull();
		expect(screen.getByText('title:')).toBeTruthy();
	});

	it('flags a run that started without the screen it asked for', () => {
		renderLog([
			makeRun({
				event: {
					id: 'evt-5',
					type: 'github.issue',
					timestamp: new Date('2026-09-14T10:00:00Z').toISOString(),
					triggerName: 'nightly',
					payload: {
						injectionScreen: {
							outcome: 'ran-unscreened',
							reason: 'Prompt-injection screen is off.',
						},
					},
				},
			}),
		]);

		expect(screen.getByText(/completed in/)).toBeTruthy();
		expect(screen.getByLabelText('Not screened for prompt injection')).toBeTruthy();
	});

	it('draws no screen marker on a row the screen found clean, or never touched', () => {
		renderLog([
			makeRun({
				event: {
					id: 'evt-6',
					type: 'github.issue',
					timestamp: new Date('2026-09-14T10:00:00Z').toISOString(),
					triggerName: 'nightly',
					payload: { injectionScreen: { outcome: 'clean', reason: 'Nothing reached 0.80.' } },
				},
			}),
		]);
		expect(screen.queryByLabelText('Not screened for prompt injection')).toBeNull();
		expect(screen.queryByText('blocked ✗')).toBeNull();
	});
});
