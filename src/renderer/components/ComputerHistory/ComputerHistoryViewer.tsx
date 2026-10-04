/**
 * Computer History viewer - the place to see and explore what was recorded.
 *
 * Three tabs over one range:
 *   Timeline  activity strip (stacked by app) + app list + visit stream
 *   Digests   agent-written 15-minute digests and 6-hour roll-ups
 *   Capture   which apps are recorded (exclude / include mode) and domains
 *
 * Reads go through `window.maestro.computerHistory` to the ONE main-process
 * service (the same reader the CLI uses from disk), so what this shows is
 * exactly what `maestro-cli computer-history query` returns. Desktop only:
 * the web bridge refuses every computerHistory channel, and the entry points
 * are gated by `canOpenComputerHistory`.
 *
 * Reachable by hotkey (Ctrl+Cmd+H), the command palette, the hamburger menu,
 * and `maestro-cli open computer-history`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
	AlertTriangle,
	ListFilter,
	Pause,
	Play,
	RotateCw,
	ScanEye,
	Settings2,
	X,
} from 'lucide-react';
import type { Theme } from '../../types';
import { Modal } from '../ui/Modal';
import { EscCloseButton } from '../ui/EscCloseButton';
import { GhostIconButton } from '../ui/GhostIconButton';
import { SegmentedControl } from '../ui/SegmentedControl';
import { FilterInput } from '../ui/FilterInput';
import { Spinner } from '../ui/Spinner';
import { EmptyStatePlaceholder } from '../ui/EmptyStatePlaceholder';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { useComputerHistoryStatus } from '../../hooks/computerHistory/useComputerHistoryStatus';
import { usePersistedChoice } from '../../hooks/ui/usePersistedChoice';
import { useDebouncedValue } from '../../hooks/utils/useThrottle';
import { useElementWidth } from '../../hooks/ui/useElementWidth';
import { getModalActions } from '../../stores/modalStore';
import { notifyToast } from '../../stores/notificationStore';
import { generateParticipantColor } from '../../utils/participantColors';
import { viewportModalSize } from '../../utils/modalSizing';
import { formatDurationCompact } from '../../../shared/duration';
import type { ActivitySummary } from '../../../shared/computer-history/reader';
import type { RecorderState } from '../../../shared/computer-history/status';
import type { StoredEvent } from '../../../shared/computer-history/types';
import { ActivityStrip } from './ActivityStrip';
import { CaptureRulesEditor } from './CaptureRulesEditor';
import { DigestsPanel } from './DigestsPanel';
import { VisitCard } from './VisitCard';
import {
	KIND_FILTERS,
	RANGE_OPTIONS,
	clockLabel,
	dayLabel,
	eventKey,
	groupIntoVisits,
	kindsForFilters,
	localDayKey,
	rangeStartMs,
	type KindFilterId,
	type RangeId,
	type Visit,
} from './timelineModel';

export const COMPUTER_HISTORY_RESIZE_KEY = 'computer-history-viewer';

type TabId = 'timeline' | 'digests' | 'capture';

const TAB_OPTIONS = [
	{ value: 'timeline' as const, label: 'Timeline' },
	{ value: 'digests' as const, label: 'Digests' },
	{ value: 'capture' as const, label: 'Capture' },
];
const TAB_IDS: readonly TabId[] = TAB_OPTIONS.map((t) => t.value);
const RANGE_IDS: readonly RangeId[] = RANGE_OPTIONS.map((r) => r.value);

/** Events per page; "Load older" fetches the next page before the oldest shown. */
const PAGE_SIZE = 400;
/** Apps beyond this rank share the "other" color in the strip. */
const COLORED_APPS = 10;
/** Below this content width the app sidebar folds away. */
const SIDEBAR_MIN_WIDTH = 820;

const STATE_LABELS: Record<RecorderState, string> = {
	off: 'Off',
	recording: 'Recording',
	paused: 'Paused',
	blocked: 'Waiting for permission',
	starting: 'Starting',
	'binary-missing': 'Recorder not installed',
	restarting: 'Restarting',
	failed: 'Recorder stopped',
};

interface ComputerHistoryViewerProps {
	theme: Theme;
	onClose: () => void;
}

interface EventPage {
	events: StoredEvent[];
	/** Older matches may exist before the oldest loaded event. */
	more: boolean;
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export function ComputerHistoryViewer({ theme, onClose }: ComputerHistoryViewerProps) {
	const api = window.maestro?.computerHistory;
	const { status } = useComputerHistoryStatus();
	const { value: tab, setValue: setTab } = usePersistedChoice<TabId>(
		'computerHistory.viewer.tab',
		TAB_IDS,
		'timeline'
	);
	const { value: range, setValue: setRange } = usePersistedChoice<RangeId>(
		'computerHistory.viewer.range',
		RANGE_IDS,
		'today'
	);
	const [nowMs, setNowMs] = useState(() => Date.now());
	const [refreshToken, setRefreshToken] = useState(0);
	const [focus, setFocus] = useState<{ startMs: number; endMs: number } | null>(null);
	const [selectedApps, setSelectedApps] = useState<ReadonlySet<string>>(new Set());
	const [kindFilters, setKindFilters] = useState<ReadonlySet<KindFilterId>>(
		() => new Set(KIND_FILTERS.map((f) => f.id))
	);
	const [query, setQuery] = useState('');
	const debouncedQuery = useDebouncedValue(query.trim(), 250);
	const [activity, setActivity] = useState<ActivitySummary | null>(null);
	const [page, setPage] = useState<EventPage | null>(null);
	const [loadingMore, setLoadingMore] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const bodyRef = useRef<HTMLDivElement>(null);
	const bodyWidth = useElementWidth(bodyRef);
	const showSidebar = bodyWidth === 0 || bodyWidth >= SIDEBAR_MIN_WIDTH;
	const defaultSize = useMemo(() => viewportModalSize({ width: 0.9, height: 0.88 }), []);

	const sinceMs = rangeStartMs(range, nowMs);
	const windowSince = focus?.startMs ?? sinceMs;
	const windowUntil = focus?.endMs ?? nowMs;
	const kinds = useMemo(() => kindsForFilters(kindFilters), [kindFilters]);
	const appsFilter = useMemo(() => [...selectedApps], [selectedApps]);

	const refresh = useCallback(() => {
		setNowMs(Date.now());
		setRefreshToken((n) => n + 1);
	}, []);

	// Changing the range drops a focused bar that may be outside it.
	const changeRange = useCallback(
		(next: RangeId) => {
			setFocus(null);
			setRange(next);
			setNowMs(Date.now());
		},
		[setRange]
	);

	// Activity (strip + app list) follows the range, not the filters.
	useEffect(() => {
		if (!api) return;
		let cancelled = false;
		api
			.activity({ sinceMs, untilMs: nowMs })
			.then((next) => {
				if (!cancelled) setActivity(next);
			})
			.catch((err) => {
				if (!cancelled) setError(errorText(err));
			});
		return () => {
			cancelled = true;
		};
	}, [api, sinceMs, nowMs, refreshToken]);

	// First page of events for the current filters.
	useEffect(() => {
		if (!api || tab !== 'timeline') return;
		let cancelled = false;
		setPage(null);
		setError(null);
		api
			.query({
				sinceMs: windowSince,
				untilMs: windowUntil,
				apps: appsFilter.length > 0 ? appsFilter : undefined,
				kinds,
				grep: debouncedQuery || undefined,
				limit: PAGE_SIZE,
			})
			.then((result) => {
				if (!cancelled) setPage({ events: result.events, more: result.limited });
			})
			.catch((err) => {
				if (!cancelled) setError(errorText(err));
			});
		return () => {
			cancelled = true;
		};
	}, [api, tab, windowSince, windowUntil, appsFilter, kinds, debouncedQuery, refreshToken]);

	const loadOlder = useCallback(async () => {
		if (!api || !page || page.events.length === 0) return;
		setLoadingMore(true);
		try {
			const oldestMs = Date.parse(page.events[0].ts);
			const result = await api.query({
				sinceMs: windowSince,
				// Inclusive bound, deduped below, so events sharing the oldest
				// millisecond are not skipped at the page boundary.
				untilMs: oldestMs,
				apps: appsFilter.length > 0 ? appsFilter : undefined,
				kinds,
				grep: debouncedQuery || undefined,
				limit: PAGE_SIZE,
			});
			setPage((prev) => {
				if (!prev) return prev;
				const seen = new Set(prev.events.map(eventKey));
				const older = result.events.filter((e) => !seen.has(eventKey(e)));
				return { events: [...older, ...prev.events], more: result.limited && older.length > 0 };
			});
		} catch (err) {
			notifyToast({ color: 'red', title: 'Computer History', message: errorText(err) });
		} finally {
			setLoadingMore(false);
		}
	}, [api, page, windowSince, appsFilter, kinds, debouncedQuery]);

	// App colors by rank in the range, so the strip, list, and cards agree.
	const { appColors, appNames } = useMemo(() => {
		const colors = new Map<string, string>();
		const names = new Map<string, string>();
		(activity?.apps ?? []).forEach((app, i) => {
			names.set(app.id, app.name);
			if (i < COLORED_APPS) colors.set(app.id, generateParticipantColor(i, theme));
		});
		return { appColors: colors, appNames: names };
	}, [activity, theme]);

	const visits = useMemo(() => groupIntoVisits(page?.events ?? []), [page]);

	const toggleApp = (id: string) =>
		setSelectedApps((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});

	const toggleKind = (id: KindFilterId) =>
		setKindFilters((prev) => {
			const next = new Set(prev);
			if (next.has(id)) {
				// Never filter down to nothing: the last chip stays on.
				if (next.size > 1) next.delete(id);
			} else next.add(id);
			return next;
		});

	// Escape clears the search first, then closes (same path as the ESC pill).
	const handleClose = useCallback(() => {
		if (query) {
			setQuery('');
			return;
		}
		onClose();
	}, [query, onClose]);

	const openSettings = useCallback(() => {
		onClose();
		getModalActions().openSettings('encore', 'encore-computer-history');
	}, [onClose]);

	const togglePause = useCallback(async () => {
		if (!api) return;
		try {
			if (status?.state === 'paused') await api.resume();
			else await api.pause(null);
		} catch (err) {
			notifyToast({ color: 'red', title: 'Computer History', message: errorText(err) });
		}
	}, [api, status?.state]);

	const state = status?.state ?? 'off';
	const stateColor =
		state === 'recording'
			? theme.colors.success
			: state === 'paused' || state === 'starting' || state === 'restarting'
				? theme.colors.warning
				: theme.colors.error;
	const recorderProblem =
		state === 'blocked' || state === 'binary-missing' || state === 'failed' || state === 'off';

	const headerActions = (
		<>
			<span
				className="flex items-center gap-1.5 text-xs px-2 py-1 rounded-full"
				style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}
				data-testid="computer-history-state"
			>
				<span
					className={`w-2 h-2 rounded-full ${state === 'recording' ? 'animate-pulse' : ''}`}
					style={{ backgroundColor: stateColor }}
				/>
				{STATE_LABELS[state]}
			</span>
			{(state === 'recording' || state === 'paused') && (
				<GhostIconButton
					onClick={() => void togglePause()}
					ariaLabel={state === 'paused' ? 'Resume recording' : 'Pause recording'}
					title={state === 'paused' ? 'Resume recording' : 'Pause recording until resumed'}
					color={theme.colors.textDim}
					testId="computer-history-pause"
				>
					{state === 'paused' ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />}
				</GhostIconButton>
			)}
			<GhostIconButton
				onClick={refresh}
				ariaLabel="Refresh"
				title="Refresh"
				color={theme.colors.textDim}
				testId="computer-history-refresh"
			>
				<RotateCw className="w-4 h-4" />
			</GhostIconButton>
			<GhostIconButton
				onClick={openSettings}
				ariaLabel="Computer History settings"
				title="Retention, permission, and digest settings"
				color={theme.colors.textDim}
			>
				<Settings2 className="w-4 h-4" />
			</GhostIconButton>
			<EscCloseButton theme={theme} onClose={handleClose} testId="computer-history-esc" />
		</>
	);

	const totalActiveMs = (activity?.apps ?? []).reduce((sum, a) => sum + a.activeMs, 0);

	return (
		<Modal
			theme={theme}
			title="Computer History"
			priority={MODAL_PRIORITIES.COMPUTER_HISTORY}
			onClose={handleClose}
			headerIcon={<ScanEye className="w-4 h-4" style={{ color: theme.colors.accent }} />}
			showCloseButton={false}
			headerActions={headerActions}
			resizeKey={COMPUTER_HISTORY_RESIZE_KEY}
			defaultSize={defaultSize}
			minSize={{ width: 560, height: 420 }}
			contentClassName="flex-1 min-h-0 flex flex-col overflow-hidden"
			testId="computer-history-viewer"
			portal
		>
			{!api ? (
				<EmptyStatePlaceholder
					theme={theme}
					title="Desktop only"
					description="Computer History can only be viewed in the Maestro desktop app."
				/>
			) : (
				<>
					{/* Toolbar */}
					<div
						className="flex flex-wrap items-center gap-2 px-4 py-2 border-b select-none"
						style={{ borderColor: theme.colors.border }}
					>
						<SegmentedControl
							theme={theme}
							value={tab}
							onChange={setTab}
							options={TAB_OPTIONS}
							ariaLabel="Computer History view"
							testId="computer-history-tabs"
						/>
						<div className="flex-1" />
						{tab !== 'capture' && (
							<SegmentedControl
								theme={theme}
								value={range}
								onChange={changeRange}
								options={RANGE_OPTIONS}
								ariaLabel="Time range"
								testId="computer-history-range"
							/>
						)}
						{tab === 'timeline' && (
							<FilterInput
								theme={theme}
								value={query}
								onChange={setQuery}
								placeholder="Search text, titles, URLs"
								title="Case-insensitive; regular expressions work too"
								width={240}
							/>
						)}
					</div>

					{recorderProblem && tab !== 'capture' && (
						<div
							className="flex items-center gap-2 px-4 py-1.5 text-xs border-b select-none"
							style={{ borderColor: theme.colors.border, color: theme.colors.warning }}
						>
							<AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
							<span className="flex-1">
								{state === 'off'
									? 'The recorder is not running. Showing what was recorded before.'
									: `${STATE_LABELS[state]}. Nothing new is being recorded.`}
							</span>
							<button type="button" className="underline" onClick={openSettings}>
								Open settings
							</button>
						</div>
					)}

					<div ref={bodyRef} className="flex-1 min-h-0 flex">
						{tab === 'timeline' && (
							<>
								{showSidebar && (
									<aside
										className="w-60 flex-shrink-0 border-r overflow-y-auto py-3 select-none"
										style={{ borderColor: theme.colors.border }}
										data-testid="computer-history-apps"
									>
										<div
											className="px-4 pb-2 text-xs font-semibold uppercase tracking-wide"
											style={{ color: theme.colors.textDim }}
										>
											Apps
										</div>
										<button
											type="button"
											onClick={() => setSelectedApps(new Set())}
											className="w-full flex items-center justify-between px-4 py-1.5 text-sm text-left hover:bg-white/5"
											style={{
												color: theme.colors.textMain,
												backgroundColor:
													selectedApps.size === 0 ? theme.colors.bgActivity : undefined,
											}}
											aria-pressed={selectedApps.size === 0}
										>
											<span>All apps</span>
											<span className="text-xs" style={{ color: theme.colors.textDim }}>
												{totalActiveMs > 0
													? formatDurationCompact(totalActiveMs)
													: (activity?.totalEvents ?? 0)}
											</span>
										</button>
										{(activity?.apps ?? []).map((app) => {
											const active = selectedApps.has(app.id);
											const share =
												totalActiveMs > 0
													? app.activeMs / totalActiveMs
													: activity && activity.totalEvents > 0
														? app.events / activity.totalEvents
														: 0;
											return (
												<button
													key={app.id}
													type="button"
													onClick={() => toggleApp(app.id)}
													className="w-full px-4 py-1.5 text-left hover:bg-white/5"
													style={{
														backgroundColor: active ? theme.colors.bgActivity : undefined,
													}}
													aria-pressed={active}
													title={app.id}
												>
													<div className="flex items-center gap-2 text-sm">
														<span
															className="w-2 h-2 rounded-full flex-shrink-0"
															style={{
																backgroundColor: appColors.get(app.id) ?? theme.colors.textDim,
															}}
														/>
														<span
															className="truncate flex-1"
															style={{
																color: active ? theme.colors.accent : theme.colors.textMain,
															}}
														>
															{app.name}
														</span>
														<span
															className="text-xs tabular-nums"
															style={{ color: theme.colors.textDim }}
														>
															{app.activeMs > 0 ? formatDurationCompact(app.activeMs) : app.events}
														</span>
													</div>
													<div
														className="mt-1 ml-4 h-1 rounded-full overflow-hidden"
														style={{ backgroundColor: theme.colors.bgActivity }}
													>
														<div
															className="h-full rounded-full"
															style={{
																width: `${Math.max(2, share * 100)}%`,
																backgroundColor: appColors.get(app.id) ?? theme.colors.textDim,
															}}
														/>
													</div>
												</button>
											);
										})}
										{activity && activity.apps.length === 0 && (
											<p className="px-4 text-xs" style={{ color: theme.colors.textDim }}>
												No apps in this range.
											</p>
										)}
									</aside>
								)}
								<section className="flex-1 min-w-0 flex flex-col">
									<div
										className="px-4 pt-3 pb-2 border-b"
										style={{ borderColor: theme.colors.border }}
									>
										{activity ? (
											<ActivityStrip
												theme={theme}
												buckets={activity.buckets}
												sinceMs={sinceMs}
												untilMs={nowMs}
												appColors={appColors}
												appNames={appNames}
												focus={focus}
												onFocus={setFocus}
											/>
										) : (
											<div className="h-20" />
										)}
										<div className="flex flex-wrap items-center gap-1.5 mt-1 select-none">
											<ListFilter className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
											{KIND_FILTERS.map((f) => {
												const on = kindFilters.has(f.id);
												return (
													<button
														key={f.id}
														type="button"
														onClick={() => toggleKind(f.id)}
														title={f.title}
														aria-pressed={on}
														className="text-xs px-2 py-0.5 rounded-full border"
														style={{
															borderColor: on ? theme.colors.accent : theme.colors.border,
															color: on ? theme.colors.textMain : theme.colors.textDim,
															backgroundColor: on ? theme.colors.accentDim : 'transparent',
														}}
													>
														{f.label}
													</button>
												);
											})}
											{focus && (
												<FilterChip
													theme={theme}
													label={`${dayLabel(focus.startMs, nowMs)} ${clockLabel(focus.startMs)} - ${clockLabel(focus.endMs)}`}
													onClear={() => setFocus(null)}
												/>
											)}
											{!showSidebar &&
												[...selectedApps].map((id) => (
													<FilterChip
														key={id}
														theme={theme}
														label={appNames.get(id) ?? id}
														onClear={() => toggleApp(id)}
													/>
												))}
										</div>
									</div>
									<div
										className="flex-1 min-h-0 overflow-y-auto px-4 py-3"
										data-testid="computer-history-stream"
									>
										<VisitStream
											theme={theme}
											page={page}
											error={error}
											visits={visits}
											appColors={appColors}
											highlight={debouncedQuery}
											nowMs={nowMs}
											loadingMore={loadingMore}
											onLoadOlder={() => void loadOlder()}
										/>
									</div>
								</section>
							</>
						)}
						{tab === 'digests' && (
							<div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
								<DigestsPanel
									theme={theme}
									sinceMs={sinceMs}
									untilMs={nowMs}
									refreshToken={refreshToken}
								/>
							</div>
						)}
						{tab === 'capture' && (
							<div className="flex-1 min-h-0 overflow-y-auto px-4 py-4">
								<div className="max-w-2xl mx-auto">
									<CaptureRulesEditor theme={theme} listMaxHeight={480} onConfigChange={refresh} />
								</div>
							</div>
						)}
					</div>
				</>
			)}
		</Modal>
	);
}

function FilterChip({
	theme,
	label,
	onClear,
}: {
	theme: Theme;
	label: string;
	onClear: () => void;
}) {
	return (
		<span
			className="inline-flex items-center gap-1 text-xs pl-2 pr-1 py-0.5 rounded-full"
			style={{ backgroundColor: theme.colors.accent, color: theme.colors.accentForeground }}
		>
			{label}
			<button
				type="button"
				onClick={onClear}
				aria-label={`Clear ${label}`}
				className="rounded-full p-0.5 hover:bg-black/10"
			>
				<X className="w-3 h-3" />
			</button>
		</span>
	);
}

function VisitStream({
	theme,
	page,
	error,
	visits,
	appColors,
	highlight,
	nowMs,
	loadingMore,
	onLoadOlder,
}: {
	theme: Theme;
	page: EventPage | null;
	error: string | null;
	visits: Visit[];
	appColors: ReadonlyMap<string, string>;
	highlight: string;
	nowMs: number;
	loadingMore: boolean;
	onLoadOlder: () => void;
}) {
	if (error) {
		return (
			<EmptyStatePlaceholder theme={theme} title="Could not read history" description={error} />
		);
	}
	if (!page) {
		return (
			<div className="flex justify-center py-10">
				<Spinner size={20} color={theme.colors.textDim} />
			</div>
		);
	}
	if (visits.length === 0) {
		return (
			<EmptyStatePlaceholder
				theme={theme}
				icon={<ScanEye className="w-8 h-8" />}
				title="Nothing recorded here"
				description="Try a wider range, another app, or a different search."
			/>
		);
	}
	let lastDay = '';
	return (
		<div className="space-y-2">
			{visits.map((visit) => {
				const day = localDayKey(visit.startMs);
				const separator = day !== lastDay;
				lastDay = day;
				return (
					<div key={visit.key}>
						{separator && (
							<div
								className="pt-2 pb-1 text-xs font-semibold uppercase tracking-wide select-none"
								style={{ color: theme.colors.textDim, backgroundColor: theme.colors.bgMain }}
							>
								{dayLabel(visit.startMs, nowMs)}
							</div>
						)}
						<VisitCard
							theme={theme}
							visit={visit}
							color={appColors.get(visit.appId) ?? theme.colors.textDim}
							highlight={highlight}
						/>
					</div>
				);
			})}
			{page.more && (
				<div className="flex justify-center py-2">
					<button
						type="button"
						onClick={onLoadOlder}
						disabled={loadingMore}
						className="text-xs px-3 py-1.5 rounded border disabled:opacity-50"
						style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
						data-testid="computer-history-load-older"
					>
						{loadingMore ? 'Loading...' : 'Load older'}
					</button>
				</div>
			)}
		</div>
	);
}
