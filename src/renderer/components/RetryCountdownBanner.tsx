/**
 * RetryCountdownBanner - live countdown for an in-progress Agent Resilience
 * auto-retry. Renders directly above the input area for the active AI tab
 * whenever `retryStore` holds a pending retry for it, showing when the next
 * resend fires plus Cancel / Retry Now controls. Renders nothing when there is
 * no active retry for the tab.
 */

import React, { useEffect, useState } from 'react';
import { RefreshCw, X, Zap } from 'lucide-react';

import { useRetryStore, cancelRetry, retryNow } from '../stores/retryStore';
import type { Theme } from '../types';

interface RetryCountdownBannerProps {
	sessionId: string;
	tabId: string | null | undefined;
	theme: Theme;
}

/** "1h 4m" / "3m 20s" / "12s" remaining. */
function formatRemaining(ms: number): string {
	const totalSec = Math.max(0, Math.ceil(ms / 1000));
	const h = Math.floor(totalSec / 3600);
	const m = Math.floor((totalSec % 3600) / 60);
	const s = totalSec % 60;
	if (h > 0) return `${h}h ${m}m`;
	if (m > 0) return `${m}m ${s}s`;
	return `${s}s`;
}

export function RetryCountdownBanner({
	sessionId,
	tabId,
	theme,
}: RetryCountdownBannerProps): React.ReactElement | null {
	const key = tabId ? `${sessionId}:${tabId}` : '';
	const entry = useRetryStore((s) => (key ? s.retries[key] : undefined));

	// Tick once a second to drive the live countdown.
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!entry) return;
		const id = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(id);
	}, [entry]);

	if (!entry || !tabId) return null;

	const remainingMs = entry.nextRetryAt - now;
	const isFiring = entry.status === 'in-flight' || remainingMs <= 0;
	const label = entry.strategy === 'availability' ? 'Service overloaded' : 'Plan quota exhausted';

	return (
		<div
			className="flex items-center gap-3 px-3 py-2 mb-2 rounded-lg border text-sm select-none"
			style={{
				borderColor: theme.colors.border,
				backgroundColor: theme.colors.bgSidebar,
				color: theme.colors.textMain,
			}}
			role="status"
		>
			<Zap className="w-4 h-4 flex-shrink-0" style={{ color: theme.colors.warning }} />
			<div className="min-w-0 flex-1">
				<span className="font-medium">{label}.</span>{' '}
				<span style={{ color: theme.colors.textDim }}>
					{isFiring
						? 'Retrying now…'
						: `Auto-retrying in ${formatRemaining(remainingMs)}${
								entry.attempt > 0 ? ` (attempt ${entry.attempt + 1})` : ''
							}`}
				</span>
			</div>
			<button
				type="button"
				onClick={() => retryNow(sessionId, tabId)}
				disabled={isFiring}
				className="flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors hover:bg-white/10 disabled:opacity-50 disabled:cursor-not-allowed"
				style={{ color: theme.colors.accent }}
				title="Retry now"
			>
				<RefreshCw className="w-3.5 h-3.5" />
				Retry now
			</button>
			<button
				type="button"
				onClick={() => cancelRetry(sessionId, tabId)}
				className="flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors hover:bg-white/10"
				style={{ color: theme.colors.textDim }}
				title="Cancel auto-retry"
			>
				<X className="w-3.5 h-3.5" />
				Cancel
			</button>
		</div>
	);
}
