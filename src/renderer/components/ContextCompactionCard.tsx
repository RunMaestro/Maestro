/**
 * ContextCompactionCard - the transcript pill where Maestro compacted this
 * conversation on its own.
 *
 * A turn refused because the conversation no longer fits the model's context
 * window is recovered without the user: the provider session is compacted and
 * the same prompt resent. The failure itself is shown nowhere, so this pill is
 * the whole record that it happened, in the spot where the conversation was cut
 * down.
 *
 * Driven by `LogEntry.contextCompaction`, written by
 * `services/contextCompaction.ts`: it starts `pending` (spinner) and is settled
 * when the compaction ends.
 */

import type React from 'react';
import { Minimize2 } from 'lucide-react';
import { Spinner } from './ui/Spinner';
import type { LogEntry, Theme } from '../types';
import { useIsContextCompactionLive } from '../stores/retryStore';

type CompactionRecord = NonNullable<LogEntry['contextCompaction']>;

export interface ContextCompactionCardProps {
	log: LogEntry;
	theme: Theme;
}

/**
 * The label and its one-line explanation, by outcome.
 *
 * `live` is whether a recovery is still driving a `pending` pill. A pill left
 * pending by an app quit has nothing behind it, and must not spin forever.
 */
export function describeContextCompaction(
	status: CompactionRecord['status'],
	live: boolean
): { label: string; detail: string; state: 'working' | 'done' | 'stopped' | 'failed' } {
	if (status === 'pending' && live) {
		return {
			label: 'Compacting context',
			detail: "The conversation reached the model's limit. Your message is sent again next.",
			state: 'working',
		};
	}
	if (status === 'done') {
		return {
			label: 'Context compacted',
			detail: "The conversation reached the model's limit. Your message was sent again.",
			state: 'done',
		};
	}
	if (status === 'error') {
		return {
			label: 'Context compaction failed',
			detail: 'The conversation could not be compacted.',
			state: 'failed',
		};
	}
	return {
		label: 'Context compaction stopped',
		// Deliberately silent on the message: after an app quit the queue still
		// holds it and sends it, so "not sent again" would be wrong there.
		detail: 'The compaction did not finish.',
		state: 'stopped',
	};
}

export function ContextCompactionCard({
	log,
	theme,
}: ContextCompactionCardProps): React.ReactElement | null {
	const live = useIsContextCompactionLive(log.id);
	const compaction = log.contextCompaction;
	if (!compaction) return null;

	const { label, detail, state } = describeContextCompaction(compaction.status, live);
	const accent = state === 'failed' ? theme.colors.error : theme.colors.accent;

	return (
		<div
			className="inline-flex max-w-full items-center gap-2 px-2.5 py-1 rounded-full border text-xs select-none"
			style={{
				backgroundColor: `color-mix(in srgb, ${accent} 10%, transparent)`,
				borderColor: `color-mix(in srgb, ${accent} 35%, ${theme.colors.border})`,
			}}
			title={state === 'failed' ? compaction.error : undefined}
			data-testid="context-compaction-card"
			data-state={state}
		>
			{state === 'working' ? (
				<Spinner size={14} color={accent} decorative />
			) : (
				<Minimize2 className="w-3.5 h-3.5 shrink-0" style={{ color: accent }} aria-hidden />
			)}

			<span className="shrink-0 font-semibold" style={{ color: accent }}>
				{label}
			</span>

			<span className="min-w-0 truncate" style={{ color: theme.colors.textDim }} title={detail}>
				{detail}
			</span>
		</div>
	);
}

export default ContextCompactionCard;
