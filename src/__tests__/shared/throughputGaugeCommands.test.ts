import { describe, it, expect } from 'vitest';
import {
	isThroughputGaugeAction,
	normalizeThroughputGaugeCommandResult,
	parseThroughputGaugeCommandRequest,
	THROUGHPUT_GAUGE_ACTIONS,
	type ThroughputGaugeStatus,
} from '../../shared/throughputGaugeCommands';
import { DEFAULT_THROUGHPUT_GAUGE_SETTINGS } from '../../shared/throughputGauge';

const STATUS: ThroughputGaugeStatus = {
	enabled: true,
	visible: true,
	settings: { ...DEFAULT_THROUGHPUT_GAUGE_SETTINGS },
	rates: { in: 10, out: 20, combined: 30 },
	peak: { in: 40, out: 50, combined: 90 },
	windowMs: 10000,
};

describe('isThroughputGaugeAction', () => {
	it('accepts every listed action and nothing else', () => {
		for (const action of THROUGHPUT_GAUGE_ACTIONS)
			expect(isThroughputGaugeAction(action)).toBe(true);
		expect(isThroughputGaugeAction('reset')).toBe(false);
		expect(isThroughputGaugeAction(undefined)).toBe(false);
	});
});

describe('parseThroughputGaugeCommandRequest', () => {
	it('accepts the bare verbs and drops any stray patch', () => {
		for (const action of ['show', 'hide', 'toggle', 'status', 'reset-peak'] as const) {
			expect(parseThroughputGaugeCommandRequest({ action, patch: { style: 'lcd' } })).toEqual({
				ok: true,
				request: { action },
			});
		}
	});

	it('rejects an unknown or missing action', () => {
		const bad = parseThroughputGaugeCommandRequest({ action: 'explode' });
		expect(bad.ok).toBe(false);
		if (!bad.ok) expect(bad.error).toContain('show, hide, toggle, status, set, reset-peak');
		expect(parseThroughputGaugeCommandRequest({}).ok).toBe(false);
	});

	it('keeps only the fields a set names', () => {
		expect(
			parseThroughputGaugeCommandRequest({
				action: 'set',
				patch: { style: 'lcd', windowMs: 30000 },
			})
		).toEqual({ ok: true, request: { action: 'set', patch: { style: 'lcd', windowMs: 30000 } } });
	});

	it('rejects a set with no patch or an empty one', () => {
		const missing = parseThroughputGaugeCommandRequest({ action: 'set' });
		expect(missing).toEqual({
			ok: false,
			error: 'Throughput Gauge settings patch must be an object.',
		});
		expect(parseThroughputGaugeCommandRequest({ action: 'set', patch: {} })).toEqual({
			ok: false,
			error: 'Throughput Gauge set needs at least one setting to change',
		});
	});

	it('rejects an invalid value or an unknown field with the shared validator message', () => {
		const badValue = parseThroughputGaugeCommandRequest({
			action: 'set',
			patch: { style: 'lcd', windowMs: 7000 },
		});
		expect(badValue.ok).toBe(false);
		if (!badValue.ok) expect(badValue.error).toContain('"windowMs"');

		const badField = parseThroughputGaugeCommandRequest({ action: 'set', patch: { color: 'red' } });
		expect(badField.ok).toBe(false);
		if (!badField.ok) expect(badField.error).toContain('Unknown Throughput Gauge setting "color"');
	});
});

describe('normalizeThroughputGaugeCommandResult', () => {
	it('passes a successful status through', () => {
		expect(normalizeThroughputGaugeCommandResult({ success: true, status: STATUS })).toEqual({
			success: true,
			status: STATUS,
		});
	});

	it('turns a malformed answer into a failure', () => {
		expect(normalizeThroughputGaugeCommandResult(undefined)).toEqual({
			success: false,
			error: 'Invalid Throughput Gauge response',
		});
		expect(normalizeThroughputGaugeCommandResult({ success: 'yes' })).toEqual({
			success: false,
			error: 'Throughput Gauge command failed',
		});
		expect(normalizeThroughputGaugeCommandResult({ success: true })).toEqual({
			success: false,
			error: 'Throughput Gauge response carried no status',
		});
	});

	it('keeps the renderer error text', () => {
		expect(normalizeThroughputGaugeCommandResult({ success: false, error: 'off' })).toEqual({
			success: false,
			error: 'off',
		});
	});
});
