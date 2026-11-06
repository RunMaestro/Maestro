import { describe, expect, it } from 'vitest';
import { planBoardMigration, type BoardMigrationInput } from '../../../main/board/board-migration';

const timestamp = '2026-10-31T12:00:00.000Z';
const card = {
	id: 'card',
	title: 'Work',
	body: 'Task',
	status: 'todo',
	assigneeAgentId: 'worker',
	assigneeProfileId: 'role',
	parents: ['parent'],
	heldByUser: true,
	createdAt: timestamp,
	updatedAt: timestamp,
	runs: [
		{
			attempt: 1,
			startedAt: timestamp,
			endedAt: timestamp,
			workerAgentId: 'worker',
			future: { kept: true },
		},
	],
	future: { nested: [null, 42] },
};
const input = (path: string): BoardMigrationInput => ({
	source: { location: { kind: 'local' }, path },
	repository: { id: path, workingDirectory: path, validated: true },
	boardBytes: Buffer.from(
		JSON.stringify({
			extraRoot: 'preserved in bytes',
			boards: [{ id: 'board', name: 'Board', cards: [card], future: 17 }],
		})
	),
	profileBytes: Buffer.from(
		JSON.stringify({ profiles: [{ id: 'role', name: 'Role', future: true }] })
	),
	workers: [{ id: 'worker', boardWorker: true, dir: path, future: 'kept' }],
});

describe('legacy Board snapshot planning', () => {
	it('keeps equal legacy IDs separate across explicit sources and maps deterministically', () => {
		const first = input('/project-a');
		const a = planBoardMigration(first);
		const b = planBoardMigration(input('/project-b'));
		expect(planBoardMigration(first)).toEqual(a);
		expect(a.sourceKey).not.toBe(b.sourceKey);
		expect(a.profileNamespace).not.toBe(b.profileNamespace);
		expect(a.boards[0].collectionKey).not.toBe(b.boards[0].collectionKey);
		expect(a.boards[0].cards[0].legacyId).toBe(b.boards[0].cards[0].legacyId);
		expect(a.profiles[0].legacyId).toBe(b.profiles[0].legacyId);
		expect(Buffer.from(a.snapshot.boardBase64!, 'base64')).toEqual(first.boardBytes);
		expect(Buffer.from(a.snapshot.profileBase64!, 'base64')).toEqual(first.profileBytes);
		expect(a.snapshot.workers).toEqual(first.workers);
		expect(a.boards[0].cards[0].raw).toEqual(card);
		expect(a.profiles[0].raw).toMatchObject({ future: true });
		expect(a.boards[0].cards[0]).toMatchObject({
			intent: 'legacy-direct',
			executionScope: { kind: 'agent', agentId: 'worker' },
			blockers: expect.arrayContaining(['held']),
		});
	});

	it('retains invalid and duplicate entries as conflicts instead of discarding them', () => {
		const source = input('/duplicates');
		const invalid = { ...card, status: 'future-status', futureInvalid: { value: 1 } };
		source.boardBytes = Buffer.from(
			JSON.stringify({ boards: [{ id: 'board', name: 'Board', cards: [invalid, invalid] }] })
		);
		source.profileBytes = Buffer.from(
			JSON.stringify({
				profiles: [
					{ id: 'role', name: 'Role' },
					{ id: 'role', name: 'Role' },
				],
			})
		);
		const plan = planBoardMigration(source);
		expect(plan.conflicts).toContain('duplicate-profile-id');
		expect(plan.boards[0].conflicts).toContain('duplicate-card-id');
		expect(plan.boards[0].cards).toHaveLength(2);
		for (const entry of plan.boards[0].cards) {
			expect(entry.raw).toEqual(invalid);
			expect(entry.blockers).toEqual(
				expect.arrayContaining([
					'invalid-card',
					'duplicate-card-id',
					'profile-unresolved',
					'unknown',
				])
			);
		}
		expect(Buffer.from(plan.snapshot.boardBase64!, 'base64')).toEqual(source.boardBytes);
	});

	it('preserves DAG and run history while blocking ambiguous targets and start intentions', () => {
		const source = input('/uncertain');
		const cards = [
			{ ...card, id: 'triage', status: 'triage' },
			{ ...card, id: 'review', status: 'review' },
			{
				...card,
				id: 'running',
				status: 'running',
				assigneeAgentId: undefined,
				assigneeProfileId: undefined,
				runs: [{ attempt: 2, startedAt: timestamp }],
			},
		];
		source.boardBytes = Buffer.from(
			JSON.stringify({ boards: [{ id: 'board', name: 'Board', cards }] })
		);
		source.repository = null;
		const planned = planBoardMigration(source).boards[0].cards;
		expect(planned.map((entry) => entry.raw)).toEqual(JSON.parse(JSON.stringify(cards)));
		expect(planned.map((entry) => entry.intent)).toEqual([
			'approval-required',
			'human-review',
			'reconciliation-required',
		]);
		expect(planned[0].blockers).toEqual(
			expect.arrayContaining(['approval-required', 'held', 'repository-unresolved'])
		);
		expect(planned[1].blockers).toContain('human-review');
		expect(planned[2].blockers).toEqual(
			expect.arrayContaining(['missing-scope', 'repository-unresolved', 'running-worker-unknown'])
		);
		expect(planned[2].executionScope).toBeNull();
	});
});
