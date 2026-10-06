import { describe, it, expect } from 'vitest';
import {
	extractGrokTextFromJsonl,
	getGrokTextDelta,
	GROK_WIZARD_DISCOVERY_ARGS,
} from '../../../renderer/utils/grokWizard';

describe('grokWizard helpers', () => {
	describe('GROK_WIZARD_DISCOVERY_ARGS', () => {
		it('caps turns, auto-approves, and bans subagents without plan mode', () => {
			expect(GROK_WIZARD_DISCOVERY_ARGS).toEqual([
				'--always-approve',
				'--max-turns',
				'8',
				'--no-subagents',
			]);
			expect(GROK_WIZARD_DISCOVERY_ARGS).not.toContain('--permission-mode');
			expect(GROK_WIZARD_DISCOVERY_ARGS).not.toContain('plan');
		});
	});

	describe('getGrokTextDelta', () => {
		it('returns text data only', () => {
			expect(getGrokTextDelta({ type: 'text', data: 'hello' })).toBe('hello');
			expect(getGrokTextDelta({ type: 'thought', data: 'thinking' })).toBeNull();
			expect(getGrokTextDelta({ type: 'text', data: '' })).toBeNull();
			expect(getGrokTextDelta({ type: 'text', data: 42 })).toBeNull();
			expect(getGrokTextDelta(null)).toBeNull();
		});
	});

	describe('extractGrokTextFromJsonl', () => {
		it('joins text deltas and skips thought', () => {
			const lines = [
				'{"type":"thought","data":"planning"}',
				'{"type":"text","data":"{\\"ready\\":"}',
				'{"type":"text","data":"true}"}',
				'{"type":"end","sessionId":"abc"}',
				'not-json',
				'',
			];
			expect(extractGrokTextFromJsonl(lines)).toBe('{"ready":true}');
		});

		it('returns null when no text deltas are present', () => {
			expect(extractGrokTextFromJsonl(['{"type":"thought","data":"x"}'])).toBeNull();
			expect(extractGrokTextFromJsonl([])).toBeNull();
		});
	});
});
