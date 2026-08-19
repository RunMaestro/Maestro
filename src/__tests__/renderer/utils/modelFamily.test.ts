/**
 * Tests for model family labelling.
 *
 * Grouping is a display aid over an untyped list of model ids, so the cases
 * that matter are: vendor prefixes map to the right label, provider-qualified
 * ids ("github-copilot/claude-...") are read from their last segment, unknown
 * ids fall to "Other" instead of being dropped, and a single-family list stays
 * ungrouped so a lone header never appears.
 */

import { describe, it, expect } from 'vitest';
import { getModelFamily, groupModelsByFamily } from '../../../renderer/utils/modelFamily';

describe('getModelFamily', () => {
	it('maps vendor prefixes to family labels', () => {
		expect(getModelFamily('claude-sonnet-4.5')).toBe('Claude');
		expect(getModelFamily('gpt-5')).toBe('OpenAI');
		expect(getModelFamily('o3-mini')).toBe('OpenAI');
		expect(getModelFamily('gemini-2.5-pro')).toBe('Gemini');
		expect(getModelFamily('grok-4.5')).toBe('Grok');
	});

	it('reads the vendor from the last segment of a provider-qualified id', () => {
		expect(getModelFamily('github-copilot/claude-sonnet-4.5')).toBe('Claude');
		expect(getModelFamily('openrouter/google/gemini-2.5-flash')).toBe('Gemini');
	});

	it('falls back to Other rather than dropping an unknown id', () => {
		expect(getModelFamily('some-unreleased-thing')).toBe('Other');
	});
});

describe('groupModelsByFamily', () => {
	it('returns one unlabelled group when every model shares a family', () => {
		const groups = groupModelsByFamily(['claude-opus-4', 'claude-sonnet-4.5']);
		expect(groups).toEqual([{ family: null, models: ['claude-opus-4', 'claude-sonnet-4.5'] }]);
	});

	it('groups a mixed catalog by vendor with Other last', () => {
		const groups = groupModelsByFamily([
			'gpt-5',
			'mystery-model',
			'claude-sonnet-4.5',
			'gemini-2.5-pro',
			'gpt-5-mini',
		]);

		expect(groups.map((g) => g.family)).toEqual(['Claude', 'OpenAI', 'Gemini', 'Other']);
		expect(groups.find((g) => g.family === 'OpenAI')?.models).toEqual(['gpt-5', 'gpt-5-mini']);
		expect(groups.find((g) => g.family === 'Other')?.models).toEqual(['mystery-model']);
	});

	it('preserves the incoming order inside each group', () => {
		const groups = groupModelsByFamily(['claude-b', 'gpt-5', 'claude-a']);
		expect(groups.find((g) => g.family === 'Claude')?.models).toEqual(['claude-b', 'claude-a']);
	});
});
