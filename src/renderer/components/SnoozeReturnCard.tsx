/**
 * SnoozeReturnCard - the transcript marker where a snoozed tab came back.
 *
 * A snoozed tab can be away for months, and when it returns the conversation
 * would otherwise resume mid-thought with no sign of the gap. This card is the
 * seam: it says how long the tab was away, when it was due, and - most
 * importantly - repeats the note-to-self the user left when they snoozed it.
 *
 * That note is the whole reason the tab came back. It's shown once in a toast
 * at wake time, which auto-dismisses; keeping it here means the reminder lives
 * with the conversation it belongs to, and is still there weeks later.
 *
 * Driven entirely by the anchoring `LogEntry.snoozeReturn` record, which is
 * written once and never updated, so the card is stable across restarts.
 */

import React, { useMemo } from 'react';
import { BellRing, RotateCcw, StickyNote } from 'lucide-react';

import type { LogEntry, Theme } from '../types';
import { formatSnoozeTarget } from '../../shared/snooze';
import { formatDurationWords } from '../../shared/formatters';

interface SnoozeReturnCardProps {
	log: LogEntry;
	theme: Theme;
}

export function SnoozeReturnCard({ log, theme }: SnoozeReturnCardProps): React.ReactElement | null {
	const snooze = log.snoozeReturn;

	// How long the tab was actually away, measured to the moment it came back
	// rather than to its due time - "brought back early" is a real outcome and
	// the elapsed gap should reflect what happened, not what was scheduled.
	// Worded rather than a seconds count: a tab can sleep for months, and
	// "130127.72s" tells nobody anything.
	const awayFor = useMemo(() => {
		if (!snooze) return null;
		const elapsed = log.timestamp - snooze.snoozedAt;
		return elapsed >= 1000 ? formatDurationWords(elapsed) : null;
	}, [log.timestamp, snooze]);

	if (!snooze) return null;

	const early = snooze.resolution === 'unsnoozed';
	const Icon = early ? RotateCcw : BellRing;
	const headline = early ? 'Brought back early' : 'Back from snooze';

	return (
		<div
			className="flex flex-col gap-2 px-3.5 py-3 rounded-lg border text-sm select-none"
			style={{
				borderColor: `${theme.colors.accent}55`,
				backgroundColor: `${theme.colors.accent}10`,
			}}
		>
			<div className="flex items-center gap-2 flex-wrap">
				<Icon className="w-4 h-4 shrink-0" style={{ color: theme.colors.accent }} />
				<span className="font-medium" style={{ color: theme.colors.textMain }}>
					{headline}
				</span>
				{awayFor && (
					<span className="text-xs" style={{ color: theme.colors.textDim }}>
						after {awayFor}
					</span>
				)}
				<span className="text-xs" style={{ color: theme.colors.textDim }}>
					· was due {formatSnoozeTarget(snooze.wakeAt, log.timestamp)}
				</span>
			</div>

			{snooze.note && (
				<div
					className="flex items-start gap-2 text-sm select-text"
					style={{ color: theme.colors.textMain }}
				>
					<StickyNote
						className="w-3.5 h-3.5 shrink-0 mt-0.5"
						style={{ color: theme.colors.textDim }}
					/>
					<span className="italic whitespace-pre-wrap break-words">{snooze.note}</span>
				</div>
			)}
		</div>
	);
}
