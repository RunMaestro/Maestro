/**
 * DashboardPanelState - the loading / error / empty frame every Usage Dashboard
 * panel draws around its content.
 *
 * Pair it with `useDashboardResource`: pass `loading` and `error` straight from
 * the hook, and `empty` when the fetched data has nothing to draw. Precedence:
 *
 * 1. `loading` (nothing to show yet): a pulsing placeholder line.
 * 2. `error` with nothing to show (`empty`): the error and a Retry button. A
 *    failure is never drawn as "no data".
 * 3. `error` beside data from an earlier fetch: the content, under a one-line
 *    "Could not refresh" strip, so stale numbers are labeled as stale.
 * 4. `empty`: the empty message.
 * 5. Otherwise: the content.
 */

import { memo, type ReactNode } from 'react';
import type { Theme } from '../../types';
import { ipcErrorMessage } from '../../../shared/serializeError';
import { transparentize } from '../../../shared/colorContrast';

export interface DashboardPanelStateProps {
	theme: Theme;
	/** No data yet and a fetch is pending (`useDashboardResource().loading`). */
	loading?: boolean;
	/** The last fetch failed (`useDashboardResource().error`). */
	error?: unknown;
	/** The data has nothing to draw (or there is no data at all). */
	empty?: boolean;
	/** Shown when `empty`. */
	emptyMessage?: string;
	/** A control drawn under the empty message (a Refresh when the emptiness may pass). */
	emptyAction?: ReactNode;
	/** Shown while loading. */
	loadingMessage?: string;
	/** Retry handler (`useDashboardResource().refresh`). Without it, no Retry button. */
	onRetry?: () => void;
	/** Minimum height of the placeholder states, so the layout does not jump. */
	minHeight?: number | string;
	/** Prefix for the state elements' test ids. */
	testId?: string;
	children?: ReactNode;
}

function RetryButton({ theme, onRetry }: { theme: Theme; onRetry: () => void }) {
	return (
		<button
			type="button"
			onClick={onRetry}
			className="px-3 py-1 rounded text-xs"
			style={{ backgroundColor: theme.colors.accent, color: theme.colors.accentForeground }}
		>
			Retry
		</button>
	);
}

export const DashboardPanelState = memo(function DashboardPanelState({
	theme,
	loading = false,
	error,
	empty = false,
	emptyMessage = 'No data for this range',
	emptyAction,
	loadingMessage = 'Loading...',
	onRetry,
	minHeight = 96,
	testId = 'dashboard-panel',
	children,
}: DashboardPanelStateProps) {
	const hasError = error !== undefined && error !== null && error !== '';
	const placeholderStyle = { minHeight, color: theme.colors.textDim };

	if (loading) {
		return (
			<div
				className="flex flex-col items-center justify-center gap-2 text-xs"
				style={placeholderStyle}
				role="status"
				aria-live="polite"
				data-testid={`${testId}-loading`}
			>
				<div
					className="h-2 w-1/2 rounded animate-pulse"
					style={{ backgroundColor: theme.colors.border }}
				/>
				<span>{loadingMessage}</span>
			</div>
		);
	}

	if (hasError) {
		const message = ipcErrorMessage(error, 'Could not load this panel');
		if (empty) {
			return (
				<div
					className="flex flex-col items-center justify-center gap-2 text-center text-xs"
					style={placeholderStyle}
					role="alert"
					data-testid={`${testId}-error`}
				>
					<span style={{ color: theme.colors.error }}>Could not load: {message}</span>
					{onRetry && <RetryButton theme={theme} onRetry={onRetry} />}
				</div>
			);
		}
		return (
			<>
				<div
					className="flex items-center justify-between gap-2 mb-2 px-2 py-1 rounded text-xs"
					style={{
						color: theme.colors.error,
						backgroundColor: transparentize(theme.colors.error, theme.colors.bgMain, 0.08),
					}}
					role="alert"
					data-testid={`${testId}-stale`}
				>
					<span>Could not refresh: {message}</span>
					{onRetry && <RetryButton theme={theme} onRetry={onRetry} />}
				</div>
				{children}
			</>
		);
	}

	if (empty) {
		return (
			<div
				className="flex flex-col items-center justify-center gap-2 text-center text-sm"
				style={placeholderStyle}
				data-testid={`${testId}-empty`}
			>
				<span>{emptyMessage}</span>
				{emptyAction}
			</div>
		);
	}

	return <>{children}</>;
});

export default DashboardPanelState;
