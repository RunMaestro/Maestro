import { describe, expect, it } from 'vitest';
import { isInteractiveRuntimeAuthorized } from '../../../shared/plugins/interactive-runtime';

const authorized = {
	signatureTrusted: true,
	enabled: true,
	hostCompatible: true,
	userConsented: true,
	workspaceRootCurrent: true,
	grants: [{ capability: 'process:interactive' as const, scope: 'omp', grantedAt: 1 }],
};

describe('isInteractiveRuntimeAuthorized', () => {
	it('requires trusted, enabled, compatible, consented process:interactive authority', () => {
		expect(isInteractiveRuntimeAuthorized(authorized)).toBe(true);
		for (const denied of [
			{ ...authorized, signatureTrusted: false },
			{ ...authorized, enabled: false },
			{ ...authorized, hostCompatible: false },
			{ ...authorized, userConsented: false },
			{ ...authorized, workspaceRootCurrent: false },
			{ ...authorized, grants: [] },
			{
				...authorized,
				grants: [{ capability: 'process:interactive' as const, scope: 'other', grantedAt: 1 }],
			},
		]) {
			expect(isInteractiveRuntimeAuthorized(denied)).toBe(false);
		}
	});
});
