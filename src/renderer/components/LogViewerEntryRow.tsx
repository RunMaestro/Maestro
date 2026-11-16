/**
 * One card of the System Log Viewer. Memoized, and the list is virtualized, so
 * a new log line, the relative-time tick, or a store update re-renders only the
 * handful of cards on screen instead of every entry in the buffer.
 */

import React, { memo } from 'react';
import { ChevronRight, ChevronDown, Pencil, Copy, Check } from 'lucide-react';
import type { Theme } from '../types';
import { readableTextOn, transparentize } from '../../shared/colorContrast';
import { formatRelativeTime } from '../../shared/formatters';
import type { SourcedLogEntry } from '../../shared/logSources';
import { useSessionStore } from '../stores/sessionStore';

/** One card's entry: Maestro's own, or a file log line read into the same shape. */
export type SystemLogEntry = SourcedLogEntry;

export interface LogLevelColor {
	/** Solid fill: timeline stripe, selected filter chip, pill border. */
	fg: string;
	/** The level color washed over the card the pill sits on. */
	bg: string;
	/** Pill label, held to AA against `bg` rather than assumed readable. */
	text: string;
}

/** Jump-to-agent pill: the same wash as a level pill, one step more opaque. */
function agentPillStyle(theme: Theme, color: string): React.CSSProperties {
	const backgroundColor = transparentize(color, theme.colors.bgActivity, 0.2);
	return { backgroundColor, color: readableTextOn(color, [backgroundColor]) };
}

interface AgentPillProps {
	theme: Theme;
	label: string;
	color: string;
	sessionId: string | undefined;
	tabId?: string;
	onSessionClick?: (sessionId: string, tabId?: string) => void;
}

function AgentPill({ theme, label, color, sessionId, tabId, onSessionClick }: AgentPillProps) {
	const canNavigate = !!(onSessionClick && sessionId);
	return (
		<span
			className={`text-xs px-1.5 py-0.5 rounded flex items-center gap-1${canNavigate ? ' cursor-pointer hover:brightness-125' : ''}`}
			style={agentPillStyle(theme, color)}
			onClick={
				canNavigate
					? (e) => {
							e.stopPropagation();
							onSessionClick!(sessionId!, tabId);
						}
					: undefined
			}
			title={canNavigate ? `Jump to ${label}` : undefined}
		>
			<Pencil className="w-3 h-3" />
			{label}
		</span>
	);
}

/**
 * An Auto Run or Cue entry names its agent; the pill resolves the name here,
 * per card, with a selector that returns a primitive. The viewer itself no
 * longer subscribes to the session list, which changes on every streamed chunk
 * of every busy agent and used to re-render the whole log with it.
 */
function NamedAgentPill(props: Omit<AgentPillProps, 'sessionId' | 'tabId'>) {
	const sessionId = useSessionStore((s) => s.sessions.find((x) => x.name === props.label)?.id);
	return <AgentPill {...props} sessionId={sessionId} />;
}

export interface LogViewerEntryRowProps {
	log: SystemLogEntry;
	entryKey: string;
	theme: Theme;
	levelColor: LogLevelColor | undefined;
	/** The Cue level's fill, for a Cue entry's agent pill. */
	cueColor: string;
	expanded: boolean;
	copied: boolean;
	/** Changes every few seconds so the relative time on a shown card stays fresh. */
	relativeTick: number;
	onToggleExpanded: (entryKey: string) => void;
	onCopy: (log: SystemLogEntry, entryKey: string) => void;
	onSessionClick?: (sessionId: string, tabId?: string) => void;
}

export const LogViewerEntryRow = memo(function LogViewerEntryRow({
	log,
	entryKey,
	theme,
	levelColor,
	cueColor,
	expanded,
	copied,
	onToggleExpanded,
	onCopy,
	onSessionClick,
}: LogViewerEntryRowProps) {
	const toast =
		log.level === 'toast'
			? (log.data as { project?: string; sessionId?: string; tabId?: string } | undefined)
			: undefined;

	return (
		<div
			className="rounded p-3 border"
			style={{
				backgroundColor: theme.colors.bgActivity,
				borderColor: theme.colors.border,
			}}
		>
			<div className="flex items-start gap-3 group">
				{/* Level Pill */}
				<div
					className="px-2 py-0.5 rounded text-xs font-bold uppercase flex-shrink-0"
					style={{
						backgroundColor: levelColor?.bg ?? 'transparent',
						color: levelColor?.text ?? theme.colors.textDim,
					}}
				>
					{log.level}
				</div>

				{/* Copy Button */}
				<button
					onClick={() => onCopy(log, entryKey)}
					className="p-1 rounded row-hover transition-all flex-shrink-0 opacity-0 group-hover:opacity-100"
					style={{ color: copied ? theme.colors.accent : theme.colors.textDim }}
					title={copied ? 'Copied!' : 'Copy log entry'}
				>
					{copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
				</button>

				{/* Content */}
				<div className="flex-1 min-w-0">
					<div className="flex items-start gap-2 mb-1">
						<span
							className="text-xs font-mono flex-shrink-0"
							style={{ color: theme.colors.textMain }}
						>
							{new Date(log.timestamp).toLocaleTimeString()}{' '}
							<span style={{ color: theme.colors.textDim }}>
								({formatRelativeTime(log.timestamp, { includeSeconds: true })})
							</span>
						</span>
						{/* Context pill - show for non-toast/autorun entries */}
						{log.level !== 'toast' &&
							log.level !== 'autorun' &&
							log.level !== 'cue' &&
							log.context && (
								<span
									className="text-xs px-1.5 py-0.5 rounded font-mono"
									style={{ backgroundColor: theme.colors.bgMain, color: theme.colors.accent }}
								>
									{log.context}
								</span>
							)}
						{/* Agent name pill for toast entries (from data.project) */}
						{toast?.project && (
							<AgentPill
								theme={theme}
								label={toast.project}
								color={theme.colors.success}
								sessionId={toast.sessionId}
								tabId={toast.tabId}
								onSessionClick={onSessionClick}
							/>
						)}
						{/* Agent name pill for autorun and cue entries (from context) */}
						{(log.level === 'autorun' || log.level === 'cue') && log.context && (
							<NamedAgentPill
								theme={theme}
								label={log.context}
								color={log.level === 'cue' ? cueColor : theme.colors.success}
								onSessionClick={onSessionClick}
							/>
						)}
					</div>
					<div className="text-sm break-words" style={{ color: theme.colors.textMain }}>
						{log.message}
					</div>
					{!!log.data && (
						<div className="mt-2">
							<button
								onClick={() => onToggleExpanded(entryKey)}
								className="flex items-center gap-1 text-xs px-2 py-1 rounded row-hover transition-colors"
								style={{ color: theme.colors.textDim, backgroundColor: theme.colors.bgMain }}
							>
								{expanded ? (
									<ChevronDown className="w-3 h-3" />
								) : (
									<ChevronRight className="w-3 h-3" />
								)}
								<span className="font-mono">{expanded ? 'Hide details' : 'Show details'}</span>
							</button>
							{expanded && (
								<pre
									className="text-xs mt-1 p-2 rounded overflow-x-auto font-mono scrollbar-thin"
									style={{ backgroundColor: theme.colors.bgMain, color: theme.colors.textDim }}
								>
									{JSON.stringify(log.data, null, 2)}
								</pre>
							)}
						</div>
					)}
				</div>
			</div>
		</div>
	);
});
