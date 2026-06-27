import { describe, it, expect } from 'vitest';
import { evaluatePluginDispatch } from '../../../shared/plugins/plugin-dispatch-gate';
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
