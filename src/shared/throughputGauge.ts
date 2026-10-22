/**
 * Throughput Gauge settings - the one persisted object that configures the gauge.
 *
 * Three surfaces edit it: the gear popover on the gauge, the plugin's settings
 * body in the Encore tile, and `maestro-cli`. All of them read the option lists
 * and labels below, so a label is spelled once.
 *
 * Every field is validated on its own. A bad stored `style` falls back to its
 * default and leaves a good `scope` alone.
 */

import { formatNumber } from './formatters';
import {
	DEFAULT_THROUGHPUT_WINDOW_MS,
	THROUGHPUT_WINDOWS_MS,
	type ThroughputMetric,
	type ThroughputWindowMs,
} from './throughputRate';

/** Settings key holding {@link ThroughputGaugeSettings}. */
export const THROUGHPUT_GAUGE_SETTINGS_KEY = 'throughputGaugeSettings' as const;

/** One choice in a settings control: the stored value and the word the user sees. */
export interface ThroughputGaugeOption<T> {
	value: T;
	label: string;
}

/** Whose output the gauge counts. */
export const THROUGHPUT_SCOPES = [
	{ value: 'all', label: 'All agents' },
	{ value: 'active', label: 'Active agent' },
] as const satisfies ReadonlyArray<ThroughputGaugeOption<string>>;

export type ThroughputScope = (typeof THROUGHPUT_SCOPES)[number]['value'];

/** Which reading the gauge shows. */
export const THROUGHPUT_METRICS = [
	{ value: 'combined', label: 'Combined' },
	{ value: 'in', label: 'In' },
	{ value: 'out', label: 'Out' },
] as const satisfies ReadonlyArray<ThroughputGaugeOption<ThroughputMetric>>;

/** One gauge for the chosen metric, or all three side by side. */
export const THROUGHPUT_LAYOUTS = [
	{ value: 'single', label: 'One' },
	{ value: 'all', label: 'All three' },
] as const satisfies ReadonlyArray<ThroughputGaugeOption<string>>;

export type ThroughputLayout = (typeof THROUGHPUT_LAYOUTS)[number]['value'];

/** How a reading is drawn. */
export const THROUGHPUT_STYLES = [
	{ value: 'dial', label: 'Dial' },
	{ value: 'vu', label: 'VU' },
	{ value: 'lcd', label: 'LCD' },
	{ value: 'sparkline', label: 'Sparkline' },
] as const satisfies ReadonlyArray<ThroughputGaugeOption<string>>;

export type ThroughputStyle = (typeof THROUGHPUT_STYLES)[number]['value'];

/** The unit every surface prints beside a reading: each gauge style and the CLI. */
export const GAUGE_UNIT = 'tok/s';

/** A rate as the gauges print it: rounded, compact above a thousand (`1.2K`). */
export function formatGaugeRate(rate: number): string {
	return formatNumber(Math.max(0, Math.round(Number.isFinite(rate) ? rate : 0)));
}

/** Short label for a rolling-average window: `10000` -> `10s`. */
export function throughputWindowLabel(windowMs: number): string {
	return `${windowMs / 1000}s`;
}

/** The rolling-average windows, labeled. */
export const THROUGHPUT_WINDOW_OPTIONS: ReadonlyArray<ThroughputGaugeOption<ThroughputWindowMs>> =
	THROUGHPUT_WINDOWS_MS.map((value) => ({ value, label: throughputWindowLabel(value) }));

export interface ThroughputGaugeSettings {
	scope: ThroughputScope;
	metric: ThroughputMetric;
	layout: ThroughputLayout;
	style: ThroughputStyle;
	/** Rolling-average window, one of `THROUGHPUT_WINDOWS_MS`. */
	windowMs: ThroughputWindowMs;
}

export const DEFAULT_THROUGHPUT_GAUGE_SETTINGS: Readonly<ThroughputGaugeSettings> = {
	scope: 'all',
	metric: 'combined',
	layout: 'single',
	style: 'dial',
	windowMs: DEFAULT_THROUGHPUT_WINDOW_MS,
};

/** One setting as every surface shows it: the field, its name, and its choices. */
export type ThroughputGaugeSettingControl = {
	[K in keyof ThroughputGaugeSettings]: {
		field: K;
		label: string;
		options: ReadonlyArray<ThroughputGaugeOption<ThroughputGaugeSettings[K]>>;
	};
}[keyof ThroughputGaugeSettings];

/** The five settings, in the order the popover, the Encore tile, and the CLI list them. */
export const THROUGHPUT_GAUGE_SETTING_CONTROLS: ReadonlyArray<ThroughputGaugeSettingControl> = [
	{ field: 'scope', label: 'Scope', options: THROUGHPUT_SCOPES },
	{ field: 'metric', label: 'Metric', options: THROUGHPUT_METRICS },
	{ field: 'layout', label: 'Layout', options: THROUGHPUT_LAYOUTS },
	{ field: 'style', label: 'Style', options: THROUGHPUT_STYLES },
	{ field: 'windowMs', label: 'Window', options: THROUGHPUT_WINDOW_OPTIONS },
];

/** Allowed values per field, in display order. The one table both validators read. */
const FIELD_VALUES: { readonly [K in keyof ThroughputGaugeSettings]: ReadonlyArray<unknown> } = {
	scope: THROUGHPUT_SCOPES.map((o) => o.value),
	metric: THROUGHPUT_METRICS.map((o) => o.value),
	layout: THROUGHPUT_LAYOUTS.map((o) => o.value),
	style: THROUGHPUT_STYLES.map((o) => o.value),
	windowMs: THROUGHPUT_WINDOWS_MS,
};

/** The settings fields, in the order the surfaces show them. */
export const THROUGHPUT_GAUGE_SETTING_FIELDS = Object.keys(FIELD_VALUES) as ReadonlyArray<
	keyof ThroughputGaugeSettings
>;

function isAllowed<K extends keyof ThroughputGaugeSettings>(
	field: K,
	value: unknown
): value is ThroughputGaugeSettings[K] {
	return FIELD_VALUES[field].includes(value);
}

function asRecord(raw: unknown): Record<string, unknown> {
	return raw && typeof raw === 'object' && !Array.isArray(raw)
		? (raw as Record<string, unknown>)
		: {};
}

/**
 * Merge a persisted settings object onto the defaults. Each field keeps its
 * stored value only when that value is allowed, so garbage in one field never
 * resets another.
 */
export function resolveThroughputGaugeSettings(raw: unknown): ThroughputGaugeSettings {
	const stored = asRecord(raw);
	const pick = <K extends keyof ThroughputGaugeSettings>(field: K): ThroughputGaugeSettings[K] =>
		isAllowed(field, stored[field]) ? stored[field] : DEFAULT_THROUGHPUT_GAUGE_SETTINGS[field];
	return {
		scope: pick('scope'),
		metric: pick('metric'),
		layout: pick('layout'),
		style: pick('style'),
		windowMs: pick('windowMs'),
	};
}

export type ThroughputGaugeSettingsPatchResult =
	| { ok: true; settings: ThroughputGaugeSettings }
	| { ok: false; error: string };

/**
 * Validate a partial patch and merge it onto `current`. Pure. The first bad
 * field (an unknown key, or a value outside its allowed list) fails the whole
 * patch with an error naming the field and what it accepts, so nothing is
 * half-applied.
 */
export function applyThroughputGaugeSettingsPatch(
	current: ThroughputGaugeSettings,
	patch: unknown
): ThroughputGaugeSettingsPatchResult {
	if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
		return { ok: false, error: 'Throughput Gauge settings patch must be an object.' };
	}
	const merged: ThroughputGaugeSettings = { ...current };
	for (const [field, value] of Object.entries(patch)) {
		if (!(field in FIELD_VALUES)) {
			return {
				ok: false,
				error: `Unknown Throughput Gauge setting "${field}". Allowed settings: ${THROUGHPUT_GAUGE_SETTING_FIELDS.join(', ')}.`,
			};
		}
		const key = field as keyof ThroughputGaugeSettings;
		if (!isAllowed(key, value)) {
			return {
				ok: false,
				error: `Invalid value ${JSON.stringify(value)} for Throughput Gauge setting "${key}". Allowed values: ${FIELD_VALUES[key].join(', ')}.`,
			};
		}
		(merged as Record<keyof ThroughputGaugeSettings, unknown>)[key] = value;
	}
	return { ok: true, settings: merged };
}

/** The label for a value in an option list, or the raw value when it is not listed. */
export function throughputOptionLabel<T>(
	options: ReadonlyArray<ThroughputGaugeOption<T>>,
	value: T
): string {
	return options.find((o) => o.value === value)?.label ?? String(value);
}

/**
 * Whose output the gauge counts, in words: "all agents", or the active
 * agent's name. `activeAgentName` is null when there is no active agent.
 */
export function throughputScopeCaption(
	scope: ThroughputScope,
	activeAgentName: string | null
): string {
	if (scope === 'all') return 'all agents';
	return activeAgentName || 'no active agent';
}
