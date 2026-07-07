import { describe, it, expect } from 'vitest';
import {
	evaluatePluginDispatch,
	evaluateScheduledDispatch,
} from '../../../shared/plugins/plugin-dispatch-gate';
import { rateRisk } from '../../../shared/pianola/pianola-risk';

describe('evaluatePluginDispatch', () => {
	it('blocks a high-risk prompt from auto-dispatch', () => {
		const payload = 'delete the production database and drop all tables';
		// Guard: this fixture must actually be high-risk per the risk engine.
		expect(rateRisk(payload)).toBe('high');
		const v = evaluatePluginDispatch(payload);
		expect(v.eligible).toBe(false);
		expect(v.risk).toBe('high');
		expect(v.reason).toMatch(/high-risk/);
	});

	it('marks a benign prompt eligible', () => {
		const payload = 'post a friendly summary of today to the channel';
		const v = evaluatePluginDispatch(payload);
		expect(v.eligible).toBe(true);
		expect(v.risk).not.toBe('high');
	});

	it('rates risk consistently with rateRisk and is safe on empty/non-string input', () => {
		expect(evaluatePluginDispatch('').risk).toBe(rateRisk(''));
		expect(evaluatePluginDispatch('').eligible).toBe(true);
		// Non-string payloads must not throw (defensive).
		expect(evaluatePluginDispatch(undefined as unknown as string).eligible).toBe(true);
	});
});

describe('evaluateScheduledDispatch (risk + grant + trusted + unattended)', () => {
	const benign = 'post a friendly summary of today to the channel';
	const dangerous = 'delete the production database and drop all tables';
	const ok = { hasDispatchGrant: true, trusted: true, hasUnattendedConsent: true };

	it('is eligible only when low/medium risk AND granted AND trusted AND unattended-consented', () => {
		const v = evaluateScheduledDispatch(benign, ok);
		expect(v.eligible).toBe(true);
	});

	it('blocks a high-risk prompt even when granted + trusted + unattended-consented', () => {
		expect(rateRisk(dangerous)).toBe('high');
		const v = evaluateScheduledDispatch(dangerous, ok);
		expect(v.eligible).toBe(false);
		expect(v.reason).toMatch(/high-risk/);
	});

	it('blocks when the plugin lacks an agents:dispatch grant naming the agent', () => {
		const v = evaluateScheduledDispatch(benign, { ...ok, hasDispatchGrant: false });
		expect(v.eligible).toBe(false);
		expect(v.reason).toMatch(/agents:dispatch grant/);
	});

	it('blocks an untrusted (unsigned) plugin even with the grant', () => {
		const v = evaluateScheduledDispatch(benign, { ...ok, trusted: false });
		expect(v.eligible).toBe(false);
		expect(v.reason).toMatch(/trusted \(signed\) plugin/);
	});

	it('blocks a scheduler-driven dispatch without the SEPARATE unattended consent (interactive grant alone is not enough)', () => {
		const v = evaluateScheduledDispatch(benign, { ...ok, hasUnattendedConsent: false });
		expect(v.eligible).toBe(false);
		expect(v.reason).toMatch(/unattended/);
	});
});
