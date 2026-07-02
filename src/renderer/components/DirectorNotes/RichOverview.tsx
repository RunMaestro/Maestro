/**
 * RichOverview
 *
 * The Director's Notes "Rich Mode" dashboard. Composes the shared
 * presentational widget library (`components/widgets`) from a single,
 * deterministic source of truth: `getRichOverviewStats`, which the main process
 * computes over the raw history entries. Every number the widgets render -
 * totals, success/failure ratios, per-agent activity, time-spent, and the
 * timeline - comes from that typed IPC, never from the LLM. The AI narrative
 * markdown is rendered below the widgets via the existing MarkdownRenderer. Each
 * chart is wrapped in ChartErrorBoundary so a single widget failure never blanks
 * the tab.
 */

import { useEffect, useRef, useState } from 'react';
import {
	History,
	Bot,
	Timer,
	Activity,
	PieChart,
	Users,
	FileText,
	CheckCircle2,
	Hourglass,
} from 'lucide-react';
import type { Theme } from '../../types';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { Spinner } from '../ui/Spinner';
import { CUE_COLOR } from '../../../shared/cue-pipeline-types';
import { formatNumber, formatDurationLong } from '../../../shared/formatters';
import { generateTerminalProseStyles } from '../../utils/markdownConfig';
import { safeClipboardWrite } from '../../utils/clipboard';
import { useSettingsStore } from '../../stores/settingsStore';
import { COLORBLIND_STATUS_COLORS } from '../../constants/colorblindPalettes';
import { logger } from '../../utils/logger';
import { daysToLookbackHours, bucketCountForLookback } from './lookback';
import { NarrativeSections } from './NarrativeSections';
import { NarrativeParseError } from './NarrativeParseError';
import type { DirectorNotesNarrative } from '../../../shared/directorNotesNarrative';
import {
	StatCardGrid,
	SectionCard,
	ActivityTimeline,
	TypeBreakdown,
	AgentActivityBars,
	SuccessFailureWidget,
	ChartErrorBoundary,
	type StatCardDatum,
	type BarDatum,
	type DonutSlice,
} from '../widgets';

/** Derived from the IPC contract so this stays in sync with the bridge. */
type SynopsisStats = NonNullable<
	Awaited<ReturnType<typeof window.maestro.directorNotes.generateSynopsis>>['stats']
>;
type RichStats = Awaited<ReturnType<typeof window.maestro.directorNotes.getRichOverviewStats>>;

interface RichOverviewProps {
	theme: Theme;
	/** Deterministic generation stats from the synopsis call (for the generation-time card). */
	stats: SynopsisStats | null;
	/** Raw AI narrative markdown - used for the legacy/markdown fallback path. */
	synopsis: string;
	/** Parsed structured narrative; when present it renders as styled section cards. */
	narrative?: DirectorNotesNarrative | null;
	/** Set when the structured output failed to parse; renders the overt error banner. */
	narrativeError?: string | null;
	/** Lookback window in days; drives the IPC query. */
	lookbackDays: number;
	/** Forwarded to the narrative MarkdownRenderer (matches Plain-mode behavior). */
	enableBionifyReadingMode?: boolean;
	/** Enables KaTeX math in the narrative MarkdownRenderer (matches Plain-mode behavior). */
	chatMath?: boolean;
}

export function RichOverview({
	theme,
	stats,
	synopsis,
	narrative,
	narrativeError,
	lookbackDays,
	enableBionifyReadingMode = false,
	chatMath = false,
}: RichOverviewProps) {
	const colorBlindMode = useSettingsStore((s) => s.colorBlindMode);
	const [richStats, setRichStats] = useState<RichStats | null>(null);
	const [isLoading, setIsLoading] = useState(true);
	const requestIdRef = useRef(0);

	// Fetch the deterministic stats on mount and whenever the lookback window
	// changes. A monotonic request id guards against a slow earlier response
	// clobbering a newer one after rapid changes.
	useEffect(() => {
		const requestId = ++requestIdRef.current;
		const bucketCount = bucketCountForLookback(daysToLookbackHours(lookbackDays));
		setIsLoading(true);

		(async () => {
			try {
				const next = await window.maestro.directorNotes.getRichOverviewStats({
					lookbackDays,
					bucketCount,
				});
				if (requestId !== requestIdRef.current) return;
				setRichStats(next);
			} catch (err) {
				if (requestId !== requestIdRef.current) return;
				logger.error('Failed to load Rich Overview stats:', undefined, err);
				setRichStats(null);
			} finally {
				if (requestId === requestIdRef.current) setIsLoading(false);
			}
		})();
	}, [lookbackDays]);

	// --- Derive widget data from the deterministic stats ---
	const autoColor = colorBlindMode ? COLORBLIND_STATUS_COLORS.warning : theme.colors.warning;
	const userColor = theme.colors.accent;
	const successColor = colorBlindMode ? COLORBLIND_STATUS_COLORS.success : theme.colors.success;
	const failureColor = colorBlindMode ? COLORBLIND_STATUS_COLORS.error : theme.colors.error;

	const timelineBuckets = richStats?.timelineBuckets ?? [];
	const totalsTrend = timelineBuckets.map((b) => b.auto + b.user + b.cue);

	const totalEntries = richStats?.totalEntries ?? 0;
	const agentCount = richStats?.agentCount ?? 0;
	const autoCount = richStats?.autoCount ?? 0;
	const userCount = richStats?.userCount ?? 0;
	const cueCount = richStats?.cueCount ?? 0;
	const successCount = richStats?.successCount ?? 0;
	const failureCount = richStats?.failureCount ?? 0;
	const successRate = richStats?.successRate ?? 0;
	const totalElapsedMs = richStats?.totalElapsedMs ?? 0;

	const successPct = Math.round(successRate * 100);

	const cards: StatCardDatum[] = [
		{
			label: 'Total Entries',
			value: totalEntries,
			icon: History,
			color: userColor,
			trend: totalsTrend,
		},
		{ label: 'Agents', value: agentCount, icon: Bot, color: userColor },
		{
			label: 'Success Rate',
			value: successCount,
			displayValue: `${successPct}%`,
			caption: `${formatNumber(successCount)} ok · ${formatNumber(failureCount)} failed`,
			icon: CheckCircle2,
			color: successColor,
		},
		{
			label: 'Time Spent',
			value: totalElapsedMs,
			displayValue: formatDurationLong(totalElapsedMs),
			icon: Timer,
			color: theme.colors.accent,
		},
	];
	// Generation time is deterministic too (from the synopsis call). Keep it as
	// an extra card when available.
	if (stats && stats.durationMs > 0) {
		cards.push({
			label: 'Generation Time',
			value: stats.durationMs,
			displayValue: formatDurationLong(stats.durationMs),
			icon: Hourglass,
			color: theme.colors.success,
		});
	}

	const slices: DonutSlice[] = [
		{ label: 'User', value: userCount, color: userColor },
		{ label: 'Auto', value: autoCount, color: autoColor },
		{ label: 'Cue', value: cueCount, color: CUE_COLOR },
	];

	const agentBars: BarDatum[] = (richStats?.perAgent ?? []).map((a) => ({
		label: a.agentName,
		value: a.entryCount,
	}));

	const proseStyles = generateTerminalProseStyles(theme, '.director-notes-content');

	return (
		<div className="flex flex-col gap-4">
			{/* Headline stat cards */}
			{isLoading && !richStats ? (
				<div className="flex items-center gap-3 py-6 px-1">
					<Spinner size={18} color={theme.colors.accent} />
					<span className="text-sm" style={{ color: theme.colors.textDim }}>
						Loading activity…
					</span>
				</div>
			) : (
				<StatCardGrid theme={theme} cards={cards} />
			)}

			{/* Activity timeline */}
			<SectionCard theme={theme} title="Activity Timeline" icon={Activity}>
				<ChartErrorBoundary theme={theme} chartName="Activity Timeline">
					<ActivityTimeline
						theme={theme}
						buckets={timelineBuckets}
						colors={{ auto: autoColor, user: userColor, cue: CUE_COLOR }}
					/>
				</ChartErrorBoundary>
			</SectionCard>

			{/* Success vs failure */}
			<SectionCard theme={theme} title="Success vs Failure" icon={CheckCircle2}>
				<ChartErrorBoundary theme={theme} chartName="Success vs Failure">
					<SuccessFailureWidget
						theme={theme}
						successCount={successCount}
						failureCount={failureCount}
						colors={{ success: successColor, failure: failureColor }}
					/>
				</ChartErrorBoundary>
			</SectionCard>

			{/* Source / type breakdown */}
			<SectionCard theme={theme} title="Source Breakdown" icon={PieChart}>
				<ChartErrorBoundary theme={theme} chartName="Source Breakdown">
					<TypeBreakdown theme={theme} slices={slices} />
				</ChartErrorBoundary>
			</SectionCard>

			{/* Per-agent activity */}
			<SectionCard theme={theme} title="Agent Activity" icon={Users}>
				<ChartErrorBoundary theme={theme} chartName="Agent Activity">
					<AgentActivityBars theme={theme} data={agentBars} />
				</ChartErrorBoundary>
			</SectionCard>

			{/* AI narrative slot. Priority: structured narrative -> overt parse
			    failure -> legacy markdown fallback (e.g. a cached result that only
			    has markdown). A parse failure surfaces loudly here while the
			    deterministic widgets above keep rendering normally. */}
			{narrative ? (
				<NarrativeSections theme={theme} narrative={narrative} />
			) : narrativeError ? (
				<NarrativeParseError theme={theme} error={narrativeError} rawOutput={synopsis} />
			) : (
				synopsis && (
					<SectionCard theme={theme} title="AI Narrative" icon={FileText}>
						{/* Content-driven AI output: opt back into text selection under
						    the modal's select-none (see CLAUDE.md modal text rules). */}
						<div className="director-notes-content select-text">
							<style>{proseStyles}</style>
							<MarkdownRenderer
								content={synopsis}
								theme={theme}
								onCopy={(text) => safeClipboardWrite(text)}
								enableBionifyReadingMode={enableBionifyReadingMode}
								chatMath={chatMath}
							/>
						</div>
					</SectionCard>
				)
			)}
		</div>
	);
}

export default RichOverview;
