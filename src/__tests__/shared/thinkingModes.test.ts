import { describe, it, expect } from 'vitest';
import { THINKING_MODES, nextThinkingMode, asThinkingMode } from '../../shared/types';

describe('thinking mode helpers', () => {
	it('cycles off -> on -> sticky -> off', () => {
		// The composer chip and `maestro-cli tab thinking <id> cycle` share this
		// order; if it changes, a click and a CLI cycle disagree.
		expect(THINKING_MODES).toEqual(['off', 'on', 'sticky']);
		expect(nextThinkingMode('off')).toBe('on');
		expect(nextThinkingMode('on')).toBe('sticky');
		expect(nextThinkingMode('sticky')).toBe('off');
	});

	it('treats an unset mode as off', () => {
		expect(nextThinkingMode(undefined)).toBe('on');
	});

	it('narrows only the three real modes', () => {
		expect(asThinkingMode('sticky')).toBe('sticky');
		expect(asThinkingMode('loud')).toBeUndefined();
		expect(asThinkingMode(true)).toBeUndefined();
		expect(asThinkingMode(null)).toBeUndefined();
		expect(asThinkingMode(undefined)).toBeUndefined();
	});
});
