/**
 * Shared input-widget library: type definitions.
 *
 * This is the foundation for the upcoming dynamic-interface feature, where an
 * agent (or a playbook) can request structured input from the user by composing
 * themed controls - sliders, date-range pickers, ranked-choice lists, and the
 * like. Like the output family, every input widget is theme-aware and
 * presentational-only (no IPC, no store reads, no Encore gate): it renders the
 * `value` it is handed and reports edits back through `onChange`. The owning
 * surface holds the state, so the same control can drive a modal, a wizard step,
 * or a future dynamic HTML form without dragging along app wiring.
 *
 * These starter shapes are intentionally small; the family grows as the
 * dynamic-interface work lands. See `../index.ts` for the public surface.
 */

import type { Theme } from '../../../types';

/**
 * Base props shared by every controlled input widget.
 *
 * `theme` keeps the control theme-aware via `theme.colors.*`. `value`/`onChange`
 * make it a controlled component: the parent owns the state and re-renders with
 * the next value. `label` and `disabled` round out the accessible, form-like
 * contract every input control honors.
 *
 * @typeParam T - The value shape this control reads and emits.
 */
export interface InputWidgetProps<T> {
	theme: Theme;
	/** Current value (controlled). */
	value: T;
	/** Called with the next value whenever the user edits the control. */
	onChange: (next: T) => void;
	/** When true, the control is non-interactive and visually muted. */
	disabled?: boolean;
	/** Accessible label rendered with (and wired to) the control. */
	label?: string;
}

/** Value for a single-thumb numeric slider. */
export type SliderValue = number;

/**
 * Value for a date-range picker. Dates are ISO `YYYY-MM-DD` strings (or `null`
 * when an endpoint is unset) so the shape stays serializable across the IPC
 * bridge and the future dynamic-interface payloads.
 */
export interface DateRangeValue {
	start: string | null;
	end: string | null;
}

/**
 * Value for a ranked-choice / reorderable list. Holds only the ordered ids; the
 * control is handed the id→label mapping separately, so the emitted value stays
 * a compact, serializable ordering the caller can persist or send back.
 */
export interface RankedChoiceValue {
	orderedIds: string[];
}
