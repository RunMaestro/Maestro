/**
 * AutoRunScheduledBanner.tsx
 *
 * Shown in the Auto Run panel while this agent has a run parked for a future
 * date/time (see scheduledAutoRunStore). Without it a schedule is invisible
 * once the modal closes, and the user has no way to cancel it.
 */

import { memo } from 'react';
import { CalendarClock, X } from 'lucide-react';
import type { Theme } from '../../types';
import {
	useScheduledAutoRunStore,
	selectScheduledAutoRun,
} from '../../stores/scheduledAutoRunStore';
import { formatFutureTime } from '../../../shared/formatters';

interface AutoRunScheduledBannerProps {
	theme: Theme;
	sessionId: string;
}

export const AutoRunScheduledBanner = memo(function AutoRunScheduledBanner({
	theme,
	sessionId,
}: AutoRunScheduledBannerProps) {
	const scheduled = useScheduledAutoRunStore(selectScheduledAutoRun(sessionId));
	const cancel = useScheduledAutoRunStore((s) => s.cancel);

	if (!scheduled) return null;

	const documentCount = scheduled.config.documents.length;
	const summary = scheduled.config.goalConfig
		? 'Goal-Driven run'
		: `${documentCount} document${documentCount === 1 ? '' : 's'}`;

	return (
		<div
			className="mx-2 mb-2 px-2.5 py-2 rounded border flex items-center gap-2"
			style={{
				borderColor: theme.colors.accent + '40',
				backgroundColor: theme.colors.accent + '15',
			}}
		>
			<CalendarClock className="w-3.5 h-3.5 shrink-0" style={{ color: theme.colors.accent }} />
			<div className="flex-1 min-w-0">
				<div className="text-xs font-medium truncate" style={{ color: theme.colors.textMain }}>
					Auto Run scheduled {formatFutureTime(scheduled.scheduledFor)}
				</div>
				<div className="text-[10px] truncate" style={{ color: theme.colors.textDim }}>
					{summary} - {new Date(scheduled.scheduledFor).toLocaleString()}
				</div>
			</div>
			<button
				onClick={() => cancel(sessionId)}
				className="p-1 rounded hover:bg-white/10 transition-colors shrink-0"
				style={{ color: theme.colors.textDim }}
				title="Cancel the scheduled Auto Run"
				aria-label="Cancel scheduled Auto Run"
			>
				<X className="w-3.5 h-3.5" />
			</button>
		</div>
	);
});
