/**
 * Shared building blocks for the Usage Dashboard's detail modals.
 *
 * `AgentDetailModal` and `GroupDetailModal` present the same shapes - a headline
 * KPI, a label/value pair in a meta row, a section heading - so those live here
 * once instead of being copied per modal. Purely presentational; callers own
 * their own data shaping and formatting.
 */

import { memo } from 'react';
import type { Theme } from '../../types';

export interface KpiProps {
	label: string;
	value: string;
	theme: Theme;
	/** Tighter padding and smaller type, for a dense secondary row. */
	compact?: boolean;
	/** Native tooltip - use it to qualify a value the number alone overstates
	 *  (e.g. a cost that only covers part of the recorded queries). */
	title?: string;
	testId?: string;
	/** Render the value dim, for values that are absent rather than zero. */
	muted?: boolean;
}

export const Kpi = memo(function Kpi({
	label,
	value,
	theme,
	compact = false,
	title,
	testId,
	muted = false,
}: KpiProps) {
	return (
		<div
			className="rounded-md border"
			style={{
				borderColor: theme.colors.border,
				backgroundColor: theme.colors.bgMain,
				padding: compact ? '8px 10px' : '12px',
			}}
			title={title}
			data-testid={testId}
		>
			<div
				className="text-2xs uppercase tracking-wide mb-1"
				style={{ color: theme.colors.textDim }}
			>
				{label}
			</div>
			<div
				className={compact ? 'text-base font-semibold' : 'text-lg font-bold'}
				style={{ color: muted ? theme.colors.textDim : theme.colors.textMain }}
			>
				{value}
			</div>
		</div>
	);
});

export interface MetaFieldProps {
	label: string;
	value: string;
	theme: Theme;
	mono?: boolean;
}

export const MetaField = memo(function MetaField({ label, value, theme, mono }: MetaFieldProps) {
	return (
		<span className="inline-flex items-baseline gap-1">
			<span style={{ color: theme.colors.textDim }}>{label}:</span>
			<span
				className={mono ? 'font-mono' : ''}
				style={{ color: theme.colors.textMain }}
				title={value}
			>
				{value}
			</span>
		</span>
	);
});

export interface SectionHeadingProps {
	theme: Theme;
	children: React.ReactNode;
}

export const SectionHeading = memo(function SectionHeading({
	theme,
	children,
}: SectionHeadingProps) {
	return (
		<h3
			className="text-xs font-semibold uppercase tracking-wide mb-2"
			style={{ color: theme.colors.textDim }}
		>
			{children}
		</h3>
	);
});
