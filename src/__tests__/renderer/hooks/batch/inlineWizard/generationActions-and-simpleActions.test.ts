// Source: src/__tests__/renderer/hooks/batch/inlineWizard/generationActions.test.ts
// Source: src/__tests__/renderer/hooks/batch/inlineWizard/simpleActions.test.ts
import { describe as describeSourceSuite } from 'vitest';
import { describe } from 'vitest';
import { expect } from 'vitest';
import { it } from 'vitest';
import { getProjectNameForGeneration } from '../../../../../renderer/hooks/batch/inlineWizard/generationActions';
import { parseGenerationProgress } from '../../../../../renderer/hooks/batch/inlineWizard/generationActions';
import { initialInlineWizardState } from '../../../../../renderer/hooks/batch/inlineWizard/state';
import { clampConfidence } from '../../../../../renderer/hooks/batch/inlineWizard/simpleActions';
describeSourceSuite('generationActions', () => {
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
});
describeSourceSuite('simpleActions', () => {
	describe('inline wizard simple action helpers', () => {
		it('clamps confidence to the wizard bounds', () => {
			expect(clampConfidence(-10)).toBe(0);
			expect(clampConfidence(42)).toBe(42);
			expect(clampConfidence(150)).toBe(100);
		});
	});
});
