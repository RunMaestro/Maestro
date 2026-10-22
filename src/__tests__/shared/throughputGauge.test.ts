import { describe, expect, it } from 'vitest';

import {
	applyThroughputGaugeSettingsPatch,
	DEFAULT_THROUGHPUT_GAUGE_SETTINGS,
	formatGaugeRate,
	GAUGE_UNIT,
	resolveThroughputGaugeSettings,
	THROUGHPUT_GAUGE_SETTING_CONTROLS,
	THROUGHPUT_GAUGE_SETTING_FIELDS,
	THROUGHPUT_GAUGE_SETTINGS_KEY,
	THROUGHPUT_LAYOUTS,
	THROUGHPUT_METRICS,
	THROUGHPUT_SCOPES,
	THROUGHPUT_STYLES,
	THROUGHPUT_WINDOW_OPTIONS,
	throughputOptionLabel,
	throughputScopeCaption,
	throughputWindowLabel,
	type ThroughputGaugeSettings,
	type ThroughputLayout,
	type ThroughputScope,
	type ThroughputStyle,
} from '../../shared/throughputGauge';
import {
	DEFAULT_THROUGHPUT_WINDOW_MS,
	THROUGHPUT_WINDOWS_MS,
	type ThroughputMetric,
} from '../../shared/throughputRate';

/**
 * Every member of each union, written out by hand. A `Record<Union, true>`
 * fails to compile when a member is missing or extra, so the lists below are
 * exactly the unions and the option-list checks compare against them.
 */
const SCOPES: Record<ThroughputScope, true> = { all: true, active: true };
const METRICS: Record<ThroughputMetric, true> = { combined: true, in: true, out: true };
const LAYOUTS: Record<ThroughputLayout, true> = { single: true, all: true };
const STYLES: Record<ThroughputStyle, true> = { dial: true, vu: true, lcd: true, sparkline: true };

describe('throughputGauge settings model', () => {
	it('uses the documented settings key', () => {
		expect(THROUGHPUT_GAUGE_SETTINGS_KEY).toBe('throughputGaugeSettings');
	});

	describe('defaults', () => {
		it('match the spec', () => {
			expect(DEFAULT_THROUGHPUT_GAUGE_SETTINGS).toEqual({
				scope: 'all',
				metric: 'combined',
				layout: 'single',
				style: 'dial',
				windowMs: DEFAULT_THROUGHPUT_WINDOW_MS,
			});
		});

		it.each([undefined, null, 'dial', 42, [], true])('resolve %j to the defaults', (raw) => {
			expect(resolveThroughputGaugeSettings(raw)).toEqual(DEFAULT_THROUGHPUT_GAUGE_SETTINGS);
		});

		it('returns a fresh object, never the frozen defaults', () => {
			expect(resolveThroughputGaugeSettings(undefined)).not.toBe(DEFAULT_THROUGHPUT_GAUGE_SETTINGS);
		});
	});

	describe('resolveThroughputGaugeSettings', () => {
		it('keeps every valid stored field', () => {
			const stored: ThroughputGaugeSettings = {
				scope: 'active',
				metric: 'out',
				layout: 'all',
				style: 'lcd',
				windowMs: 60000,
			};
			expect(resolveThroughputGaugeSettings(stored)).toEqual(stored);
		});

		it('falls back per field, so a bad style does not reset scope', () => {
			expect(
				resolveThroughputGaugeSettings({
					scope: 'active',
					metric: 'sideways',
					layout: 3,
					style: 'nixie',
					windowMs: 12345,
				})
			).toEqual({ ...DEFAULT_THROUGHPUT_GAUGE_SETTINGS, scope: 'active' });
		});

		it('rejects a window given as a string', () => {
			expect(resolveThroughputGaugeSettings({ windowMs: '30000' }).windowMs).toBe(
				DEFAULT_THROUGHPUT_WINDOW_MS
			);
		});

		it('drops unknown keys', () => {
			expect(resolveThroughputGaugeSettings({ style: 'vu', color: 'red' })).toEqual({
				...DEFAULT_THROUGHPUT_GAUGE_SETTINGS,
				style: 'vu',
			});
		});
	});

	describe('applyThroughputGaugeSettingsPatch', () => {
		const current: ThroughputGaugeSettings = { ...DEFAULT_THROUGHPUT_GAUGE_SETTINGS };

		it('merges a valid patch', () => {
			expect(applyThroughputGaugeSettingsPatch(current, { metric: 'in', windowMs: 5000 })).toEqual({
				ok: true,
				settings: { ...current, metric: 'in', windowMs: 5000 },
			});
		});

		it('does not mutate the current settings', () => {
			applyThroughputGaugeSettingsPatch(current, { scope: 'active' });
			expect(current).toEqual(DEFAULT_THROUGHPUT_GAUGE_SETTINGS);
		});

		it('accepts an empty patch unchanged', () => {
			expect(applyThroughputGaugeSettingsPatch(current, {})).toEqual({
				ok: true,
				settings: current,
			});
		});

		it('names the field and its allowed values for a bad value', () => {
			const result = applyThroughputGaugeSettingsPatch(current, { metric: 'in', style: 'nixie' });
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.error).toContain('"style"');
			expect(result.error).toContain('"nixie"');
			expect(result.error).toContain('dial, vu, lcd, sparkline');
		});

		it('lists the windows for a bad window', () => {
			const result = applyThroughputGaugeSettingsPatch(current, { windowMs: 7000 });
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.error).toContain('"windowMs"');
			expect(result.error).toContain(THROUGHPUT_WINDOWS_MS.join(', '));
		});

		it('names an unknown field and the allowed fields', () => {
			const result = applyThroughputGaugeSettingsPatch(current, { colour: 'red' });
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.error).toContain('"colour"');
			expect(result.error).toContain('scope, metric, layout, style, windowMs');
		});

		it.each([null, undefined, 'scope=all', 5, ['scope']])(
			'rejects a non-object patch %j',
			(patch) => {
				expect(applyThroughputGaugeSettingsPatch(current, patch).ok).toBe(false);
			}
		);
	});

	describe('option lists', () => {
		const values = <T>(options: ReadonlyArray<{ value: T }>) => options.map((o) => o.value);

		it('each list covers its type union exactly', () => {
			expect(values(THROUGHPUT_SCOPES).sort()).toEqual(Object.keys(SCOPES).sort());
			expect(values(THROUGHPUT_METRICS).sort()).toEqual(Object.keys(METRICS).sort());
			expect(values(THROUGHPUT_LAYOUTS).sort()).toEqual(Object.keys(LAYOUTS).sort());
			expect(values(THROUGHPUT_STYLES).sort()).toEqual(Object.keys(STYLES).sort());
			expect(values(THROUGHPUT_WINDOW_OPTIONS)).toEqual([...THROUGHPUT_WINDOWS_MS]);
		});

		it('carries the user-facing labels', () => {
			expect(THROUGHPUT_SCOPES.map((o) => o.label)).toEqual(['All agents', 'Active agent']);
			expect(THROUGHPUT_METRICS.map((o) => o.label)).toEqual(['Combined', 'In', 'Out']);
			expect(THROUGHPUT_LAYOUTS.map((o) => o.label)).toEqual(['One', 'All three']);
			expect(THROUGHPUT_STYLES.map((o) => o.label)).toEqual(['Dial', 'VU', 'LCD', 'Sparkline']);
			expect(THROUGHPUT_WINDOW_OPTIONS.map((o) => o.label)).toEqual(['5s', '10s', '30s', '60s']);
		});

		it('every default is one of its options', () => {
			expect(values(THROUGHPUT_SCOPES)).toContain(DEFAULT_THROUGHPUT_GAUGE_SETTINGS.scope);
			expect(values(THROUGHPUT_METRICS)).toContain(DEFAULT_THROUGHPUT_GAUGE_SETTINGS.metric);
			expect(values(THROUGHPUT_LAYOUTS)).toContain(DEFAULT_THROUGHPUT_GAUGE_SETTINGS.layout);
			expect(values(THROUGHPUT_STYLES)).toContain(DEFAULT_THROUGHPUT_GAUGE_SETTINGS.style);
			expect(values(THROUGHPUT_WINDOW_OPTIONS)).toContain(
				DEFAULT_THROUGHPUT_GAUGE_SETTINGS.windowMs
			);
		});

		it('controls cover every field once, in field order, with the shared lists', () => {
			expect(THROUGHPUT_GAUGE_SETTING_CONTROLS.map((c) => c.field)).toEqual([
				...THROUGHPUT_GAUGE_SETTING_FIELDS,
			]);
			expect(THROUGHPUT_GAUGE_SETTING_CONTROLS.map((c) => c.label)).toEqual([
				'Scope',
				'Metric',
				'Layout',
				'Style',
				'Window',
			]);
			for (const control of THROUGHPUT_GAUGE_SETTING_CONTROLS) {
				const result = applyThroughputGaugeSettingsPatch(DEFAULT_THROUGHPUT_GAUGE_SETTINGS, {
					[control.field]: control.options[control.options.length - 1].value,
				});
				expect(result.ok).toBe(true);
			}
		});

		it('lists every settings field', () => {
			expect([...THROUGHPUT_GAUGE_SETTING_FIELDS].sort()).toEqual(
				Object.keys(DEFAULT_THROUGHPUT_GAUGE_SETTINGS).sort()
			);
		});
	});

	describe('labels', () => {
		it('formats a window in seconds', () => {
			expect(throughputWindowLabel(30000)).toBe('30s');
		});

		it('looks up an option label, falling back to the raw value', () => {
			expect(throughputOptionLabel(THROUGHPUT_METRICS, 'out')).toBe('Out');
			expect(throughputOptionLabel(THROUGHPUT_STYLES, 'nixie' as ThroughputStyle)).toBe('nixie');
		});

		it('captions the scope alone', () => {
			expect(throughputScopeCaption('all', 'Backend')).toBe('all agents');
			expect(throughputScopeCaption('active', 'Backend')).toBe('Backend');
			expect(throughputScopeCaption('active', null)).toBe('no active agent');
			expect(throughputScopeCaption('active', '')).toBe('no active agent');
		});
	});
});

describe('formatGaugeRate', () => {
	it('rounds, clamps at zero, and compacts above a thousand', () => {
		expect(formatGaugeRate(181.6)).toBe('182');
		expect(formatGaugeRate(-4)).toBe('0');
		expect(formatGaugeRate(Number.NaN)).toBe('0');
		expect(formatGaugeRate(1234)).toBe('1.2K');
		expect(GAUGE_UNIT).toBe('tok/s');
	});
});
