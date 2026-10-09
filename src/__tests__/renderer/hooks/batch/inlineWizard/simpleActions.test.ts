import { describe, expect, it } from 'vitest';
import { clampConfidence } from '../../../../../renderer/hooks/batch/inlineWizard/simpleActions';

describe('inline wizard simple action helpers', () => {
	it('clamps confidence to the wizard bounds', () => {
		expect(clampConfidence(-10)).toBe(0);
		expect(clampConfidence(42)).toBe(42);
		expect(clampConfidence(150)).toBe(100);
	});
});
