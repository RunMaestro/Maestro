import { describe, expect, it } from 'vitest';
import {
	IMPORTED_MAX_LOOPS_CEILING,
	clampImportedMaxLoops,
	isUnboundedLoop,
	toBatchRunPlaybook,
} from '../../shared/playbookRun';
import type { Playbook } from '../../shared/types';

function makePlaybook(overrides: Partial<Playbook> = {}): Playbook {
	return {
		id: 'pb-1',
		name: 'Refactor',
		createdAt: 0,
		updatedAt: 0,
		documents: [{ filename: 'refactor/one', resetOnCompletion: false }],
		loopEnabled: true,
		maxLoops: null,
		prompt: '',
		...overrides,
	};
}

describe('clampImportedMaxLoops', () => {
	it('caps an unlimited loop at the ceiling', () => {
		expect(IMPORTED_MAX_LOOPS_CEILING).toBe(10);
		expect(clampImportedMaxLoops(true, null)).toBe(10);
		expect(clampImportedMaxLoops(true, undefined)).toBe(10);
	});

	it('caps a bound that is not a positive finite number', () => {
		expect(clampImportedMaxLoops(true, 0)).toBe(10);
		expect(clampImportedMaxLoops(true, -3)).toBe(10);
		expect(clampImportedMaxLoops(true, Number.POSITIVE_INFINITY)).toBe(10);
		expect(clampImportedMaxLoops(true, Number.NaN)).toBe(10);
	});

	it('keeps a finite bound, even one above the ceiling', () => {
		expect(clampImportedMaxLoops(true, 3)).toBe(3);
		expect(clampImportedMaxLoops(true, 30)).toBe(30);
	});

	it('leaves a non-looping playbook as it shipped', () => {
		expect(clampImportedMaxLoops(false, null)).toBeNull();
		expect(clampImportedMaxLoops(false, undefined)).toBeUndefined();
		expect(clampImportedMaxLoops(false, 4)).toBe(4);
	});
});

describe('isUnboundedLoop', () => {
	it('is true exactly when the clamp would change the bound', () => {
		expect(isUnboundedLoop(true, null)).toBe(true);
		expect(isUnboundedLoop(true, undefined)).toBe(true);
		expect(isUnboundedLoop(true, 5)).toBe(false);
		expect(isUnboundedLoop(false, null)).toBe(false);
	});
});

describe('toBatchRunPlaybook', () => {
	it('carries identity, provenance, overlay, and the stored answers', () => {
		const playbook = makePlaybook({
			parameterOverlay: [{ name: 'PR_URL', type: 'url', required: true }],
			parameterValues: { PR_URL: 'https://github.com/o/r/pull/1' },
			provenance: {
				kind: 'marketplace',
				marketplaceId: 'development-refactor',
				sourceVersion: '2026-10-01',
				targetFolderName: 'refactor',
				importedAt: 0,
				documentHashes: {},
			},
		});
		expect(toBatchRunPlaybook(playbook, 'agent-1')).toEqual({
			id: 'pb-1',
			ownerSessionId: 'agent-1',
			marketplaceId: 'development-refactor',
			sourceVersion: '2026-10-01',
			parameterOverlay: [{ name: 'PR_URL', type: 'url', required: true }],
			parameterValues: { PR_URL: 'https://github.com/o/r/pull/1' },
		});
	});

	it('prefers the answers the launcher hands it over the stored ones', () => {
		const playbook = makePlaybook({ parameterValues: { BRANCH: 'old' } });
		expect(toBatchRunPlaybook(playbook, 'agent-1', { BRANCH: 'feat/x' }).parameterValues).toEqual({
			BRANCH: 'feat/x',
		});
	});

	it('omits what the record does not have', () => {
		expect(toBatchRunPlaybook(makePlaybook(), 'agent-1')).toEqual({
			id: 'pb-1',
			ownerSessionId: 'agent-1',
		});
	});
});
