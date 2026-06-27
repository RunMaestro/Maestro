/**
 * Per-plugin observability (read-only) for the Plugins settings panel.
 *
 * Renders a compact card per running tier-1 (sandboxed code) plugin: total host
 * calls, current/peak in-flight, crash count, last-activity time, and the most
 * recent sandbox log lines. Data comes from window.maestro.plugins.getActivity(),
 * which the main process gates on the `plugins` Encore flag and feeds from the
 * sandbox host. It polls on a light interval while mounted so the view stays
 * live; only running tier-1 plugins ever appear in the snapshot.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { Activity as ActivityIcon, Bug, Clock } from 'lucide-react';
import type { Theme } from '../../types';
import type { PluginRecord } from '../../../shared/plugins/plugin-registry';
import type { PluginActivityMap } from '../../../main/ipc/handlers/plugins';

interface PluginActivityViewProps {
	theme: Theme;
	records: PluginRecord[];
	/** Re-fetch cadence in ms. */
	pollMs?: number;
}

function levelColor(theme: Theme, level: string): string {
	const l = level.toLowerCase();
	if (l === 'error') return theme.colors.error;
	if (l === 'warn' || l === 'warning') return theme.colors.warning;
	return theme.colors.textDim;
}

/** Coarse "time ago" label; OS- and locale-agnostic. */
function relativeTime(at: number, now: number): string {
	const diff = Math.max(0, now - at);
	if (diff < 5_000) return 'just now';
	const s = Math.floor(diff / 1000);
	if (s < 60) return `${s}s ago`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ago`;
	return `${Math.floor(h / 24)}d ago`;
}

export function PluginActivityView({ theme, records, pollMs = 4000 }: PluginActivityViewProps) {
	const [activity, setActivity] = useState<PluginActivityMap>({});
	const [now, setNow] = useState(() => Date.now());
	const mounted = useRef(true);

	const refresh = useCallback(async () => {
		try {
			const map = await window.maestro.plugins.getActivity();
			if (!mounted.current) return;
			setActivity(map);
			setNow(Date.now());
		} catch {
			// Feature gated off or a transient IPC error: surface nothing.
			if (mounted.current) setActivity({});
		}
	}, []);

	useEffect(() => {
		mounted.current = true;
		void refresh();
		const id = setInterval(() => void refresh(), pollMs);
		return () => {
			mounted.current = false;
			clearInterval(id);
		};
	}, [refresh, pollMs]);

	const nameFor = useCallback(
		(id: string): string => records.find((r) => r.id === id)?.manifest?.name ?? id,
		[records]
	);

	const ids = Object.keys(activity).sort(
		(a, b) => (activity[b]?.lastActivity ?? 0) - (activity[a]?.lastActivity ?? 0)
	);
	if (ids.length === 0) return null;

	return (
		<div className="mt-4">
			<div
				className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide mb-2"
				style={{ color: theme.colors.textDim }}
			>
				<ActivityIcon className="w-3.5 h-3.5" />
				Live activity
			</div>
			<div className="flex flex-col gap-2">
				{ids.map((id) => {
					const a = activity[id];
					if (!a) return null;
					return (
						<div
							key={id}
							className="rounded-lg border p-3"
							style={{ borderColor: theme.colors.border }}
						>
							<div className="flex items-center justify-between gap-3">
								<div
									className="text-sm font-semibold truncate"
									style={{ color: theme.colors.textMain }}
								>
									{nameFor(id)}
								</div>
								<div className="flex items-center gap-3 shrink-0 text-[11px]">
									<span style={{ color: theme.colors.textDim }} title="Total host calls">
										{a.totalCalls} call{a.totalCalls === 1 ? '' : 's'}
									</span>
									<span
										className="inline-flex items-center gap-1"
										style={{ color: theme.colors.textDim }}
										title="Last activity"
									>
										<Clock className="w-3 h-3" />
										{relativeTime(a.lastActivity, now)}
									</span>
									<span
										className="inline-flex items-center gap-1"
										style={{
											color: a.crashCount > 0 ? theme.colors.error : theme.colors.textDim,
										}}
										title="Crash count"
									>
										<Bug className="w-3 h-3" />
										{a.crashCount}
									</span>
								</div>
							</div>

							{(a.inFlight > 0 || a.peakInFlight > 0) && (
								<div className="text-[11px] mt-1" style={{ color: theme.colors.textDim }}>
									In-flight {a.inFlight} (peak {a.peakInFlight})
								</div>
							)}

							{a.recentLogs.length > 0 && (
								<div
									className="mt-2 pt-2 flex flex-col gap-0.5 max-h-32 overflow-auto font-mono text-[10px]"
									style={{ borderTop: `1px solid ${theme.colors.border}` }}
								>
									{a.recentLogs.slice(-8).map((line, i) => (
										<div key={`${i}-${line.at}`} className="flex gap-1.5 leading-snug">
											<span
												className="uppercase shrink-0"
												style={{ color: levelColor(theme, line.level) }}
											>
												{line.level}
											</span>
											<span className="truncate" style={{ color: theme.colors.textDim }}>
												{line.message}
											</span>
										</div>
									))}
								</div>
							)}
						</div>
					);
				})}
			</div>
		</div>
	);
}
