/**
 * Shared output-widget library: type definitions.
 *
 * This library is theme-aware, presentational-only (no IPC calls, no store
 * reads), and independent of any Encore feature flag. Every widget receives
 * the data it renders through props and draws it deterministically, so the
 * same widget can be dropped into any surface (Director's Notes, dashboards,
 * future enriched input/output components) without dragging along a feature
 * gate. These shared prop shapes keep the widgets composable. See `./index.ts`
 * for the public surface.
 */

import type { LucideIcon } from 'lucide-react';
import type { Theme } from '../../types';

/**
 * Base props shared by every widget. `theme` is always required so widgets
 * stay theme-aware via `theme.colors.*` without reaching into any store.
 */
export interface WidgetProps {
	theme: Theme;
}

/** Data for a single headline metric card. */
export interface StatCardDatum {
	/** Short metric label, e.g. "Total Entries". */
	label: string;
	/** Numeric value; rendered with `formatNumber` unless `displayValue` is set. */
	value: number;
	/** Optional pre-formatted value (e.g. a duration string). Wins over `value` for display. */
	displayValue?: string;
	/** Optional sequential trend values (oldest -> newest) for an inline sparkline. */
	trend?: number[];
	/** Optional accent color for the icon + sparkline. Defaults to the theme accent. */
	color?: string;
	/** Optional lucide icon component rendered beside the label. */
	icon?: LucideIcon;
	/** Optional secondary caption under the value, e.g. "60% AUTO". */
	caption?: string;
}

/** A single labeled bar value for horizontal bar charts. */
export interface BarDatum {
	label: string;
	value: number;
	color?: string;
}

/** One activity time-slice split by entry source. */
export interface TimelineBucket {
	auto: number;
	user: number;
	cue: number;
}

/** One slice of a donut breakdown. */
export interface DonutSlice {
	label: string;
	value: number;
	color: string;
}
