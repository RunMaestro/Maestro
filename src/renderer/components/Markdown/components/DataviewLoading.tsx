/**
 * DataviewLoading - what a `dataview` or `dataviewjs` block shows while it computes.
 *
 * Two states, one look, shared by `DataviewBlock` and `DataviewJsFrame`:
 * - First run (no result yet): `DataviewSkeleton`, ghost table rows that hold the block's space, with a
 *   "Calculating" pill pinned to the top right.
 * - Refresh (a result is on screen and the index re-runs it): the result stays, dimmed, under a
 *   "Recalculating" pill in the same corner (`DataviewRefreshing`, or `useDataviewRefreshIndicator()` where
 *   the content cannot be wrapped). The old result is never blanked. An inline value dims the same way
 *   without a pill (`DataviewInlineRefreshing`).
 *
 * The pills wait {@link DATAVIEW_LOADING_PILL_DELAY_MS} before appearing, so an answer that comes back at
 * once never flashes a spinner or a dim.
 */

import React, { useEffect, useState } from 'react';
import type { Theme } from '../../../types';
import { Spinner } from '../../ui/Spinner';
import { SkeletonBox } from '../../ui/SkeletonBox';

/** How long a block computes before its pill (and a refresh's dim) appears. */
export const DATAVIEW_LOADING_PILL_DELAY_MS = 300;

/** Opacity of a result on screen while a refresh recomputes it. */
export const DATAVIEW_REFRESH_DIM_OPACITY = 0.55;

/** Column widths of the ghost rows, so the skeleton reads as a table rather than a stack of bars. */
const SKELETON_ROWS = [
	['80%', '70%', '100%'],
	['65%', '70%', '85%'],
	['90%', '70%', '60%'],
] as const;

/**
 * True once `active` has held for `delayMs`; false the moment it stops. Not `useDebouncedValue`: that one
 * starts out equal to its input, so a skeleton that mounts already loading would show its pill at once.
 */
function useDelayedFlag(active: boolean, delayMs: number): boolean {
	const [elapsed, setElapsed] = useState(false);
	useEffect(() => {
		if (!active) {
			setElapsed(false);
			return;
		}
		const timer = setTimeout(() => setElapsed(true), delayMs);
		return () => clearTimeout(timer);
	}, [active, delayMs]);
	return active && elapsed;
}

/** Whether a refresh has run long enough to show: dim the result and draw the "Recalculating" pill. */
export function useDataviewRefreshIndicator(refreshing: boolean): boolean {
	return useDelayedFlag(refreshing, DATAVIEW_LOADING_PILL_DELAY_MS);
}

/** The spinner pill pinned to a block's top-right corner. Its parent must be positioned. */
export function DataviewCalculatingPill({ theme, label }: { theme: Theme; label: string }) {
	return (
		<span
			data-dataview-pill=""
			role="status"
			aria-live="polite"
			style={{
				position: 'absolute',
				top: 4,
				right: 4,
				zIndex: 1,
				display: 'inline-flex',
				alignItems: 'center',
				gap: 6,
				padding: '2px 10px',
				borderRadius: 999,
				border: `1px solid ${theme.colors.accent}`,
				background: theme.colors.bgMain,
				color: theme.colors.textMain,
				fontSize: 11,
				lineHeight: 1.6,
				whiteSpace: 'nowrap',
				boxShadow: '0 2px 10px rgba(0, 0, 0, 0.3)',
				pointerEvents: 'none',
			}}
		>
			<Spinner size={11} color={theme.colors.accent} decorative />
			<span className="dataview-ellipsis">{label}</span>
		</span>
	);
}

/** A block's first run: ghost table rows in the block's space, and the "Calculating" pill. */
export function DataviewSkeleton({ theme, ariaLabel }: { theme: Theme; ariaLabel: string }) {
	const showPill = useDelayedFlag(true, DATAVIEW_LOADING_PILL_DELAY_MS);
	const rowStyle: React.CSSProperties = {
		display: 'grid',
		gridTemplateColumns: '2fr 1fr 3fr',
		gap: 10,
		padding: '7px 8px',
		borderBottom: `1px solid ${theme.colors.border}`,
	};
	return (
		<div
			data-dataview-placeholder=""
			aria-busy="true"
			aria-label={ariaLabel}
			style={{ position: 'relative' }}
		>
			{showPill && <DataviewCalculatingPill theme={theme} label="Calculating" />}
			<div style={rowStyle}>
				{[0, 1, 2].map((column) => (
					<SkeletonBox key={column} theme={theme} style={{ height: 8, width: '60%' }} />
				))}
			</div>
			{SKELETON_ROWS.map((widths, row) => (
				<div key={row} style={rowStyle}>
					{widths.map((width, column) => (
						<SkeletonBox key={column} theme={theme} style={{ height: 10, width }} />
					))}
				</div>
			))}
		</div>
	);
}

/**
 * An inline `= expr` / `$= expr` value that stays in place, dimmed, while a refresh recomputes it. No pill: a
 * floating chip inside a sentence would cover the words around it.
 */
export function DataviewInlineRefreshing({
	refreshing,
	children,
}: {
	refreshing: boolean;
	children: React.ReactNode;
}) {
	const show = useDataviewRefreshIndicator(refreshing);
	return (
		<span
			data-dataview-refreshing={show ? '' : undefined}
			aria-busy={show || undefined}
			style={{
				opacity: show ? DATAVIEW_REFRESH_DIM_OPACITY : 1,
				transition: 'opacity 150ms ease',
			}}
		>
			{children}
		</span>
	);
}

/** A result that stays on screen, dimmed under a "Recalculating" pill, while a refresh recomputes it. */
export function DataviewRefreshing({
	theme,
	refreshing,
	children,
}: {
	theme: Theme;
	refreshing: boolean;
	children: React.ReactNode;
}) {
	const show = useDataviewRefreshIndicator(refreshing);
	return (
		<div
			data-dataview-refreshing={show ? '' : undefined}
			aria-busy={show || undefined}
			style={{ position: 'relative' }}
		>
			{show && <DataviewCalculatingPill theme={theme} label="Recalculating" />}
			<div
				style={{
					opacity: show ? DATAVIEW_REFRESH_DIM_OPACITY : 1,
					transition: 'opacity 150ms ease',
				}}
			>
				{children}
			</div>
		</div>
	);
}
