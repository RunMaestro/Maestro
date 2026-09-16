import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import {
	HistoryEntryItem,
	estimateHistoryRowHeight,
	ESTIMATED_ROW_HEIGHT_BASE,
	ESTIMATED_ROW_HEIGHT_FOOTER,
	ESTIMATED_ROW_HEIGHT_CUE_SUBTITLE,
} from '../../../../renderer/components/History';
import type { HistoryEntry } from '../../../../renderer/types';
import { mockTheme } from '../../../helpers/mockTheme';

/**
 * Row-height estimation for CUE rows now that they are served from `cue_events`
 * rather than the agent's JSONL file (CUE-HISTORY-02).
 *
 * `estimateHistoryRowHeight` decides a row's height from a handful of fields,
 * but the row's ACTUAL height is decided by `HistoryEntryItem`'s own render
 * conditions. The two are separate predicates over the same entry, so they can
 * drift - and when the estimate comes in UNDER the render, adjacent rows
 * overlap for the frame between the initial paint and the ResizeObserver
 * correction. These tests pin them together: each case renders the entry and
 * derives the expected height from what actually landed in the DOM.
 */

/**
 * The three shapes a DB-sourced CUE row can take, mirroring
 * `cueEventToHistoryEntry()` in `src/main/cue/stats/cue-stats-query.ts`:
 *
 * - `cueEventType` is always set (`cue_events.type` is NOT NULL).
 * - `elapsedTimeMs` is set only when `completed_at` is non-NULL, so an orphaned
 *   `running` row - served as a failure - carries no footer at all. That is the
 *   one variant the JSONL writer effectively never produced.
 * - `usageStats`, `achievementAction`, `hostname` and `tokenSource` are never
 *   set on a Cue row from either writer, so the footer hangs on `elapsedTimeMs`
 *   alone.
 */
const cueRow = (overrides: Partial<HistoryEntry> = {}): HistoryEntry => ({
	id: 'cue-event-1',
	type: 'CUE',
	timestamp: Date.now(),
	summary: 'Ran the lint sweep and fixed 3 files',
	fullResponse: 'full output',
	projectPath: '/test/project',
	sessionId: 'agent-1',
	sessionName: 'Maestro',
	success: true,
	elapsedTimeMs: 4200,
	cueTriggerName: 'lint-on-save',
	cueEventType: 'file.changed',
	...overrides,
});

/** Height the DOM actually implies, read back from the rendered row. */
function renderedHeightTerms(entry: HistoryEntry): number {
	const { container, unmount } = render(
		<HistoryEntryItem
			entry={entry}
			index={0}
			isSelected={false}
			theme={mockTheme}
			onOpenDetailModal={vi.fn()}
		/>
	);
	const hasFooter = container.querySelector('.border-t') !== null;
	// The tally line of a grouped row replaces the "Triggered by:" subtitle and
	// occupies the same slot, so either one counts as the subtitle term.
	const subtitleText = container.textContent ?? '';
	const hasCueSubtitle =
		subtitleText.includes('Triggered by:') || container.querySelector('[data-cue-group]') !== null;
	unmount();

	return (
		ESTIMATED_ROW_HEIGHT_BASE +
		(hasFooter ? ESTIMATED_ROW_HEIGHT_FOOTER : 0) +
		(hasCueSubtitle ? ESTIMATED_ROW_HEIGHT_CUE_SUBTITLE : 0)
	);
}

describe('estimateHistoryRowHeight for DB-sourced CUE rows', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2025-06-15T12:00:00Z'));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('matches the rendered row for a completed run with output', () => {
		const entry = cueRow();
		expect(estimateHistoryRowHeight(entry)).toBe(renderedHeightTerms(entry));
		expect(estimateHistoryRowHeight(entry)).toBe(
			ESTIMATED_ROW_HEIGHT_BASE + ESTIMATED_ROW_HEIGHT_FOOTER + ESTIMATED_ROW_HEIGHT_CUE_SUBTITLE
		);
	});

	it('matches the rendered row for a failed run', () => {
		const entry = cueRow({ success: false, summary: 'Cue run failed: exit 1' });
		expect(estimateHistoryRowHeight(entry)).toBe(renderedHeightTerms(entry));
	});

	it('drops the footer for a run with no completion time', () => {
		// `completed_at` NULL -> no `elapsedTimeMs` -> no footer row, but the
		// "Triggered by:" subtitle still renders.
		const entry = cueRow({ elapsedTimeMs: undefined });
		expect(estimateHistoryRowHeight(entry)).toBe(renderedHeightTerms(entry));
		expect(estimateHistoryRowHeight(entry)).toBe(
			ESTIMATED_ROW_HEIGHT_BASE + ESTIMATED_ROW_HEIGHT_CUE_SUBTITLE
		);
	});

	it('charges the CUE subtitle for every Cue event type the DB can serve', () => {
		// `cue_events.type` is NOT NULL, so the subtitle is unconditional for a
		// DB row regardless of whether the renderer knows how to humanize the
		// value - an unrecognized type still renders the line.
		for (const cueEventType of [
			'file.changed',
			'agent.completed',
			'time.interval',
			'github.pr',
			'some.future.trigger',
		]) {
			const entry = cueRow({ cueEventType });
			expect(estimateHistoryRowHeight(entry)).toBe(renderedHeightTerms(entry));
		}
	});

	it('matches the rendered row for a collapsed Cue group', () => {
		// The group's tally line sits exactly where the "Triggered by:" subtitle
		// would, so a grouped row costs the same single extra line.
		const entry = cueRow({
			cueGroup: { key: 'Command-Bus', label: 'Command-Bus', runCount: 1382, failureCount: 3 },
		});
		expect(estimateHistoryRowHeight(entry)).toBe(renderedHeightTerms(entry));
		expect(estimateHistoryRowHeight(entry)).toBe(
			ESTIMATED_ROW_HEIGHT_BASE + ESTIMATED_ROW_HEIGHT_FOOTER + ESTIMATED_ROW_HEIGHT_CUE_SUBTITLE
		);
	});

	it('charges the tally line for a group whose row carries no cueEventType', () => {
		// A grouped row renders its tally whether or not the trigger type is
		// known, so the subtitle term can no longer hang on `cueEventType` alone.
		const entry = cueRow({
			cueEventType: undefined,
			cueGroup: { key: 'Command-Bus', label: 'Command-Bus', runCount: 12, failureCount: 0 },
		});
		expect(estimateHistoryRowHeight(entry)).toBe(renderedHeightTerms(entry));
		expect(estimateHistoryRowHeight(entry)).toBe(
			ESTIMATED_ROW_HEIGHT_BASE + ESTIMATED_ROW_HEIGHT_FOOTER + ESTIMATED_ROW_HEIGHT_CUE_SUBTITLE
		);
	});

	it('never under-estimates a USER row, which carries no CUE subtitle', () => {
		// Guards the other direction: the subtitle term must stay CUE-only, or
		// every USER/AUTO row would be over-estimated by 18px and leave a gap.
		const entry: HistoryEntry = {
			id: 'user-1',
			type: 'USER',
			timestamp: Date.now(),
			summary: 'Asked a question',
			projectPath: '/test/project',
			elapsedTimeMs: 1200,
		};
		expect(estimateHistoryRowHeight(entry)).toBe(renderedHeightTerms(entry));
		expect(estimateHistoryRowHeight(entry)).toBe(
			ESTIMATED_ROW_HEIGHT_BASE + ESTIMATED_ROW_HEIGHT_FOOTER
		);
	});
});
