import { describe, it, expect } from 'vitest';
import { formatTimestamp } from '../../shared/formatters';
import type { StoredEvent } from '../../shared/computer-history/types';
import type { HistoryEntry } from '../../shared/types';
import {
	DEFAULT_TIMELINE_SOURCES,
	collapseRepeatedAppSwitches,
	computerEventToTimelineEvent,
	formatTimelineLine,
	gitTimelineArgs,
	historyEntryToTimelineEvent,
	isTimelineSource,
	journeyEntryToTimelineEvent,
	parseGitTimeline,
	selectTimelineEvents,
	timelineFollowUp,
	timelineFollowUps,
	type TimelineEvent,
} from '../../shared/timeline';

const NOW = new Date(2026, 9, 18, 14, 30).getTime();
const TODAY = new Date(2026, 9, 18, 14, 2).getTime();
const YESTERDAY = new Date(2026, 9, 17, 9, 15).getTime();
const SHA = '5e6217267fdc8fc45851e994487efc72f6bef442';

function history(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
	return {
		id: '1a2b3c4d-1111-2222-3333-444455556666',
		type: 'USER',
		timestamp: TODAY,
		summary: 'Fixed tooltip clipping',
		projectPath: '/repo',
		...overrides,
	};
}

function event(overrides: Partial<TimelineEvent> = {}): TimelineEvent {
	return { ts: TODAY, source: 'history', agentId: 'agent-1', text: 'USER: x', ...overrides };
}

describe('timeline sources', () => {
	it('knows its sources and leaves Computer History out of the defaults', () => {
		expect(isTimelineSource('git')).toBe(true);
		expect(isTimelineSource('computer')).toBe(true);
		expect(isTimelineSource('transcripts')).toBe(false);
		expect(DEFAULT_TIMELINE_SOURCES).not.toContain('computer');
	});
});

describe('historyEntryToTimelineEvent', () => {
	it('carries the type, tab, one-line summary, and the entry id as the ref', () => {
		expect(
			historyEntryToTimelineEvent(
				history({ sessionName: 'Tooltip', summary: 'Fixed\n tooltip   clipping' }),
				'agent-1'
			)
		).toEqual({
			ts: TODAY,
			source: 'history',
			agentId: 'agent-1',
			text: 'USER (Tooltip): Fixed tooltip clipping',
			ref: '1a2b3c4d-1111-2222-3333-444455556666',
		});
	});

	it('names who asked, the Cue trigger, and a failed turn', () => {
		expect(
			historyEntryToTimelineEvent(history({ type: 'AGENT', sourceAgentName: 'Docs' }), 'a').text
		).toBe('AGENT from Docs: Fixed tooltip clipping');
		expect(
			historyEntryToTimelineEvent(history({ type: 'CUE', cueTriggerName: 'nightly' }), 'a').text
		).toBe('CUE nightly: Fixed tooltip clipping');
		expect(historyEntryToTimelineEvent(history({ success: false }), 'a').text).toBe(
			'USER: Fixed tooltip clipping [failed]'
		);
	});

	it('cuts a long summary at a word boundary and marks an empty one', () => {
		const long = historyEntryToTimelineEvent(history({ summary: 'word '.repeat(100) }), 'a');
		expect(long.text.length).toBeLessThanOrEqual('USER: '.length + 160);
		expect(long.text.endsWith('…')).toBe(true);
		expect(historyEntryToTimelineEvent(history({ summary: '' }), 'a').text).toBe(
			'USER: (no summary)'
		);
	});
});

describe('journeyEntryToTimelineEvent', () => {
	it('describes the action with paths relative to the cwd', () => {
		expect(
			journeyEntryToTimelineEvent(
				{
					ts: TODAY,
					agentId: 'agent-1',
					kind: 'file.save',
					target: '/repo/src/a.ts',
					linesAdded: 2,
					linesRemoved: 1,
				},
				{ cwd: '/repo' }
			)
		).toEqual({
			ts: TODAY,
			source: 'journey',
			agentId: 'agent-1',
			text: 'user saved src/a.ts (+2/-1)',
		});
	});
});

describe('git', () => {
	it('asks for first-parent commits in the window, newest first', () => {
		const args = gitTimelineArgs(TODAY, NOW, 25);
		expect(args[0]).toBe('log');
		expect(args).toContain('--first-parent');
		expect(args).toContain(`--since=${new Date(TODAY).toISOString()}`);
		expect(args).toContain(`--until=${new Date(NOW).toISOString()}`);
		expect(args).toContain('-n25');
		expect(gitTimelineArgs(TODAY, undefined, 25).some((a) => a.startsWith('--until'))).toBe(false);
	});

	it('parses commits and skips malformed lines', () => {
		const seconds = Math.floor(TODAY / 1000);
		const stdout = [
			`${SHA}\x1f${seconds}\x1fAda Lovelace\x1fFix the tooltip`,
			'not a commit',
			`zzzz\x1f${seconds}\x1fA\x1fbad sha`,
			'',
		].join('\n');
		expect(parseGitTimeline(stdout, 'agent-1')).toEqual([
			{
				ts: seconds * 1000,
				source: 'git',
				agentId: 'agent-1',
				text: 'commit by Ada Lovelace: Fix the tooltip',
				ref: SHA,
			},
		]);
	});
});

describe('Computer History', () => {
	function stored(overrides: Partial<StoredEvent>): StoredEvent {
		return {
			v: 1,
			seq: 0,
			ts: new Date(TODAY).toISOString(),
			kind: 'app.activated',
			app: { id: 'com.tinyspeck.slackmacgap', name: 'Slack', pid: 1 },
			...overrides,
		} as StoredEvent;
	}

	it('turns app switches and captured text into short user lines', () => {
		expect(computerEventToTimelineEvent(stored({}))).toEqual({
			ts: TODAY,
			source: 'computer',
			text: 'user switched to Slack',
		});
		expect(
			computerEventToTimelineEvent(stored({ kind: 'text.committed', text: 'ship it '.repeat(30) }))
				?.text
		).toMatch(/^user typed in Slack: ".{1,80}"$/);
		expect(
			computerEventToTimelineEvent(stored({ kind: 'window.changed', window: { title: 'general' } }))
				?.text
		).toBe('user Slack window "general"');
		expect(computerEventToTimelineEvent(stored({ ts: 'not a time' }))).toBeNull();
	});

	it('collapses an app switch that repeats the one before it', () => {
		const slack = event({ source: 'computer', text: 'user switched to Slack' });
		const chrome = event({ source: 'computer', text: 'user switched to Chrome' });
		expect(collapseRepeatedAppSwitches([slack, slack, chrome, slack])).toEqual([
			slack,
			chrome,
			slack,
		]);
	});
});

describe('selectTimelineEvents', () => {
	it('merges oldest first, keeping source order on a tie', () => {
		const a = event({ ts: 3, text: 'c' });
		const b = event({ ts: 1, source: 'git', text: 'a', ref: 'x' });
		const c = event({ ts: 1, source: 'journey', text: 'b' });
		expect(selectTimelineEvents([a, b, c]).map((e) => e.text)).toEqual(['a', 'b', 'c']);
	});

	it('applies the window and the grep, matching text or ref', () => {
		const events = [
			event({ ts: 1, text: 'old' }),
			event({ ts: 5, text: 'auth fix' }),
			event({ ts: 6, source: 'git', text: 'other', ref: 'abcdef1' }),
			event({ ts: 9, text: 'late' }),
		];
		expect(selectTimelineEvents(events, { sinceMs: 2, untilMs: 8 }).map((e) => e.text)).toEqual([
			'auth fix',
			'other',
		]);
		expect(selectTimelineEvents(events, { grep: /AUTH|abcdef/i }).map((e) => e.text)).toEqual([
			'auth fix',
			'other',
		]);
	});

	it('keeps a commit seen from two agents once', () => {
		const one = event({ source: 'git', agentId: 'a', ref: SHA });
		const two = event({ source: 'git', agentId: 'b', ref: SHA });
		expect(selectTimelineEvents([one, two])).toEqual([one]);
	});

	it('caps each source, then the total, keeping the newest', () => {
		const saves = Array.from({ length: 5 }, (_, i) =>
			event({ ts: 10 + i, source: 'journey', text: `save ${i}` })
		);
		const turn = event({ ts: 1, text: 'turn' });
		expect(selectTimelineEvents([turn, ...saves], { perSourceTail: 2 }).map((e) => e.text)).toEqual(
			['turn', 'save 3', 'save 4']
		);
		expect(selectTimelineEvents([turn, ...saves], { tail: 2 }).map((e) => e.text)).toEqual([
			'save 3',
			'save 4',
		]);
		expect(selectTimelineEvents([turn], { tail: 0 })).toEqual([]);
	});
});

describe('formatTimelineLine', () => {
	it('shows the clock, source, text, and a short handle', () => {
		const time = formatTimestamp(TODAY, 'time');
		expect(formatTimelineLine(event({ ref: '1a2b3c4d-9999' }), NOW)).toBe(
			`${time} history USER: x [entry 1a2b3c4d]`
		);
		expect(
			formatTimelineLine(event({ source: 'git', text: 'commit by A: y', ref: SHA }), NOW)
		).toBe(`${time} git commit by A: y [commit 5e621726]`);
		expect(formatTimelineLine(event({ source: 'journey', text: 'user saved a.ts' }), NOW)).toBe(
			`${time} journey user saved a.ts`
		);
	});

	it('names the agent when asked and dates an event from another day', () => {
		expect(formatTimelineLine(event({ ts: YESTERDAY }), NOW, { agentName: 'Docs' })).toBe(
			`${formatTimestamp(YESTERDAY, 'datetime')} history Docs: USER: x`
		);
	});
});

describe('follow-ups', () => {
	it('names the command that reads more about one event', () => {
		expect(timelineFollowUp(event({ ref: 'h-1' }))).toBe('timeline show h-1');
		expect(timelineFollowUp(event({ source: 'git', ref: SHA }))).toBe(`git show ${SHA}`);
		expect(timelineFollowUp(event({ source: 'journey', text: 'user saved a.ts' }))).toBeUndefined();
		expect(timelineFollowUp(event({ source: 'computer', ts: Date.UTC(2026, 0, 1) }))).toBe(
			'computer-history query --since 2026-01-01T00:00:00.000Z --until 2026-01-01T00:05:00.000Z'
		);
	});

	it('lists a read-more line per source present, then how to widen the view', () => {
		const lines = timelineFollowUps([event({}), event({ source: 'git', ref: SHA })]);
		expect(lines[0]).toMatch(/^timeline show <entry>/);
		expect(lines[1]).toMatch(/^git show <commit>/);
		expect(lines.some((l) => l.startsWith('journey'))).toBe(false);
		expect(lines.some((l) => l.startsWith('computer-history'))).toBe(false);
		expect(lines[lines.length - 1]).toContain('--since 1w');
		expect(timelineFollowUps([])).toHaveLength(1);
	});
});
