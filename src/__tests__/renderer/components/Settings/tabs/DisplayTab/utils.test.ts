import { describe, expect, it } from 'vitest';
import {
	getRedThresholdUpdate,
	getYellowThresholdUpdate,
	isValidBionifyAlgorithm,
	normalizeBionifyAlgorithm,
} from '../../../../../../renderer/components/Settings/tabs/DisplayTab/utils';
import type { ContextManagementSettings } from '../../../../../../renderer/types';

const contextSettings: ContextManagementSettings = {
	autoGroomContexts: true,
	maxContextTokens: 100000,
	showMergePreview: true,
	groomingTimeout: 60000,
	preferredGroomingAgent: 'fastest',
	contextWarningsEnabled: true,
	contextWarningYellowThreshold: 60,
	contextWarningRedThreshold: 80,
};

describe('DisplayTab utils', () => {
	it('validates and normalizes Bionify algorithm strings', () => {
		expect(normalizeBionifyAlgorithm('  - 0 1 1 2 0.4  ')).toBe('- 0 1 1 2 0.4');
		expect(isValidBionifyAlgorithm('- 0 1 1 2 0.4')).toBe(true);
		expect(isValidBionifyAlgorithm('+ 1 1 2 2 1')).toBe(true);
		expect(isValidBionifyAlgorithm('- 0 1 1')).toBe(false);
		expect(isValidBionifyAlgorithm('- 0 1 1 2 1.5')).toBe(false);
	});

	it('keeps yellow threshold updates below red unless red must be bumped', () => {
		expect(getYellowThresholdUpdate(contextSettings, 70)).toEqual({
			contextWarningYellowThreshold: 70,
		});
		expect(getYellowThresholdUpdate(contextSettings, 85)).toEqual({
			contextWarningYellowThreshold: 85,
			contextWarningRedThreshold: 95,
		});
		expect(getYellowThresholdUpdate(contextSettings, 100)).toEqual({
			contextWarningYellowThreshold: 100,
			contextWarningRedThreshold: 100,
		});
	});

	it('keeps red threshold updates above yellow unless yellow must be lowered', () => {
		expect(getRedThresholdUpdate(contextSettings, 90)).toEqual({
			contextWarningRedThreshold: 90,
		});
		expect(getRedThresholdUpdate(contextSettings, 50)).toEqual({
			contextWarningRedThreshold: 50,
			contextWarningYellowThreshold: 40,
		});
		expect(getRedThresholdUpdate(contextSettings, 0)).toEqual({
			contextWarningRedThreshold: 0,
			contextWarningYellowThreshold: 0,
		});
	});
});
