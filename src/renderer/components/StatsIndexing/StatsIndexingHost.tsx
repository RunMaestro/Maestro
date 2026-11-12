/**
 * StatsIndexingHost - shows a long usage-data scan instead of letting it look
 * like a frozen app.
 *
 * After a version upgrade, the usage caches re-read every session transcript
 * once; on a machine with gigabytes of history that takes minutes. Mounted
 * once in `AppShell`. A scan opens as a modal that says what is happening and
 * how far along it is; "Continue in background" (or Escape) shrinks it to a
 * corner card, which expands again on click. Neither one controls the scan:
 * it runs in the main process, on worker threads, whatever is on screen.
 *
 * State comes from main (`src/main/stats/stats-indexing.ts`); presentation is
 * `statsIndexingStore`. The same numbers are what `maestro-cli stats-indexing`
 * prints, because both go through `summarizeStatsIndexing`.
 */

import { useEffect, useState } from 'react';
import { DatabaseZap, X } from 'lucide-react';
import type { Theme } from '../../types';
import { Modal, ModalFooter } from '../ui/Modal';
import { ProgressBar } from '../ui/ProgressBar';
import { GhostIconButton } from '../ui/GhostIconButton';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { elevatedSurfaceStyle } from '../../utils/elevatedSurface';
import { useToastAvoidZone } from '../../hooks/ui/useToastAvoidZone';
import { useStatsIndexingStore } from '../../stores/statsIndexingStore';
import {
	statsIndexingExplanation,
	statsIndexingTitle,
	summarizeStatsIndexing,
	type StatsIndexingSummary,
} from '../../../shared/statsIndexing';
import { formatCount, formatDurationHuman, formatSize } from '../../../shared/formatters';

interface StatsIndexingHostProps {
	theme: Theme;
}

/** The ETA is wall-clock driven, so it is recomputed this often while visible. */
const CLOCK_TICK_MS = 1000;

export function StatsIndexingHost({ theme }: StatsIndexingHostProps) {
	useStatsIndexingSubscription();
	const state = useStatsIndexingStore((s) => s.state);
	const presentation = useStatsIndexingStore((s) => s.presentation);
	const now = useClock(summarizeStatsIndexing(state, 0) !== null);
	const summary = summarizeStatsIndexing(state, now);

	if (!summary || presentation === 'hidden') return null;
	return presentation === 'modal' ? (
		<StatsIndexingModal theme={theme} summary={summary} />
	) : (
		<StatsIndexingCard theme={theme} summary={summary} />
	);
}

/** Mirror main's state: one read for a window that opens mid-scan, then the push. */
function useStatsIndexingSubscription(): void {
	const applyState = useStatsIndexingStore((s) => s.applyState);
	useEffect(() => {
		const stats = window.maestro?.stats;
		if (!stats?.onIndexingUpdate) return;
		let disposed = false;
		const unsubscribe = stats.onIndexingUpdate((next) => {
			if (!disposed) applyState(next);
		});
		stats
			.getIndexingState()
			.then((initial) => {
				if (!disposed) applyState(initial);
			})
			.catch(() => {
				// The push still arrives; a failed first read only delays the bar.
			});
		return () => {
			disposed = true;
			unsubscribe();
		};
	}, [applyState]);
}

function useClock(running: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!running) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
		return () => clearInterval(timer);
	}, [running]);
	return now;
}

function StatsIndexingModal({ theme, summary }: { theme: Theme; summary: StatsIndexingSummary }) {
	const sendToBackground = useStatsIndexingStore((s) => s.sendToBackground);
	const title = statsIndexingTitle(summary.reason);
	return (
		<Modal
			theme={theme}
			title={title}
			headerIcon={<DatabaseZap className="w-4 h-4" style={{ color: theme.colors.accent }} />}
			priority={MODAL_PRIORITIES.STATS_INDEXING}
			onClose={sendToBackground}
			width={460}
			testId="stats-indexing-modal"
			footer={
				<ModalFooter
					theme={theme}
					showCancel={false}
					onCancel={sendToBackground}
					onConfirm={sendToBackground}
					confirmLabel="Continue in background"
				/>
			}
		>
			<div className="select-none flex flex-col gap-3">
				<p className="text-sm" style={{ color: theme.colors.textMain }}>
					{statsIndexingExplanation(summary.reason)}
				</p>
				<ProgressBar
					value={summary.fraction * 100}
					total={100}
					theme={theme}
					label={title}
					height={8}
					testId="stats-indexing-modal-bar"
				/>
				<ProgressDetail theme={theme} summary={summary} />
			</div>
		</Modal>
	);
}

function StatsIndexingCard({ theme, summary }: { theme: Theme; summary: StatsIndexingSummary }) {
	const bringToFront = useStatsIndexingStore((s) => s.bringToFront);
	const hideCard = useStatsIndexingStore((s) => s.hideCard);
	const avoidRef = useToastAvoidZone();
	const title = statsIndexingTitle(summary.reason);
	return (
		<div
			ref={avoidRef}
			className="fixed bottom-4 right-4 z-[70] w-80 rounded-lg p-3 select-none"
			style={elevatedSurfaceStyle(theme)}
			data-testid="stats-indexing-card"
		>
			<div className="flex items-center gap-2 mb-2">
				<button
					type="button"
					onClick={bringToFront}
					className="flex-1 min-w-0 flex items-center gap-2 text-left outline-none"
					title="Show details"
					data-testid="stats-indexing-card-expand"
				>
					<DatabaseZap className="w-4 h-4 shrink-0" style={{ color: theme.colors.accent }} />
					<span className="text-sm font-medium truncate" style={{ color: theme.colors.textMain }}>
						{title}
					</span>
					<span className="ml-auto text-xs tabular-nums" style={{ color: theme.colors.textDim }}>
						{Math.round(summary.fraction * 100)}%
					</span>
				</button>
				<GhostIconButton
					onClick={hideCard}
					title="Hide until the next scan"
					ariaLabel="Hide scan progress"
					color={theme.colors.textDim}
				>
					<X className="w-3.5 h-3.5" />
				</GhostIconButton>
			</div>
			<ProgressBar
				value={summary.fraction * 100}
				total={100}
				theme={theme}
				label={title}
				testId="stats-indexing-card-bar"
			/>
			<ProgressDetail theme={theme} summary={summary} compact />
		</div>
	);
}

function ProgressDetail({
	theme,
	summary,
	compact = false,
}: {
	theme: Theme;
	summary: StatsIndexingSummary;
	compact?: boolean;
}) {
	const files = `${formatCount(summary.doneFiles)} of ${formatCount(summary.totalFiles)} transcripts`;
	const bytes =
		summary.totalBytes > 0
			? ` · ${formatSize(summary.doneBytes)} of ${formatSize(summary.totalBytes)}`
			: '';
	const eta =
		summary.etaMs !== undefined
			? `About ${formatDurationHuman(summary.etaMs)} left`
			: 'Estimating time left';
	return (
		<div
			className={`flex flex-col gap-0.5 text-xs ${compact ? 'mt-2' : ''}`}
			style={{ color: theme.colors.textDim }}
		>
			<span className="tabular-nums">
				{files}
				{bytes}
			</span>
			<span>{eta}</span>
			{!compact && <span>Building: {summary.labels.join(', ')}</span>}
		</div>
	);
}
