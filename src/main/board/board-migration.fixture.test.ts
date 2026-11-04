import { describe, it, expect } from 'vitest';
import { planBoardMigration } from './board-migration';

describe('migration fixture', () => {
	it('keeps sources separate and retains raw data deterministically', () => {
		const boardBytes = Buffer.from(
			'boards:\n  - id: same\n    name: Test\n    mystery: kept\n    cards:\n      - id: c\n        status: running\n        parents: [other]\n        heldByUser: true\n        runs: [{workerAgentId: worker, extra: kept}]\n      - id: c\n        unexpected: 42\n'
		);
		const profileBytes = Buffer.from('profiles:\n  - id: role\n    name: Role\n    extra: kept\n');
		const input = {
			source: { location: { kind: 'local' as const }, path: '/one' },
			repository: null,
			boardBytes,
			profileBytes,
			workers: [{ id: 'worker', boardWorker: true, extra: 1 }],
		};
		const a = planBoardMigration(input);
		const b = planBoardMigration({ ...input, source: { ...input.source, path: '/two' } });
		expect(planBoardMigration(input)).toEqual(a);
		expect(a.boards[0].collectionKey).not.toEqual(b.boards[0].collectionKey);
		expect(a.profileNamespace).not.toEqual(b.profileNamespace);
		expect(Buffer.from(a.snapshot.boardBase64!, 'base64')).toEqual(boardBytes);
		expect(a.boards[0].cards[0].raw).toMatchObject({
			parents: ['other'],
			heldByUser: true,
			runs: [{ extra: 'kept' }],
		});
		expect(a.boards[0].cards[0].blockers).toContain('duplicate-card-id');
		expect(a.boards[0].cards[0].blockers).toContain('reconciliation-required');
		expect(a.boards[0].cards[0].blockers).toContain('repository-unresolved');
		expect(a.boards[0].cards[1].raw).toMatchObject({ unexpected: 42 });
		expect(() => planBoardMigration({ ...input, boardBytes: Buffer.from('boards: [') })).toThrow();
	});
});
