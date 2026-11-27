/**
 * ActivityLogDetail - Expanded detail view for a single Cue run execution.
 *
 * Shows metadata grid, event payload, stdout, and stderr.
 */

import { Clock, Zap, Terminal, AlertTriangle, Filter, ShieldAlert } from 'lucide-react';
import type { Theme } from '../../types';
import type { CueRunResult } from '../../hooks/useCue';
import { CUE_COLOR } from '../../../shared/cue-pipeline-types';
import { readCueGateRecord, type CueGateRecord } from '../../../shared/cue/gate';
import {
	readCueInjectionRecord,
	type CueInjectionRecord,
} from '../../../shared/cue/injection-screen';
import { isCueRunBlocked } from '../../../shared/cue/contracts';
import { cleanStderrForDisplay, formatDuration, formatPayloadEntries } from './cueModalUtils';

/** What each gate outcome is called in the detail view. */
const GATE_OUTCOME_LABEL: Record<CueGateRecord['outcome'], string> = {
	passed: 'Passed',
	gated: 'Skipped the run',
	'ran-unchecked': 'Not checked, ran anyway',
};

/** What each injection screen outcome is called in the detail view. */
const INJECTION_OUTCOME_LABEL: Record<CueInjectionRecord['outcome'], string> = {
	clean: 'Clean',
	blocked: 'Blocked the run',
	'ran-unscreened': 'Not screened, ran anyway',
};

/** The color an injection screen outcome is drawn in. */
function injectionOutcomeColor(outcome: CueInjectionRecord['outcome'], theme: Theme): string {
	if (outcome === 'blocked') return theme.colors.error;
	if (outcome === 'ran-unscreened') return theme.colors.warning;
	return theme.colors.textMain;
}

interface ActivityLogDetailProps {
	entry: CueRunResult;
	theme: Theme;
}

export function ActivityLogDetail({ entry, theme }: ActivityLogDetailProps) {
	const payloadEntries = formatPayloadEntries(entry.event.payload);
	const gate = readCueGateRecord(entry.event.payload);
	const injection = readCueInjectionRecord(entry.event.payload);
	const hasStdout = entry.stdout.trim().length > 0;
	// Apply the benign-stderr filter at display time too so older log entries
	// (captured before the backend filter existed) don't paint the red Errors
	// panel with agent-CLI diagnostics that aren't actually errors.
	const displayStderr = cleanStderrForDisplay(entry.stderr);
	// A blocked run's `stderr` IS the screen's reason, which the Injection
	// screen section already shows. Nothing ran, so there are no other errors.
	const hasStderr = displayStderr.trim().length > 0 && !isCueRunBlocked(entry.status);

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
						{entry.exitCode ?? '-'}
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

			{/* Gate verdict: why this event did or did not start a run */}
			{gate && (
				<div data-testid="cue-activity-gate">
					<div className="flex items-center gap-1 text-2xs font-bold uppercase tracking-wider mb-1">
						<Filter
							className="w-3 h-3"
							style={{
								color: gate.outcome === 'ran-unchecked' ? theme.colors.warning : CUE_COLOR,
							}}
						/>
						<span style={{ color: theme.colors.textDim }}>Gate</span>
						<span
							className="normal-case tracking-normal font-normal"
							style={{
								color:
									gate.outcome === 'ran-unchecked' ? theme.colors.warning : theme.colors.textMain,
							}}
						>
							{GATE_OUTCOME_LABEL[gate.outcome]}
						</span>
					</div>
					{gate.reason && (
						<div
							className="rounded px-2 py-1.5 text-xs-plus select-text"
							style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textMain }}
						>
							{gate.reason}
						</div>
					)}
				</div>
			)}

			{/* Injection screen: what it found in the untrusted text of this event */}
			{injection && (
				<div data-testid="cue-activity-injection-screen">
					<div className="flex items-center gap-1 text-2xs font-bold uppercase tracking-wider mb-1">
						<ShieldAlert
							className="w-3 h-3"
							style={{
								color:
									injection.outcome === 'clean'
										? CUE_COLOR
										: injectionOutcomeColor(injection.outcome, theme),
							}}
						/>
						<span style={{ color: theme.colors.textDim }}>Injection screen</span>
						<span
							className="normal-case tracking-normal font-normal"
							style={{ color: injectionOutcomeColor(injection.outcome, theme) }}
						>
							{INJECTION_OUTCOME_LABEL[injection.outcome]}
						</span>
					</div>
					{injection.reason && (
						<div
							className="rounded px-2 py-1.5 text-xs-plus select-text"
							style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textMain }}
						>
							{injection.reason}
						</div>
					)}
				</div>
			)}

			{/* Event payload */}
			{payloadEntries.length > 0 && (
				<div>
					<div
						className="text-2xs font-bold uppercase tracking-wider mb-1"
						style={{ color: theme.colors.textDim }}
					>
						Event Payload
					</div>
					<div
						className="rounded px-2 py-1.5 font-mono text-xs-plus space-y-0.5 max-h-32 overflow-y-auto"
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
						className="text-2xs font-bold uppercase tracking-wider mb-1"
						style={{ color: theme.colors.textDim }}
					>
						Output
					</div>
					<pre
						className="rounded px-2 py-1.5 text-xs-plus max-h-48 overflow-y-auto whitespace-pre-wrap break-all"
						style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textMain }}
					>
						{entry.stdout.slice(-5000)}
					</pre>
				</div>
			)}

			{/* stderr */}
			{hasStderr && (
				<div>
					<div className="flex items-center gap-1 text-2xs font-bold uppercase tracking-wider mb-1">
						<AlertTriangle className="w-3 h-3" style={{ color: theme.colors.error }} />
						<span style={{ color: theme.colors.error }}>Errors</span>
					</div>
					<pre
						className="rounded px-2 py-1.5 text-xs-plus max-h-32 overflow-y-auto whitespace-pre-wrap break-all"
						style={{ backgroundColor: `${theme.colors.error}10`, color: theme.colors.error }}
					>
						{displayStderr.slice(-3000)}
					</pre>
				</div>
			)}
		</div>
	);
}
