import { describe, expect, it } from 'vitest';
import {
	normalizeAutoRunTargetFilename,
	resolveGroupChatAutoRunTarget,
} from '../../../renderer/utils/groupChatAutoRun';

describe('groupChatAutoRun', () => {
	describe('normalizeAutoRunTargetFilename', () => {
		it('removes md extension and normalizes slashes', () => {
			expect(normalizeAutoRunTargetFilename('./plans\\phase-01.md')).toBe('plans/phase-01');
		});
	});

	describe('resolveGroupChatAutoRunTarget', () => {
		it('matches an exact relative path after normalization', () => {
			expect(
				resolveGroupChatAutoRunTarget(['plans/phase-01', 'plans/phase-02'], 'plans/phase-01.md')
			).toEqual({
				files: ['plans/phase-01'],
			});
		});

		it('matches a unique basename when the moderator omits the subfolder', () => {
			expect(
				resolveGroupChatAutoRunTarget(['plans/phase-01', 'plans/phase-02'], 'phase-02.md')
			).toEqual({
				files: ['plans/phase-02'],
			});
		});

		it('returns an ambiguity error for duplicate basenames', () => {
			expect(resolveGroupChatAutoRunTarget(['frontend/plan', 'backend/plan'], 'plan.md')).toEqual({
				error: 'Specified file "plan.md" is ambiguous. Matching files: frontend/plan, backend/plan',
			});
		});

		it('returns a not found error for unknown files', () => {
			expect(resolveGroupChatAutoRunTarget(['plans/phase-01'], 'missing.md')).toEqual({
				error: 'Specified file "missing.md" not found. Available files: plans/phase-01',
			});
		});
	});
});
