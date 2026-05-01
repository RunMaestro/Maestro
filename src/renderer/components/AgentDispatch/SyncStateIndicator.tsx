/**
 * SyncStateIndicator — small chip showing the remote sync state of a work item.
 *
 * Accepts the full TrackerSyncState union from tracker-backend-types (six states)
 * so it can be driven by both the per-item WorkItem column and any higher-level
 * sync metadata surfaces.
 */

import React, { useCallback } from 'react';
import { AlertTriangle, CheckCircle2, Clock, Loader2, WifiOff, XCircle } from 'lucide-react';
import type { TrackerSyncState } from '../../../shared/tracker-backend-types';
import type { Theme } from '../../types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SyncStateIndicatorProps {
	state: TrackerSyncState;
	/** URL to the external issue/ticket; if provided, clicking a "synced" chip opens it. */
	externalUrl?: string;
	/** Last error message; shown in tooltip when state === 'error'. */
	lastError?: string;
	theme: Theme;
}

// ---------------------------------------------------------------------------
// State metadata
// ---------------------------------------------------------------------------

interface StateConfig {
	label: string;
	tooltip: string;
	/** Returns CSS color value given the theme. */
	color: (theme: Theme) => string;
	icon: React.ReactElement;
}

const STATE_CONFIG: Record<TrackerSyncState, StateConfig> = {
	unsynced: {
		label: 'local',
		tooltip: 'Local only',
		color: (t) => t.colors.textDim,
		icon: <WifiOff className="w-2.5 h-2.5" aria-hidden="true" />,
	},
	syncing: {
		label: 'syncing',
		tooltip: 'Syncing…',
		color: (t) => t.colors.accent,
		icon: <Loader2 className="w-2.5 h-2.5 animate-spin" aria-hidden="true" />,
	},
	synced: {
		label: 'synced',
		tooltip: 'Synced',
		color: (t) => t.colors.success,
		icon: <CheckCircle2 className="w-2.5 h-2.5" aria-hidden="true" />,
	},
	conflict: {
		label: 'conflict',
		tooltip: 'Conflict — needs resolution',
		color: (t) => t.colors.warning,
		icon: <AlertTriangle className="w-2.5 h-2.5" aria-hidden="true" />,
	},
	error: {
		label: 'error',
		tooltip: 'Sync error',
		color: (t) => t.colors.error,
		icon: <XCircle className="w-2.5 h-2.5" aria-hidden="true" />,
	},
	'rate-limited': {
		label: 'rate-limited',
		tooltip: 'Rate limited, will retry',
		color: (t) => t.colors.warning,
		icon: <Clock className="w-2.5 h-2.5" aria-hidden="true" />,
	},
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const SyncStateIndicator = React.memo(function SyncStateIndicator({
	state,
	externalUrl,
	lastError,
	theme,
}: SyncStateIndicatorProps) {
	const config = STATE_CONFIG[state];
	const color = config.color(theme);

	// Build tooltip: for 'error' append the last error message if available.
	const tooltip =
		state === 'error' && lastError ? `${config.tooltip}: ${lastError}` : config.tooltip;

	const handleClick = useCallback(
		(e: React.MouseEvent | React.KeyboardEvent) => {
			if (state === 'synced' && externalUrl) {
				e.stopPropagation(); // don't also fire card's onSelect
				window.open(externalUrl, '_blank', 'noopener,noreferrer');
			}
		},
		[state, externalUrl]
	);

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				handleClick(e);
			}
		},
		[handleClick]
	);

	const isClickable = state === 'synced' && Boolean(externalUrl);

	return (
		<span
			role={isClickable ? 'link' : undefined}
			tabIndex={0}
			aria-label={tooltip}
			title={tooltip}
			data-testid={`sync-state-indicator-${state}`}
			onClick={handleClick}
			onKeyDown={handleKeyDown}
			className="inline-flex items-center gap-1 text-[10px] font-medium rounded px-1.5 py-0.5 outline-none focus-visible:ring-1 shrink-0"
			style={{
				backgroundColor: `${color}20`,
				color,
				cursor: isClickable ? 'pointer' : 'default',
				// @ts-expect-error -- CSS custom property for focus ring
				'--tw-ring-color': color,
			}}
		>
			{config.icon}
			<span>{config.label}</span>
		</span>
	);
});
