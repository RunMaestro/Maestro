/**
 * ActivityLog — Cue run history rendered as a table with newest-first ordering,
 * smart "today vs date" timestamps, header-mounted search, and an expand-all
 * toggle. Used as the body of the Activity Log tab.
 */

import { Fragment, useEffect, useMemo, useState } from 'react';
import {
	AlertTriangle,
	ChevronDown,
	ChevronRight,
	Search,
	X,
	Zap,
	ChevronsDownUp,
	ChevronsUpDown,
} from 'lucide-react';
import type { Theme } from '../../types';
import type { CueRunResult } from '../../hooks/useCue';
import { CUE_COLOR } from '../../../shared/cue-pipeline-types';
import { PipelineDot } from './StatusDot';
import { ActivityLogDetail } from './ActivityLogDetail';
import { cleanStderrForDisplay, formatDuration, getPipelineForSubscription } from './cueModalUtils';

interface ActivityLogProps {
	log: CueRunResult[];
	theme: Theme;
	subscriptionPipelineMap: Map<string, { name: string; color: string }>;
	searchQuery: string;
	setSearchQuery: (q: string) => void;
	searchInputRef: React.RefObject<HTMLInputElement>;
}

function buildHaystack(
	entry: CueRunResult,
	subscriptionPipelineMap: Map<string, { name: string; color: string }>
): string {
	const parts: string[] = [
		entry.subscriptionName,
		entry.sessionName ?? '',
		entry.pipelineName ?? '',
		entry.event.type,
		entry.status,
	];
	const pipeline = subscriptionPipelineMap.get(entry.subscriptionName);
	if (pipeline) parts.push(pipeline.name);
	const p = entry.event.payload as Record<string, unknown> | undefined;
	if (p) {
		if (typeof p.file === 'string') parts.push(p.file);
		if (typeof p.filename === 'string') parts.push(p.filename);
		if (typeof p.title === 'string') parts.push(p.title);
		if (p.number !== undefined && p.number !== null) parts.push(`#${String(p.number)}`);
	}
	// Include the OUTPUT body so users can search by anything the run printed
	// (PR URLs, file paths, error messages). Trim each stream to a sensible
	// upper bound so a runaway log doesn't make the haystack pathological.
	if (entry.stdout) parts.push(entry.stdout.slice(0, 20_000));
	if (entry.stderr) parts.push(entry.stderr.slice(0, 5_000));
	return parts.join(' ').toLowerCase();
}

/**
 * Same-day entries get just `H:MM AM/PM`; older entries get
 * `YYYY-MM-DD H:MM AM/PM`. Seconds are intentionally dropped so the column
 * stays narrow.
 */
function formatActivityTimestamp(iso: string, now: Date): string {
	const date = new Date(iso);
	if (isNaN(date.getTime())) return '—';
	const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
	const sameDay =
		date.getFullYear() === now.getFullYear() &&
		date.getMonth() === now.getMonth() &&
		date.getDate() === now.getDate();
	if (sameDay) return time;
	const y = date.getFullYear();
	const m = String(date.getMonth() + 1).padStart(2, '0');
	const d = String(date.getDate()).padStart(2, '0');
	return `${y}-${m}-${d} ${time}`;
}

export function ActivityLog({
	log,
	theme,
	subscriptionPipelineMap,
	searchQuery,
	setSearchQuery,
	searchInputRef,
}: ActivityLogProps) {
	const [visibleCount, setVisibleCount] = useState(100);
	const [expandedRunIds, setExpandedRunIds] = useState<Set<string>>(new Set());

	// Cmd/Ctrl+F focuses the search box.
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
			if (e.key !== 'f' && e.key !== 'F') return;
			e.preventDefault();
			searchInputRef.current?.focus();
			searchInputRef.current?.select();
		};
		window.addEventListener('keydown', handleKeyDown);
		return () => window.removeEventListener('keydown', handleKeyDown);
	}, [searchInputRef]);

	// Sort newest-first by startedAt; the engine's ring buffer hands us oldest→newest.
	const sorted = useMemo(() => {
		return [...log].sort(
			(a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
		);
	}, [log]);

	const filtered = useMemo(() => {
		const q = searchQuery.trim().toLowerCase();
		if (!q) return sorted;
		return sorted.filter((entry) => buildHaystack(entry, subscriptionPipelineMap).includes(q));
	}, [sorted, searchQuery, subscriptionPipelineMap]);

	const visible = filtered.slice(0, visibleCount);

	// Expand-all toggles only the currently visible rows so it remains
	// predictable when "Load more" hasn't been pressed yet.
	const allVisibleExpanded =
		visible.length > 0 && visible.every((e) => expandedRunIds.has(e.runId));
	const toggleAll = () => {
		setExpandedRunIds((prev) => {
			const next = new Set(prev);
			if (allVisibleExpanded) {
				for (const e of visible) next.delete(e.runId);
			} else {
				for (const e of visible) next.add(e.runId);
			}
			return next;
		});
	};
	const toggleOne = (runId: string) => {
		setExpandedRunIds((prev) => {
			const next = new Set(prev);
			if (next.has(runId)) next.delete(runId);
			else next.add(runId);
			return next;
		});
	};

	const now = new Date();

	return (
		<div className="flex flex-col h-full">
			{/* Header — title left; search + expand-all right */}
			<div className="flex items-center justify-between gap-3 mb-3">
				<h3
					className="text-xs font-bold uppercase tracking-wider"
					style={{ color: theme.colors.textDim }}
				>
					Activity Log
					{log.length > 0 && (
						<span
							className="ml-2 font-normal normal-case tracking-normal"
							style={{ color: theme.colors.textDim, opacity: 0.7 }}
						>
							{filtered.length === log.length
								? `${log.length} entr${log.length === 1 ? 'y' : 'ies'}`
								: `${filtered.length} of ${log.length}`}
						</span>
					)}
				</h3>
				<div className="flex items-center gap-2">
					<div
						className="flex items-center gap-1.5 px-2 py-1 rounded"
						style={{ backgroundColor: theme.colors.bgActivity, minWidth: 220 }}
					>
						<Search className="w-3 h-3 flex-shrink-0" style={{ color: theme.colors.textDim }} />
						<input
							ref={searchInputRef}
							type="text"
							value={searchQuery}
							onChange={(e) => setSearchQuery(e.target.value)}
							placeholder="Search activity..."
							className="flex-1 bg-transparent outline-none text-xs"
							style={{ color: theme.colors.textMain }}
							disabled={log.length === 0}
						/>
						{searchQuery && (
							<button
								onClick={() => setSearchQuery('')}
								className="flex-shrink-0 opacity-60 hover:opacity-100"
								style={{ color: theme.colors.textDim }}
								aria-label="Clear search"
							>
								<X className="w-3 h-3" />
							</button>
						)}
					</div>
					<button
						onClick={toggleAll}
						disabled={visible.length === 0}
						className="flex items-center gap-1 px-2 py-1 rounded text-xs hover:opacity-80 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
						style={{
							backgroundColor: theme.colors.bgActivity,
							color: theme.colors.textDim,
						}}
						title={allVisibleExpanded ? 'Collapse all' : 'Expand all'}
					>
						{allVisibleExpanded ? (
							<ChevronsDownUp className="w-3.5 h-3.5" />
						) : (
							<ChevronsUpDown className="w-3.5 h-3.5" />
						)}
						{allVisibleExpanded ? 'Collapse all' : 'Expand all'}
					</button>
				</div>
			</div>

			{/* Body */}
			<div
				className="flex-1 overflow-y-auto rounded-md"
				style={{ backgroundColor: theme.colors.bgActivity }}
			>
				{log.length === 0 ? (
					<div className="text-sm py-6 px-3" style={{ color: theme.colors.textDim }}>
						No activity yet
					</div>
				) : filtered.length === 0 ? (
					<div className="text-xs py-6 px-3" style={{ color: theme.colors.textDim }}>
						No matches for "{searchQuery}"
					</div>
				) : (
					<table className="w-full text-xs">
						<colgroup>
							<col style={{ width: 24 }} />
							<col style={{ width: 1 }} />
							<col style={{ width: 24 }} />
							<col style={{ width: 1 }} />
							<col />
							<col style={{ width: 1 }} />
						</colgroup>
						<tbody>
							{visible.map((entry) => {
								const isFailed = entry.status === 'failed' || entry.status === 'timeout';
								const eventType = entry.event.type;
								const filePayload =
									eventType === 'file.changed' && entry.event.payload?.file
										? ` (${String(entry.event.payload.file).split('/').pop()})`
										: '';
								const taskPayload =
									eventType === 'task.pending' && entry.event.payload?.filename
										? ` (${String(entry.event.payload.filename)}: ${String(entry.event.payload.taskCount ?? 0)} task(s))`
										: '';
								const githubPayload =
									(eventType === 'github.pull_request' || eventType === 'github.issue') &&
									entry.event.payload?.number
										? ` (#${String(entry.event.payload.number)} ${String(entry.event.payload.title ?? '')})`
										: '';
								const isReconciled = entry.event.payload?.reconciled === true;
								const isExpanded = expandedRunIds.has(entry.runId);
								const hasStderr =
									entry.stderr.length > 0 && cleanStderrForDisplay(entry.stderr).trim().length > 0;
								const pInfo = getPipelineForSubscription(
									entry.subscriptionName,
									subscriptionPipelineMap
								);

								return (
									<Fragment key={entry.runId}>
										<tr
											onClick={() => toggleOne(entry.runId)}
											className="cursor-pointer hover:bg-white/5 transition-colors align-baseline"
										>
											<td className="py-1.5 pl-2 pr-1 align-middle">
												{isExpanded ? (
													<ChevronDown
														className="w-3 h-3"
														style={{ color: theme.colors.textDim }}
													/>
												) : (
													<ChevronRight
														className="w-3 h-3"
														style={{ color: theme.colors.textDim }}
													/>
												)}
											</td>
											<td
												className="py-1.5 pr-2 font-mono whitespace-nowrap"
												style={{ color: theme.colors.textDim }}
											>
												{formatActivityTimestamp(entry.startedAt, now)}
											</td>
											<td className="py-1.5 pr-2 align-middle">
												{pInfo ? (
													<PipelineDot color={pInfo.color} name={pInfo.name} />
												) : (
													<Zap className="w-3 h-3" style={{ color: CUE_COLOR }} />
												)}
											</td>
											<td
												className="py-1.5 pr-2 whitespace-nowrap"
												style={{ color: theme.colors.textMain }}
											>
												"{entry.subscriptionName}"
												{isReconciled && (
													<span
														className="inline-block ml-1.5 px-1.5 py-0.5 rounded text-[10px] font-bold"
														style={{
															backgroundColor: `${theme.colors.warning}20`,
															color: theme.colors.warning,
														}}
													>
														catch-up
													</span>
												)}
											</td>
											<td className="py-1.5 pr-2 truncate" style={{ color: theme.colors.textDim }}>
												triggered ({eventType}){filePayload}
												{taskPayload}
												{githubPayload}
											</td>
											<td className="py-1.5 pr-2 whitespace-nowrap text-right">
												<span className="inline-flex items-center gap-1.5 justify-end">
													{hasStderr && !isFailed && (
														<span title="Run produced error output" className="inline-flex">
															<AlertTriangle
																className="w-3 h-3"
																style={{ color: theme.colors.warning }}
																aria-label="Run produced error output"
															/>
														</span>
													)}
													{isFailed ? (
														<span style={{ color: theme.colors.error }}>{entry.status} ✗</span>
													) : entry.status === 'stopped' ? (
														<span style={{ color: theme.colors.warning }}>stopped</span>
													) : (
														<span style={{ color: theme.colors.success }}>
															completed in {formatDuration(entry.durationMs)} ✓
														</span>
													)}
												</span>
											</td>
										</tr>
										{isExpanded && (
											<tr>
												<td colSpan={6} className="px-2 pb-2">
													<ActivityLogDetail entry={entry} theme={theme} />
												</td>
											</tr>
										)}
									</Fragment>
								);
							})}
						</tbody>
					</table>
				)}
				{filtered.length > visibleCount && (
					<button
						onClick={() => setVisibleCount((c) => c + 100)}
						className="text-xs py-2 w-full text-center hover:opacity-80 transition-opacity"
						style={{ color: CUE_COLOR }}
					>
						Load more ({filtered.length - visibleCount} remaining)
					</button>
				)}
			</div>
		</div>
	);
}
