import { describe, it, expect } from 'vitest';
import { buildAutoRunSkillBusPayload } from '../../shared/skillBus';

describe('skillBus helpers', () => {
	it('builds a success payload for normal Auto Run task entries', () => {
		expect(
			buildAutoRunSkillBusPayload(
				{
					type: 'AUTO',
					summary: 'Updated session handling',
					success: true,
					sessionName: 'Agent A',
				},
				'desktop'
			)
		).toEqual({
			skillName: 'maestro-autorun',
			result: 'success',
			score: 1,
			task: 'Desktop Auto Run: [Agent A] Updated session handling',
		});
	});

	it('maps WARN to partial result', () => {
		expect(
			buildAutoRunSkillBusPayload(
				{
					type: 'AUTO',
					summary: '[WARN] Verification warning',
					success: true,
					verifierVerdict: 'WARN',
				},
				'cli'
			)
		).toEqual({
			skillName: 'maestro-autorun',
			result: 'partial',
			score: 0.7,
			task: 'CLI Auto Run: [WARN] Verification warning (WARN)',
		});
	});

	it('ignores loop summaries', () => {
		expect(
			buildAutoRunSkillBusPayload(
				{
					type: 'AUTO',
					summary: 'Loop 2 completed: 3 tasks accomplished',
					success: true,
				},
				'desktop'
			)
		).toBeNull();
	});
});
