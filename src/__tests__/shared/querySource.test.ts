/**
 * @file querySource.test.ts
 * @description Reading the inherited query source from an environment, and
 * which sources count as automation.
 */

import { describe, expect, it } from 'vitest';
import {
	QUERY_SOURCE_ENV_VAR,
	isAutomationQuerySource,
	readQuerySource,
} from '../../shared/querySource';

describe('readQuerySource', () => {
	it('reads a known source, trimming whitespace', () => {
		expect(readQuerySource({ [QUERY_SOURCE_ENV_VAR]: 'cue' })).toBe('cue');
		expect(readQuerySource({ [QUERY_SOURCE_ENV_VAR]: ' auto\n' })).toBe('auto');
		expect(readQuerySource({ [QUERY_SOURCE_ENV_VAR]: 'user' })).toBe('user');
	});

	it('returns null when the variable is unset or outside the vocabulary', () => {
		expect(readQuerySource({})).toBeNull();
		expect(readQuerySource({ [QUERY_SOURCE_ENV_VAR]: '' })).toBeNull();
		expect(readQuerySource({ [QUERY_SOURCE_ENV_VAR]: 'CUE' })).toBeNull();
	});
});

describe('isAutomationQuerySource', () => {
	it('is true for Auto Run and Cue, false for a person or no claim', () => {
		expect(isAutomationQuerySource('cue')).toBe(true);
		expect(isAutomationQuerySource('auto')).toBe(true);
		expect(isAutomationQuerySource('user')).toBe(false);
		expect(isAutomationQuerySource(null)).toBe(false);
	});
});
