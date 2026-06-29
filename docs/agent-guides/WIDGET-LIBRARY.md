<!-- Created 2026-06-28 with the shared widget library (Director's Notes Rich Mode, Phase 05) -->

# Widget Library

The shared, theme-aware widget library at `src/renderer/components/widgets/`. Reuse these before hand-rolling stat cards, bar charts, donuts, sparklines, activity timelines, or controlled input controls. Duplicated UI is this codebase's stated #1 maintenance burden; this library exists so the next surface composes widgets instead of reinventing them.

---

## Three rules every widget honors

1. **Theme-aware.** Every widget takes a `theme` prop and derives all colors from `theme.colors.*`. No hardcoded hex, no named Tailwind color utilities (e.g. no `accent-indigo-500`). A widget must read acceptably under any theme, light or dark. The one deliberate exception is `CUE_COLOR` (the cross-app "Cue" brand color from the unified-history language), which is prop-overridable.
2. **Presentational-only.** No IPC calls, no store reads, no `useSettings`. Every widget receives the data it renders through props and draws it deterministically. The owning surface fetches/derives the data and holds any state.
3. **Encore-flag-independent.** The library never imports from `UsageDashboard/` and never gates on the `usageDashboard` (or any other) Encore feature. It renders anywhere - Director's Notes, dashboards, the future dynamic interface - regardless of which Encore features are enabled. Shared chart math that used to live in the Usage Dashboard (e.g. tooltip viewport clamping) was extracted into the library precisely to keep this rule (`output/tooltipGeometry.ts`).

Because of these rules, the same widget drops into any surface without dragging along a feature gate or app wiring.

---

## Import from the barrel

Always import from the public barrel (`components/widgets`), never from the `output/` or `input/` subfolders directly:

```tsx
import { StatCardGrid, ActivityTimeline, ChartErrorBoundary, Slider } from '../widgets';
import type { StatCardDatum, BarDatum, TimelineBucket } from '../widgets';
```

The library splits into two families:

- **Output (production-grade):** presentational widgets that render data. These power live surfaces today (Director's Notes Rich Mode).
- **Input (foundation):** the seed of the controlled input-control family for the upcoming dynamic-interface feature. Small but real; grows as that work lands.

---

## Output family

| Widget                 | Use for                                                                    |
| ---------------------- | -------------------------------------------------------------------------- |
| `StatCard`             | One headline metric: large value, label, optional inline sparkline + icon  |
| `StatCardGrid`         | Responsive auto-fit grid of `StatCard`s from a `StatCardDatum[]`           |
| `SectionCard`          | Titled content card (icon + accent + action slot) framing a block          |
| `ActivityTimeline`     | Compact stacked AUTO/USER/CUE bar timeline from `TimelineBucket[]`         |
| `TypeBreakdown`        | Donut breakdown of `DonutSlice[]` with a center total + legend percentages |
| `AgentActivityBars`    | Horizontal bars from `BarDatum[]`: sorted descending, top-N + overflow row |
| `SuccessFailureWidget` | Single success-vs-failure split bar with counts and percentage             |
| `Sparkline`            | Standalone inline SVG trend line (also embedded by `StatCard`)             |
| `ChartTooltip`         | Portaled, cursor-anchored, viewport-clamped tooltip for any chart          |
| `ChartErrorBoundary`   | Catches a throwing chart child and shows a themed retry UI                 |

### Output widget props

Every output widget extends `WidgetProps` (`{ theme: Theme }`) unless noted.

**`StatCard`** - props are `WidgetProps & StatCardDatum`:

- `label: string` - short uppercase metric label.
- `value: number` - rendered with `formatNumber` unless `displayValue` is set.
- `displayValue?: string` - pre-formatted value (e.g. a duration); wins over `value`.
- `trend?: number[]` - sequential values (oldest to newest) for an inline `Sparkline`.
- `color?: string` - accent for the icon + sparkline; defaults to the theme accent.
- `icon?: LucideIcon` - optional icon beside the label.
- `caption?: string` - optional secondary caption under the value.

**`StatCardGrid`**:

- `cards: StatCardDatum[]` - each keyed by its `label`.
- `minColumnWidth?: number` - min column width in px before the grid wraps (default 160).

**`SectionCard`**:

- `title: string`, `children: ReactNode` (the card body).
- `icon?: LucideIcon`, `accent?: string` (icon accent; defaults to theme accent).
- `action?: ReactNode` - right-aligned content in the title row (e.g. a count badge).
- `className?: string` - extra classes for the outer card.

**`ActivityTimeline`**:

- `buckets: TimelineBucket[]` - ordered time slices (oldest to newest).
- `colors?: { auto; user; cue }` - segment colors; defaults to the unified-history language.
- `height?: number` (bar area px, default 96), `showLegend?: boolean` (default true).

**`TypeBreakdown`**:

- `slices: DonutSlice[]` - zero-value slices stay in the legend but draw no arc.
- `size?: number` (outer diameter px, default 132), `thickness?: number` (ring px, default 18).

**`AgentActivityBars`**:

- `data: BarDatum[]` - unsorted is fine; sorted descending internally.
- `topN?: number` - max rows before collapsing the remainder into an overflow row (default 8).
- `emptyLabel?: string` - empty-state message.

**`SuccessFailureWidget`**:

- `successCount: number`, `failureCount: number`.
- `colors?: { success; failure }` - defaults to the theme success/error language.
- `emptyLabel?: string` - shown when there are no recorded outcomes.

**`Sparkline`** (standalone; does NOT extend `WidgetProps` - takes an explicit `color`):

- `data: number[]` - sequential values (oldest to newest). Empty or all-zero data renders a flat collapsed baseline rather than crashing.
- `color: string` (required), `width?` (80), `height?` (24), `fillOpacity?` (0.15), `showEndDot?` (true), `strokeWidth?` (1.5).

**`ChartTooltip`** (portaled primitive):

- `anchor: { x; y } | null` - viewport coords, typically the cursor; `null` hides it.
- `theme: Theme`, `children: ReactNode`.
- `width?`, `height?` - size hints for viewport clamping.
- `offset?` - px above the cursor; `testId?` - forwarded to the rendered element.

**`ChartErrorBoundary`** (class component):

- `children: ReactNode`, `theme: Theme`.
- `chartName?: string` - used in the error message ("Failed to render {chartName}") and in logger/Sentry context.
- `onRetry?: () => void` - called when the user clicks Retry. The boundary also resets its own error state on retry. Wrap each chart so one throwing widget cannot blank the whole surface.

### Shared output prop types (`widgets/types.ts`)

- `WidgetProps` - `{ theme: Theme }`, the base every widget extends.
- `StatCardDatum` - one headline metric (see `StatCard` props above).
- `BarDatum` - `{ label: string; value: number; color?: string }`.
- `TimelineBucket` - `{ auto: number; user: number; cue: number }`.
- `DonutSlice` - `{ label: string; value: number; color: string }`.

`clampTooltipToViewport` (from `output/tooltipGeometry.ts`) is also exported for callers building bespoke tooltips - it returns viewport-clamped top-left coordinates you can drop straight into `style.left` / `style.top`.

### Color language

Output widgets follow the unified-history color language so charts read consistently across the app:

- AUTO = `theme.colors.warning`
- USER = `theme.colors.accent`
- CUE = `CUE_COLOR` (the cross-app Cue brand color from `shared/cue-pipeline-types`)
- success = `theme.colors.success`, failure = `theme.colors.error`

Every color is prop-overridable (pass a `colors` override) so a colorblind palette can swap them while keeping Cue consistent.

---

## Input family

The foundation for the upcoming dynamic-interface feature, where an agent (or a playbook) can request structured input from the user by composing themed controls.

### The input-family contract

Every input widget extends `InputWidgetProps<T>` (`input/types.ts`) and is a **controlled component**:

```ts
interface InputWidgetProps<T> {
	theme: Theme; // theme-aware via theme.colors.*
	value: T; // current value (controlled)
	onChange: (next: T) => void; // emits the next value on edit
	disabled?: boolean; // non-interactive + visually muted
	label?: string; // accessible label, wired to the control
}
```

The parent owns the state and re-renders with the next value; the control never holds app state. Like the output family, input widgets are theme-aware, presentational-only (no IPC, no store reads), and Encore-flag-independent. Value shapes are kept serializable (ISO date strings, ordered id arrays) so they survive the IPC bridge and future dynamic-interface payloads.

### Starter primitives

| Widget         | Value type             | Props beyond `InputWidgetProps`                       |
| -------------- | ---------------------- | ----------------------------------------------------- |
| `Slider`       | `SliderValue` (number) | `min?` (0), `max?` (100), `step?` (1), `formatValue?` |
| `RankedChoice` | `RankedChoiceValue`    | `items: RankedChoiceItem[]` (the id->label source)    |

Value types (`input/types.ts`):

- `SliderValue` = `number`.
- `DateRangeValue` = `{ start: string \| null; end: string \| null }` (ISO `YYYY-MM-DD`). Shape defined for the date-range control that lands with the dynamic-interface work.
- `RankedChoiceValue` = `{ orderedIds: string[] }` - a compact, serializable ordering. `RankedChoice` is handed the `id->label` mapping separately via `items` and emits only the order.

These shapes are intentionally small; the family grows as the dynamic-interface work lands.

---

## Widget Gallery (dev preview)

There is no npm/CLI command for the gallery - it is reached in-app via the command palette (Quick Actions, Cmd+K):

**`Debug: Widget Gallery`** - opens `WidgetGallery.tsx`, which renders every output widget and the starter input widgets with representative mock data under the active theme.

The gallery is a self-subscribing modal (it subscribes to the `widgetGallery` modal in the modal store and is mounted once globally in `AppStandaloneModals.tsx`). It is a developer/preview surface, NOT a user-facing feature, and it imports only the public `components/widgets` barrel plus app modal infrastructure - never the Usage Dashboard - so it doubles as a living proof that the library is Encore-flag-independent. Use it to eyeball a widget under every theme (including light themes and colorblind palettes) and to exercise the `ChartErrorBoundary` retry UI via the "Simulate error" toggle.

---

## Where it is used

First consumer: **Director's Notes Rich Mode** (`src/renderer/components/DirectorNotes/RichOverview.tsx`), which composes the widgets from deterministic IPC data (`getGraphData` / `getUnifiedHistory`) and wraps each chart in `ChartErrorBoundary`. The widgets themselves stay presentational; RichOverview owns the fetching and shaping.

---

## Adding a new widget

1. Decide output vs input. Add the file under `output/` or `input/`.
2. Extend `WidgetProps` (output) or `InputWidgetProps<T>` (input). Derive every color from `theme.colors.*`. Take all data via props.
3. Keep it presentational and Encore-flag-independent - no IPC, no store reads, no import from `UsageDashboard/`, no feature gate.
4. `memo` the component (every widget here is memoized) and reuse existing primitives (`Sparkline`, `formatNumber`, `ChartTooltip`) rather than re-deriving SVG paths or number formatting.
5. Export it (and any new prop type) from `index.ts`.
6. Add it to `WidgetGallery.tsx` with representative mock data.
7. Add a row to the tables above and to the "Output Widget Library" section in [UI-PATTERNS.md](UI-PATTERNS.md).
8. Cover it with a component test in `src/__tests__/renderer/components/widgets/` (render, empty/zero data, and a theme-sentinel color assertion so a baked-in hex regresses loudly). See [TEST-PATTERNS.md](TEST-PATTERNS.md).

---

## Related guides

- [UI-PATTERNS.md](UI-PATTERNS.md) - theme system, modal system, focus patterns, text-selection rules, and the short "Output Widget Library" pointer.
- [TEST-PATTERNS.md](TEST-PATTERNS.md) - shared theme mock (`createMockTheme`) and render helpers used by the widget tests.
- [STATS-ANALYTICS.md](STATS-ANALYTICS.md) - the Usage Dashboard, which has its own (older) chart components; the shared library was factored to be independent of it.
