import { Activity } from 'lucide-react';
import type { AgentRunEvent } from '../../../shared/agent-run';
import type { Theme } from '../../types';
import { formatTime, statusTone } from './dashboardHelpers';
import { Pill } from './dashboardPrimitives';

export function EventTimeline({
	theme,
	events,
	onRefresh,
}: {
	theme: Theme;
	events: AgentRunEvent[];
	onRefresh: () => void;
}) {
	return (
		<section className="rounded-xl border" style={{ borderColor: theme.colors.border }}>
			<div
				className="flex items-center justify-between border-b px-3 py-2"
				style={{ borderColor: theme.colors.border }}
			>
				<div className="flex items-center gap-2 text-sm font-semibold">
					<Activity className="h-4 w-4" />
					Event timeline
				</div>
				<button
					type="button"
					onClick={onRefresh}
					className="text-xs"
					style={{ color: theme.colors.accent }}
				>
					Reload events
				</button>
			</div>
			{events.length === 0 ? (
				<div className="px-3 py-6 text-sm" style={{ color: theme.colors.textDim }}>
					No events recorded yet.
				</div>
			) : (
				<div className="space-y-3 p-3">
					{events.map((event) => (
						<div
							key={event.id}
							className="border-l-2 pl-3"
							style={{ borderColor: statusTone(event.status ?? event.type, theme) }}
						>
							<div className="flex flex-wrap items-center gap-2 text-xs">
								<span className="font-semibold" style={{ color: theme.colors.textMain }}>
									{event.type}
								</span>
								{event.status && (
									<Pill theme={theme} tone={statusTone(event.status, theme)}>
										{event.status}
									</Pill>
								)}
								<span style={{ color: theme.colors.textDim }}>{formatTime(event.timestamp)}</span>
							</div>
							{event.message && <div className="mt-1 text-sm">{event.message}</div>}
							{(event.data || event.metadata) && (
								<pre
									className="mt-2 max-h-28 overflow-auto rounded p-2 text-[11px]"
									style={{ backgroundColor: theme.colors.bgSidebar, color: theme.colors.textDim }}
								>
									{JSON.stringify({ data: event.data, metadata: event.metadata }, null, 2)}
								</pre>
							)}
						</div>
					))}
				</div>
			)}
		</section>
	);
}
