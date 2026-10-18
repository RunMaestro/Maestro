// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { validateAcceptanceInputs } from '../../../../scripts/provider-translation-acceptance/driver';

describe('prepared acceptance authorization', () => {
	it('requires explicit opt-in and refuses credentials outside checkout scratch', () => {
		const workspace = '/isolated/project';
		expect(() => validateAcceptanceInputs(workspace, [])).toThrow('explicit opt-in');
		const args = [
			'--execute-isolated-acceptance',
			'--claude-auth',
			'/default/.claude/credentials',
			'--codex-auth',
			'/isolated/project/.maestro/scratch/auth.json',
			'--recall-question',
			'Recall a synthetic fact',
			'--expected-recall',
			'azure kite',
		];
		expect(() => validateAcceptanceInputs(workspace, args)).toThrow('checkout scratch');
		args[2] = '/isolated/project/.maestro/scratch/claude.json';
		expect(validateAcceptanceInputs(workspace, args).expected).toBe('azure kite');
		expect(() => validateAcceptanceInputs(workspace, args.slice(0, -2))).toThrow(
			'--expected-recall'
		);
	});
});
