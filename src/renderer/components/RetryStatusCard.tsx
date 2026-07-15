/**
 * RetryStatusCard - the collapsed Agent Resilience "outage" bubble in the chat
 * transcript. When an agent turn fails with a recoverable upstream error and
 * resilience auto-retries, ALL of the repeated attempts collapse into this one
 * live card instead of spraying a wall of error bubbles. It shows, at a glance:
 *   - which failure mode (service overloaded vs plan quota exhausted),
 *   - how many times we've retried,
 *   - how long the outage has lasted (since the first failure),
 *   - when the next attempt fires (live countdown), and
 *   - a "Retry now" button to skip the timer + "Stop" to give up.
 *
 * Driven entirely by the persistent `retryStore.outages[outageId]` record, which
 * outlives the active retry so the card freezes into a "Recovered" / "Stopped"
 * summary once the outage resolves. Anchored in the transcript by a marker
 * `LogEntry` carrying `retryOutageId` (see `useAgentErrorListener`).
 */

import React, { useEffect, useState } from 'react';
import { AlertTriangle, Check, RefreshCw, X, Zap } from 'lucide-react';

import { useRetryStore, retryNow, cancelRetry } from '../stores/retryStore';
import { formatDurationHuman } from '../../shared/formatters';
import type { Theme } from '../types';

interface RetryStatusCardProps {
	outageId: string;
	theme: Theme;
	/**
	 * The marker entry's original error text. Rendered as a graceful fallback
	 * when the in-memory outage record is gone (e.g. after an app restart, which
	 * clears `retryStore` but keeps the persisted transcript) so an old marker
	 * doesn't collapse to an empty row.
	 */
	fallbackText?: string;
}

/** Constitutional "stuck / backing off" hue - pulsing orange, distinct from thinking-yellow. */
const OUTAGE_COLOR = '#ff8800';

function StatBlock({
	label,
	value,
	color,
}: {
	label: string;
	value: string;
	color: string;
}): React.ReactElement {
	return (
		<div className="flex flex-col gap-0.5 min-w-0">
			<span className="text-[10px] uppercase tracking-wide opacity-70" style={{ color }}>
				{label}
			</span>
			<span className="text-sm font-medium tabular-nums" style={{ color }}>
				{value}
			</span>
		</div>
	);
}

export function RetryStatusCard({
	outageId,
	theme,
	fallbackText,
}: RetryStatusCardProps): React.ReactElement | null {
	const outage = useRetryStore((s) => s.outages[outageId]);

	// Tick once a second to drive the live "elapsed" + "next attempt" readouts.
	const [now, setNow] = useState(() => Date.now());
	const isActive = outage?.status === 'active';
	useEffect(() => {
		if (!isActive) return;
		const id = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(id);
	}, [isActive]);

	// No live record (e.g. a resolved outage from a prior session after restart):
	// degrade gracefully to a dim one-line note instead of an empty row.
	if (!outage) {
		if (!fallbackText) return null;
		return (
			<div
				className="flex items-center gap-2 px-3 py-2 rounded-lg border text-sm select-none"
				style={{
					borderColor: theme.colors.border,
					backgroundColor: theme.colors.bgSidebar,
					color: theme.colors.textDim,
				}}
				role="status"
			>
				<AlertTriangle className="w-4 h-4 flex-shrink-0" style={{ color: theme.colors.textDim }} />
				<span>{fallbackText}</span>
			</div>
		);
	}

	const strategyLabel =
		outage.strategy === 'availability' ? 'Service overloaded' : 'Plan quota exhausted';
	// `attempts` is the 0-indexed count of the next resend, so it doubles as the
	// number of retries already dispatched. Guard the plural.
	const retryCount = outage.attempts;

	// -- Resolved states: freeze into a compact one-line summary. -----------------
	if (outage.status === 'recovered') {
		const totalMs = (outage.resolvedAt ?? outage.startedAt) - outage.startedAt;
		return (
			<div
				className="flex items-center gap-2 px-3 py-2 rounded-lg border text-sm select-none"
				style={{
					borderColor: theme.colors.success + '40',
					backgroundColor: theme.colors.success + '12',
					color: theme.colors.textMain,
				}}
				role="status"
			>
				<Check className="w-4 h-4 flex-shrink-0" style={{ color: theme.colors.success }} />
				<span>
					<span className="font-medium">Connection recovered.</span>{' '}
					<span style={{ color: theme.colors.textDim }}>
						{strategyLabel} cleared after {retryCount} {retryCount === 1 ? 'retry' : 'retries'}
						{totalMs > 0 ? ` over ${formatDurationHuman(totalMs)}` : ''}.
					</span>
				</span>
			</div>
		);
	}

	if (outage.status === 'stopped') {
		return (
			<div
				className="flex items-center gap-2 px-3 py-2 rounded-lg border text-sm select-none"
				style={{
					borderColor: theme.colors.border,
					backgroundColor: theme.colors.bgSidebar,
					color: theme.colors.textDim,
				}}
				role="status"
			>
				<X className="w-4 h-4 flex-shrink-0" style={{ color: theme.colors.textDim }} />
				<span>
					<span className="font-medium" style={{ color: theme.colors.textMain }}>
						Auto-retry stopped.
					</span>{' '}
					{strategyLabel} was not resolved after {retryCount}{' '}
					{retryCount === 1 ? 'retry' : 'retries'}.
				</span>
			</div>
		);
	}

	// -- Active outage: live status + controls. -----------------------------------
	const elapsedMs = Math.max(0, now - outage.startedAt);
	const remainingMs = outage.nextRetryAt - now;
	const isFiring = remainingMs <= 0;

	return (
		<div
			className="flex flex-col gap-3 px-3.5 py-3 rounded-lg border text-sm select-none"
			style={{
				borderColor: OUTAGE_COLOR + '55',
				backgroundColor: OUTAGE_COLOR + '10',
				color: theme.colors.textMain,
			}}
			role="status"
			aria-live="polite"
		>
			<div className="flex items-center gap-2">
				<span className="relative flex h-2.5 w-2.5 flex-shrink-0">
					<span
						className="absolute inline-flex h-full w-full rounded-full opacity-60 animate-ping"
						style={{ backgroundColor: OUTAGE_COLOR }}
					/>
					<span
						className="relative inline-flex h-2.5 w-2.5 rounded-full"
						style={{ backgroundColor: OUTAGE_COLOR }}
					/>
				</span>
				<AlertTriangle className="w-4 h-4 flex-shrink-0" style={{ color: OUTAGE_COLOR }} />
				<span className="font-medium" style={{ color: OUTAGE_COLOR }}>
					{strategyLabel}
				</span>
				<span className="text-xs" style={{ color: theme.colors.textDim }}>
					auto-retrying
				</span>
			</div>

			<div className="flex items-center gap-6 flex-wrap">
				<StatBlock label="Retries" value={String(retryCount)} color={theme.colors.textMain} />
				<StatBlock
					label="Failing for"
					value={formatDurationHuman(elapsedMs)}
					color={theme.colors.textMain}
				/>
				<StatBlock
					label="Next attempt"
					value={isFiring ? 'now…' : `in ${formatDurationHuman(remainingMs)}`}
					color={theme.colors.textMain}
				/>
			</div>

			<div className="flex items-center gap-2">
				<button
					type="button"
					onClick={() => retryNow(outage.sessionId, outage.tabId)}
					disabled={isFiring}
					className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-colors hover:opacity-80 disabled:opacity-50 disabled:cursor-not-allowed"
					style={{
						backgroundColor: OUTAGE_COLOR + '22',
						color: OUTAGE_COLOR,
						border: `1px solid ${OUTAGE_COLOR}40`,
					}}
					title="Skip the timer and retry immediately"
				>
					{isFiring ? <Zap className="w-3.5 h-3.5" /> : <RefreshCw className="w-3.5 h-3.5" />}
					Try now
				</button>
				<button
					type="button"
					onClick={() => cancelRetry(outage.sessionId, outage.tabId)}
					className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs transition-colors hover:bg-white/10"
					style={{ color: theme.colors.textDim }}
					title="Stop auto-retrying"
				>
					<X className="w-3.5 h-3.5" />
					Stop
				</button>
			</div>
		</div>
	);
}
