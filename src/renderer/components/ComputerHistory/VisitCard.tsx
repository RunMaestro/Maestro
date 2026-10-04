/**
 * Computer History - one visit (a run of events in one app and window).
 *
 * The header carries the app, window, site, and time span; the body lists
 * what happened there: text typed into fields, selections, window changes,
 * and screen-text snapshots (collapsed, since one can be 32 KB). Everything
 * shown is captured from other apps, so URLs are displayed, never linked.
 */

import { memo, useState } from 'react';
import { AppWindow, ChevronRight, FileText, Highlighter, Keyboard } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { Theme } from '../../types';
import { CopyIconButton } from '../ui/CopyIconButton';
import { highlightMatches } from '../../utils/highlightMatches';
import { formatDurationCompact } from '../../../shared/duration';
import type { StoredEvent } from '../../../shared/computer-history/types';
import { clockLabel, eventKey, urlHostLabel, type Visit } from './timelineModel';

const SNAPSHOT_PREVIEW_CHARS = 180;

const ROW_ICONS: Partial<Record<StoredEvent['kind'], { icon: LucideIcon; label: string }>> = {
	'text.committed': { icon: Keyboard, label: 'Typed' },
	'selection.changed': { icon: Highlighter, label: 'Selected' },
	'content.snapshot': { icon: FileText, label: 'Screen text' },
	'window.changed': { icon: AppWindow, label: 'Window' },
};

interface VisitCardProps {
	theme: Theme;
	visit: Visit;
	color: string;
	/** Plain-text query to highlight (the service already filtered by it). */
	highlight: string;
}

export const VisitCard = memo(function VisitCard({
	theme,
	visit,
	color,
	highlight,
}: VisitCardProps) {
	const host = urlHostLabel(visit.url);
	const spanMs = visit.endMs - visit.startMs;
	return (
		<article
			className="rounded-lg border overflow-hidden"
			style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgActivity }}
			data-testid="computer-history-visit"
		>
			<header
				className="flex items-center gap-2 px-3 py-2"
				style={{ borderLeft: `3px solid ${color}` }}
			>
				<span className="text-sm font-semibold truncate" style={{ color: theme.colors.textMain }}>
					{visit.appName}
				</span>
				{visit.title && (
					<span className="text-sm truncate min-w-0 flex-1" style={{ color: theme.colors.textDim }}>
						{highlightMatches(visit.title, highlight, theme.colors.accent)}
					</span>
				)}
				{!visit.title && <span className="flex-1" />}
				{host && (
					<span
						className="text-xs font-mono px-1.5 py-0.5 rounded flex-shrink-0"
						style={{ backgroundColor: theme.colors.bgMain, color: theme.colors.textDim }}
						title={visit.url}
					>
						{host}
					</span>
				)}
				<span
					className="text-xs tabular-nums flex-shrink-0"
					style={{ color: theme.colors.textDim }}
					title={new Date(visit.startMs).toLocaleString()}
				>
					{clockLabel(visit.startMs)}
					{spanMs >= 60_000
						? ` - ${clockLabel(visit.endMs)} (${formatDurationCompact(spanMs)})`
						: ''}
				</span>
			</header>
			{visit.rows.length > 0 && (
				<ul className="px-3 pb-2 space-y-1.5 select-text">
					{visit.rows.map((e) => (
						<EventRow key={eventKey(e)} theme={theme} event={e} highlight={highlight} />
					))}
				</ul>
			)}
		</article>
	);
});

function EventRow({
	theme,
	event,
	highlight,
}: {
	theme: Theme;
	event: StoredEvent;
	highlight: string;
}) {
	const [expanded, setExpanded] = useState(false);
	const meta = ROW_ICONS[event.kind];
	if (!meta) return null;
	const Icon = meta.icon;
	const isSnapshot = event.kind === 'content.snapshot';
	const text = event.kind === 'window.changed' ? (event.window?.title ?? '') : (event.text ?? '');
	const label = event.element?.label;
	const shown =
		isSnapshot && !expanded && text.length > SNAPSHOT_PREVIEW_CHARS
			? `${text.slice(0, SNAPSHOT_PREVIEW_CHARS).trimEnd()}...`
			: text;

	return (
		<li className="group flex gap-2 text-sm" data-kind={event.kind}>
			<span
				className="text-xs tabular-nums pt-0.5 w-11 flex-shrink-0 select-none"
				style={{ color: theme.colors.textDim }}
			>
				{clockLabel(Date.parse(event.ts))}
			</span>
			<Icon
				className="w-3.5 h-3.5 mt-0.5 flex-shrink-0"
				style={{ color: theme.colors.textDim }}
				aria-label={meta.label}
			/>
			<div className="flex-1 min-w-0">
				{(label || isSnapshot) && (
					<div className="text-xs mb-0.5 select-none" style={{ color: theme.colors.textDim }}>
						{isSnapshot ? (
							<button
								type="button"
								onClick={() => setExpanded((v) => !v)}
								className="inline-flex items-center gap-1 hover:underline"
								aria-expanded={expanded}
							>
								<ChevronRight
									className={`w-3 h-3 transition-transform ${expanded ? 'rotate-90' : ''}`}
								/>
								{meta.label} - {text.length.toLocaleString()} chars
								{event.truncated ? ' (truncated)' : ''}
							</button>
						) : (
							label
						)}
					</div>
				)}
				<div
					className={`whitespace-pre-wrap break-words ${isSnapshot && expanded ? 'max-h-80 overflow-y-auto' : 'max-h-40 overflow-y-auto'}`}
					style={{
						color: event.kind === 'window.changed' ? theme.colors.textDim : theme.colors.textMain,
						fontStyle: event.kind === 'selection.changed' ? 'italic' : undefined,
					}}
				>
					{event.kind === 'selection.changed' ? '"' : ''}
					{highlightMatches(shown, highlight, theme.colors.accent)}
					{event.kind === 'selection.changed' ? '"' : ''}
				</div>
			</div>
			{text && event.kind !== 'window.changed' && (
				<CopyIconButton
					value={text}
					theme={theme}
					title={`Copy ${meta.label.toLowerCase()}`}
					className="opacity-0 group-hover:opacity-100 focus:opacity-100 self-start"
				/>
			)}
		</li>
	);
}
