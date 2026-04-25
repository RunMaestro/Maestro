/**
 * ActivityLogDetail — Expanded detail view for a single Cue run execution.
 *
 * Shows metadata grid, event payload, stdout, and stderr.
 */

import { Clock, Zap, Terminal, AlertTriangle } from 'lucide-react';
import type { Theme } from '../../types';
import type { CueRunResult } from '../../hooks/useCue';
import { CUE_COLOR } from '../../../shared/cue-pipeline-types';
import { cleanStderrForDisplay, formatDuration, formatPayloadEntries } from './cueModalUtils';

interface ActivityLogDetailProps {
	entry: CueRunResult;
	theme: Theme;
}

export function ActivityLogDetail({ entry, theme }: ActivityLogDetailProps) {
	const payloadEntries = formatPayloadEntries(entry.event.payload);
	const hasStdout = entry.stdout.trim().length > 0;
	// Apply the benign-stderr filter at display time too so older log entries
	// (captured before the backend filter existed) don't paint the red Errors
	// panel with agent-CLI diagnostics that aren't actually errors.
	const displayStderr = cleanStderrForDisplay(entry.stderr);
	const hasStderr = displayStderr.trim().length > 0;

	return (
		<div
			className="mt-1 mb-2 rounded-md px-3 py-3 text-xs space-y-3"
			style={{ backgroundColor: theme.colors.bgMain, border: `1px solid ${theme.colors.border}` }}
		>
			{/* Execution metadata */}
			<div className="grid grid-cols-2 gap-x-6 gap-y-1">
				<div className="flex items-center gap-1.5">
					<Clock className="w-3 h-3" style={{ color: theme.colors.textDim }} />
					<span style={{ color: theme.colors.textDim }}>Started:</span>
					<span style={{ color: theme.colors.textMain }}>
						{new Date(entry.startedAt).toLocaleString()}
					</span>
				</div>
				<div className="flex items-center gap-1.5">
					<Clock className="w-3 h-3" style={{ color: theme.colors.textDim }} />
					<span style={{ color: theme.colors.textDim }}>Duration:</span>
					<span style={{ color: theme.colors.textMain }}>{formatDuration(entry.durationMs)}</span>
				</div>
				<div className="flex items-center gap-1.5">
					<Zap className="w-3 h-3" style={{ color: CUE_COLOR }} />
					<span style={{ color: theme.colors.textDim }}>Event:</span>
					<span style={{ color: theme.colors.textMain }}>{entry.event.type}</span>
				</div>
				<div className="flex items-center gap-1.5">
					<Terminal className="w-3 h-3" style={{ color: theme.colors.textDim }} />
					<span style={{ color: theme.colors.textDim }}>Exit code:</span>
					<span
						style={{
							color:
								entry.exitCode === 0
									? theme.colors.success
									: entry.exitCode != null
										? theme.colors.error
										: theme.colors.textDim,
						}}
					>
						{entry.exitCode ?? '—'}
					</span>
				</div>
				<div className="flex items-center gap-1.5">
					<span style={{ color: theme.colors.textDim }}>Session:</span>
					<span style={{ color: theme.colors.textMain }}>{entry.sessionName}</span>
				</div>
				<div className="flex items-center gap-1.5">
					<span style={{ color: theme.colors.textDim }}>Run ID:</span>
					<span className="font-mono" style={{ color: theme.colors.textDim }}>
						{entry.runId.slice(0, 8)}
					</span>
				</div>
			</div>

			{/* Event payload */}
			{payloadEntries.length > 0 && (
				<div>
					<div
						className="text-[10px] font-bold uppercase tracking-wider mb-1"
						style={{ color: theme.colors.textDim }}
					>
						Event Payload
					</div>
					<div
						className="rounded px-2 py-1.5 font-mono text-[11px] space-y-0.5 max-h-32 overflow-y-auto"
						style={{ backgroundColor: theme.colors.bgActivity }}
					>
						{payloadEntries.map(([key, value]) => (
							<div key={key} className="flex gap-2">
								<span className="flex-shrink-0" style={{ color: CUE_COLOR }}>
									{key}:
								</span>
								<span className="break-all" style={{ color: theme.colors.textMain }}>
									{value}
								</span>
							</div>
						))}
					</div>
				</div>
			)}

			{/* stdout */}
			{hasStdout && (
				<div>
					<div
						className="text-[10px] font-bold uppercase tracking-wider mb-1"
						style={{ color: theme.colors.textDim }}
					>
						Output
					</div>
					<pre
						className="rounded px-2 py-1.5 text-[11px] max-h-48 overflow-y-auto whitespace-pre-wrap break-all"
						style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textMain }}
					>
						{entry.stdout.slice(-5000)}
					</pre>
				</div>
			)}

			{/* stderr */}
			{hasStderr && (
				<div>
					<div className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider mb-1">
						<AlertTriangle className="w-3 h-3" style={{ color: theme.colors.error }} />
						<span style={{ color: theme.colors.error }}>Errors</span>
					</div>
					<pre
						className="rounded px-2 py-1.5 text-[11px] max-h-32 overflow-y-auto whitespace-pre-wrap break-all"
						style={{ backgroundColor: `${theme.colors.error}10`, color: theme.colors.error }}
					>
						{displayStderr.slice(-3000)}
					</pre>
				</div>
			)}
		</div>
	);
}
