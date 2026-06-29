/**
 * Shared widget library: public barrel.
 *
 * This library is theme-aware, presentational-only (no IPC calls, no store
 * reads), and independent of any Encore feature flag - in particular it never
 * imports from `UsageDashboard/` or gates on the `usageDashboard` feature, so it
 * renders anywhere (Director's Notes, dashboards, the future dynamic interface)
 * regardless of which Encore features are enabled. Import widgets from here
 * (`components/widgets`) rather than reaching into the `output/`/`input/`
 * subfolders directly. Every widget takes its data via props and renders
 * deterministically.
 *
 * Two families:
 * - **output** (production-grade): presentational widgets that render data -
 *   stat cards, charts, sparklines, breakdowns, plus the shared `ChartTooltip`
 *   and `ChartErrorBoundary` primitives. These power live surfaces today.
 * - **input** (foundation): the seed of the controlled input-control family
 *   (sliders, ranked-choice, date ranges) for the upcoming dynamic-interface
 *   feature. Small but real; grows as that work lands.
 */

// ============================================================================
// Output family (production-grade)
// ============================================================================

export type { WidgetProps, StatCardDatum, BarDatum, TimelineBucket, DonutSlice } from './types';

export { StatCard } from './output/StatCard';
export { StatCardGrid } from './output/StatCardGrid';
export { SectionCard } from './output/SectionCard';
export { ActivityTimeline } from './output/ActivityTimeline';
export { TypeBreakdown } from './output/TypeBreakdown';
export { AgentActivityBars } from './output/AgentActivityBars';
export { SuccessFailureWidget } from './output/SuccessFailureWidget';
export { Sparkline } from './output/Sparkline';
export { ChartTooltip } from './output/ChartTooltip';
export { ChartErrorBoundary } from './output/ChartErrorBoundary';
export { clampTooltipToViewport } from './output/tooltipGeometry';

// ============================================================================
// Input family (foundation for the dynamic-interface feature)
// ============================================================================

export type {
	InputWidgetProps,
	SliderValue,
	DateRangeValue,
	RankedChoiceValue,
} from './input/types';

export { Slider } from './input/Slider';
export { RankedChoice, type RankedChoiceItem } from './input/RankedChoice';
