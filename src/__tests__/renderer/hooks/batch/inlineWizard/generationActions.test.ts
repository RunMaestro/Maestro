import { describe, expect, it } from 'vitest';
import {
	getProjectNameForGeneration,
	parseGenerationProgress,
} from '../../../../../renderer/hooks/batch/inlineWizard/generationActions';
import { initialInlineWizardState } from '../../../../../renderer/hooks/batch/inlineWizard/state';

describe('inline wizard generation helpers', () => {
	it('parses "of" progress messages', () => {
		expect(parseGenerationProgress('Saving 2 of 5 document(s)...')).toEqual({
			current: 2,
			total: 5,
		});
	});

	it('parses slash progress messages', () => {
		expect(parseGenerationProgress('Writing 3 / 7')).toEqual({ current: 3, total: 7 });
	});

	it('ignores messages without progress counters', () => {
		expect(parseGenerationProgress('Starting document generation...')).toBeNull();
	});

	it('prefers the AI-extracted project name for generation', () => {
		expect(
			getProjectNameForGeneration({
				...initialInlineWizardState,
				extractedProjectName: ' HTML Chat Interface ',
				sessionName: 'rc',
			})
		).toBe('HTML Chat Interface');
	});

	it('falls back to the session name and then Project', () => {
		expect(
			getProjectNameForGeneration({
				...initialInlineWizardState,
				sessionName: 'Feature Session',
			})
		).toBe('Feature Session');
		expect(getProjectNameForGeneration(initialInlineWizardState)).toBe('Project');
	});
});
