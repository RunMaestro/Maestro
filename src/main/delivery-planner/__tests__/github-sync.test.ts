import { describe, expect, it, vi } from 'vitest';

import type { ExecResult } from '../../utils/execFile';
import type { WorkItem } from '../../../shared/work-graph-types';
import { DeliveryPlannerGithubSafetyError } from '../github-safety';
import { DeliveryPlannerGithubSync } from '../github-sync';

const ok = (stdout: string): ExecResult => ({ stdout, stderr: '', exitCode: 0 });

describe('DeliveryPlannerGithubSync', () => {
	it('creates fork-local issues, adds them to the project, and sets organization fields', async () => {
		const calls: string[][] = [];
		const exec = vi.fn(async (_command: string, args: string[]) => {
			calls.push(args);
			if (args[0] === 'issue' && args[1] === 'create') {
				return ok('https://github.com/HumpfTech/Maestro/issues/67\n');
			}
			if (args[0] === 'project' && args[1] === 'view') {
				return ok(JSON.stringify({ id: 'project-7', title: 'Humpf Tech Maestro Features' }));
			}
			if (args[0] === 'project' && args[1] === 'item-add') {
				return ok(JSON.stringify({ id: 'project-item-67' }));
			}
			if (args[0] === 'project' && args[1] === 'field-list') {
				return ok(
					JSON.stringify({
						fields: [
							textField('Maestro Major', 'field-major'),
							textField('Work Item Type', 'field-type'),
							textField('Parent Work Item', 'field-parent'),
							textField('External Mirror ID', 'field-external-mirror'),
							textField('Agent Pickup', 'field-pickup'),
						],
					})
				);
			}
			return ok('{}');
		});
		const sync = new DeliveryPlannerGithubSync({ exec });

		const result = await sync.syncIssue(makeWorkItem());

		expect(result.github).toMatchObject({
			owner: 'HumpfTech',
			repo: 'Maestro',
			repository: 'HumpfTech/Maestro',
			issueNumber: 67,
		});
		expect(calls[0]).toEqual(
			expect.arrayContaining([
				'issue',
				'create',
				'-R',
				'HumpfTech/Maestro',
				'--label',
				'delivery-planner',
			])
		);
		expect(
			calls.some((args) => args.includes('--field-id') && args.includes('field-external-mirror'))
		).toBe(true);
		expect(calls.every((args) => args[args.indexOf('-R') + 1] !== 'RunMaestro/Maestro')).toBe(true);
	});

	it('reuses existing GitHub issue references instead of creating duplicates', async () => {
		const exec = vi.fn(async (_command: string, args: string[]) => {
			if (args[0] === 'issue' && args[1] === 'view') {
				return ok(
					JSON.stringify({ number: 67, url: 'https://github.com/HumpfTech/Maestro/issues/67' })
				);
			}
			if (args[0] === 'project' && args[1] === 'view') {
				return ok(JSON.stringify({ id: 'project-7', title: 'Humpf Tech Maestro Features' }));
			}
			if (args[0] === 'project' && args[1] === 'item-add') {
				return ok(JSON.stringify({ id: 'project-item-67' }));
			}
			if (args[0] === 'project' && args[1] === 'field-list') {
				return ok(
					JSON.stringify({
						fields: [
							textField('Maestro Major', 'field-major'),
							textField('Work Item Type', 'field-type'),
							textField('Parent Work Item', 'field-parent'),
							textField('External Mirror ID', 'field-external-mirror'),
							textField('Agent Pickup', 'field-pickup'),
						],
					})
				);
			}
			return ok('{}');
		});
		const sync = new DeliveryPlannerGithubSync({ exec });

		const result = await sync.syncIssue(
			makeWorkItem({
				github: {
					owner: 'HumpfTech',
					repo: 'Maestro',
					repository: 'HumpfTech/Maestro',
					issueNumber: 67,
					url: 'https://github.com/HumpfTech/Maestro/issues/67',
				},
			})
		);

		expect(result.created).toBe(false);
		expect(exec).not.toHaveBeenCalledWith(
			'gh',
			expect.arrayContaining(['issue', 'create']),
			undefined
		);
	});

	it('rejects upstream GitHub references before running gh', async () => {
		const exec = vi.fn();
		const sync = new DeliveryPlannerGithubSync({ exec });

		await expect(
			sync.syncIssue(
				makeWorkItem({
					github: {
						owner: 'HumpfTech',
						repo: 'Maestro',
						repository: 'RunMaestro/Maestro' as 'HumpfTech/Maestro',
						issueNumber: 1,
					},
				})
			)
		).rejects.toBeInstanceOf(DeliveryPlannerGithubSafetyError);
		expect(exec).not.toHaveBeenCalled();
	});

	it('maps status and progress comments to fork-local issue commands', async () => {
		const exec = vi.fn(async () => ok('{}'));
		const sync = new DeliveryPlannerGithubSync({ exec });
		const item = makeWorkItem({
			status: 'done',
			github: {
				owner: 'HumpfTech',
				repo: 'Maestro',
				repository: 'HumpfTech/Maestro',
				issueNumber: 67,
			},
		});

		await sync.addProgressComment(item, 'Implementation complete.');
		await sync.syncStatus(item);

		expect(exec).toHaveBeenCalledWith(
			'gh',
			['issue', 'comment', '67', '-R', 'HumpfTech/Maestro', '--body', 'Implementation complete.'],
			undefined
		);
		expect(exec).toHaveBeenCalledWith(
			'gh',
			expect.arrayContaining(['issue', 'close', '67', '-R', 'HumpfTech/Maestro']),
			undefined
		);
	});
});

function textField(name: string, id: string) {
	return { name, id, dataType: 'TEXT' };
}

function makeWorkItem(overrides: Partial<WorkItem> = {}): WorkItem {
	const timestamp = '2026-04-30T00:00:00.000Z';
	return {
		id: 'item-67',
		type: 'task',
		status: 'ready',
		title: 'Sync GitHub progress',
		description: 'Implement sync.',
		projectPath: '/project',
		gitPath: '/project',
		source: 'delivery-planner',
		readonly: false,
		tags: ['delivery-planner', 'external-mirror'],
		version: 0,
		createdAt: timestamp,
		updatedAt: timestamp,
		metadata: {
			kind: 'task',
			mirrorSlug: 'delivery-planner',
			mirrorTaskId: 8,
			parentWorkItemId: 'epic-1',
		},
		...overrides,
	};
}
